/**
 * 할일/루틴 도메인 로직 — 순수함수, 단위테스트 대상.
 * 네트워크·DynamoDB 접근은 여기 두지 않는다 (스코어링/추출과 같은 원칙).
 */
import type { BriefSlot, Routine, TaskInstance, TaskStatus } from '../lib/types';

/** 한국은 서머타임이 없어 UTC+9 고정 오프셋으로 안전하게 환산된다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'] as const;
export const ALL_SLOTS: readonly BriefSlot[] = ['morning', 'midday', 'evening'];

/** 브리핑 슬롯별 KST 발송 시각 — CDK의 EventBridge 크론과 짝을 이룬다. */
export const SLOT_HOUR_KST: Record<BriefSlot, number> = {
  morning: 9,
  midday: 12,
  evening: 20,
};

export interface KstMoment {
  /** YYYY-MM-DD (KST) */
  date: string;
  /** 0=일 … 6=토 (KST) */
  weekday: number;
  /** HH:MM (KST) */
  time: string;
}

export function kstMoment(now: Date): KstMoment {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    time: shifted.toISOString().slice(11, 16),
  };
}

/** YYYY-MM-DD 에 days를 더한 날짜 (음수 가능). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** "2026-09-07" → "09/07(월)" */
export function dateLabel(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}(${DAY_LABEL[weekdayOf(date)]})`;
}

export const dayPk = (date: string): string => `DAY#${date}`;

// ---- 루틴 → 하루 전개 ----

export function routineRunsOn(routine: Routine, weekday: number): boolean {
  return routine.active && routine.daysOfWeek.includes(weekday);
}

/** 루틴이 어떤 브리핑에 노출될지. 비어 있으면 3회 모두. */
export function slotsOf(routine: Pick<Routine, 'remindSlots'>): BriefSlot[] {
  const slots = routine.remindSlots;
  return slots && slots.length > 0 ? slots : [...ALL_SLOTS];
}

/**
 * 해당 날짜에 돌아야 할 루틴을 TaskInstance로 전개.
 * 실제 저장은 조건부 put(이미 있으면 skip)으로 하므로 여기서 중복은 신경쓰지 않는다.
 */
export function planForDay(
  routines: Routine[],
  date: string,
  at: string,
  ttlDays = 365
): TaskInstance[] {
  const weekday = weekdayOf(date);
  const ttl = Math.floor(new Date(at).getTime() / 1000) + ttlDays * 86400;
  return routines
    .filter((r) => routineRunsOn(r, weekday))
    .map((r) => ({
      pk: dayPk(date),
      sk: r.routineId,
      date,
      title: r.title,
      status: 'todo' as TaskStatus,
      origin: 'routine' as const,
      routineId: r.routineId,
      timeOfDay: r.timeOfDay,
      remindSlots: r.remindSlots,
      category: r.category,
      estimatedMinutes: r.estimatedMinutes,
      note: r.note,
      createdAt: at,
      updatedAt: at,
      ttl,
    }));
}

/** 시각(있는 것 먼저, 이른 순) → 제목 순. 브리핑·웹이 같은 순서를 쓴다. */
export function sortTasks(tasks: TaskInstance[]): TaskInstance[] {
  return [...tasks].sort((a, b) => {
    const at = a.timeOfDay ?? '99:99';
    const bt = b.timeOfDay ?? '99:99';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.title.localeCompare(b.title, 'ko');
  });
}

export interface DaySummary {
  total: number;
  done: number;
  skipped: number;
  todo: number;
  /** 완료율 0~1 (스킵은 분모에서 제외, 전부 스킵이면 1) */
  rate: number;
}

export function summarizeDay(tasks: TaskInstance[]): DaySummary {
  const done = tasks.filter((t) => t.status === 'done').length;
  const skipped = tasks.filter((t) => t.status === 'skipped').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const counted = tasks.length - skipped;
  return {
    total: tasks.length,
    done,
    skipped,
    todo,
    rate: counted <= 0 ? 1 : done / counted,
  };
}

/**
 * 슬롯별 노출 대상.
 * - morning: 오늘 할일 전부 (하루 시작이니 전체를 보여준다)
 * - midday/evening: 해당 슬롯을 구독한 것 중 아직 남은 것만 (이미 끝낸 걸 또 알리지 않는다)
 */
export function tasksForSlot(tasks: TaskInstance[], slot: BriefSlot): TaskInstance[] {
  const sorted = sortTasks(tasks);
  if (slot === 'morning') return sorted;
  return sorted.filter((t) => t.status === 'todo' && slotsOf(t).includes(slot));
}

/** 버튼에 실려 있던 sk 순서대로 다시 정렬 — 눌러도 목록이 재배치되지 않게. */
export function orderTasksBy(skOrder: string[], tasks: TaskInstance[]): TaskInstance[] {
  const byKey = new Map(tasks.map((t) => [t.sk, t]));
  const picked: TaskInstance[] = [];
  for (const sk of skOrder) {
    const t = byKey.get(sk);
    if (t) picked.push(t);
  }
  return picked;
}

// ---- 상태 전이 ----

/** 체크 토글 — 잘못 누른 것을 같은 버튼으로 되돌릴 수 있게 한다. */
export function toggleStatus(current: TaskStatus): TaskStatus {
  return current === 'done' ? 'todo' : 'done';
}

export function skipToggleStatus(current: TaskStatus): TaskStatus {
  return current === 'skipped' ? 'todo' : 'skipped';
}

// ---- Telegram callback_data (64바이트 제한) ----

export type TaskAction = 'toggle' | 'skip';

const TASK_PREFIX = 't1';
const TASK_ACTIONS: readonly TaskAction[] = ['toggle', 'skip'];
const SLOT_CODE: Record<BriefSlot, string> = { morning: 'm', midday: 'd', evening: 'e' };
const CODE_SLOT: Record<string, BriefSlot> = { m: 'morning', d: 'midday', e: 'evening' };

/**
 * `t1|toggle|20260907|m|a1b2c3d4` (29바이트) — 날짜 하이픈을 빼고 슬롯은 한 글자로.
 * 슬롯을 실어야 버튼을 누른 뒤 같은 메시지를 그대로 다시 그릴 수 있다.
 */
export function encodeTaskCallback(
  action: TaskAction,
  date: string,
  slot: BriefSlot,
  sk: string
): string {
  return `${TASK_PREFIX}|${action}|${date.replace(/-/g, '')}|${SLOT_CODE[slot]}|${sk}`;
}

export function decodeTaskCallback(
  data: string | undefined
): { action: TaskAction; date: string; slot: BriefSlot; sk: string } | undefined {
  if (!data) return undefined;
  const parts = data.split('|');
  if (parts.length !== 5) return undefined;
  const [prefix, action, compactDate, slotCode, sk] = parts;
  if (prefix !== TASK_PREFIX || !sk) return undefined;
  if (!TASK_ACTIONS.includes(action as TaskAction)) return undefined;
  if (!/^\d{8}$/.test(compactDate)) return undefined;
  const slot = CODE_SLOT[slotCode];
  if (!slot) return undefined;
  const date = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
  return { action: action as TaskAction, date, slot, sk };
}

/**
 * 알림 피로 방지 — 오늘 할일이 아예 없는 날은 점심/저녁 브리핑을 보내지 않는다.
 * 아침은 하루의 기준점이라 항상 보낸다.
 */
export function shouldSendBrief(
  slot: BriefSlot,
  dayTaskCount: number,
  tomorrowTaskCount: number
): boolean {
  if (slot === 'morning') return true;
  if (slot === 'midday') return dayTaskCount > 0;
  return dayTaskCount > 0 || tomorrowTaskCount > 0;
}

// ---- 웹 API 입력 검증 (순수함수, 테스트 대상) ----

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Parsed<never> => ({ ok: false, error });

export interface RoutineInput {
  title: string;
  daysOfWeek: number[];
  timeOfDay?: string;
  remindSlots?: BriefSlot[];
  category?: string;
  estimatedMinutes?: number;
  note?: string;
  active: boolean;
}

export interface TaskInput {
  title: string;
  timeOfDay?: string;
  category?: string;
  estimatedMinutes?: number;
  note?: string;
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const isTime = (v: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function optionalText(
  raw: Record<string, unknown>,
  key: string,
  max: number
): Parsed<string | undefined> {
  const v = raw[key];
  if (v === undefined || v === null || v === '') return { ok: true, value: undefined };
  if (typeof v !== 'string') return fail(`${key}는 문자열이어야 합니다`);
  const trimmed = v.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (trimmed.length > max) return fail(`${key}는 ${max}자 이하여야 합니다`);
  return { ok: true, value: trimmed };
}

function optionalMinutes(raw: Record<string, unknown>): Parsed<number | undefined> {
  const v = raw.estimatedMinutes;
  if (v === undefined || v === null || v === '') return { ok: true, value: undefined };
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 600) {
    return fail('estimatedMinutes는 1~600 사이 정수여야 합니다');
  }
  return { ok: true, value: n };
}

function commonFields(raw: Record<string, unknown>): Parsed<TaskInput> {
  const title = raw.title;
  if (typeof title !== 'string' || !title.trim()) return fail('title이 필요합니다');
  if (title.trim().length > 120) return fail('title은 120자 이하여야 합니다');

  const timeOfDay = raw.timeOfDay;
  if (timeOfDay !== undefined && timeOfDay !== null && timeOfDay !== '') {
    if (typeof timeOfDay !== 'string' || !isTime(timeOfDay)) {
      return fail('timeOfDay는 HH:MM 형식이어야 합니다');
    }
  }

  const category = optionalText(raw, 'category', 40);
  if (!category.ok) return category;
  const note = optionalText(raw, 'note', 300);
  if (!note.ok) return note;
  const minutes = optionalMinutes(raw);
  if (!minutes.ok) return minutes;

  return {
    ok: true,
    value: {
      title: title.trim(),
      timeOfDay: typeof timeOfDay === 'string' && timeOfDay ? timeOfDay : undefined,
      category: category.value,
      note: note.value,
      estimatedMinutes: minutes.value,
    },
  };
}

export function parseTaskInput(raw: unknown): Parsed<TaskInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('본문이 필요합니다');
  return commonFields(raw as Record<string, unknown>);
}

export function parseRoutineInput(raw: unknown): Parsed<RoutineInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('본문이 필요합니다');
  const obj = raw as Record<string, unknown>;

  const base = commonFields(obj);
  if (!base.ok) return base;

  const days = obj.daysOfWeek;
  if (!Array.isArray(days) || days.length === 0) return fail('daysOfWeek에 요일이 하나는 필요합니다');
  const unique = [...new Set(days)];
  if (!unique.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
    return fail('daysOfWeek는 0(일)~6(토) 정수여야 합니다');
  }

  let remindSlots: BriefSlot[] | undefined;
  const slots = obj.remindSlots;
  if (slots !== undefined && slots !== null) {
    if (!Array.isArray(slots)) return fail('remindSlots는 배열이어야 합니다');
    const picked = [...new Set(slots)];
    if (!picked.every((s) => (ALL_SLOTS as readonly unknown[]).includes(s))) {
      return fail('remindSlots는 morning/midday/evening만 가능합니다');
    }
    // 전부 고른 것과 비우는 것은 같은 의미 — 비워서 저장한다.
    remindSlots =
      picked.length > 0 && picked.length < ALL_SLOTS.length ? (picked as BriefSlot[]) : undefined;
  }

  return {
    ok: true,
    value: {
      ...base.value,
      daysOfWeek: (unique as number[]).sort((a, b) => a - b),
      remindSlots,
      active: obj.active === undefined ? true : obj.active === true,
    },
  };
}

export function parseStatusInput(raw: unknown): Parsed<TaskStatus> {
  const status = (raw as Record<string, unknown> | null)?.status;
  if (status === 'todo' || status === 'done' || status === 'skipped') {
    return { ok: true, value: status };
  }
  return fail('status는 todo/done/skipped 중 하나여야 합니다');
}
