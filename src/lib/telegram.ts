import { encodeCallback } from '../domain/feedback';
import { AREA_LABEL } from '../domain/curriculum';
import { encodeLessonCallback, type LessonPlan } from '../domain/learning';
import type { Article, Category, LessonContent, SourceType } from './types';

const CATEGORY_LABEL: Record<Category, string> = {
  travel: '여행',
  'dev-ai': '개발·AI',
  cloud: '클라우드',
};

/** 어디서 온 글인지 한눈에 — YouTube/Reddit이 섞이면서 필요해졌다. */
const SOURCE_ICON: Record<SourceType, string> = {
  blog: '📝',
  youtube: '📺',
  reddit: '👽',
  hackernews: '🟠',
  arxiv: '📄',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
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
  const icon = SOURCE_ICON[article.source] ?? SOURCE_ICON.blog;
  const lines = [
    `<b>[${escapeHtml(cat)}] ${icon}${slot} ${escapeHtml(article.title)}</b>`,
  ];
  if (article.summary) lines.push(escapeHtml(article.summary));
  if (article.aiOpinion) lines.push(`💡 추천이유: ${escapeHtml(article.aiOpinion)}`);
  if (typeof article.score === 'number') lines.push(`⭐ 점수: ${article.score}`);
  lines.push(`🔗 ${escapeHtml(article.url)}`);
  if (article.discussionUrl) lines.push(`💬 토론: ${escapeHtml(article.discussionUrl)}`);
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
  replyMarkup?: InlineKeyboard,
  disablePreview = false
): Promise<void> {
  await callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disablePreview,
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

// ---------------------------------------------------------------- 학습 레슨

/** Telegram 메시지 한도는 4096자. 태그를 빼고 세지만 여유 있게 HTML 길이로 자른다. */
const TELEGRAM_MAX = 3800;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** 레슨 버튼. callback_data는 Feedback Lambda가 decodeLessonCallback으로 해석. */
export function buildLessonKeyboard(lessonId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ 이해했어요', callback_data: encodeLessonCallback('done', lessonId) },
        { text: '🔁 쉽게 다시', callback_data: encodeLessonCallback('again', lessonId) },
      ],
    ],
  };
}

const MODE_BADGE: Record<LessonPlan['mode'], string> = {
  normal: '',
  easier: ' · 🔁 쉽게 다시',
  deep: ' · 🧠 심화',
};

/**
 * 레슨 → Telegram HTML 메시지들. 섹션 단위로 끊어서 태그가 잘리지 않게 하고,
 * 한도를 넘으면 여러 메시지로 나눈다 (버튼은 마지막 메시지에 붙인다). 순수함수.
 */
export function formatLesson(
  plan: LessonPlan,
  content: LessonContent,
  related: Pick<Article, 'title' | 'url'>[],
  progress: { completed: number; total: number }
): string[] {
  const { track, lesson } = plan;
  const round = plan.mode === 'deep' ? ` ${plan.round + 1}회차` : '';
  const sections: string[] = [];

  sections.push(
    [
      `📚 <b>오늘의 학습</b> · ${track.emoji} ${escapeHtml(track.name)} (${AREA_LABEL[track.area]})`,
      `<b>${plan.index + 1}/${track.lessons.length} · ${escapeHtml(lesson.title)}</b>${MODE_BADGE[plan.mode]}${round}`,
      content.summary ? `<i>${escapeHtml(clip(content.summary, 200))}</i>` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
  sections.push(`<b>📖 개념</b>\n${escapeHtml(clip(content.concept, 1200))}`);
  if (content.whyItMatters) {
    sections.push(`<b>🎯 왜 중요한가</b>\n${escapeHtml(clip(content.whyItMatters, 600))}`);
  }
  sections.push(
    `<b>📌 핵심</b>\n${content.keyPoints.map((k) => `• ${escapeHtml(clip(k, 250))}`).join('\n')}`
  );
  if (content.example) {
    const lang = content.example.lang.replace(/[^\w+-]/g, '') || 'text';
    const lines = [
      `<b>💻 예제</b>`,
      `<pre><code class="language-${lang}">${escapeHtml(clip(content.example.code, 1500))}</code></pre>`,
    ];
    if (content.example.note) lines.push(escapeHtml(clip(content.example.note, 300)));
    sections.push(lines.join('\n'));
  }
  if (content.aiTip) sections.push(`<b>🤖 AI에게 시킬 때</b>\n${escapeHtml(clip(content.aiTip, 700))}`);
  if (content.practice) sections.push(`<b>🛠 10분 실습</b>\n${escapeHtml(clip(content.practice, 500))}`);
  if (content.quiz) {
    sections.push(
      `<b>❓ 퀴즈</b>\n${escapeHtml(clip(content.quiz.question, 300))}\n` +
        `정답 보기 → <tg-spoiler>${escapeHtml(clip(content.quiz.answer, 500))}</tg-spoiler>`
    );
  }
  sections.push(`<b>🔗 공식 문서</b>\n${lesson.refs.map((u) => escapeHtml(u)).join('\n')}`);
  if (related.length > 0) {
    sections.push(
      `<b>📎 hariesse가 모아둔 관련 글</b>\n` +
        related
          .map((a) => `• <a href="${escapeAttr(a.url)}">${escapeHtml(clip(a.title, 120))}</a>`)
          .join('\n')
    );
  }
  sections.push(`<i>진도: 완료 ${progress.completed} / 전체 ${progress.total}레슨</i>`);

  return packSections(sections, TELEGRAM_MAX);
}

/** 섹션들을 한도 안에서 최대한 적은 메시지로 묶는다. 순수함수. */
export function packSections(sections: string[], max: number): string[] {
  const messages: string[] = [];
  let current = '';
  for (const section of sections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length <= max || !current) {
      current = candidate;
    } else {
      messages.push(current);
      current = section;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** 레슨 메시지 전송 — 링크 미리보기는 끈다 (공식 문서 카드가 본문을 가린다). */
export async function sendLesson(
  token: string,
  chatId: string,
  messages: string[],
  lessonId: string
): Promise<void> {
  for (let i = 0; i < messages.length; i++) {
    const isLast = i === messages.length - 1;
    await sendMessage(token, chatId, messages[i], isLast ? buildLessonKeyboard(lessonId) : undefined, true);
  }
}
