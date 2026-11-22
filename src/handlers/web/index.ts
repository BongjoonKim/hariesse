import { getConfig, getNotionToken, getWebPassword, type AppConfig } from '../../lib/config';
import { ENV } from '../../lib/constants';
import { getLearningProgress } from '../../lib/dynamo';
import { enrichWriting } from '../../lib/bedrock';
import { captureExpression } from '../../lib/vocab-capture';
import { getVocabPage, updateVocabPage, archiveVocabPage, type VocabFields } from '../../lib/notion-vocab';
import { createWritingPage, updateWritingPage, type WritingFields } from '../../lib/notion-writing';
import {
  listVocab,
  listWriting,
  getMirrorEntry,
  putMirrorEntry,
  deleteMirrorEntry,
  syncFromNotion,
  getDay,
  putDay,
  listDaysSince,
  getMeta,
  putMeta,
  listDeliveredSince,
  type SyncResult,
} from '../../lib/study-store';
import {
  kstDate,
  addDays,
  parseVocabMessage,
  hasKoreanInstruction,
  normalizeVocabKey,
  detectKind,
  applyReview,
  pickDueEntries,
  MAX_BOX,
  BOX_INTERVAL_DAYS,
  type ReviewResult,
} from '../../domain/vocab';
import { normalizeWritingKey, applyWritingEnrichment, applyQuizSent, pickQuizEntries } from '../../domain/writing';
import {
  buildMissions,
  summarize,
  computeStreak,
  lastDays,
  normalizeSettings,
  DEFAULT_SETTINGS,
  type DayRecord,
  type MissionSettings,
} from '../../domain/missions';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  checkPassword,
  sessionKey,
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  loginGate,
  nextLoginState,
  type LoginState,
} from '../../domain/web-auth';
import { CURRICULUM } from '../../domain/curriculum';
import { findLesson } from '../../domain/learning';
import type { AddOutcome, LibraryPayload, TechPayload, TodayPayload } from '../../lib/web-types';
import type { VocabEntry, WritingEntry } from '../../lib/types';

/**
 * 웹 API Lambda — CloudFront `/api/*` 뒤의 Function URL.
 * - 인증: 비밀번호 1개(Secrets `web-password`) → 서명된 세션 쿠키. `/api/login` 말고는 전부 세션이 있어야 한다.
 * - 읽기는 DynamoDB 미러(학습 테이블)에서, 쓰기는 Notion(원본)에 먼저 쓰고 미러를 같이 고친다.
 * - EventBridge(30분마다) 또는 `{"type":"sync"}`로 호출되면 Notion → 미러 동기화만 한다.
 * - 변경 요청(POST)은 `x-hariesse` 헤더가 있어야 한다 — 다른 사이트의 폼 전송으로는 붙일 수 없는 헤더(CSRF 방지).
 */

interface UrlEvent {
  requestContext?: { http?: { method: string } };
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  type?: string;
}

interface UrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const json = (statusCode: number, body: unknown, cookies?: string[]): UrlResponse => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  ...(cookies ? { cookies } : {}),
  body: JSON.stringify(body),
});

/** 한 번에 등록하는 줄 수 — 줄마다 Bedrock 1회라 응답 시간(60초) 안에 끝나게 */
const ADD_MAX_LINES = 5;
const FIELD_MAX = 1900;
const HISTORY_DAYS = 126;

export const handler = async (event: UrlEvent = {}): Promise<UrlResponse | SyncResult> => {
  const cfg = await getConfig();
  const table = process.env[ENV.STUDY_TABLE];
  if (!table) throw new Error(`Missing required env var: ${ENV.STUDY_TABLE}`);

  // 스케줄·수동 호출 = 동기화
  if (!event.requestContext?.http) return sync(cfg, table);

  const method = event.requestContext.http.method;
  const path = (event.rawPath ?? '').replace(/\/+$/, '');
  try {
    const body = parseBody(event);
    const password = await getWebPassword();

    if (path === '/api/login' && method === 'POST') return await login(table, password, body);
    if (path === '/api/logout' && method === 'POST') return json(200, { ok: true }, [sessionCookie('', 0)]);

    const cookies = parseCookies([...(event.cookies ?? []), event.headers?.cookie ?? ''].join('; '));
    if (!verifySession(sessionKey(password), cookies[SESSION_COOKIE], Date.now())) throw new HttpError(401, '로그인이 필요해요');
    if (method === 'POST' && !event.headers?.['x-hariesse']) throw new HttpError(403, '잘못된 요청이에요');

    const route = `${method} ${path}`;
    switch (route) {
      case 'GET /api/today':
        return json(200, await today(cfg, table));
      case 'GET /api/library':
        return json(200, await library(table));
      case 'GET /api/tech':
        return json(200, await tech(cfg));
      case 'POST /api/sync':
        await sync(cfg, table);
        return json(200, { today: await today(cfg, table), library: await library(table) });
      case 'POST /api/vocab/review':
        return json(200, await reviewVocab(cfg, table, body));
      case 'POST /api/vocab/update':
        return json(200, await updateVocab(cfg, table, body));
      case 'POST /api/vocab/delete':
        return json(200, await deleteVocab(cfg, table, body));
      case 'POST /api/writing/attempt':
        return json(200, await attemptWriting(cfg, table, body));
      case 'POST /api/writing/update':
        return json(200, await updateWriting(cfg, table, body));
      case 'POST /api/add':
        return json(200, await add(cfg, table, body));
      case 'POST /api/checkin':
        return json(200, await checkin(cfg, table, body));
      case 'POST /api/settings':
        await putMeta(table, 'settings', normalizeSettings(body, await loadSettings(table)));
        return json(200, { today: await today(cfg, table) });
      default:
        throw new HttpError(404, '없는 주소예요');
    }
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
    console.error(`web ${method} ${path} 실패: ${(err as Error).stack ?? err}`);
    return json(500, { error: '처리하지 못했어요. 잠시 후 다시 해 주세요.' });
  }
};

type Body = Record<string, unknown>;

function parseBody(event: UrlEvent): Body {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : {};
  } catch {
    throw new HttpError(400, '요청 형식이 잘못됐어요');
  }
}

function pageIdOf(body: Body): string {
  const id = body.pageId;
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id)) throw new HttpError(400, 'pageId가 필요해요');
  return id;
}

// ---------------------------------------------------------------- 로그인

async function login(table: string, password: string, body: Body): Promise<UrlResponse> {
  const now = Date.now();
  const state = await getMeta<LoginState>(table, 'login');
  const gate = loginGate(state, now);
  if (!gate.allowed) {
    throw new HttpError(429, `여러 번 틀려서 잠겼어요. ${Math.ceil(gate.retryAfterSec / 60)}분 뒤에 다시 해 주세요.`);
  }
  const ok = checkPassword(body.password, password);
  if (!ok || (state?.fails ?? 0) > 0) await putMeta(table, 'login', nextLoginState(state, ok, now));
  if (!ok) throw new HttpError(401, '비밀번호가 달라요');
  return json(200, { ok: true }, [sessionCookie(signSession(sessionKey(password), now), Math.floor(SESSION_TTL_MS / 1000))]);
}

// ---------------------------------------------------------------- 동기화

async function sync(cfg: AppConfig, table: string): Promise<SyncResult> {
  const result = await syncFromNotion(table, await getNotionToken(), {
    vocab: cfg.vocabNotionDatabaseId,
    writing: cfg.writingNotionDatabaseId,
  });
  console.log(`web sync: ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------- 오늘의 미션

async function loadSettings(table: string): Promise<MissionSettings> {
  return normalizeSettings(await getMeta<MissionSettings>(table, 'settings'), DEFAULT_SETTINGS);
}

async function today(_cfg: AppConfig, table: string): Promise<TodayPayload> {
  const date = kstDate();
  const [vocab, writing, day, settings, syncMeta, days] = await Promise.all([
    listVocab(table),
    listWriting(table),
    getDay(table, date),
    loadSettings(table),
    getMeta<SyncResult>(table, 'sync'),
    listDaysSince(table, '2000-01-01'),
  ]);

  const due = pickDueEntries(vocab, date, Number.MAX_SAFE_INTEGER);
  const attempted = new Set(day.writingIds);
  const quizAll = pickQuizEntries(writing, Number.MAX_SAFE_INTEGER);
  const missions = buildMissions(settings, day, {
    vocabDue: due.length,
    vocabReviewedToday: vocab.filter((e) => e.lastReviewed === date).length,
    addedToday: [...vocab, ...writing].filter((e) => e.createdDate === date).length,
    writingAvailable: quizAll.length,
  });
  const summary = summarize(missions);

  // 연속 기록·달력이 읽을 수 있게 오늘 결과를 남긴다 (바뀌었을 때만)
  if (day.done !== summary.done || day.total !== summary.total || day.complete !== summary.complete) {
    await putDay(table, { ...day, ...summary });
  }

  const byDate = new Map(days.map((d) => [d.date, d]));
  byDate.set(date, { ...day, ...summary });
  const completeDates = [...byDate.values()].filter((d) => d.complete).map((d) => d.date);
  return {
    date,
    missions,
    summary,
    streak: computeStreak(completeDates, date),
    history: lastDays(date, HISTORY_DAYS).map((d) => {
      const rec = byDate.get(d);
      return { date: d, done: rec?.done ?? 0, total: rec?.total ?? 0, complete: Boolean(rec?.complete) };
    }),
    settings,
    book: day.book,
    dueIds: due.map((e) => e.pageId),
    quizIds: quizAll.filter((e) => !attempted.has(e.pageId)).map((e) => e.pageId),
    techIds: day.techIds,
    syncedAt: syncMeta?.at,
  };
}

async function library(table: string): Promise<LibraryPayload> {
  const [vocab, writing] = await Promise.all([listVocab(table), listWriting(table)]);
  return { vocab, writing };
}

async function tech(cfg: AppConfig): Promise<TechPayload> {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const [articles, progress] = await Promise.all([
    listDeliveredSince(cfg.articlesTable, ['dev-ai', 'cloud', 'design', 'travel'], since),
    getLearningProgress(cfg.profileTable),
  ]);
  const found = progress?.lastLessonId ? findLesson(CURRICULUM, progress.lastLessonId) : undefined;
  const sentDate = progress?.lastSentDate;
  // 이틀 넘은 레슨은 '오늘 읽을 것'에서 뺀다
  const lesson =
    found && sentDate && sentDate >= addDays(kstDate(), -1)
      ? {
          id: `lesson:${found.lesson.id}:${sentDate}`,
          title: found.lesson.title,
          track: `${found.track.emoji} ${found.track.name}`,
          sentDate,
          refs: found.lesson.refs,
        }
      : undefined;
  return { articles, lesson };
}

// ---------------------------------------------------------------- 단어장

/**
 * 복습 답. 복습할 차례인 표현이면 Telegram 버튼과 똑같이 Leitner 박스를 옮긴다.
 * 차례가 아닌 표현(자유 복습)은 '몰라요'만 반영한다 — '알아요'로 간격을 당겨 올리면 간격 반복이 무너진다.
 */
async function reviewVocab(cfg: AppConfig, table: string, body: Body) {
  const pageId = pageIdOf(body);
  const result = body.result;
  if (result !== 'know' && result !== 'forgot') throw new HttpError(400, 'result는 know 또는 forgot');
  const notionToken = await getNotionToken();
  // 박스·마지막 복습은 Telegram에서도 바뀌므로 Notion의 지금 값을 기준으로 한다
  const entry = await getVocabPage(notionToken, pageId);
  if (!entry) {
    await deleteMirrorEntry(table, 'VOCAB', pageId);
    throw new HttpError(404, '삭제된 표현이에요');
  }
  const date = kstDate();
  const due = entry.status !== 'mastered' && entry.nextReview !== undefined && entry.nextReview <= date;
  if (!due && result === 'know') {
    await putMirrorEntry(table, 'VOCAB', entry);
    return { entry, changed: false, ack: '연습으로만 봤어요 (복습 일정은 그대로)', today: await today(cfg, table) };
  }
  const r = applyReview(entry, result as ReviewResult, date);
  const merged: VocabEntry = { ...entry, ...r.fields };
  if (r.changed) await updateVocabPage(notionToken, pageId, r.fields);
  await putMirrorEntry(table, 'VOCAB', merged);
  return { entry: merged, changed: r.changed, ack: r.ack, today: await today(cfg, table) };
}

/** 문자열 칸: 빈 문자열이면 지운다(undefined). 본문에 없는 키는 건드리지 않는다. */
function pickText<K extends string>(src: Body, keys: readonly K[]): Partial<Record<K, string | undefined>> {
  const out: Partial<Record<K, string | undefined>> = {};
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const v = src[k];
    if (v !== null && typeof v !== 'string') throw new HttpError(400, `${k}는 글자여야 해요`);
    out[k] = v?.trim().slice(0, FIELD_MAX) || undefined;
  }
  return out;
}

async function updateVocab(cfg: AppConfig, table: string, body: Body) {
  const pageId = pageIdOf(body);
  const entry = await getMirrorEntry<VocabEntry>(table, 'VOCAB', pageId);
  if (!entry) throw new HttpError(404, '없는 표현이에요');
  const date = kstDate();
  const src = (body.fields && typeof body.fields === 'object' ? body.fields : {}) as Body;
  const fields: VocabFields = pickText(src, ['meaning', 'pos', 'pronunciation', 'example', 'synonyms', 'note'] as const);

  if (typeof src.text === 'string' && src.text.trim() && src.text.trim() !== entry.text) {
    const text = src.text.trim().slice(0, FIELD_MAX);
    const key = normalizeVocabKey(text);
    const clash = (await listVocab(table)).find((e) => e.key === key && e.pageId !== pageId);
    if (!key || clash) throw new HttpError(409, '같은 표현이 이미 있어요');
    Object.assign(fields, { text, key, kind: detectKind(text) });
  }
  if (Array.isArray(src.tags)) {
    fields.tags = [...new Set(src.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
  }
  if (body.action === 'master') Object.assign(fields, { status: 'mastered', box: MAX_BOX, nextReview: undefined });
  else if (body.action === 'relearn') {
    Object.assign(fields, { status: 'learning', box: 1, nextReview: addDays(date, BOX_INTERVAL_DAYS[1]) });
  } else if (body.action !== undefined) throw new HttpError(400, '모르는 action');
  if (Object.keys(fields).length === 0) throw new HttpError(400, '바꿀 내용이 없어요');

  await updateVocabPage(await getNotionToken(), pageId, fields);
  const merged: VocabEntry = { ...entry, ...fields };
  await putMirrorEntry(table, 'VOCAB', merged);
  return { entry: merged, today: await today(cfg, table) };
}

async function deleteVocab(cfg: AppConfig, table: string, body: Body) {
  const pageId = pageIdOf(body);
  // Notion 휴지통으로 이동 (30일 안에 Notion에서 복구 가능)
  await archiveVocabPage(await getNotionToken(), pageId);
  await deleteMirrorEntry(table, 'VOCAB', pageId);
  return { ok: true, today: await today(cfg, table) };
}

// ---------------------------------------------------------------- Writing

async function attemptWriting(cfg: AppConfig, table: string, body: Body) {
  const pageId = pageIdOf(body);
  const entry = await getMirrorEntry<WritingEntry>(table, 'WRITING', pageId);
  if (!entry) throw new HttpError(404, '없는 문장이에요');
  const answer = typeof body.answer === 'string' ? body.answer : '';
  const date = kstDate();
  // 출제 기록은 Telegram 출제와 같은 칸을 쓴다 — 웹에서 써 본 문장은 Telegram에서도 뒤로 밀린다
  const sent = applyQuizSent(entry, date);
  await updateWritingPage(await getNotionToken(), pageId, sent);
  const merged: WritingEntry = { ...entry, ...sent };
  await putMirrorEntry(table, 'WRITING', merged);

  const day = await getDay(table, date);
  if (!day.writingIds.includes(pageId)) await putDay(table, { ...day, writingIds: [...day.writingIds, pageId] });
  return {
    entry: merged,
    match: answer.trim() !== '' && normalizeWritingKey(answer) === normalizeWritingKey(entry.text),
    today: await today(cfg, table),
  };
}

async function updateWriting(cfg: AppConfig, table: string, body: Body) {
  const pageId = pageIdOf(body);
  const entry = await getMirrorEntry<WritingEntry>(table, 'WRITING', pageId);
  if (!entry) throw new HttpError(404, '없는 문장이에요');
  const src = (body.fields && typeof body.fields === 'object' ? body.fields : {}) as Body;
  const fields: WritingFields = pickText(src, ['korean', 'note', 'source'] as const);
  if (typeof src.text === 'string' && src.text.trim() && src.text.trim() !== entry.text) {
    const text = src.text.trim().slice(0, FIELD_MAX);
    Object.assign(fields, { text, key: normalizeWritingKey(text) });
  }
  if (body.action === 'exclude') fields.status = 'excluded';
  else if (body.action === 'include') fields.status = 'active';
  else if (body.action !== undefined) throw new HttpError(400, '모르는 action');
  if (Object.keys(fields).length === 0) throw new HttpError(400, '바꿀 내용이 없어요');

  await updateWritingPage(await getNotionToken(), pageId, fields);
  const merged: WritingEntry = { ...entry, ...fields };
  await putMirrorEntry(table, 'WRITING', merged);
  return { entry: merged, today: await today(cfg, table) };
}

// ---------------------------------------------------------------- 등록

async function add(cfg: AppConfig, table: string, body: Body) {
  const text = typeof body.text === 'string' ? body.text : '';
  const target = body.target === 'writing' ? 'writing' : 'vocab';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new HttpError(400, '등록할 내용을 적어 주세요');
  if (lines.length > ADD_MAX_LINES) throw new HttpError(400, `한 번에 ${ADD_MAX_LINES}줄까지 등록할 수 있어요`);
  const databaseId = target === 'writing' ? cfg.writingNotionDatabaseId : cfg.vocabNotionDatabaseId;
  if (!databaseId) throw new HttpError(400, 'Notion DB가 아직 설정되지 않았어요');

  const notionToken = await getNotionToken();
  const date = kstDate();
  const outcomes: AddOutcome[] = [];
  const known = target === 'writing' ? await listWriting(table) : [];
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 90) : 'Web';

  for (const line of lines) {
    try {
      // 영어 학습 자료만 받는다. 한국어 뜻은 `표현 :: 뜻` 형식으로만 (Telegram과 같은 규칙).
      if (hasKoreanInstruction(line)) {
        outcomes.push({ input: line, ok: false, error: '영어만 적어 주세요. 뜻을 같이 적으려면 "표현 :: 뜻"' });
        continue;
      }
      if (target === 'vocab') {
        const [input] = parseVocabMessage(line);
        if (!input) continue;
        const out = await captureExpression(
          { modelId: cfg.bedrockModelId, region: cfg.bedrockRegion, notionToken, databaseId },
          input,
          date,
          'web'
        );
        await putMirrorEntry(table, 'VOCAB', out.entry);
        outcomes.push({ input: line, ok: true, repeated: out.repeated, note: out.spelling, vocab: out.entry });
      } else {
        const entry = await addWriting(cfg, notionToken, databaseId, line, source, date, known);
        if (!entry) {
          outcomes.push({ input: line, ok: true, repeated: true });
          continue;
        }
        known.push(entry);
        await putMirrorEntry(table, 'WRITING', entry);
        outcomes.push({ input: line, ok: true, note: entry.text !== line ? `✏️ ${entry.text}` : undefined, writing: entry });
      }
    } catch (err) {
      console.error(`web add 실패 "${line}": ${(err as Error).message}`);
      outcomes.push({ input: line, ok: false, error: '저장하지 못했어요' });
    }
  }
  return { outcomes, today: await today(cfg, table) };
}

/** Writing 문장 1건 저장. 이미 있는 문장이면 undefined. 채우기에 실패하면 '새로 추가'로 두고 다음 12:00 실행이 채운다. */
async function addWriting(
  cfg: AppConfig,
  notionToken: string,
  databaseId: string,
  text: string,
  source: string,
  date: string,
  known: WritingEntry[]
): Promise<WritingEntry | undefined> {
  const isKnown = (key: string) => known.some((e) => (e.key ?? normalizeWritingKey(e.text)) === key);
  if (isKnown(normalizeWritingKey(text))) return undefined;

  let fields: WritingFields = { text, key: normalizeWritingKey(text), status: 'new', quizCount: 0, source };
  try {
    const e = await enrichWriting(cfg.bedrockModelId, cfg.bedrockRegion, text);
    const update = applyWritingEnrichment({ text, quizCount: 0 }, e);
    if (update.text && isKnown(update.key!)) return undefined; // 고친 문장이 이미 있다
    fields = { ...fields, ...update, text: update.text ?? text };
  } catch (err) {
    console.warn(`writing enrich 실패 "${text}": ${(err as Error).message}`);
  }
  const pageId = await createWritingPage(notionToken, databaseId, fields);
  return { pageId, quizCount: 0, createdDate: date, ...fields, text: fields.text! };
}

// ---------------------------------------------------------------- 체크인 (기술 글 · 독서)

async function checkin(cfg: AppConfig, table: string, body: Body) {
  const date = kstDate();
  const day: DayRecord = await getDay(table, date);
  const done = body.done !== false;
  if (body.kind === 'book') {
    const memo = typeof body.memo === 'string' && body.memo.trim() ? body.memo.trim().slice(0, 300) : undefined;
    await putDay(table, { ...day, book: { done, memo } });
  } else if (body.kind === 'tech') {
    const id = typeof body.id === 'string' ? body.id.slice(0, 120) : '';
    if (!id) throw new HttpError(400, 'id가 필요해요');
    const rest = day.techIds.filter((x) => x !== id);
    await putDay(table, { ...day, techIds: done ? [...rest, id] : rest });
  } else {
    throw new HttpError(400, '모르는 kind');
  }
  return { today: await today(cfg, table) };
}
