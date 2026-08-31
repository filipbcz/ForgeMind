import type { FastifyInstance } from 'fastify';
import type { ForgeMindRepository } from '@forgemind/db';
import { z } from 'zod';

const idParamsSchema = z.object({ id: z.string().uuid() });
const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  projectId: z.string().uuid().optional(),
  providerConnectionId: z.string().uuid().optional(),
  mode: z.enum(['safe', 'auto', 'full_auto']).optional(),
  repositoryOwner: z.string().trim().min(1).max(120).optional(),
  repositoryName: z.string().trim().min(1).max(120).optional(),
  baseBranch: z.string().trim().min(1).max(200).optional()
}).refine((value) => Boolean(value.repositoryOwner) === Boolean(value.repositoryName), {
  message: 'Repository owner and name must be configured together.'
});
const updateThreadSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  projectId: z.string().uuid().nullable().optional(),
  providerConnectionId: z.string().uuid().nullable().optional(),
  mode: z.enum(['safe', 'auto', 'full_auto']).optional(),
  repositoryOwner: z.string().trim().min(1).max(120).nullable().optional(),
  repositoryName: z.string().trim().min(1).max(120).nullable().optional(),
  baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
  branchName: z.string().trim().min(1).max(200).nullable().optional(),
  status: z.enum(['active', 'archived']).optional()
});
const createMessageSchema = z.object({ content: z.string().trim().min(1).max(100_000) });
const deleteThreadSchema = z.object({ confirmation: z.string().min(1) });

export function registerChatRoutes(app: FastifyInstance, repository: ForgeMindRepository) {
  app.get('/api/chat/threads', async (request) => {
    const query = z.object({ includeArchived: z.coerce.boolean().optional().default(false) }).parse(request.query);
    const user = await repository.getCurrentUser();
    return repository.listChatThreads(user.id, query.includeArchived);
  });

  app.post('/api/chat/threads', async (request, reply) => {
    try {
      const input = createThreadSchema.parse(request.body);
      const user = await repository.getCurrentUser();
      const thread = await repository.createChatThread({ ...input, userId: user.id });
      return reply.code(201).send(thread);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/chat/threads/:id/continue-with-repository', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = createThreadSchema.parse(request.body);
      const user = await repository.getCurrentUser();
      const thread = await repository.continueChatThreadWithRepository(id, { ...input, userId: user.id }, user.id);
      return thread
        ? reply.code(201).send(thread)
        : reply.code(404).send({ error: `Chat thread "${id}" not found.` });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/chat/threads/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const user = await repository.getCurrentUser();
    const detail = await repository.getChatThreadDetail(id, user.id);
    return detail ?? reply.code(404).send({ error: `Chat thread "${id}" not found.` });
  });

  app.patch('/api/chat/threads/:id', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = updateThreadSchema.parse(request.body);
      const user = await repository.getCurrentUser();
      const thread = await repository.updateChatThread(id, input, user.id);
      return thread ?? reply.code(404).send({ error: `Chat thread "${id}" not found.` });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.delete('/api/chat/threads/:id', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = deleteThreadSchema.parse(request.body);
      const user = await repository.getCurrentUser();
      const thread = await repository.getChatThread(id, user.id);
      if (!thread) return reply.code(404).send({ error: `Chat thread "${id}" not found.` });
      if (input.confirmation.trim() !== thread.title) {
        return reply.code(400).send({ error: 'Thread title confirmation does not match.' });
      }
      await repository.deleteChatThread(id, user.id);
      return { deleted: true, threadId: id };
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/chat/threads/:id/messages', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = createMessageSchema.parse(request.body);
      const user = await repository.getCurrentUser();
      const created = await repository.appendChatUserMessage(id, input.content, user.id);
      return reply.code(202).send(created);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/chat/runs/:id/retry', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const user = await repository.getCurrentUser();
      const run = await repository.retryChatRun(id, user.id);
      return run ?? reply.code(404).send({ error: `Chat run "${id}" not found.` });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/chat/runs/:id/cancel', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const user = await repository.getCurrentUser();
      const run = await repository.cancelChatRun(id, user.id);
      return run ?? reply.code(404).send({ error: `Chat run "${id}" not found.` });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/chat/approvals/:id/:decision', async (request, reply) => {
    try {
      const params = z.object({ id: z.string().uuid(), decision: z.enum(['approve', 'reject']) }).parse(request.params);
      const user = await repository.getCurrentUser();
      const approval = await repository.resolveChatApproval(
        params.id,
        params.decision === 'approve' ? 'approved' : 'rejected',
        user.id
      );
      return approval ?? reply.code(404).send({ error: `Chat approval "${params.id}" not found.` });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });
}

function sendBadRequest(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Invalid request.', issues: error.issues });
  }
  return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
}
