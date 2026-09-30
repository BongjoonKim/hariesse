export type Category = 'travel' | 'dev-ai' | 'cloud';
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
