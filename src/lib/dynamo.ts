import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULTS } from './constants';
import { clampWeight, type FeedbackAction } from '../domain/feedback';
import type { Article, ArticleStatus, Source, Profile } from './types';

const region = process.env.AWS_REGION ?? DEFAULTS.BEDROCK_REGION;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

/** URL → 안정적인 articleId (dedup 키) */
export function hashUrl(url: string): string {
  return createHash('sha256').update(url.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/** 도메인 → siteId */
export function hashDomain(domain: string): string {
  return createHash('sha256').update(domain.trim().toLowerCase()).digest('hex').slice(0, 16);
}

// ---- Sources ----

export async function getActiveSources(table: string): Promise<Source[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'active' },
    })
  );
  return (res.Items ?? []) as Source[];
}

export async function putSource(table: string, source: Source): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: source }));
}

/**
 * 이미 있는 소스는 건드리지 않는 put. 시드/소스 추가 스크립트를 여러 번 돌려도
 * 피드백으로 쌓인 weight/likeCount가 초기화되지 않는다. 새로 넣었으면 true.
 */
export async function putSourceIfNew(table: string, source: Source): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: source,
        ConditionExpression: 'attribute_not_exists(siteId)',
      })
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function markSourceCrawled(
  table: string,
  siteId: string,
  at: string
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { siteId },
      UpdateExpression: 'SET lastCrawledAt = :at',
      ExpressionAttributeValues: { ':at': at },
    })
  );
}

// ---- Articles ----

export async function getArticle(table: string, articleId: string): Promise<Article | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { articleId } }));
  return res.Item as Article | undefined;
}

/** 신규 글만 기록 (이미 있으면 false). dedup/idempotency. */
export async function putArticleIfNew(table: string, article: Article): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: article,
        ConditionExpression: 'attribute_not_exists(articleId)',
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function listArticlesByStatus(
  table: string,
  status: Article['status'],
  limit = 100
): Promise<Article[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: table,
      IndexName: 'status-index',
      KeyConditionExpression: '#s = :st',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':st': status },
      Limit: limit,
    })
  );
  return (res.Items ?? []) as Article[];
}

export async function saveCuration(
  table: string,
  articleId: string,
  fields: Pick<Article, 'score' | 'summary' | 'aiOpinion' | 'tags' | 'curatedAt'>
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { articleId },
      UpdateExpression:
        'SET score = :score, summary = :summary, aiOpinion = :op, tags = :tags, curatedAt = :ca',
      ExpressionAttributeValues: {
        ':score': fields.score,
        ':summary': fields.summary,
        ':op': fields.aiOpinion,
        ':tags': fields.tags ?? [],
        ':ca': fields.curatedAt,
      },
    })
  );
}

export async function markDelivered(
  table: string,
  articleId: string,
  slot: Article['slot'],
  at: string
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { articleId },
      UpdateExpression: 'SET deliveredAt = :at, slot = :slot',
      ExpressionAttributeValues: { ':at': at, ':slot': slot },
    })
  );
}

// ---- Feedback ----

export async function getSource(table: string, siteId: string): Promise<Source | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { siteId } }));
  return res.Item as Source | undefined;
}

/**
 * 피드백 1회 반영 (idempotent). `${action}FeedbackAt` 마커가 이미 있으면 false.
 * 글이 TTL로 사라진 경우에도 false (ghost 아이템 생성 방지).
 */
export async function markArticleFeedbackOnce(
  table: string,
  articleId: string,
  action: FeedbackAction,
  fields: { status?: ArticleStatus; liked?: boolean; nadelivCandidate?: boolean },
  at: string
): Promise<boolean> {
  const sets = ['#flag = :at'];
  const names: Record<string, string> = { '#flag': `${action}FeedbackAt` };
  const values: Record<string, unknown> = { ':at': at };
  if (fields.status !== undefined) {
    sets.push('#s = :st');
    names['#s'] = 'status';
    values[':st'] = fields.status;
  }
  if (fields.liked !== undefined) {
    sets.push('liked = :lk');
    values[':lk'] = fields.liked;
  }
  if (fields.nadelivCandidate !== undefined) {
    sets.push('nadelivCandidate = :nc');
    values[':nc'] = fields.nadelivCandidate;
  }
  try {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { articleId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(articleId) AND attribute_not_exists(#flag)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** 소스 가중치/카운터 조정. weight는 read-modify-write로 클램프. */
export async function adjustSourceFeedback(
  table: string,
  siteId: string,
  deltas: { weightDelta: number; likeCountDelta: number; skipCountDelta: number }
): Promise<void> {
  const source = await getSource(table, siteId);
  if (!source) return;
  await doc.send(
    new UpdateCommand({
      TableName: table,
      Key: { siteId },
      UpdateExpression: 'SET weight = :w ADD likeCount :lc, skipCount :sc',
      ExpressionAttributeValues: {
        ':w': clampWeight((source.weight ?? 1) + deltas.weightDelta),
        ':lc': deltas.likeCountDelta,
        ':sc': deltas.skipCountDelta,
      },
    })
  );
}

/** 좋아요한 글의 태그를 Profile 관심사에 누적. */
export async function bumpProfileInterests(
  table: string,
  tags: string[],
  at: string
): Promise<void> {
  if (tags.length === 0) return;
  const profile = await getProfile(table);
  if (!profile) return;
  const interests = { ...profile.interests };
  for (const tag of tags) {
    const key = tag.trim();
    if (!key) continue;
    interests[key] = (interests[key] ?? 0) + 1;
  }
  await putProfile(table, { ...profile, interests, updatedAt: at });
}

// ---- Profile ----

export async function getProfile(table: string): Promise<Profile | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk: 'PROFILE' } }));
  return res.Item as Profile | undefined;
}

export async function putProfile(table: string, profile: Profile): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: profile }));
}
