import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_DISCOVERY_URL = `${OPENAI_ISSUER}/.well-known/openid-configuration`;
const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';

interface JwtHeader { alg?: string; kid?: string }
export interface ValidatedChatGPTIdentity {
  issuer: string;
  subject: string;
  email?: string;
  expiresAt: string;
}

export async function validateChatGPTIdToken(input: {
  idToken: string;
  clientId: string;
  nonce?: string;
}): Promise<ValidatedChatGPTIdentity> {
  const parts = input.idToken.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT ID token is malformed.');
  const header = decodeJwtPart<JwtHeader>(parts[0]!);
  const claims = decodeJwtPart<Record<string, unknown>>(parts[1]!);
  if (!header.kid || !header.alg) throw new Error('ChatGPT ID token is missing signing metadata.');
  if (!['RS256', 'ES256', 'EdDSA'].includes(header.alg)) throw new Error('ChatGPT ID token uses an unsupported signing algorithm.');
  const discoveryResponse = await fetch(OPENAI_DISCOVERY_URL);
  if (!discoveryResponse.ok) throw new Error(`Could not load OpenAI OIDC discovery metadata (HTTP ${discoveryResponse.status}).`);
  const discovery = await discoveryResponse.json() as { issuer?: string; jwks_uri?: string };
  if (!discovery.jwks_uri || !discovery.issuer) throw new Error('OpenAI OIDC discovery metadata is incomplete.');
  const jwksResponse = await fetch(discovery.jwks_uri);
  if (!jwksResponse.ok) throw new Error(`Could not load OpenAI OIDC signing keys (HTTP ${jwksResponse.status}).`);
  const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
  const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === header.alg));
  if (!jwk) throw new Error('ChatGPT ID token signing key is unavailable.');
  const signature = Buffer.from(parts[2]!, 'base64url');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const valid = header.alg.startsWith('ES')
    ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    : verify(header.alg === 'EdDSA' ? null : 'sha256', data, key, signature);
  if (!valid) throw new Error('ChatGPT ID token signature is invalid.');

  const issuer = stringClaim(claims, 'iss');
  const subject = stringClaim(claims, 'sub');
  const audience = claims.aud;
  const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience.filter((item): item is string => typeof item === 'string') : [];
  const expires = typeof claims.exp === 'number' ? claims.exp : 0;
  if (issuer !== discovery.issuer || issuer !== OPENAI_ISSUER) throw new Error('ChatGPT ID token issuer is invalid.');
  if (!audiences.includes(input.clientId)) throw new Error('ChatGPT ID token audience does not match the issued client.');
  if (!expires || expires * 1_000 <= Date.now()) throw new Error('ChatGPT ID token is expired.');
  if (input.nonce && stringClaim(claims, 'nonce') !== input.nonce) throw new Error('ChatGPT ID token nonce does not match the authorization attempt.');
  return {
    issuer,
    subject,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    expiresAt: new Date(expires * 1_000).toISOString()
  };
}

export async function refreshChatGPTPlanTokens(input: {
  clientId: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
}): Promise<{ accessToken: string; refreshToken: string; idToken: string; scopes: string[]; expiresAt: string }> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource: 'https://api.openai.com/v1'
    })
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(`ChatGPT token refresh failed. HTTP ${response.status}.`) as Error & { status?: number; errorCode?: string };
    error.status = response.status;
    error.errorCode = typeof payload.error === 'string' ? payload.error : undefined;
    throw error;
  }
  const accessToken = requiredString(payload, 'access_token');
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : input.refreshToken;
  const idToken = typeof payload.id_token === 'string' ? payload.id_token : input.idToken;
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : input.scopes;
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
  return { accessToken, refreshToken, idToken, scopes, expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() };
}

function decodeJwtPart<T>(value: string): T {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T; }
  catch { throw new Error('ChatGPT ID token contains invalid JSON.'); }
}

function stringClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== 'string' || !value) throw new Error(`ChatGPT ID token is missing ${name}.`);
  return value;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !candidate) throw new Error(`ChatGPT token response is missing ${key}.`);
  return candidate;
}
