import { getConfig, getGoogleOAuth, getSessionSecret } from '../../lib/config';
import {
  deleteRoutine,
  deleteTask,
  ensureDayPlan,
  getRoutine,
  listRoutines,
  newId,
  putRoutine,
  putTask,
  resyncRoutineDays,
  setTaskStatus,
} from '../../lib/tasks';
import {
  isValidDate,
  kstMoment,
  parseRoutineInput,
  parseStatusInput,
  parseTaskInput,
  sortTasks,
  summarizeDay,
  type RoutineInput,
} from '../../domain/routine';
import {
  PKCE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  clearCookie,
  createPkce,
  isAllowedEmail,
  parseCookies,
  setCookie,
  signPkce,
  signSession,
  verifyPkce,
  verifySession,
  type SessionPayload,
} from '../../domain/session';
import { authorizeUrl, decodeIdToken, exchangeCode } from '../../lib/google-oauth';
import { DEFAULTS } from '../../lib/constants';
import type { Routine, TaskInstance } from '../../lib/types';

/**
 * 웹 UI 백엔드 (Lambda Function URL, CloudFront OAC 뒤).
 * 브라우저는 같은 CloudFront 도메인의 `/api/*`로만 접근한다 → CORS 없음,
 * 세션 쿠키를 HttpOnly·Secure·SameSite=Lax로 쓸 수 있다.
 *
 * 인증은 Google OAuth(Authorization Code + PKCE)를 직접 처리하고,
 * 허용 이메일(SSM `/hariesse/allowed-email`) 밖의 계정은 거부한다.
 */

interface ApiEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  requestContext?: { http?: { method?: string } };
  body?: string;
  isBase64Encoded?: boolean;
}

interface ApiResponse {
  statusCode: number;
  headers?: Record<string, string>;
  cookies?: string[];
  body?: string;
}

const PKCE_TTL_SEC = 600;

function json(statusCode: number, data: unknown, cookies?: string[]): ApiResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    ...(cookies ? { cookies } : {}),
    body: JSON.stringify(data),
  };
}

function redirect(location: string, cookies?: string[]): ApiResponse {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
    ...(cookies ? { cookies } : {}),
  };
}

function readBody(event: ApiEvent): unknown {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body ?? '';
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 로그인 실패는 JSON 대신 SPA로 돌려보낸다 — 사용자가 보는 건 브라우저 화면이다. */
const loginError = (origin: string, reason: string): ApiResponse =>
  redirect(`${origin}/?login=${reason}`, [clearCookie(PKCE_COOKIE)]);

// ---- 인증 ----

async function handleAuth(
  event: ApiEvent,
  segments: string[],
  method: string
): Promise<ApiResponse> {
  const cfg = await getConfig();
  const secret = await getSessionSecret();
  const nowSec = Math.floor(Date.now() / 1000);

  // 로그아웃은 web-origin 설정과 무관하게 항상 동작해야 한다.
  if (segments[1] === 'logout' && method === 'POST') {
    return json(200, { ok: true }, [clearCookie(SESSION_COOKIE)]);
  }

  if (!cfg.webOrigin) {
    return json(500, { error: 'SSM /hariesse/web-origin 이 비어 있습니다 (배포 후 설정 필요)' });
  }
  const redirectUri = `${cfg.webOrigin}/api/auth/callback`;

  if (segments[1] === 'login' && method === 'GET') {
    const { clientId } = await getGoogleOAuth();
    const pkce = createPkce();
    const cookie = signPkce(
      { verifier: pkce.verifier, state: pkce.state, exp: nowSec + PKCE_TTL_SEC },
      secret
    );
    return redirect(
      authorizeUrl({ clientId, redirectUri, state: pkce.state, codeChallenge: pkce.challenge }),
      [setCookie(PKCE_COOKIE, cookie, PKCE_TTL_SEC)]
    );
  }

  if (segments[1] === 'callback' && method === 'GET') {
    const params = new URLSearchParams(event.rawQueryString ?? '');
    const code = params.get('code');
    const state = params.get('state');
    const cookies = parseCookies(event.cookies, event.headers?.cookie);
    const saved = verifyPkce(cookies[PKCE_COOKIE], secret, nowSec);

    if (!code || !saved || !state || saved.state !== state) {
      return loginError(cfg.webOrigin, 'state');
    }

    const { clientId, clientSecret } = await getGoogleOAuth();
    let claims;
    try {
      const tokens = await exchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier: saved.verifier,
      });
      claims = decodeIdToken(tokens.id_token);
    } catch (err) {
      console.warn(`토큰 교환 실패: ${(err as Error).message}`);
      return loginError(cfg.webOrigin, 'exchange');
    }

    if (!claims?.email || !claims.sub || claims.email_verified === false) {
      return loginError(cfg.webOrigin, 'email');
    }
    if (!isAllowedEmail(claims.email, cfg.allowedEmail)) {
      console.warn(`허용되지 않은 계정 로그인 시도: ${claims.email}`);
      return loginError(cfg.webOrigin, 'forbidden');
    }

    const session = signSession(
      { sub: claims.sub, email: claims.email, exp: nowSec + SESSION_TTL_SEC },
      secret
    );
    return redirect(`${cfg.webOrigin}/`, [
      setCookie(SESSION_COOKIE, session, SESSION_TTL_SEC),
      clearCookie(PKCE_COOKIE),
    ]);
  }

  return json(404, { error: 'not found' });
}

// ---- 루틴 ----

function routineFrom(
  input: RoutineInput,
  routineId: string,
  createdAt: string,
  now: string
): Routine {
  return {
    pk: 'ROUTINE',
    sk: routineId,
    routineId,
    title: input.title,
    daysOfWeek: input.daysOfWeek,
    timeOfDay: input.timeOfDay,
    remindSlots: input.remindSlots,
    category: input.category,
    estimatedMinutes: input.estimatedMinutes,
    note: input.note,
    active: input.active,
    createdAt,
    updatedAt: now,
  };
}

async function handleRoutines(
  event: ApiEvent,
  segments: string[],
  method: string,
  table: string,
  today: string
): Promise<ApiResponse> {
  const routineId = segments[1];

  if (!routineId && method === 'GET') {
    const routines = await listRoutines(table);
    routines.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    return json(200, { routines });
  }

  if (!routineId && method === 'POST') {
    const parsed = parseRoutineInput(readBody(event));
    if (!parsed.ok) return json(400, { error: parsed.error });
    const now = new Date().toISOString();
    const created = routineFrom(parsed.value, newId(), now, now);
    await putRoutine(table, created);
    await resyncRoutineDays(table, created.routineId, today);
    return json(201, { routine: created });
  }

  if (routineId && method === 'PUT') {
    const existing = await getRoutine(table, routineId);
    if (!existing) return json(404, { error: '없는 루틴입니다' });
    const parsed = parseRoutineInput(readBody(event));
    if (!parsed.ok) return json(400, { error: parsed.error });
    const updated = routineFrom(
      parsed.value,
      routineId,
      existing.createdAt,
      new Date().toISOString()
    );
    await putRoutine(table, updated);
    await resyncRoutineDays(table, routineId, today);
    return json(200, { routine: updated });
  }

  if (routineId && method === 'DELETE') {
    await deleteRoutine(table, routineId);
    await resyncRoutineDays(table, routineId, today);
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}

// ---- 하루 할일 ----

async function handleDays(
  event: ApiEvent,
  segments: string[],
  method: string,
  table: string
): Promise<ApiResponse> {
  const date = segments[1];
  if (!isValidDate(date)) return json(400, { error: '날짜는 YYYY-MM-DD 형식이어야 합니다' });

  // GET /days/{date}
  if (segments.length === 2 && method === 'GET') {
    const tasks = sortTasks(await ensureDayPlan(table, date, new Date().toISOString()));
    return json(200, { date, tasks, summary: summarizeDay(tasks) });
  }

  if (segments[2] !== 'tasks') return json(404, { error: 'not found' });

  // POST /days/{date}/tasks — 단건 추가
  if (segments.length === 3 && method === 'POST') {
    const parsed = parseTaskInput(readBody(event));
    if (!parsed.ok) return json(400, { error: parsed.error });
    const now = new Date().toISOString();
    const task: TaskInstance = {
      pk: `DAY#${date}`,
      sk: `x${newId()}`,
      date,
      title: parsed.value.title,
      status: 'todo',
      origin: 'adhoc',
      timeOfDay: parsed.value.timeOfDay,
      category: parsed.value.category,
      estimatedMinutes: parsed.value.estimatedMinutes,
      note: parsed.value.note,
      createdAt: now,
      updatedAt: now,
      ttl: Math.floor(Date.now() / 1000) + DEFAULTS.TASK_TTL_DAYS * 86400,
    };
    await putTask(table, task);
    return json(201, { task });
  }

  const sk = segments[3];
  if (!sk) return json(404, { error: 'not found' });

  // PATCH /days/{date}/tasks/{sk} — 상태 변경
  if (method === 'PATCH') {
    const parsed = parseStatusInput(readBody(event));
    if (!parsed.ok) return json(400, { error: parsed.error });
    const updated = await setTaskStatus(table, date, sk, parsed.value, new Date().toISOString());
    if (!updated) return json(404, { error: '없는 할일입니다' });
    return json(200, { task: updated });
  }

  // DELETE /days/{date}/tasks/{sk} — 단건만 삭제 (루틴 전개분은 루틴에서 지운다)
  if (method === 'DELETE') {
    if (!sk.startsWith('x')) {
      return json(400, { error: '루틴에서 나온 할일은 루틴을 고쳐 주세요' });
    }
    await deleteTask(table, date, sk);
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}

// ---- 진입점 ----

export const handler = async (event: ApiEvent): Promise<ApiResponse> => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = (event.rawPath ?? '/').replace(/^\/api(?=\/|$)/, '');
  const segments = path.split('/').filter(Boolean);

  try {
    if (segments[0] === 'auth') return await handleAuth(event, segments, method);

    const secret = await getSessionSecret();
    const cookies = parseCookies(event.cookies, event.headers?.cookie);
    const session: SessionPayload | undefined = verifySession(
      cookies[SESSION_COOKIE],
      secret,
      Math.floor(Date.now() / 1000)
    );
    if (!session) return json(401, { error: 'unauthorized' });

    const cfg = await getConfig();
    if (!cfg.tasksTable) return json(500, { error: 'TASKS_TABLE 환경변수가 없습니다' });
    const today = kstMoment(new Date()).date;

    if (segments[0] === 'me' && method === 'GET') {
      return json(200, { email: session.email, today });
    }
    if (segments[0] === 'routines') {
      return await handleRoutines(event, segments, method, cfg.tasksTable, today);
    }
    if (segments[0] === 'days') {
      return await handleDays(event, segments, method, cfg.tasksTable);
    }
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error(`api 오류 ${method} ${path}: ${(err as Error).stack}`);
    return json(500, { error: 'internal error' });
  }
};
