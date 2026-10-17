import { getConfig, getTelegramBotToken, getTelegramWebhookSecret, getNotionToken } from '../../lib/config';
import {
  getArticle,
  markArticleFeedbackOnce,
  adjustSourceFeedback,
  bumpProfileInterests,
  getLearningProgress,
  putLearningProgress,
} from '../../lib/dynamo';
import { decodeCallback, feedbackEffects } from '../../domain/feedback';
import { decodeLessonCallback, applyLessonFeedback, initialProgress } from '../../domain/learning';
import { decodeVocabCallback, pageIdFromReplyMarkup, applyReview, kstDate } from '../../domain/vocab';
import { answerCallbackQuery, clearInlineKeyboard, sendReply } from '../../lib/telegram';
import { upsertArticle } from '../../lib/notion';
import { getVocabPage, updateVocabPage, archiveVocabPage } from '../../lib/notion-vocab';
import { ENV } from '../../lib/constants';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { VocabEvent } from '../vocab';

/**
 * Telegram webhook 수신 (Lambda Function URL).
 * - X-Telegram-Bot-Api-Secret-Token 헤더로 인증 (setWebhook의 secret_token과 일치해야 함).
 * - callback_query: 다이제스트(v1|) / 학습 레슨(l1|) / TOEFL 단어장(t1|) 버튼.
 * - message: 내 채팅(SSM telegram-chat-id)에서 온 것만 → TOEFL 단어장에 기록. Bedrock이 오래 걸리니
 *   Vocab Lambda를 비동기 호출하고 바로 200 (Telegram은 응답이 늦으면 같은 update를 재전송한다).
 *   단어장 카드에 답장한 메시지면 그 카드의 page id를 같이 넘긴다 (뜻 수정 요청).
 * - 응답은 항상 200 (아니면 Telegram이 재시도 폭주).
 * - idempotency: 액션당 1회만 반영 (`${action}FeedbackAt` 마커, dynamo 조건부 update).
 */

interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface TelegramMessageRef {
  message_id: number;
  chat: { id: number };
}

interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    /** 버튼이 붙어 있던 메시지 */
    message?: TelegramMessageRef;
  };
  message?: TelegramMessageRef & {
    text?: string;
    from?: { is_bot?: boolean };
    /** 답장이면 원본 메시지. 봇의 단어장 카드면 inline 키보드에 page id가 들어 있다. */
    reply_to_message?: TelegramMessageRef & {
      from?: { is_bot?: boolean };
      reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
    };
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

  if (update.message) {
    await handleMessage(update.message);
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

  // TOEFL 단어장 버튼 (t1|...) — Notion 페이지를 직접 갱신
  const vocabCb = decodeVocabCallback(cb.data);
  if (vocabCb) {
    await answer(await handleVocabButton(vocabCb.action, vocabCb.pageId, botToken, cb.message));
    return OK;
  }

  // 학습 레슨 버튼 (l1|...) — 기사 피드백과 저장 위치가 달라 먼저 분기
  const lessonCb = decodeLessonCallback(cb.data);
  if (lessonCb) {
    const cfg = await getConfig();
    const now = new Date().toISOString();
    const progress = (await getLearningProgress(cfg.profileTable)) ?? initialProgress(now);
    const result = applyLessonFeedback(progress, lessonCb.action, lessonCb.lessonId, now);
    if (result.changed) await putLearningProgress(cfg.profileTable, result.progress);
    console.log(`lesson feedback: ${lessonCb.action} ${lessonCb.lessonId} changed=${result.changed}`);
    await answer(result.ack);
    return OK;
  }

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

// ---------------------------------------------------------------- TOEFL 단어장

const VOCAB_HELP = [
  '📒 <b>TOEFL 단어장</b>',
  '영어 단어·표현·문장을 그냥 보내면 뜻(문장은 번역)을 채워서 Notion에 저장해요.',
  '한 줄에 하나씩, 여러 줄이면 여러 개를 한 번에 저장해요.',
  '',
  '<code>ubiquitous</code>',
  '<code>The findings corroborate the hypothesis.</code>',
  '<code>mitigate :: 완화하다 #reading</code>  ← 내가 아는 뜻(::)·태그(#)는 선택',
  '',
  '뜻이 틀렸으면 그 카드에 <b>답장</b>으로, 또는 바로 한국어로 "~라는 뜻이야"라고 보내면 고쳐요 (답장이 없으면 마지막에 저장한 표현).',
  '',
  '매일 21:00에 복습 퀴즈가 와요. 지금 복습하려면 /review',
].join('\n');

let lambdaClient: LambdaClient | undefined;

async function invokeVocab(payload: VocabEvent): Promise<void> {
  const functionName = process.env[ENV.VOCAB_FUNCTION_NAME];
  if (!functionName) throw new Error(`Missing env var: ${ENV.VOCAB_FUNCTION_NAME}`);
  lambdaClient ??= new LambdaClient({});
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event', // 비동기 — webhook은 바로 200
      Payload: Buffer.from(JSON.stringify(payload)),
    })
  );
}

async function handleMessage(msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
  // 단어장을 끈 배포(-c vocab=false, 예: 디자인 stage)는 메시지를 받을 일이 없다
  if (!process.env[ENV.VOCAB_FUNCTION_NAME]) {
    console.warn('message 무시: 단어장 꺼짐');
    return;
  }
  const cfg = await getConfig();
  // 봇은 누구나 말을 걸 수 있다 — 내 채팅이 아니면 조용히 무시
  if (!cfg.telegramChatId || String(msg.chat.id) !== cfg.telegramChatId || msg.from?.is_bot) {
    console.warn(`message 무시: chat ${msg.chat.id}`);
    return;
  }
  const botToken = await getTelegramBotToken();
  const reply = async (text: string) => {
    try {
      await sendReply(botToken, cfg.telegramChatId, text, msg.message_id);
    } catch (err) {
      console.warn(`답장 실패: ${(err as Error).message}`);
    }
  };

  const text = msg.text?.trim();
  if (!text) {
    await reply('텍스트만 저장할 수 있어요.');
    return;
  }

  try {
    if (text.startsWith('/')) {
      const command = text.split(/[\s@]/)[0].toLowerCase();
      if (command === '/review') {
        await invokeVocab({ type: 'review', force: true });
      } else {
        await reply(VOCAB_HELP);
      }
      return;
    }
    const replyToPageId = msg.reply_to_message?.from?.is_bot ? pageIdFromReplyMarkup(msg.reply_to_message.reply_markup) : undefined;
    await invokeVocab({ type: 'capture', text, messageId: msg.message_id, ...(replyToPageId ? { replyToPageId } : {}) });
  } catch (err) {
    console.error(`vocab 호출 실패: ${(err as Error).message}`);
    await reply('⚠️ 단어장 처리를 시작하지 못했어요. 잠시 후 다시 보내 주세요.');
  }
}

/** 단어장 버튼 처리 → 토스트 문구. 처리했으면 버튼을 지워 같은 퀴즈를 또 누르지 않게 한다. */
async function handleVocabButton(
  action: 'know' | 'forgot' | 'delete',
  pageId: string,
  botToken: string,
  message: TelegramMessageRef | undefined
): Promise<string> {
  const clear = async () => {
    if (!message) return;
    try {
      await clearInlineKeyboard(botToken, message.chat.id, message.message_id);
    } catch (err) {
      console.warn(`버튼 제거 실패: ${(err as Error).message}`);
    }
  };

  try {
    const notionToken = await getNotionToken();
    if (action === 'delete') {
      await archiveVocabPage(notionToken, pageId);
      await clear();
      return '🗑 삭제했어요 (Notion 휴지통에서 되살릴 수 있어요)';
    }

    const entry = await getVocabPage(notionToken, pageId);
    if (!entry) {
      await clear();
      return '삭제된 표현이에요';
    }
    const result = applyReview(entry, action, kstDate());
    if (result.changed) await updateVocabPage(notionToken, pageId, result.fields);
    await clear();
    console.log(`vocab review: ${action} ${pageId} changed=${result.changed} box=${result.fields.box}`);
    return result.ack;
  } catch (err) {
    console.error(`vocab 버튼 처리 실패 ${action} ${pageId}: ${(err as Error).message}`);
    return '⚠️ 반영하지 못했어요. 잠시 후 다시 눌러 주세요';
  }
}
