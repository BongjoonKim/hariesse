/**
 * 큐레이션 도메인 로직 — 순수함수, 단위테스트 대상.
 * 탐험(explore) vs 활용(exploit) 분배로 에코챔버를 피한다 (스펙 설계원칙 1).
 */
import type { Slot } from '../lib/types';

export interface Rankable {
  articleId: string;
  siteId: string;
  score: number; // 0~100
  /** 탐험 후보 신호: 신규/낯선 사이트(candidate), 미노출 도메인 등 */
  isNovel?: boolean;
}

export interface Ranked<T> {
  item: T;
  slot: Slot;
}

/**
 * 다이제스트 슬롯 수를 활용/탐험으로 나눈다.
 * explore = round(size * ratio), exploit = 나머지. 최소 1개씩 보장(size>=2, ratio>0).
 */
export function computeSlotCounts(
  size: number,
  ratio: number
): { exploit: number; explore: number } {
  const clampedSize = Math.max(0, Math.floor(size));
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  if (clampedSize === 0) return { exploit: 0, explore: 0 };

  let explore = Math.round(clampedSize * clampedRatio);
  // ratio가 0보다 크면 탐험 최소 1개, 단 활용도 최소 1개는 남긴다.
  if (clampedRatio > 0 && explore === 0 && clampedSize >= 2) explore = 1;
  if (explore >= clampedSize && clampedSize >= 2) explore = clampedSize - 1;
  return { exploit: clampedSize - explore, explore };
}

/**
 * 입력 순서(우선순위)를 보존하며 사이트 다양성을 적용해 count개 선택.
 * caller가 우선순위대로 정렬해 넘기면, 같은 siteId 반복을 1차로 회피하고 부족분을 채운다.
 */
function pickDiverse<T extends Rankable>(ordered: T[], count: number): T[] {
  const seenSites = new Set<string>();
  const picked: T[] = [];
  // 1차: 우선순위 순서로 돌며 새로운 사이트 우선
  for (const c of ordered) {
    if (picked.length >= count) break;
    if (!seenSites.has(c.siteId)) {
      picked.push(c);
      seenSites.add(c.siteId);
    }
  }
  // 2차: 부족하면 우선순위 순서로 나머지 채움
  if (picked.length < count) {
    for (const c of ordered) {
      if (picked.length >= count) break;
      if (!picked.includes(c)) picked.push(c);
    }
  }
  return picked;
}

/**
 * 점수 정렬 후 활용/탐험 비율로 top N 선정. 각 항목에 slot을 부여.
 * - exploit: 점수 최상위
 * - explore: 나머지 중 isNovel 우선 + 사이트 다양성
 */
export function rankAndSplit<T extends Rankable>(
  articles: T[],
  ratio: number,
  size: number
): Ranked<T>[] {
  if (articles.length === 0) return [];

  // articleId 기준 dedup
  const unique = Array.from(new Map(articles.map((a) => [a.articleId, a])).values());
  const { exploit, explore } = computeSlotCounts(Math.min(size, unique.length), ratio);

  const byScore = [...unique].sort((a, b) => b.score - a.score);
  const exploitPicks = byScore.slice(0, exploit);
  const exploitIds = new Set(exploitPicks.map((a) => a.articleId));

  const remaining = byScore.filter((a) => !exploitIds.has(a.articleId));
  const novel = remaining.filter((a) => a.isNovel);
  const rest = remaining.filter((a) => !a.isNovel);

  // remaining은 이미 점수 내림차순 → novel/rest 모두 점수 순서 보존됨
  const explorePicks = pickDiverse([...novel, ...rest], explore);

  return [
    ...exploitPicks.map((item) => ({ item, slot: 'exploit' as Slot })),
    ...explorePicks.map((item) => ({ item, slot: 'explore' as Slot })),
  ];
}
