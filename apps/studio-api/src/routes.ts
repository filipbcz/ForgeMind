import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildProjectExtensionProposalPrompt, CodexExecutionTimeoutError, createProvider, formatProjectExtensionProposal, GitHubCopilotProvider, listCodexModels, listOpenAIModels } from '@forgemind/providers';
import type { AIProvider, PlanResult, ProviderSessionContext } from '@forgemind/providers';
import {
  checkGitHubConnection,
  createGitHubBranch,
  createGitHubRepository,
  deleteGitHubRepository,
  GitHubAppAdapter,
  getGitHubAdapterEnvStatus,
  listGitHubBranches,
  listGitHubRepositoryOwners,
  listGitHubRepositories,
  normalizeGitHubRepositoryInput,
  normalizeGitHubToken
} from '@forgemind/github';
import type { AuthService } from './auth.js';
import { completeCodexOAuthBrowserLogin, readCodexOAuthBrowserLoginStatus, readCodexOAuthStatus, resolveCodexHome, startCodexOAuthBrowserLogin } from './codex-oauth.js';
import { createTaskDispatchService } from './dispatch.js';
import { sendBadRequest, sendNotFound } from './http.js';
import { advanceRoadmapAfterTaskCapabilityWait, advanceRoadmapAfterTaskCompletion, buildRoadmapStepTaskPrompt, composeApprovedExtensionSpecification, startNextRoadmapStep } from '@forgemind/db';
import type { AIProviderConnectionKind, AIProviderConnectionSecret, ForgeMindRepository } from '@forgemind/db';
import { parseGitHubWebhookPayload, projectGitHubWebhookEvent, verifyGitHubWebhookSignature } from './webhook.js';
import type { NotificationService } from './notifications.js';
import { activeProjectContractRequirements, applyProjectContractDelta } from '@forgemind/core';
import type { Project, ProjectArchitectureUpdate, ProjectContract, ProjectContractDelta, TaskMode } from '@forgemind/core';
import { resolveRuntimeEnvVar } from './runtime-env.js';

const validationProfileSchema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  dockerComposeFiles: z.array(z.string().trim().min(1)).max(8).default([]),
  dockerComposeServices: z.array(z.string().trim().min(1)).max(32).default([]),
  requiredEnvironmentVariables: z.array(z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/)).max(32).default([]),
  migrationCommands: z.array(z.string().trim().min(1)).max(16).default([]),
  readinessCommands: z.array(z.string().trim().min(1)).max(16).default([]),
  commandTimeoutMinutes: z.number().int().min(1).max(60).default(10)
});

const projectSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  githubOwner: z.string().min(1).optional(),
  githubRepo: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).default('main'),
  configYaml: z.string().optional(),
  brief: z.string().min(20).optional(),
  validationProfile: validationProfileSchema.optional(),
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
  validationProfile: validationProfileSchema.nullable().optional(),
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

const projectContractPlanSchema = z.object({
  version: z.number().int().positive(),
  summary: z.string().trim().min(1),
  invariants: z.array(z.string().trim().min(1)).min(1),
  prohibitedSubstitutes: z.array(z.string().trim().min(1)),
  requirements: z.array(z.object({
    id: z.string().trim().regex(/^REQ-[A-Z0-9-]+$/),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    briefReferences: z.array(z.string().trim().min(1)).default([])
  })).min(1),
  releaseCriteria: z.array(z.string().trim().min(1)).min(1)
});

const projectContractRequirementDraftSchema = z.object({
  id: z.string().trim().regex(/^REQ-[A-Z0-9-]+$/),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  briefReferences: z.array(z.string().trim().min(1)).default([])
});

const projectContractCollectionDeltaSchema = z.object({
  add: z.array(z.string().trim().min(1)),
  remove: z.array(z.object({
    value: z.string().trim().min(1),
    rationale: z.string().trim().min(1)
  }))
});

const projectContractDeltaPlanSchema = z.object({
  baseVersion: z.number().int().positive(),
  summary: z.string().trim().min(1).nullable().optional(),
  addRequirements: z.array(projectContractRequirementDraftSchema),
  updateRequirements: z.array(z.object({
    id: z.string().trim().regex(/^REQ-[A-Z0-9-]+$/),
    title: z.string().trim().min(1).nullable().optional(),
    description: z.string().trim().min(1).nullable().optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).nullable().optional(),
    briefReferences: z.array(z.string().trim().min(1)).nullable().optional(),
    rationale: z.string().trim().min(1)
  })),
  supersedeRequirements: z.array(z.object({
    id: z.string().trim().regex(/^REQ-[A-Z0-9-]+$/),
    replacement: projectContractRequirementDraftSchema,
    rationale: z.string().trim().min(1)
  })),
  removeRequirements: z.array(z.object({
    id: z.string().trim().regex(/^REQ-[A-Z0-9-]+$/),
    rationale: z.string().trim().min(1)
  })),
  invariantChanges: projectContractCollectionDeltaSchema,
  prohibitedSubstituteChanges: projectContractCollectionDeltaSchema,
  releaseCriteriaChanges: projectContractCollectionDeltaSchema,
  migrationImpacts: z.array(z.string().trim().min(1)),
  compatibilityImpacts: z.array(z.string().trim().min(1))
});

const architectureUpdatePlanSchema = z.object({
  summary: z.string().trim().min(1).nullable().optional(),
  modules: z.array(z.object({
    name: z.string().trim().min(1),
    responsibility: z.string().trim().min(1),
    paths: z.array(z.string().trim().min(1)),
    publicInterfaces: z.array(z.string().trim().min(1)),
    dependencies: z.array(z.string().trim().min(1))
  })),
  databaseSchemas: z.array(z.object({
    name: z.string().trim().min(1),
    technology: z.string().trim().min(1),
    paths: z.array(z.string().trim().min(1)),
    ownedByModule: z.string().trim().min(1),
    migrationPaths: z.array(z.string().trim().min(1))
  })).default([]),
  decisions: z.array(z.object({
    summary: z.string().trim().min(1),
    rationale: z.string().trim().min(1)
  })),
  conventions: z.array(z.string().trim().min(1)),
  dependencyRules: z.array(z.string().trim().min(1)),
  knownDebt: z.array(z.string().trim().min(1)),
  resolvedDebt: z.array(z.string().trim().min(1)),
  validationCommands: z.array(z.string().trim().min(1))
});

const roadmapExtensionApprovalSchema = z.object({
  approved: z.boolean(),
  cycleId: z.string().min(1).optional(),
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
    if (input.authMode === 'api_key' && input.provider !== 'github_copilot' && !input.apiKey && !input.connectionId) {
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
  connectionId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  isDefault: z.boolean().optional(),
  model: z.string().min(1)
});

const codexOAuthStartSchema = z.object({
  loginId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80).optional()
});

const codexOAuthStatusParamsSchema = z.object({
  loginId: z.string().uuid()
});

const providerModelsSchema = z.object({
  provider: z.enum(['openai', 'codex', 'github_copilot']),
  apiKey: z.string().min(1).optional(),
  connectionId: z.string().uuid().optional(),
  loginId: z.string().uuid().optional()
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
    const connections = await Promise.all(providerConnections.map(async (connection) => {
      if (connection.provider !== 'codex' || connection.authMode !== 'codex_oauth') {
        return { ...connection, available: true };
      }
      if (!connection.codexHome) {
        return { ...connection, available: false };
      }

      const status = await readCodexOAuthStatus(connection.codexHome);
      return {
        ...connection,
        available: status.loggedIn,
        accountSummary: status.accountSummary ?? connection.accountSummary
      };
    }));
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
      connections,
      fallbackProvider: process.env.FORGEMIND_FALLBACK_PROVIDER ?? null,
      githubAdapter: githubConnection ? 'app' : getGitHubAdapterEnvStatus().adapter,
      availableProviders: ['openai', 'codex'],
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
        codex:
          providerConnection?.provider === 'codex'
            ? providerConnection.authMode !== 'codex_oauth' || connections.some((connection) => connection.id === providerConnection.id && connection.available)
            : Boolean(process.env.CODEX_API_KEY),
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

  app.post('/api/providers/models', async (request, reply) => {
    try {
      const input = providerModelsSchema.parse(request.body ?? {});
      const connection = input.connectionId
        ? await readAIProviderConnectionSecretById(repository, input.connectionId)
        : undefined;
      if (input.connectionId && !connection) {
        throw new Error('AI provider connection was not found.');
      }
      if (connection && connection.provider !== input.provider) {
        throw new Error('The selected connection belongs to a different AI provider.');
      }

      if (input.provider === 'openai') {
        const apiKey = input.apiKey ?? connection?.apiKey;
        if (!apiKey) {
          throw new Error('Enter an OpenAI API key before loading models.');
        }
        return { provider: input.provider, connectionId: input.connectionId, models: await listOpenAIModels(apiKey) };
      }

      if (input.provider === 'github_copilot') {
        if (!connection) {
          throw new Error('GitHub Copilot provider is frozen. Only existing connections remain available.');
        }
        const provider = new GitHubCopilotProvider({ apiKey: input.apiKey ?? connection?.apiKey });
        return { provider: input.provider, connectionId: input.connectionId, models: await provider.listModels() };
      }

      if (input.loginId) {
        const login = await readCodexOAuthBrowserLoginStatus(input.loginId);
        if (!login.success || !login.status.loggedIn) {
          throw new Error('Finish the Codex OAuth login before loading models.');
        }
        return { provider: input.provider, loginId: input.loginId, models: await listCodexModels({ codexHome: login.codexHome }) };
      }

      if (connection?.authMode === 'codex_oauth' && connection.codexHome) {
        const status = await readCodexOAuthStatus(connection.codexHome);
        if (!status.loggedIn) {
          throw new Error('This Codex OAuth connection has expired. Sign in again.');
        }
        return { provider: input.provider, connectionId: input.connectionId, models: await listCodexModels({ codexHome: connection.codexHome }) };
      }

      const apiKey = input.apiKey ?? connection?.apiKey;
      if (!apiKey) {
        throw new Error('Enter a Codex API key or select a connected Codex OAuth account before loading models.');
      }
      return {
        provider: input.provider,
        connectionId: input.connectionId,
        models: await listOpenAIModels(apiKey, process.env.CODEX_API_BASE_URL ?? 'https://api.openai.com/v1/responses')
      };
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

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

  app.get('/api/providers/codex/oauth/authorize', async (request, reply) => {
    try {
      const input = codexOAuthStartSchema.parse(request.query ?? {});
      if (!input.loginId) {
        throw new Error('OAuth login ID is required.');
      }
      const login = await startCodexOAuthBrowserLogin(input);
      if (!login.loginUrl) {
        throw new Error('Codex did not provide an OAuth authorization URL.');
      }
      return reply.redirect(login.loginUrl);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/providers/codex/oauth/:loginId/status', async (request, reply) => {
    try {
      const { loginId } = codexOAuthStatusParamsSchema.parse(request.params);
      return reply.send(await readCodexOAuthBrowserLoginStatus(loginId));
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
      const existingConnection = input.connectionId
        ? await readAIProviderConnectionSecretById(repository, input.connectionId)
        : undefined;
      if (input.connectionId && !existingConnection) {
        throw new Error('AI provider connection was not found.');
      }
      if (
        existingConnection
        && (existingConnection.provider !== 'codex' || existingConnection.authMode !== 'codex_oauth')
      ) {
        throw new Error('Only an existing Codex OAuth connection can be signed in again.');
      }

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

      const provider = createProvider('codex', {
        authMode: 'codex_oauth',
        model: input.model,
        codexHome: completed.status.codexHome
      });
      const estimate = await provider.estimateCost({
        prompt: 'Provider connection check prompt.',
        repositorySizeHint: 'small'
      });

      const currentUser = await repository.getCurrentUser();
      const connection = await saveAIProviderConnection(repository, {
        connectionId: input.connectionId,
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
      if (input.provider === 'github_copilot' && !input.connectionId) {
        throw new Error('GitHub Copilot provider is frozen. New connections cannot be created.');
      }
      const existingConnection = input.connectionId
        ? await readAIProviderConnectionSecretById(repository, input.connectionId)
        : undefined;
      if (input.connectionId && !existingConnection) {
        throw new Error('AI provider connection was not found.');
      }
      if (
        existingConnection
        && (existingConnection.provider !== input.provider || existingConnection.authMode !== input.authMode)
      ) {
        throw new Error('Provider and authentication type cannot be changed on an existing connection. Add a new connection instead.');
      }

      let codexOAuthStatus: Awaited<ReturnType<typeof readCodexOAuthStatus>> | undefined;
      if (input.authMode === 'codex_oauth') {
        if (!existingConnection?.codexHome) {
          throw new Error('Start and complete a new Codex OAuth login before creating this connection.');
        }
        codexOAuthStatus = await readCodexOAuthStatus(existingConnection.codexHome);
        if (!codexOAuthStatus.loggedIn) {
          throw new Error('This Codex OAuth connection has expired. Sign in again.');
        }
      }

      const provider = createProvider(input.provider, {
        apiKey: input.apiKey ?? existingConnection?.apiKey,
        authMode: input.authMode,
        model: input.model,
        codexHome: codexOAuthStatus?.codexHome
      });
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
        codexHome: codexOAuthStatus?.codexHome,
        accountSummary: codexOAuthStatus?.accountSummary ?? undefined
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
          validationProfile: input.validationProfile,
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

  app.get('/api/projects/:id/specifications', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const specifications = await repository.getProjectSpecifications(id);
    return specifications ? specifications : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.get('/api/projects/:id/contracts', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const contracts = await repository.getProjectContracts(id);
    return contracts ? contracts : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.get('/api/projects/:id/architectures', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const architectures = await repository.getProjectArchitectures(id);
    return architectures ? architectures : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.post('/api/projects/:id/audit/retry', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const roadmap = await repository.getProjectRoadmap(id);
      if (!roadmap) return sendNotFound(reply, `Project "${id}" not found`);
      const cycle = [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
      if (!cycle) return reply.code(409).send({ error: 'The project does not have a roadmap cycle to audit.' });
      const auditJob = roadmap.auditJobs.find((job) => job.cycleId === cycle.id);
      if (!auditJob || (auditJob.status !== 'failed' && auditJob.status !== 'blocked')) {
        return reply.code(409).send({ error: 'Only a failed or blocked project audit can be retried.' });
      }
      await repository.enqueueProjectAudit({
        projectId: id,
        cycleId: cycle.id,
        triggerTaskId: auditJob.triggerTaskId,
        requirementIds: auditJob.requirementIds
      });
      return (await repository.getProjectRoadmap(id))!;
    } catch (error) {
      return sendBadRequest(reply, error);
    }
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

      const task = await startNextRoadmapStep(repository, project.id, latestCycle.id);
      return task
        ? reply.code(201).send(task)
        : reply.code(409).send({ error: 'The next implementation step was already reserved or started.' });
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
      await repository.assertProjectRoadmapRegenerationAllowed(project.id);

      const objective = input.objective?.trim() || project.brief?.trim();
      if (!objective) {
        return reply.code(400).send({ error: 'Project brief is required before generating implementation steps.' });
      }

      const specifications = await repository.getProjectSpecifications(project.id);
      const currentSpecification = specifications?.current.fullSpecification ?? project.brief ?? objective;
      const contractHistory = await repository.getProjectContracts(project.id);
      const previousContract = contractHistory?.current?.contract;
      const planning = await generateRoadmapPlan(repository, project, objective, currentSpecification, previousContract);
      let plan = planning.plan;
      const regeneratedContract = resolveRegeneratedProjectContract(
        plan,
        currentSpecification,
        objective,
        previousContract
      );
      const { projectContract, contractDelta, touchedRequirementIds } = regeneratedContract;
      const architectureUpdate = toProjectArchitectureUpdate(plan, !previousContract);
      const roadmapValidationOptions = previousContract
        ? {
            completedStepTitles: planning.completedSteps,
            migrationImpacts: contractDelta!.migrationImpacts,
            compatibilityImpacts: contractDelta!.compatibilityImpacts,
            extension: true
          }
        : { completedStepTitles: planning.completedSteps };
      const repairedRoadmap = await buildImplementationStepBlueprintsWithRepairs({
        provider: planning.provider,
        session: planning.session,
        plan,
        repairInput: {
          taskId: project.id,
          objective,
          allowedRequirementIds: touchedRequirementIds,
          completedStepTitles: planning.completedSteps,
          migrationImpacts: contractDelta?.migrationImpacts ?? [],
          compatibilityImpacts: contractDelta?.compatibilityImpacts ?? []
        },
        validate: (candidate) => toImplementationStepBlueprints(
          candidate,
          projectContract,
          touchedRequirementIds,
          roadmapValidationOptions
        )
      });
      plan = repairedRoadmap.plan;
      const stepBlueprints = repairedRoadmap.blueprints;
      if (stepBlueprints.length === 0) {
        throw new Error('AI provider did not return any implementation steps.');
      }

      const roadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id,
        objective,
        projectContract,
        contractDelta,
        contractChangeSummary: contractDelta?.summary ?? 'Initial generated project contract.',
        architectureUpdate,
        steps: stepBlueprints
      });

      const firstStep = findFirstPendingStepForLatestCycle(roadmap);
      if (firstStep) {
        await startNextRoadmapStep(repository, project.id, firstStep.cycleId);
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

      const cycle = input.cycleId
        ? roadmap.cycles.find((candidate) => candidate.id === input.cycleId)
        : [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
      if (!cycle) {
        return reply.code(400).send({ error: 'No roadmap cycle exists for this project.' });
      }

      if (!input.approved) {
        await repository.updateProjectRoadmapCycleStatus(cycle.id, 'completed');
        return (await repository.getProjectRoadmap(id))!;
      }

      const specifications = await repository.getProjectSpecifications(project.id);
      if (specifications?.versions.some((version) => version.sourceCycleId === cycle.id)) {
        return roadmap;
      }
      if (cycle.status !== 'awaiting_extension_approval') {
        return reply.code(409).send({ error: 'The selected roadmap cycle is not awaiting extension approval.' });
      }

      const objective = input.objectiveOverride?.trim() || cycle.extensionProposal?.trim();
      if (!objective) {
        return reply.code(400).send({ error: 'There is no approved extension proposal to expand into implementation steps.' });
      }

      const currentSpecification = specifications?.current.fullSpecification ?? project.brief ?? project.name;
      const nextSpecification = composeApprovedExtensionSpecification(currentSpecification, objective);
      if (!project.projectContract) {
        throw new Error('A current project contract is required before an extension can be approved. Regenerate the roadmap first.');
      }
      const planning = await generateRoadmapPlan(repository, project, objective, nextSpecification, project.projectContract);
      let plan = planning.plan;
      const contractDelta = toProjectContractDelta(plan);
      const appliedContract = applyProjectContractDelta(project.projectContract, contractDelta);
      const projectContract = withProjectContractSource(appliedContract.contract, nextSpecification);
      const architectureUpdate = toProjectArchitectureUpdate(plan);
      const roadmapValidationOptions = {
        completedStepTitles: planning.completedSteps,
        migrationImpacts: contractDelta.migrationImpacts,
        compatibilityImpacts: contractDelta.compatibilityImpacts,
        extension: true
      };
      const repairedRoadmap = await buildImplementationStepBlueprintsWithRepairs({
        provider: planning.provider,
        session: planning.session,
        plan,
        repairInput: {
          taskId: project.id,
          objective,
          allowedRequirementIds: appliedContract.touchedRequirementIds,
          completedStepTitles: planning.completedSteps,
          migrationImpacts: contractDelta.migrationImpacts,
          compatibilityImpacts: contractDelta.compatibilityImpacts
        },
        validate: (candidate) => toImplementationStepBlueprints(candidate, projectContract, appliedContract.touchedRequirementIds, roadmapValidationOptions)
      });
      plan = repairedRoadmap.plan;
      const stepBlueprints = repairedRoadmap.blueprints;
      if (stepBlueprints.length === 0) {
        throw new Error('AI provider did not return any implementation steps.');
      }

      const nextRoadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id,
        objective,
        projectContract,
        contractDelta,
        contractChangeSummary: contractDelta.summary ?? objective,
        architectureUpdate,
        approvedExtension: {
          sourceCycleId: cycle.id,
          changeSummary: `Approved extension for roadmap cycle ${cycle.cycleNumber + 1}.`
        },
        steps: stepBlueprints
      });

      const firstStep = findFirstPendingStepForLatestCycle(nextRoadmap);
      if (firstStep) {
        await startNextRoadmapStep(repository, project.id, firstStep.cycleId);
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
      const existingTask = await repository.getTask(id);
      if (!existingTask) return sendNotFound(reply, `Task "${id}" not found`);
      const project = await repository.getProject(existingTask.projectId);
      if (!project) return sendNotFound(reply, `Project "${existingTask.projectId}" not found`);
      if (project.githubOwner && project.githubRepo) {
        if (!existingTask.pullRequestNumber) {
          return reply.code(409).send({ error: 'Task cannot be completed because it has no pull request.' });
        }
        const connection = await readGitHubConnectionSecret(repository);
        if (!connection) {
          return reply.code(409).send({ error: 'Task completion requires the configured GitHub connection to verify the pull request.' });
        }
        const github = new GitHubAppAdapter({ token: connection.token, apiBaseUrl: connection.apiBaseUrl });
        const pullRequest = await github.getPullRequestState(project, existingTask.pullRequestNumber);
        if (!pullRequest.merged) {
          return reply.code(409).send({ error: `Pull request #${existingTask.pullRequestNumber} is not merged.` });
        }
      }
      if (existingTask.waitingForCapabilities?.length) {
        const task = await repository.waitTaskForCapabilities(id, existingTask.waitingForCapabilities, {
          source: 'user',
          pullRequestMerged: true
        });
        await advanceRoadmapAfterTaskCapabilityWait(repository, id);
        return task;
      }
      const task = await repository.transitionTask(id, 'completed', { source: 'user' });
      await repository.recordCompletedTaskProjectMemory({ taskId: id });
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

      return task;
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
  project: Project,
  objective: string,
  currentSpecification?: string,
  currentContract?: ProjectContract
): Promise<{ plan: PlanResult; provider: AIProvider; session: ProviderSessionContext; completedSteps: string[] }> {
  const connection = project.aiProviderConnectionId
    ? await readAIProviderConnectionSecretById(repository, project.aiProviderConnectionId)
    : await readAIProviderConnectionSecret(repository);
  if (!connection) {
    throw new Error('Connect an AI provider before generating implementation steps.');
  }

  const provider = createProvider(connection.provider, {
    apiKey: connection.apiKey,
    authMode: connection.authMode,
    model: connection.model,
    codexHome: connection.codexHome
  });
  let session = createProjectPlanningSession(repository, project, connection);
  const existingRoadmap = await repository.getProjectRoadmap(project.id);
  const completedSteps = existingRoadmap?.steps.filter((step) => step.status === 'completed').map((step) => step.title) ?? [];
  const planInput = {
    taskId: project.id,
    title: `Project roadmap for ${project.name}`,
    prompt: buildRoadmapPlanningPrompt({
      project: currentSpecification ? { ...project, brief: currentSpecification } : project,
      objective,
      completedSteps,
      continuation: Boolean(session.id),
      currentContract
    }),
    maxRuntimeMs: roadmapPlanningMaxRuntimeMs()
  };
  let plan: PlanResult;
  try {
    plan = await provider.plan({ ...planInput, session });
  } catch (error) {
    if (!(error instanceof CodexExecutionTimeoutError) || !session.id) throw error;
    session = createProjectPlanningSession(repository, project, connection, true);
    plan = await provider.plan({ ...planInput, session });
  }
  return { plan, provider, session, completedSteps };
}

function roadmapPlanningMaxRuntimeMs(): number {
  const configured = Number(process.env.FORGEMIND_ROADMAP_PLAN_MAX_RUNTIME_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.min(configured, 3_600_000)
    : 15 * 60_000;
}

export async function repairRoadmapOnce(
  provider: AIProvider,
  session: ProviderSessionContext,
  plan: PlanResult,
  input: {
    taskId: string;
    objective: string;
    validationError: string;
    allowedRequirementIds: string[];
    completedStepTitles: string[];
    migrationImpacts: string[];
    compatibilityImpacts: string[];
  }
): Promise<PlanResult> {
  if (!provider.repairRoadmap) {
    throw new Error(`Roadmap validation failed and provider "${provider.kind}" does not support targeted repair: ${input.validationError}`);
  }
  const repaired = await provider.repairRoadmap({
    ...input,
    implementationSteps: plan.implementationSteps ?? [],
    session
  });
  return { ...plan, implementationSteps: repaired.implementationSteps };
}

export async function buildImplementationStepBlueprintsWithRepairs<T>(input: {
  provider: AIProvider;
  session: ProviderSessionContext;
  plan: PlanResult;
  repairInput: Omit<Parameters<typeof repairRoadmapOnce>[3], 'validationError'>;
  validate: (plan: PlanResult) => T;
  maxRepairs?: number;
}): Promise<{ plan: PlanResult; blueprints: T }> {
  let plan = input.plan;
  const maxRepairs = Math.max(0, input.maxRepairs ?? 2);
  for (let repairAttempt = 0; ; repairAttempt += 1) {
    try {
      return { plan, blueprints: input.validate(plan) };
    } catch (error) {
      if (repairAttempt >= maxRepairs) throw error;
      plan = await repairRoadmapOnce(input.provider, input.session, plan, {
        ...input.repairInput,
        validationError: errorMessage(error)
      });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createProjectPlanningSession(
  repository: Pick<ForgeMindRepository, 'updateProjectPlanningSession'>,
  project: Project,
  connection: AIProviderConnectionSecret,
  forceFresh = false
): ProviderSessionContext {
  const canResume = !forceFresh
    && project.planningSessionProvider === connection.provider
    && project.planningSessionModel === connection.model
    && project.planningSessionConnectionId === connection.id;
  return {
    id: canResume ? project.planningSessionId : undefined,
    provider: connection.provider,
    model: connection.model,
    onUpdate: async (update) => {
      await repository.updateProjectPlanningSession({
        projectId: project.id,
        sessionId: update.id,
        provider: update.provider,
        model: update.model,
        connectionId: connection.id
      });
    }
  };
}

export function buildRoadmapPlanningPrompt(input: {
  project: Pick<Project, 'name' | 'brief'>;
  objective: string;
  completedSteps: string[];
  continuation: boolean;
  currentContract?: ProjectContract;
}): string {
  if (input.currentContract) {
    return [
      input.continuation
        ? 'Continue the existing project planning session. The persisted contract below is authoritative even if session memory differs.'
        : 'Revise the persisted project contract below against the complete current specification. It is the authoritative base contract and unchanged requirements must survive.',
      `Generate an ordered implementation roadmap only for changes required by this objective: ${input.objective}`,
      `Current contract (compact JSON):\n${JSON.stringify(compactProjectContract(input.currentContract))}`,
      input.completedSteps.length > 0
        ? `Do not recreate these completed steps:\n${input.completedSteps.map((step) => `- ${step}`).join('\n')}`
        : undefined,
      `Return projectContract as null and contractDelta with baseVersion ${input.currentContract.version}.`,
      'The delta must list every requirement addition, update, supersession, or removal explicitly. Every update, supersession, and removal requires a concrete rationale.',
      'Never replace the complete contract with a smaller topical contract. Requirements omitted from the delta remain active and unchanged.',
      'Preserve all unchanged active requirements. Include migrationImpacts and compatibilityImpacts, using empty arrays when there are none.',
      'Return only implementationSteps needed to realize the delta. Every added, updated, superseded, or removed requirement must be referenced by at least one returned step.',
      'Every step must include a concrete changeRationale, dependsOnStepTitles referencing only earlier returned steps, and validationFocus. Include regression validation and add migration or compatibility validation when those impacts are declared.',
      'Keep each implementation step focused: at most 3 requirementIds, 3 deliverables, 5 acceptanceCriteria, and 5 inScope items. Split broader work into additional ordered steps.',
      'Return a compact architectureUpdate containing only architecture changes caused by this extension.'
    ].filter(Boolean).join('\n\n');
  }

  return [
      input.continuation
        ? 'Generate a fresh complete project contract and roadmap. Persisted project state is authoritative; do not rely on an older session contract.'
        : 'Generate an ordered implementation roadmap for the following project objective.',
      '',
      `Project: ${input.project.name}`,
      `Objective: ${input.objective}`,
      !input.continuation && input.project.brief?.trim() && input.project.brief.trim() !== input.objective.trim()
        ? `Existing brief context: ${input.project.brief.trim()}`
        : undefined,
      input.completedSteps.length > 0 ? `Already completed implementation steps:\n${input.completedSteps.map((step) => `- ${step}`).join('\n')}` : undefined,
      '',
      'Return concrete implementation steps that can be executed one by one as individual engineering tasks in implementationSteps.',
      'Also return projectContract with version 1, summary, global invariants, prohibited substitutes, atomic requirements, and release criteria.',
      'Return contractDelta as null because this is a complete contract generation.',
      'For every projectContract requirement, include briefReferences with short phrases or section names that identify the source obligation in the supplied brief.',
      'Return architectureUpdate with the intended modules, their paths and public interfaces, allowed dependencies, conventions, decisions, known debt, and lightweight executable architecture validation commands that remain valid after every implementation step.',
      'Every requirement id must use REQ-UPPERCASE format and describe one independently verifiable product capability, not an implementation layer.',
      'Each implementationSteps item must contain title, a distinct implementation-focused description, acceptanceCriteria, inScope, outOfScope, requirementIds, and concrete deliverables.',
      'Each implementationSteps item must also contain changeRationale, dependsOnStepTitles, and validationFocus. Dependencies may reference only earlier step titles. validationFocus uses implementation, migration, compatibility, or regression.',
      'Each implementation step must fit one focused pull request and cover at most three contract requirements. Split broad epics into multiple steps.',
      'Each implementation step may contain at most 3 deliverables, 5 acceptanceCriteria, and 5 inScope items.',
      'Every contract requirement must be referenced by at least one implementation step. Placeholder data, declarations, documentation, interfaces, or pass-valued evidence do not satisfy production capabilities unless explicitly required.',
      'Give every step only its own verifiable acceptance criteria. Do not copy project-wide acceptance criteria to every step.',
      'Steps must not overlap. Do not include work assigned to a later step, and do not recreate already completed capabilities.',
      'A documentation or scope-definition step must change documentation only and must not implement application code.',
      'Order dependencies explicitly so each task starts from the repository state produced by earlier tasks.'
    ].filter(Boolean).join('\n');
}

function compactProjectContract(contract: ProjectContract): ProjectContract {
  return {
    version: contract.version,
    summary: contract.summary,
    invariants: contract.invariants,
    prohibitedSubstitutes: contract.prohibitedSubstitutes,
    requirements: contract.requirements,
    releaseCriteria: contract.releaseCriteria
  };
}

export function toProjectArchitectureUpdate(plan: PlanResult, requireModule = false): ProjectArchitectureUpdate {
  const parsed = architectureUpdatePlanSchema.parse(plan.architectureUpdate);
  if (requireModule && parsed.modules.length === 0) {
    throw new Error('AI provider did not return an initial project architecture module.');
  }
  return {
    ...parsed,
    summary: parsed.summary ?? undefined
  };
}

export function toProjectContract(plan: PlanResult, source = '', version?: number): ProjectContract {
  const contract = projectContractPlanSchema.parse(plan.projectContract);
  const ids = contract.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('AI provider returned duplicate project contract requirement ids.');
  }
  const sourceBriefSnapshot = normalizeContractSource(source);
  const contractVersion = version ?? contract.version;
  return {
    ...contract,
    version: contractVersion,
    requirements: contract.requirements.map((requirement) => ({
      ...requirement,
      status: 'active',
      introducedInVersion: contractVersion,
      lastChangedInVersion: contractVersion
    })),
    sourceBriefHash: createHash('sha256').update(sourceBriefSnapshot).digest('hex'),
    sourceBriefSnapshot
  };
}

export function toProjectContractDelta(plan: PlanResult): ProjectContractDelta {
  const parsed = projectContractDeltaPlanSchema.parse(plan.contractDelta);
  return {
    ...parsed,
    summary: parsed.summary ?? undefined,
    updateRequirements: parsed.updateRequirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title ?? undefined,
      description: requirement.description ?? undefined,
      acceptanceCriteria: requirement.acceptanceCriteria ?? undefined,
      briefReferences: requirement.briefReferences ?? undefined,
      rationale: requirement.rationale
    }))
  };
}

export function resolveRegeneratedProjectContract(
  plan: PlanResult,
  currentSpecification: string,
  objective: string,
  previousContract?: ProjectContract
): {
  projectContract: ProjectContract;
  contractDelta?: ProjectContractDelta;
  touchedRequirementIds: string[];
} {
  const source = buildContractSource(currentSpecification, objective);
  if (!previousContract) {
    const projectContract = toProjectContract(plan, source, 1);
    return {
      projectContract,
      touchedRequirementIds: activeProjectContractRequirements(projectContract).map((requirement) => requirement.id)
    };
  }

  const contractDelta = toProjectContractDelta(plan);
  const applied = applyProjectContractDelta(previousContract, contractDelta);
  return {
    projectContract: withProjectContractSource(applied.contract, source),
    contractDelta,
    touchedRequirementIds: applied.touchedRequirementIds
  };
}

function withProjectContractSource(contract: ProjectContract, source: string): ProjectContract {
  const sourceBriefSnapshot = normalizeContractSource(source);
  return {
    ...contract,
    sourceBriefHash: createHash('sha256').update(sourceBriefSnapshot).digest('hex'),
    sourceBriefSnapshot
  };
}

function buildContractSource(brief: string | undefined, objective: string): string {
  return [brief?.trim(), objective.trim()].filter(Boolean).join('\n\n');
}

function normalizeContractSource(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export function toImplementationStepBlueprints(
  plan: PlanResult,
  projectContract: ProjectContract,
  requiredRequirementIds = activeProjectContractRequirements(projectContract).map((requirement) => requirement.id),
  options: {
    completedStepTitles?: string[];
    migrationImpacts?: string[];
    compatibilityImpacts?: string[];
    extension?: boolean;
  } = {}
): Array<{
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requirementIds: string[];
  deliverables: string[];
  changeRationale: string;
  dependsOnStepTitles: string[];
  validationFocus: Array<'implementation' | 'migration' | 'compatibility' | 'regression'>;
}> {
  if (!Array.isArray(plan.implementationSteps) || plan.implementationSteps.length === 0) {
    throw new Error('AI provider did not return structured implementationSteps for the project roadmap.');
  }

  const knownTitles = new Set<string>();
  const completedTitles = new Set((options.completedStepTitles ?? []).map(normalizeRoadmapIdentity));
  const allowedRequirementIds = new Set(requiredRequirementIds);
  const blueprints = plan.implementationSteps.map((step, index) => {
    const title = step.title.trim();
    const description = step.description.trim();
    const acceptanceCriteria = step.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean);
    const inScope = step.inScope.map((item) => item.trim()).filter(Boolean);
    const outOfScope = step.outOfScope.map((item) => item.trim()).filter(Boolean);
    const requirementIds = step.requirementIds.map((item) => item.trim()).filter(Boolean);
    const deliverables = step.deliverables.map((item) => item.trim()).filter(Boolean);
    const changeRationale = step.changeRationale?.trim();
    const dependsOnStepTitles = step.dependsOnStepTitles?.map((item) => item.trim()).filter(Boolean) ?? [];
    const validationFocus = Array.from(new Set(['implementation' as const, ...(step.validationFocus ?? [])]));

    if (!title || !description || acceptanceCriteria.length === 0 || inScope.length === 0 || requirementIds.length === 0 || deliverables.length === 0 || !changeRationale) {
      throw new Error(`AI provider returned an incomplete implementation step at position ${index + 1}.`);
    }
    if (requirementIds.length > 3 || deliverables.length > 3 || acceptanceCriteria.length > 5 || inScope.length > 5) {
      const counts = [
        `requirementIds=${requirementIds.length}/3`,
        `deliverables=${deliverables.length}/3`,
        `acceptanceCriteria=${acceptanceCriteria.length}/5`,
        `inScope=${inScope.length}/5`
      ].join(', ');
      throw new Error(`AI provider returned an oversized implementation step at position ${index + 1} (${counts}); split it into focused work items and preserve complete requirement coverage.`);
    }
    const knownRequirementIds = new Set(projectContract.requirements.map((requirement) => requirement.id));
    const unknownRequirementId = requirementIds.find((id) => !knownRequirementIds.has(id));
    if (unknownRequirementId) {
      throw new Error(`Implementation step ${index + 1} references unknown requirement "${unknownRequirementId}".`);
    }
    const titleIdentity = normalizeRoadmapIdentity(title);
    if (knownTitles.has(titleIdentity)) {
      throw new Error(`Roadmap contains duplicate implementation step title "${title}".`);
    }
    if (completedTitles.has(titleIdentity)) {
      throw new Error(`Roadmap recreates completed implementation step "${title}".`);
    }
    const invalidDependency = dependsOnStepTitles.find((dependency) => !knownTitles.has(normalizeRoadmapIdentity(dependency)));
    if (invalidDependency) {
      throw new Error(`Implementation step "${title}" depends on unknown or later step "${invalidDependency}".`);
    }
    if (options.extension) {
      const scopeCrossingRequirement = requirementIds.find((id) => !allowedRequirementIds.has(id));
      if (scopeCrossingRequirement) {
        throw new Error(`Extension step "${title}" crosses the contract delta scope via requirement "${scopeCrossingRequirement}".`);
      }
    }
    knownTitles.add(titleIdentity);

    return {
      title,
      description: [
        description,
        '',
        'In scope:',
        ...inScope.map((item) => `- ${item}`),
        ...(outOfScope.length > 0 ? ['', 'Out of scope:', ...outOfScope.map((item) => `- ${item}`)] : [])
      ].join('\n'),
      acceptanceCriteria,
      requirementIds,
      deliverables,
      changeRationale,
      dependsOnStepTitles,
      validationFocus
    };
  });

  const coveredRequirementIds = new Set(plan.implementationSteps.flatMap((step) => step.requirementIds));
  const missingRequirementId = requiredRequirementIds.find((requirementId) => !coveredRequirementIds.has(requirementId));
  if (missingRequirementId) {
    throw new Error(`Roadmap does not cover project contract requirement "${missingRequirementId}".`);
  }
  if (options.extension && !blueprints.some((step) => step.validationFocus.includes('regression'))) {
    throw new Error('Extension roadmap must include regression validation focus.');
  }
  if ((options.migrationImpacts?.length ?? 0) > 0 && !blueprints.some((step) => step.validationFocus.includes('migration'))) {
    throw new Error('Roadmap declares migration impacts but has no migration validation focus.');
  }
  if ((options.compatibilityImpacts?.length ?? 0) > 0 && !blueprints.some((step) => step.validationFocus.includes('compatibility'))) {
    throw new Error('Roadmap declares compatibility impacts but has no compatibility validation focus.');
  }

  return blueprints;
}

function normalizeRoadmapIdentity(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
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

export function resolveTaskMode(taskMode: TaskMode | undefined, projectDefaultMode: TaskMode | undefined): TaskMode {
  return taskMode ?? projectDefaultMode ?? 'safe';
}

export { buildRoadmapStepTaskPrompt };

async function generateExtensionProposal(
  repository: ForgeMindRepository,
  project: Project,
  completedObjective: string
): Promise<string> {
  const connection = project.aiProviderConnectionId
    ? await readAIProviderConnectionSecretById(repository, project.aiProviderConnectionId)
    : await readAIProviderConnectionSecret(repository);
  if (!connection) {
    throw new Error('Connect an AI provider before generating a project extension proposal.');
  }

  const provider = createProvider(connection.provider, {
    apiKey: connection.apiKey,
    authMode: connection.authMode,
    model: connection.model,
    codexHome: connection.codexHome
  });
  const session = createProjectPlanningSession(repository, project, connection);
  const contract = project.projectContract;
  const specifications = await repository.getProjectSpecifications(project.id);
  const plan = await provider.plan({
    taskId: `project-extension:${project.id}`,
    title: `Next extension for ${project.name}`,
    prompt: buildProjectExtensionProposalPrompt({
      projectName: project.name,
      completedObjective,
      contractVersion: contract?.version,
      contractSummary: contract?.summary,
      completedCapabilities: contract?.requirements.map((requirement) => requirement.title),
      projectBrief: specifications?.current.fullSpecification ?? project.brief,
      continuation: Boolean(session.id)
    }),
    session
  });

  return formatProjectExtensionProposal(plan);
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
