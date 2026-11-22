import type { LibraryPayload, TechPayload, TodayPayload, VocabEntry, WritingEntry } from '../../src/lib/web-types';

/** 앱 상태 + API 호출. 화면(views)은 여기 상태를 읽어 그리고, 바꾸고 나면 rerender()를 부른다. */

export interface State {
  authed?: boolean;
  today?: TodayPayload;
  lib?: LibraryPayload;
  tech?: TechPayload;
  syncing: boolean;
}

export const state: State = { syncing: false };

let renderFn: () => void = () => undefined;
export function setRenderer(fn: () => void): void {
  renderFn = fn;
}
export function rerender(): void {
  renderFn();
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-hariesse': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, '네트워크에 연결하지 못했어요');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') {
      state.authed = false;
      rerender();
    }
    throw new ApiError(res.status, data.error ?? `오류 (${res.status})`);
  }
  return data as T;
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2600);
}

/**
 * 변경 요청. 응답에 today가 있으면 미션 상태를 갱신한다. 실패하면 토스트를 띄우고 undefined.
 */
export async function act<T extends { today?: TodayPayload }>(path: string, body: unknown): Promise<T | undefined> {
  try {
    const res = await api<T>(path, body);
    if (res.today) state.today = res.today;
    return res;
  } catch (err) {
    toast((err as Error).message);
    return undefined;
  }
}

export function vocabById(id: string): VocabEntry | undefined {
  return state.lib?.vocab.find((e) => e.pageId === id);
}
export function writingById(id: string): WritingEntry | undefined {
  return state.lib?.writing.find((e) => e.pageId === id);
}

export function upsertVocab(entry: VocabEntry): void {
  if (!state.lib) return;
  const i = state.lib.vocab.findIndex((e) => e.pageId === entry.pageId);
  if (i === -1) state.lib.vocab.push(entry);
  else state.lib.vocab[i] = entry;
}
export function upsertWriting(entry: WritingEntry): void {
  if (!state.lib) return;
  const i = state.lib.writing.findIndex((e) => e.pageId === entry.pageId);
  if (i === -1) state.lib.writing.push(entry);
  else state.lib.writing[i] = entry;
}
export function removeVocab(id: string): void {
  if (state.lib) state.lib.vocab = state.lib.vocab.filter((e) => e.pageId !== id);
}

/** 사본이 이보다 오래됐으면 화면을 열 때 Notion에서 다시 받아 온다 (Telegram·Notion에서 바꾼 것 반영). */
const STALE_MS = 10 * 60 * 1000;

export async function load(): Promise<void> {
  try {
    const [today, lib] = await Promise.all([api<TodayPayload>('/today'), api<LibraryPayload>('/library')]);
    state.today = today;
    state.lib = lib;
    state.authed = true;
  } catch (err) {
    if ((err as ApiError).status === 401) state.authed = false;
    else toast((err as Error).message);
  }
  rerender();
  const syncedAt = state.today?.syncedAt;
  if (state.authed && (!syncedAt || Date.now() - Date.parse(syncedAt) > STALE_MS)) void sync(true);
}

export async function sync(quiet = false): Promise<void> {
  if (state.syncing) return;
  state.syncing = true;
  if (!quiet) rerender();
  try {
    const res = await api<{ today: TodayPayload; library: LibraryPayload }>('/sync', {});
    state.today = res.today;
    state.lib = res.library;
    if (!quiet) toast('Notion과 맞췄어요');
  } catch (err) {
    if (!quiet) toast((err as Error).message);
  }
  state.syncing = false;
  // 문제를 푸는 중에는 화면을 갈아엎지 않는다
  if (!quiet || !location.hash.startsWith('#/session')) rerender();
}

export function go(hash: string): void {
  if (location.hash === hash) rerender();
  else location.hash = hash;
}
