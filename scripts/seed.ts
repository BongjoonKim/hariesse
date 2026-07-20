/**
 * 배포 후 1회 실행: 시드 소스 + 초기 Profile 적재.
 *
 * 실행:
 *   AWS_REGION=ap-northeast-2 \
 *   SOURCES_TABLE=<name> PROFILE_TABLE=<name> \
 *   npm run seed
 *
 * 테이블 이름은 `cdk deploy`의 CfnOutput(SourcesTableName/ProfileTableName)에서 확인.
 */
import { putSource, putProfile, hashDomain } from '../src/lib/dynamo';
import { DEFAULTS } from '../src/lib/constants';
import type { Source, Profile } from '../src/lib/types';

const SOURCES_TABLE = process.env.SOURCES_TABLE;
const PROFILE_TABLE = process.env.PROFILE_TABLE;

function source(
  domain: string,
  name: string,
  category: Source['category'],
  feedUrl: string,
  weight = 1.0
): Source {
  return {
    siteId: hashDomain(domain),
    domain,
    name,
    category,
    feedUrl,
    weight,
    likeCount: 0,
    skipCount: 0,
    status: 'active',
    discoveredAt: new Date().toISOString(),
    discoverySource: 'seed',
  };
}

const SEED_SOURCES: Source[] = [
  source('aws.amazon.com', 'AWS Architecture Blog', 'cloud', 'https://aws.amazon.com/blogs/architecture/feed/', 1.0),
  source('techblog.woowahan.com', '우아한형제들 기술블로그', 'dev-ai', 'https://techblog.woowahan.com/feed/', 1.0),
  source('toss.tech', '토스 기술블로그', 'dev-ai', 'https://toss.tech/rss.xml', 1.0),
];

const SEED_PROFILE: Profile = {
  pk: 'PROFILE',
  interests: {
    PQC: 1.0,
    서버리스: 1.0,
    LLM: 1.0,
    React: 1.0,
    국내여행: 1.0,
    해외여행: 1.0,
  },
  explorationRatio: DEFAULTS.EXPLORATION_RATIO,
  updatedAt: new Date().toISOString(),
};

async function main() {
  if (!SOURCES_TABLE || !PROFILE_TABLE) {
    throw new Error('환경변수 SOURCES_TABLE, PROFILE_TABLE 필요');
  }

  for (const s of SEED_SOURCES) {
    await putSource(SOURCES_TABLE, s);
    console.log(`✔ source: ${s.name} (${s.siteId})`);
  }

  await putProfile(PROFILE_TABLE, SEED_PROFILE);
  console.log('✔ profile seeded');
  console.log('완료.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
