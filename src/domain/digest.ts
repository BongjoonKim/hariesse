import type { Article } from '../lib/types';

/**
 * 다이제스트 재전송 로직 (순수함수, 테스트 대상).
 * 전달했지만 읽음 표시가 없는 글은 읽을 때까지 다시 보낸다 (사용자 결정 2026-11-20).
 */

const DAY_MS = 86_400_000;

/**
 * 읽음 여부. 버튼을 하나라도 누르면 읽은 것이다.
 * readAt 도입 전에 누른 버튼(`*FeedbackAt`만 있음)과 status가 바뀐 글도 읽음으로 친다.
 */
export function isRead(a: Article): boolean {
  return Boolean(
    a.readAt ||
      a.likeFeedbackAt ||
      a.siteFeedbackAt ||
      a.saveFeedbackAt ||
      a.skipFeedbackAt ||
      a.readFeedbackAt ||
      a.status !== 'unread'
  );
}

/** 마지막으로 보낸 시각 (ms). 전달된 적 없으면 undefined. */
export function lastSentMs(a: Article): number | undefined {
  const at = a.lastSentAt ?? a.deliveredAt;
  if (!at) return undefined;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * 이번 다이제스트에 다시 넣을 글. 전달됐고 안 읽었고 마지막 전송 후 afterDays일이 지난 글 중
 * 가장 오래 기다린 것부터 count건. 횟수 제한은 없다 — 읽음 표시를 할 때까지 돌아온다.
 */
export function pickResends(
  articles: Article[],
  nowMs: number,
  afterDays: number,
  count: number
): Article[] {
  const cutoff = nowMs - afterDays * DAY_MS;
  return articles
    .map((a) => ({ a, sent: lastSentMs(a) }))
    .filter((x): x is { a: Article; sent: number } => x.sent !== undefined && !isRead(x.a) && x.sent <= cutoff)
    .sort((x, y) => x.sent - y.sent || x.a.articleId.localeCompare(y.a.articleId))
    .slice(0, Math.max(0, Math.floor(count)))
    .map((x) => x.a);
}

/**
 * 재전송이 끼면 새 글 자리를 그만큼 줄인다. 단 새 글은 최소 1건 남긴다
 * (안 읽은 글이 쌓여도 다이제스트가 재전송만으로 채워지지 않게).
 */
export function newSlotCount(size: number, resendCount: number): number {
  if (resendCount <= 0) return size;
  return Math.max(Math.min(size, 1), size - resendCount);
}

/** 전송 시점 기준으로 다시 잡는 TTL (epoch 초). */
export function ttlFrom(nowMs: number, days: number): number {
  return Math.floor(nowMs / 1000) + days * 86_400;
}

/** 안 읽은 전달 글의 TTL이 곧(withinDays 안에) 끝나면 true — 재전송 차례가 오기 전에 지워지지 않게 연장한다. */
export function ttlExpiresSoon(a: Article, nowMs: number, withinDays: number): boolean {
  return typeof a.ttl === 'number' && a.ttl < ttlFrom(nowMs, withinDays);
}
