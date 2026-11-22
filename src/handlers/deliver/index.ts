import { getConfig, getTelegramBotToken, getNotionToken } from '../../lib/config';
import { listArticlesByStatus, listDeliveredUnread, markDelivered, extendArticleTtl } from '../../lib/dynamo';
import { decideDigestSize, rankAndSplit, type Rankable } from '../../domain/scoring';
import { isRead, pickResends, newSlotCount, ttlFrom, ttlExpiresSoon } from '../../domain/digest';
import { sendDigest } from '../../lib/telegram';
import { upsertArticle } from '../../lib/notion';
import { DEFAULTS } from '../../lib/constants';
import type { Article } from '../../lib/types';

interface DeliverResult {
  delivered: number;
  exploit: number;
  explore: number;
  /** 읽음 표시가 없어 다시 보낸 글 수 (delivered에 포함되지 않음) */
  resent: number;
}

function kstDateLabel(): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export const handler = async (): Promise<DeliverResult> => {
  const cfg = await getConfig();
  const nowMs = Date.now();

  // 큐레이션 완료(score 있음) + 미전달 후보 — 최근 수집한 글부터 본다
  const unread = await listArticlesByStatus(cfg.articlesTable, 'unread', 300, true);
  const candidates = unread.filter((a) => typeof a.score === 'number' && !a.deliveredAt);

  // 전달했지만 읽음 표시가 없는 글 → 며칠 지나면 다시 보낸다 (읽을 때까지)
  const pending = (await listDeliveredUnread(cfg.articlesTable)).filter((a) => !isRead(a));
  const resends = pickResends(pending, nowMs, DEFAULTS.RESEND_AFTER_DAYS, DEFAULTS.RESEND_PER_DIGEST);

  const byId = new Map<string, Article>(candidates.map((a) => [a.articleId, a]));
  const rankables: Rankable[] = candidates.map((a) => ({
    articleId: a.articleId,
    siteId: a.siteId,
    score: a.score ?? 0,
    isNovel: false, // 다음 증분: candidate 소스/미노출 도메인을 novel로 표시
  }));

  const size = decideDigestSize(
    rankables.map((r) => r.score),
    cfg.digestMinSize,
    cfg.digestSize,
    cfg.digestMinScore
  );
  const ranked = rankAndSplit(rankables, cfg.explorationRatio, newSlotCount(size, resends.length));

  const selected: Article[] = ranked.map((r) => {
    const a = byId.get(r.item.articleId)!;
    return { ...a, slot: r.slot };
  });

  const dateLabel = kstDateLabel();

  // Telegram 다이제스트
  const botToken = await getTelegramBotToken();
  await sendDigest(botToken, cfg.telegramChatId, selected, dateLabel, resends);

  // Notion 아카이브 + 전달 표시. TTL은 전송 시점 기준으로 다시 잡는다.
  const notionToken = cfg.notionDatabaseId ? await getNotionToken() : '';
  const deliveredAt = new Date(nowMs).toISOString();
  const ttl = ttlFrom(nowMs, DEFAULTS.DELIVERED_TTL_DAYS);
  for (const article of selected) {
    if (cfg.notionDatabaseId && notionToken) {
      try {
        await upsertArticle(notionToken, cfg.notionDatabaseId, article);
      } catch (err) {
        console.warn(`Notion upsert 실패 ${article.articleId}: ${(err as Error).message}`);
      }
    }
    await markDelivered(cfg.articlesTable, article.articleId, article.slot, deliveredAt, ttl);
  }
  // 재전송은 Notion에 이미 있다 — 전송 기록만 갱신
  for (const article of resends) {
    await markDelivered(cfg.articlesTable, article.articleId, article.slot, deliveredAt, ttl);
  }

  // 차례를 기다리는 안 읽은 글이 그 전에 TTL로 지워지지 않게 연장
  const resentIds = new Set(resends.map((a) => a.articleId));
  let extended = 0;
  for (const article of pending) {
    if (resentIds.has(article.articleId) || !ttlExpiresSoon(article, nowMs, 7)) continue;
    try {
      await extendArticleTtl(cfg.articlesTable, article.articleId, ttl);
      extended++;
    } catch (err) {
      console.warn(`TTL 연장 실패 ${article.articleId}: ${(err as Error).message}`);
    }
  }

  const exploit = selected.filter((a) => a.slot === 'exploit').length;
  const explore = selected.filter((a) => a.slot === 'explore').length;
  const ids = [...selected, ...resends].map((a) => a.articleId).join(',');
  console.log(
    `deliver 완료: ${selected.length}건 (활용 ${exploit} / 탐험 ${explore}), 재전송 ${resends.length}건, ` +
      `안 읽음 대기 ${pending.length}건 (TTL 연장 ${extended}) [${ids}]`
  );
  return { delivered: selected.length, exploit, explore, resent: resends.length };
};
