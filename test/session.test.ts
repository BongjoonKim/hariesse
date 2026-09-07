import { createHash } from 'crypto';
import {
  PKCE_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  createPkce,
  isAllowedEmail,
  parseCookies,
  pkceChallenge,
  setCookie,
  signPkce,
  signSession,
  verifyPkce,
  verifySession,
} from '../src/domain/session';

const SECRET = 'test-secret-value';
const NOW = 1_800_000_000;

describe('세션 토큰', () => {
  const payload = { sub: '10842', email: 'me@example.com', exp: NOW + 3600 };

  it('서명 왕복', () => {
    const token = signSession(payload, SECRET);
    expect(verifySession(token, SECRET, NOW)).toEqual(payload);
  });

  it('다른 키로 서명된 토큰은 거부', () => {
    expect(verifySession(signSession(payload, 'other'), SECRET, NOW)).toBeUndefined();
  });

  it('본문을 바꾸면 서명이 깨진다', () => {
    const token = signSession(payload, SECRET);
    const [body, sig] = token.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, email: 'attacker@example.com' })
    ).toString('base64url');
    expect(verifySession(`${tampered}.${sig}`, SECRET, NOW)).toBeUndefined();
    expect(body).not.toBe(tampered);
  });

  it('만료된 토큰은 거부', () => {
    const token = signSession({ ...payload, exp: NOW - 1 }, SECRET);
    expect(verifySession(token, SECRET, NOW)).toBeUndefined();
  });

  it('형식이 깨진 값은 조용히 거부', () => {
    for (const bad of [undefined, '', 'abc', 'a.b.c', '.sig']) {
      expect(verifySession(bad, SECRET, NOW)).toBeUndefined();
    }
  });

  it('서명키가 비어 있으면 무조건 거부 (Secrets 미설정 시 통과 방지)', () => {
    expect(verifySession(signSession(payload, ''), '', NOW)).toBeUndefined();
  });
});

describe('PKCE', () => {
  it('challenge는 verifier의 SHA-256 base64url', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(pkceChallenge('abc')).toBe(createHash('sha256').update('abc').digest('base64url'));
  });

  it('verifier 길이가 RFC 7636 범위(43~128)', () => {
    const { verifier } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('쿠키 왕복과 만료', () => {
    const value = { verifier: 'v', state: 's', exp: NOW + 600 };
    const token = signPkce(value, SECRET);
    expect(verifyPkce(token, SECRET, NOW)).toEqual(value);
    expect(verifyPkce(token, SECRET, NOW + 601)).toBeUndefined();
    expect(verifyPkce(token, 'other', NOW)).toBeUndefined();
  });
});

describe('쿠키', () => {
  it('Function URL의 배열 형식을 파싱', () => {
    expect(parseCookies([`${SESSION_COOKIE}=abc`, `${PKCE_COOKIE}=def`])).toEqual({
      [SESSION_COOKIE]: 'abc',
      [PKCE_COOKIE]: 'def',
    });
  });

  it('헤더 문자열도 파싱', () => {
    expect(parseCookies(undefined, 'a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('값에 = 가 들어가도 잘린 앞부분만 이름으로', () => {
    expect(parseCookies(['t=aa.bb=='])).toEqual({ t: 'aa.bb==' });
  });

  it('보안 속성이 붙는다', () => {
    const c = setCookie('x', 'y', 60);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Max-Age=60');
    expect(clearCookie('x')).toContain('Max-Age=0');
  });
});

describe('허용 이메일', () => {
  it('대소문자·공백을 무시하고 비교', () => {
    expect(isAllowedEmail('Me@Example.com', ' me@example.com ')).toBe(true);
    expect(isAllowedEmail('me@example.com', 'a@b.com, me@example.com')).toBe(true);
  });

  it('목록이 비면 아무도 통과시키지 않는다', () => {
    expect(isAllowedEmail('me@example.com', '')).toBe(false);
    expect(isAllowedEmail('me@example.com', '  , ')).toBe(false);
  });

  it('없는 이메일은 거부', () => {
    expect(isAllowedEmail(undefined, 'me@example.com')).toBe(false);
    expect(isAllowedEmail('other@example.com', 'me@example.com')).toBe(false);
  });
});
