import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  createApp,
  registerErrorRedaction,
  registerHttpGuardrails,
  startNonOverlappingPolling,
  validateProductionHttpSecurityConfig
} from './server.js';

const guardedEnvNames = [
  'NODE_ENV',
  'FORGEMIND_CORS_ORIGINS',
  'FORGEMIND_AUTH_SESSION_SECRET',
  'FORGEMIND_SESSION_COOKIE_SECURE',
  'FORGEMIND_SENSITIVE_RATE_LIMIT_MAX',
  'FORGEMIND_SENSITIVE_RATE_LIMIT_WINDOW_MS',
  'FORGEMIND_REQUEST_BODY_LIMIT_BYTES',
  'FORGEMIND_REQUEST_HEADER_LIMIT_BYTES',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_CALLBACK_URL',
  'FORGEMIND_GOOGLE_ALLOWED_EMAIL'
] as const;

const originalEnv = new Map(guardedEnvNames.map((name) => [name, process.env[name]]));

function useDevelopmentHttpEnv() {
  process.env.NODE_ENV = 'test';
  delete process.env.FORGEMIND_CORS_ORIGINS;
  delete process.env.FORGEMIND_SESSION_COOKIE_SECURE;
}

describe('Studio API server', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const name of guardedEnvNames) {
      const value = originalEnv.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it.each(['PATCH', 'PUT', 'DELETE'])('allows %s requests from the mobile development origin', async (method) => {
    useDevelopmentHttpEnv();
    app = await createApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects/project_1',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type'
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-methods']).toContain(method);
  });

  it('does not allow credentialed API requests from arbitrary origins', async () => {
    useDevelopmentHttpEnv();
    app = await createApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects/project_1',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type'
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('redacts credentials from uncaught application errors', async () => {
    app = Fastify({ logger: false });
    registerErrorRedaction(app);
    app.get('/failure', async () => {
      throw new Error('Provider failed with Authorization: Bearer sk-server_1234567890abcdef');
    });

    const response = await app.inject({ method: 'GET', url: '/failure' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('[secret-redacted]');
    expect(response.body).not.toContain('sk-server_1234567890abcdef');
  });

  it('fails production startup when required HTTP security config is missing or unsafe', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.FORGEMIND_CORS_ORIGINS;
    process.env.FORGEMIND_SESSION_COOKIE_SECURE = 'true';

    expect(() => validateProductionHttpSecurityConfig()).toThrow(/FORGEMIND_CORS_ORIGINS/);

    process.env.FORGEMIND_CORS_ORIGINS = 'not a valid origin';
    expect(() => validateProductionHttpSecurityConfig()).toThrow(/valid origins/);

    process.env.FORGEMIND_CORS_ORIGINS = 'http://localhost:5173';
    expect(() => validateProductionHttpSecurityConfig()).toThrow(/https/);

    process.env.FORGEMIND_CORS_ORIGINS = 'https://studio.example';
    process.env.FORGEMIND_SESSION_COOKIE_SECURE = 'false';
    expect(() => validateProductionHttpSecurityConfig()).toThrow(/FORGEMIND_SESSION_COOKIE_SECURE/);
  });

  it('allows only configured CORS origins in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FORGEMIND_CORS_ORIGINS = 'https://studio.example';
    process.env.FORGEMIND_SESSION_COOKIE_SECURE = 'true';
    process.env.FORGEMIND_AUTH_SESSION_SECRET = 'production-test-session-secret';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'google-client-secret';
    process.env.GOOGLE_OAUTH_CALLBACK_URL = 'https://studio.example/api/auth/google/callback';
    process.env.FORGEMIND_GOOGLE_ALLOWED_EMAIL = 'owner@example.com';
    app = await createApp();

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects/project_1',
      headers: {
        origin: 'https://studio.example',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type,x-forgemind-csrf'
      }
    });
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/api/projects/project_1',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type,x-forgemind-csrf'
      }
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://studio.example');
    expect(denied.statusCode).toBe(404);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('enforces rate limits for sensitive endpoints before handlers execute', async () => {
    process.env.FORGEMIND_SENSITIVE_RATE_LIMIT_MAX = '1';
    process.env.FORGEMIND_SENSITIVE_RATE_LIMIT_WINDOW_MS = '60000';
    app = Fastify();
    const handler = vi.fn(async () => ({ ok: true }));
    await registerHttpGuardrails(app);
    app.post('/api/tasks', handler);

    const first = await app.inject({ method: 'POST', url: '/api/tasks' });
    const second = await app.inject({ method: 'POST', url: '/api/tasks' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('requires CSRF protection for browser-originated mutations before handlers execute', async () => {
    useDevelopmentHttpEnv();
    app = Fastify();
    const handler = vi.fn(async () => ({ ok: true }));
    await registerHttpGuardrails(app);
    app.patch('/api/projects/project_1', handler);

    const rejectedWithOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers: { origin: 'http://localhost:5173' },
      payload: { name: 'Changed project' }
    });
    const rejectedWithCookie = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers: { cookie: 'forgemind_session=session_1' },
      payload: { name: 'Changed project' }
    });
    const accepted = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers: { origin: 'http://localhost:5173', 'x-forgemind-csrf': '1' },
      payload: { name: 'Changed project' }
    });

    expect(rejectedWithOrigin.statusCode).toBe(403);
    expect(rejectedWithCookie.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects oversized requests before handlers execute', async () => {
    app = Fastify({ bodyLimit: 32 });
    const handler = vi.fn(async () => ({ ok: true }));
    await registerHttpGuardrails(app);
    app.post('/api/tasks', handler);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { 'content-type': 'application/json' },
      payload: { prompt: 'x'.repeat(128) }
    });

    expect(response.statusCode).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects oversized headers before handlers execute', async () => {
    process.env.FORGEMIND_REQUEST_HEADER_LIMIT_BYTES = '64';
    app = Fastify();
    const handler = vi.fn(async () => ({ ok: true }));
    await registerHttpGuardrails(app);
    app.get('/api/projects', handler);

    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { 'x-large-header': 'x'.repeat(128) }
    });

    expect(response.statusCode).toBe(431);
    expect(handler).not.toHaveBeenCalled();
  });

  it('sets security headers on HTTP responses', async () => {
    app = Fastify();
    await registerHttpGuardrails(app);
    app.get('/health', async () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('does not overlap notification polling while a database query is still running', async () => {
    vi.useFakeTimers();
    let finishPoll: (() => void) | undefined;
    const poll = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishPoll = resolve;
        })
    );
    const stop = startNonOverlappingPolling(poll, 100);

    try {
      await vi.advanceTimersByTimeAsync(350);
      expect(poll).toHaveBeenCalledOnce();

      finishPoll?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(poll).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      finishPoll?.();
      vi.useRealTimers();
    }
  });
});
