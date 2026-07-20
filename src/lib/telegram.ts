import { encodeCallback } from '../domain/feedback';
import type { Article, Category } from './types';

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
