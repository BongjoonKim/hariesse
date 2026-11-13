/**
 * 일회성 운영 스크립트 (2026-11-13): "TOEFL Writing" DB에서 옛 `교정` 칸이 채워진 행의 `문장`을 교정 문장으로 바꾸고 `교정`을 비운다.
 * 코드가 `교정` 칸을 더 이상 읽지도 쓰지도 않게 되면서(고친 문장은 `문장`에 덮어씀) 기존 행도 같은 모양으로 맞춘다.
 *
 *   NOTION_TOKEN=... WRITING_DB=205a87eb3c20434b896d33213d051501 npx ts-node scripts/migrate-writing-corrections.ts [--apply]
 *
 * 기본은 dry-run(바꿀 내용만 출력). `--apply`를 줘야 Notion에 쓴다. `문장`·`키`·`교정`만 PATCH한다.
 */
import { notionFetch, queryDatabase, plain, type NotionPage } from '../src/lib/notion-vocab';
import { WRITING_PROP, buildWritingProperties } from '../src/lib/notion-writing';
import { normalizeWritingKey, compactPageId } from '../src/domain/writing';

const LEGACY_CORRECTED_PROP = '교정';

async function main(): Promise<void> {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.WRITING_DB;
  if (!token || !databaseId) throw new Error('NOTION_TOKEN, WRITING_DB 환경변수가 필요하다');
  const apply = process.argv.includes('--apply');

  const rows = await queryDatabase(
    token,
    databaseId,
    { property: LEGACY_CORRECTED_PROP, rich_text: { is_not_empty: true } },
    [{ timestamp: 'created_time', direction: 'ascending' }],
    500,
    (page: NotionPage) => ({
      pageId: compactPageId(page.id),
      text: plain(page.properties?.[WRITING_PROP.text], 'title'),
      corrected: plain(page.properties?.[LEGACY_CORRECTED_PROP], 'rich_text'),
    })
  );
  console.log(`${LEGACY_CORRECTED_PROP}이 채워진 행: ${rows.length}건 (${apply ? 'APPLY' : 'dry-run'})`);

  let changed = 0;
  for (const row of rows) {
    const same = row.corrected === row.text;
    console.log(`${same ? '= ' : '→ '}"${row.text}"${same ? '' : `\n   → "${row.corrected}"`}`);
    if (!apply) continue;
    const properties = {
      ...buildWritingProperties(same ? {} : { text: row.corrected, key: normalizeWritingKey(row.corrected) }),
      [LEGACY_CORRECTED_PROP]: { rich_text: [] },
    };
    await notionFetch(token, `/pages/${row.pageId}`, 'PATCH', { properties });
    changed++;
  }
  if (apply) console.log(`완료: ${changed}건 갱신`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
