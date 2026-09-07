import type { Routine, TaskInstance, TaskStatus } from './types';

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 401) throw new UnauthorizedError();
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data as T;
}

export interface DaySummary {
  total: number;
  done: number;
  skipped: number;
  todo: number;
  rate: number;
}

export interface Me {
  email: string;
  /** 서버(KST) 기준 오늘 — 기기 시간대에 흔들리지 않게 서버 값을 쓴다 */
  today: string;
}

export interface RoutineBody {
  title: string;
  daysOfWeek: number[];
  timeOfDay?: string;
  remindSlots?: string[];
  category?: string;
  estimatedMinutes?: number;
  note?: string;
  active: boolean;
}

export const api = {
  me: () => req<Me>('/me'),
  logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST' }),

  listRoutines: () => req<{ routines: Routine[] }>('/routines'),
  createRoutine: (body: RoutineBody) =>
    req<{ routine: Routine }>('/routines', { method: 'POST', body: JSON.stringify(body) }),
  updateRoutine: (id: string, body: RoutineBody) =>
    req<{ routine: Routine }>(`/routines/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteRoutine: (id: string) => req<{ ok: true }>(`/routines/${id}`, { method: 'DELETE' }),

  day: (date: string) =>
    req<{ date: string; tasks: TaskInstance[]; summary: DaySummary }>(`/days/${date}`),
  addTask: (date: string, body: { title: string; timeOfDay?: string; note?: string }) =>
    req<{ task: TaskInstance }>(`/days/${date}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setStatus: (date: string, sk: string, status: TaskStatus) =>
    req<{ task: TaskInstance }>(`/days/${date}/tasks/${sk}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  deleteTask: (date: string, sk: string) =>
    req<{ ok: true }>(`/days/${date}/tasks/${sk}`, { method: 'DELETE' }),
};

/** 서버 `summarizeDay`와 같은 규칙 — 스킵은 분모에서 뺀다. */
export function summarize(tasks: TaskInstance[]): DaySummary {
  const done = tasks.filter((t) => t.status === 'done').length;
  const skipped = tasks.filter((t) => t.status === 'skipped').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const counted = tasks.length - skipped;
  return { total: tasks.length, done, skipped, todo, rate: counted <= 0 ? 1 : done / counted };
}

// ---- 날짜 유틸 (서버의 src/domain/routine.ts와 같은 규칙) ----

export const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function dateLabel(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)} (${DAY_LABEL[weekdayOf(date)]})`;
}
