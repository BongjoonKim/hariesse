/**
 * Google OAuth 2.0 (Authorization Code + PKCE).
 * 1인용이라 Cognito를 두지 않고 여기서 직접 처리한다 — Phase C의 Calendar 권한도
 * 같은 동의 흐름에 얹으면 되므로 부품이 가장 적다. (docs/ASSISTANT.md §2)
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Phase C에서 `https://www.googleapis.com/auth/calendar.events`를 여기에 추가한다(재동의 1회 필요). */
export const GOOGLE_SCOPES = ['openid', 'email', 'profile'] as const;

export interface GoogleOAuthSecret {
  clientId: string;
  clientSecret: string;
}

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent', // refresh token을 매번 받도록 (Phase C 대비)
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: opts.codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google 토큰 교환 실패 ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export interface IdTokenClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * id_token payload 디코드.
 * 서명 검증을 생략하는 이유: 이 토큰은 브라우저를 거치지 않고 TLS로 Google 토큰
 * 엔드포인트에서 직접 받아온 것이다 (Google 문서가 명시적으로 허용하는 경우).
 * 프론트엔드에서 받은 토큰이라면 반드시 검증해야 한다.
 */
export function decodeIdToken(idToken: string | undefined): IdTokenClaims | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    return undefined;
  }
}
