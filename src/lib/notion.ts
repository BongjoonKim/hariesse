import { AREA_LABEL } from '../domain/curriculum';
import type { LessonPlan } from '../domain/learning';
import type { Article, Category, SourceType, ArticleStatus, LessonContent } from './types';

const NOTION_VERSION = '2022-06-28';
const BASE = 'https://api.notion.com/v1';

const CATEGORY_LABEL: Record<Category, string> = {
  travel: '여행',
  'dev-ai': '개발·AI',
  cloud: '클라우드',
};
const SOURCE_LABEL: Record<SourceType, string> = {
  blog: '블로그',
  youtube: 'YouTube',
  hackernews: 'HackerNews',
  arxiv: 'arXiv',
  reddit: 'Reddit',
};
const STATUS_LABEL: Record<ArticleStatus, string> = {
  unread: '안읽음',
  reading: '읽는중',
  read: '읽음',
  starred: '별표',
  skipped: '스킵',
};

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

function richText(s: string | undefined) {
  return { rich_text: [{ text: { content: (s ?? '').slice(0, 1900) } }] };
}

function buildProperties(article: Article) {
  return {
    제목: { title: [{ text: { content: article.title.slice(0, 200) } }] },
    URL: { url: article.url },
    카테고리: { select: { name: CATEGORY_LABEL[article.category] ?? '기타' } },
    소스: { select: { name: SOURCE_LABEL[article.source] ?? '블로그' } },
    추천점수: { number: article.score ?? 0 },
    상태: { select: { name: STATUS_LABEL[article.status] ?? '안읽음' } },
    요약: richText(article.summary),
    추천이유: richText(article.aiOpinion),
    태그: { multi_select: (article.tags ?? []).slice(0, 8).map((name) => ({ name })) },
    'nadeliv 글감': { checkbox: Boolean(article.nadelivCandidate) },
  };
}

async function findByUrl(
  token: string,
  databaseId: string,
  url: string
): Promise<string | undefined> {
  const res = await fetch(`${BASE}/databases/${databaseId}/query`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ filter: { property: 'URL', url: { equals: url } }, page_size: 1 }),
  });
  if (!res.ok) throw new Error(`Notion query 실패 ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { results?: { id: string }[] };
  return data.results?.[0]?.id;
}

/** URL 기준 upsert — 있으면 속성 갱신, 없으면 생성. idempotent. */
export async function upsertArticle(
  token: string,
  databaseId: string,
  article: Article
): Promise<void> {
  const props = buildProperties(article);
  const existingId = await findByUrl(token, databaseId, article.url);

  if (existingId) {
    const res = await fetch(`${BASE}/pages/${existingId}`, {
      method: 'PATCH',
      headers: headers(token),
      body: JSON.stringify({ properties: props }),
    });
    if (!res.ok) throw new Error(`Notion update 실패 ${res.status}: ${await res.text()}`);
  } else {
    const res = await fetch(`${BASE}/pages`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ parent: { database_id: databaseId }, properties: props }),
    });
    if (!res.ok) throw new Error(`Notion create 실패 ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------- 학습 레슨

/** Notion 코드 블록은 정해진 언어 이름만 받는다. 모르는 건 plain text. */
const NOTION_CODE_LANG: Record<string, string> = {
  yaml: 'yaml',
  yml: 'yaml',
  bash: 'bash',
  sh: 'shell',
  shell: 'shell',
  groovy: 'groovy',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  python: 'python',
  json: 'json',
  dockerfile: 'docker',
  docker: 'docker',
};

/**
 * 레슨 페이지의 URL 속성 = 대표 문서 링크 + 레슨·날짜 fragment.
 * 기존 URL upsert 규칙을 그대로 쓰면서 레슨 회차마다 페이지가 따로 생긴다.
 */
export function lessonPageUrl(plan: LessonPlan, sentDate: string): string {
  return `${plan.lesson.refs[0]}#hariesse-${plan.lesson.id}-${sentDate}`;
}

function textChunks(s: string): { text: { content: string } }[] {
  const chunks: { text: { content: string } }[] = [];
  for (let i = 0; i < s.length; i += 1900) chunks.push({ text: { content: s.slice(i, i + 1900) } });
  return chunks.length ? chunks : [{ text: { content: '' } }];
}

const heading = (t: string) => ({ object: 'block', type: 'heading_2', heading_2: { rich_text: textChunks(t) } });
const paragraph = (t: string) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: textChunks(t) } });
const bullet = (t: string) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: textChunks(t) },
});
const link = (url: string) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [{ text: { content: url, link: { url } } }] },
});

/** 레슨 → Notion 페이지 본문 블록 (학습 노트). 순수함수. */
export function buildLessonBlocks(plan: LessonPlan, content: LessonContent): unknown[] {
  const blocks: unknown[] = [heading('📖 개념'), paragraph(content.concept)];
  if (content.whyItMatters) blocks.push(heading('🎯 왜 중요한가'), paragraph(content.whyItMatters));
  blocks.push(heading('📌 핵심'), ...content.keyPoints.map(bullet));
  if (content.example) {
    blocks.push(heading('💻 예제'), {
      object: 'block',
      type: 'code',
      code: {
        rich_text: textChunks(content.example.code),
        language: NOTION_CODE_LANG[content.example.lang.toLowerCase()] ?? 'plain text',
      },
    });
    if (content.example.note) blocks.push(paragraph(content.example.note));
  }
  if (content.aiTip) blocks.push(heading('🤖 AI에게 시킬 때'), paragraph(content.aiTip));
  if (content.practice) blocks.push(heading('🛠 10분 실습'), paragraph(content.practice));
  if (content.quiz) {
    blocks.push(heading('❓ 퀴즈'), {
      object: 'block',
      type: 'toggle',
      toggle: { rich_text: textChunks(content.quiz.question), children: [paragraph(content.quiz.answer)] },
    });
  }
  blocks.push(heading('🔗 공식 문서'), ...plan.lesson.refs.map(link));
  return blocks;
}

/** 레슨을 학습 노트 페이지로 아카이브. 같은 날 재실행이면 건너뛴다 (idempotent). */
export async function createLessonPageIfNew(
  token: string,
  databaseId: string,
  plan: LessonPlan,
  content: LessonContent,
  sentDate: string
): Promise<boolean> {
  const url = lessonPageUrl(plan, sentDate);
  if (await findByUrl(token, databaseId, url)) return false;

  const mode = plan.mode === 'easier' ? ' (쉽게 다시)' : plan.mode === 'deep' ? ` (심화 ${plan.round + 1}회차)` : '';
  const title = `[학습] ${plan.track.name} ${plan.index + 1}. ${plan.lesson.title}${mode}`;
  const properties = {
    제목: { title: [{ text: { content: title.slice(0, 200) } }] },
    URL: { url },
    카테고리: { select: { name: '학습' } },
    소스: { select: { name: 'hariesse 레슨' } },
    상태: { select: { name: STATUS_LABEL.unread } },
    요약: richText(content.summary),
    추천이유: richText(content.whyItMatters),
    태그: { multi_select: [{ name: plan.track.name }, { name: AREA_LABEL[plan.track.area] }] },
  };

  const res = await fetch(`${BASE}/pages`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children: buildLessonBlocks(plan, content),
    }),
  });
  if (!res.ok) throw new Error(`Notion lesson create 실패 ${res.status}: ${await res.text()}`);
  return true;
}
