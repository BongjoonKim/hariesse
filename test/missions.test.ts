import {
  buildMissions,
  summarize,
  computeStreak,
  lastDays,
  normalizeSettings,
  emptyDay,
  DEFAULT_SETTINGS,
  type DayStats,
} from '../src/domain/missions';

const stats = (s: Partial<DayStats> = {}): DayStats => ({ vocabDue: 0, vocabReviewedToday: 0, addedToday: 0, writingAvailable: 70, ...s });
const day = (d: Partial<ReturnType<typeof emptyDay>> = {}) => ({ ...emptyDay('2026-11-22'), ...d });
const byId = (ms: ReturnType<typeof buildMissions>) => Object.fromEntries(ms.map((m) => [m.id, m]));

describe('buildMissions', () => {
  it('기본 설정이면 5개 미션', () => {
    const ms = buildMissions(DEFAULT_SETTINGS, day(), stats({ vocabDue: 4 }));
    expect(ms.map((m) => m.id)).toEqual(['vocab', 'writing', 'add', 'tech', 'book']);
  });

  it('단어 복습 목표는 차례인 것까지만 (상한 = vocabGoal)', () => {
    expect(byId(buildMissions(DEFAULT_SETTINGS, day(), stats({ vocabDue: 4 }))).vocab).toMatchObject({ goal: 4, done: 0, complete: false });
    expect(byId(buildMissions(DEFAULT_SETTINGS, day(), stats({ vocabDue: 25 }))).vocab.goal).toBe(10);
  });

  it('복습한 만큼 진행되고, 한 것 + 남은 것이 목표를 정한다', () => {
    const m = byId(buildMissions(DEFAULT_SETTINGS, day(), stats({ vocabDue: 1, vocabReviewedToday: 3 }))).vocab;
    expect(m).toMatchObject({ goal: 4, done: 3, complete: false });
    const done = byId(buildMissions(DEFAULT_SETTINGS, day(), stats({ vocabDue: 20, vocabReviewedToday: 12 }))).vocab;
    expect(done).toMatchObject({ goal: 10, done: 10, complete: true });
    expect(done.hint).toContain('20개 더');
  });

  it('복습할 게 없으면 목표 0으로 이미 끝난 미션', () => {
    expect(byId(buildMissions(DEFAULT_SETTINGS, day(), stats())).vocab).toMatchObject({ goal: 0, complete: true });
  });

  it('Writing은 웹에서 써 본 문장만 세고, 문장 수보다 큰 목표는 줄인다', () => {
    const m = byId(buildMissions(DEFAULT_SETTINGS, day({ writingIds: ['a', 'b'] }), stats({ writingAvailable: 3 }))).writing;
    expect(m).toMatchObject({ goal: 3, done: 2, complete: false });
  });

  it('목표 0 / bookEnabled=false 인 미션은 빠진다', () => {
    const s = normalizeSettings({ techGoal: 0, addGoal: 0, bookEnabled: false });
    expect(buildMissions(s, day(), stats()).map((m) => m.id)).toEqual(['vocab', 'writing']);
  });

  it('책·기술 글 체크인', () => {
    const m = byId(buildMissions({ ...DEFAULT_SETTINGS, bookTitle: '클린 아키텍처' }, day({ techIds: ['x'], book: { done: true } }), stats()));
    expect(m.tech.complete).toBe(true);
    expect(m.book).toMatchObject({ complete: true, hint: '클린 아키텍처 · 20분' });
  });
});

describe('summarize', () => {
  it('전부 끝나야 하루 완료', () => {
    const all = buildMissions(DEFAULT_SETTINGS, day({ writingIds: ['1', '2', '3', '4', '5'], techIds: ['x'], book: { done: true } }), stats({ addedToday: 3 }));
    expect(summarize(all)).toEqual({ done: 5, total: 5, complete: true });
    const some = buildMissions(DEFAULT_SETTINGS, day(), stats({ vocabDue: 2 }));
    expect(summarize(some)).toMatchObject({ done: 0, complete: false });
  });
  it('미션이 하나도 없으면 완료가 아니다', () => {
    expect(summarize([])).toEqual({ done: 0, total: 0, complete: false });
  });
});

describe('computeStreak', () => {
  it('오늘을 끝냈으면 오늘 포함', () => {
    expect(computeStreak(['2026-11-20', '2026-11-21', '2026-11-22'], '2026-11-22')).toEqual({ current: 3, best: 3, todayDone: true });
  });
  it('오늘을 아직 안 했어도 어제까지의 연속은 살아 있다', () => {
    expect(computeStreak(['2026-11-20', '2026-11-21'], '2026-11-22')).toMatchObject({ current: 2, todayDone: false });
  });
  it('어제를 빼먹었으면 0', () => {
    expect(computeStreak(['2026-11-19', '2026-11-20'], '2026-11-22')).toMatchObject({ current: 0, best: 2 });
  });
  it('최고 기록은 지난 연속까지 본다 (월 경계 포함)', () => {
    const dates = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-22'];
    expect(computeStreak(dates, '2026-11-22')).toEqual({ current: 1, best: 4, todayDone: true });
  });
  it('기록이 없으면 0', () => {
    expect(computeStreak([], '2026-11-22')).toEqual({ current: 0, best: 0, todayDone: false });
  });
});

describe('normalizeSettings / lastDays', () => {
  it('숫자는 0~50으로 자르고 모르는 값은 기본값', () => {
    const s = normalizeSettings({ vocabGoal: 999, writingGoal: -3, addGoal: '7', techGoal: 'abc', bookTitle: '  책  ', bookTarget: '' });
    expect(s).toMatchObject({ vocabGoal: 50, writingGoal: 0, addGoal: 7, techGoal: 1, bookTitle: '책', bookTarget: undefined, bookEnabled: true });
  });
  it('본문에 없는 키는 기존 설정을 유지', () => {
    const base = { ...DEFAULT_SETTINGS, bookTitle: 'A', vocabGoal: 20 };
    expect(normalizeSettings({ addGoal: 1 }, base)).toMatchObject({ bookTitle: 'A', vocabGoal: 20, addGoal: 1 });
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it('lastDays는 오래된 날부터 today까지', () => {
    expect(lastDays('2026-11-02', 4)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
});
