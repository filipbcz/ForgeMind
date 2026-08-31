import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthSessionSnapshot, ForgeMindRepository, UserSnapshot } from '@forgemind/db';

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DEVELOPMENT_SESSION_SECRET = 'forgemind-development-session-secret';
const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export type AuthUser = UserSnapshot;

export interface AuthStartResult {
  provider: 'google';
  mode: 'oauth';
  authUrl: string;
  stateCookie: string;
}

export interface AuthSession {
  id: string;
  provider: 'google';
  mode: 'oauth';
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthenticatedSession extends AuthSession {
  user: AuthUser;
}

interface OAuthStatePayload {
  version: 1;
  state: string;
  codeVerifier: string;
  expiresAt: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface AuthRepository {
  bindGoogleIdentityToLocalUser(input: { subject: string; email: string; name: string }): Promise<UserSnapshot>;
  createAuthSession(input: { tokenHash: string; userId: string; expiresAt: string }): Promise<AuthSessionSnapshot>;
  getAuthSession(tokenHash: string): Promise<AuthSessionSnapshot | undefined>;
  touchAuthSession(tokenHash: string): Promise<void>;
  revokeAuthSession(tokenHash: string): Promise<boolean>;
}

interface AuthConfiguration {
  clientId?: string;
  clientSecret?: string;
  callbackUrl?: string;
  allowedEmails: Set<string>;
}

export class AuthService {
  private readonly memorySessions = new Map<string, AuthSessionSnapshot>();

  constructor(
    private readonly sessionSecret: string,
    private readonly repository: AuthRepository | undefined,
    private readonly configuration: AuthConfiguration,
    private readonly httpFetch: typeof fetch = fetch
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.configuration.clientId
      && this.configuration.clientSecret
      && this.configuration.callbackUrl
      && this.configuration.allowedEmails.size === 1
    );
  }

  startGoogleLogin(): AuthStartResult {
    const config = this.requireConfiguration();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const stateCookie = this.signOAuthState({
      version: 1,
      state,
      codeVerifier,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()
    });

    const url = new URL(GOOGLE_AUTHORIZATION_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');

    return { provider: 'google', mode: 'oauth', authUrl: url.toString(), stateCookie };
  }

  async completeGoogleCallback(input: { code?: string; state?: string; error?: string }, stateCookie?: string) {
    const config = this.requireConfiguration();
    if (input.error) throw new Error(`Google authentication was not completed: ${input.error}.`);
    if (!input.code || !input.state || !stateCookie) {
      throw new Error('Google OAuth callback is missing required data.');
    }

    const pending = this.verifyOAuthState(stateCookie);
    if (!pending || !safeEqual(input.state, pending.state)) {
      throw new Error('Invalid or expired Google OAuth state.');
    }

    const tokenResponse = await this.httpFetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: 'authorization_code',
        code_verifier: pending.codeVerifier
      })
    });
    const token = await readJson<GoogleTokenResponse>(tokenResponse);
    if (!tokenResponse.ok || !token.access_token) {
      throw new Error(`Google token exchange failed${token.error_description ? `: ${token.error_description}` : '.'}`);
    }

    const userInfoResponse = await this.httpFetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const userInfo = await readJson<GoogleUserInfo>(userInfoResponse);
    if (!userInfoResponse.ok || !userInfo.sub || !userInfo.email || userInfo.email_verified !== true) {
      throw new Error('Google did not return a verified account identity.');
    }

    const email = userInfo.email.trim().toLowerCase();
    if (!this.configuration.allowedEmails.has(email)) {
      throw new Error('This Google account is not authorized to access ForgeMind.');
    }
    if (!this.repository) throw new Error('Persistent authentication storage is not configured.');

    const user = await this.repository.bindGoogleIdentityToLocalUser({
      subject: userInfo.sub,
      email,
      name: userInfo.name?.trim() || email
    });
    const session = await this.issueSession(user);
    return { session, user };
  }

  async getSessionById(sessionId: string): Promise<AuthenticatedSession | null> {
    if (!isSessionToken(sessionId)) return null;
    const tokenHash = hashSessionToken(sessionId);
    const stored = this.repository
      ? await this.repository.getAuthSession(tokenHash)
      : this.memorySessions.get(tokenHash);
    if (!stored || stored.revokedAt || Date.parse(stored.expiresAt) <= Date.now()) return null;

    if (Date.now() - Date.parse(stored.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS) {
      if (this.repository) await this.repository.touchAuthSession(tokenHash);
      else stored.lastSeenAt = new Date().toISOString();
    }

    return {
      id: sessionId,
      provider: 'google',
      mode: 'oauth',
      userId: stored.user.id,
      user: stored.user,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt
    };
  }

  async logout(sessionId: string): Promise<boolean> {
    if (!isSessionToken(sessionId)) return false;
    const tokenHash = hashSessionToken(sessionId);
    if (this.repository) return this.repository.revokeAuthSession(tokenHash);
    const stored = this.memorySessions.get(tokenHash);
    if (!stored || stored.revokedAt) return false;
    stored.revokedAt = new Date().toISOString();
    return true;
  }

  createTestSession(user: AuthUser): AuthSession {
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();
    const tokenHash = hashSessionToken(token);
    this.memorySessions.set(tokenHash, { tokenHash, user, createdAt, expiresAt, lastSeenAt: createdAt });
    return { id: token, provider: 'google', mode: 'oauth', userId: user.id, createdAt, expiresAt };
  }

  private async issueSession(user: AuthUser): Promise<AuthSession> {
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString();
    await this.repository!.createAuthSession({ tokenHash: hashSessionToken(token), userId: user.id, expiresAt });
    return { id: token, provider: 'google', mode: 'oauth', userId: user.id, createdAt, expiresAt };
  }

  private requireConfiguration(): Required<Omit<AuthConfiguration, 'allowedEmails'>> & { allowedEmails: Set<string> } {
    if (!this.isConfigured()) {
      throw new Error('Google authentication is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_CALLBACK_URL and one FORGEMIND_GOOGLE_ALLOWED_EMAIL.');
    }
    return this.configuration as Required<Omit<AuthConfiguration, 'allowedEmails'>> & { allowedEmails: Set<string> };
  }

  private signOAuthState(payload: OAuthStatePayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${this.sign(encoded)}`;
  }

  private verifyOAuthState(token: string): OAuthStatePayload | null {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature || !safeEqual(signature, this.sign(encoded))) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OAuthStatePayload;
      if (payload.version !== 1 || !payload.state || !payload.codeVerifier || Date.parse(payload.expiresAt) <= Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.sessionSecret).update(payload).digest('base64url');
  }
}

export function createAuthService(
  repository?: ForgeMindRepository,
  overrides: Partial<AuthConfiguration> = {},
  httpFetch: typeof fetch = fetch
) {
  const sessionSecret = process.env.FORGEMIND_AUTH_SESSION_SECRET ?? process.env.FORGEMIND_CREDENTIAL_KEY;
  const googleConfigurationPresent = Boolean(
    overrides.clientId
    || overrides.clientSecret
    || overrides.callbackUrl
    || process.env.GOOGLE_OAUTH_CLIENT_ID
    || process.env.GOOGLE_OAUTH_CLIENT_SECRET
    || process.env.GOOGLE_OAUTH_CALLBACK_URL
  );
  if (!sessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('FORGEMIND_AUTH_SESSION_SECRET or FORGEMIND_CREDENTIAL_KEY is required for production authentication.');
  }
  if (!sessionSecret && googleConfigurationPresent && process.env.NODE_ENV !== 'test') {
    throw new Error('FORGEMIND_AUTH_SESSION_SECRET is required when Google authentication is configured.');
  }
  return new AuthService(
    sessionSecret ?? DEVELOPMENT_SESSION_SECRET,
    repository,
    {
      clientId: overrides.clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(),
      clientSecret: overrides.clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(),
      callbackUrl: overrides.callbackUrl ?? process.env.GOOGLE_OAUTH_CALLBACK_URL?.trim(),
      allowedEmails: overrides.allowedEmails ?? parseAllowedEmails(process.env.FORGEMIND_GOOGLE_ALLOWED_EMAIL)
    },
    httpFetch
  );
}

function parseAllowedEmails(value: string | undefined): Set<string> {
  const email = value?.trim().toLowerCase();
  return new Set(email ? [email] : []);
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isSessionToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    return {} as T;
  }
}
