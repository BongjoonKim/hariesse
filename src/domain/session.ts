import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * 웹 세션 — HS256 서명 토큰(JWT와 같은 모양, 라이브러리 없이 crypto만).
 * 순수함수라 단위테스트 대상. 서명키는 Secrets `hariesse/session-secret`.
 *
 * 1인용이라 세션 저장소를 두지 않는다. 무효화가 필요하면 서명키를 바꾸면 된다.
 */

export interface SessionPayload {
  /** Google sub */
  sub: string;
  email: string;
  /** 만료 (epoch 초) */
  exp: number;
}

export const SESSION_COOKIE = 'hs_session';
export const PKCE_COOKIE = 'hs_pkce';
export const SESSION_TTL_SEC = 12 * 60 * 60;

const b64url = (buf: Buffer | string): string =>
  (Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')).toString('base64url');

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body, secret)}`;
}

/** 서명·만료가 모두 유효할 때만 payload. 그 외에는 undefined (이유를 구분하지 않는다). */
export function verifySession(
  token: string | undefined,
  secret: string,
  nowSec: number
): SessionPayload | undefined {
  if (!token || !secret) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmac(body, secret))) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return undefined;
    if (typeof payload.email !== 'string' || !payload.email) return undefined;
    if (typeof payload.sub !== 'string' || !payload.sub) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

// ---- 쿠키 ----

/** Lambda Function URL v2는 쿠키를 `["k=v", …]`로 준다. 헤더 문자열도 같이 받는다. */
export function parseCookies(
  cookies: string[] | undefined,
  cookieHeader?: string
): Record<string, string> {
  const parts = cookies && cookies.length > 0 ? cookies : (cookieHeader ?? '').split(';');
  const out: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * HttpOnly + Secure + SameSite=Lax.
 * Lax면 크로스 사이트 POST에 쿠키가 실리지 않아 CSRF 방어가 된다 (API가 동일 오리진이라 가능).
 */
export function setCookie(name: string, value: string, maxAgeSec: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ].join('; ');
}

export const clearCookie = (name: string): string => setCookie(name, '', 0);

// ---- PKCE ----

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url'); // 64자 — RFC 7636 43~128 범위
  return { verifier, challenge: pkceChallenge(verifier), state: randomBytes(16).toString('base64url') };
}

/** PKCE 왕복도 서명해서 쿠키에 담는다 (10분짜리 세션과 같은 구조). */
export interface PkceCookie {
  verifier: string;
  state: string;
  exp: number;
}

export function signPkce(value: PkceCookie, secret: string): string {
  const body = b64url(JSON.stringify(value));
  return `${body}.${hmac(body, secret)}`;
}

export function verifyPkce(
  token: string | undefined,
  secret: string,
  nowSec: number
): PkceCookie | undefined {
  if (!token || !secret) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmac(body, secret))) return undefined;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PkceCookie;
    if (typeof value.exp !== 'number' || value.exp <= nowSec) return undefined;
    if (!value.verifier || !value.state) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** 허용 이메일 비교 — 대소문자·공백 무시. 비어 있으면 아무도 통과시키지 않는다. */
export function isAllowedEmail(email: string | undefined, allowList: string): boolean {
  if (!email) return false;
  const allowed = allowList
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(email.trim().toLowerCase());
}
