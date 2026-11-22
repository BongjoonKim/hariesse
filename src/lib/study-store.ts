import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULTS } from './constants';
import { queryDatabase, parseVocabPage } from './notion-vocab';
import { parseWritingPage } from './notion-writing';
import { diffMirror } from '../domain/mirror';
import { emptyDay, type DayRecord, type MissionSettings } from '../domain/missions';
import type { LoginState } from '../domain/web-auth';
import type { Article, Category, VocabEntry, WritingEntry } from './types';

/**
 * 학습 테이블 (pk, sk) — 웹(WebFn) 전용.
 *   VOCAB   / <pageId>      Notion "TOEFL Vocab" 행의 사본
 *   WRITING / <pageId>      Notion "TOEFL Writing" 행의 사본
 *   DAY     / <YYYY-MM-DD>  하루치 미션 기록 (KST)
 *   META    / sync | settings | login
 * 단어장·Writing의 원본은 여전히 Notion이다. 여기는 웹이 전체를 한 번에 읽기 위한 사본이고,
 * 웹에서 바꾼 것은 Notion에 먼저 쓰고 사본을 같이 고친다 (다음 동기화가 어차피 Notion 기준으로 맞춘다).
 */

const region = process.env.AWS_REGION ?? DEFAULTS.BEDROCK_REGION;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export type MirrorKind = 'VOCAB' | 'WRITING';

function strip<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as T;
}

async function queryPartition<T>(table: string, pk: string, fromSk?: string): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: fromSk ? 'pk = :pk AND sk >= :from' : 'pk = :pk',
        ExpressionAttributeValues: fromSk ? { ':pk': pk, ':from': fromSk } : { ':pk': pk },
        ExclusiveStartKey: startKey,
      })
    );
    items.push(...(res.Items ?? []).map((i) => strip<T>(i)));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

// ---- 미러 (단어장 · Writing) ----

export const listVocab = (table: string) => queryPartition<VocabEntry>(table, 'VOCAB');
export const listWriting = (table: string) => queryPartition<WritingEntry>(table, 'WRITING');

export async function getMirrorEntry<T>(table: string, kind: MirrorKind, pageId: string): Promise<T | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk: kind, sk: pageId } }));
  return res.Item ? strip<T>(res.Item) : undefined;
}

export async function putMirrorEntry(table: string, kind: MirrorKind, entry: VocabEntry | WritingEntry): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: { ...entry, pk: kind, sk: entry.pageId } }));
}

export async function deleteMirrorEntry(table: string, kind: MirrorKind, pageId: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: table, Key: { pk: kind, sk: pageId } }));
}

async function batchWrite(table: string, requests: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < requests.length; i += 25) {
    let pending: Record<string, unknown>[] | undefined = requests.slice(i, i + 25);
    for (let attempt = 0; pending?.length; attempt++) {
      if (attempt > 5) throw new Error('DynamoDB BatchWrite: 미처리 항목이 남았다');
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = res.UnprocessedItems?.[table] as Record<string, unknown>[] | undefined;
    }
  }
}

async function applyDiff<T extends VocabEntry | WritingEntry>(table: string, kind: MirrorKind, current: T[], fresh: T[]) {
  const { puts, deletes } = diffMirror(current, fresh);
  await batchWrite(table, [
    ...puts.map((e) => ({ PutRequest: { Item: { ...e, pk: kind, sk: e.pageId } } })),
    ...deletes.map((pageId) => ({ DeleteRequest: { Key: { pk: kind, sk: pageId } } })),
  ]);
  return { total: fresh.length, changed: puts.length, removed: deletes.length };
}

/** Notion DB 한 개에서 받아 올 최대 행 수 (100행당 요청 1번). */
const SYNC_ROW_LIMIT = 5000;
const BY_CREATED = [{ timestamp: 'created_time', direction: 'ascending' }];

export interface SyncResult {
  at: string;
  vocab?: { total: number; changed: number; removed: number };
  writing?: { total: number; changed: number; removed: number };
}

/** Notion 두 DB를 통째로 읽어 미러를 맞춘다. 바뀐 행만 쓴다. DB id가 비어 있으면 그쪽은 건너뛴다. */
export async function syncFromNotion(
  table: string,
  notionToken: string,
  dbs: { vocab: string; writing: string }
): Promise<SyncResult> {
  const result: SyncResult = { at: new Date().toISOString() };
  // 제목이 빈 행(Notion에서 만들다 만 것)은 미러에 넣지 않는다
  const named = <T extends { text: string }>(rows: T[]) => rows.filter((r) => r.text.trim() !== '');
  if (dbs.vocab) {
    const [fresh, current] = await Promise.all([
      queryDatabase(notionToken, dbs.vocab, undefined, BY_CREATED, SYNC_ROW_LIMIT, parseVocabPage),
      listVocab(table),
    ]);
    result.vocab = await applyDiff(table, 'VOCAB', current, named(fresh));
  }
  if (dbs.writing) {
    const [fresh, current] = await Promise.all([
      queryDatabase(notionToken, dbs.writing, undefined, BY_CREATED, SYNC_ROW_LIMIT, parseWritingPage),
      listWriting(table),
    ]);
    result.writing = await applyDiff(table, 'WRITING', current, named(fresh));
  }
  await putMeta(table, 'sync', result);
  return result;
}

// ---- 하루 기록 ----

export async function getDay(table: string, date: string): Promise<DayRecord> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk: 'DAY', sk: date } }));
  return res.Item ? { ...emptyDay(date), ...strip<DayRecord>(res.Item) } : emptyDay(date);
}

export async function putDay(table: string, day: DayRecord): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: { ...day, pk: 'DAY', sk: day.date } }));
}

export const listDaysSince = (table: string, fromDate: string) => queryPartition<DayRecord>(table, 'DAY', fromDate);

// ---- META ----

export async function getMeta<T>(table: string, sk: 'sync' | 'settings' | 'login'): Promise<T | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk: 'META', sk } }));
  return res.Item ? strip<T>(res.Item) : undefined;
}

export async function putMeta(
  table: string,
  sk: 'sync' | 'settings' | 'login',
  value: SyncResult | MissionSettings | LoginState
): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: { ...value, pk: 'META', sk } }));
}

// ---- 기술 글 (Articles 테이블, 읽기 전용) ----

export type TechArticle = Pick<
  Article,
  'articleId' | 'url' | 'title' | 'category' | 'score' | 'summary' | 'aiOpinion' | 'tags' | 'discussionUrl' | 'deliveredAt'
>;

/** since(ISO) 이후 다이제스트로 나간 글. 최근 것 먼저. */
export async function listDeliveredSince(articlesTable: string, categories: Category[], since: string): Promise<TechArticle[]> {
  const pages = await Promise.all(
    categories.map((category) =>
      doc.send(
        new QueryCommand({
          TableName: articlesTable,
          IndexName: 'category-deliveredAt-index',
          KeyConditionExpression: 'category = :c AND deliveredAt >= :since',
          ExpressionAttributeValues: { ':c': category, ':since': since },
          ScanIndexForward: false,
          Limit: 30,
        })
      )
    )
  );
  return pages
    .flatMap((p) => (p.Items ?? []) as Article[])
    .map(({ articleId, url, title, category, score, summary, aiOpinion, tags, discussionUrl, deliveredAt }) => ({
      articleId, url, title, category, score, summary, aiOpinion, tags, discussionUrl, deliveredAt,
    }))
    .sort((a, b) => ((a.deliveredAt ?? '') < (b.deliveredAt ?? '') ? 1 : -1));
}
