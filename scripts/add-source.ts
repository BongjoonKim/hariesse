/**
 * 소스 1건 추가 CLI — YouTube 채널 / Reddit 서브레딧 / 블로그 RSS.
 *
 * 실행 예:
 *   AWS_REGION=ap-northeast-2 SOURCES_TABLE=<name> \
 *     npm run add-source -- --type youtube --url @ThePrimeagen --category dev-ai
 *   ... npm run add-source -- --type reddit --url r/rust --category dev-ai
 *   ... npm run add-source -- --type blog --url https://blog.example.com/feed --name "예시" --category cloud
 *
 * 옵션: --weight <0.1~3.0, 기본 0.8>  --dry-run (저장 없이 검증만)
 *
 * YouTube `@handle`은 채널 ID(UC...)로 자동 변환한다(핸들은 바뀔 수 있어 ID로 저장).
 * 저장 전에 실제 피드를 1회 받아 살아있는지 확인하고, 이름을 안 주면 피드 제목을 쓴다.
 */
import { putSourceIfNew, hashDomain } from '../src/lib/dynamo';
import { resolveFeedUrl } from '../src/lib/collectors';
import type { Category, Source, SourceType } from '../src/lib/types';

const SOURCES_TABLE = process.env.SOURCES_TABLE;
const UA = 'HariesseBot/0.1 (+personal curation agent)';
const TYPES: SourceType[] = ['blog', 'youtube', 'reddit'];
const CATEGORIES: Category[] = ['travel', 'dev-ai', 'cloud'];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

/** `@handle` / 채널 URL → 채널 ID(UC...). 이미 ID면 그대로. */
async function resolveYoutubeChannelId(input: string): Promise<string> {
  const direct = input.match(/(?:channel_id=|channel\/)(UC[\w-]{20,24})/) ?? input.match(/^(UC[\w-]{20,24})$/);
  if (direct) return direct[1];

  const handle = input.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^@/, '').split('/')[0];
  if (!handle) throw new Error(`YouTube 채널을 알 수 없음: ${input}`);
  const html = await fetchText(`https://www.youtube.com/@${handle}`);
  const found = html.match(/channel_id=(UC[\w-]{20,24})/) ?? html.match(/"channelId":"(UC[\w-]{20,24})"/);
  if (!found) throw new Error(`@${handle}의 채널 ID를 찾지 못함 (핸들 확인 필요)`);
  return found[1];
}

/** 피드 XML의 채널/사이트 제목. */
function feedTitle(xml: string): string | undefined {
  const m = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() || undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === 'true';
  const type = (args.type ?? 'blog') as SourceType;
  const url = args.url;
  const category = args.category as Category;
  const weight = Number(args.weight ?? 0.8);

  if (!TYPES.includes(type)) throw new Error(`--type은 ${TYPES.join(' | ')} 중 하나`);
  if (!url) throw new Error('--url 필요 (YouTube: @handle 또는 채널 ID / Reddit: r/<sub> / blog: RSS URL)');
  if (!CATEGORIES.includes(category)) throw new Error(`--category는 ${CATEGORIES.join(' | ')} 중 하나`);
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('--weight는 양수');
  if (!dryRun && !SOURCES_TABLE) throw new Error('환경변수 SOURCES_TABLE 필요 (--dry-run이면 불필요)');

  // 타입별로 domain(=siteId 기준)과 feedUrl을 정한다.
  let domain: string;
  let feedUrl: string;
  if (type === 'youtube') {
    const channelId = await resolveYoutubeChannelId(url);
    domain = `youtube.com/channel/${channelId}`;
    feedUrl = channelId;
  } else if (type === 'reddit') {
    const sub = url.match(/(?:^|reddit\.com\/)r\/([A-Za-z0-9_]+)/)?.[1];
    if (!sub) throw new Error(`서브레딧을 알 수 없음: ${url} (r/<sub> 형태)`);
    domain = `reddit.com/r/${sub}`;
    feedUrl = `r/${sub}`;
  } else {
    domain = new URL(url).hostname;
    feedUrl = url;
  }

  const draft: Source = {
    siteId: hashDomain(domain),
    domain,
    name: args.name ?? domain,
    category,
    type,
    feedUrl,
    weight,
    likeCount: 0,
    skipCount: 0,
    status: 'active',
    discoveredAt: new Date().toISOString(),
    discoverySource: 'add-source-cli',
  };

  // 살아있는 피드인지 확인 + 이름 자동 채우기
  const resolved = resolveFeedUrl(draft);
  const xml = await fetchText(resolved);
  const title = feedTitle(xml);
  if (!args.name && title) draft.name = title;
  const itemCount = (xml.match(/<(entry|item)[\s>]/g) ?? []).length;
  console.log(`피드 확인: ${resolved}\n  제목: ${title ?? '(없음)'} / 항목 ${itemCount}건`);
  if (itemCount === 0) console.warn('⚠ 항목이 0건이다 — 피드 주소를 다시 확인할 것.');

  if (dryRun) {
    console.log('--dry-run: 저장하지 않음\n', JSON.stringify(draft, null, 2));
    return;
  }

  const isNew = await putSourceIfNew(SOURCES_TABLE!, draft);
  console.log(
    isNew
      ? `✔ 추가됨: [${type}] ${draft.name} (siteId=${draft.siteId}, weight=${weight})`
      : `· 이미 있는 소스라 유지: ${draft.name} (siteId=${draft.siteId})`
  );
}

main().catch((err) => {
  console.error(`✖ ${(err as Error).message}`);
  process.exit(1);
});
