import { getConfig, getTelegramBotToken, getTelegramWebhookSecret, getNotionToken } from '../../lib/config';
import {
  getArticle,
  markArticleFeedbackOnce,
  adjustSourceFeedback,
  bumpProfileInterests,
} from '../../lib/dynamo';
import { decodeCallback, feedbackEffects } from '../../domain/feedback';
import {
  decodeTaskCallback,
  orderTasksBy,
  shiftDate,
  skipToggleStatus,
  tasksForSlot,
  toggleStatus,
} from '../../domain/routine';
import { getTask, listDayTasks, setTaskStatus } from '../../lib/tasks';
import {
  answerCallbackQuery,
  buildTaskKeyboard,
  editMessageText,
  formatBrief,
} from '../../lib/telegram';
import { upsertArticle } from '../../lib/notion';
import type { TaskStatus } from '../../lib/types';

/**
 * Telegram webhook 수신 (Lambda Function URL).
 * - X-Telegram-Bot-Api-Secret-Token 헤더로 인증 (setWebhook의 secret_token과 일치해야 함).
 * - callback_query만 처리. 응답은 항상 200 (아니면 Telegram이 재시도 폭주).
 * - `v1|…` = 다이제스트 피드백, `t1|…` = 브리핑 할일 체크. prefix로 갈린다.
 * - idempotency: 다이제스트는 액션당 1회만 반영 (`${action}FeedbackAt` 마커, 조건부 update).
 *   할일 체크는 상태 대입이라 여러 번 눌러도 같은 결과 (토글은 의도된 되돌리기).
 */

interface FunctionUrlEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number | string };
  reply_markup?: { inline_keyboard: { callback_data?: string }[][] };
}

interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    message?: TelegramMessage;
  };
}

interface HttpResponse {
  statusCode: number;
  body: string;
}

const OK: HttpResponse = { statusCode: 200, body: 'ok' };

const TASK_ACK: Record<TaskStatus, string> = {
  done: '✅ 완료! 잘했어요',
  skipped: '⏭ 오늘은 건너뛸게요',
  todo: '↩️ 되돌렸어요',
};

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

  const taskCb = decodeTaskCallback(cb.data);
  if (taskCb) {
    const cfg = await getConfig();
    if (!cfg.tasksTable) {
      await answer('할일 기능이 아직 설정되지 않았어요');
      return OK;
    }
    const task = await getTask(cfg.tasksTable, taskCb.date, taskCb.sk);
    if (!task) {
      await answer('이미 없는 할일이에요');
      return OK;
    }

    const next: TaskStatus =
      taskCb.action === 'toggle' ? toggleStatus(task.status) : skipToggleStatus(task.status);
    const updated = await setTaskStatus(
      cfg.tasksTable,
      taskCb.date,
      taskCb.sk,
      next,
      new Date().toISOString()
    );
    if (!updated) {
      await answer('이미 없는 할일이에요');
      return OK;
    }

    // 메시지 다시 그리기 — 실패해도 상태 변경 자체는 이미 반영됐다.
    try {
      const msg = cb.message;
      if (msg) {
        const dayTasks = await listDayTasks(cfg.tasksTable, taskCb.date);
        const skOrder = (msg.reply_markup?.inline_keyboard ?? [])
          .map((row) => decodeTaskCallback(row[0]?.callback_data)?.sk)
          .filter((sk): sk is string => Boolean(sk));
        const shown =
          skOrder.length > 0
            ? orderTasksBy(skOrder, dayTasks)
            : tasksForSlot(dayTasks, taskCb.slot);
        const tomorrow =
          taskCb.slot === 'evening'
            ? await listDayTasks(cfg.tasksTable, shiftDate(taskCb.date, 1))
            : [];
        await editMessageText(
          botToken,
          msg.chat.id,
          msg.message_id,
          formatBrief(taskCb.slot, taskCb.date, shown, dayTasks, tomorrow),
          buildTaskKeyboard(taskCb.slot, taskCb.date, shown)
        );
      }
    } catch (err) {
      console.warn(`브리핑 메시지 갱신 실패: ${(err as Error).message}`);
    }

    console.log(`task ${taskCb.action}: ${taskCb.date}/${taskCb.sk} → ${next}`);
    await answer(TASK_ACK[next]);
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
