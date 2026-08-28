import { afterEach, describe, expect, it } from 'vitest';
import { createAuthService } from './auth.js';

const previousSessionSecret = process.env.FORGEMIND_AUTH_SESSION_SECRET;
const previousClientId = process.env.GITHUB_CLIENT_ID;
const previousCallbackUrl = process.env.GITHUB_CALLBACK_URL;

afterEach(() => {
  if (previousSessionSecret === undefined) delete process.env.FORGEMIND_AUTH_SESSION_SECRET;
  else process.env.FORGEMIND_AUTH_SESSION_SECRET = previousSessionSecret;
  if (previousClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = previousClientId;
  if (previousCallbackUrl === undefined) delete process.env.GITHUB_CALLBACK_URL;
  else process.env.GITHUB_CALLBACK_URL = previousCallbackUrl;
});

describe('AuthService', () => {
  it('accepts a signed session after the API service is recreated', () => {
    process.env.FORGEMIND_AUTH_SESSION_SECRET = 'persistent-test-secret';
    process.env.GITHUB_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:4000/api/auth/github/callback';
    const issuer = createAuthService();
    const login = issuer.startGitHubLogin();
    const { session } = issuer.completeGitHubCallback(
      { code: 'test-code', state: login.state },
      { id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' }
    );

    const restartedService = createAuthService();
    expect(restartedService.getSessionById(session.id)).toMatchObject({
      userId: 'user_1',
      provider: 'github'
    });
  });

  it('rejects a modified session token', () => {
    process.env.FORGEMIND_AUTH_SESSION_SECRET = 'persistent-test-secret';
    process.env.GITHUB_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:4000/api/auth/github/callback';
    const auth = createAuthService();
    const login = auth.startGitHubLogin();
    const { session } = auth.completeGitHubCallback(
      { code: 'test-code', state: login.state },
      { id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' }
    );

    expect(auth.getSessionById(`${session.id}modified`)).toBeNull();
  });
});
