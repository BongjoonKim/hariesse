import { kstDate } from '../domain/vocab';
import { WRITING_STATUS_LABEL, compactPageId } from '../domain/writing';
import { notionFetch, queryDatabase, plain, selectName, dateStart, numberValue, type NotionPage } from './notion-vocab';
import type { WritingEntry, WritingStatus } from './types';

/**
 * "TOEFL Writing" Notion DB — Writing 문장 연습의 원본 저장소.
 * 속성 이름이 곧 스키마라 바꾸면 여기와 DB를 같이 바꿔야 한다.
 * 사용자가 Notion에서 직접 행을 추가하므로 '문장' 말고는 전부 비어 있을 수 있다고 가정한다.
 */
export const WRITING_PROP = {
  text: '문장',
  key: '키',
  korean: '한국어',
  corrected: '교정',
  note: '메모',
  source: '출처',
  order: '번호',
  status: '상태',
  quizCount: '출제 횟수',
  lastQuizzed: '마지막 출제',
} as const;

const STATUS_BY_LABEL = Object.fromEntries(
  Object.entries(WRITING_STATUS_LABEL).map(([k, v]) => [v, k])
) as Record<string, WritingStatus>;

export type WritingFields = Partial<Omit<WritingEntry, 'pageId' | 'createdDate'>>;

/**
 * 필드 → Notion properties. 넘긴 키만 만든다 (PATCH 시 다른 칸을 건드리지 않게).
 * 키는 있는데 값이 undefined면 그 칸을 비운다. 순수함수.
 */
export function buildWritingProperties(f: WritingFields): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const has = (k: keyof WritingFields) => Object.prototype.hasOwnProperty.call(f, k);
  const text = (k: keyof WritingFields, name: string) => {
    if (has(k)) props[name] = { rich_text: f[k] ? [{ text: { content: String(f[k]).slice(0, 1900) } }] : [] };
  };
  const select = (k: keyof WritingFields, name: string, label?: string) => {
    if (has(k)) props[name] = { select: label ? { name: label.replace(/,/g, ' ').slice(0, 100) } : null };
  };
  const number = (k: keyof WritingFields, name: string) => {
    if (has(k)) props[name] = { number: typeof f[k] === 'number' ? f[k] : null };
  };

  if (has('text')) props[WRITING_PROP.text] = { title: [{ text: { content: (f.text ?? '').slice(0, 1900) } }] };
  text('key', WRITING_PROP.key);
  text('korean', WRITING_PROP.korean);
  text('corrected', WRITING_PROP.corrected);
  text('note', WRITING_PROP.note);
  select('source', WRITING_PROP.source, f.source);
  number('order', WRITING_PROP.order);
  select('status', WRITING_PROP.status, f.status && WRITING_STATUS_LABEL[f.status]);
  number('quizCount', WRITING_PROP.quizCount);
  if (has('lastQuizzed')) props[WRITING_PROP.lastQuizzed] = { date: f.lastQuizzed ? { start: f.lastQuizzed } : null };
  return props;
}

/** Notion page → WritingEntry. 손으로 넣은 행이라 빈 칸·모르는 선택지를 모두 허용. 순수함수. */
export function parseWritingPage(page: NotionPage): WritingEntry {
  const p = page.properties ?? {};
  const text = (name: string) => plain(p[name], 'rich_text') || undefined;
  const statusLabel = selectName(p[WRITING_PROP.status]);
  return {
    pageId: compactPageId(page.id),
    text: plain(p[WRITING_PROP.text], 'title'),
    key: text(WRITING_PROP.key),
    korean: text(WRITING_PROP.korean),
    corrected: text(WRITING_PROP.corrected),
    note: text(WRITING_PROP.note),
    source: selectName(p[WRITING_PROP.source]),
    order: numberValue(p[WRITING_PROP.order]),
    status: statusLabel ? STATUS_BY_LABEL[statusLabel] : undefined,
    quizCount: numberValue(p[WRITING_PROP.quizCount]) ?? 0,
    lastQuizzed: dateStart(p[WRITING_PROP.lastQuizzed]),
    createdDate: page.created_time ? kstDate(new Date(page.created_time)) : undefined,
  };
}

const NOT_EXCLUDED = { property: WRITING_PROP.status, select: { does_not_equal: WRITING_STATUS_LABEL.excluded } };

/** 채워야 하는 행: 문장이 있고 제외가 아니며, 상태가 비었거나 '새로 추가'거나 한국어가 빈 것. 오래된 것부터. */
export function listWritingNeedingEnrichment(token: string, databaseId: string, limit: number): Promise<WritingEntry[]> {
  return queryDatabase(
    token,
    databaseId,
    {
      and: [
        { property: WRITING_PROP.text, title: { is_not_empty: true } },
        NOT_EXCLUDED,
        {
          or: [
            { property: WRITING_PROP.status, select: { is_empty: true } },
            { property: WRITING_PROP.status, select: { equals: WRITING_STATUS_LABEL.new } },
            { property: WRITING_PROP.korean, rich_text: { is_empty: true } },
          ],
        },
      ],
    },
    [{ timestamp: 'created_time', direction: 'ascending' }],
    limit,
    parseWritingPage
  );
}

/** 출제 후보: 한국어가 있고 제외가 아닌 행 전부 (추가일 → 번호 순). 최종 순서·개수는 pickQuizEntries가 정한다. */
export function listWritingCandidates(token: string, databaseId: string, limit: number): Promise<WritingEntry[]> {
  return queryDatabase(
    token,
    databaseId,
    { and: [{ property: WRITING_PROP.korean, rich_text: { is_not_empty: true } }, NOT_EXCLUDED] },
    [
      { timestamp: 'created_time', direction: 'ascending' },
      { property: WRITING_PROP.order, direction: 'ascending' },
    ],
    limit,
    parseWritingPage
  );
}

export async function updateWritingPage(token: string, pageId: string, fields: WritingFields): Promise<void> {
  await notionFetch(token, `/pages/${pageId}`, 'PATCH', { properties: buildWritingProperties(fields) });
}
