import type { Article } from '../lib/types';
import type { Lesson, Track } from './curriculum';

/**
 * 학습 트랙 도메인 로직 (순수함수, 테스트 대상).
 * - 진도: 트랙을 라운드로빈으로 돌고, 트랙 안에서는 레슨 순서대로 간다.
 *   하루는 Kubernetes, 다음 날은 Jenkins … 식이라 한 주제에 질리지 않으면서 전 영역이 고르게 쌓인다.
 * - 한 바퀴를 다 돌면 같은 목차를 '심화' 모드로 다시 돈다.
 * - "🔁 쉽게 다시"를 누르면 다음 회차는 진도를 멈추고 그 레슨을 쉬운 버전으로 다시 보낸다.
 */

export type LessonMode = 'normal' | 'easier' | 'deep';

/** Profile 테이블에 pk='LEARNING' 단일 아이템으로 저장 */
export interface LearningProgress {
  pk: 'LEARNING';
  /** 다음 차례 트랙 순번 (누적, tracks.length로 나눈 나머지가 트랙) */
  turn: number;
  /** 트랙별 다음 레슨 순번 (누적, lessons.length 이상이면 심화 회차) */
  next: Record<string, number>;
  /** 쉽게 다시 설명할 레슨 id — 다음 회차에 진도 대신 보낸다 */
  retryLessonId?: string;
  /** "✅ 이해했어요"를 누른 레슨 id */
  completed: string[];
  /** 마지막 발송일 (KST YYYY-MM-DD) — 같은 날 중복 발송 방지 */
  lastSentDate?: string;
  lastLessonId?: string;
  updatedAt: string;
}

export interface LessonPlan {
  track: Track;
  lesson: Lesson;
  /** 트랙 내 0-based 위치 */
  index: number;
  /** 0 = 첫 회차, 1+ = 심화 회차 */
  round: number;
  mode: LessonMode;
  /** 같은 트랙에서 이 레슨 앞에 나온 레슨 제목 (프롬프트의 연속성 맥락) */
  previousTitles: string[];
}

export function initialProgress(now: string): LearningProgress {
  return { pk: 'LEARNING', turn: 0, next: {}, completed: [], updatedAt: now };
}

export function findLesson(
  tracks: Track[],
  lessonId: string
): { track: Track; lesson: Lesson; index: number } | undefined {
  for (const track of tracks) {
    const index = track.lessons.findIndex((l) => l.id === lessonId);
    if (index !== -1) return { track, lesson: track.lessons[index], index };
  }
  return undefined;
}

export function totalLessons(tracks: Track[]): number {
  return tracks.reduce((sum, t) => sum + t.lessons.length, 0);
}

/** 이번 회차에 보낼 레슨을 고른다. 진도는 바꾸지 않는다 (advanceProgress가 담당). */
export function planNextLesson(progress: LearningProgress, tracks: Track[]): LessonPlan {
  if (tracks.length === 0) throw new Error('커리큘럼이 비어 있음');

  if (progress.retryLessonId) {
    const found = findLesson(tracks, progress.retryLessonId);
    if (found) {
      return {
        ...found,
        round: 0,
        mode: 'easier',
        previousTitles: found.track.lessons.slice(0, found.index).map((l) => l.title),
      };
    }
    // 커리큘럼에서 빠진 레슨이면 무시하고 정상 진도로
  }

  const track = tracks[mod(progress.turn, tracks.length)];
  const cursor = progress.next[track.id] ?? 0;
  const index = mod(cursor, track.lessons.length);
  const round = Math.floor(cursor / track.lessons.length);
  return {
    track,
    lesson: track.lessons[index],
    index,
    round,
    mode: round > 0 ? 'deep' : 'normal',
    previousTitles: track.lessons.slice(0, index).map((l) => l.title),
  };
}

/** 발송 성공 후 진도 갱신. '쉽게 다시' 회차는 진도를 움직이지 않고 재시도 표시만 지운다. */
export function advanceProgress(
  progress: LearningProgress,
  plan: LessonPlan,
  sentDate: string,
  now: string
): LearningProgress {
  const base = { ...progress, lastSentDate: sentDate, lastLessonId: plan.lesson.id, updatedAt: now };
  if (plan.mode === 'easier') {
    return { ...base, retryLessonId: undefined };
  }
  return {
    ...base,
    turn: progress.turn + 1,
    next: { ...progress.next, [plan.track.id]: (progress.next[plan.track.id] ?? 0) + 1 },
  };
}

// ---------------------------------------------------------------- 버튼 (callback_data)

export type LessonAction = 'done' | 'again';

const LESSON_PREFIX = 'l1';
const LESSON_ACTIONS: readonly LessonAction[] = ['done', 'again'];

/** "l1|again|k8s-01" — 기사 피드백(v1|...)과 prefix로 구분. 64바이트 제한 안쪽. */
export function encodeLessonCallback(action: LessonAction, lessonId: string): string {
  return `${LESSON_PREFIX}|${action}|${lessonId}`;
}

export function decodeLessonCallback(
  data: string | undefined
): { action: LessonAction; lessonId: string } | undefined {
  if (!data) return undefined;
  const parts = data.split('|');
  if (parts.length !== 3) return undefined;
  const [prefix, action, lessonId] = parts;
  if (prefix !== LESSON_PREFIX || !lessonId) return undefined;
  if (!LESSON_ACTIONS.includes(action as LessonAction)) return undefined;
  return { action: action as LessonAction, lessonId };
}

/** 버튼 효과 적용. changed=false면 저장할 필요 없음 (중복 클릭). */
export function applyLessonFeedback(
  progress: LearningProgress,
  action: LessonAction,
  lessonId: string,
  now: string
): { progress: LearningProgress; changed: boolean; ack: string } {
  if (action === 'done') {
    if (progress.completed.includes(lessonId)) {
      return { progress, changed: false, ack: '이미 완료로 기록했어요' };
    }
    return {
      progress: { ...progress, completed: [...progress.completed, lessonId], updatedAt: now },
      changed: true,
      ack: '✅ 완료! 다음 레슨으로 이어갈게요',
    };
  }
  if (progress.retryLessonId === lessonId) {
    return { progress, changed: false, ack: '이미 다시 보내기로 했어요' };
  }
  return {
    progress: { ...progress, retryLessonId: lessonId, updatedAt: now },
    changed: true,
    ack: '🔁 다음 회차에 더 쉽게 다시 설명할게요',
  };
}

// ---------------------------------------------------------------- 관련 글

/**
 * hariesse가 수집·큐레이션한 글 중 트랙 키워드에 맞는 글을 고른다.
 * 제목/태그에 키워드가 들어간 글만, 점수 높은 순. 스킵한 글은 제외.
 * 짧은 키워드('node', 'rag' 등)는 단어 경계로만 매칭해 'storage'·'weeks' 같은 오탐을 막는다 (복수형 s는 허용).
 */
export function pickRelatedArticles(
  articles: Article[],
  keywords: string[],
  limit: number,
  minScore = 50
): Article[] {
  const matchers = keywords.map(keywordMatcher);
  const seen = new Set<string>();
  return articles
    .filter((a) => typeof a.score === 'number' && a.score >= minScore && a.status !== 'skipped')
    .filter((a) => {
      const hay = [a.title, ...(a.tags ?? [])].join(' ').toLowerCase();
      return matchers.some((m) => m(hay));
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((a) => (seen.has(a.articleId) ? false : (seen.add(a.articleId), true)))
    .slice(0, limit);
}

function keywordMatcher(keyword: string): (hay: string) => boolean {
  const kw = keyword.toLowerCase();
  // 한글이나 기호가 섞인 키워드는 경계 개념이 애매하니 부분일치
  if (!/^[a-z0-9]+$/.test(kw) || kw.length > 5) return (hay) => hay.includes(kw);
  const re = new RegExp(`(^|[^a-z0-9])${kw}s?([^a-z0-9]|$)`);
  return (hay) => re.test(hay);
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
