import { getConfig } from '../../lib/config';
import { listArticlesByStatus, saveCuration, getProfile } from '../../lib/dynamo';
import { getRawText } from '../../lib/storage';
import { curateArticle } from '../../lib/bedrock';

interface CurateResult {
  curated: number;
  skipped: number;
}

export const handler = async (): Promise<CurateResult> => {
  const cfg = await getConfig();
  const profile = await getProfile(cfg.profileTable);
  const interests = profile?.interests ?? {};

  // 아직 큐레이션되지 않은(unread + score 없음) 글
  const unread = await listArticlesByStatus(cfg.articlesTable, 'unread', 200);
  const pending = unread.filter((a) => typeof a.score !== 'number');

  let curated = 0;
  let skipped = 0;

  for (const article of pending) {
    if (curated >= cfg.dailyBedrockCap) break; // Bedrock 호출 상한 (가드레일)

    let bodyText = '';
    try {
      bodyText = article.textS3Key ? await getRawText(cfg.rawBucket, article.articleId) : '';
    } catch (err) {
      console.warn(`본문 로드 실패 ${article.articleId}: ${(err as Error).message}`);
    }
    if (!bodyText) {
      skipped++;
      continue;
    }

    try {
      const result = await curateArticle(cfg.bedrockModelId, cfg.bedrockRegion, {
        title: article.title,
        url: article.url,
        category: article.category,
        sourceType: article.source,
        bodyText,
        interests,
      });
      await saveCuration(cfg.articlesTable, article.articleId, {
        score: result.score,
        summary: result.summary,
        aiOpinion: result.aiOpinion,
        tags: result.tags,
        curatedAt: new Date().toISOString(),
      });
      curated++;
    } catch (err) {
      console.warn(`큐레이션 실패 ${article.articleId}: ${(err as Error).message}`);
      skipped++;
    }
  }

  console.log(`curate 완료: ${curated}건 큐레이션, ${skipped}건 스킵`);
  return { curated, skipped };
};
