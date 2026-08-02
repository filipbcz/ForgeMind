import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, CostEstimateResult, ImplementInput, ImplementResult, PlanInput, PlanResult, ReviewInput, ReviewResult } from '@forgemind/providers';
import type { GitHubAdapter } from '@forgemind/github';
import { createAuthService } from './auth.js';
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

describe('Studio API routes', () => {
  it('exposes worker status endpoint', async () => {
    let queuePaused = false;
    const repository = {
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
    registerRoutes(app, repository as never);

    const response = await app.inject({
      method: 'GET',
      url: '/api/worker/status'
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
      payload: { paused: true }
    });

    expect(pauseResponse.statusCode).toBe(200);
    expect(repository.setWorkerQueuePaused).toHaveBeenCalledWith(true);
    expect(pauseResponse.json()).toEqual(expect.objectContaining({ queuePaused: true }));

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/worker/events?limit=10'
    });

    expect(eventsResponse.statusCode).toBe(200);
    expect(repository.getRecentWorkerEvents).toHaveBeenCalledWith(10);

    const metricsResponse = await app.inject({
      method: 'GET',
      url: '/api/metrics'
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
      listTaskAudit: vi.fn(),
      getTaskDiff: vi.fn(),
      getTaskUsage: vi.fn(),
      listApprovals: vi.fn(async () => []),
      getApproval: vi.fn(),
      resolveApproval: vi.fn(),
      getImplementationStepByTaskId: vi.fn(async () => undefined),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    registerRoutes(app, repository as never);

    const getProjectResponse = await app.inject({
      method: 'GET',
      url: '/api/projects/project_1'
    });
    expect(getProjectResponse.statusCode).toBe(200);
    expect(repository.getProject).toHaveBeenCalledWith('project_1');

    const patchProjectResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      payload: {
        name: 'Updated demo',
        defaultBranch: 'develop',
        brief: 'Updated project objective with enough detail.'
      }
    });
    expect(patchProjectResponse.statusCode).toBe(200);
    expect(repository.updateProject).toHaveBeenCalledWith('project_1', {
      name: 'Updated demo',
      defaultBranch: 'develop',
      brief: 'Updated project objective with enough detail.'
    });

    const clearProjectBriefResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      payload: { brief: null }
    });
    expect(clearProjectBriefResponse.statusCode).toBe(200);
    expect(repository.updateProject).toHaveBeenLastCalledWith('project_1', { brief: null });

    const shortProjectBriefResponse = await app.inject({
      method: 'PATCH',
      url: '/api/projects/project_1',
      payload: { brief: 'Too short' }
    });
    expect(shortProjectBriefResponse.statusCode).toBe(400);

    const invalidDeleteResponse = await app.inject({
      method: 'DELETE',
      url: '/api/projects/project_1',
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
      url: '/api/projects/project_1/config'
    });
    expect(getConfigResponse.statusCode).toBe(200);
    expect(repository.getProjectConfig).toHaveBeenCalledWith('project_1');

    const putConfigResponse = await app.inject({
      method: 'PUT',
      url: '/api/projects/project_1/config',
      payload: { configYaml: 'project:\n  id: updated-demo' }
    });
    expect(putConfigResponse.statusCode).toBe(200);
    expect(repository.updateProjectConfig).toHaveBeenCalledWith('project_1', 'project:\n  id: updated-demo');

    const getRunsResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks/task_1/runs'
    });
    expect(getRunsResponse.statusCode).toBe(200);
    expect(repository.getTaskUsage).toHaveBeenCalledWith('task_1');

    const completeTaskResponse = await app.inject({
      method: 'POST',
      url: '/api/tasks/task_1/complete',
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

    const getQueueResponse = await app.inject({
      method: 'GET',
      url: '/api/tasks/task_1/queue'
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
      getApproval: vi.fn(),
      resolveApproval: vi.fn(),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
    };

    const app = Fastify();
    registerRoutes(app, repository as never);

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        projectId: 'project_1',
        title: 'Rich task payload',
        prompt: 'Implement feature according to spec.',
        priority: 'high',
        scopeFiles: ['apps/mobile-pwa/src/App.tsx', 'apps/studio-api/src/routes.ts'],
        acceptanceCriteria: ['Build passes', 'Task reaches ready_for_user_review'],
        runtimeSummary: 'No infra changes allowed.',
        mode: 'safe',
        maxIterations: 12,
        maxBudgetUsd: 3
      }
    });

    expect(response.statusCode).toBe(201);
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project_1',
        title: 'Rich task payload',
        mode: 'safe',
        maxIterations: 12,
        maxBudgetUsd: 3,
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

  it('exposes GitHub auth scaffold endpoints', async () => {
    const previousClientId = process.env.GITHUB_CLIENT_ID;
    const previousCallbackUrl = process.env.GITHUB_CALLBACK_URL;
    process.env.GITHUB_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:4000/api/auth/github/callback';

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

    try {
      registerRoutes(app, repository as never, createNotificationService(), createAuthService());

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/github/login'
      });
      expect(loginResponse.statusCode).toBe(202);
      const loginPayload = loginResponse.json();
      expect(loginPayload.provider).toBe('github');
      expect(loginPayload.state).toBeTruthy();

      const callbackResponse = await app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?code=test-github-code&state=${encodeURIComponent(loginPayload.state)}`
      });
      expect(callbackResponse.statusCode).toBe(200);
      expect(callbackResponse.json().session.provider).toBe('github');

      const logoutResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/logout'
      });
      expect(logoutResponse.statusCode).toBe(200);
      expect(logoutResponse.json().userId).toBe('user_1');
    } finally {
      await app.close();
      restoreEnv('GITHUB_CLIENT_ID', previousClientId);
      restoreEnv('GITHUB_CALLBACK_URL', previousCallbackUrl);
    }
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
      getApproval: vi.fn(),
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
    const previousClientId = process.env.GITHUB_CLIENT_ID;
    const previousCallbackUrl = process.env.GITHUB_CALLBACK_URL;
    process.env.GITHUB_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:4000/api/auth/github/callback';

    const app = Fastify();

    try {
      registerRoutes(app, repository as never, createNotificationService(), createAuthService());

      const sessionBefore = await app.inject({
        method: 'GET',
        url: '/api/auth/session'
      });
      expect(sessionBefore.statusCode).toBe(200);
      expect(sessionBefore.json().session).toBeNull();

      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/github/login'
      });
      expect(loginResponse.statusCode).toBe(202);
      const loginPayload = loginResponse.json();

      const callbackResponse = await app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?code=test-github-code&state=${encodeURIComponent(loginPayload.state)}`
      });
      expect(callbackResponse.statusCode).toBe(200);

      const sessionAfter = await app.inject({
        method: 'GET',
        url: '/api/auth/session'
      });
      expect(sessionAfter.statusCode).toBe(200);
      expect(sessionAfter.json().session.provider).toBe('github');

      const statusResponse = await app.inject({
        method: 'GET',
        url: '/api/providers/status'
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json().availableProviders).toContain('openai');

      const connectResponse = await app.inject({
        method: 'POST',
        url: '/api/providers/connect',
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
      restoreEnv('GITHUB_CLIENT_ID', previousClientId);
      restoreEnv('GITHUB_CALLBACK_URL', previousCallbackUrl);
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
      getApproval: vi.fn(),
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
    registerRoutes(app, repository as never, createNotificationService(), createAuthService());

    const statusBefore = await app.inject({
      method: 'GET',
      url: '/api/github/status'
    });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json().adapter).toBe('none');

    const connectResponse = await app.inject({
      method: 'POST',
      url: '/api/github/connect',
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
      url: '/api/github/repositories?limit=10'
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
      url: '/api/github/repository-owners?limit=10'
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
      url: '/api/github/branches?owner=demo&repo=repo&limit=10'
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
      url: '/api/github/disconnect'
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
    registerRoutes(app, repository as never, createNotificationService());

    const previousVapid = process.env.VAPID_PUBLIC_KEY;
    process.env.VAPID_PUBLIC_KEY = 'BMOCK_PUBLIC_VAPID_KEY';

    const subscribeResponse = await app.inject({
      method: 'POST',
      url: '/api/notifications/subscribe',
      payload: {
        endpoint: 'https://push.example.com/subscription/1',
        deviceName: 'Test phone'
      }
    });
    expect(subscribeResponse.statusCode).toBe(201);

    const getSettingsResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/settings'
    });
    expect(getSettingsResponse.statusCode).toBe(200);
    expect(getSettingsResponse.json().subscriptions).toHaveLength(1);

    const vapidKeyResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/vapid-public-key'
    });
    expect(vapidKeyResponse.statusCode).toBe(200);
    expect(vapidKeyResponse.json().publicKey).toBe('BMOCK_PUBLIC_VAPID_KEY');

    const putSettingsResponse = await app.inject({
      method: 'PUT',
      url: '/api/notifications/settings',
      payload: {
        approvalRequests: false,
        budgetAlerts: true
      }
    });
    expect(putSettingsResponse.statusCode).toBe(200);
    expect(putSettingsResponse.json().settings.approvalRequests).toBe(false);

    const unsubscribeResponse = await app.inject({
      method: 'POST',
      url: '/api/notifications/unsubscribe',
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
    registerRoutes(app, repository as never);

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

  it('resumes and enqueues task after final approval is approved', async () => {
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
      getApproval: vi.fn(),
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
    registerRoutes(app, repository as never);

    const response = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval_1/approve'
    });

    expect(response.statusCode).toBe(200);
    expect(repository.resolveApproval).toHaveBeenCalledWith('approval_1', 'approved');
    expect(repository.retryTask).toHaveBeenCalledWith('task_1', true);
    expect(repository.enqueueTask).toHaveBeenCalledWith('task_1', 'task_retried');
    expect(repository.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'task_enqueued',
        taskId: 'task_1'
      })
    );

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
      getApproval: vi.fn(),
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
    registerRoutes(app, repository as never);

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
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
      payload: {}
    });
    expect(startResponse.statusCode).toBe(200);

    const workerProvider: AIProvider = {
      kind: 'codex',
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
          requestedApprovals: [],
          fileUpdates: [{ path: 'README.md', content: '# Pipeline test\n' }]
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        return {
          summary: 'Review ok',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
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
      url: '/api/tasks'
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
