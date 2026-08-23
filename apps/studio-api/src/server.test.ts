import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, startNonOverlappingPolling } from './server.js';

describe('Studio API server', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(['PATCH', 'PUT', 'DELETE'])('allows %s requests from the mobile development origin', async (method) => {
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
