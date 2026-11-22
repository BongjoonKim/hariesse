/**
 * 웹 프론트 미리보기 — AWS 없이 가짜 데이터로 화면만 본다.
 *   npm run web:preview   →  http://localhost:4173  (비밀번호: preview)
 * API는 메모리 안의 가짜지만 미션·복습 계산은 실제 도메인 함수를 쓴다. 저장은 서버를 끄면 사라진다.
 * 실제 API(src/handlers/web)의 동작 검증은 test/web-handler.test.ts가 한다.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { buildWebAssets } from '../lib/stacks/web-stack';
import { kstDate, addDays, applyReview, pickDueEntries, normalizeVocabKey } from '../src/domain/vocab';
import { applyQuizSent, pickQuizEntries, normalizeWritingKey } from '../src/domain/writing';
import { buildMissions, summarize, computeStreak, lastDays, normalizeSettings, emptyDay, DEFAULT_SETTINGS, type DayRecord } from '../src/domain/missions';
import type { VocabEntry, WritingEntry } from '../src/lib/types';

const PORT = Number(process.env.PORT ?? 4173);
const today = kstDate();
const id = (n: number) => n.toString(16).padStart(32, '0');

const WORDS: [string, string, string][] = [
  ['ubiquitous', '어디에나 있는', 'Smartphones have become ubiquitous in modern life.\n→ 스마트폰은 현대 생활 어디에나 있다.'],
  ['mitigate', '완화하다', 'Trees help mitigate the effects of urban heat.\n→ 나무는 도시 열섬 효과를 완화한다.'],
  ['take into account', '~을 고려하다', 'You should take into account the cost of living.\n→ 생활비를 고려해야 한다.'],
  ['plausible', '그럴듯한', 'That is a plausible explanation for the decline.\n→ 그것은 감소에 대한 그럴듯한 설명이다.'],
  ['deteriorate', '악화되다', 'Air quality continued to deteriorate.\n→ 공기 질이 계속 악화되었다.'],
  ['The findings contradict the earlier hypothesis.', '그 결과는 이전 가설과 모순된다.', ''],
  ['scrutinize', '면밀히 조사하다', 'Researchers scrutinized the data.\n→ 연구자들은 데이터를 면밀히 조사했다.'],
  ['inherent', '내재된, 고유의', 'There are risks inherent in any investment.\n→ 모든 투자에는 내재된 위험이 있다.'],
  ['on the verge of', '~하기 직전인', 'The species is on the verge of extinction.\n→ 그 종은 멸종 직전이다.'],
  ['albeit', '비록 ~이지만', 'It was a success, albeit a modest one.\n→ 소소하긴 했지만 성공이었다.'],
  ['proliferate', '급증하다', 'Online courses have proliferated.\n→ 온라인 강좌가 급증했다.'],
  ['compelling', '설득력 있는', 'She made a compelling argument.\n→ 그녀는 설득력 있는 주장을 했다.'],
];
let vocab: VocabEntry[] = WORDS.map(([text, meaning, example], i) => ({
  pageId: id(i + 1),
  text,
  key: normalizeVocabKey(text),
  kind: text.split(' ').length > 4 ? 'sentence' : 'word',
  meaning,
  example: example || undefined,
  pos: text.includes(' ') ? undefined : i % 2 ? 'adjective' : 'verb',
  synonyms: i % 3 === 0 ? 'omnipresent, pervasive' : undefined,
  note: i % 4 === 0 ? 'TOEFL Reading에서 기술·환경 지문에 자주 나온다.' : undefined,
  tags: i % 5 === 0 ? ['reading'] : [],
  box: i % 6,
  missCount: i % 4 === 1 ? 3 : 0,
  status: i === 11 ? 'mastered' : 'learning',
  nextReview: i === 11 ? undefined : addDays(today, i < 6 ? -(i % 3) : i - 4),
  createdDate: addDays(today, -i * 2),
  origin: 'telegram',
}));
let writing: WritingEntry[] = [
  ['The meeting has been finalized for next Monday.', '회의가 다음 주 월요일로 확정되었다.', 'Power Test 2 (p70)'],
  ['I appreciate your prompt response.', '빠른 답변에 감사드립니다.', 'Power Test 2 (p70)'],
  ['Had I known about the delay, I would have left earlier.', '지연을 알았더라면 더 일찍 출발했을 것이다.', 'Check-up (p82)'],
  ['The number of applicants has risen sharply.', '지원자 수가 급격히 늘었다.', 'Check-up (p82)'],
  ['It is essential that every student submit the form.', '모든 학생이 양식을 제출하는 것이 필수다.', 'Check-up (p92)'],
  ['Not only did she finish the report, but she also presented it.', '그녀는 보고서를 끝냈을 뿐 아니라 발표도 했다.', 'Check-up (p92)'],
].map(([text, korean, source], i) => ({
  pageId: id(100 + i), text, key: normalizeWritingKey(text), korean, source, order: i + 1, status: 'active', quizCount: i % 2,
  note: i === 1 ? "I'm appreciate → I appreciate (동사 원형)" : undefined, createdDate: addDays(today, -10),
}));
const days = new Map<string, DayRecord>();
for (const n of [1, 2, 3, 5, 6, 8, 9, 10, 11, 14, 20, 21, 22, 30]) days.set(addDays(today, -n), { ...emptyDay(addDays(today, -n)), done: 5, total: 5, complete: true });
for (const n of [4, 7, 15]) days.set(addDays(today, -n), { ...emptyDay(addDays(today, -n)), done: 2, total: 5, complete: false });
let settings = { ...DEFAULT_SETTINGS, bookTitle: '클린 아키텍처' };
const day = (): DayRecord => days.get(today) ?? emptyDay(today);

function todayPayload() {
  const d = day();
  const due = pickDueEntries(vocab, today, 1e9);
  const quizAll = pickQuizEntries(writing, 1e9);
  const missions = buildMissions(settings, d, {
    vocabDue: due.length,
    vocabReviewedToday: vocab.filter((e) => e.lastReviewed === today).length,
    addedToday: [...vocab, ...writing].filter((e) => e.createdDate === today).length,
    writingAvailable: quizAll.length,
  });
  const summary = summarize(missions);
  days.set(today, { ...d, ...summary });
  return {
    date: today, missions, summary,
    streak: computeStreak([...days.values()].filter((x) => x.complete).map((x) => x.date), today),
    history: lastDays(today, 126).map((date) => ({ date, done: days.get(date)?.done ?? 0, total: days.get(date)?.total ?? 0, complete: Boolean(days.get(date)?.complete) })),
    settings, book: d.book, dueIds: due.map((e) => e.pageId),
    quizIds: quizAll.filter((e) => !d.writingIds.includes(e.pageId)).map((e) => e.pageId),
    techIds: d.techIds, syncedAt: new Date().toISOString(),
  };
}

const TECH = {
  lesson: { id: `lesson:k8s-03:${today}`, title: 'Deployment와 롤링 업데이트', track: '☸️ Kubernetes', sentDate: today, refs: ['https://kubernetes.io/docs/concepts/workloads/controllers/deployment/'] },
  articles: [
    { articleId: 'a1', url: 'https://example.com/1', title: 'DynamoDB 단일 테이블 설계를 다시 생각한다', category: 'cloud', score: 88, summary: '액세스 패턴이 바뀔 때 단일 테이블이 주는 비용과, 테이블을 나누는 기준을 사례로 정리한 글.', aiOpinion: 'hariesse 학습 테이블처럼 작은 서비스에는 pk/sk 한 벌이면 충분하다는 점을 확인해 준다.', deliveredAt: new Date().toISOString() },
    { articleId: 'a2', url: 'https://example.com/2', title: 'LLM 에이전트 평가: 무엇을, 어떻게 잴 것인가', category: 'dev-ai', score: 81, summary: '에이전트 평가를 과제 성공률·비용·안정성 세 축으로 나눠 설명한다.', discussionUrl: 'https://example.com/d', deliveredAt: new Date().toISOString() },
  ],
};

type Body = Record<string, any>;
function route(method: string, url: string, body: Body, authed: boolean): [number, unknown, string?] {
  if (url === '/api/login') return body.password === 'preview' ? [200, { ok: true }, 'hs=preview; Path=/; HttpOnly'] : [401, { error: '비밀번호가 달라요 (미리보기: preview)' }];
  if (url === '/api/logout') return [200, { ok: true }, 'hs=; Path=/; Max-Age=0'];
  if (!authed) return [401, { error: '로그인이 필요해요' }];
  const v = () => vocab.find((e) => e.pageId === body.pageId)!;
  const w = () => writing.find((e) => e.pageId === body.pageId)!;
  switch (`${method} ${url}`) {
    case 'GET /api/today': return [200, todayPayload()];
    case 'GET /api/library': return [200, { vocab, writing }];
    case 'GET /api/tech': return [200, TECH];
    case 'POST /api/sync': return [200, { today: todayPayload(), library: { vocab, writing } }];
    case 'POST /api/vocab/review': {
      const e = v();
      const due = e.status !== 'mastered' && e.nextReview !== undefined && e.nextReview <= today;
      if (!due && body.result === 'know') return [200, { entry: e, changed: false, ack: '연습으로만 봤어요 (복습 일정은 그대로)', today: todayPayload() }];
      const r = applyReview(e, body.result, today);
      Object.assign(e, r.fields);
      return [200, { entry: e, changed: r.changed, ack: r.ack, today: todayPayload() }];
    }
    case 'POST /api/vocab/update': {
      const e = v();
      Object.assign(e, body.fields ?? {}, body.action === 'master' ? { status: 'mastered', nextReview: undefined } : body.action === 'relearn' ? { status: 'learning', box: 1, nextReview: addDays(today, 1) } : {});
      return [200, { entry: e, today: todayPayload() }];
    }
    case 'POST /api/vocab/delete': vocab = vocab.filter((e) => e.pageId !== body.pageId); return [200, { ok: true, today: todayPayload() }];
    case 'POST /api/writing/attempt': {
      const e = w();
      Object.assign(e, applyQuizSent(e, today));
      const d = day();
      if (!d.writingIds.includes(e.pageId)) days.set(today, { ...d, writingIds: [...d.writingIds, e.pageId] });
      return [200, { entry: e, match: normalizeWritingKey(body.answer ?? '') === normalizeWritingKey(e.text), today: todayPayload() }];
    }
    case 'POST /api/writing/update': {
      const e = w();
      Object.assign(e, body.fields ?? {}, body.action === 'exclude' ? { status: 'excluded' } : body.action === 'include' ? { status: 'active' } : {});
      return [200, { entry: e, today: todayPayload() }];
    }
    case 'POST /api/add': {
      const outcomes = String(body.text).split('\n').map((l) => l.trim()).filter(Boolean).map((input, i) => {
        if (/[가-힣]/.test(input.split('::')[0])) return { input, ok: false, error: '영어만 적어 주세요. 뜻을 같이 적으려면 "표현 :: 뜻"' };
        const pageId = id(Date.now() % 1e9 + i);
        if (body.target === 'writing') {
          const e: WritingEntry = { pageId, text: input, korean: '(미리보기) 한국어 문제', quizCount: 0, status: 'active', source: 'Web', createdDate: today };
          writing.push(e);
          return { input, ok: true, writing: e };
        }
        const e: VocabEntry = { pageId, text: input.split('::')[0].trim(), meaning: input.split('::')[1]?.trim() ?? '(미리보기) 뜻', tags: [], box: 0, missCount: 0, status: 'learning', nextReview: addDays(today, 1), createdDate: today, origin: 'web' };
        vocab.push(e);
        return { input, ok: true, vocab: e };
      });
      return [200, { outcomes, today: todayPayload() }];
    }
    case 'POST /api/checkin': {
      const d = day();
      if (body.kind === 'book') days.set(today, { ...d, book: { done: body.done !== false, memo: body.memo } });
      else days.set(today, { ...d, techIds: body.done === false ? d.techIds.filter((x) => x !== body.id) : [...new Set([...d.techIds, body.id])] });
      return [200, { today: todayPayload() }];
    }
    case 'POST /api/settings': settings = { ...normalizeSettings(body, settings), bookTitle: body.bookTitle || undefined } as typeof settings; return [200, { today: todayPayload() }];
    default: return [404, { error: '없는 주소예요' }];
  }
}

const dist = buildWebAssets();
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http
  .createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url.startsWith('/api/')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const [status, data, cookie] = route(req.method ?? 'GET', url, raw ? JSON.parse(raw) : {}, /hs=preview/.test(req.headers.cookie ?? ''));
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(cookie ? { 'set-cookie': cookie } : {}) });
        res.end(JSON.stringify(data));
      });
      return;
    }
    const file = path.join(dist, url === '/' ? 'index.html' : path.basename(url));
    if (!fs.existsSync(file)) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`hariesse web preview: http://localhost:${PORT}  (비밀번호: preview)`));
