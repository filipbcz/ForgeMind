import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendBadRequest, sendNotFound } from './http.js';
import type { AppStore } from './store.js';

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

export function registerRoutes(app: FastifyInstance, store: AppStore) {
  app.get('/health', async () => ({
    ok: true,
    service: 'forgemind-studio-api'
  }));

  app.get('/api/me', async () => store.currentUser);

  app.get('/api/projects', async () => Array.from(store.projects.values()));

  app.post('/api/projects', async (request, reply) => {
    try {
      const input = projectSchema.parse(request.body);
      return reply.code(201).send(store.createProject(input));
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks', async () => Array.from(store.tasks.values()));

  app.post('/api/tasks', async (request, reply) => {
    try {
      const input = createTaskSchema.parse(request.body);
      return reply.code(201).send(store.createTask(input));
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = store.tasks.get(id);
    return task ? task : sendNotFound(reply, `Task "${id}" not found`);
  });

  app.post('/api/tasks/:id/start', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const task = store.startTask(id);
      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/tasks/:id/cancel', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const task = store.cancelTask(id);
      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks/:id/logs', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.tasks.has(id)) return sendNotFound(reply, `Task "${id}" not found`);
    return store.auditLog.filter((event) => event.taskId === id);
  });

  app.get('/api/approvals', async () => Array.from(store.approvals.values()));

  app.get('/api/approvals/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const approval = store.approvals.get(id);
    return approval ? approval : sendNotFound(reply, `Approval "${id}" not found`);
  });

  app.post('/api/approvals/:id/approve', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const approval = store.resolveApproval(id, 'approved');
      return approval ? approval : sendNotFound(reply, `Approval "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/approvals/:id/reject', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const approval = store.resolveApproval(id, 'rejected');
      return approval ? approval : sendNotFound(reply, `Approval "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/approvals/:id/comment', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const approval = store.approvals.get(id);
      if (!approval) return sendNotFound(reply, `Approval "${id}" not found`);
      const body = commentSchema.parse(request.body);
      const audit = store.writeAudit({
        actorType: 'user',
        actorId: store.currentUser.id,
        eventType: 'approval_commented',
        taskId: approval.taskId,
        payload: { approvalId: id, comment: body.comment }
      });
      return reply.code(201).send(audit);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/webhooks/github', async (_request, reply) => {
    return reply.code(501).send({
      error: 'GitHub webhook receiver is reserved for the real GitHub App integration.'
    });
  });
}

