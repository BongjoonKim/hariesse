import { getConfig, getTelegramBotToken, getNotionToken } from '../../lib/config';
import { listArticlesByStatus, markDelivered } from '../../lib/dynamo';
import { rankAndSplit, type Rankable } from '../../domain/scoring';
import { sendDigest } from '../../lib/telegram';
import { upsertArticle } from '../../lib/notion';
import type { Article } from '../../lib/types';

interface DeliverResult {
  delivered: number;
  exploit: number;
  explore: number;
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

  // 큐레이션 완료(score 있음) + 미전달 후보
  const unread = await listArticlesByStatus(cfg.articlesTable, 'unread', 300);
  const candidates = unread.filter((a) => typeof a.score === 'number' && !a.deliveredAt);

  const byId = new Map<string, Article>(candidates.map((a) => [a.articleId, a]));
  const rankables: Rankable[] = candidates.map((a) => ({
    articleId: a.articleId,
    siteId: a.siteId,
    score: a.score ?? 0,
    isNovel: false, // 다음 증분: candidate 소스/미노출 도메인을 novel로 표시
  }));

  const ranked = rankAndSplit(rankables, cfg.explorationRatio, cfg.digestSize);

  const selected: Article[] = ranked.map((r) => {
    const a = byId.get(r.item.articleId)!;
    return { ...a, slot: r.slot };
  });

  const dateLabel = kstDateLabel();

  // Telegram 다이제스트
  const botToken = await getTelegramBotToken();
  await sendDigest(botToken, cfg.telegramChatId, selected, dateLabel);

  // Notion 아카이브 + 전달 표시
  const notionToken = cfg.notionDatabaseId ? await getNotionToken() : '';
  const deliveredAt = new Date().toISOString();
  for (const article of selected) {
    if (cfg.notionDatabaseId && notionToken) {
      try {
        await upsertArticle(notionToken, cfg.notionDatabaseId, article);
      } catch (err) {
        console.warn(`Notion upsert 실패 ${article.articleId}: ${(err as Error).message}`);
      }
    }
    await markDelivered(cfg.articlesTable, article.articleId, article.slot, deliveredAt);
  }

  const exploit = selected.filter((a) => a.slot === 'exploit').length;
  const explore = selected.filter((a) => a.slot === 'explore').length;
  console.log(`deliver 완료: ${selected.length}건 (활용 ${exploit} / 탐험 ${explore})`);
  return { delivered: selected.length, exploit, explore };
};
