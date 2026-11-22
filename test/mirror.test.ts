import { diffMirror, stableStringify } from '../src/domain/mirror';

const row = (pageId: string, extra: Record<string, unknown> = {}) => ({ pageId, text: pageId, ...extra });

describe('stableStringify', () => {
  it('키 순서와 undefined에 흔들리지 않는다', () => {
    expect(stableStringify({ b: 1, a: [{ y: undefined, x: 2 }] })).toBe(stableStringify({ a: [{ x: 2 }], b: 1, c: undefined }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('diffMirror', () => {
  it('새 행·바뀐 행만 쓰고 사라진 행은 지운다', () => {
    const current = [row('a'), row('b', { box: 1 }), row('c')];
    const fresh = [row('a'), row('b', { box: 2 }), row('d')];
    const d = diffMirror(current, fresh);
    expect(d.puts.map((e) => e.pageId)).toEqual(['b', 'd']);
    expect(d.deletes).toEqual(['c']);
  });
  it('같으면 아무것도 안 한다 (DynamoDB에서 읽은 행엔 undefined 키가 없다)', () => {
    const d = diffMirror([row('a', { tags: [] })], [row('a', { tags: [], note: undefined })]);
    expect(d).toEqual({ puts: [], deletes: [] });
  });
  it('Notion이 0건이면 지우지 않는다 (연동이 끊겼을 때 미러 보호)', () => {
    expect(diffMirror([row('a'), row('b')], [])).toEqual({ puts: [], deletes: [] });
  });
});
