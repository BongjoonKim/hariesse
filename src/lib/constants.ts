/**
 * CDK와 런타임이 공유하는 상수: 환경변수 키, SSM/Secrets 경로.
 * 값(토큰 등)은 여기 두지 않는다 — 이름만.
 *
 * stage: 같은 AWS 계정에 hariesse를 여러 벌 올리기 위한 접두어.
 *   - stage 없음(기본, 내 것): 스택 `Hariesse*`, SSM `/hariesse/*`, Secrets `hariesse/*`
 *   - stage=design:            스택 `HariesseDesign*`, SSM `/hariesse-design/*`, Secrets `hariesse-design/*`
 * CDK는 `configPrefix(stage)`로 이름을 만들고, Lambda에는 ENV.STAGE로 넘긴다.
 * 런타임은 ENV.STAGE를 읽어 같은 규칙으로 SSM/SECRETS 경로를 만든다.
 */

// Lambda 환경변수 키 (CDK가 주입, 런타임이 읽음)
export const ENV = {
  SOURCES_TABLE: 'SOURCES_TABLE',
  ARTICLES_TABLE: 'ARTICLES_TABLE',
  PROFILE_TABLE: 'PROFILE_TABLE',
  RAW_BUCKET: 'RAW_BUCKET',
  /** 배포 stage (없으면 기본 배포). SSM/Secrets 접두어를 정한다. */
  STAGE: 'HARIESSE_STAGE',
} as const;

/** stage → SSM/Secrets 접두어. stage가 없거나 빈 문자열이면 기존 이름 그대로. */
export function configPrefix(stage?: string): { ssm: string; secrets: string } {
  const s = (stage ?? '').trim();
  const base = s ? `hariesse-${s}` : 'hariesse';
  return { ssm: `/${base}`, secrets: base };
}

/** stage → 스택 이름 접두어 (`Hariesse` / `HariesseDesign`). */
export function stackPrefix(stage?: string): string {
  const s = (stage ?? '').trim();
  if (!s) return 'Hariesse';
  return `Hariesse${s[0].toUpperCase()}${s.slice(1)}`;
}

/** SSM Parameter Store 경로 (비-시크릿 설정값) */
export function ssmPaths(prefix: string) {
  return {
    BEDROCK_MODEL_ID: `${prefix}/bedrock-model-id`,
    BEDROCK_REGION: `${prefix}/bedrock-region`,
    EXPLORATION_RATIO: `${prefix}/exploration-ratio`,
    NOTION_DATABASE_ID: `${prefix}/notion-database-id`,
    TELEGRAM_CHAT_ID: `${prefix}/telegram-chat-id`,
    /** 큐레이션 프롬프트에 넣을 사용자 소개(한두 문장). 없으면 생략. */
    USER_PERSONA: `${prefix}/user-persona`,
    // 가드레일
    DAILY_BEDROCK_CAP: `${prefix}/daily-bedrock-cap`,
    DAILY_CURATE_CAP: `${prefix}/daily-curate-cap`,
    DIGEST_SIZE: `${prefix}/digest-size`,
    DIGEST_MIN_SIZE: `${prefix}/digest-min-size`,
    DIGEST_MIN_SCORE: `${prefix}/digest-min-score`,
  } as const;
}

/** Secrets Manager 시크릿 이름 (민감 토큰) */
export function secretNames(prefix: string) {
  return {
    TELEGRAM_BOT_TOKEN: `${prefix}/telegram-bot-token`,
    NOTION_TOKEN: `${prefix}/notion-token`,
    TELEGRAM_WEBHOOK_SECRET: `${prefix}/telegram-webhook-secret`,
  } as const;
}

// 런타임용: Lambda 환경변수의 stage로 결정된 경로. (CDK 합성 시에는 stage 미설정 → 기본 경로지만, CDK는 이 객체를 쓰지 않는다.)
const runtimePrefix = configPrefix(process.env[ENV.STAGE]);
export const SSM = ssmPaths(runtimePrefix.ssm);
export const SECRETS = secretNames(runtimePrefix.secrets);

// 기본값 (SSM 미설정 시 폴백)
export const DEFAULTS = {
  BEDROCK_REGION: 'ap-northeast-2',
  // 서울 리전은 교차리전 추론 프로파일(apac.*)로 호출. 가용성은 배포 전 콘솔에서 확인.
  BEDROCK_MODEL_ID: 'apac.anthropic.claude-sonnet-4-20250514-v1:0',
  EXPLORATION_RATIO: 0.3,
  DAILY_BEDROCK_CAP: 50,
  DAILY_CURATE_CAP: 40,
  // 다이제스트 건수: 점수 >= DIGEST_MIN_SCORE 인 글 수를 [DIGEST_MIN_SIZE, DIGEST_SIZE]로 클램프
  DIGEST_SIZE: 4,
  DIGEST_MIN_SIZE: 2,
  DIGEST_MIN_SCORE: 70,
  ARTICLE_TTL_DAYS: 30,
} as const;
