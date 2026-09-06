export type Category = 'travel' | 'dev-ai' | 'cloud';
export type SourceType = 'blog' | 'youtube' | 'hackernews' | 'arxiv' | 'reddit';
export type ArticleStatus = 'unread' | 'reading' | 'read' | 'starred' | 'skipped';
export type Slot = 'exploit' | 'explore';

export interface Source {
  siteId: string;
  domain: string;
  name: string;
  category: Category;
  feedUrl?: string;
  weight: number;
  likeCount: number;
  skipCount: number;
  status: 'active' | 'candidate' | 'muted';
  lastCrawledAt?: string;
  discoveredAt?: string;
  discoverySource?: string;
}

export interface Article {
  articleId: string; // URL 해시 (dedup 키)
  url: string;
  title: string;
  siteId: string;
  category: Category;
  source: SourceType;
  score?: number; // relevance 0~100
  status: ArticleStatus;
  summary?: string;
  aiOpinion?: string;
  tags?: string[];
  layoutType?: string;
  liked?: boolean;
  nadelivCandidate?: boolean;
  slot?: Slot;
  textS3Key?: string;
  collectedAt: string;
  curatedAt?: string;
  deliveredAt?: string;
  ttl?: number;
  // 피드백 idempotency 마커 — 액션당 1회만 반영 (`${action}FeedbackAt`)
  likeFeedbackAt?: string;
  siteFeedbackAt?: string;
  saveFeedbackAt?: string;
  skipFeedbackAt?: string;
}

export interface Profile {
  pk: 'PROFILE';
  interests: Record<string, number>; // 가중 키워드 맵
  likedPatterns?: string;
  preferences?: Record<string, unknown>;
  explorationRatio: number;
  updatedAt: string;
}

/** Bedrock 큐레이션 결과 */
export interface Curation {
  score: number;
  summary: string;
  aiOpinion: string;
  tags: string[];
}

// ---- 일정/할일 (assistant) ----

/** 하루 3회 브리핑 슬롯 — 09:00 / 12:00 / 20:00 KST */
export type BriefSlot = 'morning' | 'midday' | 'evening';
export type TaskStatus = 'todo' | 'done' | 'skipped';

/**
 * 반복 할일 정의 (예: "매주 월 — 토플 Reading 1지문").
 * hariesse가 소스 오브 트루스. Tasks 테이블에 pk='ROUTINE'으로 저장.
 */
export interface Routine {
  pk: 'ROUTINE';
  sk: string; // = routineId
  routineId: string;
  title: string;
  daysOfWeek: number[]; // 0=일 … 6=토
  timeOfDay?: string; // "HH:MM" (KST) — 정렬·표시용
  remindSlots?: BriefSlot[]; // 비우면 3회 모두 리마인드
  category?: string;
  estimatedMinutes?: number;
  note?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 특정 날짜의 할일 1건. Routine에서 매일 전개되거나(origin='routine'),
 * 웹/텔레그램에서 단건 추가된다(origin='adhoc'). pk='DAY#YYYY-MM-DD'.
 */
export interface TaskInstance {
  pk: string; // `DAY#${date}`
  sk: string; // routineId | `x<8hex>` (adhoc)
  date: string; // YYYY-MM-DD (KST)
  title: string;
  status: TaskStatus;
  origin: 'routine' | 'adhoc';
  routineId?: string;
  timeOfDay?: string;
  remindSlots?: BriefSlot[];
  category?: string;
  estimatedMinutes?: number;
  note?: string;
  doneAt?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}
