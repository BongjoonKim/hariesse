/**
 * WebFn 핸들러 — 인증·CSRF·라우팅과 미션 계산이 실제로 이어지는지. AWS·Notion·Bedrock은 전부 가짜.
 */
import type { VocabEntry, WritingEntry } from '../src/lib/types';
import type { DayRecord } from '../src/domain/missions';
import { kstDate, addDays } from '../src/domain/vocab';

import { randomBytes } from 'crypto';

// 실행할 때 만든다 (리터럴로 두면 시크릿 스캐너가 비밀번호로 오인한다)
const PASSWORD = randomBytes(12).toString('hex');
const TODAY = kstDate();
const id = (n: number) => String(n).padStart(32, '0');

const db = {
  vocab: [] as VocabEntry[],
  writing: [] as WritingEntry[],
  days: new Map<string, DayRecord>(),
  meta: new Map<string, unknown>(),
};
const notion = { vocabUpdates: [] as unknown[], writingUpdates: [] as unknown[], archived: [] as string[] };

jest.mock('../src/lib/config', () => ({
  getConfig: async () => ({
    articlesTable: 'articles',
    profileTable: 'profile',
    bedrockModelId: 'm',
    bedrockRegion: 'r',
    vocabNotionDatabaseId: 'vdb',
    writingNotionDatabaseId: 'wdb',
  }),
  getNotionToken: async () => 'notion-token',
  getWebPassword: async () => PASSWORD,
}));
jest.mock('../src/lib/dynamo', () => ({ getLearningProgress: async () => undefined }));
jest.mock('../src/lib/bedrock', () => ({ enrichWriting: async () => ({ korean: '나는 간다.', corrected: 'I go.', note: '대문자' }) }));
jest.mock('../src/lib/vocab-capture', () => ({
  captureExpression: async (_d: unknown, input: { text: string }, today: string) => ({
    entry: { pageId: 'f'.repeat(32), text: input.text, meaning: '뜻', tags: [], box: 0, missCount: 0, createdDate: today, status: 'learning' },
    repeated: false,
  }),
}));
jest.mock('../src/lib/notion-vocab', () => ({
  getVocabPage: async (_t: string, pageId: string) => db.vocab.find((e) => e.pageId === pageId),
  updateVocabPage: async (_t: string, pageId: string, fields: unknown) => void notion.vocabUpdates.push({ pageId, fields }),
  archiveVocabPage: async (_t: string, pageId: string) => void notion.archived.push(pageId),
}));
jest.mock('../src/lib/notion-writing', () => ({
  createWritingPage: async () => 'e'.repeat(32),
  updateWritingPage: async (_t: string, pageId: string, fields: unknown) => void notion.writingUpdates.push({ pageId, fields }),
}));
jest.mock('../src/lib/study-store', () => {
  const put = <T extends { pageId: string }>(list: T[], e: T) => {
    const i = list.findIndex((x) => x.pageId === e.pageId);
    if (i === -1) list.push(e);
    else list[i] = e;
  };
  return {
    listVocab: async () => [...db.vocab],
    listWriting: async () => [...db.writing],
    getMirrorEntry: async (_t: string, kind: string, pageId: string) => (kind === 'VOCAB' ? db.vocab : db.writing).find((e) => e.pageId === pageId),
    putMirrorEntry: async (_t: string, kind: string, e: VocabEntry & WritingEntry) => put<{ pageId: string }>(kind === 'VOCAB' ? db.vocab : db.writing, e),
    deleteMirrorEntry: async (_t: string, _k: string, pageId: string) => void (db.vocab = db.vocab.filter((e) => e.pageId !== pageId)),
    syncFromNotion: async () => ({ at: 'now' }),
    getDay: async (_t: string, date: string) => db.days.get(date) ?? { date, writingIds: [], techIds: [] },
    putDay: async (_t: string, day: DayRecord) => void db.days.set(day.date, day),
    listDaysSince: async () => [...db.days.values()],
    getMeta: async (_t: string, sk: string) => db.meta.get(sk),
    putMeta: async (_t: string, sk: string, v: unknown) => void db.meta.set(sk, v),
    listDeliveredSince: async () => [],
  };
});

import { handler } from '../src/handlers/web';

type Res = { statusCode: number; body: string; cookies?: string[] };

async function call(method: string, path: string, body?: unknown, opts: { cookie?: string; csrf?: boolean } = {}) {
  const res = (await handler({
    requestContext: { http: { method } },
    rawPath: path,
    headers: opts.csrf === false ? {} : { 'x-hariesse': '1' },
    cookies: opts.cookie ? [opts.cookie] : [],
    body: body === undefined ? undefined : JSON.stringify(body),
  })) as Res;
  return { status: res.statusCode, data: JSON.parse(res.body), cookies: res.cookies };
}

async function loginCookie(): Promise<string> {
  const res = await call('POST', '/api/login', { password: PASSWORD });
  return res.cookies![0].split(';')[0];
}

const vocab = (n: number, f: Partial<VocabEntry> = {}): VocabEntry => ({
  pageId: id(n), text: `word${n}`, key: `word${n}`, meaning: `뜻${n}`, tags: [], box: 1, missCount: 0, status: 'learning', nextReview: TODAY, createdDate: addDays(TODAY, -5), ...f,
});
const sentence = (n: number, f: Partial<WritingEntry> = {}): WritingEntry => ({
  pageId: id(100 + n), text: `I wrote sentence ${n}.`, key: `i wrote sentence ${n}`, korean: `문장 ${n}`, quizCount: 0, status: 'active', createdDate: addDays(TODAY, -5), ...f,
});

beforeAll(() => {
  process.env.STUDY_TABLE = 'study';
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  db.vocab = [vocab(1), vocab(2), vocab(3, { nextReview: addDays(TODAY, 3) })];
  db.writing = [sentence(1), sentence(2)];
  db.days.clear();
  db.meta.clear();
  notion.vocabUpdates = [];
  notion.writingUpdates = [];
  notion.archived = [];
});

describe('인증', () => {
  it('세션 없이는 401, 틀린 비밀번호도 401', async () => {
    expect((await call('GET', '/api/today')).status).toBe(401);
    expect((await call('GET', '/api/library', undefined, { cookie: 'hs=v1.9999999999999.' + '0'.repeat(64) })).status).toBe(401);
    const bad = await call('POST', '/api/login', { password: 'nope' });
    expect(bad.status).toBe(401);
    expect(bad.cookies).toBeUndefined();
  });

  it('로그인하면 세션 쿠키로 API를 쓸 수 있다', async () => {
    const cookie = await loginCookie();
    expect(cookie).toMatch(/^hs=v1\.\d+\.[0-9a-f]{64}$/);
    const res = await call('GET', '/api/today', undefined, { cookie });
    expect(res.status).toBe(200);
    expect(res.data.date).toBe(TODAY);
  });

  it('5번 틀리면 맞는 비밀번호도 잠긴다', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/login', { password: 'nope' });
    expect((await call('POST', '/api/login', { password: PASSWORD })).status).toBe(429);
  });

  it('POST는 x-hariesse 헤더가 없으면 403 (CSRF)', async () => {
    const cookie = await loginCookie();
    const res = await call('POST', '/api/checkin', { kind: 'book' }, { cookie, csrf: false });
    expect(res.status).toBe(403);
  });

  it('없는 주소는 404, 깨진 본문은 400', async () => {
    const cookie = await loginCookie();
    expect((await call('GET', '/api/nope', undefined, { cookie })).status).toBe(404);
    const res = (await handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/login', body: '{oops' })) as Res;
    expect(res.statusCode).toBe(400);
  });
});

describe('오늘의 미션', () => {
  it('복습할 차례인 표현과 출제 순서를 준다', async () => {
    const cookie = await loginCookie();
    const { data } = await call('GET', '/api/today', undefined, { cookie });
    expect(data.dueIds).toEqual([id(1), id(2)]);
    expect(data.quizIds).toEqual([id(101), id(102)]);
    const m = Object.fromEntries(data.missions.map((x: { id: string }) => [x.id, x]));
    expect(m.vocab).toMatchObject({ goal: 2, done: 0 });
    expect(m.writing).toMatchObject({ goal: 2, done: 0 });
    expect(data.history).toHaveLength(126);
    expect(data.history[125].date).toBe(TODAY);
  });

  it('복습 답 → Notion 갱신 + 미션 진행', async () => {
    const cookie = await loginCookie();
    const res = await call('POST', '/api/vocab/review', { pageId: id(1), result: 'know' }, { cookie });
    expect(res.status).toBe(200);
    expect(res.data.entry).toMatchObject({ box: 2, lastReviewed: TODAY, nextReview: addDays(TODAY, 3) });
    expect(notion.vocabUpdates).toHaveLength(1);
    expect(res.data.today.dueIds).toEqual([id(2)]);
    expect(res.data.today.missions[0]).toMatchObject({ id: 'vocab', goal: 2, done: 1 });
  });

  it('차례가 아닌 표현의 "알아요"는 일정을 바꾸지 않는다, "몰라요"는 박스 1로', async () => {
    const cookie = await loginCookie();
    const know = await call('POST', '/api/vocab/review', { pageId: id(3), result: 'know' }, { cookie });
    expect(know.data.changed).toBe(false);
    expect(notion.vocabUpdates).toHaveLength(0);
    const forgot = await call('POST', '/api/vocab/review', { pageId: id(3), result: 'forgot' }, { cookie });
    expect(forgot.data.entry).toMatchObject({ box: 1, missCount: 1, nextReview: addDays(TODAY, 1) });
  });

  it('Writing을 써 보면 출제 기록이 올라가고 오늘 목록에서 빠진다', async () => {
    const cookie = await loginCookie();
    const res = await call('POST', '/api/writing/attempt', { pageId: id(101), answer: 'i wrote sentence 1' }, { cookie });
    expect(res.data.match).toBe(true);
    expect(res.data.entry).toMatchObject({ quizCount: 1, lastQuizzed: TODAY });
    expect(res.data.today.quizIds).toEqual([id(102)]);
    const wrong = await call('POST', '/api/writing/attempt', { pageId: id(102), answer: 'something else' }, { cookie });
    expect(wrong.data.match).toBe(false);
    expect(wrong.data.today.missions.find((m: { id: string }) => m.id === 'writing')).toMatchObject({ done: 2, complete: true });
  });

  it('전부 끝내면 하루 완료 + 연속 1일', async () => {
    db.vocab = [];
    db.writing = [];
    db.meta.set('settings', { vocabGoal: 10, writingGoal: 0, addGoal: 1, techGoal: 1, bookEnabled: true });
    const cookie = await loginCookie();
    await call('POST', '/api/add', { text: 'ubiquitous' }, { cookie });
    await call('POST', '/api/checkin', { kind: 'tech', id: 'article-1' }, { cookie });
    const res = await call('POST', '/api/checkin', { kind: 'book', memo: '3장까지' }, { cookie });
    expect(res.data.today.summary).toEqual({ done: 4, total: 4, complete: true });
    expect(res.data.today.streak).toMatchObject({ current: 1, todayDone: true });
    expect(db.days.get(TODAY)).toMatchObject({ complete: true, book: { done: true, memo: '3장까지' } });
  });
});

describe('등록 · 수정', () => {
  it('한국어가 섞인 줄은 거절하고 나머지는 저장', async () => {
    const cookie = await loginCookie();
    const { data } = await call('POST', '/api/add', { text: 'serendipity\n이건 뭐야 hello' }, { cookie });
    expect(data.outcomes.map((o: { ok: boolean }) => o.ok)).toEqual([true, false]);
    expect(db.vocab.some((e) => e.text === 'serendipity')).toBe(true);
  });

  it('Writing 문장은 고친 문장으로 저장하고 같은 문장은 다시 만들지 않는다', async () => {
    const cookie = await loginCookie();
    const first = await call('POST', '/api/add', { text: 'i go', target: 'writing' }, { cookie });
    expect(first.data.outcomes[0].writing).toMatchObject({ text: 'I go.', korean: '나는 간다.', status: 'active' });
    const again = await call('POST', '/api/add', { text: 'I go.', target: 'writing' }, { cookie });
    expect(again.data.outcomes[0]).toMatchObject({ ok: true, repeated: true });
  });

  it('6줄 이상은 400', async () => {
    const cookie = await loginCookie();
    expect((await call('POST', '/api/add', { text: 'a\nb\nc\nd\ne\nf' }, { cookie })).status).toBe(400);
  });

  it('뜻 수정은 넘긴 칸만 바꾸고, 같은 표현으로 바꾸면 409', async () => {
    const cookie = await loginCookie();
    const res = await call('POST', '/api/vocab/update', { pageId: id(1), fields: { meaning: ' 새 뜻 ', note: '' } }, { cookie });
    expect(res.data.entry).toMatchObject({ meaning: '새 뜻', text: 'word1' });
    expect(notion.vocabUpdates[0]).toEqual({ pageId: id(1), fields: { meaning: '새 뜻', note: undefined } });
    expect((await call('POST', '/api/vocab/update', { pageId: id(1), fields: { text: 'Word2' } }, { cookie })).status).toBe(409);
  });

  it('외움 처리 · 삭제', async () => {
    const cookie = await loginCookie();
    const res = await call('POST', '/api/vocab/update', { pageId: id(1), action: 'master' }, { cookie });
    expect(res.data.entry.status).toBe('mastered');
    expect(res.data.today.dueIds).toEqual([id(2)]);
    await call('POST', '/api/vocab/delete', { pageId: id(2) }, { cookie });
    expect(notion.archived).toEqual([id(2)]);
    expect(db.vocab.map((e) => e.pageId)).not.toContain(id(2));
  });
});

describe('동기화 호출', () => {
  it('HTTP가 아닌 이벤트(스케줄)는 동기화만 한다', async () => {
    expect(await handler({ type: 'sync' })).toEqual({ at: 'now' });
  });
});
