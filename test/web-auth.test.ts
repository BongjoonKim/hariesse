import {
  checkPassword,
  sessionKey,
  signSession,
  verifySession,
  parseCookies,
  sessionCookie,
  loginGate,
  nextLoginState,
  LOGIN_MAX_FAILS,
  LOGIN_LOCK_MS,
  SESSION_TTL_MS,
} from '../src/domain/web-auth';
import { randomBytes } from 'crypto';

const NOW = 1_800_000_000_000;
// 테스트용 값은 실행할 때 만든다 (리터럴로 두면 시크릿 스캐너가 비밀번호로 오인한다)
const PW = randomBytes(12).toString('hex');
const OTHER_PW = randomBytes(12).toString('hex');

describe('checkPassword', () => {
  it('같은 값만 통과', () => {
    expect(checkPassword(PW, PW)).toBe(true);
    expect(checkPassword(PW.slice(0, -1), PW)).toBe(false);
    expect(checkPassword(undefined, PW)).toBe(false);
    expect(checkPassword(12345678, PW)).toBe(false);
  });
  it('시크릿이 비었거나 너무 짧으면 무엇을 넣어도 실패', () => {
    expect(checkPassword('', '')).toBe(false);
    expect(checkPassword('abc', 'abc')).toBe(false);
  });
});

describe('세션 토큰', () => {
  const key = sessionKey(PW);
  it('서명한 토큰은 만료 전까지 유효', () => {
    const token = signSession(key, NOW);
    expect(verifySession(key, token, NOW)).toBe(true);
    expect(verifySession(key, token, NOW + SESSION_TTL_MS - 1)).toBe(true);
    expect(verifySession(key, token, NOW + SESSION_TTL_MS)).toBe(false);
  });
  it('만료 시각이나 서명을 바꾸면 거부', () => {
    const [v, exp, sig] = signSession(key, NOW).split('.');
    expect(verifySession(key, `${v}.${Number(exp) + 1}.${sig}`, NOW)).toBe(false);
    expect(verifySession(key, `${v}.${exp}.${'0'.repeat(64)}`, NOW)).toBe(false);
    expect(verifySession(key, `${v}.${exp}.zz`, NOW)).toBe(false);
  });
  it('비밀번호를 바꾸면 기존 세션은 무효', () => {
    expect(verifySession(sessionKey(OTHER_PW), signSession(key, NOW), NOW)).toBe(false);
  });
  it('토큰이 없거나 형식이 다르면 거부', () => {
    expect(verifySession(key, undefined, NOW)).toBe(false);
    expect(verifySession(key, '', NOW)).toBe(false);
    expect(verifySession(key, 'v2.123.abc', NOW)).toBe(false);
  });
});

describe('쿠키', () => {
  it('헤더에서 이름별로 읽는다', () => {
    expect(parseCookies('a=1; hs=v1.2.3; b=x=y')).toEqual({ a: '1', hs: 'v1.2.3', b: 'x=y' });
    expect(parseCookies(undefined)).toEqual({});
  });
  it('세션 쿠키는 HttpOnly·Secure·SameSite=Strict', () => {
    const c = sessionCookie('tok', 60);
    expect(c).toContain('hs=tok');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Max-Age=60');
  });
});

describe('로그인 잠금', () => {
  it(`${LOGIN_MAX_FAILS}번 틀리면 잠기고, 풀리면 다시 1부터`, () => {
    let state = undefined as ReturnType<typeof nextLoginState> | undefined;
    for (let i = 0; i < LOGIN_MAX_FAILS - 1; i++) state = nextLoginState(state, false, NOW);
    expect(loginGate(state, NOW).allowed).toBe(true);
    state = nextLoginState(state, false, NOW);
    expect(loginGate(state, NOW)).toEqual({ allowed: false, retryAfterSec: LOGIN_LOCK_MS / 1000 });
    expect(loginGate(state, NOW + LOGIN_LOCK_MS).allowed).toBe(true);
    expect(nextLoginState(state, false, NOW + LOGIN_LOCK_MS)).toEqual({ fails: 1 });
  });
  it('성공하면 초기화', () => {
    expect(nextLoginState({ fails: 3 }, true, NOW)).toEqual({ fails: 0 });
  });
});
