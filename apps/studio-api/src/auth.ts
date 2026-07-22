import { createId, nowIso } from '@forgemind/shared';

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

interface PendingAuthState {
  mode: 'oauth_scaffold';
  createdAt: string;
}

export class AuthService {
  private readonly pendingStates = new Map<string, PendingAuthState>();
  private readonly sessionsByUser = new Map<string, AuthSession>();

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

    const session: AuthSession = {
      id: createId('session'),
      provider: 'github',
      mode: pending.mode,
      userId: user.id,
      createdAt: nowIso(),
      providerAccess: 'pending_token_exchange'
    };

    this.sessionsByUser.set(user.id, session);

    return {
      session,
      user
    };
  }

  logout(userId: string) {
    const hadSession = this.sessionsByUser.delete(userId);
    return {
      userId,
      loggedOut: hadSession
    };
  }

  getSession(userId: string) {
    return this.sessionsByUser.get(userId) ?? null;
  }
}

export function createAuthService() {
  return new AuthService();
}
