import { encodeCallback } from '../domain/feedback';
import {
  dateLabel as formatDateLabel,
  encodeTaskCallback,
  shiftDate,
  summarizeDay,
  type DaySummary,
} from '../domain/routine';
import type { Article, BriefSlot, Category, TaskInstance } from './types';

const CATEGORY_LABEL: Record<Category, string> = {
  travel: '여행',
  'dev-ai': '개발·AI',
  cloud: '클라우드',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** 항목별 피드백 버튼. callback_data는 Feedback Lambda가 decodeCallback으로 해석. */
export function buildItemKeyboard(articleId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '👍 좋아요', callback_data: encodeCallback('like', articleId) },
        { text: '⭐ 사이트 좋아요', callback_data: encodeCallback('site', articleId) },
      ],
      [
        { text: '💾 nadeliv 글감', callback_data: encodeCallback('save', articleId) },
        { text: '⏭ 건너뛰기', callback_data: encodeCallback('skip', articleId) },
      ],
    ],
  };
}

/**
 * 다이제스트 항목 1건 → Telegram HTML 메시지 (스펙 섹션 7 포맷).
 */
export function formatItem(article: Article): string {
  const cat = CATEGORY_LABEL[article.category] ?? article.category;
  const slot = article.slot === 'explore' ? ' 🧭' : '';
  const lines = [
    `<b>[${escapeHtml(cat)}]${slot} ${escapeHtml(article.title)}</b>`,
  ];
  if (article.summary) lines.push(escapeHtml(article.summary));
  if (article.aiOpinion) lines.push(`💡 추천이유: ${escapeHtml(article.aiOpinion)}`);
  if (typeof article.score === 'number') lines.push(`⭐ 점수: ${article.score}`);
  lines.push(`🔗 ${escapeHtml(article.url)}`);
  return lines.join('\n');
}

async function callTelegram(token: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // 같은 내용으로 다시 그리면 Telegram이 400을 준다 — 실패가 아니라 no-op.
    if (res.status === 400 && text.includes('message is not modified')) return;
    throw new Error(`Telegram ${method} 실패 ${res.status}: ${text}`);
  }
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  await callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** 버튼 클릭에 대한 토스트 응답. 없으면 클라이언트가 로딩 상태로 남는다. */
export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  text: string
): Promise<void> {
  await callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

/** 헤더 1건 + 항목별 메시지 전송. */
export async function sendDigest(
  token: string,
  chatId: string,
  articles: Article[],
  dateLabel: string
): Promise<void> {
  if (articles.length === 0) {
    await sendMessage(token, chatId, `📭 ${escapeHtml(dateLabel)} 다이제스트: 새 글이 없습니다.`);
    return;
  }
  await sendMessage(
    token,
    chatId,
    `🗞 <b>hariesse 다이제스트</b> — ${escapeHtml(dateLabel)} (${articles.length}건)`
  );
  for (const a of articles) {
    await sendMessage(token, chatId, formatItem(a), buildItemKeyboard(a.articleId));
  }
}


// ---- 하루 3회 브리핑 (할일/일정) ----

const SLOT_TITLE: Record<BriefSlot, string> = {
  morning: '🌅 좋은 아침이에요',
  midday: '🕛 점심 체크인',
  evening: '🌙 하루 마무리',
};

const STATUS_ICON: Record<TaskInstance['status'], string> = {
  todo: '⬜',
  done: '✅',
  skipped: '⏭',
};

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function taskLine(task: TaskInstance, index: number): string {
  const bits = [`${index + 1}. ${STATUS_ICON[task.status]}`];
  if (task.timeOfDay) bits.push(task.timeOfDay);
  bits.push(escapeHtml(task.title));
  if (task.estimatedMinutes) bits.push(`(${task.estimatedMinutes}분)`);
  const line = bits.join(' ');
  return task.note ? `${line}\n     <i>${escapeHtml(task.note)}</i>` : line;
}

/**
 * 브리핑 본문 — (slot, date, 보여줄 할일, 하루 전체, 내일)만으로 결정되는 순수함수.
 * 버튼을 눌러 다시 그릴 때도 같은 입력이면 같은 결과가 나와야 한다.
 */
export function formatBrief(
  slot: BriefSlot,
  date: string,
  shown: TaskInstance[],
  dayTasks: TaskInstance[],
  tomorrow: TaskInstance[] = []
): string {
  const summary: DaySummary = summarizeDay(dayTasks);
  const lines = [`<b>${SLOT_TITLE[slot]}</b> — ${escapeHtml(formatDateLabel(date))}`];

  if (shown.length > 0) {
    lines.push('');
    lines.push(...shown.map(taskLine));
  } else if (dayTasks.length === 0) {
    lines.push('');
    lines.push('오늘 등록된 할일이 없어요. 웹에서 루틴을 등록하면 여기에 뜹니다.');
  } else {
    lines.push('');
    lines.push(slot === 'midday' ? '남은 할일이 없네요 👏' : '오늘 할일 전부 끝냈어요 🎉');
  }

  if (dayTasks.length > 0) {
    const counted = summary.total - summary.skipped;
    lines.push('');
    if (slot === 'morning') {
      lines.push(`오늘 ${summary.total}개 — 하나씩 해봐요.`);
    } else {
      const pct = Math.round(summary.rate * 100);
      lines.push(`진행 ${summary.done}/${counted} (${pct}%)`);
    }
  }

  if (slot === 'evening') {
    const next = shiftDate(date, 1);
    lines.push('');
    if (tomorrow.length > 0) {
      const titles = tomorrow.slice(0, 5).map((t) => clip(t.title, 20));
      const more = tomorrow.length > 5 ? ` 외 ${tomorrow.length - 5}건` : '';
      lines.push(`📌 내일 ${escapeHtml(formatDateLabel(next))}: ${escapeHtml(titles.join(', '))}${more}`);
    } else {
      lines.push(`📌 내일 ${escapeHtml(formatDateLabel(next))}: 등록된 할일 없음`);
    }
  }

  return lines.join('\n');
}

/** 할일 1건당 [체크/되돌리기][스킵/되돌리기] 한 줄. */
export function buildTaskKeyboard(
  slot: BriefSlot,
  date: string,
  shown: TaskInstance[]
): InlineKeyboard | undefined {
  if (shown.length === 0) return undefined;
  return {
    inline_keyboard: shown.map((task, i) => [
      {
        text:
          task.status === 'done'
            ? `↩️ ${i + 1}. ${clip(task.title, 18)}`
            : `✅ ${i + 1}. ${clip(task.title, 18)}`,
        callback_data: encodeTaskCallback('toggle', date, slot, task.sk),
      },
      {
        text: task.status === 'skipped' ? '↩️' : '⏭',
        callback_data: encodeTaskCallback('skip', date, slot, task.sk),
      },
    ]),
  };
}

export async function editMessageText(
  token: string,
  chatId: string | number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  await callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}
