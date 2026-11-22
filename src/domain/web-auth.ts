import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * 웹 로그인 (순수함수, 테스트 대상). 혼자 쓰는 사이트라 비밀번호 1개 + 서명된 세션 쿠키.
 * - 세션 토큰: `v1.<만료 epoch ms>.<HMAC-SHA256 hex>`. 서명 키는 비밀번호에서 만들므로
 *   비밀번호를 바꾸면 기존 세션이 전부 무효가 된다 (따로 세션 저장소를 두지 않는다).
 * - 무차별 대입 방지: 연속 실패 LOGIN_MAX_FAILS회면 LOGIN_LOCK_MS 동안 잠근다 (상태는 학습 테이블에 저장).
 */

export const SESSION_COOKIE = 'hs';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILS = 5;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;
/** 이보다 짧은 비밀번호로는 로그인을 열지 않는다 (시크릿이 비었거나 잘못 들어간 경우 대비). */
export const MIN_PASSWORD_LENGTH = 8;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** 비밀번호 비교 — 길이·내용 차이가 시간으로 새지 않게 해시끼리 비교한다. */
export function checkPassword(input: unknown, actual: string): boolean {
  if (typeof input !== 'string' || actual.length < MIN_PASSWORD_LENGTH) return false;
  return timingSafeEqual(digest(input), digest(actual));
}

export function sessionKey(password: string): Buffer {
  return createHmac('sha256', password).update('hariesse-web-session-v1').digest();
}

function sign(key: Buffer, exp: number): string {
  return createHmac('sha256', key).update(`v1.${exp}`).digest('hex');
}

export function signSession(key: Buffer, now: number, ttlMs: number = SESSION_TTL_MS): string {
  const exp = now + ttlMs;
  return `v1.${exp}.${sign(key, exp)}`;
}

export function verifySession(key: Buffer, token: string | undefined, now: number): boolean {
  const m = /^v1\.(\d{1,16})\.([0-9a-f]{64})$/.exec(token ?? '');
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  return timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(sign(key, exp), 'hex'));
}

/** Cookie 헤더(또는 Function URL의 cookies 배열을 '; '로 이은 것) → 이름별 값. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
}

export interface LoginState {
  fails: number;
  /** 이 시각(epoch ms)까지 로그인 시도를 받지 않는다 */
  lockedUntil?: number;
}

/** 지금 로그인 시도를 받아도 되는지. 잠겨 있으면 남은 초. */
export function loginGate(state: LoginState | undefined, now: number): { allowed: boolean; retryAfterSec: number } {
  const until = state?.lockedUntil ?? 0;
  return until > now ? { allowed: false, retryAfterSec: Math.ceil((until - now) / 1000) } : { allowed: true, retryAfterSec: 0 };
}

/** 시도 결과를 반영한 다음 상태. 성공하면 초기화, 실패가 쌓이면 잠근다. */
export function nextLoginState(state: LoginState | undefined, success: boolean, now: number): LoginState {
  if (success) return { fails: 0 };
  // 잠금이 풀린 뒤의 첫 실패는 1부터 다시 센다
  const fails = (state?.lockedUntil ? 0 : state?.fails ?? 0) + 1;
  return fails >= LOGIN_MAX_FAILS ? { fails, lockedUntil: now + LOGIN_LOCK_MS } : { fails };
}
