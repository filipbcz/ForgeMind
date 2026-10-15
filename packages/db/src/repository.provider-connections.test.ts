import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from './credentials.js';
import { ForgeMindRepository } from './repository.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AI provider connection renewal', () => {
  it('serializes an expired ChatGPT-plan refresh without deserializing the PostgreSQL void lock result', async () => {
    vi.stubEnv('FORGEMIND_CREDENTIAL_KEY', 'provider-refresh-test-key');
    const expired = {
      id: 'plan-connection',
      userId: 'user_local_owner',
      name: 'ChatGPT plan',
      isDefault: false,
      provider: 'codex',
      authMode: 'chatgpt_plan_oauth',
      model: 'gpt-6.1-sol',
      allowedModels: ['gpt-6.1-sol'],
      apiKeyCiphertext: null,
      apiKeyFingerprint: null,
      codexHome: null,
      accountSummary: 'test@example.com',
      automaticFailover: true,
      failoverPriority: 100,
      oauthClientId: 'issued-client-id',
      oauthSubject: 'subject',
      oauthIssuer: 'https://auth.openai.com',
      oauthHostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      oauthScopes: ['openid', 'offline_access', 'chatgpt_plan'],
      oauthAccessTokenCiphertext: await encryptSecret('expired-access'),
      oauthRefreshTokenCiphertext: await encryptSecret('current-refresh'),
      oauthIdTokenCiphertext: await encryptSecret('current-id-token'),
      oauthExpiresAt: new Date(Date.now() - 60_000),
      connectedAt: new Date('2026-10-14T08:18:14.581Z'),
      lastCheckedAt: new Date('2026-10-14T08:18:14.578Z'),
      createdAt: new Date('2026-10-14T08:18:14.581Z'),
      updatedAt: new Date('2026-10-14T08:18:14.581Z')
    } as any;
    const executeRaw = vi.fn(async () => 1);
    const update = vi.fn(async ({ data }: any) => ({ ...expired, ...data, updatedAt: new Date() }));
    const tx = {
      $executeRaw: executeRaw,
      aiProviderConnection: {
        findUnique: vi.fn(async () => expired),
        update
      }
    };
    const prisma = {
      aiProviderConnection: { findMany: vi.fn(async () => [expired]) },
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx))
    };
    const request = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      access_token: 'replacement-access',
      refresh_token: 'replacement-refresh',
      id_token: 'replacement-id-token',
      expires_in: 3600,
      scope: 'openid offline_access chatgpt_plan'
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);

    const [connection] = await new ForgeMindRepository(prisma as any).listAIProviderConnectionSecrets();

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('https://auth.openai.com/api/accounts/oauth/token', expect.objectContaining({
      method: 'POST'
    }));
    const body = new URLSearchParams(request.mock.calls[0]?.[1]?.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'issued-client-id',
      refresh_token: 'current-refresh',
      resource: 'https://api.openai.com/v1'
    });
    expect(connection).toMatchObject({
      id: 'plan-connection',
      accessToken: 'replacement-access',
      refreshToken: 'replacement-refresh',
      idToken: 'replacement-id-token'
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'plan-connection' },
      data: expect.objectContaining({ lastCheckedAt: expect.any(Date) })
    }));
  });
});
