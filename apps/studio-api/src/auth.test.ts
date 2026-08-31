import { describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot, UserSnapshot } from '@forgemind/db';
import { createAuthService } from './auth.js';

const owner: UserSnapshot = { id: 'user_local_owner', email: 'owner@example.com', name: 'Owner', role: 'owner' };
const config = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  callbackUrl: 'http://localhost:4000/api/auth/google/callback',
  allowedEmails: new Set(['owner@example.com'])
};

function createAuthRepository() {
  const sessions = new Map<string, AuthSessionSnapshot>();
  return {
    sessions,
    bindGoogleIdentityToLocalUser: vi.fn(async () => owner),
    createAuthSession: vi.fn(async (input: { tokenHash: string; userId: string; expiresAt: string }) => {
      const createdAt = new Date().toISOString();
      const session = { tokenHash: input.tokenHash, user: owner, createdAt, expiresAt: input.expiresAt, lastSeenAt: createdAt };
      sessions.set(input.tokenHash, session);
      return session;
    }),
    getAuthSession: vi.fn(async (tokenHash: string) => sessions.get(tokenHash)),
    touchAuthSession: vi.fn(async () => undefined),
    revokeAuthSession: vi.fn(async (tokenHash: string) => {
      const session = sessions.get(tokenHash);
      if (!session || session.revokedAt) return false;
      session.revokedAt = new Date().toISOString();
      return true;
    })
  };
}

function createGoogleFetch(email = 'owner@example.com'): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ sub: 'google-subject-1', email, email_verified: true, name: 'Owner' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
}

async function login(auth: ReturnType<typeof createAuthService>) {
  const start = auth.startGoogleLogin();
  const state = new URL(start.authUrl).searchParams.get('state')!;
  return auth.completeGoogleCallback({ code: 'google-code', state }, start.stateCookie);
}

describe('AuthService', () => {
  it('accepts a database-backed session after the API service is recreated', async () => {
    const repository = createAuthRepository();
    const issuer = createAuthService(repository as never, config, createGoogleFetch());
    const { session } = await login(issuer);

    const restartedService = createAuthService(repository as never, config, createGoogleFetch());
    await expect(restartedService.getSessionById(session.id)).resolves.toMatchObject({
      userId: owner.id,
      provider: 'google',
      user: owner
    });
  });

  it('rejects a modified session token and an unapproved Google account', async () => {
    const repository = createAuthRepository();
    const auth = createAuthService(repository as never, config, createGoogleFetch());
    const { session } = await login(auth);
    await expect(auth.getSessionById(`${session.id}modified`)).resolves.toBeNull();

    const denied = createAuthService(repository as never, config, createGoogleFetch('other@example.com'));
    await expect(login(denied)).rejects.toThrow('not authorized');
  });

  it('revokes a session on logout', async () => {
    const repository = createAuthRepository();
    const auth = createAuthService(repository as never, config, createGoogleFetch());
    const { session } = await login(auth);

    await expect(auth.logout(session.id)).resolves.toBe(true);
    await expect(auth.getSessionById(session.id)).resolves.toBeNull();
  });
});
