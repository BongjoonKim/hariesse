import type { Article, Category, SourceType, ArticleStatus } from './types';

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
