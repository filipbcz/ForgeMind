import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendBadRequest, sendNotFound } from './http.js';
import type { ForgeMindRepository } from '@forgemind/db';
import { verifyGitHubWebhookSignature } from './webhook.js';

const projectSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  githubOwner: z.string().min(1),
  githubRepo: z.string().min(1),
  defaultBranch: z.string().min(1).default('main'),
  configYaml: z.string().optional()
});

const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(3),
  prompt: z.string().min(10),
  mode: z.enum(['safe', 'auto', 'full_auto']).default('safe'),
  maxIterations: z.number().int().min(1).max(50).default(10),
  maxBudgetUsd: z.number().min(0).max(100).default(2)
});

const idParamsSchema = z.object({
  id: z.string().min(1)
});

const commentSchema = z.object({
  comment: z.string().min(1)
});

const retrySchema = z.object({
  start: z.boolean().default(true)
});

export function registerRoutes(app: FastifyInstance, repository: ForgeMindRepository) {
  app.get('/health', async () => ({
    ok: true,
    service: 'forgemind-studio-api',
    database: Boolean(process.env.DATABASE_URL)
  }));

  app.get('/api/me', async () => repository.getCurrentUser());

  app.get('/api/projects', async () => repository.listProjects());

  app.post('/api/projects', async (request, reply) => {
    try {
      const input = projectSchema.parse(request.body);
      return reply.code(201).send(await repository.createProject(input));
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks', async () => repository.listTasks());

  app.post('/api/tasks', async (request, reply) => {
    try {
      const input = createTaskSchema.parse(request.body);
      return reply.code(201).send(await repository.createTask(input));
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    return task ? task : sendNotFound(reply, `Task "${id}" not found`);
  });

  app.post('/api/tasks/:id/start', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const task = await repository.startTask(id);
      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/tasks/:id/cancel', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const task = await repository.cancelTask(id);
      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/tasks/:id/retry', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = retrySchema.parse(request.body ?? {});
      const task = await repository.retryTask(id, input.start);
      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks/:id/logs', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    return repository.listTaskAudit(id);
  });

  app.get('/api/tasks/:id/diff', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    return repository.getTaskDiff(id);
  });

  app.get('/api/tasks/:id/usage', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    return repository.getTaskUsage(id);
  });

  app.get('/api/approvals', async () => repository.listApprovals());

  app.get('/api/approvals/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const approval = await repository.getApproval(id);
    return approval ? approval : sendNotFound(reply, `Approval "${id}" not found`);
  });

  app.post('/api/approvals/:id/approve', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const approval = await repository.resolveApproval(id, 'approved');
      return approval ? approval : sendNotFound(reply, `Approval "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/approvals/:id/reject', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const approval = await repository.resolveApproval(id, 'rejected');
      return approval ? approval : sendNotFound(reply, `Approval "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/approvals/:id/comment', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const approval = await repository.getApproval(id);
      if (!approval) return sendNotFound(reply, `Approval "${id}" not found`);
      const body = commentSchema.parse(request.body);
      const currentUser = await repository.getCurrentUser();
      const audit = await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'approval_commented',
        taskId: approval.taskId,
        payload: { approvalId: id, comment: body.comment }
      });
      return reply.code(201).send(audit);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/webhooks/github', { config: { rawBody: true } }, async (request, reply) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: 'GITHUB_WEBHOOK_SECRET is not configured.' });
    }

    const rawPayload = (request as unknown as { rawBody?: Buffer | string }).rawBody;
    if (!rawPayload) {
      return reply.code(400).send({ error: 'Raw webhook payload is not available.' });
    }

    const valid = verifyGitHubWebhookSignature({
      payload: rawPayload,
      signatureHeader: request.headers['x-hub-signature-256'],
      secret
    });
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid GitHub webhook signature.' });
    }

    const event = String(request.headers['x-github-event'] ?? 'unknown');
    const delivery = String(request.headers['x-github-delivery'] ?? '');
    const audit = await repository.writeAudit({
      actorType: 'github',
      eventType: `github_webhook_${event}`,
      payload: { event, delivery }
    });

    return reply.code(202).send({ ok: true, event, delivery, auditId: audit.id });
  });
}
