/**
 * 배포 후 1회 실행: 시드 소스 + 초기 Profile 적재.
 *
 * 실행:
 *   AWS_REGION=ap-northeast-2 \
 *   SOURCES_TABLE=<name> PROFILE_TABLE=<name> \
 *   npm run seed
 *
 * 테이블 이름은 `cdk deploy`의 CfnOutput(SourcesTableName/ProfileTableName)에서 확인.
 *
 * 재실행 안전: 소스는 `putSourceIfNew`라 이미 있으면 건드리지 않는다
 * (피드백으로 쌓인 weight/likeCount 보존). 새 소스를 추가하고 싶으면
 * 아래 목록에 넣고 다시 돌리면 된다. Profile은 없을 때만 넣는다.
 */
import { putSourceIfNew, putProfile, getProfile, hashDomain } from '../src/lib/dynamo';
import { resolveFeedUrl } from '../src/lib/collectors';
import { DEFAULTS } from '../src/lib/constants';
import type { Source, Profile, SourceType } from '../src/lib/types';

const SOURCES_TABLE = process.env.SOURCES_TABLE;
const PROFILE_TABLE = process.env.PROFILE_TABLE;

function source(
  domain: string,
  name: string,
  category: Source['category'],
  feedUrl: string,
  weight = 1.0,
  type: SourceType = 'blog'
): Source {
  return {
    siteId: hashDomain(domain),
    domain,
    name,
    category,
    type,
    feedUrl,
    weight,
    likeCount: 0,
    skipCount: 0,
    status: 'active',
    discoveredAt: new Date().toISOString(),
    discoverySource: 'seed',
  };
}

/**
 * YouTube 채널: domain은 채널별로 달라야 siteId(=가중치 단위)가 분리된다.
 * `add-source` CLI와 같은 형식(`youtube.com/channel/<id>`)이어야 같은 채널이 중복 등록되지 않는다.
 */
function youtube(
  channelId: string,
  name: string,
  category: Source['category'],
  weight = 0.8
): Source {
  return source(`youtube.com/channel/${channelId}`, name, category, channelId, weight, 'youtube');
}

/** Reddit 서브레딧. feedUrl은 `r/<sub>`만 주면 collectors가 .rss URL로 정규화한다. */
function reddit(
  sub: string,
  name: string,
  category: Source['category'],
  weight = 0.8
): Source {
  return source(`reddit.com/r/${sub}`, name, category, `r/${sub}`, weight, 'reddit');
}

const SEED_SOURCES: Source[] = [
  // ---- 블로그(RSS) ----
  source('aws.amazon.com', 'AWS Architecture Blog', 'cloud', 'https://aws.amazon.com/blogs/architecture/feed/', 1.0),
  source('techblog.woowahan.com', '우아한형제들 기술블로그', 'dev-ai', 'https://techblog.woowahan.com/feed/', 1.0),
  source('toss.tech', '토스 기술블로그', 'dev-ai', 'https://toss.tech/rss.xml', 1.0),

  // ---- YouTube (채널 ID는 2026-09-06 확인) ----
  youtube('UCsBjURrPoezykLs9EqgamOA', 'Fireship', 'dev-ai'), // @fireship
  youtube('UCbfYPyITQ-7l4upoX8nvctg', 'Two Minute Papers', 'dev-ai'), // @TwoMinutePapers
  youtube('UCUpJs89fSBXNolQGOYKn0YQ', '노마드 코더', 'dev-ai'), // @nomadcoders
  youtube('UCd6MoB9NC6uYN2grvUNT-Zg', 'Amazon Web Services', 'cloud'), // @amazonwebservices

  // ---- Reddit ----
  reddit('programming', 'r/programming', 'dev-ai'),
  reddit('LocalLLaMA', 'r/LocalLLaMA', 'dev-ai'),
  reddit('MachineLearning', 'r/MachineLearning', 'dev-ai'),
  reddit('aws', 'r/aws', 'cloud'),
  reddit('devops', 'r/devops', 'cloud'),
  reddit('solotravel', 'r/solotravel', 'travel'),

  // ---- 학습 트랙 연계 (2026-09-30, 피드 생존 확인) ----
  // cloud / backend / frontend / cicd 기본기용. 학습 레슨의 "관련 글"로도 쓰인다.
  source('kubernetes.io', 'Kubernetes Blog', 'cloud', 'https://kubernetes.io/feed.xml', 0.8),
  source('cncf.io', 'CNCF Blog', 'cloud', 'https://www.cncf.io/feed/', 0.8),
  source('jenkins.io', 'Jenkins Blog', 'cloud', 'https://www.jenkins.io/rss.xml', 0.8),
  source('nodejs.org', 'Node.js Blog', 'dev-ai', 'https://nodejs.org/en/feed/blog.xml', 0.8),
  source('langflow.org', 'Langflow Blog', 'dev-ai', 'https://www.langflow.org/blog/rss.xml', 0.8),
  source('react.dev', 'React Blog', 'dev-ai', 'https://react.dev/rss.xml', 0.8),
  source('web.dev', 'web.dev', 'dev-ai', 'https://web.dev/feed.xml', 0.8),
  reddit('kubernetes', 'r/kubernetes', 'cloud'),
  reddit('node', 'r/node', 'dev-ai'),
  reddit('reactjs', 'r/reactjs', 'dev-ai'),
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

/**
 * 기존 Profile에도 넣을 관심사 — 없는 키만 추가한다 (학습된 가중치는 건드리지 않음).
 * 학습 트랙 주제의 글이 큐레이션 점수에서 밀리지 않게 한다.
 */
const INTEREST_ADDITIONS: Record<string, number> = {
  Kubernetes: 1.0,
  Jenkins: 1.0,
  'CI/CD': 1.0,
  'Node.js': 1.0,
  Langflow: 1.0,
  프론트엔드: 1.0,
};

async function main() {
  if (!SOURCES_TABLE || !PROFILE_TABLE) {
    throw new Error('환경변수 SOURCES_TABLE, PROFILE_TABLE 필요');
  }

  let added = 0;
  for (const s of SEED_SOURCES) {
    // 저장 전에 feedUrl이 실제로 해석되는지 확인 (오타를 배포 후가 아니라 여기서 잡는다)
    resolveFeedUrl(s);
    const isNew = await putSourceIfNew(SOURCES_TABLE, s);
    if (isNew) added++;
    console.log(`${isNew ? '✔ 추가' : '· 이미 있음'}: [${s.type}] ${s.name} (${s.siteId})`);
  }

  const existingProfile = await getProfile(PROFILE_TABLE);
  if (existingProfile) {
    const missing = Object.keys(INTEREST_ADDITIONS).filter((k) => !(k in existingProfile.interests));
    if (missing.length > 0) {
      const interests = { ...existingProfile.interests };
      for (const k of missing) interests[k] = INTEREST_ADDITIONS[k];
      await putProfile(PROFILE_TABLE, { ...existingProfile, interests, updatedAt: new Date().toISOString() });
      console.log(`✔ Profile 관심사 추가: ${missing.join(', ')} (기존 가중치 유지)`);
    } else {
      console.log('· Profile 이미 있음 → 유지 (관심사 학습 결과 보존)');
    }
  } else {
    await putProfile(PROFILE_TABLE, {
      ...SEED_PROFILE,
      interests: { ...SEED_PROFILE.interests, ...INTEREST_ADDITIONS },
    });
    console.log('✔ profile seeded');
  }

  console.log(`완료. 신규 소스 ${added}건 / 전체 ${SEED_SOURCES.length}건.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
