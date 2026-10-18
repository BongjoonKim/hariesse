export type Category = 'travel' | 'dev-ai' | 'cloud' | 'design';
export type SourceType = 'blog' | 'youtube' | 'hackernews' | 'arxiv' | 'reddit';
export type ArticleStatus = 'unread' | 'reading' | 'read' | 'starred' | 'skipped';
export type Slot = 'exploit' | 'explore';

export interface Source {
  siteId: string;
  domain: string;
  name: string;
  category: Category;
  /** 소스 종류. 없으면 'blog'(RSS 원문) 취급 — 수집 어댑터 선택에 쓰인다. */
  type?: SourceType;
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
  /** 원문과 별개의 토론 링크 (Reddit 링크글의 댓글 스레드 등) */
  discussionUrl?: string;
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

/** Bedrock이 쓴 학습 레슨 본문 (구조화 — 포맷은 telegram/notion이 담당) */
export interface LessonContent {
  /** 한 줄 요약 */
  summary: string;
  /** 핵심 개념 설명 */
  concept: string;
  /** 실무·AI 활용 관점에서 왜 중요한지 */
  whyItMatters: string;
  keyPoints: string[];
  example?: { lang: string; code: string; note?: string };
  /** AI 코딩 도구에 시킬 때 쓸 프롬프트 예시 + 검증 포인트 */
  aiTip: string;
  /** 10분 실습 과제 */
  practice: string;
  quiz?: { question: string; answer: string };
}

// ---------------------------------------------------------------- TOEFL 단어장

/** 단어·짧은 표현 vs 문장. 문장은 품사 대신 번역 + 핵심 표현을 채운다. */
export type VocabKind = 'word' | 'sentence';
/** new = 아직 뜻을 안 채움(Notion에 직접 넣은 직후 등), learning = 복습 중, mastered = 외움(복습 끝) */
export type VocabStatus = 'new' | 'learning' | 'mastered';
export type VocabOrigin = 'telegram' | 'notion';

/** Bedrock이 채워주는 단어 정보. 문장이면 meaning = 한국어 번역. */
export interface VocabEnrichment {
  meaning: string;
  pos?: string;
  pronunciation?: string;
  example?: string;
  exampleKo?: string;
  synonyms: string[];
  /** TOEFL 팁(콜로케이션·자주 나오는 맥락) / 문장이면 핵심 표현 정리 */
  note?: string;
  /** 입력에 오타가 있으면 철자만 고친 표현 전체. 고칠 게 없으면 비어 있다. */
  correctedText?: string;
}

/** 사용자의 수정 요청을 반영한 카드. text는 표현 자체를 고칠 때만 (철자 등). */
export interface VocabRevision extends VocabEnrichment {
  text?: string;
}

/**
 * 한국어가 섞인 단어장 메시지의 의도.
 * new = 새 표현 저장 / revise = 마지막(답장) 카드의 뜻·예문 수정 / append = 마지막(답장) 카드의 표현 뒤에 영어 절을 이어 붙임.
 */
export type VocabIntent = 'new' | 'revise' | 'append';

export interface VocabIntentResult {
  intent: VocabIntent;
  /** 한국어 지시를 뺀 영어 본문. new면 저장할 표현, append면 이어 붙일 절. revise면 비어 있을 수 있다. */
  english: string;
  /** 한국어 지시 부분 (revise/append의 요청 내용). */
  instruction?: string;
}

/** Notion "TOEFL Vocab" DB 한 행. Notion이 원본 저장소다. */
export interface VocabEntry {
  /** Notion page id (하이픈 없는 32자) */
  pageId: string;
  text: string;
  /** dedup 키 — normalizeVocabKey(text). Notion에서 직접 넣은 행은 enrich 전까지 비어 있다. */
  key?: string;
  kind?: VocabKind;
  meaning?: string;
  pos?: string;
  pronunciation?: string;
  example?: string;
  synonyms?: string;
  note?: string;
  tags: string[];
  /** Leitner 박스 0~5 */
  box: number;
  /** KST YYYY-MM-DD */
  nextReview?: string;
  lastReviewed?: string;
  status?: VocabStatus;
  missCount: number;
  origin?: VocabOrigin;
  /** KST YYYY-MM-DD (Notion created_time 기준) */
  createdDate?: string;
}
