/**
 * Notion → DynamoDB 미러 동기화의 비교 로직 (순수함수, 테스트 대상).
 * Notion이 원본이고 미러는 웹이 한 번에 읽기 위한 사본이다 — 동기화는 Notion에 있는 그대로 맞춘다.
 */

/** 키 순서·undefined에 흔들리지 않는 직렬화 (DynamoDB는 undefined를 저장하지 않는다). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface MirrorDiff<T> {
  /** 새로 생겼거나 내용이 바뀐 행 */
  puts: T[];
  /** Notion에서 사라진(삭제·휴지통) 행의 page id */
  deletes: string[];
}

/**
 * 미러(current)를 Notion(fresh)에 맞추려면 무엇을 쓰고 지워야 하는지.
 * Notion이 한 건도 안 줬는데 미러에 행이 있으면 지우지 않는다 — 연동이 끊겼을 때 미러를 통째로 비우지 않기 위한 안전장치.
 */
export function diffMirror<T extends { pageId: string }>(current: T[], fresh: T[]): MirrorDiff<T> {
  const before = new Map(current.map((e) => [e.pageId, stableStringify(e)]));
  const puts = fresh.filter((e) => before.get(e.pageId) !== stableStringify(e));
  if (fresh.length === 0 && current.length > 0) return { puts, deletes: [] };
  const alive = new Set(fresh.map((e) => e.pageId));
  return { puts, deletes: current.filter((e) => !alive.has(e.pageId)).map((e) => e.pageId) };
}
