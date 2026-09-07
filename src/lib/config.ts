import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ENV, SSM, SECRETS, DEFAULTS } from './constants';
import type { GoogleOAuthSecret } from './google-oauth';

/**
 * SSM/Secrets에서 설정·시크릿을 1회 로드해 콜드스타트 동안 캐시.
 * 테이블/버킷 이름은 Lambda 환경변수에서 직접 읽는다.
 */

const region = process.env.AWS_REGION ?? DEFAULTS.BEDROCK_REGION;
const ssm = new SSMClient({ region });
const secretsClient = new SecretsManagerClient({ region });

export interface AppConfig {
  sourcesTable: string;
  articlesTable: string;
  profileTable: string;
  /** 할일/루틴 테이블. 파이프라인 Lambda에는 주입하지 않으므로 비어 있을 수 있다. */
  tasksTable: string;
  rawBucket: string;
  bedrockModelId: string;
  bedrockRegion: string;
  explorationRatio: number;
  notionDatabaseId: string;
  telegramChatId: string;
  dailyBedrockCap: number;
  dailyCurateCap: number;
  digestSize: number;
  /** 웹 로그인 허용 이메일 (쉼표 구분). 비면 아무도 못 들어온다. */
  allowedEmail: string;
  /** 웹 오리진 (CloudFront 도메인). OAuth redirect_uri의 출처 — 배포 후 SSM에 넣는다. */
  webOrigin: string;
}

let cachedConfig: AppConfig | undefined;
const secretCache = new Map<string, string>();

function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function getConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;

  const names = [
    SSM.BEDROCK_MODEL_ID,
    SSM.BEDROCK_REGION,
    SSM.EXPLORATION_RATIO,
    SSM.NOTION_DATABASE_ID,
    SSM.TELEGRAM_CHAT_ID,
    SSM.DAILY_BEDROCK_CAP,
    SSM.DAILY_CURATE_CAP,
    SSM.DIGEST_SIZE,
    SSM.ALLOWED_EMAIL,
    SSM.WEB_ORIGIN,
  ];

  const res = await ssm.send(new GetParametersCommand({ Names: names }));
  const p: Record<string, string> = {};
  for (const param of res.Parameters ?? []) {
    if (param.Name && param.Value !== undefined) p[param.Name] = param.Value;
  }

  cachedConfig = {
    sourcesTable: envOrThrow(ENV.SOURCES_TABLE),
    articlesTable: envOrThrow(ENV.ARTICLES_TABLE),
    profileTable: envOrThrow(ENV.PROFILE_TABLE),
    tasksTable: process.env[ENV.TASKS_TABLE] ?? '',
    rawBucket: envOrThrow(ENV.RAW_BUCKET),
    bedrockModelId: p[SSM.BEDROCK_MODEL_ID] ?? DEFAULTS.BEDROCK_MODEL_ID,
    bedrockRegion: p[SSM.BEDROCK_REGION] ?? DEFAULTS.BEDROCK_REGION,
    explorationRatio: num(p[SSM.EXPLORATION_RATIO], DEFAULTS.EXPLORATION_RATIO),
    notionDatabaseId: p[SSM.NOTION_DATABASE_ID] ?? '',
    telegramChatId: p[SSM.TELEGRAM_CHAT_ID] ?? '',
    dailyBedrockCap: num(p[SSM.DAILY_BEDROCK_CAP], DEFAULTS.DAILY_BEDROCK_CAP),
    dailyCurateCap: num(p[SSM.DAILY_CURATE_CAP], DEFAULTS.DAILY_CURATE_CAP),
    digestSize: num(p[SSM.DIGEST_SIZE], DEFAULTS.DIGEST_SIZE),
    allowedEmail: p[SSM.ALLOWED_EMAIL] ?? '',
    webOrigin: (p[SSM.WEB_ORIGIN] ?? '').replace(/\/$/, ''),
  };
  return cachedConfig;
}

/** Secrets Manager에서 시크릿을 캐시와 함께 로드. */
export async function getSecret(name: string): Promise<string> {
  const cached = secretCache.get(name);
  if (cached !== undefined) return cached;
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: name }));
  const value = res.SecretString ?? '';
  secretCache.set(name, value);
  return value;
}

export const getTelegramBotToken = () => getSecret(SECRETS.TELEGRAM_BOT_TOKEN);
export const getNotionToken = () => getSecret(SECRETS.NOTION_TOKEN);
export const getTelegramWebhookSecret = () => getSecret(SECRETS.TELEGRAM_WEBHOOK_SECRET);
export const getSessionSecret = () => getSecret(SECRETS.SESSION_SECRET);

/** Secrets `hariesse/google-oauth` = {"clientId":"…","clientSecret":"…"} */
export async function getGoogleOAuth(): Promise<GoogleOAuthSecret> {
  const raw = await getSecret(SECRETS.GOOGLE_OAUTH);
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleOAuthSecret>;
    if (!parsed.clientId || !parsed.clientSecret) throw new Error('clientId/clientSecret 없음');
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch (err) {
    throw new Error(`Secrets ${SECRETS.GOOGLE_OAUTH} 형식 오류: ${(err as Error).message}`);
  }
}
