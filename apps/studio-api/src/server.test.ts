import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './server.js';

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
});
