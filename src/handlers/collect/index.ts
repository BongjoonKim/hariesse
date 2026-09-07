import { getConfig } from '../../lib/config';
import {
  getActiveSources,
  getArticle,
  putArticleIfNew,
  markSourceCrawled,
  hashUrl,
} from '../../lib/dynamo';
import { fetchSourceItems, sourceType } from '../../lib/collectors';
import { fetchAndExtract } from '../../lib/extract';
import { putRawText } from '../../lib/storage';
import { DEFAULTS } from '../../lib/constants';
import type { Article, Source } from '../../lib/types';

// 사이트당 최대 신규 글 수 (가중치로 스케일).
const MAX_PER_SOURCE = 5;

interface CollectResult {
  collected: number;
  scanned: number;
  sources: number;
  failedSources: number;
}

function itemsPerSource(source: Source): number {
  // weight 1.0 기준 2건, 가중치에 비례. 1~MAX 범위.
  return Math.max(1, Math.min(MAX_PER_SOURCE, Math.round(source.weight * 2)));
}

export const handler = async (): Promise<CollectResult> => {
  const cfg = await getConfig();
  const sources = await getActiveSources(cfg.sourcesTable);
  // weight 내림차순
  sources.sort((a, b) => b.weight - a.weight);

  const nowIso = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + DEFAULTS.ARTICLE_TTL_DAYS * 86400;

  let collected = 0;
  let scanned = 0;
  let failedSources = 0;
  const dailyCap = cfg.dailyCurateCap; // 하루 신규 글 캡 (가드레일)

  for (const source of sources) {
    if (collected >= dailyCap) break;
    if (!source.feedUrl) continue;

    // 타입별 어댑터(blog RSS / YouTube / Reddit)가 표준 항목으로 정규화해 돌려준다.
    let items;
    try {
      items = await fetchSourceItems(source);
    } catch (err) {
      console.warn(
        `소스 수집 실패 [${sourceType(source)}] ${source.name}: ${(err as Error).message}`
      );
      failedSources++;
      continue;
    }

    const limit = itemsPerSource(source);
    let takenFromSource = 0;

    for (const item of items) {
      if (collected >= dailyCap || takenFromSource >= limit) break;
      const url = item.url;
      scanned++;

      const articleId = hashUrl(url);
      // dedup: 이미 있으면 건너뜀
      const existing = await getArticle(cfg.articlesTable, articleId);
      if (existing) continue;

      // 본문 추출 (extractUrl이 있는 소스만. 실패 시 소스가 준 텍스트로 폴백)
      let title = item.title;
      let text = item.text ?? '';
      if (item.extractUrl) {
        try {
          const extracted = await fetchAndExtract(item.extractUrl);
          if (extracted.text) {
            text = extracted.text;
            if (!item.preferSourceTitle && extracted.title) title = extracted.title;
          }
        } catch (err) {
          console.warn(`본문 추출 실패 ${item.extractUrl}: ${(err as Error).message}`);
        }
      }
      if (!text) continue;

      const textS3Key = await putRawText(cfg.rawBucket, articleId, text);

      const article: Article = {
        articleId,
        url,
        title,
        siteId: source.siteId,
        category: source.category,
        source: sourceType(source),
        status: 'unread',
        textS3Key,
        collectedAt: nowIso,
        ttl,
        ...(item.discussionUrl ? { discussionUrl: item.discussionUrl } : {}),
      };

      const isNew = await putArticleIfNew(cfg.articlesTable, article);
      if (isNew) {
        collected++;
        takenFromSource++;
      }
    }

    await markSourceCrawled(cfg.sourcesTable, source.siteId, nowIso);
  }

  console.log(
    `collect 완료: ${collected}건 신규 (${scanned} 스캔, ${sources.length} 소스, 실패 ${failedSources})`
  );
  return { collected, scanned, sources: sources.length, failedSources };
};
