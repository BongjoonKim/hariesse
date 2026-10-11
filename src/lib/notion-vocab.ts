import { BASE, headers } from './notion';
import { kstDate, compactPageId, KIND_LABEL, STATUS_LABEL } from '../domain/vocab';
import type { VocabEntry, VocabKind, VocabOrigin, VocabStatus } from './types';

/**
 * "TOEFL Vocab" Notion DB — 단어장의 원본 저장소.
 * 속성 이름이 곧 스키마라 바꾸면 여기와 DB를 같이 바꿔야 한다.
 * 사용자가 Notion에서 직접 행을 추가하므로 '표현' 말고는 전부 비어 있을 수 있다고 가정한다.
 */
export const VOCAB_PROP = {
  text: '표현',
  key: '키',
  kind: '종류',
  meaning: '뜻',
  pos: '품사',
  pronunciation: '발음',
  example: '예문',
  synonyms: '동의어',
  note: '메모',
  tags: '태그',
  box: '박스',
  nextReview: '다음 복습',
  lastReviewed: '마지막 복습',
  status: '상태',
  missCount: '헷갈린 횟수',
  origin: '입력 경로',
} as const;

export const ORIGIN_LABEL: Record<VocabOrigin, string> = { telegram: 'Telegram', notion: 'Notion' };

function invert<T extends string>(m: Record<T, string>): Record<string, T> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<string, T>;
}
const KIND_BY_LABEL = invert<VocabKind>(KIND_LABEL);
const STATUS_BY_LABEL = invert<VocabStatus>(STATUS_LABEL);
const ORIGIN_BY_LABEL = invert<VocabOrigin>(ORIGIN_LABEL);

export type VocabFields = Partial<Omit<VocabEntry, 'pageId' | 'createdDate'>>;

/**
 * 단어 필드 → Notion properties. 넘긴 키만 만든다 (PATCH 시 다른 칸을 건드리지 않게).
 * 키는 있는데 값이 undefined면 그 칸을 비운다 (예: 외움 처리 시 다음 복습 삭제). 순수함수.
 */
export function buildVocabProperties(f: VocabFields): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const has = (k: keyof VocabFields) => Object.prototype.hasOwnProperty.call(f, k);
  const text = (k: keyof VocabFields, name: string) => {
    if (has(k)) props[name] = { rich_text: f[k] ? [{ text: { content: String(f[k]).slice(0, 1900) } }] : [] };
  };
  // select 옵션 이름엔 쉼표를 못 쓴다
  const select = (k: keyof VocabFields, name: string, label?: string) => {
    if (has(k)) props[name] = { select: label ? { name: label.replace(/,/g, ' ').slice(0, 100) } : null };
  };
  const date = (k: keyof VocabFields, name: string) => {
    if (has(k)) props[name] = { date: f[k] ? { start: String(f[k]) } : null };
  };
  const number = (k: keyof VocabFields, name: string) => {
    if (has(k)) props[name] = { number: typeof f[k] === 'number' ? f[k] : null };
  };

  if (has('text')) props[VOCAB_PROP.text] = { title: [{ text: { content: (f.text ?? '').slice(0, 1900) } }] };
  text('key', VOCAB_PROP.key);
  select('kind', VOCAB_PROP.kind, f.kind && KIND_LABEL[f.kind]);
  text('meaning', VOCAB_PROP.meaning);
  select('pos', VOCAB_PROP.pos, f.pos?.toLowerCase());
  text('pronunciation', VOCAB_PROP.pronunciation);
  text('example', VOCAB_PROP.example);
  text('synonyms', VOCAB_PROP.synonyms);
  text('note', VOCAB_PROP.note);
  if (has('tags')) {
    props[VOCAB_PROP.tags] = {
      multi_select: (f.tags ?? []).slice(0, 10).map((name) => ({ name: name.replace(/,/g, ' ') })),
    };
  }
  number('box', VOCAB_PROP.box);
  date('nextReview', VOCAB_PROP.nextReview);
  date('lastReviewed', VOCAB_PROP.lastReviewed);
  select('status', VOCAB_PROP.status, f.status && STATUS_LABEL[f.status]);
  number('missCount', VOCAB_PROP.missCount);
  select('origin', VOCAB_PROP.origin, f.origin && ORIGIN_LABEL[f.origin]);
  return props;
}

export interface NotionPage {
  id: string;
  created_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, Record<string, unknown>>;
}

type Prop = Record<string, unknown> | undefined;

function plain(prop: Prop, type: 'title' | 'rich_text'): string {
  const parts = (prop?.[type] as { plain_text?: string }[] | undefined) ?? [];
  return parts.map((p) => p.plain_text ?? '').join('').trim();
}
const selectName = (prop: Prop) => (prop?.select as { name?: string } | null | undefined)?.name;
const dateStart = (prop: Prop) => (prop?.date as { start?: string } | null | undefined)?.start?.slice(0, 10);
const numberValue = (prop: Prop) => (typeof prop?.number === 'number' ? prop.number : undefined);

/** Notion page → VocabEntry. 손으로 넣은 행이라 빈 칸·모르는 선택지를 모두 허용. 순수함수. */
export function parseVocabPage(page: NotionPage): VocabEntry {
  const p = page.properties ?? {};
  const text = (name: string) => plain(p[name], 'rich_text') || undefined;
  const label = <T extends string>(name: string, by: Record<string, T>) => {
    const l = selectName(p[name]);
    return l ? by[l] : undefined;
  };
  return {
    pageId: compactPageId(page.id),
    text: plain(p[VOCAB_PROP.text], 'title'),
    key: text(VOCAB_PROP.key),
    kind: label(VOCAB_PROP.kind, KIND_BY_LABEL),
    meaning: text(VOCAB_PROP.meaning),
    pos: selectName(p[VOCAB_PROP.pos]),
    pronunciation: text(VOCAB_PROP.pronunciation),
    example: text(VOCAB_PROP.example),
    synonyms: text(VOCAB_PROP.synonyms),
    note: text(VOCAB_PROP.note),
    tags: ((p[VOCAB_PROP.tags]?.multi_select as { name: string }[] | undefined) ?? []).map((t) => t.name),
    box: numberValue(p[VOCAB_PROP.box]) ?? 0,
    nextReview: dateStart(p[VOCAB_PROP.nextReview]),
    lastReviewed: dateStart(p[VOCAB_PROP.lastReviewed]),
    status: label(VOCAB_PROP.status, STATUS_BY_LABEL),
    missCount: numberValue(p[VOCAB_PROP.missCount]) ?? 0,
    origin: label(VOCAB_PROP.origin, ORIGIN_BY_LABEL),
    createdDate: page.created_time ? kstDate(new Date(page.created_time)) : undefined,
  };
}

async function notionFetch(token: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Notion ${method} ${path} 실패 ${res.status}: ${await res.text()}`);
  return res.json();
}

/** DB 조회 (페이지네이션). limit까지만 모은다. */
async function queryVocab(
  token: string,
  databaseId: string,
  filter: unknown,
  sorts: unknown[],
  limit: number
): Promise<VocabEntry[]> {
  const entries: VocabEntry[] = [];
  let cursor: string | undefined;
  do {
    const data = (await notionFetch(token, `/databases/${databaseId}/query`, 'POST', {
      filter,
      sorts,
      page_size: Math.min(100, limit - entries.length),
      ...(cursor ? { start_cursor: cursor } : {}),
    })) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null };
    entries.push(...(data.results ?? []).map(parseVocabPage));
    cursor = data.has_more ? data.next_cursor ?? undefined : undefined;
  } while (cursor && entries.length < limit);
  return entries;
}

export async function findVocabByKey(
  token: string,
  databaseId: string,
  key: string
): Promise<VocabEntry | undefined> {
  const [found] = await queryVocab(token, databaseId, { property: VOCAB_PROP.key, rich_text: { equals: key } }, [], 1);
  return found;
}

/** 뜻을 채워야 하는 행: 상태가 비었거나(Notion에 직접 입력) '새로 추가'. 오래된 것부터. */
export function listVocabNeedingEnrichment(token: string, databaseId: string, limit: number): Promise<VocabEntry[]> {
  return queryVocab(
    token,
    databaseId,
    {
      and: [
        // Notion에서 만들다 만 빈 행은 매번 상한만 잡아먹으니 제외
        { property: VOCAB_PROP.text, title: { is_not_empty: true } },
        {
          or: [
            { property: VOCAB_PROP.status, select: { is_empty: true } },
            { property: VOCAB_PROP.status, select: { equals: STATUS_LABEL.new } },
          ],
        },
      ],
    },
    [{ timestamp: 'created_time', direction: 'ascending' }],
    limit
  );
}

/** 다음 복습일이 today 이전이고 외우지 않은 행. 최종 순서·개수는 pickDueEntries가 정한다. */
export function listDueVocab(token: string, databaseId: string, today: string, limit: number): Promise<VocabEntry[]> {
  return queryVocab(
    token,
    databaseId,
    {
      and: [
        { property: VOCAB_PROP.nextReview, date: { on_or_before: today } },
        { property: VOCAB_PROP.status, select: { does_not_equal: STATUS_LABEL.mastered } },
      ],
    },
    [{ property: VOCAB_PROP.nextReview, direction: 'ascending' }],
    limit
  );
}

/** 휴지통에 있는 페이지면 undefined. */
export async function getVocabPage(token: string, pageId: string): Promise<VocabEntry | undefined> {
  const page = (await notionFetch(token, `/pages/${pageId}`, 'GET')) as NotionPage;
  return page.archived || page.in_trash ? undefined : parseVocabPage(page);
}

export async function createVocabPage(token: string, databaseId: string, fields: VocabFields): Promise<string> {
  const page = (await notionFetch(token, '/pages', 'POST', {
    parent: { database_id: databaseId },
    properties: buildVocabProperties(fields),
  })) as NotionPage;
  return compactPageId(page.id);
}

export async function updateVocabPage(token: string, pageId: string, fields: VocabFields): Promise<void> {
  await notionFetch(token, `/pages/${pageId}`, 'PATCH', { properties: buildVocabProperties(fields) });
}

/** 삭제 = Notion 휴지통으로 이동 (30일 안에 복구 가능). */
export async function archiveVocabPage(token: string, pageId: string): Promise<void> {
  await notionFetch(token, `/pages/${pageId}`, 'PATCH', { archived: true });
}
