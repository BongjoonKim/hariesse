/**
 * 배포 후 1회 실행: 시드 소스 + 초기 Profile 적재.
 *
 * 실행:
 *   AWS_REGION=ap-northeast-2 \
 *   SOURCES_TABLE=<name> PROFILE_TABLE=<name> \
 *   npm run seed
 *
 * 시드 세트: 환경변수 SEED_SET (기본 `default` = 내 것: 여행/개발·AI/클라우드).
 *   SEED_SET=design → 디자인 배포(stage=design)용 UX/UI·그래픽·브랜드 소스 + 디자인 Profile.
 *   SEED_SET=space  → 같은 디자인 배포를 공간 디자이너용으로: 공간·건축·가구·공간 브랜딩 소스 + 공간 Profile.
 *   `--set <name>` 인자로도 고를 수 있다(환경변수보다 우선, Windows에서도 동작).
 *   세트를 잘못 고르면 다른 사람 테이블에 엉뚱한 소스가 들어가니, SOURCES_TABLE이 어느 stage 것인지 확인할 것.
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
// `--set <name>`이 환경변수보다 우선 — Windows(cmd)에서는 `SEED_SET=x cmd` 형태의 npm 스크립트가 안 돈다.
const setArgIdx = process.argv.indexOf('--set');
const SEED_SET = ((setArgIdx >= 0 ? process.argv[setArgIdx + 1] : undefined) ?? process.env.SEED_SET ?? 'default').trim();

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

const DEFAULT_SOURCES: Source[] = [
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

const DEFAULT_PROFILE: Profile = {
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
const DEFAULT_INTEREST_ADDITIONS: Record<string, number> = {
  Kubernetes: 1.0,
  Jenkins: 1.0,
  'CI/CD': 1.0,
  'Node.js': 1.0,
  Langflow: 1.0,
  프론트엔드: 1.0,
};

// ======================================================================
// 디자인 세트 (stage=design) — 피드 생존은 2026-10-04 확인. 카테고리는 전부 'design'.
// 소스를 더 넣으려면 여기 추가하거나 `npm run add-source -- --category design ...`.
// ======================================================================
const DESIGN_SOURCES: Source[] = [
  // ---- 블로그(RSS) ----
  source('smashingmagazine.com', 'Smashing Magazine', 'design', 'https://www.smashingmagazine.com/feed/', 1.0),
  source('nngroup.com', 'Nielsen Norman Group', 'design', 'https://www.nngroup.com/feed/rss/', 1.0),
  source('uxdesign.cc', 'UX Collective', 'design', 'https://uxdesign.cc/feed', 1.0),
  source('alistapart.com', 'A List Apart', 'design', 'https://alistapart.com/main/feed/', 0.8),
  source('medium.com/google-design', 'Google Design', 'design', 'https://medium.com/feed/google-design', 0.8),
  source('creativebloq.com', 'Creative Bloq', 'design', 'https://www.creativebloq.com/feed', 0.8),
  source('designweek.co.uk', 'Design Week', 'design', 'https://www.designweek.co.uk/feed/', 0.8),
  source('designboom.com', 'designboom', 'design', 'https://www.designboom.com/feed/', 0.8),
  source('brand.design', 'Brand.Design', 'design', 'https://brand.design/feed', 0.8),
  source('story.pxd.co.kr', 'pxd story (한국어 UX)', 'design', 'https://story.pxd.co.kr/rss', 1.0),

  // ---- YouTube (채널 ID는 2026-10-04 확인) ----
  youtube('UCQsVmhSa4X-G3lHlUtejzLA', 'Figma', 'design', 1.0), // @figma
  youtube('UC-b3c7kxa5vU-bnmaROgvog', 'The Futur', 'design'), // @TheFutur
  youtube('UCN7dywl5wDxTu1RM3eJ_h9Q', 'Flux Academy', 'design'), // @FluxAcademy
  youtube('UCVyRiMvfUNMA1UPlDPzG5Ow', 'DesignCourse', 'design'), // @DesignCourse
  youtube('UCZJkZy008cQjqkJeKpJu8tA', 'Mizko', 'design'), // @mizko
  youtube('UCvBGFeXbBrq3W9_0oNLJREQ', 'Jesse Showalter', 'design'), // @JesseShowalter
  youtube('UCeyR48P2g1N8Ln6m1VjBd3g', 'Dribbble', 'design'), // @Dribbble
  youtube('UCvYnDMeL-PFZhfIz6oc_U-Q', '디자인베이스', 'design', 1.0), // @designbase

  // ---- Reddit ----
  reddit('UI_Design', 'r/UI_Design', 'design'),
  reddit('userexperience', 'r/userexperience', 'design'),
  reddit('web_design', 'r/web_design', 'design'),
  reddit('graphic_design', 'r/graphic_design', 'design'),
];

const DESIGN_PROFILE: Profile = {
  pk: 'PROFILE',
  interests: {
    'UX/UI': 1.0,
    Figma: 1.0,
    타이포그래피: 1.0,
    브랜딩: 1.0,
    '디자인 시스템': 1.0,
    포트폴리오: 0.8,
  },
  explorationRatio: DEFAULTS.EXPLORATION_RATIO,
  updatedAt: new Date().toISOString(),
};

interface SeedSet {
  sources: Source[];
  profile: Profile;
  interestAdditions: Record<string, number>;
}

// ======================================================================
// 공간 디자인 세트 (stage=design, 공간 디자이너용) — 피드 생존은 2026-10-04 확인. 카테고리는 전부 'design'.
// 공간·건축·가구·공간 브랜딩(리테일) 위주. persona(SSM user-persona)와 함께 쓴다.
// ======================================================================
const SPACE_SOURCES: Source[] = [
  // ---- 블로그(RSS) ----
  source('dezeen.com', 'Dezeen', 'design', 'https://www.dezeen.com/feed/', 1.0),
  source('archdaily.com', 'ArchDaily', 'design', 'https://www.archdaily.com/feed', 1.0),
  source('designboom.com', 'designboom', 'design', 'https://www.designboom.com/feed/', 1.0),
  source('retaildesignblog.net', 'Retail Design Blog', 'design', 'https://retaildesignblog.net/feed/', 1.0),
  source('design.co.kr', '월간 디자인', 'design', 'https://design.co.kr/feed/', 1.0),
  source('wallpaper.com', 'Wallpaper*', 'design', 'https://www.wallpaper.com/feeds/all', 0.8),
  source('architecturaldigest.com', 'Architectural Digest', 'design', 'https://www.architecturaldigest.com/feed/rss', 0.8),
  source('architizer.com', 'Architizer Journal', 'design', 'https://architizer.com/blog/feed/', 0.8),
  source('design-milk.com', 'Design Milk', 'design', 'https://design-milk.com/feed/', 0.8),
  source('leibal.com', 'Leibal', 'design', 'https://leibal.com/feed/', 0.8),
  source('yankodesign.com', 'Yanko Design', 'design', 'https://www.yankodesign.com/feed/', 0.8),

  // ---- YouTube (채널 ID는 2026-10-04 확인) ----
  youtube('UCsWG9ANbrmgR0z-eFk_A3YQ', 'Dezeen', 'design'), // @dezeen
  youtube('UC0k238zFx-Z8xFH0sxCrPJg', 'Architectural Digest', 'design'), // @Archdigest
  youtube('UC_zQ777U6YTyatP3P1wi3xw', 'NEVER TOO SMALL', 'design'), // @NeverTooSmall
  youtube('UCgxg48_pay4R67s-7WOgWFA', 'The Local Project', 'design'), // @TheLocalProject
  youtube('UCKdTgHHnrxr4idSp99Yo0fQ', 'Dwell', 'design'), // @dwell
  youtube('UCv6JHGYnS74viHnZ-6zR2Jg', 'designboom', 'design'), // @designboom
  youtube('UCYAm24PkejQR2xMgJgn7xwg', 'Stewart Hicks', 'design'), // @StewartHicks
  youtube('UC6n8I1UDTKP1IWjQMg6_TwA', 'The B1M', 'design'), // @TheB1M

  // ---- Reddit ----
  reddit('architecture', 'r/architecture', 'design'),
  reddit('InteriorDesign', 'r/InteriorDesign', 'design'),
];

const SPACE_PROFILE: Profile = {
  pk: 'PROFILE',
  interests: {
    '공간 디자인': 1.0,
    인테리어: 1.0,
    건축: 1.0,
    '가구 디자인': 1.0,
    '공간 브랜딩': 1.0,
    '리테일 디자인': 1.0,
    '공간 마케팅': 0.8,
  },
  explorationRatio: DEFAULTS.EXPLORATION_RATIO,
  updatedAt: new Date().toISOString(),
};

const SEED_SETS: Record<string, SeedSet> = {
  default: { sources: DEFAULT_SOURCES, profile: DEFAULT_PROFILE, interestAdditions: DEFAULT_INTEREST_ADDITIONS },
  design: { sources: DESIGN_SOURCES, profile: DESIGN_PROFILE, interestAdditions: {} },
  space: { sources: SPACE_SOURCES, profile: SPACE_PROFILE, interestAdditions: {} },
};

async function main() {
  if (!SOURCES_TABLE || !PROFILE_TABLE) {
    throw new Error('환경변수 SOURCES_TABLE, PROFILE_TABLE 필요');
  }
  const set = SEED_SETS[SEED_SET];
  if (!set) throw new Error(`SEED_SET은 ${Object.keys(SEED_SETS).join(' | ')} 중 하나 (받음: ${SEED_SET})`);
  const { sources: SEED_SOURCES, profile: SEED_PROFILE, interestAdditions: INTEREST_ADDITIONS } = set;
  console.log(`시드 세트: ${SEED_SET} (소스 ${SEED_SOURCES.length}건) → ${SOURCES_TABLE}`);

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
