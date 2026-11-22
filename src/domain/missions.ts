import { addDays } from './vocab';

/**
 * 웹 "오늘의 미션" 도메인 로직 (순수함수, 테스트 대상).
 * 목적: 영어·기술 글·독서를 미루지 않게 하루치 할 일을 작게 정해 주고, 다 하면 연속 기록(🔥)이 이어진다.
 * - vocab  : 오늘 복습할 차례인 표현 (Leitner). Telegram 21:00 복습으로 답한 것도 같이 센다 (`마지막 복습` = 오늘).
 * - writing: 한국어를 보고 영어로 써 보기. 웹에서 직접 써 본 문장만 센다 (Telegram 출제는 읽기만 해도 되므로 안 센다).
 * - add    : 새 표현·문장 등록 (Telegram·Notion·웹 어디서 넣든 오늘 추가된 것).
 * - tech   : 오늘 다이제스트·레슨에서 읽은 기술 글.
 * - book   : 독서 체크인 (직접 체크).
 * 목표가 0인 미션은 꺼진 것이다. 미션을 늘릴 때는 MissionId와 buildMissions에만 추가하면 된다.
 */

export type MissionId = 'vocab' | 'writing' | 'add' | 'tech' | 'book';

export interface MissionSettings {
  /** 하루 단어 복습 상한 (복습할 게 이보다 적으면 있는 만큼만) */
  vocabGoal: number;
  writingGoal: number;
  addGoal: number;
  /** 읽을 기술 글 수. 0 = 끔 */
  techGoal: number;
  bookEnabled: boolean;
  /** 지금 읽는 책 (표시용) */
  bookTitle?: string;
  /** 하루 독서 목표 (표시용, 예: "20분", "10쪽") */
  bookTarget?: string;
}

export const DEFAULT_SETTINGS: MissionSettings = {
  vocabGoal: 10,
  writingGoal: 5,
  addGoal: 3,
  techGoal: 1,
  bookEnabled: true,
  bookTarget: '20분',
};

const GOAL_MAX = 50;

function goal(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(GOAL_MAX, Math.max(0, Math.round(n))) : fallback;
}

function label(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** 저장된 값·요청 본문 → 설정. 모르는 키는 버리고 숫자는 0~50으로 자른다. */
export function normalizeSettings(raw: unknown, base: MissionSettings = DEFAULT_SETTINGS): MissionSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k);
  return {
    vocabGoal: goal(r.vocabGoal, base.vocabGoal),
    writingGoal: goal(r.writingGoal, base.writingGoal),
    addGoal: goal(r.addGoal, base.addGoal),
    techGoal: goal(r.techGoal, base.techGoal),
    bookEnabled: typeof r.bookEnabled === 'boolean' ? r.bookEnabled : base.bookEnabled,
    bookTitle: has('bookTitle') ? label(r.bookTitle, 80) : base.bookTitle,
    bookTarget: has('bookTarget') ? label(r.bookTarget, 30) : base.bookTarget,
  };
}

/** 하루치 기록 (학습 테이블 pk='DAY', sk=KST 날짜). 단어·등록 수는 미러에서 세므로 여기 없다. */
export interface DayRecord {
  date: string;
  /** 웹에서 써 본 Writing 문장 (Notion page id) */
  writingIds: string[];
  /** 읽음으로 표시한 글 (articleId 또는 lesson:<id>) */
  techIds: string[];
  book?: { done: boolean; memo?: string };
  /** 마지막으로 계산한 결과 — 연속 기록·달력용 */
  done?: number;
  total?: number;
  complete?: boolean;
}

export function emptyDay(date: string): DayRecord {
  return { date, writingIds: [], techIds: [] };
}

/** 미러에서 센 오늘 숫자 */
export interface DayStats {
  /** 지금 복습할 차례인 표현 수 (아직 안 한 것) */
  vocabDue: number;
  /** 오늘 복습한 표현 수 */
  vocabReviewedToday: number;
  /** 오늘 추가된 표현 + 문장 수 */
  addedToday: number;
  /** 출제할 수 있는 Writing 문장 수 */
  writingAvailable: number;
}

export interface Mission {
  id: MissionId;
  emoji: string;
  title: string;
  done: number;
  goal: number;
  complete: boolean;
  hint: string;
}

/**
 * 오늘의 미션 목록. 꺼진 미션(목표 0)은 빠진다.
 * 단어 복습은 "오늘 차례인 것"만이 목표라, 차례인 게 없으면 목표 0으로 이미 끝난 미션이 된다 (하루 완료를 막지 않는다).
 */
export function buildMissions(settings: MissionSettings, day: DayRecord, stats: DayStats): Mission[] {
  const missions: Mission[] = [];
  const add = (id: MissionId, emoji: string, title: string, done: number, target: number, hint: string) => {
    missions.push({ id, emoji, title, done: Math.min(done, target), goal: target, complete: done >= target, hint });
  };

  if (settings.vocabGoal > 0) {
    const target = Math.min(settings.vocabGoal, stats.vocabDue + stats.vocabReviewedToday);
    const left = Math.max(0, stats.vocabDue - Math.max(0, target - stats.vocabReviewedToday));
    add(
      'vocab',
      '🧠',
      '단어 복습',
      stats.vocabReviewedToday,
      target,
      target === 0 ? '오늘 복습할 차례인 표현이 없어요' : left > 0 ? `목표 밖에 ${left}개 더 밀려 있어요` : '복습할 차례인 표현'
    );
  }
  if (settings.writingGoal > 0) {
    const target = Math.min(settings.writingGoal, stats.writingAvailable);
    add('writing', '✍️', 'Writing 영작', day.writingIds.length, target, target === 0 ? '출제할 문장이 아직 없어요' : '한국어를 보고 영어로 쓰기');
  }
  if (settings.addGoal > 0) {
    add('add', '➕', '새 표현 등록', stats.addedToday, settings.addGoal, '오늘 만난 단어·문장 적어 두기');
  }
  if (settings.techGoal > 0) {
    add('tech', '📰', '기술 글 읽기', day.techIds.length, settings.techGoal, '오늘 다이제스트·레슨에서 골라 읽기');
  }
  if (settings.bookEnabled) {
    const what = [settings.bookTitle, settings.bookTarget].filter(Boolean).join(' · ');
    add('book', '📚', '책 읽기', day.book?.done ? 1 : 0, 1, what || '오늘 읽은 만큼 체크');
  }
  return missions;
}

export interface DaySummary {
  done: number;
  total: number;
  complete: boolean;
}

/** 하루 완료 = 미션이 하나라도 있고 전부 끝남. */
export function summarize(missions: Mission[]): DaySummary {
  const done = missions.filter((m) => m.complete).length;
  return { done, total: missions.length, complete: missions.length > 0 && done === missions.length };
}

/**
 * 연속 기록. 오늘을 아직 못 끝냈어도 어제까지 이어졌으면 끊긴 게 아니다 (오늘 안에 하면 이어진다).
 * best = 기록 전체에서 가장 길었던 연속.
 */
export function computeStreak(completeDates: Iterable<string>, today: string): { current: number; best: number; todayDone: boolean } {
  const set = new Set(completeDates);
  const todayDone = set.has(today);
  let current = 0;
  for (let d = todayDone ? today : addDays(today, -1); set.has(d); d = addDays(d, -1)) current++;

  let best = 0;
  for (const d of set) {
    if (set.has(addDays(d, -1))) continue; // 연속의 첫날에서만 센다
    let run = 0;
    for (let x = d; set.has(x); x = addDays(x, 1)) run++;
    best = Math.max(best, run);
  }
  return { current, best: Math.max(best, current), todayDone };
}

/** today로 끝나는 최근 n일 (오래된 날 먼저). */
export function lastDays(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}
