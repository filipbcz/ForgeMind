import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ROADMAP_GENERATION_CONFIRMATION } from '@forgemind/core';
import type { AIProvider, CostEstimateResult, ImplementInput, ImplementResult, PlanInput, PlanResult, ReviewInput, ReviewResult } from '@forgemind/providers';
import type { GitHubAdapter } from '@forgemind/github';
import { createAuthService } from './auth.js';
import type { AuthService, AuthUser } from './auth.js';
import { createNotificationService } from './notifications.js';
import { registerRoutes } from './routes.js';
import { signGitHubWebhookPayload } from './webhook.js';

function restoreEnv(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previous;
}

async function loadRunWorkerTask() {
  const moduleUrl = new URL('../../worker/src/workflow.ts', import.meta.url).href;
  const module = (await import(moduleUrl)) as {
    runWorkerTask: (input: Record<string, unknown>) => Promise<any>;
  };
  return module.runWorkerTask;
}

function createAuthenticatedHeaders(auth: AuthService, user: AuthUser): Record<string, string> {
  const session = auth.createTestSession(user);
  return { authorization: `Bearer ${session.id}` };
}

const ownerUser: AuthUser = { id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' };

function createOwnerAuthenticatedHeaders(auth: AuthService): Record<string, string> {
  return createAuthenticatedHeaders(auth, ownerUser);
}

function withRiskApproval(headers: Record<string, string>, approvalId = 'approval_risk_1'): Record<string, string> {
  return { ...headers, 'x-forgemind-approval-id': approvalId };
}

function requireSetCookieHeader(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw new Error('Expected Set-Cookie header.');
  }
  return value;
}

function approvedRiskApproval(
  type: string,
  id = 'approval_risk_1',
  mutation?: { method: string; path: string; body?: unknown; actorId?: string }
) {
  return {
    id,
    taskId: 'task_1',
    type,
    status: 'approved',
    requestedBy: 'agent',
    title: 'Approved risky operation',
    description: 'The requested risky mutation was approved explicitly.',
    riskLevel: 'high',
    payload: mutation
      ? {
          apiMutation: {
            method: mutation.method,
            path: mutation.path,
            actorId: mutation.actorId ?? ownerUser.id,
            bodyHash: hashApiMutationBody(mutation.body ?? null)
          }
        }
      : {},
    createdAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString()
  };
}

function hashApiMutationBody(body: unknown): string {
  return createHash('sha256').update(stableJson(body)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

const mutatingEndpointInventory = [
  ['PUT', '/api/worker/queue'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/providers/models'],
  ['POST', '/api/providers/codex/oauth/start'],
  ['POST', '/api/github/connect'],
  ['POST', '/api/github/disconnect'],
  ['POST', '/api/providers/codex/oauth/complete'],
  ['POST', '/api/providers/connect'],
  ['DELETE', '/api/providers/connections/connection_1'],
  ['POST', '/api/projects'],
  ['PATCH', '/api/projects/project_1'],
  ['DELETE', '/api/projects/project_1'],
  ['POST', '/api/projects/project_1/github-repository'],
  ['PUT', '/api/projects/project_1/config'],
  ['POST', '/api/projects/project_1/audit/retry'],
  ['POST', '/api/projects/project_1/audit/start'],
  ['POST', '/api/projects/project_1/contracts'],
  ['POST', '/api/projects/project_1/implementation-steps/start-next'],
  ['POST', '/api/projects/project_1/implementation-steps/reconcile'],
  ['POST', '/api/projects/project_1/implementation-steps/generate'],
  ['POST', '/api/projects/project_1/extension/decision'],
  ['POST', '/api/tasks'],
  ['POST', '/api/tasks/task_1/start'],
  ['POST', '/api/tasks/task_1/cancel'],
  ['POST', '/api/tasks/task_1/retry'],
  ['POST', '/api/tasks/task_1/complete'],
  ['POST', '/api/chat/threads'],
  ['POST', '/api/chat/threads/00000000-0000-4000-8000-000000000001/continue-with-repository'],
  ['PATCH', '/api/chat/threads/00000000-0000-4000-8000-000000000001'],
  ['DELETE', '/api/chat/threads/00000000-0000-4000-8000-000000000001'],
  ['POST', '/api/chat/threads/00000000-0000-4000-8000-000000000001/messages'],
  ['POST', '/api/chat/runs/00000000-0000-4000-8000-000000000001/retry'],
  ['POST', '/api/chat/runs/00000000-0000-4000-8000-000000000001/cancel'],
  ['POST', '/api/chat/approvals/00000000-0000-4000-8000-000000000001/approve'],
  ['POST', '/api/chat/approvals/00000000-0000-4000-8000-000000000001/reject'],
  ['POST', '/api/approvals/approval_1/approve'],
  ['POST', '/api/approvals/approval_1/reject'],
  ['POST', '/api/approvals/approval_1/comment'],
  ['POST', '/api/notifications/subscribe'],
  ['POST', '/api/notifications/unsubscribe'],
  ['PUT', '/api/notifications/settings']
] as const;

const authenticatedReadEndpointInventory = [
  '/api/me',
  '/api/providers/status',
  '/api/providers/connections',
  '/api/providers/codex/oauth/status',
  '/api/providers/codex/oauth/authorize?loginId=00000000-0000-4000-8000-000000000001',
  '/api/providers/codex/oauth/00000000-0000-4000-8000-000000000001/status',
  '/api/github/status',
  '/api/github/repositories',
  '/api/github/repository-owners',
  '/api/github/branches?owner=demo&repo=repo',
  '/api/projects',
  '/api/projects/project_1',
  '/api/projects/project_1/config',
  '/api/projects/project_1/roadmap',
  '/api/projects/project_1/specifications',
  '/api/projects/project_1/contracts',
  '/api/projects/project_1/architectures',
  '/api/tasks',
  '/api/tasks/task_1',
  '/api/tasks/task_1/queue',
  '/api/tasks/task_1/logs',
  '/api/tasks/task_1/runs',
  '/api/tasks/task_1/diagnostics',
  '/api/tasks/task_1/diff',
  '/api/tasks/task_1/usage',
  '/api/approvals',
  '/api/approvals/approval_1',
  '/api/chat/threads',
  '/api/chat/threads/00000000-0000-4000-8000-000000000001',
  '/api/notifications/vapid-public-key',
  '/api/notifications/settings',
  '/api/worker/status',
  '/api/worker/events',
  '/api/metrics'
] as const;

describe('Studio API routes', () => {
  it('rejects mutating API requests when auth service is not configured', async () => {
    const repository = {
      createTask: vi.fn(),
      getCurrentUser: vi.fn()
    };
    const app = Fastify();
    registerRoutes(app, repository as never);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {}
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'Authentication service is not configured.' });
    expect(repository.getCurrentUser).not.toHaveBeenCalled();
    expect(repository.createTask).not.toHaveBeenCalled();
    await app.close();
  }, 10000);

  it.each(mutatingEndpointInventory)('rejects anonymous %s %s before route handlers execute', async (method, url) => {
    const repository = {
      createTask: vi.fn(),
      getCurrentUser: vi.fn()
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, createAuthService());

    const response = await app.inject({
      method,
      url,
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Authentication required.' });
    expect(repository.getCurrentUser).not.toHaveBeenCalled();
    expect(repository.createTask).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(authenticatedReadEndpointInventory)('rejects anonymous GET %s before route handlers execute', async (url) => {
    const repository = { getCurrentUser: vi.fn() };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, createAuthService());

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Authentication required.' });
    expect(repository.getCurrentUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows an authenticated owner to execute an explicit risky mutation directly', async () => {
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      setWorkerQueuePaused: vi.fn(async () => ({ queuePaused: true, updatedAt: new Date().toISOString() })),
      getWorkerStatus: vi.fn(async () => ({ state: 'idle', queuePaused: true, queuedTaskCount: 0, activeTaskCount: 0, updatedAt: new Date().toISOString() }))
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: createOwnerAuthenticatedHeaders(auth),
      payload: { paused: true }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledWith(true);
    await app.close();
  });

  it('allows an authenticated delegated chat mutation without a second approval gate', async () => {
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      isChatApiMutationAuthorized: vi.fn(async () => false),
      getApproval: vi.fn(),
      setWorkerQueuePaused: vi.fn(async () => ({ queuePaused: true, updatedAt: new Date().toISOString() })),
      getWorkerStatus: vi.fn(async () => ({ state: 'idle', queuePaused: true, queuedTaskCount: 0, activeTaskCount: 0, updatedAt: new Date().toISOString() }))
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: { ...createOwnerAuthenticatedHeaders(auth), 'x-forgemind-chat-run-id': 'run_1' },
      payload: { paused: true }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.isChatApiMutationAuthorized).not.toHaveBeenCalled();
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledWith(true);
    await app.close();
  });

  it('does not consult legacy approval authorization for chat-run delegation', async () => {
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      isChatApiMutationAuthorized: vi.fn(async () => true),
      setWorkerQueuePaused: vi.fn(async () => ({ queuePaused: true, updatedAt: new Date().toISOString() })),
      getWorkerStatus: vi.fn(async () => ({ state: 'idle', queuePaused: true, queuedTaskCount: 0, activeTaskCount: 0, updatedAt: new Date().toISOString() }))
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: { ...createOwnerAuthenticatedHeaders(auth), 'x-forgemind-chat-run-id': 'run_1' },
      payload: { paused: true }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.isChatApiMutationAuthorized).not.toHaveBeenCalled();
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledWith(true);
    await app.close();
  });

  it('allows authenticated task lifecycle mutations without a duplicate risk approval', async () => {
    const auth = createAuthService();
    const task = {
      id: 'task_1',
      projectId: 'project_1',
      title: 'Retry task',
      prompt: 'Retry the failed task.',
      status: 'submitted',
      priority: 'medium',
      mode: 'safe',
      maxIterations: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      retryTask: vi.fn(async () => task),
      enqueueTask: vi.fn(async () => undefined),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 1, queuePosition: 1 })),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/task_1/retry',
      headers: createOwnerAuthenticatedHeaders(auth),
      payload: { start: true }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.retryTask).toHaveBeenCalledWith('task_1', true);
    expect(repository.enqueueTask).toHaveBeenCalledWith('task_1', 'task_retried');
    await app.close();
  });

  it('ignores legacy risk-approval headers and authorizes by the authenticated owner', async () => {
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_wrong_body') return approvedRiskApproval('config_change', id, {
          method: 'PUT',
          path: '/api/worker/queue',
          body: { paused: false }
        });
        if (id === 'approval_wrong_actor') return approvedRiskApproval('config_change', id, {
          method: 'PUT',
          path: '/api/worker/queue',
          body: { paused: true },
          actorId: 'user_2'
        });
        return undefined;
      }),
      consumeRiskApproval: vi.fn(),
      setWorkerQueuePaused: vi.fn(async () => ({ queuePaused: true, updatedAt: new Date().toISOString() })),
      getWorkerStatus: vi.fn(async () => ({ state: 'idle', queuePaused: true, queuedTaskCount: 0, activeTaskCount: 0, updatedAt: new Date().toISOString() }))
    };
    const app = Fastify();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const wrongBodyResponse = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: withRiskApproval(headers, 'approval_wrong_body'),
      payload: { paused: true }
    });
    const wrongActorResponse = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: withRiskApproval(headers, 'approval_wrong_actor'),
      payload: { paused: true }
    });

    expect(wrongBodyResponse.statusCode).toBe(200);
    expect(wrongActorResponse.statusCode).toBe(200);
    expect(repository.getApproval).not.toHaveBeenCalled();
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('does not consume legacy risk-approval ids', async () => {
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getApproval: vi.fn(async (id: string) => id === 'approval_queue_pause'
        ? approvedRiskApproval('config_change', id, {
            method: 'PUT',
            path: '/api/worker/queue',
            body: { paused: true }
          })
        : undefined),
      consumeRiskApproval: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      setWorkerQueuePaused: vi.fn(async (paused: boolean) => ({
        queuePaused: paused,
        pausedAt: paused ? new Date().toISOString() : undefined,
        updatedAt: new Date().toISOString()
      })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuePaused: true,
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      }))
    };
    const app = Fastify();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const firstResponse = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: withRiskApproval(headers, 'approval_queue_pause'),
      payload: { paused: true }
    });
    const secondResponse = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: withRiskApproval(headers, 'approval_queue_pause'),
      payload: { paused: true }
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(repository.getApproval).not.toHaveBeenCalled();
    expect(repository.consumeRiskApproval).not.toHaveBeenCalled();
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('does not expose task approval mutations', async () => {
    const operator = { id: 'user_1', email: 'operator@example.com', name: 'Operator', role: 'operator' as const };
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => operator),
      getApproval: vi.fn(async () => ({
        id: 'approval_1',
        taskId: 'task_1',
        type: 'new_dependency',
        status: 'pending',
        requestedBy: 'agent',
        title: 'Approval required',
        description: 'Approve dependency update',
        riskLevel: 'medium',
        payload: {},
        createdAt: new Date().toISOString()
      })),
      resolveApproval: vi.fn()
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval_1/approve',
      headers: createAuthenticatedHeaders(auth, operator)
    });

    expect(response.statusCode).toBe(404);
    expect(repository.getApproval).not.toHaveBeenCalled();
    expect(repository.resolveApproval).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not execute historical approvals through the API', async () => {
    const owner = { id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' as const };
    const auth = createAuthService();
    const repository = {
      getCurrentUser: vi.fn(async () => owner),
      getApproval: vi.fn(async () => ({
        id: 'approval_1',
        taskId: 'task_1',
        type: 'risky_refactor',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required',
        description: 'Already approved.',
        riskLevel: 'high',
        createdAt: new Date().toISOString()
      })),
      resolveApproval: vi.fn()
    };
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval_1/approve',
      headers: createAuthenticatedHeaders(auth, owner)
    });

    expect(response.statusCode).toBe(404);
    expect(repository.resolveApproval).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the current project specification and its version history', async () => {
    const current = {
      id: 'spec_2', projectId: 'project_1', version: 2,
      fullSpecification: 'Initial brief\n\nApproved extension',
      changeSummary: 'Approved extension.', source: 'approved_extension',
      parentVersionId: 'spec_1', sourceCycleId: 'cycle_1', createdAt: '2026-08-10T10:00:00.000Z'
    };
    const specifications = { projectId: 'project_1', current, versions: [current] };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProjectSpecifications: vi.fn(async () => specifications)
    };
    const app = Fastify();
    const auth = createAuthService();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({ method: 'GET', url: '/api/projects/project_1/specifications', headers: createOwnerAuthenticatedHeaders(auth) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(specifications);
    await app.close();
  });

  it('reviews specification changes without saving an invalid draft or deleting audit history', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1',
        name: 'Project',
        projectContract: {
          version: 1,
          summary: 'Reporting',
          invariants: [],
          prohibitedSubstitutes: [],
          requirements: [{
            id: 'REQ-REPORTING',
            title: 'Reporting',
            description: 'Build reporting.',
            acceptanceCriteria: ['Reports render.'],
            briefReferences: ['reporting']
          }],
          releaseCriteria: ['Ready']
        }
      })),
      getProjectSpecifications: vi.fn(async () => ({
        projectId: 'project_1',
        current: {
          id: 'spec_1',
          projectId: 'project_1',
          version: 1,
          fullSpecification: 'Build reporting.\nKeep audit logs.',
          changeSummary: 'Initial brief.',
          source: 'initial_brief',
          createdAt: '2026-08-10T10:00:00.000Z'
        },
        versions: []
      })),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [],
        steps: [{
          id: 'step_1',
          projectId: 'project_1',
          cycleId: 'cycle_1',
          sequenceNumber: 1,
          title: 'Build reports',
          description: 'Implement reports.',
          acceptanceCriteria: ['Reports render.'],
          requirementIds: ['REQ-REPORTING'],
          deliverables: [],
          changeRationale: 'Needed for reporting.',
          dependsOnStepTitles: [],
          validationFocus: ['implementation'],
          status: 'pending',
          createdAt: '',
          updatedAt: ''
        }],
        evidence: [{
          id: 'evidence_1',
          projectId: 'project_1',
          cycleId: 'cycle_1',
          requirementId: 'REQ-REPORTING',
          criterionKey: 'Reports render.',
          criterion: 'Reports render.',
          source: 'repository_audit',
          status: 'passed',
          evidenceKey: 'audit:reports',
          contractVersion: 1,
          payload: {},
          createdAt: '',
          updatedAt: ''
        }],
        capabilities: [],
        auditJobs: []
      })),
      updateProject: vi.fn(),
      writeAudit: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/specification-review',
      headers,
      payload: { brief: 'Build reporting with export.\nKeep audit logs.' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: 'project_1',
      baseSpecificationVersion: 1,
      baseSpecificationHash: createHash('sha256').update('Build reporting.\nKeep audit logs.').digest('hex'),
      changed: true,
      impact: {
        requirements: [expect.objectContaining({ id: 'REQ-REPORTING' })],
        unfinishedSteps: [expect.objectContaining({ id: 'step_1' })],
        evidence: [expect.objectContaining({ id: 'evidence_1' })]
      }
    });
    expect(repository.updateProject).not.toHaveBeenCalled();
    expect(repository.writeAudit).not.toHaveBeenCalled();
    await app.close();
  });

  it('reviews clearing a specification against the cleared value and saves only after matching review metadata', async () => {
    const currentSpecification = 'Build reporting.\nKeep audit logs.';
    const baseSpecificationHash = createHash('sha256').update(currentSpecification).digest('hex');
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1',
        name: 'Project',
        projectContract: {
          version: 1,
          summary: 'Reporting',
          invariants: [],
          prohibitedSubstitutes: [],
          requirements: [{
            id: 'REQ-REPORTING',
            title: 'Reporting',
            description: 'Build reporting.',
            acceptanceCriteria: ['Reports render.'],
            briefReferences: ['reporting']
          }],
          releaseCriteria: ['Ready']
        }
      })),
      getProjectSpecifications: vi.fn(async () => ({
        projectId: 'project_1',
        current: {
          id: 'spec_1',
          projectId: 'project_1',
          version: 1,
          fullSpecification: currentSpecification,
          changeSummary: 'Initial brief.',
          source: 'initial_brief',
          createdAt: '2026-08-10T10:00:00.000Z'
        },
        versions: []
      })),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [],
        steps: [],
        evidence: [],
        capabilities: [],
        auditJobs: []
      })),
      updateProject: vi.fn(async (id: string, input: Record<string, unknown>) => ({
        id,
        name: 'Project',
        slug: 'project',
        defaultBranch: 'main',
        brief: input.brief ?? undefined,
        isActive: true,
        createdAt: '',
        updatedAt: ''
      }))
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const reviewResponse = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/specification-review',
      headers,
      payload: { brief: null }
    });
    const review = reviewResponse.json();

    expect(reviewResponse.statusCode).toBe(200);
    expect(review).toMatchObject({
      baseSpecificationVersion: 1,
      baseSpecificationHash,
      changed: true
    });
    expect(review.diff.filter((line: { type: string }) => line.type === 'added')).toEqual([]);
    expect(review.diff.filter((line: { type: string }) => line.type === 'removed')).toEqual([
      expect.objectContaining({ text: 'Build reporting.' }),
      expect.objectContaining({ text: 'Keep audit logs.' })
    ]);

    const saveResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: {
        brief: null,
        specificationReview: {
          baseSpecificationVersion: review.baseSpecificationVersion,
          baseSpecificationHash: review.baseSpecificationHash
        }
      }
    });

    expect(saveResponse.statusCode).toBe(200);
    expect(repository.updateProject).toHaveBeenCalledWith('project_1', { brief: null });
    await app.close();
  });

  it('rejects a specification save when the reviewed base version is stale', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProjectSpecifications: vi.fn(async () => ({
        projectId: 'project_1',
        current: {
          id: 'spec_2',
          projectId: 'project_1',
          version: 2,
          fullSpecification: 'Newer specification.',
          changeSummary: 'Updated.',
          source: 'manual_revision',
          createdAt: '2026-08-10T11:00:00.000Z'
        },
        versions: []
      })),
      updateProject: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: {
        brief: 'Reviewed project objective with enough detail.',
        specificationReview: {
          baseSpecificationVersion: 1,
          baseSpecificationHash: createHash('sha256').update('Older specification.').digest('hex')
        }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Specification changed after review. Review the latest diff before saving.' });
    expect(repository.updateProject).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires specification review metadata for brief saves while allowing unrelated project updates', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      updateProject: vi.fn(async (id: string, input: Record<string, unknown>) => ({
        id,
        name: input.name ?? 'Project',
        slug: 'project',
        defaultBranch: input.defaultBranch ?? 'main',
        isActive: true,
        createdAt: '',
        updatedAt: ''
      })),
      getProjectSpecifications: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const unrelatedResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: { name: 'Renamed project' }
    });

    expect(unrelatedResponse.statusCode).toBe(200);
    expect(repository.updateProject).toHaveBeenCalledWith('project_1', { name: 'Renamed project' });

    const briefResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: { brief: 'Changed project specification with enough detail.' }
    });

    expect(briefResponse.statusCode).toBe(409);
    expect(briefResponse.json()).toEqual({ error: 'Review the specification diff and impact before saving a changed specification.' });
    expect(repository.updateProject).toHaveBeenCalledTimes(1);
    expect(repository.getProjectSpecifications).not.toHaveBeenCalled();
    await app.close();
  });

  it('saves a reviewed contract specification without generating a roadmap', async () => {
    const currentSpecification = 'Build reporting.';
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProjectSpecifications: vi.fn(async () => ({
        projectId: 'project_1',
        current: {
          id: 'spec_1',
          projectId: 'project_1',
          version: 1,
          fullSpecification: currentSpecification,
          changeSummary: 'Initial brief.',
          source: 'initial_brief',
          createdAt: '2026-08-10T10:00:00.000Z'
        },
        versions: []
      })),
      updateProject: vi.fn(async (id: string, input: Record<string, unknown>) => ({
        id,
        name: 'Project',
        slug: 'project',
        defaultBranch: 'main',
        brief: input.brief,
        isActive: true,
        createdAt: '',
        updatedAt: ''
      })),
      assertProjectRoadmapRegenerationAllowed: vi.fn(),
      createProjectRoadmapCycle: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: {
        brief: 'Build reporting with export.',
        specificationReview: {
          baseSpecificationVersion: 1,
          baseSpecificationHash: createHash('sha256').update(currentSpecification).digest('hex')
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.updateProject).toHaveBeenCalledWith('project_1', { brief: 'Build reporting with export.' });
    expect(repository.assertProjectRoadmapRegenerationAllowed).not.toHaveBeenCalled();
    expect(repository.createProjectRoadmapCycle).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires explicit roadmap generation confirmation before provider planning', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project', slug: 'project', defaultBranch: 'main',
        brief: 'A sufficiently detailed project objective.', isActive: true, createdAt: '', updatedAt: ''
      })),
      assertProjectRoadmapRegenerationAllowed: vi.fn(),
      getProjectSpecifications: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/implementation-steps/generate',
      headers,
      payload: {}
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Type "GENERATE ROADMAP" to confirm roadmap generation.' });
    expect(repository.assertProjectRoadmapRegenerationAllowed).not.toHaveBeenCalled();
    expect(repository.getProjectSpecifications).not.toHaveBeenCalled();
    await app.close();
  });

  it('characterizes confirmed roadmap generation as a repository-gated provider route', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project', slug: 'project', defaultBranch: 'main',
        brief: '', isActive: true, createdAt: '', updatedAt: ''
      })),
      assertProjectRoadmapRegenerationAllowed: vi.fn(),
      getProjectSpecifications: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/implementation-steps/generate',
      headers,
      payload: { confirmation: ROADMAP_GENERATION_CONFIRMATION }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Project brief is required before generating implementation steps.' });
    expect(repository.assertProjectRoadmapRegenerationAllowed).toHaveBeenCalledWith('project_1');
    expect(repository.getProjectSpecifications).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns immutable project contract history with the current pointer', async () => {
    const current = {
      id: 'contract_2', projectId: 'project_1', specificationVersionId: 'spec_2', version: 2,
      contract: { version: 2, summary: 'Extended', invariants: [], prohibitedSubstitutes: [], requirements: [], releaseCriteria: [] },
      changeSummary: 'Added reporting.', source: 'approved_extension', parentVersionId: 'contract_1', createdAt: '2026-08-10T10:00:00.000Z'
    };
    const contracts = { projectId: 'project_1', current, versions: [current] };
    const repository = { getCurrentUser: vi.fn(async () => ownerUser), getProjectContracts: vi.fn(async () => contracts) };
    const app = Fastify();
    const auth = createAuthService();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({ method: 'GET', url: '/api/projects/project_1/contracts', headers: createOwnerAuthenticatedHeaders(auth) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(contracts);
    await app.close();
  });

  it('persists a manually supplied initial project contract version', async () => {
    const contracts = { projectId: 'project_1', current: { version: 1 }, versions: [{ version: 1 }] };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      createManualProjectContractVersion: vi.fn(async () => contracts)
    };
    const app = Fastify();
    const auth = createAuthService();
    registerRoutes(app, repository as never, undefined, auth);
    const contract = {
      version: 1,
      summary: 'Initial contract.',
      invariants: ['Existing behavior remains available.'],
      prohibitedSubstitutes: [],
      requirements: [{
        id: 'REQ-DEMO', title: 'Demo', description: 'Deliver the requested behavior.',
        acceptanceCriteria: ['The behavior is covered by an automated test.'], briefReferences: []
      }],
      releaseCriteria: ['All project validation commands pass.']
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/contracts',
      headers: createOwnerAuthenticatedHeaders(auth),
      payload: { contract, changeSummary: 'Created from AI chat.' }
    });

    expect(response.statusCode).toBe(201);
    expect(repository.createManualProjectContractVersion).toHaveBeenCalledWith({
      projectId: 'project_1', contract, contractDelta: undefined, changeSummary: 'Created from AI chat.'
    });
    await app.close();
  });

  it('reconciles roadmap step states through an authenticated chat mutation without approval binding', async () => {
    const reconciliation = {
      projectId: 'project_1', examinedSteps: 2,
      updatedSteps: [{
        stepId: 'step_1', taskId: 'task_1', taskStatus: 'completed',
        previousStatus: 'running', status: 'completed'
      }]
    };
    const roadmap = { projectId: 'project_1', cycles: [], steps: [], evidence: [], capabilities: [], auditJobs: [] };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      isChatApiMutationAuthorized: vi.fn(async () => true),
      reconcileProjectImplementationSteps: vi.fn(async () => reconciliation),
      getProjectRoadmap: vi.fn(async () => roadmap)
    };
    const app = Fastify();
    const auth = createAuthService();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/implementation-steps/reconcile',
      headers: { ...createOwnerAuthenticatedHeaders(auth), 'x-forgemind-chat-run-id': 'run_1' },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reconciliation, roadmap });
    expect(repository.isChatApiMutationAuthorized).not.toHaveBeenCalled();
    expect(repository.reconcileProjectImplementationSteps).toHaveBeenCalledWith('project_1');
    await app.close();
  });

  it('treats a repeated accepted extension decision as idempotent before invoking the provider', async () => {
    const roadmap = {
      projectId: 'project_1',
      cycles: [
        { id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Initial', status: 'completed' },
        { id: 'cycle_2', projectId: 'project_1', cycleNumber: 2, objective: 'Extension', status: 'active' }
      ],
      steps: [], evidence: [], capabilities: [], auditJobs: []
    };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project', slug: 'project', defaultBranch: 'main',
        brief: 'Initial project brief long enough.', isActive: true, createdAt: '', updatedAt: ''
      })),
      getProjectRoadmap: vi.fn(async () => roadmap),
      getProjectSpecifications: vi.fn(async () => ({
        projectId: 'project_1',
        current: { id: 'spec_2', projectId: 'project_1', version: 2, fullSpecification: 'Current', changeSummary: 'Extension', source: 'approved_extension', sourceCycleId: 'cycle_1', createdAt: '' },
        versions: [{ id: 'spec_2', projectId: 'project_1', version: 2, fullSpecification: 'Current', changeSummary: 'Extension', source: 'approved_extension', sourceCycleId: 'cycle_1', createdAt: '' }]
      })),
      createProjectRoadmapCycle: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/extension/decision',
      headers,
      payload: { accepted: true, cycleId: 'cycle_1' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(roadmap);
    expect(repository.createProjectRoadmapCycle).not.toHaveBeenCalled();
    await app.close();
  });

  it('requeues only a failed project audit with its original requirement scope', async () => {
    const roadmap = {
      projectId: 'project_1',
      cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Demo', status: 'blocked' }],
      steps: [],
      evidence: [],
      capabilities: [],
      auditJobs: [{
        id: 'audit_1', projectId: 'project_1', cycleId: 'cycle_1', triggerTaskId: 'task_1',
        requirementIds: ['REQ-DEMO'], status: 'blocked', attemptCount: 3, createdAt: '', updatedAt: ''
      }]
    };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProjectRoadmap: vi.fn(async () => roadmap),
      enqueueProjectAudit: vi.fn(async () => ({ enqueued: true, job: roadmap.auditJobs[0] }))
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({ method: 'POST', url: '/api/projects/project_1/audit/retry', headers });

    expect(response.statusCode).toBe(200);
    expect(repository.enqueueProjectAudit).toHaveBeenCalledWith({
      projectId: 'project_1', cycleId: 'cycle_1', triggerTaskId: 'task_1', requirementIds: ['REQ-DEMO']
    });
    await app.close();
  });

  it('starts the final project audit only when all implementation steps are completed', async () => {
    const roadmap = {
      projectId: 'project_1',
      cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Demo', status: 'active' }],
      steps: [{
        id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1,
        title: 'Demo', description: 'Done', acceptanceCriteria: ['Done'], requirementIds: ['REQ-DEMO'],
        deliverables: ['Demo'], dependsOnStepTitles: [], validationFocus: [], status: 'completed', taskId: 'task_1'
      }],
      evidence: [], capabilities: [], auditJobs: []
    };
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project',
        projectContract: {
          version: 1, summary: 'Demo', invariants: [], prohibitedSubstitutes: [], releaseCriteria: ['Ready'],
          requirements: [{ id: 'REQ-DEMO', title: 'Demo', description: 'Demo works.', acceptanceCriteria: ['Done'], status: 'active' }]
        }
      })),
      getProjectRoadmap: vi.fn(async () => roadmap),
      enqueueProjectAudit: vi.fn(async () => ({ enqueued: true, job: { id: 'audit_1' } }))
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({ method: 'POST', url: '/api/projects/project_1/audit/start', headers });

    expect(response.statusCode).toBe(200);
    expect(repository.enqueueProjectAudit).toHaveBeenCalledWith({
      projectId: 'project_1', cycleId: 'cycle_1', triggerTaskId: 'task_1', requirementIds: ['REQ-DEMO']
    });
    await app.close();
  });

  it('rejects a manual final audit while an implementation step is unfinished', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1',
        projectContract: {
          version: 1, summary: 'Demo', invariants: [], prohibitedSubstitutes: [], releaseCriteria: ['Ready'],
          requirements: [{ id: 'REQ-DEMO', title: 'Demo', description: 'Demo works.', acceptanceCriteria: ['Done'], status: 'active' }]
        }
      })),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Demo', status: 'active' }],
        steps: [{ id: 'step_1', cycleId: 'cycle_1', status: 'pending' }], evidence: [], capabilities: [], auditJobs: []
      })),
      enqueueProjectAudit: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({ method: 'POST', url: '/api/projects/project_1/audit/start', headers });

    expect(response.statusCode).toBe(409);
    expect(repository.enqueueProjectAudit).not.toHaveBeenCalled();
    await app.close();
  });

  it('blocks roadmap regeneration before invoking AI while project work is active', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project', slug: 'project', defaultBranch: 'main',
        brief: 'A sufficiently detailed project objective.', isActive: true, createdAt: '', updatedAt: ''
      })),
      assertProjectRoadmapRegenerationAllowed: vi.fn(async () => {
        throw new Error('Roadmap cannot be regenerated while the project has an active task, running implementation step, or project audit.');
      }),
      getProjectSpecifications: vi.fn()
    };
    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/project_1/implementation-steps/generate',
      headers,
      payload: { confirmation: 'GENERATE ROADMAP' }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('cannot be regenerated');
    expect(repository.getProjectSpecifications).not.toHaveBeenCalled();
    await app.close();
  });

  it('exposes worker status endpoint', async () => {
    let queuePaused = false;
    const repository = {
      getCurrentUser: vi.fn(async () => ownerUser),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuePaused,
        queuedTaskCount: 0,
        activeTaskCount: 0,
        activeIteration: {
          taskId: 'task_1',
          taskRunId: 'run_1',
          phase: 'implementation',
          attempt: 1,
          prompt: 'Implement the change',
          providerPrompt: 'Implement the change in the repository',
          startedAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      })),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_risk_1') return approvedRiskApproval('config_change', id, {
          method: 'PUT',
          path: '/api/worker/queue',
          body: { paused: true }
        });
        return undefined;
      }),
      consumeRiskApproval: vi.fn(async () => true),
      setWorkerQueuePaused: vi.fn(async (paused: boolean) => {
        queuePaused = paused;
        return {
          queuePaused,
          pausedAt: paused ? new Date().toISOString() : undefined,
          updatedAt: new Date().toISOString()
        };
      }),
      getRecentWorkerEvents: vi.fn(async () => []),
      getOperationalMetrics: vi.fn(async () => ({
        generatedAt: new Date().toISOString(),
        tasks: {
          total: 3,
          draft: 1,
          submitted: 1,
          active: 1,
          needsApproval: 0,
          completed: 1,
          failed: 0,
          cancelled: 0,
          providerFailed: 0,
          budgetExceeded: 0,
          iterationLimitReached: 0,
          repeatedErrorDetected: 0,
          validationFailed: 0
        },
        queue: {
          pending: 1,
          claimed: 0,
          failed: 0,
          averagePendingWaitSeconds: 2,
          maxPendingWaitSeconds: 2
        },
        approvals: {
          pending: 0,
          approved: 0,
          rejected: 0,
          cancelled: 0
        },
        runs: {
          queued: 0,
          running: 0,
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          averageDurationSeconds: 5,
          maxDurationSeconds: 5
        }
      }))
    };

    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'GET',
      url: '/api/worker/status',
      headers
    });

    expect(response.statusCode).toBe(200);
    expect(repository.getWorkerStatus).toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        activeIteration: expect.objectContaining({
          taskId: 'task_1',
          phase: 'implementation',
          attempt: 1
        })
      })
    );

    const pauseResponse = await app.inject({
      method: 'PUT',
      url: '/api/worker/queue',
      headers: withRiskApproval(headers),
      payload: { paused: true }
    });

    expect(pauseResponse.statusCode).toBe(200);
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledWith(true);
    expect(pauseResponse.json()).toEqual(expect.objectContaining({ queuePaused: true }));

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/worker/events?limit=10',
      headers
    });

    expect(eventsResponse.statusCode).toBe(200);
    expect(repository.getRecentWorkerEvents).toHaveBeenCalledWith(10);

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers
    });

    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.headers['content-type']).toContain('text/plain');
    expect(metricsResponse.body).toContain('forgemind_tasks_total 3');
    expect(metricsResponse.body).toContain('forgemind_queue_wait_seconds_avg 2.000');
    expect(repository.getOperationalMetrics).toHaveBeenCalled();

    await app.close();
  });

  it('exposes project detail and config endpoints', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(async (input) => ({
        id: 'project_1',
        name: input.name,
        slug: input.slug,
        githubOwner: input.githubOwner,
        githubRepo: input.githubRepo,
        defaultBranch: input.defaultBranch,
        configYaml: input.configYaml,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      getProject: vi.fn(async (id: string) => ({
        id,
        name: 'Demo',
        slug: 'demo',
        githubOwner: 'demo',
        githubRepo: 'repo',
        defaultBranch: 'main',
        configYaml: 'project: {}',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      updateProject: vi.fn(async (id: string, input: Record<string, unknown>) => ({
        id,
        name: String(input.name ?? 'Demo'),
        slug: String(input.slug ?? 'demo'),
        githubOwner: 'demo',
        githubRepo: 'repo',
        defaultBranch: 'develop',
        configYaml: 'project: {}',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      assertProjectDeletable: vi.fn(async () => undefined),
      getGitHubConnectionSecret: vi.fn(async () => ({
        token: 'test-token',
        apiBaseUrl: 'https://api.github.com'
      })),
      deleteProject: vi.fn(async (id: string, input?: { githubRepositoryDeleted?: boolean }) => ({
        projectId: id,
        projectName: 'Demo',
        deletedTasks: 2,
        deletedRuns: 3,
        deletedRoadmapCycles: 1,
        deletedRoadmapSteps: 4,
        githubRepositoryDeleted: input?.githubRepositoryDeleted ?? false
      })),
      getProjectConfig: vi.fn(async (id: string) => ({ projectId: id, configYaml: 'project:\n  id: demo' })),
      updateProjectConfig: vi.fn(async (id: string, configYaml: string) => ({ projectId: id, configYaml })),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(async (id: string) => ({
        id,
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Demo task',
        prompt: 'Do the thing',
        mode: 'safe',
        status: 'ready_for_user_review',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/demo/repo/pull/42',
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 2, queuePosition: 1 })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      transitionTask: vi.fn(async (id: string, status: string) => ({
        id,
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Demo task',
        prompt: 'Do the thing',
        mode: 'safe',
        status,
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: status === 'completed' ? new Date().toISOString() : undefined
      })),
      recordCompletedTaskProjectMemory: vi.fn(async () => undefined),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      exportTaskDiagnostics: vi.fn(async (taskId: string) => ({
        version: 1,
        generatedAt: new Date().toISOString(),
        task: {
          id: taskId,
          projectId: 'project_1',
          createdByUserId: 'user_1',
          title: 'Demo task',
          prompt: 'Do the thing',
          mode: 'safe',
          status: 'waiting_for_capability',
          maxIterations: 10,
          maxBudgetUsd: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        correlation: { task: `task:${taskId}` },
        runs: [{
          id: 'run_1',
          taskId,
          correlationId: `task:${taskId}:run:run_1`,
          provider: 'codex',
          model: 'codex-latest',
          status: 'running',
          state: { version: 1, status: 'waiting', reason: 'unavailable_capability', requiredCapabilities: ['windows'] },
          iterationCount: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usageSource: 'actual_total',
          estimatedCostUsd: 0.01,
          summary: 'Provider printed CODEX_API_KEY=sk-route_1234567890abcdef'
        }],
        queueJobs: [],
        providerUsage: [],
        auditEvents: [],
        waitingOrBlockedState: { version: 1, status: 'waiting', reason: 'unavailable_capability', requiredCapabilities: ['windows'] }
      })),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_delete_invalid_1') return approvedRiskApproval('delete_files', id, {
          method: 'DELETE',
          path: '/api/projects/project_1',
          body: {
            confirmation: 'Wrong name',
            deleteGitHubRepository: false
          }
        });
        if (id === 'approval_delete_1') return approvedRiskApproval('delete_files', id, {
          method: 'DELETE',
          path: '/api/projects/project_1',
          body: {
            confirmation: 'Demo',
            deleteGitHubRepository: false
          }
        });
        if (id === 'approval_delete_github_1') return approvedRiskApproval('delete_files', id, {
          method: 'DELETE',
          path: '/api/projects/project_1',
          body: {
            confirmation: 'Demo',
            deleteGitHubRepository: true
          }
        });
        if (id === 'approval_task_1' || id === 'approval_task_complete_1') return approvedRiskApproval('risky_refactor', id, {
          method: 'POST',
          path: '/api/tasks/task_1/complete',
          body: {}
        });
        return undefined;
      }),
      consumeRiskApproval: vi.fn(async () => true),
      resolveApproval: vi.fn(),
      getImplementationStepByTaskId: vi.fn(async () => undefined),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const getProjectResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/project_1',
      headers
    });
    expect(getProjectResponse.statusCode).toBe(200);
    expect(repository.getProject).toHaveBeenCalledWith('project_1');

    const patchProjectResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: {
        name: 'Updated demo',
        defaultBranch: 'develop'
      }
    });
    expect(patchProjectResponse.statusCode).toBe(200);
    expect(repository.updateProject).toHaveBeenCalledWith('project_1', {
      name: 'Updated demo',
      defaultBranch: 'develop'
    });

    const clearProjectBriefResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: { brief: null }
    });
    expect(clearProjectBriefResponse.statusCode).toBe(409);
    expect(repository.updateProject).toHaveBeenCalledTimes(1);

    const validationProfile = {
      version: 1 as const,
      enabled: true,
      dockerComposeFiles: ['compose.yml'],
      dockerComposeServices: ['postgres', 'api'],
      requiredEnvironmentVariables: ['TEST_DATABASE_URL'],
      migrationCommands: ['npm run db:migrate'],
      readinessCommands: ['npm run test:health'],
      commandTimeoutMinutes: 15
    };
    const validationProfileResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: { validationProfile }
    });
    expect(validationProfileResponse.statusCode).toBe(400);

    const shortProjectBriefResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      headers,
      payload: { brief: 'Too short' }
    });
    expect(shortProjectBriefResponse.statusCode).toBe(400);

    const invalidDeleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/projects/project_1',
      headers: withRiskApproval(headers, 'approval_delete_invalid_1'),
      payload: {
        confirmation: 'Wrong name',
        deleteGitHubRepository: false
      }
    });
    expect(invalidDeleteResponse.statusCode).toBe(400);
    expect(repository.deleteProject).not.toHaveBeenCalled();

    const deleteProjectResponse = await app.inject({
      method: 'DELETE',
      url: '/api/projects/project_1',
      headers: withRiskApproval(headers, 'approval_delete_1'),
      payload: {
        confirmation: 'Demo',
        deleteGitHubRepository: false
      }
    });
    expect(deleteProjectResponse.statusCode).toBe(200);
    expect(repository.assertProjectDeletable).toHaveBeenCalledWith('project_1');
    expect(repository.deleteProject).toHaveBeenCalledWith('project_1', {
      githubRepositoryDeleted: false
    });
    expect(deleteProjectResponse.json()).toEqual(expect.objectContaining({
      projectId: 'project_1',
      deletedGitHubRepository: false
    }));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 204
    } as Response);
    const deleteProjectWithRepositoryResponse = await app.inject({
      method: 'DELETE',
      url: '/api/projects/project_1',
      headers: withRiskApproval(headers, 'approval_delete_github_1'),
      payload: {
        confirmation: 'Demo',
        deleteGitHubRepository: true
      }
    });
    expect(deleteProjectWithRepositoryResponse.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/demo/repo',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(repository.deleteProject).toHaveBeenLastCalledWith('project_1', {
      githubRepositoryDeleted: true
    });
    expect(deleteProjectWithRepositoryResponse.json()).toEqual(expect.objectContaining({
      deletedGitHubRepository: true,
      githubRepository: 'demo/repo'
    }));
    fetchSpy.mockRestore();

    const getConfigResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/project_1/config',
      headers
    });
    expect(getConfigResponse.statusCode).toBe(200);
    expect(repository.getProjectConfig).toHaveBeenCalledWith('project_1');

    const putConfigResponse = await app.inject({
      method: 'PUT',
      url: '/api/projects/project_1/config',
      headers,
      payload: { configYaml: 'project:\n  id: updated-demo' }
    });
    expect(putConfigResponse.statusCode).toBe(200);
    expect(repository.updateProjectConfig).toHaveBeenCalledWith('project_1', 'project:\n  id: updated-demo');

    const getRunsResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks/task_1/runs',
      headers
    });
    expect(getRunsResponse.statusCode).toBe(200);
    expect(repository.getTaskUsage).toHaveBeenCalledWith('task_1');

    const getDiagnosticsResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks/task_1/diagnostics',
      headers
    });
    expect(getDiagnosticsResponse.statusCode).toBe(200);
    expect(repository.exportTaskDiagnostics).toHaveBeenCalledWith('task_1');
    expect(getDiagnosticsResponse.json()).toEqual(expect.objectContaining({
      correlation: { task: 'task:task_1' },
      runs: [expect.objectContaining({ correlationId: 'task:task_1:run:run_1' })],
      waitingOrBlockedState: expect.objectContaining({ status: 'waiting', reason: 'unavailable_capability' })
    }));
    expect(JSON.stringify(getDiagnosticsResponse.json())).toContain('[secret-redacted]');
    expect(JSON.stringify(getDiagnosticsResponse.json())).not.toContain('sk-route_1234567890abcdef');

    const unmergedPullRequestSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ number: 42, html_url: 'https://github.com/demo/repo/pull/42', merged: false, state: 'open' })
    } as Response);
    const prematureCompletionResponse = await app.inject({
      method: 'POST',
      url: '/api/tasks/task_1/complete',
      headers: withRiskApproval(headers, 'approval_task_1'),
      payload: {}
    });
    expect(prematureCompletionResponse.statusCode).toBe(409);
    expect(prematureCompletionResponse.json().error).toContain('is not merged');
    expect(repository.transitionTask).not.toHaveBeenCalled();
    unmergedPullRequestSpy.mockRestore();

    const pullRequestSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ number: 42, html_url: 'https://github.com/demo/repo/pull/42', merged: true, state: 'closed', merge_commit_sha: 'abc1234' })
    } as Response);
    const completeTaskResponse = await app.inject({
      method: 'POST',
      url: '/api/tasks/task_1/complete',
      headers: withRiskApproval(headers, 'approval_task_complete_1'),
      payload: {}
    });
    expect(completeTaskResponse.statusCode).toBe(200);
    expect(repository.transitionTask).toHaveBeenCalledWith('task_1', 'completed', { source: 'user' });
    expect(completeTaskResponse.json()).toEqual(
      expect.objectContaining({
        id: 'task_1',
        status: 'completed'
      })
    );
    pullRequestSpy.mockRestore();

    const getQueueResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks/task_1/queue',
      headers
    });
    expect(getQueueResponse.statusCode).toBe(200);
    expect(repository.getTaskQueuePosition).toHaveBeenCalledWith('task_1');

    await app.close();
  });

  it('accepts rich task fields and serializes them into prompt payload', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      getOperationalMetrics: vi.fn(async () => ({
        generatedAt: new Date().toISOString(),
        tasks: { total: 0, draft: 0, submitted: 0, active: 0, needsApproval: 0, completed: 0, failed: 0, cancelled: 0, providerFailed: 0, budgetExceeded: 0, iterationLimitReached: 0, repeatedErrorDetected: 0, validationFailed: 0 },
        queue: { pending: 0, claimed: 0, failed: 0, averagePendingWaitSeconds: 0, maxPendingWaitSeconds: 0 },
        approvals: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
        runs: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, averageDurationSeconds: 0, maxDurationSeconds: 0 }
      })),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(async () => ({
        id: 'project_1',
        name: 'Project',
        slug: 'project',
        defaultBranch: 'main',
        defaultTaskMode: 'auto',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(async (input) => ({
        id: 'task_1',
        projectId: input.projectId,
        createdByUserId: 'user_1',
        title: input.title,
        prompt: input.prompt,
        mode: input.mode,
        status: 'draft',
        maxIterations: input.maxIterations,
        maxBudgetUsd: input.maxBudgetUsd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      getTask: vi.fn(),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 0, queuePosition: null })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_provider_frozen_1') return approvedRiskApproval('config_change', id, {
          method: 'POST',
          path: '/api/providers/connect',
          body: {
            provider: 'github_copilot',
            apiKey: 'github-token',
            model: 'copilot-model'
          }
        });
        if (id === 'approval_provider_connect_1') return approvedRiskApproval('config_change', id, {
          method: 'POST',
          path: '/api/providers/connect',
          body: {
            provider: 'openai',
            apiKey: 'sk-test',
            model: 'gpt-4o-mini'
          }
        });
        return undefined;
      }),
      consumeRiskApproval: vi.fn(async () => true),
      resolveApproval: vi.fn(),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: {
        projectId: 'project_1',
        title: 'Rich task payload',
        prompt: 'Implement feature according to spec.',
        priority: 'high',
        scopeFiles: ['apps/mobile-pwa/src/App.tsx', 'apps/studio-api/src/routes.ts'],
        acceptanceCriteria: ['Build passes', 'Task reaches ready_for_user_review'],
        runtimeSummary: 'No infra changes allowed.',
        mode: 'safe'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project_1',
        title: 'Rich task payload',
        mode: 'safe',
        prompt: expect.stringContaining('Priority: high')
      })
    );
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Scope Files:\n- apps/mobile-pwa/src/App.tsx')
      })
    );
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Acceptance Criteria:\n- Build passes')
      })
    );

    await app.close();
  });

  it('exposes only the authenticated Google session and revokes it on logout', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 1, queuePosition: 1 })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(),
      resolveApproval: vi.fn(),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();

    const auth = createAuthService();
    registerRoutes(app, repository as never, createNotificationService(), auth);
    const session = auth.createTestSession(ownerUser);
    const cookie = `forgemind_session=${encodeURIComponent(session.id)}`;

    const sessionResponse = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({ user: ownerUser, session: { provider: 'google' } });

    const logoutResponse = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json().userId).toBe('user_1');
    expect((await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).json().session).toBeNull();
    await app.close();
  });

  it('starts only the Google browser login flow', async () => {
    const repository = { getCurrentUser: vi.fn(async () => ownerUser) };
    const auth = createAuthService(undefined, {
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      callbackUrl: 'http://localhost:4000/api/auth/google/callback',
      allowedEmails: new Set([ownerUser.email])
    });
    const app = Fastify();
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({ method: 'POST', url: '/api/auth/google/login' });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ provider: 'google', mode: 'oauth' });
    expect(response.json().authUrl).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(requireSetCookieHeader(response.headers['set-cookie'])).toContain('forgemind_google_oauth=');

    const legacySession = auth.createTestSession(ownerUser);
    const legacyResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/github/login',
      headers: { authorization: `Bearer ${legacySession.id}` }
    });
    expect(legacyResponse.statusCode).toBe(404);
    await app.close();
  });

  it('exposes auth session and provider connect/status endpoints', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 1, queuePosition: 1 })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_provider_frozen_1') return approvedRiskApproval('config_change', id, {
          method: 'POST',
          path: '/api/providers/connect',
          body: {
            provider: 'github_copilot',
            apiKey: 'github-token',
            model: 'copilot-model'
          }
        });
        if (id === 'approval_provider_connect_1') return approvedRiskApproval('config_change', id, {
          method: 'POST',
          path: '/api/providers/connect',
          body: {
            provider: 'openai',
            apiKey: 'sk-test',
            model: 'gpt-4o-mini'
          }
        });
        return undefined;
      }),
      consumeRiskApproval: vi.fn(async () => true),
      resolveApproval: vi.fn(),
      getAIProviderConnection: vi.fn(async () => undefined),
      upsertAIProviderConnection: vi.fn(async (input: { provider: 'openai' | 'codex'; authMode?: 'api_key' | 'codex_oauth'; model: string }) => ({
        userId: 'user_1',
        credentialSource: input.authMode === 'codex_oauth' ? 'codex_oauth' : 'api_key',
        provider: input.provider,
        authMode: input.authMode ?? 'api_key',
        model: input.model,
        apiKeyFingerprint: 'fp_test',
        connectedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const previousProvider = process.env.FORGEMIND_PROVIDER;
    const previousFallback = process.env.FORGEMIND_FALLBACK_PROVIDER;
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    const previousOpenAIModel = process.env.OPENAI_MODEL;
    const app = Fastify();

    try {
      const auth = createAuthService();
      registerRoutes(app, repository as never, createNotificationService(), auth);

      const sessionBefore = await app.inject({
        method: 'GET',
        url: '/api/auth/session'
      });
      expect(sessionBefore.statusCode).toBe(200);
      expect(sessionBefore.json().session).toBeNull();

      const testSession = auth.createTestSession(ownerUser);
      const sessionHeaders = { cookie: `forgemind_session=${encodeURIComponent(testSession.id)}` };
      const frozenCopilotRiskHeaders = withRiskApproval(sessionHeaders, 'approval_provider_frozen_1');
      const providerConnectRiskHeaders = withRiskApproval(sessionHeaders, 'approval_provider_connect_1');

      const sessionAfter = await app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: sessionHeaders
      });
      expect(sessionAfter.statusCode).toBe(200);
      expect(sessionAfter.json().session.provider).toBe('google');

      const statusResponse = await app.inject({
        method: 'GET',
        url: '/api/providers/status',
        headers: sessionHeaders
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json().availableProviders).toContain('openai');
      expect(statusResponse.json().availableProviders).not.toContain('github_copilot');

      const frozenCopilotResponse = await app.inject({
        method: 'POST',
        url: '/api/providers/connect',
        headers: frozenCopilotRiskHeaders,
        payload: {
          provider: 'github_copilot',
          apiKey: 'github-token',
          model: 'copilot-model'
        }
      });
      expect(frozenCopilotResponse.statusCode).toBe(400);
      expect(frozenCopilotResponse.json().error).toContain('frozen');

      const connectResponse = await app.inject({
        method: 'POST',
        url: '/api/providers/connect',
        headers: providerConnectRiskHeaders,
        payload: {
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'gpt-4o-mini'
        }
      });
      expect(connectResponse.statusCode).toBe(200);
      expect(connectResponse.json().ok).toBe(true);
      expect(connectResponse.json().provider).toBe('openai');
      expect(connectResponse.json().model).toBe('gpt-4o-mini');
      expect(repository.upsertAIProviderConnection).toHaveBeenCalledWith({
        provider: 'openai',
        authMode: 'api_key',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        accountSummary: undefined,
        codexHome: undefined
      });
      expect(repository.writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'provider_connected',
          actorId: 'user_1'
        })
      );
    } finally {
      restoreEnv('FORGEMIND_PROVIDER', previousProvider);
      restoreEnv('FORGEMIND_FALLBACK_PROVIDER', previousFallback);
      restoreEnv('OPENAI_API_KEY', previousOpenAIKey);
      restoreEnv('OPENAI_MODEL', previousOpenAIModel);
      await app.close();
    }
  });

  it('connects and disconnects GitHub worker adapter with token verification', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 0, queuePosition: null })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_github_connect_1') return approvedRiskApproval('config_change', id, {
          method: 'POST',
          path: '/api/github/connect',
          body: {
            token: 'Bearer github-token'
          }
        });
        if (id === 'approval_github_disconnect_1') return approvedRiskApproval('config_change', id, {
          method: 'POST',
          path: '/api/github/disconnect'
        });
        return undefined;
      }),
      consumeRiskApproval: vi.fn(async () => true),
      resolveApproval: vi.fn(),
      getGitHubConnection: vi.fn(async () => undefined),
      getGitHubConnectionSecret: vi.fn(async () => ({
        userId: 'user_1',
        credentialSource: 'token',
        apiBaseUrl: 'https://api.github.com',
        tokenFingerprint: 'token-fingerprint',
        connectedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: 'github-token'
      })),
      upsertGitHubConnection: vi.fn(async (input: { apiBaseUrl: string }) => ({
        userId: 'user_1',
        credentialSource: 'token',
        apiBaseUrl: input.apiBaseUrl,
        tokenFingerprint: 'token-fingerprint',
        connectedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      deleteGitHubConnection: vi.fn(async () => true),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const previousAdapter = process.env.FORGEMIND_GITHUB_ADAPTER;
    const previousToken = process.env.GITHUB_TOKEN;
    const previousApiBaseUrl = process.env.GITHUB_API_BASE_URL;
    delete process.env.FORGEMIND_GITHUB_ADAPTER;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_API_BASE_URL;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rate: {
          limit: 5000,
          remaining: 4999
        }
      })
    } as Response);

    const app = Fastify();
    const auth = createAuthService();
    const user = { id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' as const };
    const sessionHeaders = createAuthenticatedHeaders(auth, user);
    const githubConnectRiskHeaders = withRiskApproval(sessionHeaders, 'approval_github_connect_1');
    const githubDisconnectRiskHeaders = withRiskApproval(sessionHeaders, 'approval_github_disconnect_1');
    registerRoutes(app, repository as never, createNotificationService(), auth);

    const statusBefore = await app.inject({
      method: 'GET',
      url: '/api/github/status',
      headers: sessionHeaders
    });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json().adapter).toBe('none');

    const connectResponse = await app.inject({
      method: 'POST',
      url: '/api/github/connect',
      headers: githubConnectRiskHeaders,
      payload: {
        token: 'Bearer github-token'
      }
    });
    expect(connectResponse.statusCode).toBe(200);
    expect(connectResponse.json().status.adapter).toBe('app');
    expect(connectResponse.json().status.credentialSource).toBe('token');
    expect(connectResponse.json().status.persistent).toBe(true);
    expect(connectResponse.json().check.rateLimit.remaining).toBe(4999);
    expect(repository.upsertGitHubConnection).toHaveBeenCalledWith({
      token: 'github-token',
      apiBaseUrl: 'https://api.github.com'
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/rate_limit',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token'
        })
      })
    );
    expect(repository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'github_adapter_connected',
        actorId: 'user_1',
        payload: expect.objectContaining({
          hasToken: true,
          persistent: true,
          tokenFingerprint: 'token-fingerprint'
        })
      })
    );

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          full_name: 'demo/repo',
          name: 'repo',
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/demo/repo',
          owner: { login: 'demo' }
        }
      ]
    } as Response);
    const repositoriesResponse = await app.inject({
      method: 'GET',
      url: '/api/github/repositories?limit=10',
      headers: sessionHeaders
    });
    expect(repositoriesResponse.statusCode).toBe(200);
    expect(repositoriesResponse.json()).toEqual([
      expect.objectContaining({
        fullName: 'demo/repo',
        owner: 'demo',
        repo: 'repo'
      })
    ]);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=10&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token'
        })
      })
    );

    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          login: 'demo',
          avatar_url: 'https://avatars.githubusercontent.com/u/1'
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            login: 'demo-org',
            avatar_url: 'https://avatars.githubusercontent.com/u/2',
            description: 'Demo org'
          }
        ]
      } as Response);
    const ownersResponse = await app.inject({
      method: 'GET',
      url: '/api/github/repository-owners?limit=10',
      headers: sessionHeaders
    });
    expect(ownersResponse.statusCode).toBe(200);
    expect(ownersResponse.json()).toEqual([
      {
        login: 'demo',
        kind: 'user',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1'
      },
      {
        login: 'demo-org',
        kind: 'organization',
        avatarUrl: 'https://avatars.githubusercontent.com/u/2',
        description: 'Demo org'
      }
    ]);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'https://api.github.com/user/orgs?per_page=9&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token'
        })
      })
    );

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          name: 'main',
          protected: true,
          commit: { sha: 'main-sha' }
        }
      ]
    } as Response);
    const branchesResponse = await app.inject({
      method: 'GET',
      url: '/api/github/branches?owner=demo&repo=repo&limit=10',
      headers: sessionHeaders
    });
    expect(branchesResponse.statusCode).toBe(200);
    expect(branchesResponse.json()).toEqual([
      {
        name: 'main',
        sha: 'main-sha',
        protected: true
      }
    ]);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/demo/repo/branches?per_page=10&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer github-token'
        })
      })
    );

    const disconnectResponse = await app.inject({
      method: 'POST',
      url: '/api/github/disconnect',
      headers: githubDisconnectRiskHeaders
    });
    expect(disconnectResponse.statusCode).toBe(200);
    expect(disconnectResponse.json().status.adapter).toBe('none');
    expect(repository.deleteGitHubConnection).toHaveBeenCalled();
    expect(process.env.FORGEMIND_GITHUB_ADAPTER).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();

    fetchSpy.mockRestore();
    restoreEnv('FORGEMIND_GITHUB_ADAPTER', previousAdapter);
    restoreEnv('GITHUB_TOKEN', previousToken);
    restoreEnv('GITHUB_API_BASE_URL', previousApiBaseUrl);
    await app.close();
  });

  it('exposes notification subscription and settings endpoints', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 1, queuePosition: 1 })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(),
      resolveApproval: vi.fn(),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, createNotificationService(), auth);

    const previousVapid = process.env.VAPID_PUBLIC_KEY;
    process.env.VAPID_PUBLIC_KEY = 'BMOCK_PUBLIC_VAPID_KEY';

    const subscribeResponse = await app.inject({
      method: 'POST',
      url: '/api/notifications/subscribe',
      headers,
      payload: {
        endpoint: 'https://push.example.com/subscription/1',
        deviceName: 'Test phone'
      }
    });
    expect(subscribeResponse.statusCode).toBe(201);

    const getSettingsResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/settings',
      headers
    });
    expect(getSettingsResponse.statusCode).toBe(200);
    expect(getSettingsResponse.json().subscriptions).toHaveLength(1);

    const vapidKeyResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/vapid-public-key',
      headers
    });
    expect(vapidKeyResponse.statusCode).toBe(200);
    expect(vapidKeyResponse.json().publicKey).toBe('BMOCK_PUBLIC_VAPID_KEY');

    const putSettingsResponse = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      headers,
      payload: {
        taskUpdates: false
      }
    });
    expect(putSettingsResponse.statusCode).toBe(200);
    expect(putSettingsResponse.json().settings.taskUpdates).toBe(false);

    const unsubscribeResponse = await app.inject({
      method: 'POST',
      url: '/api/notifications/unsubscribe',
      headers,
      payload: {
        endpoint: 'https://push.example.com/subscription/1'
      }
    });
    expect(unsubscribeResponse.statusCode).toBe(200);
    expect(unsubscribeResponse.json().removed).toBe(true);

    if (previousVapid === undefined) {
      delete process.env.VAPID_PUBLIC_KEY;
    } else {
      process.env.VAPID_PUBLIC_KEY = previousVapid;
    }

    await app.close();
  });

  it('verifies GitHub webhook signature and rejects invalid payloads', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 1, queuePosition: 1 })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(),
      resolveApproval: vi.fn(),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    await app.register(rawBody, {
      field: 'rawBody',
      global: false,
      encoding: false,
      runFirst: true
    });
    const auth = createAuthService();
    registerRoutes(app, repository as never, undefined, auth);

    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' } });
    const secret = 'webhook-secret';
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = secret;

    const validResponse = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signGitHubWebhookPayload(payload, secret),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery_1'
      }
    });
    expect(validResponse.statusCode).toBe(202);
    expect(repository.writeAudit).toHaveBeenCalled();
    expect(repository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'github',
        eventType: 'github_webhook_issues',
        payload: expect.objectContaining({
          event: 'issues',
          delivery: 'delivery_1',
          action: 'opened'
        })
      })
    );

    const duplicateResponse = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signGitHubWebhookPayload(payload, secret),
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery_1'
      }
    });
    expect(duplicateResponse.statusCode).toBe(202);
    expect(duplicateResponse.json().duplicate).toBe(true);

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalid',
        'x-github-event': 'issues'
      }
    });
    expect(invalidResponse.statusCode).toBe(401);

    delete process.env.GITHUB_WEBHOOK_SECRET;
    const missingSecretResponse = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signGitHubWebhookPayload(payload, secret),
        'x-github-event': 'issues'
      }
    });
    expect(missingSecretResponse.statusCode).toBe(503);

    if (previousSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }

    await app.close();
  });

  it('does not expose the historical approval-resume endpoint', async () => {
    const repository = {
      getCurrentUser: vi.fn(async () => ({ id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' })),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: 0,
        activeTaskCount: 0,
        updatedAt: new Date().toISOString()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(),
      getProject: vi.fn(),
      updateProject: vi.fn(),
      getProjectConfig: vi.fn(),
      updateProjectConfig: vi.fn(),
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      getTask: vi.fn(async () => ({
        id: 'task_1',
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Demo task',
        prompt: 'Do the thing',
        mode: 'safe',
        status: 'needs_approval',
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      getTaskQueuePosition: vi.fn(async () => ({ queueDepth: 2, queuePosition: 1 })),
      enqueueTask: vi.fn(async () => ({ enqueued: true })),
      startTask: vi.fn(),
      cancelTask: vi.fn(),
      retryTask: vi.fn(async () => ({
        id: 'task_1',
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Demo task',
        prompt: 'Do the thing',
        mode: 'safe',
        status: 'submitted',
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })),
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => [
        {
          id: 'approval_1',
          taskId: 'task_1',
          type: 'new_dependency',
          status: 'approved',
          requestedBy: 'agent',
          title: 'Approval required',
          description: 'Approve dependency update',
          riskLevel: 'medium',
          payload: {},
          createdAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString()
        }
      ]),
      getApproval: vi.fn(async () => ({
        id: 'approval_1',
        taskId: 'task_1',
        type: 'new_dependency',
        status: 'pending',
        requestedBy: 'agent',
        title: 'Approval required',
        description: 'Approve dependency update',
        riskLevel: 'medium',
        payload: {},
        createdAt: new Date().toISOString()
      })),
      resolveApproval: vi.fn(async () => ({
        id: 'approval_1',
        taskId: 'task_1',
        type: 'new_dependency',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required',
        description: 'Approve dependency update',
        riskLevel: 'medium',
        payload: {},
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString()
      })),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval_1/approve',
      headers
    });

    expect(response.statusCode).toBe(404);
    expect(repository.resolveApproval).not.toHaveBeenCalled();
    expect(repository.retryTask).not.toHaveBeenCalled();
    expect(repository.enqueueTask).not.toHaveBeenCalled();

    await app.close();
  });

  it('covers API -> worker -> GitHub adapter -> mobile read model projection', async () => {
    const now = () => new Date().toISOString();
    const user = { id: 'user_1', email: 'owner@example.com', name: 'Owner', role: 'owner' as const };
    const projects = new Map<string, {
      id: string;
      name: string;
      slug: string;
      githubOwner: string;
      githubRepo: string;
      defaultBranch: string;
      configYaml?: string;
      isActive: boolean;
      createdAt: string;
      updatedAt: string;
    }>();
    const tasks = new Map<string, {
      id: string;
      projectId: string;
      createdByUserId: string;
      title: string;
      prompt: string;
      mode: 'safe' | 'auto' | 'full_auto';
      status: string;
      githubIssueNumber?: number;
      githubIssueUrl?: string;
      branchName?: string;
      pullRequestNumber?: number;
      pullRequestUrl?: string;
      maxIterations: number;
      maxBudgetUsd: number;
      createdAt: string;
      updatedAt: string;
      startedAt?: string;
      finishedAt?: string;
    }>();
    const queue: string[] = [];
    const audit: Array<{ id: string; eventType: string; taskId?: string; payload?: unknown; createdAt: string }> = [];

    const repository = {
      getCurrentUser: vi.fn(async () => user),
      getWorkerStatus: vi.fn(async () => ({
        state: 'idle',
        queuedTaskCount: queue.length,
        activeTaskCount: 0,
        updatedAt: now()
      })),
      getRecentWorkerEvents: vi.fn(async () => []),
      getOperationalMetrics: vi.fn(async () => ({
        generatedAt: now(),
        tasks: { total: tasks.size, draft: 0, submitted: 0, active: 0, needsApproval: 0, completed: 0, failed: 0, cancelled: 0, providerFailed: 0, budgetExceeded: 0, iterationLimitReached: 0, repeatedErrorDetected: 0, validationFailed: 0 },
        queue: { pending: queue.length, claimed: 0, failed: 0, averagePendingWaitSeconds: 0, maxPendingWaitSeconds: 0 },
        approvals: { pending: 0, approved: 0, rejected: 0, cancelled: 0 },
        runs: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, averageDurationSeconds: 0, maxDurationSeconds: 0 }
      })),
      listProjects: vi.fn(async () => Array.from(projects.values())),
      createProject: vi.fn(async (input) => {
        const id = `project_${randomUUID()}`;
        const project = {
          id,
          name: input.name,
          slug: input.slug,
          githubOwner: input.githubOwner,
          githubRepo: input.githubRepo,
          defaultBranch: input.defaultBranch,
          configYaml: input.configYaml,
          isActive: true,
          createdAt: now(),
          updatedAt: now()
        };
        projects.set(id, project);
        return project;
      }),
      getProject: vi.fn(async (id: string) => projects.get(id)),
      updateProject: vi.fn(async (id: string, input: Record<string, unknown>) => {
        const current = projects.get(id);
        if (!current) return undefined;
        const updated = {
          ...current,
          ...input,
          updatedAt: now()
        };
        projects.set(id, updated);
        return updated;
      }),
      getProjectConfig: vi.fn(async (id: string) => {
        const project = projects.get(id);
        if (!project) return undefined;
        return { projectId: id, configYaml: project.configYaml ?? null };
      }),
      updateProjectConfig: vi.fn(async (id: string, configYaml: string) => {
        const project = projects.get(id);
        if (!project) return undefined;
        const updated = { ...project, configYaml, updatedAt: now() };
        projects.set(id, updated);
        return { projectId: id, configYaml: updated.configYaml ?? null };
      }),
      listTasks: vi.fn(async () => Array.from(tasks.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
      createTask: vi.fn(async (input) => {
        const id = `task_${randomUUID()}`;
        const task = {
          id,
          projectId: input.projectId,
          createdByUserId: user.id,
          title: input.title,
          prompt: input.prompt,
          mode: input.mode,
          status: 'draft',
          maxIterations: input.maxIterations,
          maxBudgetUsd: input.maxBudgetUsd,
          createdAt: now(),
          updatedAt: now()
        };
        tasks.set(id, task);
        return task;
      }),
      getTask: vi.fn(async (id: string) => tasks.get(id)),
      startTask: vi.fn(async (id: string) => {
        const task = tasks.get(id);
        if (!task) return undefined;
        const updated = { ...task, status: 'submitted', startedAt: now(), updatedAt: now() };
        tasks.set(id, updated);
        return updated;
      }),
      cancelTask: vi.fn(async (id: string) => {
        const task = tasks.get(id);
        if (!task) return undefined;
        const updated = { ...task, status: 'cancelled', finishedAt: now(), updatedAt: now() };
        tasks.set(id, updated);
        return updated;
      }),
      retryTask: vi.fn(async (id: string, start: boolean) => {
        const task = tasks.get(id);
        if (!task) return undefined;
        const updated = { ...task, status: start ? 'submitted' : 'draft', updatedAt: now() };
        tasks.set(id, updated);
        return updated;
      }),
      getTaskQueuePosition: vi.fn(async (taskId: string) => ({
        queueDepth: queue.length,
        queuePosition: queue.indexOf(taskId) >= 0 ? queue.indexOf(taskId) + 1 : null
      })),
      enqueueTask: vi.fn(async (taskId: string) => {
        if (!queue.includes(taskId)) {
          queue.push(taskId);
        }
        return { enqueued: true };
      }),
      listTaskAudit: vi.fn(async (taskId: string) => audit.filter((item) => item.taskId === taskId)),
      getTaskDiff: vi.fn(async (taskId: string) => ({ taskId, filesChanged: 1, insertions: 4, deletions: 0, iterations: [] })),
      getTaskUsage: vi.fn(async (taskId: string) => ({
        taskId,
        inputTokens: 20,
        outputTokens: 10,
        cachedTokens: 0,
        totalTokens: 30,
        usageSource: 'actual_breakdown',
        actualCostUsd: null,
        estimatedCostUsd: 0.02,
        runs: [],
        records: []
      })),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(async (id: string) => {
        if (id === 'approval_pipeline_task_start_1') {
          const taskId = Array.from(tasks.keys())[0];
          return taskId
            ? approvedRiskApproval('risky_refactor', id, {
                method: 'POST',
                path: `/api/tasks/${taskId}/start`,
                body: {}
              })
            : undefined;
        }
        return undefined;
      }),
      consumeRiskApproval: vi.fn(async () => true),
      resolveApproval: vi.fn(),
      writeAudit: vi.fn(async (entry) => {
        const item = { id: `audit_${randomUUID()}`, createdAt: now(), ...entry };
        audit.push(item);
        return item;
      }),
      transitionTask: vi.fn(async (taskId: string, status: string, payload?: Record<string, unknown>) => {
        const task = tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        const updated = {
          ...task,
          status,
          pullRequestUrl: typeof payload?.pullRequestUrl === 'string' ? payload.pullRequestUrl : task.pullRequestUrl,
          branchName: typeof payload?.branchName === 'string' ? payload.branchName : task.branchName,
          finishedAt: status === 'ready_for_user_review' ? now() : task.finishedAt,
          updatedAt: now()
        };
        tasks.set(taskId, updated);
        return updated;
      }),
      updateTaskGitHubFields: vi.fn(async (taskId: string, fields: Record<string, unknown>) => {
        const task = tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        const updated = { ...task, ...fields, updatedAt: now() };
        tasks.set(taskId, updated);
        return updated;
      })
    };

    const app = Fastify();
    const auth = createAuthService();
    const headers = createOwnerAuthenticatedHeaders(auth);
    registerRoutes(app, repository as never, undefined, auth);

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: {
        name: 'Pipeline project',
        slug: 'pipeline-project',
        githubOwner: 'demo',
        githubRepo: 'pipeline-project',
        defaultBranch: 'main'
      }
    });
    expect(projectResponse.statusCode).toBe(201);
    const createdProject = projectResponse.json() as { id: string; defaultBranch: string; githubOwner: string; githubRepo: string; name: string; slug: string; isActive: boolean; createdAt: string; updatedAt: string };

    const createTaskResponse = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers,
      payload: {
        projectId: createdProject.id,
        title: 'Pipeline test task',
        prompt: 'Ship gallery improvements with acceptance criteria and limits.',
        priority: 'high',
        scopeFiles: ['apps/mobile-pwa/src/App.tsx'],
        acceptanceCriteria: ['Build passes', 'PR is created'],
        runtimeSummary: 'No backend migrations.',
        mode: 'safe',
        maxIterations: 5,
        maxBudgetUsd: 3
      }
    });
    expect(createTaskResponse.statusCode).toBe(201);
    const createdTask = createTaskResponse.json() as { id: string; prompt: string; projectId: string; title: string; maxIterations: number; maxBudgetUsd: number; mode: 'safe' | 'auto' | 'full_auto'; status: string; createdAt: string; updatedAt: string; createdByUserId: string };
    expect(createdTask.prompt).toContain('Acceptance Criteria:\n- Build passes');

    const startResponse = await app.inject({
      method: 'POST',
      url: `/api/tasks/${createdTask.id}/start`,
      headers: withRiskApproval(headers, 'approval_pipeline_task_start_1'),
      payload: {}
    });
    expect(startResponse.statusCode).toBe(200);

    const workerProvider: AIProvider = {
      kind: 'codex',
    async preflight() { return { provider: 'codex', ok: true, checkedAt: new Date().toISOString() }; },
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan generated for pipeline test',
          steps: ['Implement', 'Validate', 'Open draft PR'],
          acceptanceCriteria: ['Build passes', 'PR exists']
        };
      },
      async implement(_input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: 'Implementation done',
          changedFiles: ['README.md'],
          diffStat: { filesChanged: 1, insertions: 3, deletions: 0 },
          validationChecks: [{ kind: 'command', command: 'node --version' }],
          fileUpdates: [{ path: 'README.md', content: '# Pipeline test\n' }]
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        return {
          verdict: 'satisfied',
          summary: 'Review ok',
          blockers: [],
          criterionResults: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 20,
          outputTokens: 10,
          estimatedCostUsd: 0.02
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const workerGitHub: GitHubAdapter = {
      async createIssue() {
        return {
          issueNumber: 901,
          issueUrl: `https://github.com/${createdProject.githubOwner}/${createdProject.githubRepo}/issues/901`
        };
      },
      getRemoteUrl() {
        return undefined;
      },
      async createBranch() {
        return undefined;
      },
      async commitAndPush() {
        return undefined;
      },
      async createDraftPullRequest() {
        return {
          pullRequestNumber: 902,
          pullRequestUrl: `https://github.com/${createdProject.githubOwner}/${createdProject.githubRepo}/pull/902`
        };
      },
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    const runWorkerTask = await loadRunWorkerTask();
    const workerResult = await runWorkerTask({
      project: createdProject as never,
      task: (await repository.getTask(createdTask.id)) as never,
      provider: workerProvider,
      github: workerGitHub,
      verifyCommand: 'node --version',
      resourcePolicy: { allowNetwork: true, minFreeSpaceMb: 0, retentionDays: 14 },
      workspaceRoot: join(tmpdir(), `forgemind-step21-${randomUUID()}`),
      hooks: {
        onStatus: async (status: string, payload: unknown) => {
          await repository.transitionTask(createdTask.id, status, payload as Record<string, unknown>);
        },
        onIssue: async (issue: { issueNumber: number; issueUrl: string }) => {
          await repository.updateTaskGitHubFields(createdTask.id, {
            githubIssueNumber: issue.issueNumber,
            githubIssueUrl: issue.issueUrl
          });
        },
        onBranch: async (branchName: string) => {
          await repository.updateTaskGitHubFields(createdTask.id, { branchName });
        },
        onPullRequest: async (pullRequest: { pullRequestNumber: number; pullRequestUrl: string }) => {
          await repository.updateTaskGitHubFields(createdTask.id, {
            pullRequestNumber: pullRequest.pullRequestNumber,
            pullRequestUrl: pullRequest.pullRequestUrl
          });
        }
      }
    });

    expect(workerResult.status).toBe('ready_for_user_review');
    await repository.transitionTask(createdTask.id, 'ready_for_user_review', {
      branchName: workerResult.branchName,
      pullRequestUrl: workerResult.pullRequestUrl ?? null
    });

    const listTasksResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: createOwnerAuthenticatedHeaders(auth)
    });
    expect(listTasksResponse.statusCode).toBe(200);
    const apiTasks = listTasksResponse.json() as Array<{
      id: string;
      title: string;
      status: string;
      branchName?: string;
      githubIssueUrl?: string;
      pullRequestUrl?: string;
    }>;
    const pipelineTask = apiTasks.find((item) => item.id === createdTask.id);
    expect(pipelineTask).toBeTruthy();
    expect(pipelineTask?.status).toBe('ready_for_user_review');
    expect(pipelineTask?.githubIssueUrl).toContain('/issues/901');
    expect(pipelineTask?.pullRequestUrl).toContain('/pull/902');
    expect(pipelineTask?.branchName).toMatch(/^ai\//);

    // Mobile read-model projection smoke: API payload contains fields consumed by mobile TaskSummary mapping.
    const mobileReadModel = {
      id: pipelineTask?.id,
      title: pipelineTask?.title,
      status: pipelineTask?.status,
      issueUrl: pipelineTask?.githubIssueUrl,
      pullRequestUrl: pipelineTask?.pullRequestUrl,
      branchName: pipelineTask?.branchName
    };
    expect(mobileReadModel.status).toBe('ready_for_user_review');
    expect(mobileReadModel.pullRequestUrl).toContain('/pull/902');

    await app.close();
  }, 30000);
});
