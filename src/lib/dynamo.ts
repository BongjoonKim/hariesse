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
import type { Article, Source, Profile } from './types';

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

// ---- Profile ----

export async function getProfile(table: string): Promise<Profile | undefined> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk: 'PROFILE' } }));
  return res.Item as Profile | undefined;
}

export async function putProfile(table: string, profile: Profile): Promise<void> {
  await doc.send(new PutCommand({ TableName: table, Item: profile }));
}
