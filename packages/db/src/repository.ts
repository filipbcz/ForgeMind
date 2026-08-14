import {
  activeProjectContractRequirements,
  type AcceptanceEvidence,
  type AcceptanceEvidenceSource,
  type AcceptanceEvidenceStatus,
  assertTaskTransition,
  type Approval,
  type ApprovalStatus,
  type ApprovalType,
  type AuditEvent,
  type ForgeTask,
  type IterationPhase,
  type ProjectImplementationStep,
  type ProjectImplementationStepStatus,
  type ProjectAuditJob,
  type ProjectArchitecture,
  type ProjectArchitectureSnapshot,
  type ProjectArchitectureUpdate,
  type ProjectContract,
  type ProjectContractDelta,
  type ProjectContractRequirement,
  type ProjectContractSnapshot,
  type ProjectMemory,
  type ProjectValidationProfile,
  type ProjectRoadmapCycle,
  type ProjectRoadmapCycleStatus,
  type ProjectSpecificationSnapshot,
  type Project,
  type ProjectCapability,
  type ProviderKind,
  type RiskLevel,
  type TaskStatus,
  type TaskCheckpoint
} from '@forgemind/core';
import { createHash } from 'node:crypto';
import { parseAgentConfigYaml } from '@forgemind/config';
import type { JsonValue } from '@forgemind/shared';
import { Prisma } from '@prisma/client';
import type { AiProviderConnection, AuditLog, GitHubConnection, PrismaClient, ProjectAuditJobStatus, QueueJobStatus, TaskMode } from '@prisma/client';
import { decryptSecret, encryptSecret, fingerprintSecret } from './credentials.js';
import {
  toApproval,
  toAcceptanceEvidence,
  toAuditEvent,
  toPrismaJson,
  toProject,
  toProjectArchitectureVersion,
  toProjectContractVersion,
  toProjectAuditJob,
  toProjectImplementationStep,
  toProjectRoadmapCycle,
  toProjectSpecificationVersion,
  sanitizePostgresText,
  toTask,
  toTaskRun
} from './mappers.js';
import { composeApprovedExtensionSpecification } from './specification.js';

export const LOCAL_USER_ID = 'user_local_owner';

export interface UserSnapshot {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'operator';
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  githubOwner?: string;
  githubRepo?: string;
  defaultBranch: string;
  configYaml?: string;
  brief?: string;
  validationProfile?: ProjectValidationProfile;
  autoCreatePullRequest?: boolean;
  autoMergePullRequest?: boolean;
  autoCompleteTask?: boolean;
  allowSafeOperationsWithoutApproval?: boolean;
  defaultTaskMode?: TaskMode;
  aiProviderConnectionId?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  githubOwner?: string | null;
  githubRepo?: string | null;
  defaultBranch?: string;
  configYaml?: string;
  brief?: string | null;
  validationProfile?: ProjectValidationProfile | null;
  autoCreatePullRequest?: boolean;
  autoMergePullRequest?: boolean;
  autoCompleteTask?: boolean;
  allowSafeOperationsWithoutApproval?: boolean;
  defaultTaskMode?: TaskMode;
  aiProviderConnectionId?: string | null;
  isActive?: boolean;
}

export interface DeleteProjectResult {
  projectId: string;
  projectName: string;
  deletedTasks: number;
  deletedRuns: number;
  deletedRoadmapCycles: number;
  deletedRoadmapSteps: number;
}

export interface ProjectRoadmapSnapshot {
  projectId: string;
  cycles: ProjectRoadmapCycle[];
  steps: ProjectImplementationStep[];
  evidence: AcceptanceEvidence[];
  capabilities: ProjectCapability[];
  auditJobs: ProjectAuditJob[];
}

export interface ClaimedProjectAuditJob {
  job: ProjectAuditJob;
  project: Project;
  cycle: ProjectRoadmapCycle;
}

export interface RecordAcceptanceEvidenceInput {
  projectId: string;
  cycleId: string;
  stepId?: string;
  taskId?: string;
  taskRunId?: string;
  requirementIds: string[];
  criterion: string;
  source: AcceptanceEvidenceSource;
  status: AcceptanceEvidenceStatus;
  evidenceIdentity: string;
  contractVersion: number;
  commitSha?: string;
  command?: string;
  exitCode?: number;
  detailsUrl?: string;
  payload?: JsonValue;
}

export interface CreateProjectRoadmapCycleInput {
  projectId: string;
  objective: string;
  projectContract: ProjectContract;
  contractDelta?: ProjectContractDelta;
  contractChangeSummary?: string;
  architectureUpdate?: ProjectArchitectureUpdate;
  approvedExtension?: {
    sourceCycleId: string;
    changeSummary?: string;
  };
  steps: Array<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requirementIds: string[];
    deliverables: string[];
    changeRationale: string;
    dependsOnStepTitles: string[];
    validationFocus: ProjectImplementationStep['validationFocus'];
  }>;
}

export interface AppendProjectImplementationStepsInput {
  projectId: string;
  cycleId: string;
  newRequirements?: ProjectContractRequirement[];
  steps: Array<{
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requirementIds: string[];
    deliverables: string[];
    changeRationale: string;
    dependsOnStepTitles: string[];
    validationFocus: ProjectImplementationStep['validationFocus'];
  }>;
}

export interface GitHubConnectionSnapshot {
  userId: string;
  credentialSource: 'token';
  apiBaseUrl: string;
  tokenFingerprint: string;
  connectedAt: string;
  lastCheckedAt?: string;
  updatedAt: string;
}

export interface GitHubConnectionSecret extends GitHubConnectionSnapshot {
  token: string;
}

export type AIProviderConnectionKind = Extract<ProviderKind, 'openai' | 'codex' | 'github_copilot'>;
export type AIProviderAuthMode = 'api_key' | 'codex_oauth';

export interface AIProviderConnectionSnapshot {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  credentialSource: 'api_key' | 'codex_oauth';
  provider: AIProviderConnectionKind;
  authMode: AIProviderAuthMode;
  model: string;
  apiKeyFingerprint?: string;
  codexHome?: string;
  accountSummary?: string;
  connectedAt: string;
  lastCheckedAt?: string;
  updatedAt: string;
}

export interface AIProviderConnectionSecret extends AIProviderConnectionSnapshot {
  apiKey?: string;
}

export interface NotificationSettingsSnapshot {
  userId: string;
  settings: {
    pushEnabled: boolean;
    approvalRequests: boolean;
    taskUpdates: boolean;
    budgetAlerts: boolean;
  };
  subscriptions: NotificationSubscriptionSnapshot[];
}

export interface NotificationSubscriptionInput {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  deviceName?: string;
}

export interface NotificationSubscriptionSnapshot extends NotificationSubscriptionInput {
  id: string;
  userId: string;
  createdAt: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  maxIterations: number;
  maxBudgetUsd: number;
  architectureVersionId?: string;
}

export interface ClaimedTask {
  task: ForgeTask;
  project: Project;
  taskRun: ReturnType<typeof toTaskRun>;
  queueJobId?: string;
  queueReason?: string;
}

export interface TaskQueuePosition {
  queueDepth: number;
  queuePosition: number | null;
}

export interface WorkerQueueControlSnapshot {
  queuePaused: boolean;
  pausedAt?: string;
  updatedAt: string;
}

export interface QueueRecoveryResult {
  recoveredCount: number;
  queueJobIds: string[];
}

export interface WorkerStatusSnapshot {
  state: 'idle' | 'running';
  queuePaused: boolean;
  queuePausedAt?: string;
  queuedTaskCount: number;
  activeTaskCount: number;
  runningRun?: {
    id: string;
    taskId: string;
    provider: ProviderKind;
    model: string;
    startedAt?: string;
  };
  activeIteration?: {
    taskId: string;
    taskRunId?: string;
    phase: 'planning' | 'implementation' | 'validation' | 'review' | 'approval' | 'pr_creation';
    attempt: number;
    prompt: string;
    providerPrompt?: string;
    startedAt: string;
  };
  lastCompletedRun?: {
    id: string;
    taskId: string;
    provider: ProviderKind;
    model: string;
    finishedAt?: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    summary?: string;
    errorMessage?: string;
  };
  updatedAt: string;
}

export interface OperationalMetricsSnapshot {
  generatedAt: string;
  tasks: {
    total: number;
    draft: number;
    submitted: number;
    active: number;
    needsApproval: number;
    completed: number;
    failed: number;
    cancelled: number;
    providerFailed: number;
    budgetExceeded: number;
    iterationLimitReached: number;
    repeatedErrorDetected: number;
    validationFailed: number;
  };
  queue: {
    pending: number;
    claimed: number;
    failed: number;
    averagePendingWaitSeconds: number;
    maxPendingWaitSeconds: number;
  };
  approvals: {
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
  };
  runs: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    averageDurationSeconds: number;
    maxDurationSeconds: number;
  };
}

const WORKER_EVENT_PREFIXES = [
  'worker_queue_',
  'task_enqueued',
  'task_claimed',
  'task_status_',
  'task_github_',
  'task_iteration_',
  'task_activity',
  'task_provider_activity',
  'task_worker_interrupted',
  'task_failed',
  'project_audit_',
  'project_release_'
] as const;

const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'submitted',
  'planning',
  'creating_github_issue',
  'creating_branch',
  'running_ai',
  'validating',
  'reviewing',
  'improving',
  'creating_pr'
]);

const ACTIVE_QUEUE_STATUSES = ['pending', 'claimed'] as const;
const DEFAULT_QUEUE_MAX_ATTEMPTS = 3;
const DEFAULT_QUEUE_BACKOFF_SECONDS = 30;
const DEFAULT_AUDIT_JOB_MAX_ATTEMPTS = 3;
const WORKER_QUEUE_CONTROL_ID = 'global';
const WORKER_QUEUE_ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(742764962030481)::text AS "lock"';

interface WorkerQueueControlRow {
  queuePaused: boolean;
  pausedAt: Date | null;
  updatedAt: Date;
}

function isActiveQueueStatus(status: QueueJobStatus): status is (typeof ACTIVE_QUEUE_STATUSES)[number] {
  return status === 'pending' || status === 'claimed';
}

export class ForgeMindRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureLocalUser(): Promise<UserSnapshot> {
    const user = await this.prisma.user.upsert({
      where: { id: LOCAL_USER_ID },
      update: {},
      create: {
        id: LOCAL_USER_ID,
        email: 'owner@forgemind.local',
        name: 'Local Owner',
        role: 'owner'
      }
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };
  }

  async getCurrentUser(): Promise<UserSnapshot> {
    return this.ensureLocalUser();
  }

  async getGitHubConnection(userId = LOCAL_USER_ID): Promise<GitHubConnectionSnapshot | undefined> {
    const connection = await this.prisma.gitHubConnection.findUnique({
      where: { userId }
    });

    return connection ? toGitHubConnectionSnapshot(connection) : undefined;
  }

  async getGitHubConnectionSecret(userId = LOCAL_USER_ID): Promise<GitHubConnectionSecret | undefined> {
    const connection = await this.prisma.gitHubConnection.findUnique({
      where: { userId }
    });

    if (!connection) {
      return undefined;
    }

    return {
      ...toGitHubConnectionSnapshot(connection),
      token: await decryptSecret(connection.tokenCiphertext)
    };
  }

  async upsertGitHubConnection(input: { token: string; apiBaseUrl: string; userId?: string }): Promise<GitHubConnectionSnapshot> {
    const userId = input.userId ?? LOCAL_USER_ID;
    await this.ensureLocalUser();
    const now = new Date();
    const tokenCiphertext = await encryptSecret(input.token);
    const tokenFingerprint = fingerprintSecret(input.token);
    const connection = await this.prisma.gitHubConnection.upsert({
      where: { userId },
      update: {
        tokenCiphertext,
        tokenFingerprint,
        apiBaseUrl: input.apiBaseUrl,
        lastCheckedAt: now
      },
      create: {
        userId,
        tokenCiphertext,
        tokenFingerprint,
        apiBaseUrl: input.apiBaseUrl,
        lastCheckedAt: now
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'github_connection_saved',
      payload: {
        credentialSource: 'token',
        apiBaseUrl: connection.apiBaseUrl,
        tokenFingerprint: connection.tokenFingerprint
      }
    });

    return toGitHubConnectionSnapshot(connection);
  }

  async deleteGitHubConnection(userId = LOCAL_USER_ID): Promise<boolean> {
    const existing = await this.prisma.gitHubConnection.findUnique({
      where: { userId },
      select: { id: true, apiBaseUrl: true, tokenFingerprint: true }
    });

    if (!existing) {
      return false;
    }

    await this.prisma.gitHubConnection.delete({
      where: { userId }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'github_connection_deleted',
      payload: {
        apiBaseUrl: existing.apiBaseUrl,
        tokenFingerprint: existing.tokenFingerprint
      }
    });

    return true;
  }

  async listAIProviderConnections(userId = LOCAL_USER_ID): Promise<AIProviderConnectionSnapshot[]> {
    const connections = await this.prisma.aiProviderConnection.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
    });

    return connections.map(toAIProviderConnectionSnapshot);
  }

  async getAIProviderConnection(userId = LOCAL_USER_ID): Promise<AIProviderConnectionSnapshot | undefined> {
    const connection = await this.findDefaultAIProviderConnection(userId);
    return connection ? toAIProviderConnectionSnapshot(connection) : undefined;
  }

  async getAIProviderConnectionById(connectionId: string): Promise<AIProviderConnectionSnapshot | undefined> {
    const connection = await this.prisma.aiProviderConnection.findUnique({
      where: { id: connectionId }
    });

    return connection ? toAIProviderConnectionSnapshot(connection) : undefined;
  }

  async getAIProviderConnectionSecret(userId = LOCAL_USER_ID): Promise<AIProviderConnectionSecret | undefined> {
    const connection = await this.findDefaultAIProviderConnection(userId);
    return connection ? this.toAIProviderConnectionSecret(connection) : undefined;
  }

  async getAIProviderConnectionSecretById(connectionId: string): Promise<AIProviderConnectionSecret | undefined> {
    const connection = await this.prisma.aiProviderConnection.findUnique({
      where: { id: connectionId }
    });

    return connection ? this.toAIProviderConnectionSecret(connection) : undefined;
  }

  async upsertAIProviderConnection(input: {
    connectionId?: string;
    name?: string;
    isDefault?: boolean;
    provider: AIProviderConnectionKind;
    authMode?: AIProviderAuthMode;
    model: string;
    apiKey?: string;
    codexHome?: string;
    accountSummary?: string;
    userId?: string;
  }): Promise<AIProviderConnectionSnapshot> {
    const userId = input.userId ?? LOCAL_USER_ID;
    await this.ensureLocalUser();
    const now = new Date();
    const authMode = input.authMode ?? 'api_key';
    const existingConnection = input.connectionId
      ? await this.prisma.aiProviderConnection.findFirst({ where: { id: input.connectionId, userId } })
      : null;
    if (input.connectionId && !existingConnection) {
      throw new Error('AI provider connection was not found.');
    }
    if (authMode === 'api_key' && !input.apiKey && !existingConnection?.apiKeyCiphertext) {
      throw new Error('AI provider API key is required for api_key auth mode.');
    }

    const apiKeyCiphertext = input.apiKey ? await encryptSecret(input.apiKey) : existingConnection?.apiKeyCiphertext ?? null;
    const apiKeyFingerprint = input.apiKey ? fingerprintSecret(input.apiKey) : existingConnection?.apiKeyFingerprint ?? null;
    const existingCount = await this.prisma.aiProviderConnection.count({ where: { userId } });
    const isDefault = input.isDefault ?? existingConnection?.isDefault ?? existingCount === 0;
    const name = await this.resolveAIProviderConnectionName(userId, input.name ?? buildAIProviderConnectionName(input.provider, authMode, input.model), input.connectionId);
    const connection = await this.prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.aiProviderConnection.updateMany({
          where: { userId },
          data: { isDefault: false }
        });
      }

      if (input.connectionId) {
        return tx.aiProviderConnection.update({
          where: { id: input.connectionId },
          data: {
            userId,
            name,
            isDefault,
            provider: input.provider,
            authMode,
            model: input.model,
            apiKeyCiphertext,
            apiKeyFingerprint,
            codexHome: input.codexHome ?? existingConnection?.codexHome,
            accountSummary: input.accountSummary ?? existingConnection?.accountSummary,
            lastCheckedAt: now
          }
        });
      }

      return tx.aiProviderConnection.create({
        data: {
          userId,
          name,
          isDefault,
          provider: input.provider,
          authMode,
          model: input.model,
          apiKeyCiphertext,
          apiKeyFingerprint,
          codexHome: input.codexHome,
          accountSummary: input.accountSummary,
          lastCheckedAt: now
        }
      });
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'ai_provider_connection_saved',
      payload: {
        credentialSource: connection.authMode === 'codex_oauth' ? 'codex_oauth' : 'api_key',
        connectionId: connection.id,
        name: connection.name,
        isDefault: connection.isDefault,
        provider: connection.provider,
        authMode: connection.authMode,
        model: connection.model,
        apiKeyFingerprint: connection.apiKeyFingerprint ?? null,
        codexHome: connection.codexHome ?? null,
        accountSummary: connection.accountSummary ?? null
      }
    });

    return toAIProviderConnectionSnapshot(connection);
  }

  async deleteAIProviderConnection(connectionId: string, userId = LOCAL_USER_ID): Promise<boolean> {
    const existing = await this.prisma.aiProviderConnection.findFirst({
      where: { id: connectionId, userId },
      select: { id: true, name: true, provider: true, isDefault: true }
    });
    if (!existing) return false;

    await this.prisma.$transaction(async (tx) => {
      // Detach projects from this connection first so delete is safe on all DB constraints.
      await tx.project.updateMany({
        where: { aiProviderConnectionId: connectionId },
        data: { aiProviderConnectionId: null }
      });

      await tx.aiProviderConnection.delete({ where: { id: connectionId } });
    });

    if (existing.isDefault) {
      const next = await this.prisma.aiProviderConnection.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' }
      });
      if (next) {
        await this.prisma.aiProviderConnection.update({
          where: { id: next.id },
          data: { isDefault: true }
        });
      }
    }

    await this.writeAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'ai_provider_connection_deleted',
      payload: {
        connectionId,
        name: existing.name,
        provider: existing.provider
      }
    });

    return true;
  }

  private async findDefaultAIProviderConnection(userId: string): Promise<AiProviderConnection | null> {
    return this.prisma.aiProviderConnection.findFirst({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]
    });
  }

  private async toAIProviderConnectionSecret(connection: AiProviderConnection): Promise<AIProviderConnectionSecret> {
    return {
      ...toAIProviderConnectionSnapshot(connection),
      apiKey: connection.apiKeyCiphertext ? await decryptSecret(connection.apiKeyCiphertext) : undefined
    };
  }

  private async resolveAIProviderConnectionName(userId: string, requestedName: string, connectionId?: string): Promise<string> {
    const baseName = requestedName.trim() || 'AI provider';
    const existing = await this.prisma.aiProviderConnection.findMany({
      where: { userId },
      select: { id: true, name: true }
    });
    const names = new Set(existing.filter((connection) => connection.id !== connectionId).map((connection) => connection.name));
    if (!names.has(baseName)) {
      return baseName;
    }

    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${baseName} ${index}`;
      if (!names.has(candidate)) {
        return candidate;
      }
    }

    throw new Error('Unable to allocate a unique AI provider connection name.');
  }

  async listProjects(): Promise<Project[]> {
    const projects = await this.prisma.project.findMany({
      orderBy: { createdAt: 'asc' }
    });
    return projects.map(toProject);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    await this.ensureLocalUser();
    const autoCreatePullRequest = input.autoCreatePullRequest ?? true;
    const autoMergePullRequest = input.autoMergePullRequest ?? false;
    const autoCompleteTask = input.autoCompleteTask ?? false;
    if (autoMergePullRequest && !autoCreatePullRequest) {
      throw new Error('Automatic pull request creation is required for automatic merge.');
    }
    if (autoCompleteTask && !autoMergePullRequest) {
      throw new Error('Automatic merge is required for automatic task completion.');
    }
    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name: input.name,
          slug: input.slug,
          githubOwner: input.githubOwner,
          githubRepo: input.githubRepo,
          defaultBranch: input.defaultBranch,
          configYaml: input.configYaml,
          brief: input.brief,
          validationProfile: input.validationProfile ? toPrismaJson(input.validationProfile as unknown as JsonValue) : undefined,
          autoCreatePullRequest,
          autoMergePullRequest,
          autoCompleteTask,
          allowSafeOperationsWithoutApproval: input.allowSafeOperationsWithoutApproval,
          defaultTaskMode: input.defaultTaskMode,
          aiProviderConnectionId: input.aiProviderConnectionId
        }
      });

      await tx.projectSpecificationVersion.create({
        data: {
          projectId: created.id,
          version: 1,
          fullSpecification: input.brief?.trim() || input.name.trim(),
          changeSummary: 'Initial project brief.',
          source: 'initial_brief',
          approvedAt: created.createdAt
        }
      });

      await this.writeAuditTx(tx, {
        actorType: 'user',
        actorId: LOCAL_USER_ID,
        eventType: 'project_created',
        projectId: created.id,
        payload: { slug: created.slug, specificationVersion: 1 }
      });

      return created;
    });

    return toProject(project);
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    return project ? toProject(project) : undefined;
  }

  async getProjectSpecifications(projectId: string): Promise<ProjectSpecificationSnapshot | undefined> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true }
    });
    if (!project) return undefined;

    const specifications = await this.prisma.projectSpecificationVersion.findMany({
      where: { projectId },
      orderBy: [{ version: 'asc' }, { createdAt: 'asc' }]
    });
    if (specifications.length === 0) {
      throw new Error(`Project "${projectId}" has no specification version.`);
    }

    const versions = specifications.map(toProjectSpecificationVersion);
    return {
      projectId,
      current: versions.at(-1)!,
      versions
    };
  }

  async getProjectContracts(projectId: string): Promise<ProjectContractSnapshot | undefined> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, currentContractVersionId: true }
    });
    if (!project) return undefined;

    const records = await this.prisma.projectContractVersion.findMany({
      where: { projectId },
      orderBy: [{ version: 'asc' }, { createdAt: 'asc' }]
    });
    const versions = records.map(toProjectContractVersion);
    const current = project.currentContractVersionId
      ? versions.find((version) => version.id === project.currentContractVersionId)
      : versions.at(-1);
    return { projectId, current, versions };
  }

  async getProjectArchitectures(projectId: string): Promise<ProjectArchitectureSnapshot | undefined> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, currentArchitectureVersionId: true }
    });
    if (!project) return undefined;

    const records = await this.prisma.projectArchitectureVersion.findMany({
      where: { projectId },
      orderBy: [{ version: 'asc' }, { createdAt: 'asc' }]
    });
    const versions = records.map(toProjectArchitectureVersion);
    const current = project.currentArchitectureVersionId
      ? versions.find((version) => version.id === project.currentArchitectureVersionId)
      : versions.at(-1);
    return { projectId, current, versions };
  }

  async updateProject(projectId: string, input: UpdateProjectInput): Promise<Project | undefined> {
    const existing = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!existing) return undefined;

    const autoCreatePullRequest = input.autoCreatePullRequest ?? existing.autoCreatePullRequest;
    const autoMergePullRequest = input.autoMergePullRequest ?? existing.autoMergePullRequest;
    const autoCompleteTask = input.autoCompleteTask ?? existing.autoCompleteTask;
    const allowSafeOperationsWithoutApproval = input.allowSafeOperationsWithoutApproval ?? existing.allowSafeOperationsWithoutApproval;
    const defaultTaskMode = input.defaultTaskMode ?? existing.defaultTaskMode;
    if (autoMergePullRequest && !autoCreatePullRequest) {
      throw new Error('Automatic pull request creation is required for automatic merge.');
    }
    if (autoCompleteTask && !autoMergePullRequest) {
      throw new Error('Automatic merge is required for automatic task completion.');
    }
    const invalidateProjectContext = shouldInvalidateProjectContract(existing.brief, input.brief);
    const invalidatePlanningSession = invalidateProjectContext
      || (input.aiProviderConnectionId !== undefined && input.aiProviderConnectionId !== existing.aiProviderConnectionId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.project.update({
        where: { id: projectId },
        data: {
          name: input.name,
          slug: input.slug,
          githubOwner: input.githubOwner,
          githubRepo: input.githubRepo,
          defaultBranch: input.defaultBranch,
          configYaml: input.configYaml,
          brief: input.brief,
          validationProfile: input.validationProfile === null
            ? Prisma.DbNull
            : input.validationProfile ? toPrismaJson(input.validationProfile as unknown as JsonValue) : undefined,
          projectContract: invalidateProjectContext ? Prisma.DbNull : undefined,
          currentContractVersionId: invalidateProjectContext ? null : undefined,
          projectMemory: invalidateProjectContext ? Prisma.DbNull : undefined,
          projectArchitecture: invalidateProjectContext ? Prisma.DbNull : undefined,
          planningSessionId: invalidatePlanningSession ? null : undefined,
          planningSessionProvider: invalidatePlanningSession ? null : undefined,
          planningSessionModel: invalidatePlanningSession ? null : undefined,
          planningSessionConnectionId: invalidatePlanningSession ? null : undefined,
          planningSessionUpdatedAt: invalidatePlanningSession ? null : undefined,
          autoCreatePullRequest,
          autoMergePullRequest,
          autoCompleteTask,
          allowSafeOperationsWithoutApproval,
          defaultTaskMode,
          aiProviderConnectionId: input.aiProviderConnectionId,
          isActive: input.isActive
        }
      });

      if (invalidateProjectContext) {
        const currentSpecification = await tx.projectSpecificationVersion.findFirst({
          where: { projectId },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
        });
        await tx.projectSpecificationVersion.create({
          data: {
            projectId,
            version: (currentSpecification?.version ?? 0) + 1,
            fullSpecification: input.brief?.trim() || result.name.trim(),
            changeSummary: input.brief?.trim()
              ? 'Project brief updated by user.'
              : 'Project brief cleared by user.',
            source: 'manual_revision',
            parentVersionId: currentSpecification?.id,
            approvedAt: new Date()
          }
        });
      }

      await this.writeAuditTx(tx, {
        actorType: 'user',
        actorId: LOCAL_USER_ID,
        eventType: 'project_updated',
        projectId: result.id,
        payload: {
          name: result.name,
          slug: result.slug,
          githubOwner: result.githubOwner,
          githubRepo: result.githubRepo,
          defaultBranch: result.defaultBranch,
          autoCreatePullRequest: result.autoCreatePullRequest,
          autoMergePullRequest: result.autoMergePullRequest,
          autoCompleteTask: result.autoCompleteTask,
          allowSafeOperationsWithoutApproval: result.allowSafeOperationsWithoutApproval,
          defaultTaskMode: result.defaultTaskMode,
          aiProviderConnectionId: result.aiProviderConnectionId,
          isActive: result.isActive,
          hasConfigYaml: Boolean(result.configYaml),
          hasBrief: Boolean(result.brief),
          validationProfileEnabled: toProject(result).validationProfile?.enabled ?? false,
          specificationRevised: invalidateProjectContext
        }
      });

      return result;
    });

    return toProject(updated);
  }

  async assertProjectDeletable(projectId: string): Promise<void> {
    const [activeTaskCount, activeQueueJobCount] = await Promise.all([
      this.prisma.task.count({
        where: {
          projectId,
          status: { in: [...ACTIVE_TASK_STATUSES] }
        }
      }),
      this.prisma.taskQueueJob.count({
        where: {
          task: { projectId },
          status: { in: [...ACTIVE_QUEUE_STATUSES] }
        }
      })
    ]);
    if (activeTaskCount > 0 || activeQueueJobCount > 0) {
      throw new Error('Project has active or queued tasks. Cancel them before deleting the project.');
    }
  }

  async deleteProject(
    projectId: string,
    input: { githubRepositoryDeleted?: boolean } = {}
  ): Promise<DeleteProjectResult | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, slug: true, githubOwner: true, githubRepo: true }
      });
      if (!project) return undefined;

      const [activeTaskCount, activeQueueJobCount] = await Promise.all([
        tx.task.count({
          where: {
            projectId,
            status: { in: [...ACTIVE_TASK_STATUSES] }
          }
        }),
        tx.taskQueueJob.count({
          where: {
            task: { projectId },
            status: { in: [...ACTIVE_QUEUE_STATUSES] }
          }
        })
      ]);
      if (activeTaskCount > 0 || activeQueueJobCount > 0) {
        throw new Error('Project has active or queued tasks. Cancel them before deleting the project.');
      }

      const taskIds = (await tx.task.findMany({
        where: { projectId },
        select: { id: true }
      })).map((task) => task.id);
      const runIds = taskIds.length > 0
        ? (await tx.taskRun.findMany({
            where: { taskId: { in: taskIds } },
            select: { id: true }
          })).map((run) => run.id)
        : [];

      await tx.auditLog.deleteMany({
        where: {
          OR: [
            { projectId },
            ...(taskIds.length > 0 ? [{ taskId: { in: taskIds } }] : [])
          ]
        }
      });
      if (taskIds.length > 0) {
        await tx.providerUsage.deleteMany({ where: { taskId: { in: taskIds } } });
        await tx.approval.deleteMany({ where: { taskId: { in: taskIds } } });
        await tx.taskQueueJob.deleteMany({ where: { taskId: { in: taskIds } } });
      }
      if (runIds.length > 0) {
        await tx.taskIteration.deleteMany({ where: { taskRunId: { in: runIds } } });
      }

      const roadmapSteps = await tx.projectImplementationStep.deleteMany({ where: { projectId } });
      const runs = taskIds.length > 0
        ? await tx.taskRun.deleteMany({ where: { taskId: { in: taskIds } } })
        : { count: 0 };
      const tasks = await tx.task.deleteMany({ where: { projectId } });
      const roadmapCycles = await tx.projectRoadmapCycle.deleteMany({ where: { projectId } });
      await tx.project.delete({ where: { id: projectId } });

      await this.writeAuditTx(tx, {
        actorType: 'user',
        actorId: LOCAL_USER_ID,
        eventType: 'project_deleted',
        payload: {
          projectId: project.id,
          projectName: project.name,
          slug: project.slug,
          githubRepository: project.githubOwner && project.githubRepo
            ? `${project.githubOwner}/${project.githubRepo}`
            : null,
          githubRepositoryDeleted: input.githubRepositoryDeleted ?? false,
          deletedTasks: tasks.count,
          deletedRuns: runs.count,
          deletedRoadmapCycles: roadmapCycles.count,
          deletedRoadmapSteps: roadmapSteps.count
        }
      });

      return {
        projectId: project.id,
        projectName: project.name,
        deletedTasks: tasks.count,
        deletedRuns: runs.count,
        deletedRoadmapCycles: roadmapCycles.count,
        deletedRoadmapSteps: roadmapSteps.count
      };
    }, { timeout: 30_000 });
  }

  async getProjectConfig(projectId: string): Promise<{ projectId: string; configYaml: string | null } | undefined> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, configYaml: true }
    });

    if (!project) return undefined;

    return {
      projectId: project.id,
      configYaml: project.configYaml
    };
  }

  async updateProjectConfig(projectId: string, configYaml: string): Promise<{ projectId: string; configYaml: string | null } | undefined> {
    const existing = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!existing) return undefined;

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { configYaml }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'project_config_updated',
      projectId: updated.id,
      payload: { hasConfigYaml: Boolean(updated.configYaml) }
    });

    return {
      projectId: updated.id,
      configYaml: updated.configYaml
    };
  }

  async getProjectRoadmap(projectId: string): Promise<ProjectRoadmapSnapshot | undefined> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId }
    });
    if (!project) return undefined;

    const [cycles, steps, evidence, auditJobs] = await Promise.all([
      this.prisma.projectRoadmapCycle.findMany({
        where: { projectId },
        orderBy: [{ cycleNumber: 'asc' }, { createdAt: 'asc' }]
      }),
      this.prisma.projectImplementationStep.findMany({
        where: { projectId },
        orderBy: [{ cycle: { cycleNumber: 'asc' } }, { sequenceNumber: 'asc' }, { createdAt: 'asc' }]
      }),
      this.prisma.acceptanceEvidence.findMany({
        where: { projectId },
        orderBy: [{ createdAt: 'asc' }]
      }),
      this.prisma.projectAuditJob.findMany({
        where: { projectId },
        orderBy: [{ createdAt: 'asc' }]
      })
    ]);

    const mappedSteps = steps.map(toProjectImplementationStep);
    const mappedEvidence = evidence.map(toAcceptanceEvidence);
    const mappedProject = toProject(project);

    return {
      projectId,
      cycles: cycles.map(toProjectRoadmapCycle),
      steps: mappedSteps,
      evidence: mappedEvidence,
      auditJobs: auditJobs.map(toProjectAuditJob),
      capabilities: deriveProjectCapabilities(mappedProject, cycles.map(toProjectRoadmapCycle), mappedSteps, mappedEvidence)
    };
  }

  async createProjectRoadmapCycle(input: CreateProjectRoadmapCycleInput): Promise<ProjectRoadmapSnapshot> {
    await this.ensureLocalUser();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
        const project = await tx.project.findUnique({ where: { id: input.projectId } });
        if (!project) {
          throw new Error(`Project "${input.projectId}" does not exist`);
        }

        if (!input.approvedExtension && await tx.projectRoadmapCycle.count({ where: { projectId: input.projectId } }) > 0) {
          const [activeTaskCount, runningStepCount, activeAuditCount] = await Promise.all([
            tx.task.count({ where: { projectId: input.projectId, status: { in: [...ACTIVE_TASK_STATUSES] } } }),
            tx.projectImplementationStep.count({ where: { projectId: input.projectId, status: 'running' } }),
            tx.projectAuditJob.count({ where: { projectId: input.projectId, status: { in: ['pending', 'claimed'] } } })
          ]);
          if (activeTaskCount > 0 || runningStepCount > 0 || activeAuditCount > 0) {
            throw new Error('Roadmap cannot be regenerated while the project has an active task, running implementation step, or project audit.');
          }
        }

        if (input.approvedExtension) {
          const existingSpecification = await tx.projectSpecificationVersion.findUnique({
            where: { sourceCycleId: input.approvedExtension.sourceCycleId }
          });
          if (existingSpecification) {
            if (existingSpecification.projectId !== input.projectId) {
              throw new Error('Approved extension belongs to another project.');
            }
            return;
          }

          const sourceCycle = await tx.projectRoadmapCycle.findUnique({
            where: { id: input.approvedExtension.sourceCycleId }
          });
          if (!sourceCycle || sourceCycle.projectId !== input.projectId) {
            throw new Error('Approved extension source cycle does not exist in this project.');
          }
          if (sourceCycle.status !== 'awaiting_extension_approval') {
            throw new Error(`Roadmap cycle "${sourceCycle.id}" is not awaiting extension approval.`);
          }
        }

        let specificationVersion = await tx.projectSpecificationVersion.findFirst({
          where: { projectId: input.projectId },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
        });
        if (!specificationVersion) {
          specificationVersion = await tx.projectSpecificationVersion.create({
            data: {
              projectId: input.projectId,
              version: 1,
              fullSpecification: project.brief?.trim() || project.name.trim(),
              changeSummary: 'Initial project brief.',
              source: 'initial_brief',
              approvedAt: project.createdAt
            }
          });
        }

        if (input.approvedExtension) {
          specificationVersion = await tx.projectSpecificationVersion.create({
            data: {
              projectId: input.projectId,
              version: specificationVersion.version + 1,
              fullSpecification: composeApprovedExtensionSpecification(
                specificationVersion.fullSpecification,
                input.objective
              ),
              changeSummary: input.approvedExtension.changeSummary?.trim()
                || `Approved extension following cycle ${input.approvedExtension.sourceCycleId}.`,
              source: 'approved_extension',
              parentVersionId: specificationVersion.id,
              sourceCycleId: input.approvedExtension.sourceCycleId,
              approvedAt: new Date()
            }
          });
        }

        const currentContractVersion = await tx.projectContractVersion.findFirst({
          where: { projectId: input.projectId },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
        });
        const expectedContractVersion = (currentContractVersion?.version ?? 0) + 1;
        if (input.projectContract.version !== expectedContractVersion) {
          throw new Error(
            `Project contract version ${input.projectContract.version} is invalid; expected ${expectedContractVersion}.`
          );
        }
        const contractVersion = await tx.projectContractVersion.create({
          data: {
            projectId: input.projectId,
            specificationVersionId: specificationVersion.id,
            version: input.projectContract.version,
            contractJson: toPrismaJson(input.projectContract as unknown as JsonValue),
            contractDelta: input.contractDelta
              ? toPrismaJson(input.contractDelta as unknown as JsonValue)
              : undefined,
            changeSummary: input.contractChangeSummary?.trim()
              || (input.approvedExtension ? 'Approved project contract extension.' : 'Generated project contract.'),
            source: input.approvedExtension
              ? 'approved_extension'
              : currentContractVersion
                ? 'manual_regeneration'
                : 'initial_plan',
            parentVersionId: currentContractVersion?.id
          }
        });

        const currentArchitectureVersion = await tx.projectArchitectureVersion.findFirst({
          where: { projectId: input.projectId },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
        });
        const architecture = input.architectureUpdate
          ? mergeProjectArchitecture(toProject(project).projectArchitecture, input.architectureUpdate)
          : toProject(project).projectArchitecture;
        const architectureVersion = architecture && input.architectureUpdate
          ? await tx.projectArchitectureVersion.create({
              data: {
                projectId: input.projectId,
                version: (currentArchitectureVersion?.version ?? 0) + 1,
                architectureJson: toPrismaJson(architecture as unknown as JsonValue),
                architectureUpdate: toPrismaJson(input.architectureUpdate as unknown as JsonValue),
                changeSummary: input.architectureUpdate.summary?.trim()
                  || (input.approvedExtension ? 'Architecture updated for approved extension.' : 'Initial project architecture.'),
                source: input.approvedExtension ? 'approved_extension' : 'initial_plan',
                parentVersionId: currentArchitectureVersion?.id,
                contractVersionId: contractVersion.id
              }
            })
          : currentArchitectureVersion;

        await tx.project.update({
          where: { id: input.projectId },
          data: {
            projectContract: toPrismaJson(input.projectContract as unknown as JsonValue),
            currentContractVersionId: contractVersion.id,
            projectArchitecture: architecture
              ? toPrismaJson(architecture as unknown as JsonValue)
              : undefined,
            currentArchitectureVersionId: architectureVersion?.id
          }
        });

        await tx.projectRoadmapCycle.updateMany({
          where: {
            projectId: input.projectId,
            status: { in: ['active', 'verifying', 'partial', 'blocked', 'awaiting_extension_approval'] }
          },
          data: {
            status: 'completed',
            completedAt: new Date()
          }
        });

        const cycleAggregate = await tx.projectRoadmapCycle.aggregate({
          where: { projectId: input.projectId },
          _max: { cycleNumber: true }
        });

        const cycle = await tx.projectRoadmapCycle.create({
          data: {
            projectId: input.projectId,
            cycleNumber: (cycleAggregate._max.cycleNumber ?? 0) + 1,
            objective: input.objective,
            specificationVersionId: specificationVersion.id,
            contractVersionId: contractVersion.id,
            architectureVersionId: architectureVersion?.id,
            status: 'active'
          }
        });

        if (input.steps.length > 0) {
          await tx.projectImplementationStep.createMany({
            data: input.steps.map((step, index) => ({
              projectId: input.projectId,
              cycleId: cycle.id,
              sequenceNumber: index + 1,
              title: step.title,
              description: step.description,
              acceptanceCriteria: toPrismaJson(step.acceptanceCriteria),
              requirementIds: toPrismaJson(step.requirementIds),
              deliverables: toPrismaJson(step.deliverables),
              changeRationale: step.changeRationale,
              dependsOnStepTitles: toPrismaJson(step.dependsOnStepTitles),
              validationFocus: toPrismaJson(step.validationFocus),
              status: 'pending'
            }))
          });
        }

        await this.writeAuditTx(tx, {
          actorType: 'user',
          actorId: LOCAL_USER_ID,
          eventType: 'project_roadmap_cycle_created',
          projectId: input.projectId,
          payload: {
            objective: input.objective,
            stepCount: input.steps.length,
            contractVersion: input.projectContract.version,
            contractVersionId: contractVersion.id,
            requirementCount: input.projectContract.requirements.length,
            specificationVersion: specificationVersion.version,
            architectureVersion: architectureVersion?.version ?? null,
            ...(input.approvedExtension
              ? { approvedExtensionSourceCycleId: input.approvedExtension.sourceCycleId }
              : {})
          }
        });
      });
    } catch (error) {
      if (input.approvedExtension && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingSpecification = await this.prisma.projectSpecificationVersion.findUnique({
          where: { sourceCycleId: input.approvedExtension.sourceCycleId }
        });
        if (existingSpecification?.projectId === input.projectId) {
          return (await this.getProjectRoadmap(input.projectId))!;
        }
      }
      throw error;
    }

    return (await this.getProjectRoadmap(input.projectId))!;
  }

  async assertProjectRoadmapRegenerationAllowed(projectId: string): Promise<void> {
    const cycleCount = await this.prisma.projectRoadmapCycle.count({ where: { projectId } });
    if (cycleCount === 0) return;
    const [activeTaskCount, runningStepCount, activeAuditCount] = await Promise.all([
      this.prisma.task.count({ where: { projectId, status: { in: [...ACTIVE_TASK_STATUSES] } } }),
      this.prisma.projectImplementationStep.count({ where: { projectId, status: 'running' } }),
      this.prisma.projectAuditJob.count({ where: { projectId, status: { in: ['pending', 'claimed'] } } })
    ]);
    if (activeTaskCount > 0 || runningStepCount > 0 || activeAuditCount > 0) {
      throw new Error('Roadmap cannot be regenerated while the project has an active task, running implementation step, or project audit.');
    }
  }

  async setProjectRoadmapCycleExtensionProposal(
    cycleId: string,
    input: { proposal: string; status?: ProjectRoadmapCycleStatus }
  ): Promise<ProjectRoadmapCycle | undefined> {
    const existing = await this.prisma.projectRoadmapCycle.findUnique({ where: { id: cycleId } });
    if (!existing) return undefined;

    const updated = await this.prisma.projectRoadmapCycle.update({
      where: { id: cycleId },
      data: {
        extensionProposal: input.proposal,
        status: input.status ?? 'awaiting_extension_approval'
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'project_roadmap_extension_proposed',
      projectId: updated.projectId,
      payload: {
        cycleId: updated.id,
        status: updated.status
      }
    });

    return toProjectRoadmapCycle(updated);
  }

  async updateProjectRoadmapCycleStatus(cycleId: string, status: ProjectRoadmapCycleStatus): Promise<ProjectRoadmapCycle | undefined> {
    const existing = await this.prisma.projectRoadmapCycle.findUnique({ where: { id: cycleId } });
    if (!existing) return undefined;

    const updated = await this.prisma.projectRoadmapCycle.update({
      where: { id: cycleId },
      data: {
        status,
        completedAt: status === 'completed' ? new Date() : null
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'project_roadmap_cycle_status_updated',
      projectId: updated.projectId,
      payload: {
        cycleId: updated.id,
        status: updated.status
      }
    });

    return toProjectRoadmapCycle(updated);
  }

  async listProjectImplementationSteps(projectId: string): Promise<ProjectImplementationStep[]> {
    const steps = await this.prisma.projectImplementationStep.findMany({
      where: { projectId },
      orderBy: [{ cycle: { cycleNumber: 'asc' } }, { sequenceNumber: 'asc' }, { createdAt: 'asc' }]
    });
    return steps.map(toProjectImplementationStep);
  }

  async getProjectImplementationStep(stepId: string): Promise<ProjectImplementationStep | undefined> {
    const step = await this.prisma.projectImplementationStep.findUnique({ where: { id: stepId } });
    return step ? toProjectImplementationStep(step) : undefined;
  }

  async getImplementationStepByTaskId(taskId: string): Promise<ProjectImplementationStep | undefined> {
    const step = await this.prisma.projectImplementationStep.findUnique({ where: { taskId } });
    return step ? toProjectImplementationStep(step) : undefined;
  }

  async getNextPendingImplementationStep(projectId: string, cycleId: string): Promise<ProjectImplementationStep | undefined> {
    const step = await this.prisma.projectImplementationStep.findFirst({
      where: {
        projectId,
        cycleId,
        status: 'pending'
      },
      orderBy: [{ sequenceNumber: 'asc' }, { createdAt: 'asc' }]
    });
    return step ? toProjectImplementationStep(step) : undefined;
  }

  async appendProjectImplementationSteps(input: AppendProjectImplementationStepsInput): Promise<ProjectImplementationStep[]> {
    if (input.steps.length === 0) return [];

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
      const [project, cycle, existingSteps] = await Promise.all([
        tx.project.findUnique({ where: { id: input.projectId } }),
        tx.projectRoadmapCycle.findUnique({ where: { id: input.cycleId } }),
        tx.projectImplementationStep.findMany({
          where: { cycleId: input.cycleId },
          orderBy: { sequenceNumber: 'asc' }
        })
      ]);
      if (!project?.projectContract || !cycle || cycle.projectId !== input.projectId) {
        throw new Error('Gap work items reference an unknown project contract or roadmap cycle.');
      }

      const contract = toProject(project).projectContract;
      if (!contract) throw new Error('Project contract is required for gap work items.');
      const newRequirements = input.newRequirements ?? [];
      const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id));
      for (const [index, requirement] of newRequirements.entries()) {
        const briefReferences = requirement.briefReferences?.map((item) => item.trim()).filter(Boolean) ?? [];
        if (
          !/^REQ-[A-Z0-9-]+$/.test(requirement.id)
          || requirementIds.has(requirement.id)
          || !requirement.title.trim()
          || !requirement.description.trim()
          || requirement.acceptanceCriteria.length === 0
          || briefReferences.length === 0
        ) {
          throw new Error(`Gap contract amendment at position ${index + 1} is invalid or duplicates an existing requirement.`);
        }
        requirementIds.add(requirement.id);
      }
      const existingKeys = new Set(existingSteps.map((step) => implementationStepIdentity({
        title: step.title,
        requirementIds: jsonStringArray(step.requirementIds),
        deliverables: jsonStringArray(step.deliverables)
      })));
      const uniqueSteps = input.steps.filter((step) => {
        if (step.requirementIds.length === 0 || step.requirementIds.some((id) => !requirementIds.has(id))) {
          throw new Error(`Gap work item "${step.title}" has invalid requirement traceability.`);
        }
        const key = implementationStepIdentity(step);
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });
      if (uniqueSteps.length === 0) return [];

      if (newRequirements.length > 0) {
        const currentContractVersion = await tx.projectContractVersion.findFirst({
          where: { projectId: input.projectId },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
        });
        if (!currentContractVersion) {
          throw new Error('A persisted project contract version is required before adding audit gap requirements.');
        }
        const nextVersion = currentContractVersion.version + 1;
        const normalizedNewRequirements: ProjectContractRequirement[] = newRequirements.map((requirement) => ({
          id: requirement.id.trim(),
          title: requirement.title.trim(),
          description: requirement.description.trim(),
          acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean),
          briefReferences: requirement.briefReferences?.map((reference) => reference.trim()).filter(Boolean),
          status: 'active',
          introducedInVersion: nextVersion,
          lastChangedInVersion: nextVersion
        }));
        const amendedContract: ProjectContract = {
          ...contract,
          version: nextVersion,
          requirements: [...contract.requirements, ...normalizedNewRequirements]
        };
        const contractDelta: ProjectContractDelta = {
          baseVersion: contract.version,
          summary: 'Added requirements discovered by the repository capability audit.',
          addRequirements: normalizedNewRequirements.map((requirement) => ({
            id: requirement.id,
            title: requirement.title,
            description: requirement.description,
            acceptanceCriteria: requirement.acceptanceCriteria,
            briefReferences: requirement.briefReferences
          })),
          updateRequirements: [],
          supersedeRequirements: [],
          removeRequirements: [],
          invariantChanges: { add: [], remove: [] },
          prohibitedSubstituteChanges: { add: [], remove: [] },
          releaseCriteriaChanges: { add: [], remove: [] },
          migrationImpacts: [],
          compatibilityImpacts: []
        };
        const contractVersion = await tx.projectContractVersion.create({
          data: {
            projectId: input.projectId,
            specificationVersionId: cycle.specificationVersionId,
            version: nextVersion,
            contractJson: toPrismaJson(amendedContract as unknown as JsonValue),
            contractDelta: toPrismaJson(contractDelta as unknown as JsonValue),
            changeSummary: contractDelta.summary!,
            source: 'manual_regeneration',
            parentVersionId: currentContractVersion.id
          }
        });
        await tx.project.update({
          where: { id: input.projectId },
          data: {
            projectContract: toPrismaJson(amendedContract as unknown as JsonValue),
            currentContractVersionId: contractVersion.id
          }
        });
        await tx.projectRoadmapCycle.update({
          where: { id: input.cycleId },
          data: { contractVersionId: contractVersion.id }
        });
      }

      const firstPendingSequence = existingSteps.find((step) => step.status === 'pending')?.sequenceNumber;
      const firstSequenceNumber = firstPendingSequence ?? ((existingSteps.at(-1)?.sequenceNumber ?? 0) + 1);
      if (firstPendingSequence !== undefined) {
        const shiftedSteps = existingSteps
          .filter((step) => step.sequenceNumber >= firstPendingSequence)
          .sort((left, right) => right.sequenceNumber - left.sequenceNumber);
        for (const step of shiftedSteps) {
          await tx.projectImplementationStep.update({
            where: { id: step.id },
            data: { sequenceNumber: step.sequenceNumber + uniqueSteps.length }
          });
        }
      }
      const invalidatedRequirementIds = Array.from(new Set(uniqueSteps.flatMap((step) => step.requirementIds)));
      await tx.acceptanceEvidence.deleteMany({
        where: {
          cycleId: input.cycleId,
          source: 'repository_audit',
          OR: [
            { requirementId: { in: invalidatedRequirementIds } },
            { criterion: { startsWith: 'Release: ' } }
          ]
        }
      });
      const created: ProjectImplementationStep[] = [];
      for (const [index, step] of uniqueSteps.entries()) {
        const record = await tx.projectImplementationStep.create({
          data: {
            projectId: input.projectId,
            cycleId: input.cycleId,
            sequenceNumber: firstSequenceNumber + index,
            title: step.title,
            description: step.description,
            acceptanceCriteria: toPrismaJson(step.acceptanceCriteria),
            requirementIds: toPrismaJson(step.requirementIds),
            deliverables: toPrismaJson(step.deliverables),
            changeRationale: step.changeRationale,
            dependsOnStepTitles: toPrismaJson(step.dependsOnStepTitles),
            validationFocus: toPrismaJson(step.validationFocus),
            status: 'pending'
          }
        });
        created.push(toProjectImplementationStep(record));
      }

      await tx.projectRoadmapCycle.update({
        where: { id: input.cycleId },
        data: { status: 'active', completedAt: null }
      });
      await this.writeAuditTx(tx, {
        actorType: 'agent',
        eventType: 'project_audit_gap_steps_created',
        projectId: input.projectId,
        payload: {
          cycleId: input.cycleId,
          stepIds: created.map((step) => step.id),
          newRequirementIds: newRequirements.map((requirement) => requirement.id)
        }
      });
      return created;
    });
  }

  async assignTaskToImplementationStep(
    stepId: string,
    taskId: string,
    status: ProjectImplementationStepStatus = 'running'
  ): Promise<ProjectImplementationStep | undefined> {
    const existing = await this.prisma.projectImplementationStep.findUnique({ where: { id: stepId } });
    if (!existing) return undefined;

    const updated = await this.prisma.projectImplementationStep.update({
      where: { id: stepId },
      data: {
        taskId,
        status,
        completedAt: status === 'completed' ? new Date() : null
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'project_implementation_step_task_assigned',
      projectId: updated.projectId,
      taskId,
      payload: {
        stepId: updated.id,
        status: updated.status
      }
    });

    return toProjectImplementationStep(updated);
  }

  async createAndStartRoadmapStepTask(
    stepId: string,
    input: CreateTaskInput
  ): Promise<ForgeTask | undefined> {
    await this.ensureLocalUser();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
      const step = await tx.projectImplementationStep.findFirst({
        where: {
          id: stepId,
          projectId: input.projectId,
          status: 'pending',
          taskId: null,
          cycle: { status: 'active' }
        }
      });
      if (!step) return undefined;
      const running = await tx.projectImplementationStep.count({
        where: { projectId: input.projectId, cycleId: step.cycleId, status: 'running' }
      });
      if (running > 0) return undefined;
      const dependencyTitles = Array.isArray(step.dependsOnStepTitles)
        ? step.dependsOnStepTitles.filter((value): value is string => typeof value === 'string')
        : [];
      if (dependencyTitles.length > 0) {
        const completedDependencies = await tx.projectImplementationStep.count({
          where: {
            projectId: input.projectId,
            cycleId: step.cycleId,
            title: { in: dependencyTitles },
            status: 'completed'
          }
        });
        if (completedDependencies !== new Set(dependencyTitles).size) return undefined;
      }

      const project = await tx.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new Error(`Project "${input.projectId}" does not exist`);
      const architectureVersionId = input.architectureVersionId ?? project.currentArchitectureVersionId ?? undefined;
      if (architectureVersionId) {
        const architectureVersion = await tx.projectArchitectureVersion.findUnique({
          where: { id: architectureVersionId },
          select: { projectId: true }
        });
        if (!architectureVersion || architectureVersion.projectId !== project.id) {
          throw new Error('Task architecture version does not belong to the selected project.');
        }
      }

      const startedAt = new Date();
      const task = await tx.task.create({
        data: {
          projectId: project.id,
          createdByUserId: LOCAL_USER_ID,
          title: input.title,
          prompt: input.prompt,
          mode: input.mode,
          status: 'submitted',
          architectureVersionId,
          maxIterations: input.maxIterations,
          maxBudgetUsd: input.maxBudgetUsd,
          startedAt
        }
      });
      await tx.projectImplementationStep.update({
        where: { id: step.id },
        data: { taskId: task.id, status: 'running', completedAt: null }
      });
      await tx.taskRun.create({
        data: {
          taskId: task.id,
          provider: resolveProjectProvider(project.configYaml ?? undefined),
          model: 'queued',
          status: 'queued'
        }
      });
      await tx.taskQueueJob.create({
        data: {
          taskId: task.id,
          reason: 'roadmap_step_started',
          status: 'pending',
          nextAttemptAt: startedAt
        }
      });

      await this.writeAuditTx(tx, {
        actorType: 'user', actorId: LOCAL_USER_ID, eventType: 'task_created', projectId: project.id, taskId: task.id,
        payload: { title: task.title, mode: task.mode }
      });
      await this.writeAuditTx(tx, {
        actorType: 'system', eventType: 'project_implementation_step_task_assigned', projectId: project.id, taskId: task.id,
        payload: { stepId: step.id, status: 'running' }
      });
      await this.writeAuditTx(tx, {
        actorType: 'user', actorId: LOCAL_USER_ID, eventType: 'task_started', projectId: project.id, taskId: task.id,
        payload: { status: task.status }
      });
      await this.writeAuditTx(tx, {
        actorType: 'system', eventType: 'task_run_queued', projectId: project.id, taskId: task.id,
        payload: { status: 'queued' }
      });
      await this.writeAuditTx(tx, {
        actorType: 'system', eventType: 'task_enqueued', projectId: project.id, taskId: task.id,
        payload: { reason: 'roadmap_step_started' }
      });
      return toTask(task);
    });
  }

  async updateImplementationStepStatus(
    stepId: string,
    status: ProjectImplementationStepStatus
  ): Promise<ProjectImplementationStep | undefined> {
    const existing = await this.prisma.projectImplementationStep.findUnique({ where: { id: stepId } });
    if (!existing) return undefined;

    const updated = await this.prisma.projectImplementationStep.update({
      where: { id: stepId },
      data: {
        status,
        taskId: status === 'pending' ? null : undefined,
        completedAt: status === 'completed' ? new Date() : null
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'project_implementation_step_status_updated',
      projectId: updated.projectId,
      taskId: updated.taskId ?? undefined,
      payload: {
        stepId: updated.id,
        status: updated.status
      }
    });

    return toProjectImplementationStep(updated);
  }

  async recordAcceptanceEvidence(input: RecordAcceptanceEvidenceInput): Promise<AcceptanceEvidence[]> {
    const [projectRecord, cycleRecord, stepRecord] = await Promise.all([
      this.prisma.project.findUnique({ where: { id: input.projectId } }),
      this.prisma.projectRoadmapCycle.findUnique({ where: { id: input.cycleId } }),
      input.stepId ? this.prisma.projectImplementationStep.findUnique({ where: { id: input.stepId } }) : undefined
    ]);
    if (!projectRecord || !cycleRecord || cycleRecord.projectId !== input.projectId) {
      throw new Error('Acceptance evidence references an invalid project roadmap cycle.');
    }
    if (stepRecord && (stepRecord.projectId !== input.projectId || stepRecord.cycleId !== input.cycleId)) {
      throw new Error('Acceptance evidence references an invalid roadmap work item.');
    }

    const project = toProject(projectRecord);
    if (!project.projectContract || project.projectContract.version !== input.contractVersion) {
      throw new Error('Acceptance evidence does not match the active project contract version.');
    }
    const knownRequirements = new Set(activeProjectContractRequirements(project.projectContract).map((requirement) => requirement.id));
    const stepRequirements = stepRecord ? new Set(toProjectImplementationStep(stepRecord).requirementIds) : undefined;
    const requirementIds = Array.from(new Set(input.requirementIds));
    if (requirementIds.length === 0 || requirementIds.some((id) => !knownRequirements.has(id) || (stepRequirements && !stepRequirements.has(id)))) {
      throw new Error('Acceptance evidence contains an unknown or unrelated project requirement.');
    }

    const criterion = input.criterion.trim();
    if (!criterion) throw new Error('Acceptance evidence criterion is required.');
    const criterionKey = acceptanceCriterionKey(criterion);
    const evidenceKey = acceptanceCriterionKey(input.evidenceIdentity);
    const payload = toPrismaJson(input.payload ?? {});
    const records = await this.prisma.$transaction(requirementIds.map((requirementId) =>
      this.prisma.acceptanceEvidence.upsert({
        where: {
          cycleId_requirementId_criterionKey_source_evidenceKey: {
            cycleId: input.cycleId,
            requirementId,
            criterionKey,
            source: input.source,
            evidenceKey
          }
        },
        update: {
          stepId: input.stepId,
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          status: input.status,
          contractVersion: input.contractVersion,
          commitSha: input.commitSha,
          command: input.command,
          exitCode: input.exitCode,
          detailsUrl: input.detailsUrl,
          payloadJson: payload
        },
        create: {
          projectId: input.projectId,
          cycleId: input.cycleId,
          stepId: input.stepId,
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          requirementId,
          criterionKey,
          criterion,
          source: input.source,
          status: input.status,
          evidenceKey,
          contractVersion: input.contractVersion,
          commitSha: input.commitSha,
          command: input.command,
          exitCode: input.exitCode,
          detailsUrl: input.detailsUrl,
          payloadJson: payload
        }
      })
    ));

    await this.writeAudit({
      actorType: input.source === 'github_check' ? 'github' : 'system',
      eventType: 'acceptance_evidence_recorded',
      projectId: input.projectId,
      taskId: input.taskId,
      payload: {
        cycleId: input.cycleId,
        stepId: input.stepId ?? null,
        requirementIds,
        source: input.source,
        status: input.status,
        criterionKey,
        evidenceKey,
        contractVersion: input.contractVersion,
        commitSha: input.commitSha ?? null
      }
    });

    return records.map(toAcceptanceEvidence);
  }

  async getNotificationSettings(userId: string): Promise<NotificationSettingsSnapshot> {
    const [settings, subscriptions] = await Promise.all([
      this.prisma.notificationSettings.findUnique({ where: { userId } }),
      this.prisma.notificationSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
    ]);

    return {
      userId,
      settings: settings
        ? {
            pushEnabled: settings.pushEnabled,
            approvalRequests: settings.approvalRequests,
            taskUpdates: settings.taskUpdates,
            budgetAlerts: settings.budgetAlerts
          }
        : {
            pushEnabled: false,
            approvalRequests: true,
            taskUpdates: true,
            budgetAlerts: true
          },
      subscriptions: subscriptions.map((item) => ({
        id: item.id,
        userId: item.userId,
        endpoint: item.endpoint,
        keys: item.keysJson && typeof item.keysJson === 'object' && !Array.isArray(item.keysJson)
          ? (item.keysJson as { p256dh?: string; auth?: string })
          : undefined,
        deviceName: item.deviceName ?? undefined,
        createdAt: item.createdAt.toISOString()
      }))
    };
  }

  async updateNotificationSettings(
    userId: string,
    input: Partial<NotificationSettingsSnapshot['settings']>
  ): Promise<NotificationSettingsSnapshot> {
    await this.ensureLocalUser();
    await this.prisma.notificationSettings.upsert({
      where: { userId },
      update: input,
      create: {
        userId,
        ...input
      }
    });

    return this.getNotificationSettings(userId);
  }

  async subscribeNotification(userId: string, input: NotificationSubscriptionInput): Promise<NotificationSubscriptionSnapshot> {
    await this.ensureLocalUser();

    const subscription = await this.prisma.notificationSubscription.upsert({
      where: {
        userId_endpoint: {
          userId,
          endpoint: input.endpoint
        }
      },
      update: {
        keysJson: input.keys ? toPrismaJson(input.keys) : undefined,
        deviceName: input.deviceName
      },
      create: {
        userId,
        endpoint: input.endpoint,
        keysJson: input.keys ? toPrismaJson(input.keys) : undefined,
        deviceName: input.deviceName
      }
    });

    await this.prisma.notificationSettings.upsert({
      where: { userId },
      update: { pushEnabled: true },
      create: {
        userId,
        pushEnabled: true
      }
    });

    return {
      id: subscription.id,
      userId: subscription.userId,
      endpoint: subscription.endpoint,
      keys: subscription.keysJson && typeof subscription.keysJson === 'object' && !Array.isArray(subscription.keysJson)
        ? (subscription.keysJson as { p256dh?: string; auth?: string })
        : undefined,
      deviceName: subscription.deviceName ?? undefined,
      createdAt: subscription.createdAt.toISOString()
    };
  }

  async unsubscribeNotification(userId: string, endpoint: string): Promise<{ userId: string; endpoint: string; removed: boolean }> {
    const existing = await this.prisma.notificationSubscription.findFirst({
      where: { userId, endpoint }
    });

    if (!existing) {
      return { userId, endpoint, removed: false };
    }

    await this.prisma.notificationSubscription.delete({
      where: {
        userId_endpoint: {
          userId,
          endpoint
        }
      }
    });

    const remaining = await this.prisma.notificationSubscription.count({ where: { userId } });
    await this.prisma.notificationSettings.upsert({
      where: { userId },
      update: { pushEnabled: remaining > 0 },
      create: {
        userId,
        pushEnabled: remaining > 0
      }
    });

    return { userId, endpoint, removed: true };
  }

  async listTasks(): Promise<ForgeTask[]> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { updatedAt: 'desc' }
    });
    return tasks.map(toTask);
  }

  async getTask(taskId: string): Promise<ForgeTask | undefined> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    return task ? toTask(task) : undefined;
  }

  async updateTaskProviderSession(input: {
    taskId: string;
    sessionId: string;
    provider: ProviderKind;
    model: string;
    connectionId?: string;
  }): Promise<void> {
    const current = await this.prisma.task.findUnique({
      where: { id: input.taskId },
      select: {
        projectId: true,
        providerSessionId: true,
        providerSessionProvider: true,
        providerSessionModel: true,
        providerSessionConnectionId: true
      }
    });
    if (!current) throw new Error(`Task "${input.taskId}" not found`);

    const isNewSession = current.providerSessionId !== input.sessionId
      || current.providerSessionProvider !== input.provider
      || current.providerSessionModel !== input.model
      || (current.providerSessionConnectionId ?? undefined) !== input.connectionId;
    await this.prisma.task.update({
      where: { id: input.taskId },
      data: {
        providerSessionId: input.sessionId,
        providerSessionProvider: input.provider,
        providerSessionModel: input.model,
        providerSessionConnectionId: input.connectionId,
        providerSessionUpdatedAt: new Date()
      }
    });

    if (isNewSession) {
      await this.writeAudit({
        actorType: 'agent',
        eventType: 'task_provider_session_updated',
        projectId: current.projectId,
        taskId: input.taskId,
        payload: {
          provider: input.provider,
          model: input.model,
          connectionId: input.connectionId ?? null,
          resumed: Boolean(current.providerSessionId)
        }
      });
    }
  }

  async updateProjectPlanningSession(input: {
    projectId: string;
    sessionId: string;
    provider: ProviderKind;
    model: string;
    connectionId?: string;
  }): Promise<void> {
    const current = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: {
        planningSessionId: true,
        planningSessionProvider: true,
        planningSessionModel: true,
        planningSessionConnectionId: true
      }
    });
    if (!current) throw new Error(`Project "${input.projectId}" not found`);

    const isNewSession = current.planningSessionId !== input.sessionId
      || current.planningSessionProvider !== input.provider
      || current.planningSessionModel !== input.model
      || (current.planningSessionConnectionId ?? undefined) !== input.connectionId;
    await this.prisma.project.update({
      where: { id: input.projectId },
      data: {
        planningSessionId: input.sessionId,
        planningSessionProvider: input.provider,
        planningSessionModel: input.model,
        planningSessionConnectionId: input.connectionId,
        planningSessionUpdatedAt: new Date()
      }
    });

    if (isNewSession) {
      await this.writeAudit({
        actorType: 'agent',
        eventType: 'project_planning_session_updated',
        projectId: input.projectId,
        payload: {
          provider: input.provider,
          model: input.model,
          connectionId: input.connectionId ?? null,
          resumed: Boolean(current.planningSessionId)
        }
      });
    }
  }

  async recordCompletedTaskProjectMemory(input: {
    taskId: string;
    summary?: string;
    changedFiles?: string[];
    commitSha?: string;
    architectureUpdate?: ProjectArchitectureUpdate;
  }): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: input.taskId },
      include: {
        project: true,
        taskRuns: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: {
            iterations: {
              where: { phase: 'implementation' },
              orderBy: { createdAt: 'desc' },
              take: 1
            }
          }
        }
      }
    });
    if (!task || task.status !== 'completed') return;

    const latestRun = task.taskRuns[0];
    const latestImplementation = latestRun?.iterations[0];
    const implementationPayload = asJsonRecord(latestImplementation?.validationResultJson);
    const persistedArchitectureUpdate = toProjectArchitectureUpdate(implementationPayload?.architectureUpdate);
    const persistedChangedFiles = Array.isArray(implementationPayload?.changedFiles)
      ? implementationPayload.changedFiles.filter((path): path is string => typeof path === 'string')
      : [];
    const currentMemory = toProject(task.project).projectMemory;
    const completedAt = (task.finishedAt ?? new Date()).toISOString();
    const entry = {
      taskId: task.id,
      title: task.title,
      summary: input.summary?.trim() || latestRun?.summary?.trim() || latestImplementation?.resultSummary || task.title,
      changedFiles: Array.from(new Set(input.changedFiles?.length ? input.changedFiles : persistedChangedFiles)).slice(0, 40),
      commitSha: input.commitSha,
      completedAt
    };
    const memory: ProjectMemory = {
      version: 1,
      contractVersion: toProject(task.project).projectContract?.version,
      baseCommitSha: input.commitSha ?? currentMemory?.baseCommitSha,
      recentWork: [entry, ...(currentMemory?.recentWork ?? []).filter((item) => item.taskId !== task.id)].slice(0, 8),
      updatedAt: new Date().toISOString()
    };
    const architectureUpdate = input.architectureUpdate ?? persistedArchitectureUpdate;
    const architecture = architectureUpdate
      ? mergeProjectArchitecture(toProject(task.project).projectArchitecture, architectureUpdate, task.id)
      : undefined;

    await this.prisma.$transaction(async (tx) => {
      let architectureVersionId = task.architectureVersionId ?? task.project.currentArchitectureVersionId ?? undefined;
      let architectureVersion: number | undefined;
      if (architecture && architectureUpdate) {
        const existing = await tx.projectArchitectureVersion.findUnique({ where: { sourceTaskId: task.id } });
        const current = existing ? undefined : await tx.projectArchitectureVersion.findFirst({
          where: { projectId: task.projectId },
          orderBy: [{ version: 'desc' }, { createdAt: 'desc' }]
        });
        const created = existing ?? await tx.projectArchitectureVersion.create({
          data: {
            projectId: task.projectId,
            version: (current?.version ?? 0) + 1,
            architectureJson: toPrismaJson(architecture as unknown as JsonValue),
            architectureUpdate: toPrismaJson(architectureUpdate as unknown as JsonValue),
            changeSummary: architectureUpdate.summary?.trim() || `Architecture updated by task ${task.title}.`,
            source: 'task_update',
            parentVersionId: current?.id,
            contractVersionId: task.project.currentContractVersionId,
            sourceTaskId: task.id
          }
        });
        architectureVersionId = created.id;
        architectureVersion = created.version;
      }

      await tx.project.update({
        where: { id: task.projectId },
        data: {
          projectMemory: toPrismaJson(memory as unknown as JsonValue),
          projectArchitecture: architecture ? toPrismaJson(architecture as unknown as JsonValue) : undefined,
          currentArchitectureVersionId: architectureVersionId
        }
      });
      if (architectureVersionId) {
        await tx.task.update({
          where: { id: task.id },
          data: { architectureVersionId }
        });
      }
      await this.writeAuditTx(tx, {
        actorType: 'system',
        eventType: 'project_memory_updated',
        projectId: task.projectId,
        taskId: task.id,
        payload: {
          recentWorkCount: memory.recentWork.length,
          contractVersion: memory.contractVersion ?? null,
          baseCommitSha: memory.baseCommitSha ?? null,
          architectureUpdated: Boolean(architecture),
          architectureVersion: architectureVersion ?? null
        }
      });
    });
  }

  async getTaskQueuePosition(taskId: string): Promise<TaskQueuePosition> {
    const pendingJobs = await this.prisma.taskQueueJob.findMany({
      where: { status: 'pending' },
      select: { taskId: true },
      orderBy: { createdAt: 'asc' }
    });

    const queueDepth = pendingJobs.length;
    const queuePosition = pendingJobs.findIndex((item) => item.taskId === taskId);

    return {
      queueDepth,
      queuePosition: queuePosition >= 0 ? queuePosition + 1 : null
    };
  }

  async enqueueTask(taskId: string, reason: string): Promise<{ enqueued: boolean }> {
    const existing = await this.prisma.taskQueueJob.findFirst({
      where: {
        taskId,
        status: {
          in: [...ACTIVE_QUEUE_STATUSES]
        }
      }
    });

    if (existing) {
      return { enqueued: false };
    }

    await this.prisma.taskQueueJob.create({
      data: {
        taskId,
        reason,
        status: 'pending',
        nextAttemptAt: new Date()
      }
    });

    return { enqueued: true };
  }

  async enqueueProjectAudit(input: { projectId: string; cycleId: string; triggerTaskId?: string; requirementIds: string[] }): Promise<{ enqueued: boolean; job: ProjectAuditJob }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
      const [cycle, project] = await Promise.all([
        tx.projectRoadmapCycle.findUnique({ where: { id: input.cycleId } }),
        tx.project.findUnique({ where: { id: input.projectId } })
      ]);
      if (!cycle || cycle.projectId !== input.projectId) throw new Error('Project audit references an unknown roadmap cycle.');
      const contract = project ? toProject(project).projectContract : undefined;
      const knownRequirementIds = new Set(contract?.requirements.map((requirement) => requirement.id) ?? []);
      const requirementIds = Array.from(new Set(input.requirementIds));
      if (!contract || requirementIds.length === 0 || requirementIds.some((id) => !knownRequirementIds.has(id))) {
        throw new Error('Project audit must reference requirements from the active project contract.');
      }

      const existing = await tx.projectAuditJob.findUnique({ where: { cycleId: input.cycleId } });
      if (existing && (existing.status === 'pending' || existing.status === 'claimed')) {
        return { enqueued: false, job: toProjectAuditJob(existing) };
      }
      if (existing?.status === 'succeeded') {
        const latestCompletedStep = await tx.projectImplementationStep.findFirst({
          where: { cycleId: input.cycleId, status: 'completed' },
          orderBy: { completedAt: 'desc' },
          select: { completedAt: true }
        });
        if (!shouldRequeueProjectAuditAfterCompletedWork(existing.finishedAt, latestCompletedStep?.completedAt)) {
          return { enqueued: false, job: toProjectAuditJob(existing) };
        }
      }

      const now = new Date();
      const job = await tx.projectAuditJob.upsert({
        where: { cycleId: input.cycleId },
        update: {
          triggerTaskId: input.triggerTaskId,
          requirementIds: toPrismaJson(requirementIds),
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: now,
          errorMessage: null,
          claimedAt: null,
          finishedAt: null
        },
        create: {
          projectId: input.projectId,
          cycleId: input.cycleId,
          triggerTaskId: input.triggerTaskId,
          requirementIds: toPrismaJson(requirementIds),
          status: 'pending',
          nextAttemptAt: now
        }
      });
      await tx.projectRoadmapCycle.update({
        where: { id: input.cycleId },
        data: { status: 'verifying', completedAt: null }
      });
      await this.writeAuditTx(tx, {
        actorType: 'system',
        eventType: 'project_audit_enqueued',
        projectId: input.projectId,
        taskId: input.triggerTaskId,
        payload: { auditJobId: job.id, cycleId: input.cycleId, requirementIds }
      });
      return { enqueued: true, job: toProjectAuditJob(job) };
    });
  }

  async claimNextProjectAudit(): Promise<ClaimedProjectAuditJob | undefined> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
      const [workerControl] = await tx.$queryRawUnsafe<Array<{ queuePaused: boolean }>>(
        'SELECT "queue_paused" AS "queuePaused" FROM "worker_control" WHERE "id" = $1',
        WORKER_QUEUE_CONTROL_ID
      );
      if (workerControl?.queuePaused) return undefined;

      const candidate = await tx.projectAuditJob.findFirst({
        where: {
          status: 'pending',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }]
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        include: { project: true, cycle: true }
      });
      if (!candidate) return undefined;

      const claimed = await tx.projectAuditJob.update({
        where: { id: candidate.id },
        data: { status: 'claimed', claimedAt: new Date(), attemptCount: { increment: 1 } }
      });
      await this.writeAuditTx(tx, {
        actorType: 'agent',
        eventType: 'project_audit_claimed',
        projectId: candidate.projectId,
        taskId: candidate.triggerTaskId ?? undefined,
        payload: { auditJobId: candidate.id, cycleId: candidate.cycleId }
      });
      return {
        job: toProjectAuditJob(claimed),
        project: toProject(candidate.project),
        cycle: toProjectRoadmapCycle(candidate.cycle)
      };
    });
  }

  async finalizeProjectAudit(
    auditJobId: string,
    status: Extract<ProjectAuditJobStatus, 'succeeded' | 'blocked' | 'failed'>,
    errorMessage?: string
  ): Promise<{ retryScheduled: boolean }> {
    const job = await this.prisma.projectAuditJob.findUnique({ where: { id: auditJobId } });
    if (!job || job.status !== 'claimed') return { retryScheduled: false };

    if (status === 'failed') {
      const maxAttempts = Math.max(1, Number(process.env.FORGEMIND_AUDIT_MAX_ATTEMPTS ?? DEFAULT_AUDIT_JOB_MAX_ATTEMPTS));
      if (job.attemptCount < maxAttempts) {
        const backoffSeconds = Math.max(1, Number(process.env.FORGEMIND_QUEUE_RETRY_BACKOFF_SECONDS ?? DEFAULT_QUEUE_BACKOFF_SECONDS));
        const nextAttemptAt = new Date(Date.now() + backoffSeconds * (2 ** Math.max(0, job.attemptCount - 1)) * 1000);
        await this.prisma.projectAuditJob.update({
          where: { id: auditJobId },
          data: { status: 'pending', claimedAt: null, nextAttemptAt, errorMessage }
        });
        await this.writeAudit({
          actorType: 'system',
          eventType: 'project_audit_retry_scheduled',
          projectId: job.projectId,
          taskId: job.triggerTaskId ?? undefined,
          payload: { auditJobId, cycleId: job.cycleId, nextAttemptAt: nextAttemptAt.toISOString(), errorMessage: errorMessage ?? null }
        });
        return { retryScheduled: true };
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.projectAuditJob.update({
        where: { id: auditJobId },
        data: {
          status,
          claimedAt: null,
          nextAttemptAt: null,
          errorMessage: status === 'succeeded' ? null : errorMessage,
          finishedAt: new Date()
        }
      });
      if (status === 'blocked' || status === 'failed') {
        await tx.projectRoadmapCycle.update({
          where: { id: job.cycleId },
          data: { status: 'blocked', completedAt: null }
        });
      }
      await this.writeAuditTx(tx, {
        actorType: 'system',
        eventType: `project_audit_${status}`,
        projectId: job.projectId,
        taskId: job.triggerTaskId ?? undefined,
        payload: { auditJobId, cycleId: job.cycleId, errorMessage: errorMessage ?? null }
      });
    });
    return { retryScheduled: false };
  }

  async recoverStuckProjectAudits(claimTimeoutMinutes = 2): Promise<number> {
    const cutoff = new Date(Date.now() - Math.max(1, claimTimeoutMinutes) * 60_000);
    const result = await this.prisma.projectAuditJob.updateMany({
      where: { status: 'claimed', claimedAt: { lt: cutoff } },
      data: {
        status: 'pending',
        claimedAt: null,
        nextAttemptAt: new Date(),
        errorMessage: 'Worker execution was interrupted; capability audit will resume.'
      }
    });
    return result.count;
  }

  async recoverStuckQueueJobs(claimTimeoutMinutes = 2): Promise<QueueRecoveryResult> {
    const timeoutMinutes = Math.max(1, claimTimeoutMinutes);
    const cutoff = new Date(Date.now() - timeoutMinutes * 60_000);

    const stuckJobs = await this.prisma.taskQueueJob.findMany({
      where: {
        status: 'claimed',
        claimedAt: { lt: cutoff }
      },
      select: {
        id: true,
        taskId: true
      }
    });

    const queueJobIds: string[] = [];
    for (const job of stuckJobs) {
      const recovered = await this.prisma.$transaction(async (tx) => {
        const [queueJob, task] = await Promise.all([
          tx.taskQueueJob.findUnique({
            where: { id: job.id },
            select: {
              id: true,
              status: true,
              claimedAt: true
            }
          }),
          tx.task.findUnique({
            where: { id: job.taskId },
            select: {
              id: true,
              projectId: true,
              status: true
            }
          })
        ]);

        if (!queueJob || queueJob.status !== 'claimed' || !queueJob.claimedAt || queueJob.claimedAt >= cutoff) {
          return false;
        }

        if (!task) {
          await tx.taskQueueJob.update({
            where: { id: job.id },
            data: {
              status: 'failed',
              claimedAt: null,
              nextAttemptAt: null,
              errorMessage: `Task "${job.taskId}" no longer exists.`,
              finishedAt: new Date()
            }
          });
          return false;
        }

        if (task.status !== 'submitted' && !ACTIVE_TASK_STATUSES.has(task.status)) {
          await tx.taskQueueJob.update({
            where: { id: job.id },
            data: {
              status: task.status === 'cancelled' ? 'cancelled' : 'failed',
              claimedAt: null,
              nextAttemptAt: null,
              errorMessage: `Task "${task.id}" is ${task.status}; interrupted queue job was not recovered.`,
              finishedAt: new Date()
            }
          });
          return false;
        }

        const interruptedAt = new Date();
        const interruptionMessage = 'Worker execution was interrupted and will resume from the existing workspace.';
        await tx.taskRun.updateMany({
          where: {
            taskId: task.id,
            status: 'running'
          },
          data: {
            status: 'failed',
            finishedAt: interruptedAt,
            errorMessage: interruptionMessage
          }
        });
        await tx.task.update({
          where: { id: task.id },
          data: {
            status: 'submitted',
            finishedAt: null
          }
        });
        await tx.taskQueueJob.update({
          where: { id: job.id },
          data: {
            status: 'pending',
            reason: 'worker_interrupted',
            claimedAt: null,
            nextAttemptAt: interruptedAt,
            errorMessage: interruptionMessage,
            finishedAt: null
          }
        });
        await tx.auditLog.create({
          data: {
            actorType: 'system',
            eventType: 'task_worker_interrupted',
            projectId: task.projectId,
            taskId: task.id,
            payload: {
              queueJobId: job.id,
              claimTimeoutMinutes: timeoutMinutes,
              resumeFromWorkspace: true
            }
          }
        });
        await tx.auditLog.create({
          data: {
            actorType: 'system',
            eventType: 'task_queue_job_recovered',
            projectId: task.projectId,
            taskId: task.id,
            payload: {
              queueJobId: job.id,
              claimTimeoutMinutes: timeoutMinutes
            }
          }
        });
        return true;
      });

      if (recovered) {
        queueJobIds.push(job.id);
      }
    }

    const orphanedTasks = await this.prisma.task.findMany({
      where: {
        status: { in: [...ACTIVE_TASK_STATUSES] },
        queueJobs: {
          none: {
            status: { in: [...ACTIVE_QUEUE_STATUSES] }
          }
        }
      },
      select: {
        id: true,
        projectId: true
      }
    });
    for (const orphanedTask of orphanedTasks) {
      const recoveredQueueJobId = await this.prisma.$transaction(async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: orphanedTask.id },
          select: {
            id: true,
            projectId: true,
            status: true
          }
        });
        if (!task || !ACTIVE_TASK_STATUSES.has(task.status)) {
          return undefined;
        }

        const activeQueueJobCount = await tx.taskQueueJob.count({
          where: {
            taskId: task.id,
            status: { in: [...ACTIVE_QUEUE_STATUSES] }
          }
        });
        if (activeQueueJobCount > 0) {
          return undefined;
        }

        const recoveredAt = new Date();
        const interruptionMessage = 'Active task had no live worker claim and will resume from the existing workspace.';
        await tx.taskRun.updateMany({
          where: {
            taskId: task.id,
            status: 'running'
          },
          data: {
            status: 'failed',
            finishedAt: recoveredAt,
            errorMessage: interruptionMessage
          }
        });
        await tx.task.update({
          where: { id: task.id },
          data: {
            status: 'submitted',
            finishedAt: null
          }
        });
        const queueJob = await tx.taskQueueJob.create({
          data: {
            taskId: task.id,
            reason: 'worker_interrupted',
            status: 'pending',
            nextAttemptAt: recoveredAt,
            errorMessage: interruptionMessage
          },
          select: {
            id: true
          }
        });
        await tx.auditLog.create({
          data: {
            actorType: 'system',
            eventType: 'task_worker_interrupted',
            projectId: task.projectId,
            taskId: task.id,
            payload: {
              queueJobId: queueJob.id,
              orphanedTask: true,
              resumeFromWorkspace: true
            }
          }
        });
        return queueJob.id;
      });

      if (recoveredQueueJobId) {
        queueJobIds.push(recoveredQueueJobId);
      }
    }

    return {
      recoveredCount: queueJobIds.length,
      queueJobIds
    };
  }

  async refreshQueueJobClaim(queueJobId: string): Promise<boolean> {
    const result = await this.prisma.taskQueueJob.updateMany({
      where: {
        id: queueJobId,
        status: 'claimed'
      },
      data: {
        claimedAt: new Date()
      }
    });
    return result.count === 1;
  }

  async refreshProjectAuditClaim(auditJobId: string): Promise<boolean> {
    const result = await this.prisma.projectAuditJob.updateMany({
      where: { id: auditJobId, status: 'claimed' },
      data: { claimedAt: new Date() }
    });
    return result.count === 1;
  }

  async interruptClaimedTask(input: {
    queueJobId: string;
    taskId: string;
    taskRunId: string;
    signal: 'SIGTERM' | 'SIGINT';
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const [queueJob, task] = await Promise.all([
        tx.taskQueueJob.findUnique({
          where: { id: input.queueJobId },
          select: {
            id: true,
            taskId: true,
            status: true
          }
        }),
        tx.task.findUnique({
          where: { id: input.taskId },
          select: {
            id: true,
            projectId: true,
            status: true
          }
        })
      ]);
      if (
        !queueJob
        || queueJob.taskId !== input.taskId
        || queueJob.status !== 'claimed'
        || !task
        || (task.status !== 'submitted' && !ACTIVE_TASK_STATUSES.has(task.status))
      ) {
        return false;
      }

      const interruptedAt = new Date();
      const errorMessage = `Worker received ${input.signal}; execution will resume from the existing workspace.`;
      await tx.taskRun.updateMany({
        where: {
          id: input.taskRunId,
          taskId: input.taskId,
          status: 'running'
        },
        data: {
          status: 'failed',
          finishedAt: interruptedAt,
          errorMessage
        }
      });
      await tx.task.update({
        where: { id: input.taskId },
        data: {
          status: 'submitted',
          finishedAt: null
        }
      });
      await tx.taskQueueJob.update({
        where: { id: input.queueJobId },
        data: {
          status: 'pending',
          reason: 'worker_interrupted',
          claimedAt: null,
          nextAttemptAt: interruptedAt,
          errorMessage,
          finishedAt: null
        }
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          eventType: 'task_worker_interrupted',
          projectId: task.projectId,
          taskId: task.id,
          payload: {
            queueJobId: input.queueJobId,
            taskRunId: input.taskRunId,
            signal: input.signal,
            resumeFromWorkspace: true
          }
        }
      });
      return true;
    });
  }

  async getWorkerStatus(): Promise<WorkerStatusSnapshot> {
    const claimTimeoutMinutes = Math.max(1, Number(process.env.FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES ?? 2));
    const activeClaimCutoff = new Date(Date.now() - claimTimeoutMinutes * 60_000);
    const activeClaimFilter = {
      status: 'claimed' as const,
      claimedAt: { gte: activeClaimCutoff }
    };
    const [queueControl, queuedTaskCount, activeTaskCount, queuedAuditCount, activeAuditCount, runningRun, lastCompletedRun] = await Promise.all([
      this.getWorkerQueueControl(),
      this.prisma.taskQueueJob.count({ where: { status: 'pending' } }),
      this.prisma.task.count({
        where: {
          status: { in: [...ACTIVE_TASK_STATUSES] },
          queueJobs: {
            some: activeClaimFilter
          }
        }
      }),
      this.prisma.projectAuditJob.count({ where: { status: 'pending' } }),
      this.prisma.projectAuditJob.count({ where: activeClaimFilter }),
      this.prisma.taskRun.findFirst({
        where: {
          status: 'running',
          task: {
            queueJobs: {
              some: activeClaimFilter
            }
          }
        },
        orderBy: { startedAt: 'desc' }
      }),
      this.prisma.taskRun.findFirst({
        where: { status: { in: ['succeeded', 'failed', 'cancelled'] } },
        orderBy: { finishedAt: 'desc' }
      })
    ]);

    const activeIterationAudit = runningRun
      ? await this.prisma.auditLog.findFirst({
          where: {
            taskId: runningRun.taskId,
            eventType: 'task_iteration_started'
          },
          orderBy: { createdAt: 'desc' }
        })
      : null;
    const activeIteration = parseActiveIterationAudit(activeIterationAudit);

    return {
      state: runningRun || activeAuditCount > 0 ? 'running' : 'idle',
      queuePaused: queueControl.queuePaused,
      queuePausedAt: queueControl.pausedAt,
      queuedTaskCount: queuedTaskCount + queuedAuditCount,
      activeTaskCount: activeTaskCount + activeAuditCount,
      runningRun: runningRun
        ? {
            id: runningRun.id,
            taskId: runningRun.taskId,
            provider: runningRun.provider,
            model: runningRun.model,
            startedAt: runningRun.startedAt?.toISOString()
          }
        : undefined,
      activeIteration: activeIteration && runningRun ? { ...activeIteration, taskId: runningRun.taskId } : undefined,
      lastCompletedRun: lastCompletedRun
        ? {
            id: lastCompletedRun.id,
            taskId: lastCompletedRun.taskId,
            provider: lastCompletedRun.provider,
            model: lastCompletedRun.model,
            finishedAt: lastCompletedRun.finishedAt?.toISOString(),
            status: lastCompletedRun.status as 'succeeded' | 'failed' | 'cancelled',
            summary: lastCompletedRun.summary ?? undefined,
            errorMessage: lastCompletedRun.errorMessage ?? undefined
          }
        : undefined,
      updatedAt: new Date().toISOString()
    };
  }

  async getWorkerQueueControl(): Promise<WorkerQueueControlSnapshot> {
    const [control] = await this.prisma.$queryRawUnsafe<WorkerQueueControlRow[]>(
      'SELECT "queue_paused" AS "queuePaused", "paused_at" AS "pausedAt", "updated_at" AS "updatedAt" FROM "worker_control" WHERE "id" = $1',
      WORKER_QUEUE_CONTROL_ID
    );

    return control
      ? {
          queuePaused: control.queuePaused,
          pausedAt: control.pausedAt?.toISOString(),
          updatedAt: control.updatedAt.toISOString()
        }
      : {
          queuePaused: false,
          updatedAt: new Date(0).toISOString()
        };
  }

  async setWorkerQueuePaused(paused: boolean): Promise<WorkerQueueControlSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
      const now = new Date();
      const [control] = await tx.$queryRawUnsafe<WorkerQueueControlRow[]>(
        `INSERT INTO "worker_control" ("id", "queue_paused", "paused_at", "updated_at")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("id") DO UPDATE SET
           "queue_paused" = EXCLUDED."queue_paused",
           "paused_at" = EXCLUDED."paused_at",
           "updated_at" = EXCLUDED."updated_at"
         RETURNING "queue_paused" AS "queuePaused", "paused_at" AS "pausedAt", "updated_at" AS "updatedAt"`,
        WORKER_QUEUE_CONTROL_ID,
        paused,
        paused ? now : null,
        now
      );
      if (!control) {
        throw new Error('Worker queue control could not be persisted.');
      }
      await tx.auditLog.create({
        data: {
          actorType: 'user',
          eventType: paused ? 'worker_queue_paused' : 'worker_queue_resumed',
          payload: {
            queuePaused: paused,
            effectiveAfterActiveTask: true
          }
        }
      });

      return {
        queuePaused: control.queuePaused,
        pausedAt: control.pausedAt?.toISOString(),
        updatedAt: control.updatedAt.toISOString()
      };
    });
  }

  async getRecentWorkerEvents(limit = 20): Promise<AuditEvent[]> {
    const events = await this.prisma.auditLog.findMany({
      where: {
        OR: WORKER_EVENT_PREFIXES.map((prefix) => ({ eventType: { startsWith: prefix } }))
      },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(100, limit))
    });

    return events.map(toAuditEvent);
  }

  async getOperationalMetrics(): Promise<OperationalMetricsSnapshot> {
    const [
      totalTasks,
      draftTasks,
      submittedTasks,
      activeTasks,
      needsApprovalTasks,
      completedTasks,
      failedTasks,
      cancelledTasks,
      providerFailedTasks,
      budgetExceededTasks,
      iterationLimitTasks,
      repeatedErrorTasks,
      validationFailedTasks,
      pendingQueueJobs,
      claimedQueueJobs,
      failedQueueJobs,
      pendingQueueWaitJobs,
      pendingApprovals,
      approvedApprovals,
      rejectedApprovals,
      cancelledApprovals,
      queuedRuns,
      runningRuns,
      succeededRuns,
      failedRuns,
      cancelledRuns,
      finishedRuns
    ] = await Promise.all([
      this.prisma.task.count(),
      this.prisma.task.count({ where: { status: 'draft' } }),
      this.prisma.task.count({ where: { status: 'submitted' } }),
      this.prisma.task.count({ where: { status: { in: [...ACTIVE_TASK_STATUSES] } } }),
      this.prisma.task.count({ where: { status: 'needs_approval' } }),
      this.prisma.task.count({ where: { status: 'completed' } }),
      this.prisma.task.count({ where: { status: 'failed' } }),
      this.prisma.task.count({ where: { status: 'cancelled' } }),
      this.prisma.task.count({ where: { status: 'provider_failed' } }),
      this.prisma.task.count({ where: { status: 'budget_exceeded' } }),
      this.prisma.task.count({ where: { status: 'iteration_limit_reached' } }),
      this.prisma.task.count({ where: { status: 'repeated_error_detected' } }),
      this.prisma.task.count({ where: { status: 'validation_failed' } }),
      this.prisma.taskQueueJob.count({ where: { status: 'pending' } }),
      this.prisma.taskQueueJob.count({ where: { status: 'claimed' } }),
      this.prisma.taskQueueJob.count({ where: { status: 'failed' } }),
      this.prisma.taskQueueJob.findMany({
        where: { status: 'pending' },
        select: { createdAt: true }
      }),
      this.prisma.approval.count({ where: { status: 'pending' } }),
      this.prisma.approval.count({ where: { status: 'approved' } }),
      this.prisma.approval.count({ where: { status: 'rejected' } }),
      this.prisma.approval.count({ where: { status: 'cancelled' } }),
      this.prisma.taskRun.count({ where: { status: 'queued' } }),
      this.prisma.taskRun.count({ where: { status: 'running' } }),
      this.prisma.taskRun.count({ where: { status: 'succeeded' } }),
      this.prisma.taskRun.count({ where: { status: 'failed' } }),
      this.prisma.taskRun.count({ where: { status: 'cancelled' } }),
      this.prisma.taskRun.findMany({
        where: {
          status: { in: ['succeeded', 'failed', 'cancelled'] },
          startedAt: { not: null },
          finishedAt: { not: null }
        },
        select: { startedAt: true, finishedAt: true }
      })
    ]);

    const now = Date.now();
    const pendingWaitDurations = pendingQueueWaitJobs.map((job) => (now - job.createdAt.getTime()) / 1000);
    const averagePendingWaitSeconds = pendingWaitDurations.length
      ? pendingWaitDurations.reduce((sum, value) => sum + value, 0) / pendingWaitDurations.length
      : 0;
    const maxPendingWaitSeconds = pendingWaitDurations.length ? Math.max(...pendingWaitDurations) : 0;

    const runDurations = finishedRuns.map((run) => (run.finishedAt!.getTime() - run.startedAt!.getTime()) / 1000);
    const averageRunDurationSeconds = runDurations.length ? runDurations.reduce((sum, value) => sum + value, 0) / runDurations.length : 0;
    const maxRunDurationSeconds = runDurations.length ? Math.max(...runDurations) : 0;

    return {
      generatedAt: new Date().toISOString(),
      tasks: {
        total: totalTasks,
        draft: draftTasks,
        submitted: submittedTasks,
        active: activeTasks,
        needsApproval: needsApprovalTasks,
        completed: completedTasks,
        failed: failedTasks,
        cancelled: cancelledTasks,
        providerFailed: providerFailedTasks,
        budgetExceeded: budgetExceededTasks,
        iterationLimitReached: iterationLimitTasks,
        repeatedErrorDetected: repeatedErrorTasks,
        validationFailed: validationFailedTasks
      },
      queue: {
        pending: pendingQueueJobs,
        claimed: claimedQueueJobs,
        failed: failedQueueJobs,
        averagePendingWaitSeconds,
        maxPendingWaitSeconds
      },
      approvals: {
        pending: pendingApprovals,
        approved: approvedApprovals,
        rejected: rejectedApprovals,
        cancelled: cancelledApprovals
      },
      runs: {
        queued: queuedRuns,
        running: runningRuns,
        succeeded: succeededRuns,
        failed: failedRuns,
        cancelled: cancelledRuns,
        averageDurationSeconds: averageRunDurationSeconds,
        maxDurationSeconds: maxRunDurationSeconds
      }
    };
  }

  async createTask(input: CreateTaskInput): Promise<ForgeTask> {
    await this.ensureLocalUser();
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) {
      throw new Error(`Project "${input.projectId}" does not exist`);
    }
    const architectureVersionId = input.architectureVersionId ?? project.currentArchitectureVersionId ?? undefined;
    if (architectureVersionId) {
      const architectureVersion = await this.prisma.projectArchitectureVersion.findUnique({
        where: { id: architectureVersionId },
        select: { projectId: true }
      });
      if (!architectureVersion || architectureVersion.projectId !== project.id) {
        throw new Error('Task architecture version does not belong to the selected project.');
      }
    }

    const task = await this.prisma.task.create({
      data: {
        projectId: project.id,
        createdByUserId: LOCAL_USER_ID,
        title: input.title,
        prompt: input.prompt,
        mode: input.mode,
        status: 'draft',
        architectureVersionId,
        maxIterations: input.maxIterations,
        maxBudgetUsd: input.maxBudgetUsd
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_created',
      projectId: project.id,
      taskId: task.id,
      payload: { title: task.title, mode: task.mode }
    });

    return toTask(task);
  }

  async startTask(taskId: string): Promise<ForgeTask | undefined> {
    const task = await this.getTask(taskId);
    if (!task) return undefined;
    assertTaskTransition(task.status, 'submitted');

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'submitted',
        startedAt: new Date()
      }
    });

    const queuedRun = await this.prisma.taskRun.findFirst({
      where: {
        taskId: updated.id,
        status: 'queued'
      },
      orderBy: { id: 'asc' }
    });

    if (!queuedRun) {
      const project = await this.prisma.project.findUnique({
        where: { id: updated.projectId },
        select: { configYaml: true }
      });
      await this.prisma.taskRun.create({
        data: {
          taskId: updated.id,
          provider: resolveProjectProvider(project?.configYaml ?? undefined),
          model: 'queued',
          status: 'queued'
        }
      });
    }

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_started',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: { status: updated.status }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'task_run_queued',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: { status: 'queued' }
    });

    return toTask(updated);
  }

  async cancelTask(taskId: string): Promise<ForgeTask | undefined> {
    const task = await this.getTask(taskId);
    if (!task) return undefined;
    assertTaskTransition(task.status, 'cancelled');

    const queueCancellation = await this.prisma.taskQueueJob.updateMany({
      where: {
        taskId,
        status: { in: [...ACTIVE_QUEUE_STATUSES] }
      },
      data: {
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        finishedAt: new Date()
      }
    });
    await this.prisma.taskRun.updateMany({
      where: { taskId, status: 'running' },
      data: {
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        finishedAt: new Date()
      }
    });

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'cancelled',
        finishedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_cancelled',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: {
        cancelledQueueJobs: queueCancellation.count
      }
    });

    return toTask(updated);
  }

  async retryTask(taskId: string, start = true): Promise<ForgeTask | undefined> {
    const task = await this.getTask(taskId);
    if (!task) return undefined;
    if (ACTIVE_TASK_STATUSES.has(task.status)) {
      throw new Error(`Task "${taskId}" is currently active and cannot be retried.`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const retriedTask = await tx.task.update({
        where: { id: taskId },
        data: {
          status: start ? 'submitted' : 'draft',
          waitingForCapabilities: [],
          startedAt: start ? new Date() : null,
          finishedAt: null
        }
      });
      await tx.projectImplementationStep.updateMany({
        where: { taskId, status: { in: ['completed', 'waiting_for_capability'] } },
        data: { status: 'running', completedAt: null }
      });
      return retriedTask;
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_retried',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: { status: updated.status }
    });

    return toTask(updated);
  }

  async transitionTask(taskId: string, nextStatus: TaskStatus, payload: JsonValue = {}): Promise<ForgeTask> {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`Task "${taskId}" not found`);
    assertTaskTransition(current.status, nextStatus);

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: nextStatus,
        waitingForCapabilities: nextStatus === 'completed' ? [] : undefined,
        finishedAt: nextStatus === 'completed' ? new Date() : undefined
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: `task_status_${nextStatus}`,
      projectId: updated.projectId,
      taskId: updated.id,
      payload
    });

    return toTask(updated);
  }

  async waitTaskForCapabilities(taskId: string, capabilities: string[], payload: JsonValue = {}): Promise<ForgeTask> {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`Task "${taskId}" not found`);
    assertTaskTransition(current.status, 'waiting_for_capability');
    const normalized = Array.from(new Set(capabilities.map((item) => item.trim().toLowerCase()).filter(Boolean)));
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'waiting_for_capability',
        waitingForCapabilities: normalized,
        finishedAt: new Date()
      }
    });
    await this.writeAudit({
      actorType: 'system',
      eventType: 'task_waiting_for_capability',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: { ...payload as Record<string, JsonValue>, requiredCapabilities: normalized }
    });
    return toTask(updated);
  }

  async setTaskWaitingCapabilities(taskId: string, capabilities: string[]): Promise<ForgeTask> {
    const normalized = Array.from(new Set(capabilities.map((item) => item.trim().toLowerCase()).filter(Boolean)));
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { waitingForCapabilities: normalized }
    });
    return toTask(updated);
  }

  async requeueTasksWaitingForCapabilities(availableCapabilities: ReadonlySet<string>): Promise<number> {
    const waitingTasks = await this.prisma.task.findMany({ where: { status: 'waiting_for_capability' } });
    let requeued = 0;
    for (const candidate of waitingTasks) {
      const required = jsonStringArray(candidate.waitingForCapabilities);
      if (required.length === 0 || required.some((capability) => !availableCapabilities.has(capability))) continue;
      const didRequeue = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
        const task = await tx.task.findUnique({ where: { id: candidate.id } });
        if (!task || task.status !== 'waiting_for_capability') return false;
        const activeQueueJobs = await tx.taskQueueJob.count({
          where: { taskId: task.id, status: { in: ['pending', 'claimed'] } }
        });
        if (activeQueueJobs > 0) return false;
        const linkedStep = await tx.projectImplementationStep.findFirst({ where: { taskId: task.id } });
        if (linkedStep) {
          const otherRunningSteps = await tx.projectImplementationStep.count({
            where: {
              projectId: linkedStep.projectId,
              cycleId: linkedStep.cycleId,
              status: 'running',
              id: { not: linkedStep.id }
            }
          });
          if (otherRunningSteps > 0) return false;
        }
        const now = new Date();
        await tx.task.update({
          where: { id: task.id },
          data: { status: 'submitted', waitingForCapabilities: [], startedAt: now, finishedAt: null }
        });
        if (linkedStep) {
          await tx.projectImplementationStep.update({
            where: { id: linkedStep.id },
            data: { status: 'running', completedAt: null }
          });
        }
        await tx.taskRun.create({
          data: { taskId: task.id, provider: resolveProjectProvider((await tx.project.findUnique({ where: { id: task.projectId } }))?.configYaml ?? undefined), model: 'queued', status: 'queued' }
        });
        await tx.taskQueueJob.create({
          data: { taskId: task.id, reason: 'capability_available', status: 'pending', nextAttemptAt: now }
        });
        await tx.auditLog.create({
          data: {
            actorType: 'system', eventType: 'task_capability_available', projectId: task.projectId, taskId: task.id,
            payload: { requiredCapabilities: required }
          }
        });
        return true;
      });
      if (didRequeue) requeued += 1;
    }
    return requeued;
  }

  async updateTaskGitHubFields(
    taskId: string,
    fields: {
      githubIssueNumber?: number;
      githubIssueUrl?: string;
      branchName?: string;
      pullRequestNumber?: number;
      pullRequestUrl?: string;
      status?: TaskStatus;
    }
  ): Promise<ForgeTask> {
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: fields
    });
    return toTask(updated);
  }

  async claimNextSubmittedTask(provider: ProviderKind, model = 'queued'): Promise<ClaimedTask | undefined> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(WORKER_QUEUE_ADVISORY_LOCK_SQL);
      const [workerControl] = await tx.$queryRawUnsafe<Array<{ queuePaused: boolean }>>(
        'SELECT "queue_paused" AS "queuePaused" FROM "worker_control" WHERE "id" = $1',
        WORKER_QUEUE_CONTROL_ID
      );
      if (workerControl?.queuePaused) return undefined;

      const queueJob = await tx.taskQueueJob.findFirst({
        where: {
          status: 'pending',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }]
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }]
      });
      if (!queueJob) return undefined;

      const claimedQueueJob = await tx.taskQueueJob.update({
        where: { id: queueJob.id },
        data: {
          status: 'claimed',
          claimedAt: new Date(),
          attemptCount: { increment: 1 }
        }
      });

      const queued = await tx.task.findUnique({
        where: { id: claimedQueueJob.taskId },
        include: {
          project: true,
          taskRuns: {
            where: { status: 'queued' },
            orderBy: { id: 'asc' },
            take: 1
          }
        }
      });

      if (!queued) {
        await tx.taskQueueJob.update({
          where: { id: claimedQueueJob.id },
          data: {
            status: 'failed',
            errorMessage: `Task \"${claimedQueueJob.taskId}\" not found while claiming queue job.`,
            finishedAt: new Date()
          }
        });
        return undefined;
      }

      if (queued.status !== 'submitted') {
        await tx.taskQueueJob.update({
          where: { id: claimedQueueJob.id },
          data: {
            status: queued.status === 'cancelled' ? 'cancelled' : 'failed',
            claimedAt: null,
            errorMessage: `Task "${queued.id}" is ${queued.status}; queue job was not claimed.`,
            finishedAt: new Date()
          }
        });
        return undefined;
      }

      const updated = await tx.task.update({
        where: { id: queued.id },
        data: { status: 'planning' },
        include: { project: true, architectureVersion: true }
      });

      await tx.taskRun.updateMany({
        where: {
          taskId: updated.id,
          status: 'running'
        },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorMessage: 'Worker run was superseded by a later queue claim.'
        }
      });

      const existingRun = queued.taskRuns[0];
      const taskRun = existingRun
        ? await tx.taskRun.update({
            where: { id: existingRun.id },
            data: {
              provider,
              model,
              status: 'running',
              startedAt: new Date()
            }
          })
        : await tx.taskRun.create({
            data: {
              taskId: updated.id,
              provider,
              model,
              status: 'running',
              startedAt: new Date()
            }
          });

      await tx.auditLog.create({
        data: {
          actorType: 'agent',
          eventType: 'task_claimed',
          projectId: updated.projectId,
          taskId: updated.id,
          payload: { provider, architectureVersionId: updated.architectureVersionId ?? null }
        }
      });

      const project = toProject(updated.project);
      const taskArchitecture = updated.architectureVersion
        ? toProjectArchitectureVersion(updated.architectureVersion).architecture
        : undefined;
      return {
        task: toTask(updated),
        project: taskArchitecture ? { ...project, projectArchitecture: taskArchitecture } : project,
        taskRun: toTaskRun(taskRun),
        queueJobId: claimedQueueJob.id,
        queueReason: claimedQueueJob.reason
      };
    });
  }

  async finalizeQueueJob(
    queueJobId: string | undefined,
    status: 'succeeded' | 'failed' | 'cancelled',
    errorMessage?: string,
    retryable = true
  ): Promise<void> {
    if (!queueJobId) return;

    const queueJob = await this.prisma.taskQueueJob.findUnique({
      where: { id: queueJobId },
      select: {
        id: true,
        taskId: true,
        status: true,
        attemptCount: true
      }
    });
    if (!queueJob) return;
    if (!isActiveQueueStatus(queueJob.status)) return;

    if (status === 'failed' && retryable) {
      const maxAttempts = Math.max(1, Number(process.env.FORGEMIND_QUEUE_MAX_ATTEMPTS ?? DEFAULT_QUEUE_MAX_ATTEMPTS));
      const backoffSeconds = Math.max(1, Number(process.env.FORGEMIND_QUEUE_RETRY_BACKOFF_SECONDS ?? DEFAULT_QUEUE_BACKOFF_SECONDS));
      const shouldRetry = queueJob.attemptCount < maxAttempts;

      if (shouldRetry) {
        const delaySeconds = backoffSeconds * Math.max(1, 2 ** Math.max(0, queueJob.attemptCount - 1));
        const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);
        await this.prisma.$transaction(async (tx) => {
          await tx.taskQueueJob.update({
            where: { id: queueJobId },
            data: {
              status: 'pending',
              reason: 'phase_retry',
              claimedAt: null,
              nextAttemptAt,
              errorMessage
            }
          });
          await tx.task.updateMany({
            where: {
              id: queueJob.taskId,
              status: { notIn: ['completed', 'cancelled'] }
            },
            data: {
              status: 'submitted',
              finishedAt: null
            }
          });
          await tx.auditLog.create({
            data: {
              actorType: 'system',
              eventType: 'task_queue_retry_scheduled',
              taskId: queueJob.taskId,
              payload: {
                queueJobId,
                nextAttemptAt: nextAttemptAt.toISOString(),
                errorMessage: errorMessage ?? null,
                resumeFromCheckpoint: true
              }
            }
          });
        });
        return;
      }
    }

    await this.prisma.taskQueueJob.update({
      where: { id: queueJobId },
      data: {
        status,
        claimedAt: null,
        nextAttemptAt: null,
        errorMessage,
        finishedAt: new Date()
      }
    });
  }

  async createIteration(input: {
    taskRunId: string;
    iterationNumber: number;
    phase: IterationPhase;
    prompt: string;
    resultSummary: string;
    providerPrompt?: string;
    providerResponse?: string;
    diffStat: JsonValue;
    validationResult: JsonValue;
  }): Promise<void> {
    await this.prisma.taskIteration.create({
      data: {
        taskRunId: input.taskRunId,
        iterationNumber: input.iterationNumber,
        phase: input.phase,
        prompt: sanitizePostgresText(input.prompt),
        resultSummary: sanitizePostgresText(input.resultSummary),
        providerPrompt: input.providerPrompt === undefined ? undefined : sanitizePostgresText(input.providerPrompt),
        providerResponse: input.providerResponse === undefined ? undefined : sanitizePostgresText(input.providerResponse),
        diffStatJson: toPrismaJson(input.diffStat),
        validationResultJson: toPrismaJson(input.validationResult)
      }
    });
  }

  async listTaskCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
    const checkpoints = await this.prisma.taskCheckpoint.findMany({
      where: { taskId },
      orderBy: { updatedAt: 'asc' }
    });
    return checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      taskId: checkpoint.taskId,
      taskRunId: checkpoint.taskRunId ?? undefined,
      key: checkpoint.key,
      phase: checkpoint.phase as TaskCheckpoint['phase'],
      status: checkpoint.status,
      inputHash: checkpoint.inputHash,
      output: checkpoint.outputJson === null ? undefined : checkpoint.outputJson as JsonValue,
      errorMessage: checkpoint.errorMessage ?? undefined,
      startedAt: checkpoint.startedAt.toISOString(),
      completedAt: checkpoint.completedAt?.toISOString(),
      updatedAt: checkpoint.updatedAt.toISOString()
    }));
  }

  async recordTaskCheckpoint(input: {
    taskId: string;
    taskRunId?: string;
    key: string;
    phase: TaskCheckpoint['phase'];
    status: TaskCheckpoint['status'];
    inputHash: string;
    output?: JsonValue;
    errorMessage?: string;
  }): Promise<TaskCheckpoint> {
    const now = new Date();
    const checkpoint = await this.prisma.taskCheckpoint.upsert({
      where: { taskId_key: { taskId: input.taskId, key: input.key } },
      create: {
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        key: input.key,
        phase: input.phase,
        status: input.status,
        inputHash: input.inputHash,
        outputJson: input.output === undefined ? undefined : toPrismaJson(input.output),
        errorMessage: input.errorMessage,
        startedAt: now,
        completedAt: input.status === 'completed' ? now : null
      },
      update: {
        taskRunId: input.taskRunId,
        phase: input.phase,
        status: input.status,
        inputHash: input.inputHash,
        outputJson: input.output === undefined ? undefined : toPrismaJson(input.output),
        errorMessage: input.errorMessage ?? null,
        startedAt: input.status === 'started' ? now : undefined,
        completedAt: input.status === 'completed' ? now : null
      }
    });
    return {
      id: checkpoint.id,
      taskId: checkpoint.taskId,
      taskRunId: checkpoint.taskRunId ?? undefined,
      key: checkpoint.key,
      phase: checkpoint.phase as TaskCheckpoint['phase'],
      status: checkpoint.status,
      inputHash: checkpoint.inputHash,
      output: checkpoint.outputJson === null ? undefined : checkpoint.outputJson as JsonValue,
      errorMessage: checkpoint.errorMessage ?? undefined,
      startedAt: checkpoint.startedAt.toISOString(),
      completedAt: checkpoint.completedAt?.toISOString(),
      updatedAt: checkpoint.updatedAt.toISOString()
    };
  }

  async finishTaskRun(input: {
    taskRunId: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    summary?: string;
    errorMessage?: string;
    iterationCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usageSource?: string;
    estimatedCostUsd?: number;
    actualCostUsd?: number | null;
  }): Promise<void> {
    await this.prisma.taskRun.update({
      where: { id: input.taskRunId },
      data: {
        status: input.status,
        summary: input.summary,
        errorMessage: input.errorMessage,
        iterationCount: input.iterationCount,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        usageSource: input.usageSource,
        estimatedCostUsd: input.estimatedCostUsd,
        actualCostUsd: input.actualCostUsd,
        finishedAt: new Date()
      }
    });
  }

  async updateTaskRunProvider(input: { taskRunId: string; provider: ProviderKind; model: string }): Promise<void> {
    await this.prisma.taskRun.update({
      where: { id: input.taskRunId },
      data: {
        provider: input.provider,
        model: input.model
      }
    });
  }

  async failTask(taskId: string, errorMessage: string, status: TaskStatus = 'failed'): Promise<void> {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status,
        finishedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'task_failed',
      projectId: task.projectId,
      taskId: task.id,
      payload: { errorMessage, status }
    });
  }

  async listApprovals(): Promise<Approval[]> {
    const approvals = await this.prisma.approval.findMany({
      orderBy: { createdAt: 'desc' }
    });
    return approvals.map(toApproval);
  }

  async getApproval(approvalId: string): Promise<Approval | undefined> {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    return approval ? toApproval(approval) : undefined;
  }

  async createApproval(input: {
    taskId: string;
    type: ApprovalType;
    requestedBy: Approval['requestedBy'];
    title: string;
    description: string;
    riskLevel: RiskLevel;
    payload: JsonValue;
  }): Promise<Approval> {
    const approval = await this.prisma.approval.create({
      data: {
        taskId: input.taskId,
        type: input.type,
        requestedBy: input.requestedBy,
        title: input.title,
        description: input.description,
        riskLevel: input.riskLevel,
        payloadJson: toPrismaJson(input.payload)
      }
    });

    await this.writeAudit({
      actorType: 'agent',
      eventType: 'approval_requested',
      taskId: approval.taskId,
      payload: { type: approval.type, riskLevel: approval.riskLevel }
    });

    return toApproval(approval);
  }

  async resolveApproval(approvalId: string, status: Extract<ApprovalStatus, 'approved' | 'rejected'>): Promise<Approval | undefined> {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) return undefined;
    if (approval.status !== 'pending') {
      throw new Error(`Approval "${approvalId}" is already ${approval.status}`);
    }

    const updated = await this.prisma.approval.update({
      where: { id: approvalId },
      data: {
        status,
        approvedByUserId: status === 'approved' ? LOCAL_USER_ID : null,
        resolvedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: status === 'approved' ? 'approval_approved' : 'approval_rejected',
      taskId: updated.taskId,
      payload: { approvalId }
    });

    return toApproval(updated);
  }

  async listTaskAudit(taskId: string): Promise<AuditEvent[]> {
    const events = await this.prisma.auditLog.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' }
    });
    return events.map(toAuditEvent);
  }

  async getTaskDiff(taskId: string) {
    const iterations = await this.prisma.taskIteration.findMany({
      where: {
        taskRun: {
          taskId
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    const latestRunId = iterations.at(-1)?.taskRunId;
    const latestSnapshot = [...iterations]
      .reverse()
      .find((iteration) => iteration.taskRunId === latestRunId && iteration.phase !== 'planning');
    const totals = latestSnapshot
      ? parseDiffStat(latestSnapshot.diffStatJson)
      : { filesChanged: 0, insertions: 0, deletions: 0 };

    return {
      taskId,
      ...totals,
      iterations: iterations.map((iteration) => ({
        id: iteration.id,
        taskRunId: iteration.taskRunId,
        iterationNumber: iteration.iterationNumber,
        phase: iteration.phase,
        prompt: iteration.prompt,
        resultSummary: iteration.resultSummary,
        providerPrompt: iteration.providerPrompt ?? undefined,
        providerResponse: iteration.providerResponse ?? undefined,
        diffStat: iteration.diffStatJson,
        validationResult: iteration.validationResultJson,
        createdAt: iteration.createdAt.toISOString()
      }))
    };
  }

  async getTaskUsage(taskId: string) {
    const [runs, usage] = await Promise.all([
      this.prisma.taskRun.findMany({
        where: { taskId },
        orderBy: { startedAt: 'asc' }
      }),
      this.prisma.providerUsage.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' }
      })
    ]);

    const actualUsage = usage.filter((item) => item.usageSource.startsWith('actual'));
    const estimatedUsage = usage.filter((item) => item.usageSource === 'estimated');
    const measuredUsage = actualUsage.length > 0 ? actualUsage : estimatedUsage;
    const totals = measuredUsage.reduce(
      (summary, item) => {
        summary.inputTokens += item.inputTokens;
        summary.outputTokens += item.outputTokens;
        summary.cachedTokens += item.cachedTokens;
        summary.totalTokens += item.totalTokens;
        summary.estimatedCostUsd += Number(item.estimatedCostUsd);
        return summary;
      },
      { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
    );
    const hasCompleteBreakdown = actualUsage.length > 0 && actualUsage.every((item) => item.usageSource === 'actual_breakdown');
    const actualCostAvailable = actualUsage.length > 0 && actualUsage.every((item) => item.actualCostUsd !== null);
    const actualCostUsd = actualCostAvailable
      ? actualUsage.reduce((sum, item) => sum + Number(item.actualCostUsd), 0)
      : null;
    const usageSource =
      actualUsage.length === 0
        ? (estimatedUsage.length > 0 ? 'estimated' : 'unavailable')
        : (estimatedUsage.length > 0 ? 'mixed' : (hasCompleteBreakdown ? 'actual_breakdown' : 'actual_total'));

    return {
      taskId,
      ...totals,
      inputTokens: hasCompleteBreakdown ? totals.inputTokens : 0,
      outputTokens: hasCompleteBreakdown ? totals.outputTokens : 0,
      cachedTokens: hasCompleteBreakdown ? totals.cachedTokens : 0,
      usageSource,
      actualCostUsd,
      runs: runs.map((run) => ({
        id: run.id,
        provider: run.provider,
        model: run.model,
        status: run.status,
        iterationCount: run.iterationCount,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens,
        usageSource: run.usageSource,
        estimatedCostUsd: Number(run.estimatedCostUsd),
        actualCostUsd: run.actualCostUsd === null ? null : Number(run.actualCostUsd),
        startedAt: run.startedAt?.toISOString(),
        finishedAt: run.finishedAt?.toISOString(),
        summary: run.summary,
        errorMessage: run.errorMessage
      })),
      records: usage.map((item) => ({
        id: item.id,
        provider: item.provider,
        model: item.model,
        phase: item.phase,
        attempt: item.attempt,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        cachedTokens: item.cachedTokens,
        totalTokens: item.totalTokens,
        usageSource: item.usageSource,
        estimatedCostUsd: Number(item.estimatedCostUsd),
        actualCostUsd: item.actualCostUsd === null ? null : Number(item.actualCostUsd),
        createdAt: item.createdAt.toISOString()
      }))
    };
  }

  async writeAudit(input: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent> {
    const event = await this.prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId,
        eventType: input.eventType,
        projectId: input.projectId,
        taskId: input.taskId,
        payload: toPrismaJson(input.payload)
      }
    });
    return toAuditEvent(event);
  }

  private async writeAuditTx(
    tx: Prisma.TransactionClient,
    input: Omit<AuditEvent, 'id' | 'createdAt'>
  ): Promise<AuditEvent> {
    const event = await tx.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId,
        eventType: input.eventType,
        projectId: input.projectId,
        taskId: input.taskId,
        payload: toPrismaJson(input.payload)
      }
    });
    return toAuditEvent(event);
  }

  async recordProviderUsage(input: {
    taskId: string;
    taskRunId: string;
    provider: ProviderKind;
    model: string;
    phase?: string;
    attempt?: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    totalTokens?: number;
    usageSource?: string;
    credits?: number;
    estimatedCostUsd: number;
    actualCostUsd?: number;
  }): Promise<void> {
    await this.prisma.providerUsage.create({
      data: {
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        provider: input.provider,
        model: input.model,
        phase: input.phase,
        attempt: input.attempt,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedTokens: input.cachedTokens ?? 0,
        totalTokens: input.totalTokens ?? input.inputTokens + input.outputTokens,
        usageSource: input.usageSource ?? 'estimated',
        credits: input.credits ?? 0,
        estimatedCostUsd: input.estimatedCostUsd,
        actualCostUsd: input.actualCostUsd
      }
    });
  }
}

function resolveProjectProvider(configYaml?: string): ProviderKind {
  if (!configYaml) {
    return 'codex';
  }

  try {
    return parseAgentConfigYaml(configYaml).ai.primary_provider;
  } catch {
    return 'codex';
  }
}

export function createRepository(prisma: PrismaClient): ForgeMindRepository {
  return new ForgeMindRepository(prisma);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
}

export type PrismaJsonObject = Prisma.JsonObject;

function parseActiveIterationAudit(event: AuditLog | null):
  | {
      taskRunId?: string;
      phase: 'planning' | 'implementation' | 'validation' | 'review' | 'approval' | 'pr_creation';
      attempt: number;
      prompt: string;
      providerPrompt?: string;
      startedAt: string;
    }
  | undefined {
  if (!event || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }

  const payload = event.payload as Record<string, unknown>;
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  if (!['planning', 'implementation', 'validation', 'review', 'approval', 'pr_creation'].includes(phase)) {
    return undefined;
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt) {
    return undefined;
  }

  return {
    taskRunId: typeof payload.taskRunId === 'string' ? payload.taskRunId : undefined,
    phase: phase as 'planning' | 'implementation' | 'validation' | 'review' | 'approval' | 'pr_creation',
    attempt: typeof payload.attempt === 'number' && Number.isFinite(payload.attempt) ? payload.attempt : 0,
    prompt,
    providerPrompt: typeof payload.providerPrompt === 'string' && payload.providerPrompt.length > 0 ? payload.providerPrompt : undefined,
    startedAt: event.createdAt.toISOString()
  };
}

function toGitHubConnectionSnapshot(connection: GitHubConnection): GitHubConnectionSnapshot {
  return {
    userId: connection.userId,
    credentialSource: 'token',
    apiBaseUrl: connection.apiBaseUrl,
    tokenFingerprint: connection.tokenFingerprint,
    connectedAt: connection.connectedAt.toISOString(),
    lastCheckedAt: connection.lastCheckedAt?.toISOString(),
    updatedAt: connection.updatedAt.toISOString()
  };
}

function toAIProviderConnectionSnapshot(connection: AiProviderConnection): AIProviderConnectionSnapshot {
  const authMode = connection.authMode as AIProviderAuthMode;
  return {
    id: connection.id,
    userId: connection.userId,
    name: connection.name,
    isDefault: connection.isDefault,
    credentialSource: authMode === 'codex_oauth' ? 'codex_oauth' : 'api_key',
    provider: connection.provider as AIProviderConnectionKind,
    authMode,
    model: connection.model,
    apiKeyFingerprint: connection.apiKeyFingerprint ?? undefined,
    codexHome: connection.codexHome ?? undefined,
    accountSummary: connection.accountSummary ?? undefined,
    connectedAt: connection.connectedAt.toISOString(),
    lastCheckedAt: connection.lastCheckedAt?.toISOString(),
    updatedAt: connection.updatedAt.toISOString()
  };
}

function asJsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : undefined;
}

function toProjectArchitectureUpdate(value: Prisma.JsonValue | undefined): ProjectArchitectureUpdate | undefined {
  const record = asJsonRecord(value);
  if (!record) return undefined;
  const modules = Array.isArray(record.modules) ? record.modules.flatMap((value) => {
    const module = asJsonRecord(value);
    if (!module || typeof module.name !== 'string' || typeof module.responsibility !== 'string') return [];
    return [{
      name: module.name,
      responsibility: module.responsibility,
      paths: jsonStringArray(module.paths ?? []),
      publicInterfaces: jsonStringArray(module.publicInterfaces ?? []),
      dependencies: jsonStringArray(module.dependencies ?? [])
    }];
  }) : [];
  const decisions = Array.isArray(record.decisions) ? record.decisions.flatMap((value) => {
    const decision = asJsonRecord(value);
    if (!decision || typeof decision.summary !== 'string' || typeof decision.rationale !== 'string') return [];
    return [{ summary: decision.summary, rationale: decision.rationale }];
  }) : [];

  return {
    summary: typeof record.summary === 'string' ? record.summary : undefined,
    modules,
    decisions,
    conventions: jsonStringArray(record.conventions ?? []),
    dependencyRules: jsonStringArray(record.dependencyRules ?? []),
    knownDebt: jsonStringArray(record.knownDebt ?? []),
    resolvedDebt: jsonStringArray(record.resolvedDebt ?? []),
    validationCommands: jsonStringArray(record.validationCommands ?? [])
  };
}

function buildAIProviderConnectionName(provider: AIProviderConnectionKind, authMode: AIProviderAuthMode, model: string): string {
  const providerName = provider === 'codex' ? 'Codex' : 'OpenAI';
  const authName = authMode === 'codex_oauth' ? 'OAuth' : 'API key';
  return `${providerName} ${authName} ${model}`.trim();
}

export function deriveProjectCapabilities(
  project: Project | undefined,
  cycles: ProjectRoadmapCycle[],
  steps: ProjectImplementationStep[],
  evidence: AcceptanceEvidence[]
): ProjectCapability[] {
  const contract = project?.projectContract;
  if (!contract) return [];
  const latestCycle = [...cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
  if (!latestCycle) return [];

  return activeProjectContractRequirements(contract).map((requirement) => {
    const workItems = steps.filter((step) => step.cycleId === latestCycle.id && step.requirementIds.includes(requirement.id));
    const evidenceValidFromVersion = requirement.lastChangedInVersion ?? requirement.introducedInVersion ?? contract.version;
    const currentEvidence = evidence.filter((item) =>
      item.cycleId === latestCycle.id
      && item.requirementId === requirement.id
      && item.contractVersion >= evidenceValidFromVersion
      && item.contractVersion <= contract.version
    );
    const latestAuditByCriterion = new Map<string, AcceptanceEvidence>();
    for (const item of currentEvidence.filter((candidate) => candidate.source === 'repository_audit')) {
      const current = latestAuditByCriterion.get(item.criterionKey);
      if (!current || current.updatedAt <= item.updatedAt) latestAuditByCriterion.set(item.criterionKey, item);
    }
    const criterionEvidence = requirement.acceptanceCriteria.map((criterion) => latestAuditByCriterion.get(acceptanceCriterionKey(criterion)));
    const satisfiedCriteria = criterionEvidence.filter((item) => item?.status === 'passed').length;
    const hasBlockedCriterion = criterionEvidence.some((item) => item?.status === 'blocked');
    const hasFailedCriterion = criterionEvidence.some((item) => item?.status === 'failed');
    let status: ProjectCapability['status'];
    if (hasBlockedCriterion) {
      status = 'blocked';
    } else if (satisfiedCriteria === requirement.acceptanceCriteria.length) {
      status = 'satisfied';
    } else if (hasFailedCriterion) {
      status = 'partial';
    } else if (workItems.some((item) => item.status === 'running') || workItems.some((item) => item.status === 'completed')) {
      status = workItems.every((item) => item.status === 'completed') ? 'verifying' : 'implementing';
    } else {
      status = 'pending';
    }

    return {
      requirement,
      status,
      workItemIds: workItems.map((item) => item.id),
      evidence: currentEvidence,
      satisfiedCriteria,
      totalCriteria: requirement.acceptanceCriteria.length
    };
  });
}

export function acceptanceCriterionKey(value: string): string {
  return createHash('sha256').update(value.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

export function shouldInvalidateProjectContract(existingBrief: string | null, nextBrief: string | null | undefined): boolean {
  if (nextBrief === undefined) return false;
  const normalize = (value: string | null) => (value ?? '').replace(/\r\n/g, '\n').trim();
  return normalize(existingBrief) !== normalize(nextBrief);
}

export function shouldRequeueProjectAuditAfterCompletedWork(
  auditFinishedAt: Date | null | undefined,
  latestStepCompletedAt: Date | null | undefined
): boolean {
  return Boolean(
    auditFinishedAt
    && latestStepCompletedAt
    && latestStepCompletedAt.getTime() > auditFinishedAt.getTime()
  );
}

export function mergeProjectArchitecture(
  current: ProjectArchitecture | undefined,
  update: ProjectArchitectureUpdate,
  taskId?: string,
  updatedAt = new Date().toISOString()
): ProjectArchitecture {
  const modules = new Map(
    (current?.modules ?? []).map((module) => [module.name.trim().toLowerCase(), module])
  );
  for (const module of update.modules ?? []) {
    const name = cleanArchitectureText(module.name, 120);
    const responsibility = cleanArchitectureText(module.responsibility, 600);
    if (!name || !responsibility) continue;
    modules.set(name.toLowerCase(), {
      name,
      responsibility,
      paths: uniqueArchitectureItems(module.paths, 20, 240),
      publicInterfaces: uniqueArchitectureItems(module.publicInterfaces, 20, 240),
      dependencies: uniqueArchitectureItems(module.dependencies, 20, 120)
    });
  }

  const databaseSchemas = new Map(
    (current?.databaseSchemas ?? []).map((schema) => [schema.name.trim().toLowerCase(), schema])
  );
  for (const schema of update.databaseSchemas ?? []) {
    const name = cleanArchitectureText(schema.name, 120);
    const technology = cleanArchitectureText(schema.technology, 120);
    const ownedByModule = cleanArchitectureText(schema.ownedByModule, 120);
    if (!name || !technology || !ownedByModule) continue;
    databaseSchemas.set(name.toLowerCase(), {
      name,
      technology,
      paths: uniqueArchitectureItems(schema.paths, 20, 240),
      ownedByModule,
      migrationPaths: uniqueArchitectureItems(schema.migrationPaths, 20, 240)
    });
  }

  const decisions = [...(current?.decisions ?? [])];
  for (const decision of update.decisions ?? []) {
    const summary = cleanArchitectureText(decision.summary, 400);
    const rationale = cleanArchitectureText(decision.rationale, 800);
    if (!summary || !rationale) continue;
    const id = `arch-${createHash('sha256').update(`${summary}\n${rationale}`.toLowerCase()).digest('hex').slice(0, 12)}`;
    if (decisions.some((item) => item.id === id)) continue;
    decisions.push({ id, summary, rationale, taskId, createdAt: updatedAt });
  }

  const resolvedDebt = new Set((update.resolvedDebt ?? []).map(normalizeArchitectureIdentity));
  const knownDebt = uniqueArchitectureItems([...(current?.knownDebt ?? []), ...(update.knownDebt ?? [])], 30, 500)
    .filter((item) => !resolvedDebt.has(normalizeArchitectureIdentity(item)));

  return {
    version: 1,
    summary: cleanArchitectureText(update.summary, 2_000) || current?.summary || 'Architecture is derived from completed project work.',
    modules: [...modules.values()].slice(-30),
    databaseSchemas: [...databaseSchemas.values()].slice(-20),
    decisions: decisions.slice(-30),
    conventions: uniqueArchitectureItems([...(current?.conventions ?? []), ...(update.conventions ?? [])], 30, 400),
    dependencyRules: uniqueArchitectureItems([...(current?.dependencyRules ?? []), ...(update.dependencyRules ?? [])], 30, 400),
    knownDebt,
    validationCommands: uniqueArchitectureItems([...(current?.validationCommands ?? []), ...(update.validationCommands ?? [])], 20, 500),
    updatedAt
  };
}

function cleanArchitectureText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function normalizeArchitectureIdentity(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function uniqueArchitectureItems(values: unknown[], limit: number, maxLength: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = cleanArchitectureText(value, maxLength);
    const identity = normalizeArchitectureIdentity(item);
    if (!item || seen.has(identity)) continue;
    seen.add(identity);
    result.push(item);
  }
  return result.slice(-limit);
}

function implementationStepIdentity(input: { title: string; requirementIds: string[]; deliverables: string[] }): string {
  return createHash('sha256').update(JSON.stringify({
    title: input.title.replace(/\s+/g, ' ').trim().toLowerCase(),
    requirementIds: [...input.requirementIds].sort(),
    deliverables: input.deliverables.map((item) => item.replace(/\s+/g, ' ').trim().toLowerCase()).sort()
  })).digest('hex');
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseDiffStat(value: Prisma.JsonValue): { filesChanged: number; insertions: number; deletions: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }

  const record = value as Record<string, unknown>;
  return {
    filesChanged: typeof record.filesChanged === 'number' ? record.filesChanged : 0,
    insertions: typeof record.insertions === 'number' ? record.insertions : 0,
    deletions: typeof record.deletions === 'number' ? record.deletions : 0
  };
}
