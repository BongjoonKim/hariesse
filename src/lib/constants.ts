/**
 * CDK와 런타임이 공유하는 상수: 환경변수 키, SSM/Secrets 경로.
 * 값(토큰 등)은 여기 두지 않는다 — 이름만.
 */

// Lambda 환경변수 키 (CDK가 주입, 런타임이 읽음)
export const ENV = {
  SOURCES_TABLE: 'SOURCES_TABLE',
  ARTICLES_TABLE: 'ARTICLES_TABLE',
  PROFILE_TABLE: 'PROFILE_TABLE',
  RAW_BUCKET: 'RAW_BUCKET',
} as const;

// SSM Parameter Store 경로 (비-시크릿 설정값)
export const SSM = {
  BEDROCK_MODEL_ID: '/hariesse/bedrock-model-id',
  BEDROCK_REGION: '/hariesse/bedrock-region',
  EXPLORATION_RATIO: '/hariesse/exploration-ratio',
  NOTION_DATABASE_ID: '/hariesse/notion-database-id',
  TELEGRAM_CHAT_ID: '/hariesse/telegram-chat-id',
  // 가드레일
  DAILY_BEDROCK_CAP: '/hariesse/daily-bedrock-cap',
  DAILY_CURATE_CAP: '/hariesse/daily-curate-cap',
  DIGEST_SIZE: '/hariesse/digest-size',
} as const;

// Secrets Manager 시크릿 이름 (민감 토큰)
export const SECRETS = {
  TELEGRAM_BOT_TOKEN: 'hariesse/telegram-bot-token',
  NOTION_TOKEN: 'hariesse/notion-token',
} as const;

// 기본값 (SSM 미설정 시 폴백)
export const DEFAULTS = {
  BEDROCK_REGION: 'ap-northeast-2',
  // 서울 리전은 교차리전 추론 프로파일(apac.*)로 호출. 가용성은 배포 전 콘솔에서 확인.
  BEDROCK_MODEL_ID: 'apac.anthropic.claude-sonnet-4-20250514-v1:0',
  EXPLORATION_RATIO: 0.3,
  DAILY_BEDROCK_CAP: 50,
  DAILY_CURATE_CAP: 40,
  DIGEST_SIZE: 8,
  ARTICLE_TTL_DAYS: 30,
} as const;
