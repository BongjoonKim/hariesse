/**
 * 소스 타입별 수집 어댑터 (blog RSS / YouTube / Reddit).
 *
 * 설계: URL 정규화·피드 항목 파싱은 전부 **순수함수**로 분리했다(네트워크 없음, 단위테스트 대상).
 * 네트워크는 `fetchSourceItems` 하나에만 있다.
 */
import Parser from 'rss-parser';
import { normalizeWhitespace } from './extract';
import type { Source, SourceType } from './types';

const USER_AGENT = 'HariesseBot/0.1 (+personal curation agent)';

/** 수집기가 collect 핸들러에 넘기는 표준 항목. */
export interface CollectedItem {
  /** 저장·dedup에 쓸 정규 URL (다이제스트에서 클릭되는 링크) */
  url: string;
  title: string;
  /** 소스가 직접 주는 본문/설명. extractUrl 추출이 실패하면 이 값이 폴백. */
  text?: string;
  /** 본문을 긁어올 URL. 없으면 추출을 시도하지 않는다(YouTube 등). */
  extractUrl?: string;
  /** 원문과 별개의 토론 링크 (Reddit 댓글 스레드) */
  discussionUrl?: string;
  /** true면 본문 추출에 성공해도 소스 제목을 유지한다 (Reddit 제목이 곧 맥락). */
  preferSourceTitle?: boolean;
}

/** rss-parser 항목 중 우리가 쓰는 필드만 (테스트에서 손으로 만들 수 있게 느슨하게). */
export interface RawFeedItem {
  title?: string;
  link?: string;
  content?: string;
  contentSnippet?: string;
  'media:group'?: unknown;
}

// YouTube 설명이 이보다 짧으면 큐레이션이 무의미하므로 건너뛴다.
const MIN_YOUTUBE_DESC = 40;
// Reddit 자기글(selftext)이 이보다 짧으면 스킵 — 제목뿐인 질문글 방지.
const MIN_REDDIT_SELFTEXT = 200;

// ---------------------------------------------------------------- 공통 유틸

/** HTML 태그 제거 + 기본 엔티티 디코드 → 평문. 순수함수. */
export function stripHtml(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&#0*32;/g, ' ');
  return normalizeWhitespace(text);
}

/** 소스의 실효 타입 (미지정 = blog). */
export function sourceType(source: Pick<Source, 'type'>): SourceType {
  return source.type ?? 'blog';
}

// ---------------------------------------------------------------- YouTube

const YT_FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

/**
 * 채널 ID / 채널 URL / 재생목록 → YouTube RSS 피드 URL. 순수함수.
 * `@handle` 형태는 채널 ID 조회에 네트워크가 필요하므로 여기서 처리하지 않는다
 * (`scripts/add-source.ts`가 미리 해석해서 채널 ID로 저장한다).
 */
export function toYoutubeFeedUrl(input: string): string {
  const raw = input.trim();
  if (raw.startsWith(YT_FEED_BASE)) return raw;

  const channel = raw.match(/(?:channel_id=|channel\/)(UC[\w-]{20,24})/) ?? raw.match(/^(UC[\w-]{20,24})$/);
  if (channel) return `${YT_FEED_BASE}?channel_id=${channel[1]}`;

  const playlist = raw.match(/(?:playlist_id=|list=)(PL[\w-]{10,})/) ?? raw.match(/^(PL[\w-]{10,})$/);
  if (playlist) return `${YT_FEED_BASE}?playlist_id=${playlist[1]}`;

  throw new Error(
    `YouTube 소스 feedUrl을 해석할 수 없음: ${input} (채널 ID(UC...) 또는 feeds/videos.xml URL 필요)`
  );
}

/** media:group 안의 설명 텍스트를 꺼낸다 (rss-parser 출력 형태가 버전마다 달라 방어적으로). */
export function extractYoutubeDescription(item: RawFeedItem): string {
  const group = item['media:group'] as Record<string, unknown> | undefined;
  const raw = group?.['media:description'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string') return normalizeWhitespace(value);
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['_'];
    if (typeof inner === 'string') return normalizeWhitespace(inner);
  }
  return normalizeWhitespace(item.contentSnippet ?? '');
}

/**
 * YouTube 피드 항목 → CollectedItem. 설명이 너무 짧으면 null(스킵). 순수함수.
 * 영상 페이지는 Readability로 본문을 못 뽑으므로 extractUrl을 주지 않는다.
 */
export function toYoutubeItem(item: RawFeedItem, channelName: string): CollectedItem | null {
  const url = item.link?.trim();
  const title = item.title?.trim();
  if (!url || !title) return null;

  const description = extractYoutubeDescription(item);
  if (description.length < MIN_YOUTUBE_DESC) return null;

  return {
    url,
    title,
    preferSourceTitle: true,
    text: [
      `[YouTube 영상] ${title}`,
      `채널: ${channelName}`,
      '',
      description,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------- Reddit

/**
 * 서브레딧 지정(`r/aws`, 서브레딧 URL, 이미 완성된 .rss URL) → Reddit RSS URL. 순수함수.
 *
 * 참고: Reddit의 `.json` 엔드포인트는 UA를 붙여도 403을 주는 경우가 많다(데이터센터 IP 차단).
 * 반면 `.rss`는 열려 있어 RSS 경로만 쓴다.
 */
export function toRedditFeedUrl(input: string, sort = 'top', period = 'day'): string {
  const raw = input.trim();
  if (/\.rss(\?|$)/.test(raw)) return raw;

  const match = raw.match(/(?:^|reddit\.com\/)r\/([A-Za-z0-9_]+)/);
  if (!match) throw new Error(`Reddit 소스 feedUrl을 해석할 수 없음: ${input} (r/<subreddit> 형태 필요)`);
  return `https://www.reddit.com/r/${match[1]}/${sort}/.rss?t=${period}`;
}

/** Reddit RSS content HTML에서 [link]/[comments] 앵커 href를 뽑는다. 순수함수. */
export function parseRedditLinks(contentHtml: string): { link?: string; comments?: string } {
  const out: { link?: string; comments?: string } = {};
  const anchors = contentHtml.matchAll(/<a\s+href="([^"]+)"[^>]*>\s*\[(link|comments)\]\s*<\/a>/gi);
  for (const m of anchors) {
    const href = m[1].replace(/&amp;/g, '&');
    if (m[2].toLowerCase() === 'link') out.link = href;
    else out.comments = href;
  }
  return out;
}

/** 'submitted by /u/x [link] [comments]' 꼬리표를 떼고 본문만 남긴다. 순수함수. */
export function stripRedditChrome(contentHtml: string): string {
  const withoutAnchors = contentHtml.replace(
    /<span>\s*<a\s+href="[^"]*"[^>]*>\s*\[(link|comments)\]\s*<\/a>\s*<\/span>/gi,
    ' '
  );
  return stripHtml(withoutAnchors)
    .replace(/submitted by\s*\/u\/[\w-]+/gi, ' ')
    .replace(/\[(link|comments)\]/gi, ' ')
    .trim();
}

/**
 * Reddit 피드 항목 → CollectedItem. 순수함수.
 * - 링크글: url = 외부 원문(블로그와 dedup이 맞물린다), discussionUrl = 댓글 스레드
 * - 자기글: url = 퍼머링크, 본문 = selftext (너무 짧으면 null)
 */
export function toRedditItem(item: RawFeedItem, subredditLabel: string): CollectedItem | null {
  const title = item.title?.trim();
  if (!title) return null;

  const content = item.content ?? '';
  const { link, comments } = parseRedditLinks(content);
  const permalink = comments ?? item.link?.trim();
  if (!permalink) return null;

  const isExternal = Boolean(link && !/^https?:\/\/(www\.|old\.)?reddit\.com/i.test(link));

  if (isExternal) {
    return {
      url: link!,
      title,
      preferSourceTitle: true,
      extractUrl: link!,
      discussionUrl: permalink,
      text: `[Reddit ${subredditLabel}에서 화제] ${title}\n원문: ${link}`,
    };
  }

  const selfText = stripRedditChrome(content);
  if (selfText.length < MIN_REDDIT_SELFTEXT) return null;

  return {
    url: permalink,
    title,
    preferSourceTitle: true,
    text: [`[Reddit ${subredditLabel} 게시글] ${title}`, '', selfText].join('\n'),
  };
}

// ---------------------------------------------------------------- blog(RSS)

/** 일반 블로그 RSS 항목 → CollectedItem. 본문은 원문 페이지에서 추출한다. 순수함수. */
export function toBlogItem(item: RawFeedItem): CollectedItem | null {
  const url = item.link?.trim();
  if (!url) return null;
  return {
    url,
    title: item.title?.trim() || url,
    extractUrl: url,
    // 추출 실패 시 폴백
    text: (item.contentSnippet || item.content || '').trim(),
  };
}

// ---------------------------------------------------------------- 네트워크

const parser = new Parser({
  timeout: 12000,
  customFields: { item: [['media:group', 'media:group']] },
});

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 호스트별 호출 정책 — 간격과 재시도 백오프. */
export interface FetchPolicy {
  /** 같은 호스트 연속 호출 최소 간격 */
  minIntervalMs: number;
  /** 429/5xx 재시도 대기 (배열 길이 = 재시도 횟수) */
  backoffMs: number[];
}

/**
 * Reddit는 익명 요청을 아주 빡빡하게 조인다. 실측(2026-09-06) 결과 4초 간격으로는
 * 절반이 429였고, 한 번 걸리면 수십 초간 안 풀린다. 하루 1회 실행이라 넉넉히 벌려도 손해가 없다.
 */
const REDDIT_POLICY: FetchPolicy = { minIntervalMs: 20000, backoffMs: [30000] };
const DEFAULT_POLICY: FetchPolicy = { minIntervalMs: 0, backoffMs: [2000, 5000] };

/** URL → 호출 정책. 호스트를 정확히 보고 고른다(부분 문자열 매칭 금지). 순수함수. */
export function policyFor(url: string): FetchPolicy {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return DEFAULT_POLICY;
  }
  return host === 'reddit.com' || host.endsWith('.reddit.com') ? REDDIT_POLICY : DEFAULT_POLICY;
}

const lastFetchAt = new Map<FetchPolicy, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 같은 정책(=같은 호스트군) 호출 사이 간격을 벌린다. */
async function throttle(policy: FetchPolicy): Promise<void> {
  if (policy.minIntervalMs <= 0) return;
  const wait = (lastFetchAt.get(policy) ?? 0) + policy.minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastFetchAt.set(policy, Date.now());
}

/** 본문 읽기까지 타임아웃 안에서 끝낸다 (응답만 받고 body에서 멈추는 걸 방지). */
async function fetchOnce(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** 피드 XML을 받아온다. 429/5xx는 호스트 정책대로 백오프 재시도. */
async function fetchFeedText(url: string, timeoutMs = 12000): Promise<string> {
  const policy = policyFor(url);
  for (let attempt = 0; ; attempt++) {
    await throttle(policy);
    const res = await fetchOnce(url, timeoutMs);
    if (res.ok) return res.text;
    if (RETRYABLE_STATUS.has(res.status) && attempt < policy.backoffMs.length) {
      await sleep(policy.backoffMs[attempt]);
      continue;
    }
    throw new Error(`feed fetch ${url} -> ${res.status}`);
  }
}

/** 소스의 실효 피드 URL (타입별 정규화). 순수함수. */
export function resolveFeedUrl(source: Source): string {
  const feedUrl = source.feedUrl?.trim();
  if (!feedUrl) throw new Error(`feedUrl 없음: ${source.name}`);
  switch (sourceType(source)) {
    case 'youtube':
      return toYoutubeFeedUrl(feedUrl);
    case 'reddit':
      return toRedditFeedUrl(feedUrl);
    default:
      return feedUrl;
  }
}

/**
 * 소스 하나를 읽어 표준 항목 목록으로. **이 모듈에서 유일하게 네트워크를 쓰는 함수.**
 * 피드 접근 실패는 예외로 던지고, 개별 항목 파싱 실패는 조용히 건너뛴다.
 */
export async function fetchSourceItems(source: Source): Promise<CollectedItem[]> {
  const feedUrl = resolveFeedUrl(source);
  const xml = await fetchFeedText(feedUrl);
  const feed = await parser.parseString(xml);
  const items = (feed.items ?? []) as RawFeedItem[];
  const type = sourceType(source);

  const mapped = items.map((item) => {
    switch (type) {
      case 'youtube':
        return toYoutubeItem(item, source.name);
      case 'reddit':
        return toRedditItem(item, source.name);
      default:
        return toBlogItem(item);
    }
  });

  return mapped.filter((i): i is CollectedItem => i !== null);
}
