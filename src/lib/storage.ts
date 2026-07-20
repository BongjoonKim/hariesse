import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DEFAULTS } from './constants';

const region = process.env.AWS_REGION ?? DEFAULTS.BEDROCK_REGION;
const s3 = new S3Client({ region });

export function rawKey(articleId: string): string {
  return `raw/${articleId}.txt`;
}

export async function putRawText(bucket: string, articleId: string, text: string): Promise<string> {
  const Key = rawKey(articleId);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key, Body: text, ContentType: 'text/plain; charset=utf-8' })
  );
  return Key;
}

export async function getRawText(bucket: string, articleId: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rawKey(articleId) }));
  return (await res.Body?.transformToString('utf-8')) ?? '';
}
