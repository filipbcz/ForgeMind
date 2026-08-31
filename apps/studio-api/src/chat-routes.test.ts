import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerChatRoutes } from './routes/chat-routes.js';

const threadId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const approvalId = '00000000-0000-4000-8000-000000000003';

function createRepository() {
  return {
    getCurrentUser: vi.fn(async () => ({ id: 'user_1' })),
    listChatThreads: vi.fn(async () => []),
    createChatThread: vi.fn(async (input: Record<string, unknown>) => ({ id: threadId, ...input })),
    continueChatThreadWithRepository: vi.fn(async (_id: string, input: Record<string, unknown>) => ({ id: threadId, ...input })),
    getChatThread: vi.fn(async () => ({ id: threadId, title: 'Repository chat' })),
    getChatThreadDetail: vi.fn(async () => ({ thread: { id: threadId }, messages: [], runs: [], approvals: [], events: [] })),
    updateChatThread: vi.fn(async (_id: string, input: Record<string, unknown>) => ({ id: threadId, ...input })),
    deleteChatThread: vi.fn(async () => true),
    appendChatUserMessage: vi.fn(async () => ({ message: { id: 'message_1' }, run: { id: runId, status: 'queued' } })),
    retryChatRun: vi.fn(async () => ({ id: runId, status: 'queued' })),
    cancelChatRun: vi.fn(async () => ({ id: runId, status: 'cancelled' })),
    resolveChatApproval: vi.fn(async (_id: string, status: string) => ({ id: approvalId, status }))
  };
}

describe('chat routes', () => {
  it('creates a persistent thread and queues a user message', async () => {
    const repository = createRepository();
    const app = Fastify();
    registerChatRoutes(app, repository as never);

    const created = await app.inject({
      method: 'POST',
      url: '/api/chat/threads',
      payload: { title: 'Repository chat', repositoryOwner: 'acme', repositoryName: 'service', mode: 'safe' }
    });
    expect(created.statusCode).toBe(201);
    expect(repository.createChatThread).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1', repositoryOwner: 'acme', repositoryName: 'service'
    }));

    const message = await app.inject({
      method: 'POST',
      url: `/api/chat/threads/${threadId}/messages`,
      payload: { content: 'Inspect the failing build.' }
    });
    expect(message.statusCode).toBe(202);
    expect(message.json()).toEqual(expect.objectContaining({ run: expect.objectContaining({ status: 'queued' }) }));
    await app.close();
  });

  it('continues a repository-free conversation in a new repository thread', async () => {
    const repository = createRepository();
    const app = Fastify();
    registerChatRoutes(app, repository as never);

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/threads/${threadId}/continue-with-repository`,
      payload: {
        title: 'Repository continuation',
        repositoryOwner: 'acme',
        repositoryName: 'service',
        baseBranch: 'develop'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(repository.continueChatThreadWithRepository).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        userId: 'user_1',
        repositoryOwner: 'acme',
        repositoryName: 'service',
        baseBranch: 'develop'
      }),
      'user_1'
    );
    await app.close();
  });

  it('requires an exact title before deleting a thread', async () => {
    const repository = createRepository();
    const app = Fastify();
    registerChatRoutes(app, repository as never);

    const rejected = await app.inject({
      method: 'DELETE',
      url: `/api/chat/threads/${threadId}`,
      payload: { confirmation: 'Wrong title' }
    });
    expect(rejected.statusCode).toBe(400);
    expect(repository.deleteChatThread).not.toHaveBeenCalled();

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/chat/threads/${threadId}`,
      payload: { confirmation: 'Repository chat' }
    });
    expect(deleted.statusCode).toBe(200);
    expect(repository.deleteChatThread).toHaveBeenCalledWith(threadId, 'user_1');
    await app.close();
  });

  it('resumes runs after approvals and exposes retry and cancellation', async () => {
    const repository = createRepository();
    const app = Fastify();
    registerChatRoutes(app, repository as never);

    const approved = await app.inject({ method: 'POST', url: `/api/chat/approvals/${approvalId}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(repository.resolveChatApproval).toHaveBeenCalledWith(approvalId, 'approved', 'user_1');

    expect((await app.inject({ method: 'POST', url: `/api/chat/runs/${runId}/retry` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/chat/runs/${runId}/cancel` })).statusCode).toBe(200);
    await app.close();
  });
});
