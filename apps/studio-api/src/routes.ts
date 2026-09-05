import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  normalizeGitHubToken,
  prepareReadOnlyRepositoryBaseline
} from '@forgemind/github';
import type { AuthService } from './auth.js';
import { completeCodexOAuthBrowserLogin, readCodexOAuthBrowserLoginStatus, readCodexOAuthStatus, resolveCodexHome, startCodexOAuthBrowserLogin } from './codex-oauth.js';
import { createTaskDispatchService } from './dispatch.js';
import { sendBadRequest, sendNotFound } from './http.js';
import { buildReviewedImplementationStepBlueprints } from './roadmap-generation.js';
import { advanceRoadmapAfterTaskCompletion, buildRoadmapStepTaskPrompt, composeApprovedExtensionSpecification, startNextRoadmapStep } from '@forgemind/db';
import type { AIProviderConnectionKind, AIProviderConnectionSecret, ForgeMindRepository, WindowsRunnerCredentialAdapter, WindowsWorkerRepository } from '@forgemind/db';
import { parseGitHubWebhookPayload, projectGitHubWebhookEvent, verifyGitHubWebhookSignature } from './webhook.js';
import type { NotificationService } from './notifications.js';
import { ROADMAP_GENERATION_CONFIRMATION, activeProjectContractRequirements, applyProjectContractDelta, buildSpecificationChangeImpactReview, redactError, redactSecrets } from '@forgemind/core';
import type { ProviderConnectionRuntimeStatus, RoadmapGenerationCheckpoint } from '@forgemind/core';
import type { Project, ProjectArchitectureUpdate, ProjectContract, ProjectContractDelta, TaskMode } from '@forgemind/core';
import { readSessionId, registerAuthRoutes } from './routes/auth-routes.js';
import { registerNotificationRoutes } from './routes/notification-routes.js';
import { registerChatRoutes } from './routes/chat-routes.js';
import { registerWorkerRoutes } from './routes/worker-routes.js';
import { registerWindowsRunnerRoutes } from './routes/windows-runner-routes.js';

export { repairRoadmapOnce, buildImplementationStepBlueprintsWithRepairs, buildReviewedImplementationStepBlueprints } from './roadmap-generation.js';

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
  defaultTaskMode: z.enum(['safe', 'auto', 'full_auto']).optional().default('safe'),
  aiProviderConnectionId: z.string().min(1).nullable().optional(),
  repositoryMode: z.enum(['existing', 'create']).optional().default('existing'),
  branchMode: z.enum(['existing', 'create']).optional().default('existing'),
  branchName: z.string().min(1).optional(),
  repositoryPrivate: z.boolean().optional().default(true),
  repositoryDescription: z.string().max(280).optional()
}).strict();

const updateProjectSchema = projectSchema.partial().extend({
  brief: z.string().trim().min(20).nullable().optional(),
  specificationReview: z.object({
    baseSpecificationVersion: z.number().int().positive().optional(),
    baseSpecificationHash: z.string().trim().min(1).optional()
  }).optional(),
  autoCreatePullRequest: z.boolean().optional(),
  autoMergePullRequest: z.boolean().optional(),
  autoCompleteTask: z.boolean().optional(),
  defaultTaskMode: z.enum(['safe', 'auto', 'full_auto']).optional(),
  isActive: z.boolean().optional()
}).strict();

const specificationReviewSchema = z.object({
  brief: z.string().trim().min(20).nullable()
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
  mode: z.enum(['safe', 'auto', 'full_auto']).optional()
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
const auditGapDecisionSchema = z.object({ auditJobId: z.string().min(1), accepted: z.boolean() }).strict();

const roadmapGenerateSchema = z.object({
  objective: z.string().min(20).optional(),
  confirmation: z.string().trim().optional(),
  contractRecovery: z.object({
    baseVersion: z.number().int().positive(),
    reason: z.string().trim().min(20),
    confirmation: z.string().trim()
  }).optional()
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

const manualProjectContractVersionSchema = z.object({
  contract: projectContractPlanSchema.optional(),
  contractDelta: projectContractDeltaPlanSchema.optional(),
  changeSummary: z.string().trim().min(1).max(2_000)
}).refine((value) => Boolean(value.contract) !== Boolean(value.contractDelta), {
  message: 'Provide exactly one of contract or contractDelta.'
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
});

const roadmapExtensionDecisionSchema = z.object({
  accepted: z.boolean(),
  cycleId: z.string().min(1).optional(),
  objectiveOverride: z.string().min(20).optional()
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

export function registerRoutes(
  app: FastifyInstance,
  repository: ForgeMindRepository,
  notifications?: NotificationService,
  auth?: AuthService,
  windowsRunner?: { credentials: WindowsRunnerCredentialAdapter; workers: WindowsWorkerRepository }
) {
  const dispatcher = createTaskDispatchService(repository);
  const processedWebhookDeliveries = new Set<string>();
  const roadmapRequests = new Map<string, AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of roadmapRequests.values()) controller.abort(new Error('API is shutting down.'));
  });

  app.addHook('preHandler', async (request, reply) => requireAuthorizedRequest(request, reply, repository, auth));

  if (auth) registerAuthRoutes(app, repository, auth);
  registerChatRoutes(app, repository);

  app.get('/health', async () => ({
    ok: true,
    service: 'forgemind-studio-api',
    database: Boolean(process.env.DATABASE_URL)
  }));

  app.get('/api/me', async () => repository.getCurrentUser());

  registerWorkerRoutes(app, repository);
  if (windowsRunner) registerWindowsRunnerRoutes(app, repository, windowsRunner.credentials, windowsRunner.workers);

  app.get('/api/providers/status', async (_request) => {
    const githubConnection = await readGitHubConnection(repository);
    const providerConnections = await listAIProviderConnections(repository);
    const providerConnection = await readAIProviderConnection(repository);
    const runtimeStatuses = await listProviderConnectionRuntimeStatuses(repository);
    const runtimeStatusByConnection = new Map(runtimeStatuses.map((status) => [providerRuntimeStatusKey(status.provider, status.connectionId), status]));
    const connections = await Promise.all(providerConnections.map(async (connection) => {
      const runtimeStatus = runtimeStatusByConnection.get(providerRuntimeStatusKey(connection.provider, connection.id)) ?? null;
      if (connection.provider !== 'codex' || connection.authMode !== 'codex_oauth') {
        return { ...connection, available: true, runtimeStatus };
      }
      if (!connection.codexHome) {
        return { ...connection, available: false, runtimeStatus };
      }

      const status = await readCodexOAuthStatus(connection.codexHome);
      return {
        ...connection,
        runtimeStatus,
        available: status.verificationStatus === 'unavailable' ? null : status.loggedIn,
        availability: status.verificationStatus === 'verified'
          ? 'available'
          : status.verificationStatus === 'logged_out'
            ? 'reauthentication_required'
            : 'status_unavailable',
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
    const currentRuntimeStatus = currentProvider
      ? runtimeStatusByConnection.get(providerRuntimeStatusKey(currentProvider, providerConnection?.id ?? null)) ?? null
      : null;
    return {
      currentProvider,
      currentModel,
      currentConnectionId: providerConnection?.id ?? null,
      currentRuntimeStatus,
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
            ? providerConnection.authMode !== 'codex_oauth' || Boolean(providerConnection.codexHome)
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
          autoCreatePullRequest: input.autoCreatePullRequest,
          autoMergePullRequest: input.autoMergePullRequest,
          autoCompleteTask: input.autoCompleteTask,
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
      const { specificationReview, ...projectInput } = input;
      if (Object.prototype.hasOwnProperty.call(input, 'brief')) {
        if (!specificationReview) {
          return reply.code(409).send({ error: 'Review the specification diff and impact before saving a changed specification.' });
        }
        const specifications = await repository.getProjectSpecifications(id);
        if (!specifications) {
          return sendNotFound(reply, `Project "${id}" not found`);
        }
        const currentHash = hashSpecificationText(specifications.current.fullSpecification);
        if (
          specificationReview.baseSpecificationVersion !== specifications.current.version
          || specificationReview.baseSpecificationHash !== currentHash
        ) {
          return reply.code(409).send({ error: 'Specification changed after review. Review the latest diff before saving.' });
        }
      }
      const project = await repository.updateProject(id, projectInput);
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

  app.post('/api/projects/:id/specification-review', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = specificationReviewSchema.parse(request.body ?? {});
      const [project, specifications, roadmap] = await Promise.all([
        repository.getProject(id),
        repository.getProjectSpecifications(id),
        repository.getProjectRoadmap(id)
      ]);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      const proposedSpecification = input.brief?.trim() ?? '';
      const baseSpecificationHash = specifications?.current
        ? hashSpecificationText(specifications.current.fullSpecification)
        : undefined;
      const review = buildSpecificationChangeImpactReview({
        projectId: id,
        currentSpecification: specifications?.current,
        proposedSpecification,
        requirements: project.projectContract?.requirements ?? [],
        steps: roadmap?.steps ?? [],
        evidence: roadmap?.evidence ?? []
      });
      return {
        ...review,
        diff: proposedSpecification === ''
          ? review.diff.filter((line) => line.type !== 'added' || line.text !== '')
          : review.diff,
        baseSpecificationHash
      };
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/projects/:id/contracts', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const contracts = await repository.getProjectContracts(id);
    return contracts ? contracts : sendNotFound(reply, `Project "${id}" not found`);
  });

  app.post('/api/projects/:id/contracts', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = manualProjectContractVersionSchema.parse(request.body ?? {});
      const contracts = await repository.createManualProjectContractVersion({
        projectId: id,
        contract: input.contract,
        contractDelta: input.contractDelta ? normalizeProjectContractDelta(input.contractDelta) : undefined,
        changeSummary: input.changeSummary
      });
      return reply.code(201).send(contracts);
    } catch (error) {
      return sendBadRequest(reply, error);
    }
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

  app.post('/api/projects/:id/audit/start', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const [project, roadmap] = await Promise.all([
        repository.getProject(id),
        repository.getProjectRoadmap(id)
      ]);
      if (!project) return sendNotFound(reply, `Project "${id}" not found`);
      if (!roadmap) return sendNotFound(reply, `Project "${id}" does not have a roadmap`);
      if (!project.projectContract) {
        return reply.code(409).send({ error: 'A project contract is required before the final audit can start.' });
      }
      const cycle = [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
      if (!cycle) return reply.code(409).send({ error: 'The project does not have a roadmap cycle to audit.' });
      if (cycle.status === 'completed' || cycle.status === 'awaiting_extension_decision') {
        return reply.code(409).send({ error: 'The latest roadmap cycle is already completed and audited.' });
      }
      const cycleSteps = roadmap.steps.filter((step) => step.cycleId === cycle.id);
      if (cycleSteps.length === 0 || cycleSteps.some((step) => step.status !== 'completed')) {
        return reply.code(409).send({ error: 'All implementation steps must be completed before the final audit can start.' });
      }
      const latestCompletedStep = [...cycleSteps]
        .filter((step) => step.taskId)
        .sort((left, right) => right.sequenceNumber - left.sequenceNumber)[0];
      const audit = await repository.enqueueProjectAudit({
        projectId: id,
        cycleId: cycle.id,
        triggerTaskId: latestCompletedStep?.taskId,
        requirementIds: activeProjectContractRequirements(project.projectContract).map((requirement) => requirement.id)
      });
      if (!audit.enqueued) {
        return reply.code(409).send({ error: 'The final project audit is already queued or no newer completed work is available to audit.' });
      }
      return (await repository.getProjectRoadmap(id))!;
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/projects/:id/audit/gaps/decision', async (request, reply) => {
    let checkout: Awaited<ReturnType<typeof prepareReadOnlyRepositoryBaseline>> | undefined;
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = auditGapDecisionSchema.parse(request.body ?? {});
      const [project, roadmap] = await Promise.all([repository.getProject(id), repository.getProjectRoadmap(id)]);
      if (!project || !roadmap) return sendNotFound(reply, `Project "${id}" not found`);
      const job = roadmap.auditJobs.find((item) => item.id === input.auditJobId);
      if (!job?.gapProposal) return reply.code(404).send({ error: 'Audit gap proposal was not found.' });
      if (job.gapProposalStatus === 'activated' || job.gapProposalStatus === 'dismissed') return roadmap;
      if (!input.accepted) {
        await repository.decideProjectAuditGapProposal({ projectId: id, auditJobId: job.id, accepted: false });
        return (await repository.getProjectRoadmap(id))!;
      }
      if (job.status !== 'succeeded' || job.gapProposalStatus !== 'proposed') {
        return reply.code(409).send({ error: 'The audit proposal is not ready for activation. Wait for the current audit or activation to finish.' });
      }
      if (!project.projectContract) throw new Error('A current project contract is required before audit gaps can be activated.');
      const connection = project.aiProviderConnectionId
        ? await readAIProviderConnectionSecretById(repository, project.aiProviderConnectionId)
        : await readAIProviderConnectionSecret(repository);
      if (!connection) throw new Error('Connect an AI provider before reviewing audit gaps.');
      if (!project.githubOwner || !project.githubRepo) throw new Error('A connected repository is required for audit gap review.');
      const provider = createProvider(connection.provider, { apiKey: connection.apiKey, authMode: connection.authMode, model: connection.model, codexHome: connection.codexHome });
      if (!provider.reviewRoadmap) throw new Error(`AI provider "${provider.kind}" does not support independent roadmap quality review.`);
      const githubConnection = await readGitHubConnectionSecret(repository);
      if (!githubConnection) throw new Error('Connect GitHub before reviewing audit gaps.');
      checkout = await prepareReadOnlyRepositoryBaseline(new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl }), project);
      const reviewContract = buildAuditGapReviewContract(project.projectContract, job.gapProposal.newRequirements);
      const review = await provider.reviewRoadmap({
        taskId: `audit-gap:${job.id}`,
        objective: [
          `Review ${job.gapProposal.kind} audit gaps against the current project scope and repository.`,
          `The proposal was recorded at commit ${job.gapProposal.commitSha}; this review uses current commit ${checkout.commitSha}.`,
          'A different commit ID alone is not a blocker: squash merges may preserve identical content.',
          'Reassess every proposed step against the current repository baseline. Reject work that is already implemented, no longer needed, or outside the current specification and contract.',
          'Approve only concrete remaining gaps; historical audit findings are context, not proof that the gap still exists.'
        ].join('\n'),
        authoritativeSpecification: (await repository.getProjectSpecifications(id))?.current.fullSpecification ?? project.brief ?? project.name,
        projectContract: reviewContract,
        requiredRequirementIds: Array.from(new Set(job.gapProposal.steps.flatMap((step) => step.requirementIds))),
        completedStepTitles: roadmap.steps.filter((step) => step.status === 'completed').map((step) => step.title),
        implementationSteps: job.gapProposal.steps.map((step) => ({ ...step, inScope: [], outOfScope: [] })),
        repositoryPath: checkout.repositoryPath,
        repositoryBaseline: { commitSha: checkout.commitSha, evidence: checkout.evidence }
      });
      await repository.saveProjectAuditGapReview({ projectId: id, auditJobId: job.id, review });
      await repository.writeAudit({
        actorType: 'system', eventType: 'project_audit_gap_review_baseline', projectId: id,
        payload: { auditJobId: job.id, proposalCommitSha: job.gapProposal.commitSha, reviewCommitSha: checkout.commitSha, verdict: review.verdict }
      });
      if (review.verdict !== 'satisfied') return reply.code(409).send({ error: review.summary, blockers: review.blockers });
      await repository.decideProjectAuditGapProposal({ projectId: id, auditJobId: job.id, accepted: true, review });
      return (await repository.getProjectRoadmap(id))!;
    } catch (error) {
      return sendBadRequest(reply, error);
    } finally { await checkout?.cleanup(); }
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

  app.post('/api/projects/:id/implementation-steps/reconcile', async (request, reply) => {
    try {
      const { id } = idParamsSchema.parse(request.params);
      const reconciliation = await repository.reconcileProjectImplementationSteps(id);
      if (!reconciliation) return sendNotFound(reply, `Project "${id}" not found`);
      const roadmap = await repository.getProjectRoadmap(id);
      return { reconciliation, roadmap };
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.post('/api/projects/:id/implementation-steps/generate', async (request, reply) => {
    let generation: ReturnType<typeof beginRoadmapRequest>;
    let planning: Awaited<ReturnType<typeof generateRoadmapPlan>> | undefined;
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = roadmapGenerateSchema.parse(request.body ?? {});
      const project = await repository.getProject(id);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }
      if (input.confirmation !== ROADMAP_GENERATION_CONFIRMATION) {
        return reply.code(409).send({
          error: `Type "${ROADMAP_GENERATION_CONFIRMATION}" to confirm roadmap generation.`
        });
      }
      generation = beginRoadmapRequest(roadmapRequests, id, request, reply);
      if (!generation) return reply.code(409).send({ error: 'Roadmap generation is already running for this project.' });
      await repository.assertProjectRoadmapRegenerationAllowed(project.id);

      const objective = input.objective?.trim() || project.brief?.trim();
      if (!objective) {
        return reply.code(400).send({ error: 'Project brief is required before generating implementation steps.' });
      }

      const specifications = await repository.getProjectSpecifications(project.id);
      const currentSpecification = specifications?.current.fullSpecification ?? project.brief ?? objective;
      const contractHistory = await repository.getProjectContracts(project.id);
      const latestContractVersion = contractHistory?.versions.at(-1);
      const recovery = input.contractRecovery;
      if (recovery && recovery.confirmation !== `RECOVER CONTRACT FROM V${recovery.baseVersion}`) {
        return reply.code(400).send({
          error: `Type "RECOVER CONTRACT FROM V${recovery.baseVersion}" to confirm contract recovery.`
        });
      }
      const recoveryBaseVersion = recovery
        ? contractHistory?.versions.find((version) => version.version === recovery.baseVersion)
        : undefined;
      if (recovery && !recoveryBaseVersion) {
        return reply.code(400).send({
          error: `Project contract version ${recovery.baseVersion} does not exist.`
        });
      }
      if (recovery && latestContractVersion && recovery.baseVersion >= latestContractVersion.version) {
        return reply.code(400).send({
          error: 'Contract recovery must select a historical version older than the latest contract.'
        });
      }
      const previousContract = recoveryBaseVersion?.contract ?? latestContractVersion?.contract;
      planning = await generateRoadmapPlan(
        repository,
        project,
        objective,
        currentSpecification,
        previousContract,
        recoveryBaseVersion?.id ?? latestContractVersion?.id,
        generation.signal,
        { operation: 'regenerate', recovery }
      );
      let plan = planning.plan;
      const regeneratedContract = resolveRegeneratedProjectContract(
        plan,
        currentSpecification,
        objective,
        previousContract,
        latestContractVersion ? latestContractVersion.version + 1 : undefined
      );
      const { projectContract, contractDelta, touchedRequirementIds } = regeneratedContract;
      const architectureUpdate = toProjectArchitectureUpdate(plan, !previousContract);
      const requiredRequirementIds = collectRegeneratedRoadmapRequirementIds(
        projectContract,
        touchedRequirementIds,
        planning.unfinishedSteps
      );
      const roadmapValidationOptions = previousContract
        ? {
            completedStepTitles: planning.completedSteps,
            migrationImpacts: contractDelta!.migrationImpacts,
            compatibilityImpacts: contractDelta!.compatibilityImpacts,
            extension: true
          }
        : { completedStepTitles: planning.completedSteps };
      const repairedRoadmap = await buildReviewedImplementationStepBlueprints({
        provider: planning.provider,
        session: planning.session,
        plan,
        checkpoint: planning.checkpoint,
        onCheckpoint: planning.saveCheckpoint,
        signal: generation.signal,
        repairInput: {
          taskId: project.id,
          objective,
          authoritativeSpecification: currentSpecification,
          projectContract,
          persistedProjectContract: previousContract,
          requiredRequirementIds,
          completedStepTitles: planning.completedSteps,
          migrationImpacts: contractDelta?.migrationImpacts ?? [],
          compatibilityImpacts: contractDelta?.compatibilityImpacts ?? [],
          repositoryPath: planning.repositoryPath
        },
        reviewInput: {
          taskId: project.id,
          objective,
          authoritativeSpecification: currentSpecification,
          projectContract,
          requiredRequirementIds,
          completedStepTitles: planning.completedSteps,
          repositoryPath: planning.repositoryPath,
          repositoryBaseline: planning.repositoryBaseline
        },
        validate: (candidate, effectiveContract = projectContract, effectiveRequiredIds = requiredRequirementIds) => toImplementationStepBlueprints(
          candidate,
          effectiveContract,
          effectiveRequiredIds,
          roadmapValidationOptions
        )
      });
      plan = repairedRoadmap.plan;
      const repairedProjectContract = plan.projectContract ?? projectContract;
      const repairedContractDelta = plan.contractDelta ?? contractDelta;
      const stepBlueprints = repairedRoadmap.blueprints;
      if (stepBlueprints.length === 0) {
        throw new Error('AI provider did not return any implementation steps.');
      }

      generation.signal.throwIfAborted();
      await planning.assertCurrentSource();
      generation.signal.throwIfAborted();
      const roadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id,
        objective,
        projectContract: repairedProjectContract,
        contractDelta: repairedContractDelta,
        contractChangeSummary: repairedContractDelta?.summary ?? 'Initial generated project contract.',
        contractRecovery: recovery ? {
          baseVersion: recovery.baseVersion,
          reason: recovery.reason
        } : undefined,
        architectureUpdate,
        qualityReview: repairedRoadmap.qualityReview,
        steps: stepBlueprints
      });

      const firstStep = findFirstPendingStepForLatestCycle(roadmap);
      if (firstStep && !recovery) {
        await startNextRoadmapStep(repository, project.id, firstStep.cycleId);
      }

      return reply.code(201).send((await repository.getProjectRoadmap(project.id))!);
    } catch (error) {
      await recordRoadmapInterruption(repository, generation, error, request);
      return sendBadRequest(reply, error);
    } finally {
      try {
        await planning?.cleanup();
      } finally {
        generation?.release();
      }
    }
  });

  app.post('/api/projects/:id/extension/decision', async (request, reply) => {
    let generation: ReturnType<typeof beginRoadmapRequest>;
    let planning: Awaited<ReturnType<typeof generateRoadmapPlan>> | undefined;
    try {
      const { id } = idParamsSchema.parse(request.params);
      const input = roadmapExtensionDecisionSchema.parse(request.body ?? {});
      const project = await repository.getProject(id);
      if (!project) {
        return sendNotFound(reply, `Project "${id}" not found`);
      }

      if (input.accepted) {
        generation = beginRoadmapRequest(roadmapRequests, id, request, reply);
        if (!generation) return reply.code(409).send({ error: 'Roadmap generation is already running for this project.' });
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

      if (!input.accepted) {
        await repository.updateProjectRoadmapCycleStatus(cycle.id, 'completed');
        return (await repository.getProjectRoadmap(id))!;
      }

      const specifications = await repository.getProjectSpecifications(project.id);
      if (specifications?.versions.some((version) => version.sourceCycleId === cycle.id)) {
        return roadmap;
      }
      if (cycle.status !== 'awaiting_extension_decision') {
        return reply.code(409).send({ error: 'The selected roadmap cycle is not awaiting an extension decision.' });
      }

      const objective = input.objectiveOverride?.trim() || cycle.extensionProposal?.trim();
      if (!objective) {
        return reply.code(400).send({ error: 'There is no accepted extension proposal to expand into implementation steps.' });
      }

      const currentSpecification = specifications?.current.fullSpecification ?? project.brief ?? project.name;
      const nextSpecification = composeApprovedExtensionSpecification(currentSpecification, objective);
      if (!project.projectContract) {
        throw new Error('A current project contract is required before an extension can be accepted. Regenerate the roadmap first.');
      }
      planning = await generateRoadmapPlan(repository, project, objective, nextSpecification, project.projectContract,
        undefined, generation!.signal, { operation: 'extension', cycleId: cycle.id });
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
      const repairedRoadmap = await buildReviewedImplementationStepBlueprints({
        provider: planning.provider,
        session: planning.session,
        plan,
        checkpoint: planning.checkpoint,
        onCheckpoint: planning.saveCheckpoint,
        signal: generation!.signal,
        repairInput: {
          taskId: project.id,
          objective,
          authoritativeSpecification: nextSpecification,
          projectContract,
          persistedProjectContract: project.projectContract,
          requiredRequirementIds: appliedContract.touchedRequirementIds,
          completedStepTitles: planning.completedSteps,
          migrationImpacts: contractDelta.migrationImpacts,
          compatibilityImpacts: contractDelta.compatibilityImpacts,
          repositoryPath: planning.repositoryPath
        },
        reviewInput: {
          taskId: project.id,
          objective,
          authoritativeSpecification: nextSpecification,
          projectContract,
          requiredRequirementIds: appliedContract.touchedRequirementIds,
          completedStepTitles: planning.completedSteps,
          repositoryPath: planning.repositoryPath,
          repositoryBaseline: planning.repositoryBaseline
        },
        validate: (candidate, effectiveContract = projectContract, effectiveRequiredIds = appliedContract.touchedRequirementIds) =>
          toImplementationStepBlueprints(candidate, effectiveContract, effectiveRequiredIds, roadmapValidationOptions)
      });
      plan = repairedRoadmap.plan;
      const repairedProjectContract = plan.projectContract ?? projectContract;
      const repairedContractDelta = plan.contractDelta ?? contractDelta;
      const stepBlueprints = repairedRoadmap.blueprints;
      if (stepBlueprints.length === 0) {
        throw new Error('AI provider did not return any implementation steps.');
      }

      generation!.signal.throwIfAborted();
      await planning.assertCurrentSource();
      generation!.signal.throwIfAborted();
      const nextRoadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id,
        objective,
        projectContract: repairedProjectContract,
        contractDelta: repairedContractDelta,
        contractChangeSummary: repairedContractDelta.summary ?? objective,
        architectureUpdate,
        qualityReview: repairedRoadmap.qualityReview,
        approvedExtension: {
          sourceCycleId: cycle.id,
          changeSummary: `Accepted extension for roadmap cycle ${cycle.cycleNumber + 1}.`
        },
        steps: stepBlueprints
      });

      const firstStep = findFirstPendingStepForLatestCycle(nextRoadmap);
      if (firstStep) {
        await startNextRoadmapStep(repository, project.id, firstStep.cycleId);
      }

      return (await repository.getProjectRoadmap(id))!;
    } catch (error) {
      await recordRoadmapInterruption(repository, generation, error, request);
      return sendBadRequest(reply, error);
    } finally {
      try {
        await planning?.cleanup();
      } finally {
        generation?.release();
      }
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
          acceptanceCriteria: input.acceptanceCriteria,
          mode: resolveTaskMode(input.mode, project.defaultTaskMode)
        })
      );
    } catch (error) {
      return sendBadRequest(reply, error);
    }
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await repository.getTask(id);
    if (!task) return sendNotFound(reply, `Task "${id}" not found`);
    const audit = await repository.listTaskAudit(id);
    const readyPayload = [...audit].reverse().find((event) => event.eventType === 'task_status_ready_for_user_review')?.payload;
    const outcomes = readyPayload && typeof readyPayload === 'object' && !Array.isArray(readyPayload)
      ? readyPayload as Record<string, unknown>
      : {};
    return {
      ...task,
      implementationResult: outcomes.implementationResult ?? (task.status === 'completed'
        ? { status: 'completed', historical: true }
        : null),
      deliveryResult: outcomes.deliveryResult ?? (task.status === 'completed'
        ? { status: 'historical_completed', mergeConfirmed: null, historical: true }
        : null)
    };
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
          status: 'awaiting_extension_decision'
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

  app.get('/api/tasks/:id/diagnostics', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const diagnostics = await repository.exportTaskDiagnostics(id);
    if (!diagnostics) return sendNotFound(reply, `Task "${id}" not found`);
    return redactSecrets(diagnostics);
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

  registerNotificationRoutes(app, repository, notifications);
}

async function requireAuthorizedRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: ForgeMindRepository,
  auth: AuthService | undefined
) {
  if (!isProtectedApiRequest(request)) {
    return;
  }

  if (!auth) {
    return reply.code(503).send({ error: 'Authentication service is not configured.' });
  }

  const sessionId = readSessionId(request.headers.authorization, request.headers.cookie);
  if (!sessionId) {
    return reply.code(401).send({ error: 'Authentication required.' });
  }

  const session = await auth.getSessionById(sessionId);
  if (!session) {
    return reply.code(401).send({ error: 'Authentication required.' });
  }

  const currentUser = await repository.getCurrentUser();
  if (session.userId !== currentUser.id) {
    return reply.code(403).send({ error: 'Authenticated principal is not authorized for this mutation.' });
  }

  if (requiresOwnerRole(request) && currentUser.role !== 'owner') {
    return reply.code(403).send({ error: 'Owner role required for this mutation.' });
  }

}

function isProtectedApiRequest(request: FastifyRequest): boolean {
  if (request.method === 'OPTIONS') return false;
  const path = request.url.split('?')[0] ?? request.url;
  if (!path.startsWith('/api/')) return false;
  return path !== '/api/auth/session'
    && path !== '/api/auth/google/login'
    && path !== '/api/auth/google/callback'
    && path !== '/api/webhooks/github'
    && path !== '/api/windows-runner/enroll'
    && path !== '/api/windows-runner/device'
    && !path.startsWith('/api/windows-runner/device/');
}

function isMutationRequest(request: FastifyRequest): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
}

function requiresOwnerRole(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? request.url;
  return path === '/api/metrics'
    || path === '/api/worker/queue'
    || path.startsWith('/api/github/')
    || path.startsWith('/api/providers/')
    || path.startsWith('/api/windows-runner/')
    || path.endsWith('/implementation-steps/reconcile')
    || (request.method === 'DELETE' && path.startsWith('/api/projects/'));
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildTaskPrompt(input: z.infer<typeof createTaskSchema>): string {
  return input.prompt.trim();
}

export function beginRoadmapRequest(
  active: Map<string, AbortController>, projectId: string, request: FastifyRequest, reply: FastifyReply
) {
  if (active.has(projectId)) return undefined;
  const controller = new AbortController();
  active.set(projectId, controller);
  const abort = () => controller.abort(new Error('Roadmap request was interrupted; retry to resume its saved checkpoint.'));
  const close = () => { if (!reply.raw.writableEnded) abort(); };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  return {
    projectId,
    signal: controller.signal,
    release() {
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
      active.delete(projectId);
    }
  };
}

async function recordRoadmapInterruption(
  repository: ForgeMindRepository, generation: ReturnType<typeof beginRoadmapRequest>, error: unknown, request: FastifyRequest
) {
  if (!generation) return;
  try {
    await repository.writeAudit({
      actorType: 'system', eventType: 'project_roadmap_generation_interrupted', projectId: generation.projectId,
      payload: { error: redactError(error), cancelled: generation.signal.aborted }
    });
  } catch (auditError) {
    request.log.error({ error: redactError(auditError) }, 'Could not record roadmap interruption');
  }
}

async function roadmapSourceKey(repository: ForgeMindRepository, projectId: string): Promise<string> {
  const [project, specifications, contracts, roadmap] = await Promise.all([
    repository.getProject(projectId), repository.getProjectSpecifications(projectId),
    repository.getProjectContracts(projectId), repository.getProjectRoadmap(projectId)
  ]);
  const connection = project?.aiProviderConnectionId
    ? await readAIProviderConnectionSecretById(repository, project.aiProviderConnectionId)
    : await readAIProviderConnectionSecret(repository);
  return createHash('sha256').update(JSON.stringify({
    name: project?.name, brief: project?.brief, configYaml: project?.configYaml,
    githubOwner: project?.githubOwner, githubRepo: project?.githubRepo, defaultBranch: project?.defaultBranch,
    currentContractVersionId: project?.currentContractVersionId,
    architectureVersionId: project?.currentArchitectureVersionId,
    specification: specifications?.current,
    contract: contracts?.versions.at(-1),
    connection: connection ? { id: connection.id, provider: connection.provider, model: connection.model } : null,
    cycles: roadmap?.cycles,
    steps: roadmap?.steps
  })).digest('hex');
}

export async function generateRoadmapPlan(
  repository: ForgeMindRepository,
  project: Project,
  objective: string,
  currentSpecification?: string,
  currentContract?: ProjectContract,
  sourceContractVersionId?: string,
  signal?: AbortSignal,
  operation: Record<string, unknown> = { operation: 'regenerate' }
): Promise<{
  plan: PlanResult;
  provider: AIProvider;
  session: ProviderSessionContext;
  completedSteps: string[];
  unfinishedSteps: Array<{ title: string; requirementIds: string[] }>;
  repositoryBaseline: { commitSha: string; evidence: string };
  repositoryPath: string;
  cleanup: () => Promise<void>;
  checkpoint: RoadmapGenerationCheckpoint;
  saveCheckpoint: (checkpoint: RoadmapGenerationCheckpoint) => Promise<void>;
  assertCurrentSource: () => Promise<void>;
}> {
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
  const discoverBaseline = async () => {
    if (!project.githubOwner || !project.githubRepo) {
      throw new Error('A connected repository is required for commit-bound roadmap planning.');
    }
    const githubConnection = await readGitHubConnectionSecret(repository);
    if (!githubConnection) throw new Error('Connect GitHub before discovering the repository baseline for roadmap planning.');
    return prepareReadOnlyRepositoryBaseline(
      new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl }), project, signal
    );
  };
  const checkout = await discoverBaseline();
  try {
    const repositoryBaseline = { commitSha: checkout.commitSha, evidence: checkout.evidence };
    let session = createProjectPlanningSession(repository, project, connection);
    const existingRoadmap = await repository.getProjectRoadmap(project.id);
    const completedSteps = existingRoadmap?.steps.filter((step) => step.status === 'completed').map((step) => step.title) ?? [];
    const unfinishedSteps = selectUnfinishedRoadmapSteps(existingRoadmap, sourceContractVersionId);
    const sourceKey = await roadmapSourceKey(repository, project.id);
    const contextKey = createHash('sha256').update(JSON.stringify({
      sourceKey, objective, currentSpecification, currentContract, sourceContractVersionId, operation,
      repositoryCommitSha: repositoryBaseline?.commitSha,
      provider: connection.provider, model: connection.model, connectionId: connection.id
    })).digest('hex');
    const assertCurrentSource = async () => {
      if (await roadmapSourceKey(repository, project.id) !== sourceKey) {
        throw new Error('Project planning inputs changed during roadmap generation. Retry against the current specification and contract.');
      }
      {
        const current = await discoverBaseline();
        try {
          if (current.commitSha !== repositoryBaseline.commitSha) {
            throw new Error('Repository checkout changed during roadmap generation. Retry against the current commit.');
          }
        } finally { await current?.cleanup(); }
      }
    };
    const saveCheckpoint = async (checkpoint: RoadmapGenerationCheckpoint) => {
      await assertCurrentSource();
      await repository.saveRoadmapGenerationCheckpoint(project.id, contextKey, checkpoint);
    };
    const checkpoint = await repository.getRoadmapGenerationCheckpoint(project.id, contextKey);
    if (checkpoint) {
      signal?.throwIfAborted();
      await repository.writeAudit({
        actorType: 'system', eventType: 'project_roadmap_generation_resumed', projectId: project.id,
        payload: { contextKey, phase: checkpoint.phase, revision: checkpoint.revision }
      });
      return {
        plan: checkpoint.plan, provider, session, completedSteps, unfinishedSteps, repositoryBaseline,
        repositoryPath: checkout.repositoryPath, cleanup: checkout.cleanup, checkpoint, saveCheckpoint, assertCurrentSource
      };
    }
    const planInput = {
      taskId: project.id,
      title: `Project roadmap for ${project.name}`,
      prompt: buildRoadmapPlanningPrompt({
        project: currentSpecification ? { ...project, brief: currentSpecification } : project,
        objective,
        completedSteps,
        unfinishedSteps,
        continuation: Boolean(session.id),
        currentContract
      }),
      maxRuntimeMs: roadmapPlanningMaxRuntimeMs(),
      signal,
      repositoryPath: checkout?.repositoryPath,
      repositoryBaseline
    };
    let plan: PlanResult;
    try {
      signal?.throwIfAborted();
      plan = await provider.plan({ ...planInput, session });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof CodexExecutionTimeoutError) || !session.id) throw error;
      session = createProjectPlanningSession(repository, project, connection, true);
      plan = await provider.plan({ ...planInput, session });
    }
    const initial: RoadmapGenerationCheckpoint = { version: 1, phase: 'validate', revision: 0, plan };
    await saveCheckpoint(initial);
    return {
      plan, provider, session, completedSteps, unfinishedSteps, repositoryBaseline,
      repositoryPath: checkout.repositoryPath, cleanup: checkout.cleanup,
      checkpoint: initial, saveCheckpoint, assertCurrentSource
    };
  } catch (error) {
    await checkout.cleanup();
    throw error;
  }
}

function roadmapPlanningMaxRuntimeMs(): number {
  const configured = Number(process.env.FORGEMIND_ROADMAP_PLAN_MAX_RUNTIME_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.min(configured, 3_600_000)
    : 15 * 60_000;
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
  unfinishedSteps?: Array<{ title: string; requirementIds: string[] }>;
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
      input.unfinishedSteps?.length
        ? `Carry forward every unfinished work item below. It may be adapted or explicitly merged with another returned step, but all of its still-active requirement ids must remain covered:\n${input.unfinishedSteps.map((step) => `- ${step.title} [${step.requirementIds.join(', ')}]`).join('\n')}`
        : undefined,
      `Return projectContract as null and contractDelta with baseVersion ${input.currentContract.version}.`,
      'The delta must list every requirement addition, update, supersession, or removal explicitly. Every update, supersession, and removal requires a concrete rationale.',
      'Never replace the complete contract with a smaller topical contract. Requirements omitted from the delta remain active and unchanged.',
      'Preserve all unchanged active requirements. Include migrationImpacts and compatibilityImpacts, using empty arrays when there are none.',
      'Return implementationSteps needed to realize the delta and to finish all carried-forward work. Every added, updated, superseded, removed, or carried-forward active requirement must be referenced by at least one returned step.',
      'Every step must include a concrete changeRationale, dependsOnStepTitles referencing only earlier returned steps, and validationFocus. Include regression validation and add migration or compatibility validation when those impacts are declared.',
      'Every changeRationale must cite repository evidence for the concrete missing behavior and name existing components, modules, or interfaces that the implementation will reuse.',
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
      input.unfinishedSteps?.length
        ? `Unfinished implementation steps that must remain covered:\n${input.unfinishedSteps.map((step) => `- ${step.title} [${step.requirementIds.join(', ')}]`).join('\n')}`
        : undefined,
      '',
      'Return concrete implementation steps that can be executed one by one as individual engineering tasks in implementationSteps.',
      'Also return projectContract with version 1, summary, global invariants, prohibited substitutes, atomic requirements, and release criteria.',
      'Return contractDelta as null because this is a complete contract generation.',
      'For every projectContract requirement, include briefReferences with short phrases or section names that identify the source obligation in the supplied brief.',
      'Return architectureUpdate with the intended modules, their paths and public interfaces, allowed dependencies, conventions, decisions, known debt, and lightweight executable architecture validation commands that remain valid after every implementation step.',
      'Every requirement id must use REQ-UPPERCASE format and describe one independently verifiable product capability, not an implementation layer.',
      'Each implementationSteps item must contain title, a distinct implementation-focused description, acceptanceCriteria, inScope, outOfScope, requirementIds, and concrete deliverables.',
      'Each implementationSteps item must also contain changeRationale, dependsOnStepTitles, and validationFocus. Dependencies may reference only earlier step titles. validationFocus uses implementation, migration, compatibility, or regression.',
      'Every changeRationale must cite repository evidence for the concrete missing behavior and name existing components, modules, or interfaces that the implementation will reuse.',
      'Each implementation step must fit one focused pull request and cover at most three contract requirements. Split broad epics into multiple steps.',
      'Each implementation step may contain at most 3 deliverables, 5 acceptanceCriteria, and 5 inScope items.',
      'Every contract requirement must be referenced by at least one implementation step. Placeholder data, declarations, documentation, interfaces, or pass-valued evidence do not satisfy production capabilities unless explicitly required.',
      'Give every step only its own verifiable acceptance criteria. Do not copy project-wide acceptance criteria to every step.',
      'Steps must not overlap. Do not include work assigned to a later step, and do not recreate already completed capabilities.',
      'A documentation or scope-definition step must change documentation only and must not implement application code.',
      'Order dependencies explicitly so each task starts from the repository state produced by earlier tasks.'
    ].filter(Boolean).join('\n');
}

export function buildAuditGapReviewContract(
  current: ProjectContract,
  newRequirements: ProjectContract['requirements']
): ProjectContract {
  if (newRequirements.length === 0) return current;
  const requirementIds = new Set(current.requirements.map((requirement) => requirement.id));
  const nextVersion = current.version + 1;
  const additions = newRequirements.map((requirement) => {
    if (requirementIds.has(requirement.id)) {
      throw new Error(`Audit gap requirement "${requirement.id}" duplicates the current contract.`);
    }
    requirementIds.add(requirement.id);
    return {
      ...requirement,
      status: 'active' as const,
      introducedInVersion: nextVersion,
      lastChangedInVersion: nextVersion
    };
  });
  return { ...current, version: nextVersion, requirements: [...current.requirements, ...additions] };
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
  return normalizeProjectContractDelta(parsed);
}

function normalizeProjectContractDelta(parsed: z.infer<typeof projectContractDeltaPlanSchema>): ProjectContractDelta {
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
  previousContract?: ProjectContract,
  outputVersion?: number
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
    projectContract: withProjectContractSource({
      ...applied.contract,
      version: outputVersion ?? applied.contract.version
    }, source),
    contractDelta,
    touchedRequirementIds: applied.touchedRequirementIds
  };
}

export function collectRegeneratedRoadmapRequirementIds(
  projectContract: ProjectContract,
  touchedRequirementIds: string[],
  unfinishedSteps: Array<{ requirementIds: string[] }>
): string[] {
  const activeRequirementIds = new Set(activeProjectContractRequirements(projectContract).map((requirement) => requirement.id));
  return Array.from(new Set([
    ...touchedRequirementIds,
    ...unfinishedSteps.flatMap((step) => step.requirementIds).filter((requirementId) => activeRequirementIds.has(requirementId))
  ]));
}

export function selectUnfinishedRoadmapSteps(
  roadmap: {
    cycles: Array<{ id: string; contractVersionId?: string }>;
    steps: Array<{ cycleId: string; title: string; status: string; requirementIds: string[] }>;
  } | undefined,
  sourceContractVersionId?: string
): Array<{ title: string; requirementIds: string[] }> {
  if (!roadmap) return [];
  const sourceCycleIds = new Set(roadmap.cycles
    .filter((cycle) => !sourceContractVersionId || cycle.contractVersionId === sourceContractVersionId)
    .map((cycle) => cycle.id));
  return roadmap.steps
    .filter((step) => sourceCycleIds.has(step.cycleId) && step.status !== 'completed')
    .map((step) => ({ title: step.title, requirementIds: step.requirementIds }));
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

async function listProviderConnectionRuntimeStatuses(repository: ForgeMindRepository) {
  const maybeRepository = repository as ForgeMindRepository & {
    listProviderConnectionRuntimeStatuses?: ForgeMindRepository['listProviderConnectionRuntimeStatuses'];
  };
  return maybeRepository.listProviderConnectionRuntimeStatuses ? maybeRepository.listProviderConnectionRuntimeStatuses() : [];
}

function providerRuntimeStatusKey(provider: ProviderConnectionRuntimeStatus['provider'], connectionId: string | null): string {
  return `${provider}:${connectionId ?? 'env'}`;
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

function hashSpecificationText(specification: string): string {
  return createHash('sha256').update(specification).digest('hex');
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
