import { CURRICULUM, AREA_LABEL, type Track } from '../src/domain/curriculum';
import {
  initialProgress,
  planNextLesson,
  advanceProgress,
  encodeLessonCallback,
  decodeLessonCallback,
  applyLessonFeedback,
  pickRelatedArticles,
  findLesson,
  totalLessons,
  type LearningProgress,
} from '../src/domain/learning';
import type { Article } from '../src/lib/types';

const NOW = '2026-09-30T11:00:00.000Z';

/** n일 동안 매일 발송했다고 치고 보낸 레슨 id 목록을 돌려준다. */
function simulate(days: number, tracks: Track[] = CURRICULUM, start = initialProgress(NOW)) {
  let p: LearningProgress = start;
  const sent: string[] = [];
  for (let d = 0; d < days; d++) {
    const plan = planNextLesson(p, tracks);
    sent.push(`${plan.lesson.id}:${plan.mode}`);
    p = advanceProgress(p, plan, `day-${d}`, NOW);
  }
  return { progress: p, sent };
}

describe('CURRICULUM 무결성', () => {
  const allLessons = CURRICULUM.flatMap((t) => t.lessons);

  it('레슨 id는 전체에서 유일', () => {
    const ids = allLessons.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('트랙 id 유일 + 영역은 cloud/backend/frontend/cicd 중 하나', () => {
    expect(new Set(CURRICULUM.map((t) => t.id)).size).toBe(CURRICULUM.length);
    for (const t of CURRICULUM) expect(Object.keys(AREA_LABEL)).toContain(t.area);
  });

  it('4개 영역을 모두 다룬다', () => {
    expect(new Set(CURRICULUM.map((t) => t.area))).toEqual(new Set(['cloud', 'backend', 'frontend', 'cicd']));
  });

  it('모든 레슨에 포인트와 https 공식 문서 링크가 있다', () => {
    for (const l of allLessons) {
      expect(l.points.length).toBeGreaterThan(0);
      expect(l.refs.length).toBeGreaterThan(0);
      for (const r of l.refs) expect(r).toMatch(/^https:\/\//);
    }
  });

  it('모든 레슨 버튼의 callback_data가 64바이트 이하', () => {
    for (const l of allLessons) {
      for (const action of ['done', 'again'] as const) {
        expect(Buffer.byteLength(encodeLessonCallback(action, l.id))).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('planNextLesson / advanceProgress', () => {
  it('트랙을 라운드로빈으로 돌고, 트랙 안에서는 순서대로 간다', () => {
    const { sent } = simulate(CURRICULUM.length + 1);
    // 첫 바퀴: 각 트랙의 1강
    expect(sent.slice(0, CURRICULUM.length)).toEqual(CURRICULUM.map((t) => `${t.lessons[0].id}:normal`));
    // 다음 차례는 첫 트랙의 2강
    expect(sent[CURRICULUM.length]).toBe(`${CURRICULUM[0].lessons[1].id}:normal`);
  });

  it('전체를 다 돌면 같은 목차를 심화 모드로 다시 돈다', () => {
    const total = totalLessons(CURRICULUM);
    const { sent } = simulate(total + 1);
    expect(new Set(sent.slice(0, total).map((s) => s.split(':')[0])).size).toBe(total); // 첫 바퀴에 전부 1번씩
    expect(sent[total]).toBe(`${CURRICULUM[0].lessons[0].id}:deep`);
  });

  it('레슨 수가 다른 트랙이 섞여도 각자 순환한다', () => {
    const tracks: Track[] = [
      { ...CURRICULUM[0], id: 'a', lessons: CURRICULUM[0].lessons.slice(0, 1) },
      { ...CURRICULUM[1], id: 'b', lessons: CURRICULUM[1].lessons.slice(0, 2) },
    ];
    const { sent } = simulate(4, tracks);
    expect(sent).toEqual([
      `${tracks[0].lessons[0].id}:normal`,
      `${tracks[1].lessons[0].id}:normal`,
      `${tracks[0].lessons[0].id}:deep`,
      `${tracks[1].lessons[1].id}:normal`,
    ]);
  });

  it('previousTitles는 같은 트랙의 앞선 레슨 제목', () => {
    const p: LearningProgress = { ...initialProgress(NOW), next: { [CURRICULUM[0].id]: 2 } };
    const plan = planNextLesson(p, CURRICULUM);
    expect(plan.index).toBe(2);
    expect(plan.previousTitles).toEqual(CURRICULUM[0].lessons.slice(0, 2).map((l) => l.title));
  });

  it('쉽게 다시 요청이 있으면 그 레슨을 easier로 보내고, 진도는 멈춘다', () => {
    const target = CURRICULUM[2].lessons[3];
    const start: LearningProgress = { ...initialProgress(NOW), turn: 7, retryLessonId: target.id };
    const plan = planNextLesson(start, CURRICULUM);
    expect(plan.lesson.id).toBe(target.id);
    expect(plan.mode).toBe('easier');

    const after = advanceProgress(start, plan, '2026-09-30', NOW);
    expect(after.retryLessonId).toBeUndefined();
    expect(after.turn).toBe(7);
    expect(after.next).toEqual(start.next);
    expect(after.lastSentDate).toBe('2026-09-30');
  });

  it('커리큘럼에서 사라진 레슨 재시도 요청은 무시하고 정상 진도', () => {
    const start: LearningProgress = { ...initialProgress(NOW), retryLessonId: 'gone-99' };
    expect(planNextLesson(start, CURRICULUM).mode).toBe('normal');
  });

  it('advanceProgress는 입력을 변경하지 않는다', () => {
    const start = initialProgress(NOW);
    const snapshot = JSON.parse(JSON.stringify(start));
    advanceProgress(start, planNextLesson(start, CURRICULUM), 'd', NOW);
    expect(start).toEqual(snapshot);
  });
});

describe('레슨 버튼', () => {
  it('encode/decode 라운드트립', () => {
    for (const action of ['done', 'again'] as const) {
      expect(decodeLessonCallback(encodeLessonCallback(action, 'k8s-01'))).toEqual({ action, lessonId: 'k8s-01' });
    }
  });

  it('기사 피드백(v1|...)이나 잘못된 입력은 undefined', () => {
    expect(decodeLessonCallback('v1|like|abc')).toBeUndefined();
    expect(decodeLessonCallback('l1|nuke|k8s-01')).toBeUndefined();
    expect(decodeLessonCallback('l1|done')).toBeUndefined();
    expect(decodeLessonCallback(undefined)).toBeUndefined();
  });

  it('done은 완료 목록에 1번만 추가', () => {
    const p0 = initialProgress(NOW);
    const r1 = applyLessonFeedback(p0, 'done', 'k8s-01', NOW);
    expect(r1.changed).toBe(true);
    expect(r1.progress.completed).toEqual(['k8s-01']);
    const r2 = applyLessonFeedback(r1.progress, 'done', 'k8s-01', NOW);
    expect(r2.changed).toBe(false);
    expect(r2.progress.completed).toEqual(['k8s-01']);
  });

  it('again은 재시도 레슨을 예약하고, 같은 레슨 중복 클릭은 무시', () => {
    const r1 = applyLessonFeedback(initialProgress(NOW), 'again', 'jk-03', NOW);
    expect(r1.changed).toBe(true);
    expect(r1.progress.retryLessonId).toBe('jk-03');
    expect(applyLessonFeedback(r1.progress, 'again', 'jk-03', NOW).changed).toBe(false);
  });

  it('findLesson', () => {
    expect(findLesson(CURRICULUM, 'nd-02')?.track.id).toBe('node');
    expect(findLesson(CURRICULUM, 'nope')).toBeUndefined();
  });
});

describe('pickRelatedArticles', () => {
  const art = (id: string, title: string, score: number, extra: Partial<Article> = {}): Article => ({
    articleId: id,
    url: `https://example.com/${id}`,
    title,
    siteId: 's',
    category: 'cloud',
    source: 'blog',
    status: 'unread',
    score,
    collectedAt: NOW,
    ...extra,
  });

  it('제목/태그 키워드 매칭 + 점수순 + 개수 제한', () => {
    const picked = pickRelatedArticles(
      [
        art('a', 'Kubernetes 1.34 released', 70),
        art('b', '여행 에세이', 90),
        art('c', 'Scaling pods', 85, { tags: ['k8s'] }),
        art('d', 'Helm tips', 60),
      ],
      ['kubernetes', 'k8s', 'helm'],
      2
    );
    expect(picked.map((a) => a.articleId)).toEqual(['c', 'a']);
  });

  it('점수 미달·스킵·미큐레이션 글은 제외', () => {
    const picked = pickRelatedArticles(
      [
        art('low', 'Kubernetes intro', 30),
        art('skip', 'Kubernetes deep', 90, { status: 'skipped' }),
        { ...art('raw', 'Kubernetes raw', 0), score: undefined },
      ],
      ['kubernetes'],
      5
    );
    expect(picked).toEqual([]);
  });

  it('짧은 영문 키워드는 단어 경계로만 매칭 (storage ≠ rag, weeks ≠ eks), 복수형은 허용', () => {
    const picked = pickRelatedArticles(
      [
        art('storage', 'Object storage pricing', 80),
        art('weeks', 'Two weeks in Japan', 80),
        art('rag', 'Building RAG with Langflow', 80),
        art('agents', 'AI agents in production', 80),
        art('nodejs', 'What is new in Node.js 24', 80),
      ],
      ['rag', 'eks', 'agent', 'node'],
      10
    );
    expect(picked.map((a) => a.articleId).sort()).toEqual(['agents', 'nodejs', 'rag']);
  });
});
