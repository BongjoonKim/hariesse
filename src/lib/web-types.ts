import type { Mission, MissionSettings, DaySummary } from '../domain/missions';
import type { TechArticle } from './study-store';
import type { VocabEntry, WritingEntry } from './types';

/** 웹 API 응답 형식 — WebFn(src/handlers/web)과 프론트(web/src)가 같이 쓴다. 타입만 둔다. */

export interface DayCell extends DaySummary {
  date: string;
}

export interface TodayPayload {
  date: string;
  missions: Mission[];
  summary: DaySummary;
  streak: { current: number; best: number; todayDone: boolean };
  /** 최근 126일(18주), 오래된 날 먼저 — 달력용 */
  history: DayCell[];
  settings: MissionSettings;
  book?: { done: boolean; memo?: string };
  /** 오늘 복습할 차례인 표현 (오래 밀린 순) */
  dueIds: string[];
  /** Writing 출제 순서 (오늘 웹에서 이미 쓴 문장 제외, 덜 나온 것 먼저) */
  quizIds: string[];
  /** 오늘 읽음으로 표시한 글 */
  techIds: string[];
  /** 마지막 Notion 동기화 시각 (ISO). 한 번도 안 했으면 없음 */
  syncedAt?: string;
}

export interface LibraryPayload {
  vocab: VocabEntry[];
  writing: WritingEntry[];
}

export interface TechLesson {
  /** 읽음 표시에 쓰는 id (`lesson:<레슨 id>:<발송일>`) */
  id: string;
  title: string;
  track: string;
  sentDate: string;
  refs: string[];
}

export interface TechPayload {
  articles: TechArticle[];
  lesson?: TechLesson;
}

export interface AddOutcome {
  input: string;
  ok: boolean;
  /** 이미 있던 표현 */
  repeated?: boolean;
  /** "✏️ 철자 교정: a → b" 또는 Writing에서 고친 내용 */
  note?: string;
  error?: string;
  vocab?: VocabEntry;
  writing?: WritingEntry;
}

export type { TechArticle, Mission, MissionSettings, DaySummary, VocabEntry, WritingEntry };
