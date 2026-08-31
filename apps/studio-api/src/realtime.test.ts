import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createAuthService } from './auth.js';
import { registerRealtimeGateway } from './realtime.js';

describe('realtime gateway authorization', () => {
  it('rejects anonymous sockets and publishes only to an owned chat subscription', async () => {
    const auth = createAuthService();
    const session = auth.createTestSession({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' });
    const repository = {
      getChatThread: vi.fn(async (threadId: string, userId: string) => threadId === 'thread_1' && userId === 'user_1' ? { id: threadId } : undefined),
      getTask: vi.fn(async () => undefined)
    };
    const app = Fastify();
    const realtime = registerRealtimeGateway(app, repository as never, auth);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = address.replace(/^http/, 'ws');

    const anonymousStatus = await rejectedUpgradeStatus(`${baseUrl}/ws?chatThreadId=thread_1`);
    expect(anonymousStatus).toBe(401);

    const socket = new WebSocket(`${baseUrl}/ws?chatThreadId=thread_1`, {
      headers: { cookie: `forgemind_session=${encodeURIComponent(session.id)}` }
    });
    const connectedPromise = waitForMessage(socket);
    await waitForOpen(socket);
    await connectedPromise;
    const eventPromise = waitForMessage(socket);
    realtime.publishAuditEvent({
      id: 'audit_1', actorType: 'agent', eventType: 'chat_provider_activity',
      chatThreadId: 'thread_1', payload: { title: 'AI pracuje' }, createdAt: new Date().toISOString()
    });
    const event = JSON.parse(await eventPromise) as { type: string; event?: { id: string } };
    expect(event).toMatchObject({ type: 'audit_event', event: { id: 'audit_1' } });

    socket.close();
    await app.close();
  });
});

function rejectedUpgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for rejected WebSocket upgrade.')), 3_000);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', () => undefined);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message.')), 3_000);
    socket.once('message', (data) => {
      clearTimeout(timeout);
      resolve(data.toString());
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
