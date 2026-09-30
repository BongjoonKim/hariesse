import { CURRICULUM } from '../src/domain/curriculum';
import { initialProgress, planNextLesson, type LearningProgress } from '../src/domain/learning';
import { parseLessonContent, buildLessonPrompt } from '../src/lib/bedrock';
import { formatLesson, packSections, buildLessonKeyboard } from '../src/lib/telegram';
import { buildLessonBlocks, lessonPageUrl } from '../src/lib/notion';
import type { LessonContent } from '../src/lib/types';

const NOW = '2026-09-30T11:00:00.000Z';
const plan = planNextLesson(initialProgress(NOW), CURRICULUM); // k8s-01

const content: LessonContent = {
  summary: '컨테이너가 많아지면 사람 대신 관리해줄 무언가가 필요하다',
  concept: 'Pod <script> & "quotes"',
  whyItMatters: 'AI가 만든 매니페스트를 읽으려면 필요하다',
  keyPoints: ['선언형', '자가 복구'],
  example: { lang: 'yaml', code: 'kind: Pod\nmetadata:\n  name: <demo>', note: '최소 Pod' },
  aiTip: '"Deployment 매니페스트를 만들어줘"라고 시키고 resources를 확인',
  practice: 'kind로 클러스터 띄우기',
  quiz: { question: 'Pod는 왜 직접 만들지 않나?', answer: '일회용이라 컨트롤러가 관리해야 해서' },
};

describe('parseLessonContent', () => {
  it('JSON 앞뒤 잡음이 있어도 파싱', () => {
    const text = `여기 있습니다:\n${JSON.stringify(content)}\n끝`;
    expect(parseLessonContent(text)).toEqual(content);
  });

  it('필수 필드(concept, keyPoints)가 없으면 throw', () => {
    expect(() => parseLessonContent(JSON.stringify({ ...content, concept: '' }))).toThrow();
    expect(() => parseLessonContent(JSON.stringify({ ...content, keyPoints: [] }))).toThrow();
    expect(() => parseLessonContent('JSON 아님')).toThrow();
  });

  it('선택 필드(example, quiz)가 불완전하면 생략', () => {
    const parsed = parseLessonContent(
      JSON.stringify({ ...content, example: { lang: 'yaml', code: '' }, quiz: { question: 'q' } })
    );
    expect(parsed.example).toBeUndefined();
    expect(parsed.quiz).toBeUndefined();
  });
});

describe('buildLessonPrompt', () => {
  it('레슨 포인트와 이전 레슨, 난이도 모드를 담는다', () => {
    const p: LearningProgress = { ...initialProgress(NOW), next: { k8s: 2 } };
    const prompt = buildLessonPrompt(planNextLesson(p, CURRICULUM));
    const lesson = CURRICULUM[0].lessons[2];
    expect(prompt).toContain(lesson.title);
    for (const pt of lesson.points) expect(prompt).toContain(pt);
    expect(prompt).toContain(CURRICULUM[0].lessons[0].title);
    expect(prompt).toContain('처음 배우는 사람');
  });

  it('쉽게 다시 모드면 쉬운 설명을 요구한다', () => {
    const p: LearningProgress = { ...initialProgress(NOW), retryLessonId: 'jk-02' };
    expect(buildLessonPrompt(planNextLesson(p, CURRICULUM))).toContain('더 쉽게');
  });
});

describe('formatLesson', () => {
  it('HTML 이스케이프 + 코드블록 + 스포일러 + 공식 문서 + 진도', () => {
    const [msg, ...rest] = formatLesson(plan, content, [], { completed: 3, total: 45 });
    expect(rest).toEqual([]);
    expect(msg).toContain('Pod &lt;script&gt; &amp; "quotes"');
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('<pre><code class="language-yaml">kind: Pod\nmetadata:\n  name: &lt;demo&gt;</code></pre>');
    expect(msg).toContain('<tg-spoiler>');
    expect(msg).toContain(plan.lesson.refs[0]);
    expect(msg).toContain('완료 3 / 전체 45');
    expect(msg).toContain('1/9');
  });

  it('관련 글 링크는 href 속성까지 이스케이프', () => {
    const [msg] = formatLesson(plan, content, [{ title: 'A & B', url: 'https://x.com/?a=1&b="2"' }], {
      completed: 0,
      total: 45,
    });
    expect(msg).toContain('<a href="https://x.com/?a=1&amp;b=&quot;2&quot;">A &amp; B</a>');
  });

  it('길면 섹션 경계에서 여러 메시지로 나눈다 (태그가 잘리지 않음)', () => {
    const long = { ...content, concept: '가'.repeat(1200), aiTip: '나'.repeat(700), practice: '다'.repeat(500) };
    const huge = { ...long, example: { lang: 'yaml', code: 'x'.repeat(1500) } };
    const msgs = formatLesson(plan, huge, [], { completed: 0, total: 45 });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(3800);
      expect((m.match(/<pre>/g) ?? []).length).toBe((m.match(/<\/pre>/g) ?? []).length);
    }
  });

  it('심화/쉽게 다시 배지', () => {
    const deep = planNextLesson({ ...initialProgress(NOW), next: { k8s: 9 } }, CURRICULUM);
    expect(formatLesson(deep, content, [], { completed: 0, total: 45 })[0]).toContain('🧠 심화 2회차');
    const easier = planNextLesson({ ...initialProgress(NOW), retryLessonId: 'k8s-01' }, CURRICULUM);
    expect(formatLesson(easier, content, [], { completed: 0, total: 45 })[0]).toContain('🔁 쉽게 다시');
  });

  it('레슨 버튼은 done/again', () => {
    const kb = buildLessonKeyboard('k8s-01');
    expect(kb.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['l1|done|k8s-01', 'l1|again|k8s-01']);
  });
});

describe('packSections', () => {
  it('한도 안에서 합치고, 넘으면 새 메시지', () => {
    expect(packSections(['aaa', 'bbb', 'ccc'], 8)).toEqual(['aaa\n\nbbb', 'ccc']);
  });
  it('한 섹션이 한도보다 커도 버리지 않는다', () => {
    expect(packSections(['x'.repeat(10)], 5)).toEqual(['x'.repeat(10)]);
  });
});

describe('Notion 레슨 페이지', () => {
  it('URL 키 = 대표 문서 + 레슨 id + 날짜', () => {
    expect(lessonPageUrl(plan, '2026-09-30')).toBe(`${plan.lesson.refs[0]}#hariesse-k8s-01-2026-09-30`);
  });

  it('블록: 코드 언어 매핑, 퀴즈 토글, 2000자 제한 분할', () => {
    const blocks = buildLessonBlocks(plan, {
      ...content,
      concept: '가'.repeat(4000),
      example: { lang: 'Dockerfile', code: 'FROM node:20' },
    }) as { type: string; [k: string]: any }[];
    const code = blocks.find((b) => b.type === 'code')!;
    expect(code.code.language).toBe('docker');
    expect(blocks.some((b) => b.type === 'toggle')).toBe(true);
    for (const b of blocks) {
      for (const rt of b[b.type].rich_text ?? []) expect(rt.text.content.length).toBeLessThanOrEqual(2000);
    }
  });
});
