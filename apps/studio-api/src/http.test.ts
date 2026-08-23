import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { sendBadRequest } from './http.js';

describe('HTTP error responses', () => {
  it('redacts credentials from application errors before display', async () => {
    const app = Fastify();
    app.get('/failure', async (_request, reply) => {
      return sendBadRequest(reply, new Error('Provider failed with Authorization: Bearer sk-http_1234567890abcdef'));
    });

    const response = await app.inject({ method: 'GET', url: '/failure' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('[secret-redacted]');
    expect(response.body).not.toContain('sk-http_1234567890abcdef');
    await app.close();
  });
});
