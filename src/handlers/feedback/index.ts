import { getConfig, getTelegramBotToken, getTelegramWebhookSecret, getNotionToken } from '../../lib/config';
import {
  getArticle,
  markArticleFeedbackOnce,
  adjustSourceFeedback,
  bumpProfileInterests,
} from '../../lib/dynamo';
import { decodeCallback, feedbackEffects } from '../../domain/feedback';
import { answerCallbackQuery } from '../../lib/telegram';
import { upsertArticle } from '../../lib/notion';

/**
 * Telegram webhook 수신 (Lambda Function URL).
 * - X-Telegram-Bot-Api-Secret-Token 헤더로 인증 (setWebhook의 secret_token과 일치해야 함).
 * - callback_query만 처리. 응답은 항상 200 (아니면 Telegram이 재시도 폭주).
 * - idempotency: 액션당 1회만 반영 (`${action}FeedbackAt` 마커, dynamo 조건부 update).
 */

interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
  };
}

interface HttpResponse {
  statusCode: number;
  body: string;
}

const OK: HttpResponse = { statusCode: 200, body: 'ok' };

export const handler = async (event: FunctionUrlEvent): Promise<HttpResponse> => {
  const secret = await getTelegramWebhookSecret();
  const given = event.headers?.['x-telegram-bot-api-secret-token'];
  if (!secret || given !== secret) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body ?? '';
  let update: TelegramUpdate;
  try {
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return OK;
  }

  const cb = update.callback_query;
  if (!cb) return OK;

  const botToken = await getTelegramBotToken();
  const answer = async (text: string) => {
    try {
      await answerCallbackQuery(botToken, cb.id, text);
    } catch (err) {
      console.warn(`answerCallbackQuery 실패: ${(err as Error).message}`);
    }
  };

  const decoded = decodeCallback(cb.data);
  if (!decoded) {
    await answer('알 수 없는 요청이에요');
    return OK;
  }

  const cfg = await getConfig();
  const article = await getArticle(cfg.articlesTable, decoded.articleId);
  if (!article) {
    await answer('이미 만료된 글이에요');
    return OK;
  }

  const fx = feedbackEffects(decoded.action);
  const now = new Date().toISOString();
  const firstTime = await markArticleFeedbackOnce(
    cfg.articlesTable,
    decoded.articleId,
    decoded.action,
    { status: fx.articleStatus, liked: fx.setLiked, nadelivCandidate: fx.setNadelivCandidate },
    now
  );
  if (!firstTime) {
    await answer('이미 반영했어요');
    return OK;
  }

  // 부수효과는 각각 격리 — 하나 실패해도 나머지와 응답은 진행
  if (fx.weightDelta !== 0 || fx.likeCountDelta !== 0 || fx.skipCountDelta !== 0) {
    try {
      await adjustSourceFeedback(cfg.sourcesTable, article.siteId, fx);
    } catch (err) {
      console.warn(`소스 가중치 반영 실패 ${article.siteId}: ${(err as Error).message}`);
    }
  }

  if (fx.bumpProfileInterests && article.tags?.length) {
    try {
      await bumpProfileInterests(cfg.profileTable, article.tags, now);
    } catch (err) {
      console.warn(`프로필 관심사 반영 실패: ${(err as Error).message}`);
    }
  }

  if (cfg.notionDatabaseId && (fx.articleStatus || fx.setNadelivCandidate !== undefined)) {
    try {
      const notionToken = await getNotionToken();
      await upsertArticle(notionToken, cfg.notionDatabaseId, {
        ...article,
        status: fx.articleStatus ?? article.status,
        liked: fx.setLiked ?? article.liked,
        nadelivCandidate: fx.setNadelivCandidate ?? article.nadelivCandidate,
      });
    } catch (err) {
      console.warn(`Notion 상태 갱신 실패 ${article.articleId}: ${(err as Error).message}`);
    }
  }

  console.log(`feedback 반영: ${decoded.action} ${decoded.articleId}`);
  await answer(fx.ack);
  return OK;
};
