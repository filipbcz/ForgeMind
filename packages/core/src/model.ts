import type { IsoDateString, JsonValue } from '@forgemind/shared';

export type ProviderKind = 'codex' | 'github_copilot' | 'openai';

export type TaskMode = 'safe' | 'auto' | 'full_auto';

export type TaskStatus =
  | 'draft'
  | 'submitted'
  | 'planning'
  | 'waiting_for_plan_approval'
  | 'creating_github_issue'
  | 'creating_branch'
  | 'running_ai'
  | 'validating'
  | 'reviewing'
  | 'improving'
  | 'needs_approval'
  | 'creating_pr'
  | 'ready_for_user_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded'
  | 'iteration_limit_reached'
  | 'repeated_error_detected'
  | 'approval_rejected'
  | 'provider_failed'
  | 'validation_failed'
  | 'waiting_for_capability';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'retry_scheduled'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RunWaitingReason =
  | 'inactive_worker'
  | 'paused_queue'
  | 'unavailable_capability'
  | 'approval_required'
  | 'retry_backoff';

export type RunBlockedReason =
  | 'validation_failed'
  | 'provider_failed'
  | 'approval_rejected'
  | 'budget_exceeded'
  | 'iteration_limit_reached'
  | 'repeated_error_detected'
  | 'worker_limit'
  | 'manual_review_required'
  | 'unknown';

export interface RunningRunState {
  version: 1;
  status: 'running';
  reason?: never;
  detail?: string;
}

export interface WaitingRunState {
  version: 1;
  status: 'waiting';
  reason: RunWaitingReason;
  detail?: string;
  requiredCapabilities?: string[];
  nextAttemptAt?: IsoDateString;
}

export interface RetryScheduledRunState {
  version: 1;
  status: 'retry_scheduled';
  reason: Extract<RunWaitingReason, 'retry_backoff'>;
  detail?: string;
  nextAttemptAt?: IsoDateString;
}

export interface BlockedRunState {
  version: 1;
  status: 'blocked';
  reason: RunBlockedReason;
  detail?: string;
}

export interface FailedRunState {
  version: 1;
  status: 'failed';
  reason?: RunBlockedReason;
  detail?: string;
}

export interface CompletedRunState {
  version: 1;
  status: 'succeeded' | 'cancelled' | 'queued';
  reason?: never;
  detail?: string;
}

export type TaskRunState =
  | RunningRunState
  | WaitingRunState
  | RetryScheduledRunState
  | BlockedRunState
  | FailedRunState
  | CompletedRunState;

export function createRunningRunState(detail?: string): RunningRunState {
  return detail ? { version: 1, status: 'running', detail } : { version: 1, status: 'running' };
}

export function createWaitingRunState(
  reason: RunWaitingReason,
  input: { detail?: string; requiredCapabilities?: string[]; nextAttemptAt?: IsoDateString } = {}
): WaitingRunState {
  return {
    version: 1,
    status: 'waiting',
    reason,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.requiredCapabilities?.length ? { requiredCapabilities: input.requiredCapabilities } : {}),
    ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {})
  };
}

export function createRetryScheduledRunState(
  input: { detail?: string; nextAttemptAt?: IsoDateString } = {}
): RetryScheduledRunState {
  return {
    version: 1,
    status: 'retry_scheduled',
    reason: 'retry_backoff',
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {})
  };
}

export function createBlockedRunState(reason: RunBlockedReason, detail?: string): BlockedRunState {
  return {
    version: 1,
    status: 'blocked',
    reason,
    ...(detail ? { detail } : {})
  };
}

export function createFailedRunState(reason?: RunBlockedReason, detail?: string): FailedRunState {
  return {
    version: 1,
    status: 'failed',
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {})
  };
}

export function normalizeRunState(status: RunStatus, input: {
  reason?: RunWaitingReason | RunBlockedReason;
  detail?: string;
  requiredCapabilities?: string[];
  nextAttemptAt?: IsoDateString;
} = {}): TaskRunState {
  if (status === 'running') return createRunningRunState(input.detail);
  if (status === 'waiting') {
    return createWaitingRunState(isRunWaitingReason(input.reason) ? input.reason : 'inactive_worker', input);
  }
  if (status === 'retry_scheduled') return createRetryScheduledRunState(input);
  if (status === 'blocked') {
    return createBlockedRunState(isRunBlockedReason(input.reason) ? input.reason : 'unknown', input.detail);
  }
  if (status === 'failed') {
    return createFailedRunState(isRunBlockedReason(input.reason) ? input.reason : undefined, input.detail);
  }
  return { version: 1, status, ...(input.detail ? { detail: input.detail } : {}) };
}

export function parseTaskRunState(value: JsonValue | undefined, fallback: TaskRunState): TaskRunState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, JsonValue>;
  if (record.version !== 1 || typeof record.status !== 'string') return fallback;
  const detail = typeof record.detail === 'string' ? record.detail : undefined;
  if (record.status === 'running') return createRunningRunState(detail);
  if (record.status === 'waiting') {
    if (!isRunWaitingReason(record.reason)) return fallback;
    return createWaitingRunState(record.reason, {
      detail,
      requiredCapabilities: Array.isArray(record.requiredCapabilities)
        ? record.requiredCapabilities.filter((item): item is string => typeof item === 'string')
        : undefined,
      nextAttemptAt: typeof record.nextAttemptAt === 'string' ? record.nextAttemptAt : undefined
    });
  }
  if (record.status === 'retry_scheduled') {
    return createRetryScheduledRunState({
      detail,
      nextAttemptAt: typeof record.nextAttemptAt === 'string' ? record.nextAttemptAt : undefined
    });
  }
  if (record.status === 'blocked') {
    if (!isRunBlockedReason(record.reason)) return fallback;
    return createBlockedRunState(record.reason, detail);
  }
  if (record.status === 'failed') {
    return createFailedRunState(isRunBlockedReason(record.reason) ? record.reason : undefined, detail);
  }
  if (record.status === 'queued' || record.status === 'succeeded' || record.status === 'cancelled') {
    return normalizeRunState(record.status, { detail });
  }
  return fallback;
}

export function getRunStateLabel(state: TaskRunState): string {
  if (state.status === 'retry_scheduled') return 'Retry scheduled';
  return state.status.replaceAll('_', ' ');
}

export function getRunStateDetail(state: TaskRunState): string | undefined {
  if (state.detail) return state.detail;
  if (state.status === 'waiting') {
    if (state.reason === 'inactive_worker') return 'Waiting for an active worker.';
    if (state.reason === 'paused_queue') return 'Waiting because the worker queue is paused.';
    if (state.reason === 'unavailable_capability') {
      const suffix = state.requiredCapabilities?.length ? `: ${state.requiredCapabilities.join(', ')}` : '.';
      return `Waiting for unavailable capability${suffix}`;
    }
    if (state.reason === 'approval_required') return 'Waiting for approval.';
    return 'Waiting for retry backoff.';
  }
  if (state.status === 'retry_scheduled') return 'Retry is scheduled after backoff.';
  if (state.status === 'blocked' || state.status === 'failed') {
    return state.reason ? state.reason.replaceAll('_', ' ') : undefined;
  }
  return undefined;
}

function isRunWaitingReason(value: unknown): value is RunWaitingReason {
  return value === 'inactive_worker'
    || value === 'paused_queue'
    || value === 'unavailable_capability'
    || value === 'approval_required'
    || value === 'retry_backoff';
}

function isRunBlockedReason(value: unknown): value is RunBlockedReason {
  return value === 'validation_failed'
    || value === 'provider_failed'
    || value === 'approval_rejected'
    || value === 'budget_exceeded'
    || value === 'iteration_limit_reached'
    || value === 'repeated_error_detected'
    || value === 'worker_limit'
    || value === 'manual_review_required'
    || value === 'unknown';
}

export type IterationPhase =
  | 'planning'
  | 'implementation'
  | 'validation'
  | 'review'
  | 'approval'
  | 'pr_creation';

export type TaskActivityPhase =
  | 'workspace'
  | 'planning'
  | 'implementation'
  | 'validation'
  | 'review'
  | 'git'
  | 'github'
  | 'completion';

export type TaskActivityState = 'started' | 'progress' | 'completed' | 'failed';

export interface TaskActivity {
  phase: TaskActivityPhase;
  state: TaskActivityState;
  title: string;
  detail?: string;
  operation?: string;
  attempt?: number;
  elapsedMs?: number;
  exitCode?: number;
  metadata?: JsonValue;
}

export type ApprovalType =
  | 'budget_increase'
  | 'continue_after_iteration_limit'
  | 'new_dependency'
  | 'risky_refactor'
  | 'database_migration'
  | 'config_change'
  | 'deploy_staging'
  | 'deploy_production'
  | 'merge_pr'
  | 'delete_files'
  | 'github_workflow_change'
  | 'systemd_change'
  | 'nginx_config_change'
  | 'write_outside_repo';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface Limits {
  maxIterations: number;
  maxRuntimeMinutes: number;
  maxChangedFiles: number;
  maxDiffLines: number;
  maxRepeatedErrorCount: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  githubOwner?: string;
  githubRepo?: string;
  defaultBranch: string;
  configYaml?: string;
  brief?: string;
  projectContract?: ProjectContract;
  currentContractVersionId?: string;
  projectMemory?: ProjectMemory;
  projectArchitecture?: ProjectArchitecture;
  currentArchitectureVersionId?: string;
  validationProfile?: ProjectValidationProfile;
  planningSessionId?: string;
  planningSessionProvider?: ProviderKind;
  planningSessionModel?: string;
  planningSessionConnectionId?: string;
  planningSessionUpdatedAt?: IsoDateString;
  autoCreatePullRequest?: boolean;
  autoMergePullRequest?: boolean;
  autoCompleteTask?: boolean;
  allowSafeOperationsWithoutApproval?: boolean;
  defaultTaskMode?: TaskMode;
  aiProviderConnectionId?: string;
  isActive: boolean;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export type ValidationCheckCategory = 'setup' | 'build' | 'database' | 'api' | 'browser' | 'smoke';

export interface ProjectValidationProfile {
  version: 1;
  enabled: boolean;
  dockerComposeFiles: string[];
  dockerComposeServices: string[];
  requiredEnvironmentVariables: string[];
  migrationCommands: string[];
  readinessCommands: string[];
  commandTimeoutMinutes: number;
}

export type TaskCheckpointStatus = 'started' | 'completed' | 'failed';

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  taskRunId?: string;
  key: string;
  phase: TaskActivityPhase;
  status: TaskCheckpointStatus;
  inputHash: string;
  output?: JsonValue;
  errorMessage?: string;
  startedAt: IsoDateString;
  completedAt?: IsoDateString;
  updatedAt: IsoDateString;
}

export interface ProjectMemoryEntry {
  taskId: string;
  title: string;
  summary: string;
  changedFiles: string[];
  commitSha?: string;
  completedAt: IsoDateString;
}

export interface ProjectMemory {
  version: 1;
  contractVersion?: number;
  baseCommitSha?: string;
  recentWork: ProjectMemoryEntry[];
  updatedAt: IsoDateString;
}

export interface ProjectArchitectureModule {
  name: string;
  responsibility: string;
  paths: string[];
  publicInterfaces: string[];
  dependencies: string[];
}

export interface ProjectArchitectureDatabaseSchema {
  name: string;
  technology: string;
  paths: string[];
  ownedByModule: string;
  migrationPaths: string[];
}

export interface ProjectArchitectureDecision {
  id: string;
  summary: string;
  rationale: string;
  taskId?: string;
  createdAt: IsoDateString;
}

export interface ProjectArchitecture {
  version: 1;
  summary: string;
  modules: ProjectArchitectureModule[];
  databaseSchemas?: ProjectArchitectureDatabaseSchema[];
  decisions: ProjectArchitectureDecision[];
  conventions: string[];
  dependencyRules: string[];
  knownDebt: string[];
  validationCommands: string[];
  updatedAt: IsoDateString;
}

export interface ProjectArchitectureUpdate {
  summary?: string;
  modules?: ProjectArchitectureModule[];
  databaseSchemas?: ProjectArchitectureDatabaseSchema[];
  decisions?: Array<{ summary: string; rationale: string }>;
  conventions?: string[];
  dependencyRules?: string[];
  knownDebt?: string[];
  resolvedDebt?: string[];
  validationCommands?: string[];
}

export type ProjectArchitectureVersionSource =
  | 'initial_plan'
  | 'approved_extension'
  | 'task_update'
  | 'legacy_import';

export interface ProjectArchitectureVersion {
  id: string;
  projectId: string;
  version: number;
  architecture: ProjectArchitecture;
  architectureUpdate?: ProjectArchitectureUpdate;
  changeSummary: string;
  source: ProjectArchitectureVersionSource;
  parentVersionId?: string;
  contractVersionId?: string;
  sourceTaskId?: string;
  createdAt: IsoDateString;
}

export interface ProjectArchitectureSnapshot {
  projectId: string;
  current?: ProjectArchitectureVersion;
  versions: ProjectArchitectureVersion[];
}

export type ProjectContractRequirementStatus = 'active' | 'superseded' | 'removed';

export interface ProjectContractRequirementDraft {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  briefReferences?: string[];
}

export interface ProjectContractRequirement extends ProjectContractRequirementDraft {
  status?: ProjectContractRequirementStatus;
  introducedInVersion?: number;
  lastChangedInVersion?: number;
  supersededByRequirementId?: string;
  lifecycleReason?: string;
}

export interface ProjectContract {
  version: number;
  sourceBriefHash?: string;
  sourceBriefSnapshot?: string;
  summary: string;
  invariants: string[];
  prohibitedSubstitutes: string[];
  requirements: ProjectContractRequirement[];
  releaseCriteria: string[];
}

export interface ProjectContractRequirementUpdate {
  id: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  briefReferences?: string[];
  rationale: string;
}

export interface ProjectContractRequirementSupersession {
  id: string;
  replacement: ProjectContractRequirementDraft;
  rationale: string;
}

export interface ProjectContractRequirementRemoval {
  id: string;
  rationale: string;
}

export interface ProjectContractStringRemoval {
  value: string;
  rationale: string;
}

export interface ProjectContractCollectionDelta {
  add: string[];
  remove: ProjectContractStringRemoval[];
}

export interface ProjectContractDelta {
  baseVersion: number;
  summary?: string;
  addRequirements: ProjectContractRequirementDraft[];
  updateRequirements: ProjectContractRequirementUpdate[];
  supersedeRequirements: ProjectContractRequirementSupersession[];
  removeRequirements: ProjectContractRequirementRemoval[];
  invariantChanges: ProjectContractCollectionDelta;
  prohibitedSubstituteChanges: ProjectContractCollectionDelta;
  releaseCriteriaChanges: ProjectContractCollectionDelta;
  migrationImpacts: string[];
  compatibilityImpacts: string[];
}

export type ProjectContractVersionSource = 'initial_plan' | 'approved_extension' | 'manual_regeneration';

export interface ProjectContractVersion {
  id: string;
  projectId: string;
  specificationVersionId?: string;
  version: number;
  contract: ProjectContract;
  contractDelta?: ProjectContractDelta;
  changeSummary: string;
  source: ProjectContractVersionSource;
  parentVersionId?: string;
  createdAt: IsoDateString;
}

export interface ProjectContractSnapshot {
  projectId: string;
  current?: ProjectContractVersion;
  versions: ProjectContractVersion[];
}

export type AcceptanceEvidenceSource = 'validation_command' | 'github_check' | 'repository_audit' | 'artifact';
export type AcceptanceEvidenceStatus = 'passed' | 'failed' | 'blocked' | 'deferred';

export interface AcceptanceEvidence {
  id: string;
  projectId: string;
  cycleId: string;
  stepId?: string;
  taskId?: string;
  taskRunId?: string;
  requirementId: string;
  criterionKey: string;
  criterion: string;
  source: AcceptanceEvidenceSource;
  status: AcceptanceEvidenceStatus;
  evidenceKey: string;
  contractVersion: number;
  commitSha?: string;
  command?: string;
  exitCode?: number;
  detailsUrl?: string;
  payload: Record<string, unknown>;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export type ProjectCapabilityStatus = 'pending' | 'implementing' | 'verifying' | 'partial' | 'blocked' | 'satisfied';

export interface ProjectCapability {
  requirement: ProjectContractRequirement;
  status: ProjectCapabilityStatus;
  workItemIds: string[];
  evidence: AcceptanceEvidence[];
  satisfiedCriteria: number;
  totalCriteria: number;
}

export type ProjectRoadmapCycleStatus =
  | 'active'
  | 'verifying'
  | 'partial'
  | 'blocked'
  | 'awaiting_extension_approval'
  | 'completed';

export type ProjectAuditJobStatus = 'pending' | 'claimed' | 'succeeded' | 'blocked' | 'failed';

export interface ProjectAuditJob {
  id: string;
  projectId: string;
  cycleId: string;
  triggerTaskId?: string;
  requirementIds: string[];
  status: ProjectAuditJobStatus;
  attemptCount: number;
  nextAttemptAt?: IsoDateString;
  errorMessage?: string;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  claimedAt?: IsoDateString;
  finishedAt?: IsoDateString;
}

export type ProjectImplementationStepStatus = 'pending' | 'running' | 'waiting_for_capability' | 'completed' | 'cancelled';

export interface ProjectRoadmapCycle {
  id: string;
  projectId: string;
  specificationVersionId?: string;
  contractVersionId?: string;
  architectureVersionId?: string;
  cycleNumber: number;
  objective: string;
  extensionProposal?: string;
  status: ProjectRoadmapCycleStatus;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  completedAt?: IsoDateString;
}

export type ProjectSpecificationSource = 'initial_brief' | 'approved_extension' | 'manual_revision';

export interface ProjectSpecificationVersion {
  id: string;
  projectId: string;
  version: number;
  fullSpecification: string;
  changeSummary: string;
  source: ProjectSpecificationSource;
  parentVersionId?: string;
  sourceCycleId?: string;
  approvedAt?: IsoDateString;
  createdAt: IsoDateString;
}

export interface ProjectSpecificationSnapshot {
  projectId: string;
  current: ProjectSpecificationVersion;
  versions: ProjectSpecificationVersion[];
}

export interface ProjectImplementationStep {
  id: string;
  projectId: string;
  cycleId: string;
  sequenceNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requirementIds: string[];
  deliverables: string[];
  changeRationale: string;
  dependsOnStepTitles: string[];
  validationFocus: Array<'implementation' | 'migration' | 'compatibility' | 'regression'>;
  status: ProjectImplementationStepStatus;
  taskId?: string;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  completedAt?: IsoDateString;
}

export interface ForgeTask {
  id: string;
  projectId: string;
  createdByUserId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  waitingForCapabilities?: string[];
  deferredValidationCapabilities?: string[];
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  branchName?: string;
  architectureVersionId?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  providerSessionId?: string;
  providerSessionProvider?: ProviderKind;
  providerSessionModel?: string;
  providerSessionConnectionId?: string;
  providerSessionUpdatedAt?: IsoDateString;
  maxIterations: number;
  maxBudgetUsd: number;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  startedAt?: IsoDateString;
  finishedAt?: IsoDateString;
}

export interface TaskRun {
  id: string;
  taskId: string;
  provider: ProviderKind;
  model: string;
  status: RunStatus;
  state: TaskRunState;
  iterationCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageSource: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  startedAt?: IsoDateString;
  finishedAt?: IsoDateString;
  summary?: string;
  errorMessage?: string;
}

export interface TaskIteration {
  id: string;
  taskRunId: string;
  iterationNumber: number;
  phase: IterationPhase;
  prompt: string;
  resultSummary: string;
  providerPrompt?: string;
  providerResponse?: string;
  diffStat: JsonValue;
  validationResult: JsonValue;
  createdAt: IsoDateString;
}

export interface Approval {
  id: string;
  taskId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedBy: 'system' | 'agent' | 'user';
  approvedByUserId?: string;
  title: string;
  description: string;
  riskLevel: RiskLevel;
  payload: JsonValue;
  createdAt: IsoDateString;
  resolvedAt?: IsoDateString;
}

export interface AuditEvent {
  id: string;
  actorType: 'user' | 'agent' | 'system' | 'github';
  actorId?: string;
  eventType: string;
  projectId?: string;
  taskId?: string;
  payload: JsonValue;
  createdAt: IsoDateString;
}
