import { computeSlotCounts, rankAndSplit, type Rankable } from '../src/domain/scoring';

describe('computeSlotCounts', () => {
  it('70/30 분배 (size 10, ratio 0.3)', () => {
    expect(computeSlotCounts(10, 0.3)).toEqual({ exploit: 7, explore: 3 });
  });

  it('size 8, ratio 0.3 → 반올림', () => {
    // 8*0.3 = 2.4 → 2
    expect(computeSlotCounts(8, 0.3)).toEqual({ exploit: 6, explore: 2 });
  });

  it('ratio>0이면 탐험 최소 1개 보장 (size 3, ratio 0.1)', () => {
    // 3*0.1 = 0.3 → 0, 하지만 최소 1
    expect(computeSlotCounts(3, 0.1)).toEqual({ exploit: 2, explore: 1 });
  });

  it('ratio 0이면 전부 활용', () => {
    expect(computeSlotCounts(5, 0)).toEqual({ exploit: 5, explore: 0 });
  });

  it('size 0', () => {
    expect(computeSlotCounts(0, 0.3)).toEqual({ exploit: 0, explore: 0 });
  });

  it('활용 최소 1개는 남긴다 (size 2, ratio 0.9)', () => {
    expect(computeSlotCounts(2, 0.9)).toEqual({ exploit: 1, explore: 1 });
  });
});

describe('rankAndSplit', () => {
  const make = (id: string, site: string, score: number, isNovel = false): Rankable => ({
    articleId: id,
    siteId: site,
    score,
    isNovel,
  });

  it('exploit은 최고점수, 결과는 size를 넘지 않는다', () => {
    const arts = [
      make('a', 's1', 90),
      make('b', 's1', 80),
      make('c', 's2', 70),
      make('d', 's3', 60),
      make('e', 's4', 50),
    ];
    const ranked = rankAndSplit(arts, 0.3, 4);
    expect(ranked.length).toBe(4);
    const exploit = ranked.filter((r) => r.slot === 'exploit');
    const explore = ranked.filter((r) => r.slot === 'explore');
    // 4*0.3=1.2→1 탐험, 3 활용
    expect(exploit.length).toBe(3);
    expect(explore.length).toBe(1);
    // 활용 최상위는 90점
    expect(exploit[0].item.articleId).toBe('a');
  });

  it('탐험 슬롯은 novel을 우선한다', () => {
    const arts = [
      make('a', 's1', 95),
      make('b', 's1', 90),
      make('c', 's2', 30, true), // 낮은 점수지만 novel
      make('d', 's3', 85),
    ];
    const ranked = rankAndSplit(arts, 0.5, 2);
    const explore = ranked.find((r) => r.slot === 'explore');
    expect(explore?.item.articleId).toBe('c');
  });

  it('articleId 중복 제거', () => {
    const arts = [make('dup', 's1', 90), make('dup', 's1', 90), make('b', 's2', 50)];
    const ranked = rankAndSplit(arts, 0.3, 5);
    const ids = ranked.map((r) => r.item.articleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('빈 입력', () => {
    expect(rankAndSplit([], 0.3, 5)).toEqual([]);
  });
});
