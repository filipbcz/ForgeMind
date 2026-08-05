import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createProvider } from '@forgemind/providers';
import type { PlanResult } from '@forgemind/providers';
import {
  checkGitHubConnection,
  createGitHubBranch,
  createGitHubRepository,
  deleteGitHubRepository,
  getGitHubAdapterEnvStatus,
  listGitHubBranches,
  listGitHubRepositoryOwners,
  listGitHubRepositories,
  normalizeGitHubRepositoryInput,
  normalizeGitHubToken
} from '@forgemind/github';
import type { AuthService } from './auth.js';
import { completeCodexOAuthBrowserLogin, readCodexOAuthStatus, resolveCodexHome, startCodexOAuthBrowserLogin } from './codex-oauth.js';
import { createTaskDispatchService } from './dispatch.js';
import { sendBadRequest, sendNotFound } from './http.js';
import { advanceRoadmapAfterTaskCompletion, buildRoadmapStepTaskPrompt } from '@forgemind/db';
import type { AIProviderConnectionKind, ForgeMindRepository } from '@forgemind/db';
import { parseGitHubWebhookPayload, projectGitHubWebhookEvent, verifyGitHubWebhookSignature } from './webhook.js';
import type { NotificationService } from './notifications.js';
import type { TaskMode } from '@forgemind/core';
import { resolveRuntimeEnvVar } from './runtime-env.js';

const projectSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  githubOwner: z.string().min(1).optional(),
  githubRepo: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).default('main'),
  configYaml: z.string().optional(),
  brief: z.string().min(20).optional(),
  autoCreatePullRequest: z.boolean().optional().default(true),
  autoMergePullRequest: z.boolean().optional().default(false),
  autoCompleteTask: z.boolean().optional().default(false),
  allowSafeOperationsWithoutApproval: z.boolean().optional().default(false),
  defaultTaskMode: z.enum(['safe', 'auto', 'full_auto']).optional().default('safe'),
  aiProviderConnectionId: z.string().min(1).nullable().optional(),
  repositoryMode: z.enum(['existing', 'create']).optional().default('existing'),
  branchMode: z.enum(['existing', 'create']).optional().default('existing'),
  branchName: z.string().min(1).optional(),
  repositoryPrivate: z.boolean().optional().default(true),
  repositoryDescription: z.string().max(280).optional()
});

const updateProjectSchema = projectSchema.partial().extend({
  brief: z.string().trim().min(20).nullable().optional(),
  autoCreatePullRequest: z.boolean().optional(),
  autoMergePullRequest: z.boolean().optional(),
  autoCompleteTask: z.boolean().optional(),
  allowSafeOperationsWithoutApproval: z.boolean().optional(),
  defaultTaskMode: z.enum(['safe', 'auto', 'full_auto']).optional(),
  isActive: z.boolean().optional()
});

const deleteProjectSchema = z.object({
  confirmation: z.string().min(1),
  deleteGitHubRepository: z.boolean().optional().default(false)
});

const projectConfigSchema = z.object({
  configYaml: z.string()
});

const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(3),
  prompt: z.string().min(10),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  scopeFiles: z.array(z.string().min(1)).max(50).optional().default([]),
  acceptanceCriteria: z.array(z.string().min(1)).max(30).optional().default([]),
  runtimeSummary: z.string().max(500).optional(),
  mode: z.enum(['safe', 'auto', 'full_auto']).optional(),
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

const roadmapGenerateSchema = z.object({
  objective: z.string().min(20).optional()
});

const roadmapExtensionApprovalSchema = z.object({
  approved: z.boolean(),
  objectiveOverride: z.string().min(20).optional()
});

const githubCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional()
});

const notificationSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z
    .object({
      p256dh: z.string().optional(),
      auth: z.string().optional()
    })
    .optional(),
  deviceName: z.string().min(1).optional()
});

const notificationSettingsSchema = z.object({
  pushEnabled: z.boolean().optional(),
  approvalRequests: z.boolean().optional(),
  taskUpdates: z.boolean().optional(),
  budgetAlerts: z.boolean().optional()
});

const workerEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
});

const workerQueueControlSchema = z.object({
  paused: z.boolean()
});

const providerConnectSchema = z
  .object({
    connectionId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    isDefault: z.boolean().optional(),
    provider: z.enum(['openai', 'codex', 'github_copilot']),
    authMode: z.enum(['api_key', 'codex_oauth']).optional().default('api_key'),
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1)
  })
  .superRefine((input, context) => {
    if (input.authMode === 'api_key' && input.provider !== 'github_copilot' && !input.apiKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: 'API key is required for API key provider auth.'
      });
    }

    if (input.authMode === 'codex_oauth' && input.provider !== 'codex') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authMode'],
        message: 'Codex OAuth can only be used with the codex provider.'
      });
    }
  });

const codexOAuthCompleteSchema = z.object({
  loginId: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  isDefault: z.boolean().optional(),
  model: z.string().min(1)
});

const codexOAuthStartSchema = z.object({
  name: z.string().trim().min(1).max(80).optional()
});

const githubConnectSchema = z.object({
  token: z.string().min(1),
  apiBaseUrl: z.string().url().optional()
});

const projectGitHubRepositorySchema = z.object({
  mode: z.enum(['existing', 'create']).default('existing'),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  branchMode: z.enum(['existing', 'create']).optional().default('existing'),
  branchName: z.string().min(1).optional(),
  private: z.boolean().optional().default(true),
  description: z.string().max(280).optional()
});

const githubRepositoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100)
});

const githubRepositoryOwnersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(100)
});

const githubBranchesQuerySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100)
});

export function registerRoutes(app: FastifyInstance, repository: ForgeMindRepository, notifications?: NotificationService, auth?: AuthService) {
  const dispatcher = createTaskDispatchService(repository);
  const processedWebhookDeliveries = new Set<string>();

  app.post('/api/auth/github/login', async (_request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: 'Auth service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const login = auth.startGitHubLogin();
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'auth_github_login_started',
        payload: { provider: 'github', mode: login.mode }
      });
      return reply.code(202).send(login);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/auth/github/callback', async (request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: 'Auth service is not configured.' });
      }

      const input = githubCallbackQuerySchema.parse(request.query);
      const currentUser = await repository.getCurrentUser();
      const session = auth.completeGitHubCallback(input, currentUser);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'auth_github_callback_completed',
        payload: {
          provider: 'github',
          mode: session.session.mode,
          providerAccess: session.session.providerAccess
        }
      });
      return reply.send(session);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: 'Auth service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const result = auth.logout(currentUser.id);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'auth_logout',
        payload: { provider: 'github', loggedOut: result.loggedOut }
      });
      return reply.send(result);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/auth/session', async (_request, reply) => {
    if (!auth) {
      return reply.code(503).send({ error: 'Auth service is not configured.' });
    }

    const currentUser = await repository.getCurrentUser();
    return {
      user: currentUser,
      session: auth.getSession(currentUser.id)
    };
  });

  app.get('/health', async () => ({
    ok: true,
    service: 'forgemind-studio-api',
    database: Boolean(process.env.DATABASE_URL)
  }));

  app.get('/api/me', async () => repository.getCurrentUser());

  app.get('/api/worker/status', async () => repository.getWorkerStatus());

  app.put('/api/worker/queue', async (request, reply) => {
    try {
      const input = workerQueueControlSchema.parse(request.body);
      await repository.setWorkerQueuePaused(input.paused);
      return repository.getWorkerStatus();
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/worker/events', async (request) => {
    const query = workerEventsQuerySchema.parse(request.query ?? {});
    return repository.getRecentWorkerEvents(query.limit);
  });

  app.get('/api/metrics', async (_request, reply) => {
    const snapshot = await repository.getOperationalMetrics();
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return formatMetrics(snapshot);
  });

  app.get('/api/providers/status', async (_request) => {
    const githubConnection = await readGitHubConnection(repository);
    const providerConnections = await listAIProviderConnections(repository);
    const providerConnection = await readAIProviderConnection(repository);
    const envProvider = process.env.FORGEMIND_PROVIDER === 'openai'
      || process.env.FORGEMIND_PROVIDER === 'codex'
      || process.env.FORGEMIND_PROVIDER === 'github_copilot'
      ? process.env.FORGEMIND_PROVIDER
      : null;
    const currentProvider = providerConnection?.provider ?? envProvider;
    const currentModel = currentProvider ? (providerConnection?.model ?? resolveProviderEnvModel(currentProvider)) : null;
    return {
      currentProvider,
      currentModel,
      currentConnectionId: providerConnection?.id ?? null,
      connections: providerConnections,
      fallbackProvider: process.env.FORGEMIND_FALLBACK_PROVIDER ?? null,
      githubAdapter: githubConnection ? 'app' : getGitHubAdapterEnvStatus().adapter,
      availableProviders: ['openai', 'codex', 'github_copilot'],
      persistent: Boolean(providerConnection),
      credentialSource: providerConnection?.credentialSource ?? (currentProvider ? 'env' : 'none'),
      authMode: providerConnection?.authMode ?? null,
      apiKeyFingerprint: providerConnection?.apiKeyFingerprint ?? null,
      codexHome: providerConnection?.codexHome ?? (currentProvider === 'codex' ? resolveCodexHome() : null),
      accountSummary: providerConnection?.accountSummary ?? null,
      connectedAt: providerConnection?.connectedAt ?? null,
      lastCheckedAt: providerConnection?.lastCheckedAt ?? null,
      configured: {
        openai: providerConnection?.provider === 'openai' || Boolean(process.env.OPENAI_API_KEY),
        codex: providerConnection?.provider === 'codex' || Boolean(process.env.CODEX_API_KEY),
        github_copilot:
          providerConnection?.provider === 'github_copilot'
          || Boolean(process.env.COPILOT_GITHUB_TOKEN)
          || Boolean(process.env.GH_TOKEN)
          || Boolean(process.env.GITHUB_TOKEN)
      },
      models: {
        openai: providerConnection?.provider === 'openai' ? providerConnection.model : (process.env.OPENAI_MODEL ?? null),
        codex: providerConnection?.provider === 'codex' ? providerConnection.model : (process.env.CODEX_MODEL ?? null),
        github_copilot:
          providerConnection?.provider === 'github_copilot'
            ? providerConnection.model
            : (process.env.COPILOT_MODEL ?? null)
      },
      apiBaseUrls: {
        openai: process.env.OPENAI_API_BASE_URL ?? null,
        codex: process.env.CODEX_API_BASE_URL ?? null,
        github_copilot: null
      }
    };
  });

  app.get('/api/providers/connections', async () => listAIProviderConnections(repository));

  app.get('/api/github/status', async () => {
    const connection = await readGitHubConnection(repository);
    if (connection) {
      return {
        adapter: 'app',
        configured: true,
        credentialSource: connection.credentialSource,
        apiBaseUrl: connection.apiBaseUrl,
        missing: [],
        persistent: true,
        tokenFingerprint: connection.tokenFingerprint,
        connectedAt: connection.connectedAt,
        lastCheckedAt: connection.lastCheckedAt
      };
    }

    return {
      ...getGitHubAdapterEnvStatus(),
      persistent: false
    };
  });

  app.get('/api/providers/codex/oauth/status', async () => {
    const status = await readCodexOAuthStatus();
    return {
      ...status,
      configured: status.loggedIn
    };
  });

  app.post('/api/providers/codex/oauth/start', async (request, reply) => {
    try {
      const input = codexOAuthStartSchema.parse(request.body ?? {});
      const login = await startCodexOAuthBrowserLogin({ name: input.name });
      return reply.code(202).send({
        loginId: login.loginId,
        authFlow: login.authFlow,
        startedAt: login.startedAt,
        loginUrl: login.loginUrl,
        codexHome: login.codexHome
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/github/repositories', async (request, reply) => {
    try {
      const input = githubRepositoriesQuerySchema.parse(request.query ?? {});
      const connection = await readGitHubConnectionSecret(repository);
      if (!connection) {
        return reply.code(409).send({ error: 'Connect GitHub before listing repositories.' });
      }

      return listGitHubRepositories({
        token: connection.token,
        apiBaseUrl: connection.apiBaseUrl,
        limit: input.limit
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/github/repository-owners', async (request, reply) => {
    try {
      const input = githubRepositoryOwnersQuerySchema.parse(request.query ?? {});
      const connection = await readGitHubConnectionSecret(repository);
      if (!connection) {
        return reply.code(409).send({ error: 'Connect GitHub before listing repository owners.' });
      }

      return listGitHubRepositoryOwners({
        token: connection.token,
        apiBaseUrl: connection.apiBaseUrl,
        limit: input.limit
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/github/branches', async (request, reply) => {
    try {
      const input = githubBranchesQuerySchema.parse(request.query ?? {});
      const connection = await readGitHubConnectionSecret(repository);
      if (!connection) {
        return reply.code(409).send({ error: 'Connect GitHub before listing branches.' });
      }

      return listGitHubBranches({
        token: connection.token,
        apiBaseUrl: connection.apiBaseUrl,
        owner: input.owner,
        repo: input.repo,
        limit: input.limit
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/github/connect', async (request, reply) => {
    try {
      const input = githubConnectSchema.parse(request.body ?? {});
      const token = normalizeGitHubToken(input.token);
      const check = await checkGitHubConnection({
        token,
        apiBaseUrl: input.apiBaseUrl
      });

      const connection = await saveGitHubConnection(repository, {
        token,
        apiBaseUrl: check.apiBaseUrl
      });

      const currentUser = await repository.getCurrentUser();
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'github_adapter_connected',
        payload: {
          credentialSource: 'token',
          apiBaseUrl: check.apiBaseUrl,
          hasToken: true,
          persistent: true,
          tokenFingerprint: connection.tokenFingerprint
        }
      });

      return reply.send({
        ok: true,
        status: {
          adapter: 'app',
          configured: true,
          credentialSource: connection.credentialSource,
          apiBaseUrl: connection.apiBaseUrl,
          missing: [],
          persistent: true,
          tokenFingerprint: connection.tokenFingerprint,
          connectedAt: connection.connectedAt,
          lastCheckedAt: connection.lastCheckedAt
        },
        check
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/github/disconnect', async (_request, reply) => {
    try {
      delete process.env.FORGEMIND_GITHUB_ADAPTER;
      delete process.env.GITHUB_TOKEN;
      await removeGitHubConnection(repository);

      const currentUser = await repository.getCurrentUser();
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'github_adapter_disconnected',
        payload: { adapter: 'none' }
      });

      return reply.send({
        ok: true,
        status: {
          ...getGitHubAdapterEnvStatus(),
          persistent: false
        }
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/providers/codex/oauth/complete', async (request, reply) => {
    try {
      const input = codexOAuthCompleteSchema.parse(request.body ?? {});
      const completed = await completeCodexOAuthBrowserLogin(input.loginId);
      if (!completed.completed) {
        return reply.code(202).send({
          ok: false,
          completed: false,
          loginId: input.loginId,
          authFlow: completed.authFlow,
          startedAt: completed.startedAt,
          loginUrl: completed.loginUrl,
          codexHome: completed.codexHome
        });
      }

      if (!completed.success || !completed.status.loggedIn) {
        throw new Error(completed.errorOutput || completed.status.rawOutput || 'Codex OAuth login did not complete successfully.');
      }

      process.env.FORGEMIND_PROVIDER = 'codex';
      applyProviderConnectionEnv({
        provider: 'codex',
        authMode: 'codex_oauth',
        model: input.model,
        codexHome: completed.status.codexHome
      });

      const provider = createProvider('codex');
      const estimate = await provider.estimateCost({
        prompt: 'Provider connection check prompt.',
        repositorySizeHint: 'small'
      });

      const currentUser = await repository.getCurrentUser();
      const connection = await saveAIProviderConnection(repository, {
        name: input.name,
        isDefault: input.isDefault,
        provider: 'codex',
        authMode: 'codex_oauth',
        model: input.model,
        codexHome: completed.status.codexHome,
        accountSummary: completed.status.accountSummary ?? undefined
      });
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'provider_connected',
        payload: {
          provider: 'codex',
          connectionId: connection.id,
          name: connection.name,
          isDefault: connection.isDefault,
          credentialSource: connection.credentialSource,
          authMode: connection.authMode,
          model: connection.model,
          codexHome: connection.codexHome ?? null,
          accountSummary: connection.accountSummary ?? null,
          persistent: true
        }
      });

      return reply.send({
        ok: true,
        completed: true,
        connectionId: connection.id,
        name: connection.name,
        provider: 'codex',
        model: connection.model,
        persistent: true,
        authMode: connection.authMode,
        estimate
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/providers/connect', async (request, reply) => {
    try {
      const input = providerConnectSchema.parse(request.body ?? {});
      if (input.authMode === 'codex_oauth') {
        const status = await readCodexOAuthStatus();
        if (!status.loggedIn) {
          throw new Error('Codex OAuth is not connected yet. Start and complete the browser OAuth flow first.');
        }
      }

      process.env.FORGEMIND_PROVIDER = input.provider;
      applyProviderConnectionEnv(input);

      const provider = createProvider(input.provider);
      const estimate = await provider.estimateCost({
        prompt: 'Provider connection check prompt.',
        repositorySizeHint: 'small'
      });

      const currentUser = await repository.getCurrentUser();
      const connection = await saveAIProviderConnection(repository, {
        connectionId: input.connectionId,
        name: input.name,
        isDefault: input.isDefault,
        provider: input.provider,
        authMode: input.authMode,
        apiKey: input.apiKey,
        model: input.model,
        codexHome: input.authMode === 'codex_oauth' ? resolveCodexHome() : undefined,
        accountSummary: input.authMode === 'codex_oauth' ? (await readCodexOAuthStatus()).accountSummary ?? undefined : undefined
      });
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'provider_connected',
        payload: {
          provider: input.provider,
          connectionId: connection.id,
          name: connection.name,
          isDefault: connection.isDefault,
          credentialSource: connection.credentialSource,
          authMode: connection.authMode,
          apiKeyFingerprint: connection.apiKeyFingerprint ?? null,
          model: connection.model,
          codexHome: connection.codexHome ?? null,
          accountSummary: connection.accountSummary ?? null,
          persistent: true
        }
      });

      return reply.send({
        ok: true,
        connectionId: connection.id,
        name: connection.name,
        provider: input.provider,
        model: connection.model,
        authMode: connection.authMode,
        persistent: true,
        estimate
      });
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.delete('/api/providers/connections/:id', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const deleted = await deleteAIProviderConnection(repository, id);
      if (!deleted) {
        return sendNotFound(reply, `AI provider connection "${id}" not found`);
      }

      return reply.send({ ok: true, connectionId: id });
    } catch (error) {
      if (error instanceof Error && /foreign key|constraint/i.test(error.message)) {
        return reply.code(409).send({ error: 'Provider connection is still referenced. Unassign it from projects and try again.' });
      }
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/projects', async () => repository.listProjects());

  app.post('/api/projects', async (request, reply) => {
    try {
      const input = projectSchema.parse(request.body);
      const githubRepository = await resolveProjectGitHubRepository(repository, {
        mode: input.repositoryMode,
        owner: input.githubOwner,
        repo: input.githubRepo,
        defaultBranch: input.defaultBranch,
        branchMode: input.branchMode,
        branchName: input.branchName,
        private: input.repositoryPrivate,
        description: input.repositoryDescription
      });

      return reply.code(201).send(
        await repository.createProject({
          name: input.name,
          slug: input.slug,
          githubOwner: githubRepository?.owner,
          githubRepo: githubRepository?.repo,
          defaultBranch: githubRepository?.defaultBranch ?? input.defaultBranch,
          configYaml: input.configYaml,
          brief: input.brief,
          autoCreatePullRequest: input.autoCreatePullRequest,
          autoMergePullRequest: input.autoMergePullRequest,
          autoCompleteTask: input.autoCompleteTask,
          allowSafeOperationsWithoutApproval: input.allowSafeOperationsWithoutApproval,
          defaultTaskMode: input.defaultTaskMode,
          aiProviderConnectionId: input.aiProviderConnectionId
        })
      );
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/projects/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const project = await repository.getProject(id);
    return project ? project : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.patch('/api/projects/:id', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = updateProjectSchema.parse(request.body);
      const project = await repository.updateProject(id, input);
      return project ? project : sendNotFound(reply, `Project "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = deleteProjectSchema.parse(request.body ?? {});
      const project = await repository.getProject(id);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }
      if (input.confirmation !== project.name) {
        throw new Error(`Type the exact project name "${project.name}" to confirm deletion.`);
      }

      await repository.assertProjectDeletable(id);

      let deletedGitHubRepository = false;
      let githubRepository: string | undefined;
      if (input.deleteGitHubRepository) {
        if (!project.githubOwner || !project.githubRepo) {
          throw new Error('This project does not have an assigned GitHub repository.');
        }
        const connection = await readGitHubConnectionSecret(repository);
        if (!connection) {
          throw new Error('Connect GitHub with a persistent token before deleting a repository.');
        }

        await deleteGitHubRepository({
          token: connection.token,
          apiBaseUrl: connection.apiBaseUrl,
          owner: project.githubOwner,
          repo: project.githubRepo
        });
        deletedGitHubRepository = true;
        githubRepository = `${project.githubOwner}/${project.githubRepo}`;
      }

      const result = await repository.deleteProject(id, {
        githubRepositoryDeleted: deletedGitHubRepository
      });
      if (!result) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      return {
        ...result,
        deletedGitHubRepository,
        githubRepository
      };
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/projects/:id/github-repository', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const project = await repository.getProject(id);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      const input = projectGitHubRepositorySchema.parse(request.body ?? {});
      const githubRepository = await resolveProjectGitHubRepository(repository, input);
      if (!githubRepository) {
        throw new Error('GitHub repository owner and name are required.');
      }

      const updated = await repository.updateProject(id, {
        githubOwner: githubRepository.owner,
        githubRepo: githubRepository.repo,
        defaultBranch: githubRepository.defaultBranch
      });

      await repository.writeAudit({
        actorType: 'user',
        actorId: (await repository.getCurrentUser()).id,
        eventType: input.mode === 'create' ? 'project_github_repository_created' : 'project_github_repository_assigned',
        projectId: id,
        payload: {
          repository: githubRepository.fullName,
          defaultBranch: githubRepository.defaultBranch
        }
      });

      return updated ? updated : sendNotFound(reply, `Project "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/projects/:id/config', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const projectConfig = await repository.getProjectConfig(id);
    return projectConfig ? projectConfig : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.put('/api/projects/:id/config', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = projectConfigSchema.parse(request.body);
      const projectConfig = await repository.updateProjectConfig(id, input.configYaml);
      return projectConfig ? projectConfig : sendNotFound(reply, `Project "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/projects/:id/roadmap', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const roadmap = await repository.getProjectRoadmap(id);
    return roadmap ? roadmap : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.post('/api/projects/:id/implementation-steps/start-next', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const project = await repository.getProject(id);
      if (!project) return sendNotFound(reply, `Project "${id}" not found`);

      const roadmap = await repository.getProjectRoadmap(id);
      if (!roadmap) return sendNotFound(reply, `Project "${id}" does not have a roadmap`);

      const latestCycle = [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
      if (!latestCycle || latestCycle.status !== 'active') {
        return reply.code(409).send({ error: 'The latest roadmap cycle is not active.' });
      }

      const cycleSteps = roadmap.steps.filter((step) => step.cycleId === latestCycle.id);
      const runningStep = cycleSteps.find((step) => step.status === 'running');
      if (runningStep) {
        return reply.code(409).send({ error: `Implementation step "${runningStep.title}" is already running.` });
      }

      const nextStep = cycleSteps.find((step) => step.status === 'pending');
      if (!nextStep) {
        return reply.code(409).send({ error: 'The latest roadmap cycle has no pending implementation step.' });
      }

      return reply.code(201).send(
        await createAndStartRoadmapTask(repository, dispatcher, project, nextStep, latestCycle.objective)
      );
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/projects/:id/implementation-steps/generate', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = roadmapGenerateSchema.parse(request.body ?? {});
      const project = await repository.getProject(id);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      const objective = input.objective?.trim() || project.brief?.trim();
      if (!objective) {
        return reply.code(400).send({ error: 'Project brief is required before generating implementation steps.' });
      }

      const plan = await generateRoadmapPlan(repository, project, objective);
      const stepBlueprints = toImplementationStepBlueprints(plan);
      if (stepBlueprints.length === 0) {
        throw new Error('AI provider did not return any implementation steps.');
      }

      const roadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id,
        objective,
        steps: stepBlueprints
      });

      const firstStep = findFirstPendingStepForLatestCycle(roadmap);
      if (firstStep) {
        await createAndStartRoadmapTask(repository, dispatcher, project, firstStep, objective);
      }

      return reply.code(201).send((await repository.getProjectRoadmap(project.id))!);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/projects/:id/extension/decision', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = roadmapExtensionApprovalSchema.parse(request.body ?? {});
      const project = await repository.getProject(id);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      const roadmap = await repository.getProjectRoadmap(id);
      if (!roadmap) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      const cycle = [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
      if (!cycle) {
        return reply.code(400).send({ error: 'No roadmap cycle exists for this project.' });
      }

      if (!input.approved) {
        await repository.updateProjectRoadmapCycleStatus(cycle.id, 'completed');
        return (await repository.getProjectRoadmap(id))!;
      }

      const objective = input.objectiveOverride?.trim() || cycle.extensionProposal?.trim();
      if (!objective) {
        return reply.code(400).send({ error: 'There is no approved extension proposal to expand into implementation steps.' });
      }

      const plan = await generateRoadmapPlan(repository, project, objective);
      const stepBlueprints = toImplementationStepBlueprints(plan);
      if (stepBlueprints.length === 0) {
        throw new Error('AI provider did not return any implementation steps.');
      }

      const nextRoadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id,
        objective,
        steps: stepBlueprints
      });

      const firstStep = findFirstPendingStepForLatestCycle(nextRoadmap);
      if (firstStep) {
        await createAndStartRoadmapTask(repository, dispatcher, project, firstStep, objective);
      }

      return (await repository.getProjectRoadmap(id))!;
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks', async () => repository.listTasks());

  app.post('/api/tasks', async (request, reply) => {
    try {
      const input = createTaskSchema.parse(request.body);
      const project = await repository.getProject(input.projectId);
      if (!project) {
        return sendNotFound(reply, `Project "${input.projectId}" not found`);
      }
      return reply.code(201).send(
        await repository.createTask({
          projectId: input.projectId,
          title: input.title,
          prompt: buildTaskPrompt(input),
          mode: resolveTaskMode(input.mode, project.defaultTaskMode),
          maxIterations: input.maxIterations,
          maxBudgetUsd: input.maxBudgetUsd
        })
      );
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
      if (task) {
        await dispatcher.enqueueTask(task.id, 'task_started');
      }
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
      if (task && input.start) {
        await dispatcher.enqueueTask(task.id, 'task_retried');
      }
      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/tasks/:id/complete', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const task = await repository.transitionTask(id, 'completed', { source: 'user' });
      const roadmapAdvance = await advanceRoadmapAfterTaskCompletion(repository, id);
      if (roadmapAdvance.completedCycle && roadmapAdvance.project) {
        const extensionProposal = await generateExtensionProposal(
          repository,
          roadmapAdvance.project,
          roadmapAdvance.completedCycle.objective
        );
        await repository.setProjectRoadmapCycleExtensionProposal(roadmapAdvance.completedCycle.id, {
          proposal: extensionProposal,
          status: 'awaiting_extension_approval'
        });
      }

      return task ? task : sendNotFound(reply, `Task "${id}" not found`);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks/:id/queue', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    return dispatcher.getQueueInfo(id);
  });

  app.get('/api/tasks/:id/logs', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    return repository.listTaskAudit(id);
  });

  app.get('/api/tasks/:id/runs', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    return repository.getTaskUsage(id);
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
      if (!approval) {
        return sendNotFound(reply, `Approval "${id}" not found`);
      }

      // Resume paused task only after the last pending approval is resolved.
      const pendingTaskApprovals = (await repository.listApprovals()).filter(
        (item) => item.taskId === approval.taskId && item.status === 'pending'
      );
      if (pendingTaskApprovals.length === 0) {
        const task = await repository.getTask(approval.taskId);
        if (task?.status === 'needs_approval') {
          const resumed = await repository.retryTask(approval.taskId, true);
          if (resumed) {
            await dispatcher.enqueueTask(resumed.id, 'task_retried');
          }
        }
      }

      return approval;
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

    if (delivery && processedWebhookDeliveries.has(delivery)) {
      return reply.code(202).send({ ok: true, event, delivery, duplicate: true });
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = parseGitHubWebhookPayload(rawPayload);
    } catch {
      return reply.code(400).send({ error: 'Webhook payload is not valid JSON.' });
    }

    const projection = projectGitHubWebhookEvent(event, parsedPayload, delivery);
    const audit = await repository.writeAudit({
      actorType: 'github',
      eventType: projection.eventType,
      payload: projection.payload
    });

    if (delivery) {
      processedWebhookDeliveries.add(delivery);
    }

    return reply.code(202).send({ ok: true, event, delivery, duplicate: false, auditId: audit.id });
  });

  app.post('/api/notifications/subscribe', async (request, reply) => {
    try {
      if (!notifications) {
        return reply.code(503).send({ error: 'Notifications service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const input = notificationSubscriptionSchema.parse(request.body);
      const subscription = await notifications.subscribe(currentUser.id, input);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'notifications_subscribed',
        payload: { endpoint: input.endpoint, deviceName: input.deviceName ?? null }
      });
      return reply.code(201).send(subscription);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/notifications/unsubscribe', async (request, reply) => {
    try {
      if (!notifications) {
        return reply.code(503).send({ error: 'Notifications service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const input = z.object({ endpoint: z.string().url() }).parse(request.body);
      const result = await notifications.unsubscribe(currentUser.id, input.endpoint);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'notifications_unsubscribed',
        payload: { endpoint: input.endpoint, removed: result.removed }
      });
      return reply.send(result);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/notifications/vapid-public-key', async (_request, reply) => {
    const publicKey = resolveRuntimeEnvVar('VAPID_PUBLIC_KEY');
    if (!publicKey) {
      return reply.code(503).send({ error: 'VAPID_PUBLIC_KEY is not configured.' });
    }

    return reply.send({ publicKey });
  });

  app.get('/api/notifications/settings', async (request, reply) => {
    if (!notifications) {
      return reply.code(503).send({ error: 'Notifications service is not configured.' });
    }

    const currentUser = await repository.getCurrentUser();
    return notifications.getSettings(currentUser.id);
  });

  app.put('/api/notifications/settings', async (request, reply) => {
    try {
      if (!notifications) {
        return reply.code(503).send({ error: 'Notifications service is not configured.' });
      }

      const currentUser = await repository.getCurrentUser();
      const input = notificationSettingsSchema.parse(request.body);
      const settings = await notifications.updateSettings(currentUser.id, input);
      await repository.writeAudit({
        actorType: 'user',
        actorId: currentUser.id,
        eventType: 'notification_settings_updated',
        payload: input
      });
      return reply.send(settings);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });
}

function formatMetrics(snapshot: Awaited<ReturnType<ForgeMindRepository['getOperationalMetrics']>>): string {
  return [
    '# HELP forgemind_tasks_total Total number of tasks.',
    '# TYPE forgemind_tasks_total gauge',
    `forgemind_tasks_total ${snapshot.tasks.total}`,
    `forgemind_tasks_draft ${snapshot.tasks.draft}`,
    `forgemind_tasks_submitted ${snapshot.tasks.submitted}`,
    `forgemind_tasks_active ${snapshot.tasks.active}`,
    `forgemind_tasks_needs_approval ${snapshot.tasks.needsApproval}`,
    `forgemind_tasks_completed ${snapshot.tasks.completed}`,
    `forgemind_tasks_failed ${snapshot.tasks.failed}`,
    `forgemind_tasks_cancelled ${snapshot.tasks.cancelled}`,
    `forgemind_tasks_provider_failed_total ${snapshot.tasks.providerFailed}`,
    `forgemind_tasks_budget_exceeded_total ${snapshot.tasks.budgetExceeded}`,
    `forgemind_tasks_iteration_limit_reached_total ${snapshot.tasks.iterationLimitReached}`,
    `forgemind_tasks_repeated_error_detected_total ${snapshot.tasks.repeatedErrorDetected}`,
    `forgemind_tasks_validation_failed_total ${snapshot.tasks.validationFailed}`,
    '',
    '# HELP forgemind_queue_jobs Queue job gauges and wait metrics.',
    '# TYPE forgemind_queue_jobs gauge',
    `forgemind_queue_jobs_pending ${snapshot.queue.pending}`,
    `forgemind_queue_jobs_claimed ${snapshot.queue.claimed}`,
    `forgemind_queue_jobs_failed ${snapshot.queue.failed}`,
    `forgemind_queue_wait_seconds_avg ${snapshot.queue.averagePendingWaitSeconds.toFixed(3)}`,
    `forgemind_queue_wait_seconds_max ${snapshot.queue.maxPendingWaitSeconds.toFixed(3)}`,
    '',
    '# HELP forgemind_approvals Approval state counters.',
    '# TYPE forgemind_approvals gauge',
    `forgemind_approvals_pending ${snapshot.approvals.pending}`,
    `forgemind_approvals_approved ${snapshot.approvals.approved}`,
    `forgemind_approvals_rejected ${snapshot.approvals.rejected}`,
    `forgemind_approvals_cancelled ${snapshot.approvals.cancelled}`,
    '',
    '# HELP forgemind_runs Task run gauges and duration metrics.',
    '# TYPE forgemind_runs gauge',
    `forgemind_runs_queued ${snapshot.runs.queued}`,
    `forgemind_runs_running ${snapshot.runs.running}`,
    `forgemind_runs_succeeded ${snapshot.runs.succeeded}`,
    `forgemind_runs_failed ${snapshot.runs.failed}`,
    `forgemind_runs_cancelled ${snapshot.runs.cancelled}`,
    `forgemind_run_duration_seconds_avg ${snapshot.runs.averageDurationSeconds.toFixed(3)}`,
    `forgemind_run_duration_seconds_max ${snapshot.runs.maxDurationSeconds.toFixed(3)}`,
    '',
    '# HELP forgemind_metrics_generated_at_unix Unix timestamp when metrics were generated.',
    '# TYPE forgemind_metrics_generated_at_unix gauge',
    `forgemind_metrics_generated_at_unix ${Math.floor(new Date(snapshot.generatedAt).getTime() / 1000)}`
  ].join('\n');
}

function buildTaskPrompt(input: z.infer<typeof createTaskSchema>): string {
  const lines = [input.prompt.trim()];

  lines.push('', `Priority: ${input.priority}`);

  if (input.runtimeSummary?.trim()) {
    lines.push('', 'Runtime Summary:', input.runtimeSummary.trim());
  }

  if (input.scopeFiles.length > 0) {
    lines.push('', 'Scope Files:');
    for (const file of input.scopeFiles) {
      lines.push(`- ${file}`);
    }
  }

  if (input.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance Criteria:');
    for (const criterion of input.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }

  return lines.join('\n');
}

async function generateRoadmapPlan(
  repository: ForgeMindRepository,
  project: { id: string; name: string; brief?: string; aiProviderConnectionId?: string },
  objective: string
) {
  const connection = project.aiProviderConnectionId
    ? await readAIProviderConnectionSecretById(repository, project.aiProviderConnectionId)
    : await readAIProviderConnectionSecret(repository);
  if (!connection) {
    throw new Error('Connect an AI provider before generating implementation steps.');
  }

  applyProviderConnectionEnv({
    provider: connection.provider,
    authMode: connection.authMode,
    apiKey: connection.apiKey,
    model: connection.model,
    codexHome: connection.codexHome
  });

  const provider = createProvider(connection.provider);
  const existingRoadmap = await repository.getProjectRoadmap(project.id);
  const completedSteps = existingRoadmap?.steps.filter((step) => step.status === 'completed').map((step) => step.title) ?? [];
  return provider.plan({
    taskId: project.id,
    title: `Project roadmap for ${project.name}`,
    prompt: [
      `Generate an ordered implementation roadmap for the following project objective.`,
      '',
      `Project: ${project.name}`,
      `Objective: ${objective}`,
      project.brief?.trim() && project.brief.trim() !== objective.trim()
        ? `Existing brief context: ${project.brief.trim()}`
        : undefined,
      completedSteps.length > 0 ? `Already completed implementation steps:\n${completedSteps.map((step) => `- ${step}`).join('\n')}` : undefined,
      '',
      'Return concrete implementation steps that can be executed one by one as individual engineering tasks in implementationSteps.',
      'Each implementationSteps item must contain title, a distinct implementation-focused description, acceptanceCriteria, inScope, and outOfScope.',
      'Give every step only its own verifiable acceptance criteria. Do not copy project-wide acceptance criteria to every step.',
      'Steps must not overlap. Do not include work assigned to a later step, and do not recreate already completed capabilities.',
      'A documentation or scope-definition step must change documentation only and must not implement application code.',
      'Order dependencies explicitly so each task starts from the repository state produced by earlier tasks.'
    ]
      .filter(Boolean)
      .join('\n')
  });
}

export function toImplementationStepBlueprints(plan: PlanResult): Array<{ title: string; description: string; acceptanceCriteria: string[] }> {
  if (!Array.isArray(plan.implementationSteps) || plan.implementationSteps.length === 0) {
    throw new Error('AI provider did not return structured implementationSteps for the project roadmap.');
  }

  return plan.implementationSteps.map((step, index) => {
    const title = step.title.trim();
    const description = step.description.trim();
    const acceptanceCriteria = step.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean);
    const inScope = step.inScope.map((item) => item.trim()).filter(Boolean);
    const outOfScope = step.outOfScope.map((item) => item.trim()).filter(Boolean);

    if (!title || !description || acceptanceCriteria.length === 0 || inScope.length === 0) {
      throw new Error(`AI provider returned an incomplete implementation step at position ${index + 1}.`);
    }

    return {
      title,
      description: [
        description,
        '',
        'In scope:',
        ...inScope.map((item) => `- ${item}`),
        ...(outOfScope.length > 0 ? ['', 'Out of scope:', ...outOfScope.map((item) => `- ${item}`)] : [])
      ].join('\n'),
      acceptanceCriteria
    };
  });
}

export function findFirstPendingStepForLatestCycle<T extends {
  cycleId: string;
  sequenceNumber: number;
  status: string;
}>(roadmap: {
  cycles: Array<{ id: string; cycleNumber: number }>;
  steps: T[];
}): T | undefined {
  const latestCycle = [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
  if (!latestCycle) return undefined;

  return roadmap.steps
    .filter((step) => step.cycleId === latestCycle.id && step.status === 'pending')
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber)[0];
}

async function createAndStartRoadmapTask(
  repository: ForgeMindRepository,
  dispatcher: ReturnType<typeof createTaskDispatchService>,
  project: { id: string; name: string; defaultTaskMode?: TaskMode },
  step: {
    id: string;
    cycleId: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
  },
  objective: string
) {
  const roadmap = await repository.getProjectRoadmap(project.id);
  const cycleSteps = roadmap?.steps
    .filter((candidate) => candidate.cycleId === step.cycleId)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber) ?? [];
  const currentIndex = cycleSteps.findIndex((candidate) => candidate.id === step.id);
  const completedSteps = cycleSteps.slice(0, Math.max(0, currentIndex)).filter((candidate) => candidate.status === 'completed').map((candidate) => candidate.title);
  const futureSteps = currentIndex >= 0 ? cycleSteps.slice(currentIndex + 1).map((candidate) => candidate.title) : [];
  const task = await repository.createTask({
    projectId: project.id,
    title: `${project.name}: ${step.title}`,
    prompt: buildRoadmapStepTaskPrompt({
      projectName: project.name,
      objective,
      stepTitle: step.title,
      stepDescription: step.description,
      acceptanceCriteria: step.acceptanceCriteria,
      completedSteps,
      futureSteps
    }),
    mode: resolveTaskMode(undefined, project.defaultTaskMode),
    maxIterations: 10,
    maxBudgetUsd: 5
  });

  await repository.assignTaskToImplementationStep(step.id, task.id, 'running');
  const startedTask = await repository.startTask(task.id);
  if (startedTask) {
    await dispatcher.enqueueTask(startedTask.id, 'roadmap_step_started');
  }

  return startedTask ?? task;
}

export function resolveTaskMode(taskMode: TaskMode | undefined, projectDefaultMode: TaskMode | undefined): TaskMode {
  return taskMode ?? projectDefaultMode ?? 'safe';
}

export { buildRoadmapStepTaskPrompt };

async function generateExtensionProposal(
  repository: ForgeMindRepository,
  project: { id: string; name: string; brief?: string },
  completedObjective: string
): Promise<string> {
  const plan = await generateRoadmapPlan(
    repository,
    project,
    [
      `The previous roadmap objective has been completed: ${completedObjective}`,
      'Propose the single next most valuable extension for this project.',
      'Focus on a concrete follow-up objective, not on implementation steps.'
    ].join('\n')
  );

  return plan.summary.trim() || plan.steps[0]?.trim() || 'Navrhnout další rozšíření projektu.';
}

async function resolveProjectGitHubRepository(
  repository: ForgeMindRepository,
  input: {
    mode: 'existing' | 'create';
    owner?: string;
    repo?: string;
    defaultBranch?: string;
    branchMode?: 'existing' | 'create';
    branchName?: string;
    private?: boolean;
    description?: string;
  }
): Promise<{ owner: string; repo: string; fullName: string; defaultBranch: string; private?: boolean } | undefined> {
  const normalized = normalizeGitHubRepositoryInput(input.owner, input.repo);
  if (!normalized) {
    return undefined;
  }

  const connection = await readGitHubConnectionSecret(repository);
  if (input.mode === 'create') {
    if (!connection) {
      throw new Error('Connect GitHub with a persistent token before creating a repository.');
    }

    const created = await createGitHubRepository({
      token: connection.token,
      apiBaseUrl: connection.apiBaseUrl,
      owner: normalized.owner,
      repo: normalized.repo,
      private: input.private,
      description: input.description
    });

    const defaultBranch = await resolveProjectGitHubBranch(repository, {
      owner: created.owner,
      repo: created.repo,
      repositoryDefaultBranch: created.defaultBranch,
      mode: input.branchMode === 'create' ? 'create' : 'existing',
      selectedBranch: input.branchMode === 'create' ? input.branchName : input.defaultBranch
    });

    return {
      owner: created.owner,
      repo: created.repo,
      fullName: created.fullName,
      defaultBranch,
      private: created.private
    };
  }

  if (connection) {
    const check = await checkGitHubConnection({
      token: connection.token,
      apiBaseUrl: connection.apiBaseUrl,
      owner: normalized.owner,
      repo: normalized.repo
    });

    if (check.repository) {
      const defaultBranch = await resolveProjectGitHubBranch(repository, {
        owner: check.repository.owner,
        repo: check.repository.repo,
        repositoryDefaultBranch: check.repository.defaultBranch,
        mode: input.branchMode ?? 'existing',
        selectedBranch: input.branchMode === 'create' ? input.branchName : input.defaultBranch
      });

      return {
        owner: check.repository.owner,
        repo: check.repository.repo,
        fullName: check.repository.fullName,
        defaultBranch,
        private: check.repository.private
      };
    }
  }

  if (input.branchMode === 'create') {
    throw new Error('Connect GitHub with a persistent token before creating a branch.');
  }

  return {
    owner: normalized.owner,
    repo: normalized.repo,
    fullName: `${normalized.owner}/${normalized.repo}`,
    defaultBranch: input.defaultBranch ?? 'main'
  };
}

async function resolveProjectGitHubBranch(
  repository: ForgeMindRepository,
  input: {
    owner: string;
    repo: string;
    repositoryDefaultBranch: string;
    mode: 'existing' | 'create';
    selectedBranch?: string;
  }
): Promise<string> {
  const branchName = input.selectedBranch?.trim();
  if (input.mode === 'existing') {
    return branchName || input.repositoryDefaultBranch;
  }

  if (!branchName) {
    throw new Error('GitHub branch name is required when creating a branch.');
  }

  if (branchName === input.repositoryDefaultBranch) {
    return branchName;
  }

  const connection = await readGitHubConnectionSecret(repository);
  if (!connection) {
    throw new Error('Connect GitHub with a persistent token before creating a branch.');
  }

  const created = await createGitHubBranch({
    token: connection.token,
    apiBaseUrl: connection.apiBaseUrl,
    owner: input.owner,
    repo: input.repo,
    branchName,
    fromBranch: input.repositoryDefaultBranch
  });

  return created.name;
}

async function readGitHubConnection(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    getGitHubConnection?: ForgeMindRepository['getGitHubConnection'];
  };
  return maybeRepository.getGitHubConnection ? maybeRepository.getGitHubConnection() : undefined;
}

async function readAIProviderConnection(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    getAIProviderConnection?: ForgeMindRepository['getAIProviderConnection'];
  };
  return maybeRepository.getAIProviderConnection ? maybeRepository.getAIProviderConnection() : undefined;
}

async function listAIProviderConnections(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    listAIProviderConnections?: ForgeMindRepository['listAIProviderConnections'];
  };
  if (maybeRepository.listAIProviderConnections) {
    return maybeRepository.listAIProviderConnections();
  }

  const connection = await readAIProviderConnection(repository);
  return connection ? [connection] : [];
}

async function readAIProviderConnectionSecret(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    getAIProviderConnectionSecret?: ForgeMindRepository['getAIProviderConnectionSecret'];
  };
  return maybeRepository.getAIProviderConnectionSecret ? maybeRepository.getAIProviderConnectionSecret() : undefined;
}

async function readAIProviderConnectionSecretById(repository: ForgeMindRepository, connectionId: string) {
  const maybeRepository = repository as ForgeMindRepository & {
    getAIProviderConnectionSecretById?: ForgeMindRepository['getAIProviderConnectionSecretById'];
  };
  return maybeRepository.getAIProviderConnectionSecretById
    ? maybeRepository.getAIProviderConnectionSecretById(connectionId)
    : readAIProviderConnectionSecret(repository);
}

async function readGitHubConnectionSecret(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    getGitHubConnectionSecret?: ForgeMindRepository['getGitHubConnectionSecret'];
  };
  return maybeRepository.getGitHubConnectionSecret ? maybeRepository.getGitHubConnectionSecret() : undefined;
}

async function saveGitHubConnection(
  repository: ForgeMindRepository,
  input: { token: string; apiBaseUrl: string }
) {
  const maybeRepository = repository as ForgeMindRepository & {
    upsertGitHubConnection?: ForgeMindRepository['upsertGitHubConnection'];
  };
  if (!maybeRepository.upsertGitHubConnection) {
    throw new Error('Persistent GitHub connection storage is not available.');
  }

  return maybeRepository.upsertGitHubConnection(input);
}

async function saveAIProviderConnection(
  repository: ForgeMindRepository,
  input: {
    connectionId?: string;
    name?: string;
    isDefault?: boolean;
    provider: AIProviderConnectionKind;
    authMode?: 'api_key' | 'codex_oauth';
    apiKey?: string;
    model: string;
    codexHome?: string;
    accountSummary?: string;
  }
) {
  const maybeRepository = repository as ForgeMindRepository & {
    upsertAIProviderConnection?: ForgeMindRepository['upsertAIProviderConnection'];
  };
  if (!maybeRepository.upsertAIProviderConnection) {
    throw new Error('Persistent AI provider connection storage is not available.');
  }

  return maybeRepository.upsertAIProviderConnection(input);
}

async function deleteAIProviderConnection(repository: ForgeMindRepository, connectionId: string) {
  const maybeRepository = repository as ForgeMindRepository & {
    deleteAIProviderConnection?: ForgeMindRepository['deleteAIProviderConnection'];
  };
  if (!maybeRepository.deleteAIProviderConnection) {
    throw new Error('Persistent AI provider connection storage is not available.');
  }

  return maybeRepository.deleteAIProviderConnection(connectionId);
}

async function removeGitHubConnection(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    deleteGitHubConnection?: ForgeMindRepository['deleteGitHubConnection'];
  };
  if (!maybeRepository.deleteGitHubConnection) {
    return false;
  }

  return maybeRepository.deleteGitHubConnection();
}

function applyProviderConnectionEnv(input: {
  provider: AIProviderConnectionKind;
  authMode?: 'api_key' | 'codex_oauth';
  apiKey?: string;
  model: string;
  codexHome?: string;
}) {
  if (input.authMode === 'codex_oauth') {
    process.env.CODEX_AUTH_MODE = 'oauth';
    process.env.CODEX_HOME = input.codexHome ?? resolveCodexHome();
    process.env.CODEX_MODEL = input.model;
    return;
  }

  if (input.provider === 'openai') {
    if (input.apiKey) {
      process.env.OPENAI_API_KEY = input.apiKey;
    }
    process.env.OPENAI_MODEL = input.model;
  }

  if (input.provider === 'codex') {
    if (input.apiKey) {
      process.env.CODEX_API_KEY = input.apiKey;
    }
    delete process.env.CODEX_AUTH_MODE;
    process.env.CODEX_MODEL = input.model;
  }

  if (input.provider === 'github_copilot') {
    if (input.apiKey) {
      process.env.COPILOT_GITHUB_TOKEN = input.apiKey;
    }
    process.env.COPILOT_MODEL = input.model;
  }
}

function resolveProviderEnvModel(provider: string): string | null {
  if (provider === 'openai') {
    return process.env.OPENAI_MODEL ?? null;
  }

  if (provider === 'codex') {
    return process.env.CODEX_MODEL ?? null;
  }

  if (provider === 'github_copilot') {
    return process.env.COPILOT_MODEL ?? 'gpt-5.4';
  }

  return null;
}
