import { createHmac, timingSafeEqual } from 'node:crypto';
import { createId, nowIso } from '@forgemind/shared';

const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_SESSION_SECRET = 'forgemind-development-session-secret';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'operator';
}

export interface AuthStartResult {
  provider: 'github';
  mode: 'oauth_scaffold';
  state: string;
  authUrl: string;
}

export interface AuthSession {
  id: string;
  provider: 'github';
  mode: 'oauth_scaffold';
  userId: string;
  createdAt: string;
  providerAccess: 'pending_token_exchange';
}

interface SignedSessionPayload {
  version: 1;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface PendingAuthState {
  mode: 'oauth_scaffold';
  createdAt: string;
}

export class AuthService {
  private readonly pendingStates = new Map<string, PendingAuthState>();

  constructor(private readonly sessionSecret: string) {}

  startGitHubLogin(): AuthStartResult {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CALLBACK_URL) {
      throw new Error('GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CALLBACK_URL.');
    }

    const state = createId('auth_state');
    const mode = 'oauth_scaffold';
    this.pendingStates.set(state, {
      mode,
      createdAt: nowIso()
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', process.env.GITHUB_CALLBACK_URL);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);

    return {
      provider: 'github',
      mode,
      state,
      authUrl: url.toString()
    };
  }

  completeGitHubCallback(input: { code?: string; state?: string }, user: AuthUser) {
    if (!input.state) {
      throw new Error('Missing OAuth state.');
    }

    const pending = this.pendingStates.get(input.state);
    if (!pending) {
      throw new Error('Invalid or expired OAuth state.');
    }

    if (!input.code) {
      throw new Error('Missing OAuth code.');
    }

    this.pendingStates.delete(input.state);

    const createdAt = nowIso();
    const session: AuthSession = {
      id: this.signSession({
        version: 1,
        userId: user.id,
        createdAt,
        expiresAt: new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString()
      }),
      provider: 'github',
      mode: pending.mode,
      userId: user.id,
      createdAt,
      providerAccess: 'pending_token_exchange'
    };

    return {
      session,
      user
    };
  }

  logout(userId: string) {
    return {
      userId,
      loggedOut: true
    };
  }

  getSessionById(sessionId: string) {
    const [encodedPayload, encodedSignature] = sessionId.split('.');
    if (!encodedPayload || !encodedSignature) return null;

    const expectedSignature = this.sign(encodedPayload);
    const actualBuffer = Buffer.from(encodedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedSessionPayload;
      if (payload.version !== 1 || !payload.userId || Date.parse(payload.expiresAt) <= Date.now()) return null;
      return {
        id: sessionId,
        provider: 'github' as const,
        mode: 'oauth_scaffold' as const,
        userId: payload.userId,
        createdAt: payload.createdAt,
        providerAccess: 'pending_token_exchange' as const
      };
    } catch {
      return null;
    }
  }

  private signSession(payload: SignedSessionPayload) {
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  private sign(payload: string) {
    return createHmac('sha256', this.sessionSecret).update(payload).digest('base64url');
  }
}

export function createAuthService() {
  const sessionSecret = process.env.FORGEMIND_AUTH_SESSION_SECRET
    ?? process.env.FORGEMIND_CREDENTIAL_KEY;
  if (!sessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('FORGEMIND_AUTH_SESSION_SECRET or FORGEMIND_CREDENTIAL_KEY is required for production authentication.');
  }
  return new AuthService(sessionSecret ?? DEVELOPMENT_SESSION_SECRET);
}
