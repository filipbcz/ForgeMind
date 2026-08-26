import type {
  AcceptanceEvidenceSource,
  AcceptanceEvidenceStatus,
  ProjectAuditJobStatus,
  ProjectCapabilityStatus,
  ProjectImplementationStepStatus as CoreProjectImplementationStepStatus,
  ProjectRoadmapCycleStatus as CoreProjectRoadmapCycleStatus,
  ProjectSpecificationSource,
  ProviderConnectionRuntimeStatus,
  TaskRunState
} from '@forgemind/core';

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

export interface ProjectApi {
  id: string;
  name: string;
  slug: string;
  githubOwner?: string;
  githubRepo?: string;
  defaultBranch: string;
  configYaml?: string;
  brief?: string;
  projectContract?: ProjectContractApi;
  currentContractVersionId?: string;
  currentArchitectureVersionId?: string;
  validationProfile?: ProjectValidationProfileApi;
  autoCreatePullRequest: boolean;
  autoMergePullRequest: boolean;
  autoCompleteTask: boolean;
  allowSafeOperationsWithoutApproval: boolean;
  defaultTaskMode: 'safe' | 'auto' | 'full_auto';
  aiProviderConnectionId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectValidationProfileApi {
  version: 1;
  enabled: boolean;
  dockerComposeFiles: string[];
  dockerComposeServices: string[];
  requiredEnvironmentVariables: string[];
  migrationCommands: string[];
  readinessCommands: string[];
  commandTimeoutMinutes: number;
}

export interface ProjectContractApi {
  version: number;
  sourceBriefHash?: string;
  sourceBriefSnapshot?: string;
  summary: string;
  invariants: string[];
  prohibitedSubstitutes: string[];
  requirements: ProjectContractRequirementApi[];
  releaseCriteria: string[];
}

export interface ProjectContractRequirementApi {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  briefReferences?: string[];
  status?: 'active' | 'superseded' | 'removed';
  introducedInVersion?: number;
  lastChangedInVersion?: number;
  supersededByRequirementId?: string;
  lifecycleReason?: string;
}

export interface ProjectContractDeltaApi {
  baseVersion: number;
  summary?: string;
  addRequirements: ProjectContractRequirementApi[];
  updateRequirements: Array<Partial<ProjectContractRequirementApi> & { id: string; rationale: string }>;
  supersedeRequirements: Array<{ id: string; replacement: ProjectContractRequirementApi; rationale: string }>;
  removeRequirements: Array<{ id: string; rationale: string }>;
  invariantChanges: ProjectContractCollectionDeltaApi;
  prohibitedSubstituteChanges: ProjectContractCollectionDeltaApi;
  releaseCriteriaChanges: ProjectContractCollectionDeltaApi;
  migrationImpacts: string[];
  compatibilityImpacts: string[];
}

export interface ProjectContractCollectionDeltaApi {
  add: string[];
  remove: Array<{ value: string; rationale: string }>;
}

export interface ProjectContractVersionApi {
  id: string;
  projectId: string;
  specificationVersionId?: string;
  version: number;
  contract: ProjectContractApi;
  contractDelta?: ProjectContractDeltaApi;
  changeSummary: string;
  source: 'initial_plan' | 'approved_extension' | 'manual_regeneration';
  parentVersionId?: string;
  createdAt: string;
}

export interface ProjectContractSnapshotApi {
  projectId: string;
  current?: ProjectContractVersionApi;
  versions: ProjectContractVersionApi[];
}

export interface ProjectArchitectureApi {
  version: 1;
  summary: string;
  modules: Array<{
    name: string;
    responsibility: string;
    paths: string[];
    publicInterfaces: string[];
    dependencies: string[];
  }>;
  databaseSchemas?: Array<{
    name: string;
    technology: string;
    paths: string[];
    ownedByModule: string;
    migrationPaths: string[];
  }>;
  decisions: Array<{ id: string; summary: string; rationale: string; taskId?: string; createdAt: string }>;
  conventions: string[];
  dependencyRules: string[];
  knownDebt: string[];
  validationCommands: string[];
  updatedAt: string;
}

export interface ProjectArchitectureVersionApi {
  id: string;
  projectId: string;
  version: number;
  architecture: ProjectArchitectureApi;
  changeSummary: string;
  source: 'initial_plan' | 'approved_extension' | 'task_update' | 'legacy_import';
  parentVersionId?: string;
  contractVersionId?: string;
  sourceTaskId?: string;
  createdAt: string;
}

export interface ProjectArchitectureSnapshotApi {
  projectId: string;
  current?: ProjectArchitectureVersionApi;
  versions: ProjectArchitectureVersionApi[];
}

export type ProjectRoadmapCycleStatus = CoreProjectRoadmapCycleStatus;

export interface ProjectAuditJobApi {
  id: string;
  projectId: string;
  cycleId: string;
  triggerTaskId?: string;
  requirementIds: string[];
  status: ProjectAuditJobStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  finishedAt?: string;
}
export type ProjectImplementationStepStatus = CoreProjectImplementationStepStatus;

export interface ProjectRoadmapCycleApi {
  id: string;
  projectId: string;
  cycleNumber: number;
  objective: string;
  specificationVersionId?: string;
  contractVersionId?: string;
  architectureVersionId?: string;
  extensionProposal?: string;
  status: ProjectRoadmapCycleStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type ProjectSpecificationSourceApi = ProjectSpecificationSource;

export interface ProjectSpecificationVersionApi {
  id: string;
  projectId: string;
  version: number;
  fullSpecification: string;
  changeSummary: string;
  source: ProjectSpecificationSourceApi;
  parentVersionId?: string;
  sourceCycleId?: string;
  approvedAt?: string;
  createdAt: string;
}

export interface ProjectSpecificationSnapshotApi {
  projectId: string;
  current: ProjectSpecificationVersionApi;
  versions: ProjectSpecificationVersionApi[];
}

export interface SpecificationChangeImpactReviewApi {
  projectId: string;
  baseSpecificationVersion?: number;
  baseSpecificationHash?: string;
  changed: boolean;
  diff: Array<{
    type: 'unchanged' | 'added' | 'removed';
    oldLineNumber?: number;
    newLineNumber?: number;
    text: string;
  }>;
  impact: {
    requirements: Array<{ id: string; title: string; reason: string }>;
    unfinishedSteps: Array<{
      id: string;
      title: string;
      status: ProjectImplementationStepStatus;
      requirementIds: string[];
    }>;
    evidence: Array<{
      id: string;
      requirementId: string;
      criterion: string;
      status: AcceptanceEvidenceApi['status'];
      contractVersion: number;
      source: AcceptanceEvidenceApi['source'];
    }>;
  };
}

export interface ProjectImplementationStepApi {
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
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ProjectRoadmapApi {
  projectId: string;
  cycles: ProjectRoadmapCycleApi[];
  steps: ProjectImplementationStepApi[];
  evidence: AcceptanceEvidenceApi[];
  capabilities: ProjectCapabilityApi[];
  auditJobs: ProjectAuditJobApi[];
}

export interface AcceptanceEvidenceApi {
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
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCapabilityApi {
  requirement: ProjectContractApi['requirements'][number];
  status: ProjectCapabilityStatus;
  workItemIds: string[];
  evidence: AcceptanceEvidenceApi[];
  satisfiedCriteria: number;
  totalCriteria: number;
}

export interface TaskApi {
  id: string;
  projectId: string;
  createdByUserId: string;
  title: string;
  prompt: string;
  mode: 'safe' | 'auto' | 'full_auto';
  status: TaskStatus;
  waitingForCapabilities?: string[];
  deferredValidationCapabilities?: string[];
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
}

export interface ApprovalApi {
  id: string;
  taskId: string;
  type: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedBy: 'system' | 'agent' | 'user';
  approvedByUserId?: string;
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  payload: unknown;
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditEventApi {
  id: string;
  actorType: 'user' | 'agent' | 'system' | 'github';
  actorId?: string;
  eventType: string;
  projectId?: string;
  taskId?: string;
  payload: unknown;
  createdAt: string;
}

export interface TaskDiffApi {
  taskId: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  iterations: Array<{
    id: string;
    taskRunId: string;
    iterationNumber: number;
    phase: string;
    prompt: string;
    resultSummary: string;
    providerPrompt?: string;
    providerResponse?: string;
    diffStat: unknown;
    validationResult: unknown;
    createdAt: string;
  }>;
}

export interface TaskUsageApi {
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  usageSource: 'actual_total' | 'actual_breakdown' | 'estimated' | 'mixed' | 'unavailable';
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  runs: Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    state: TaskRunState;
    iterationCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    usageSource: string;
    estimatedCostUsd: number;
    actualCostUsd: number | null;
    startedAt?: string;
    finishedAt?: string;
    summary?: string | null;
    errorMessage?: string | null;
  }>;
  records: Array<{
    id: string;
    provider: string;
    model: string;
    phase?: string | null;
    attempt?: number | null;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    totalTokens: number;
    usageSource: string;
    estimatedCostUsd: number;
    actualCostUsd: number | null;
    createdAt: string;
  }>;
}

export interface TaskQueueApi {
  taskId: string;
  queueDepth: number;
  queuePosition: number | null;
}

export interface WorkerStatusApi {
  state: 'idle' | 'running';
  runState: TaskRunState;
  queuePaused: boolean;
  queuePausedAt?: string;
  queuedTaskCount: number;
  activeTaskCount: number;
  runningRun?: {
    id: string;
    taskId: string;
    provider: string;
    model: string;
    startedAt?: string;
  };
  activeIteration?: {
    taskId: string;
    taskRunId?: string;
    phase: string;
    attempt: number;
    prompt: string;
    providerPrompt?: string;
    startedAt: string;
  };
  lastCompletedRun?: {
    id: string;
    taskId: string;
    provider: string;
    model: string;
    finishedAt?: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    summary?: string;
    errorMessage?: string;
  };
  updatedAt: string;
}

export interface WorkerEventApi {
  id: string;
  actorType: 'user' | 'agent' | 'system' | 'github';
  eventType: string;
  taskId?: string;
  payload?: unknown;
  createdAt: string;
}

export interface RealtimeAuditEventMessage {
  type: 'audit_event';
  event: AuditEventApi;
}

export interface RealtimeConnectedMessage {
  type: 'connected';
  taskId?: string;
}

export interface RealtimeHeartbeatMessage {
  type: 'heartbeat';
  sentAt: string;
}

export type RealtimeMessage = RealtimeConnectedMessage | RealtimeHeartbeatMessage | RealtimeAuditEventMessage;

export interface NotificationSubscriptionApi {
  id: string;
  userId: string;
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  deviceName?: string;
  createdAt: string;
}

export interface NotificationSettingsApi {
  userId: string;
  settings: {
    pushEnabled: boolean;
    approvalRequests: boolean;
    taskUpdates: boolean;
    budgetAlerts: boolean;
  };
  subscriptions: NotificationSubscriptionApi[];
}

export interface NotificationSubscriptionRequest {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  deviceName?: string;
}

export interface GitHubAdapterStatusApi {
  adapter: 'none' | 'app';
  configured: boolean;
  credentialSource: 'token' | 'github_app' | 'none';
  apiBaseUrl: string;
  missing: string[];
  persistent?: boolean;
  tokenFingerprint?: string;
  connectedAt?: string;
  lastCheckedAt?: string;
}

export interface GitHubAdapterConnectRequest {
  token: string;
  apiBaseUrl?: string;
}

export interface GitHubAdapterConnectResponse {
  ok: boolean;
  status: GitHubAdapterStatusApi;
  check: {
    ok: true;
    apiBaseUrl: string;
    credentialSource: 'token';
    repository?: {
      fullName: string;
      owner: string;
      repo: string;
      defaultBranch: string;
      private: boolean;
      htmlUrl?: string;
    };
    rateLimit?: {
      limit: number;
      remaining: number;
    };
  };
}

export interface GitHubRepositoryApi {
  fullName: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl?: string;
}

export interface GitHubRepositoryOwnerApi {
  login: string;
  kind: 'user' | 'organization';
  avatarUrl?: string;
  description?: string;
}

export interface GitHubBranchApi {
  name: string;
  sha: string;
  protected: boolean;
}

export interface ProviderStatusApi {
  currentProvider: 'openai' | 'codex' | 'github_copilot' | string | null;
  currentModel: string | null;
  currentConnectionId: string | null;
  currentRuntimeStatus: ProviderConnectionRuntimeStatus | null;
  connections: ProviderConnectionApi[];
  fallbackProvider: 'openai' | 'codex' | 'github_copilot' | string | null;
  githubAdapter: string;
  availableProviders: string[];
  persistent: boolean;
  credentialSource: 'api_key' | 'codex_oauth' | 'env' | 'none' | string;
  authMode: 'api_key' | 'codex_oauth' | null;
  apiKeyFingerprint: string | null;
  codexHome: string | null;
  accountSummary: string | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  configured: {
    openai: boolean;
    codex: boolean;
    github_copilot?: boolean;
  };
  models: {
    openai: string | null;
    codex: string | null;
    github_copilot?: string | null;
  };
  apiBaseUrls: {
    openai: string | null;
    codex: string | null;
    github_copilot?: string | null;
  };
}

export interface ProviderConnectionApi {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  credentialSource: 'api_key' | 'codex_oauth' | string;
  provider: 'openai' | 'codex' | 'github_copilot';
  authMode: 'api_key' | 'codex_oauth';
  model: string;
  apiKeyFingerprint?: string;
  codexHome?: string;
  accountSummary?: string;
  available?: boolean | null;
  availability?: 'available' | 'reauthentication_required' | 'status_unavailable';
  runtimeStatus?: ProviderConnectionRuntimeStatus | null;
  connectedAt: string;
  lastCheckedAt?: string;
  updatedAt: string;
}

export interface ProviderConnectRequest {
  connectionId?: string;
  name?: string;
  isDefault?: boolean;
  provider: 'openai' | 'codex' | 'github_copilot';
  authMode?: 'api_key' | 'codex_oauth';
  apiKey?: string;
  model: string;
}

export interface ProviderConnectResponse {
  ok: boolean;
  connectionId: string;
  name: string;
  provider: string;
  model: string;
  authMode: 'api_key' | 'codex_oauth';
  persistent: boolean;
  estimate: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

export interface ProviderModelOption {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface ProviderModelsRequest {
  provider: ProviderConnectRequest['provider'];
  apiKey?: string;
  connectionId?: string;
  loginId?: string;
}

export interface ProviderModelsResponse {
  provider: ProviderConnectRequest['provider'];
  connectionId?: string;
  loginId?: string;
  models: ProviderModelOption[];
}

export interface CodexOAuthStartResponse {
  loginId: string;
  authFlow: 'browser';
  startedAt: string;
  loginUrl?: string;
  codexHome: string;
}

export interface CodexOAuthCompleteResponse {
  ok: boolean;
  completed: boolean;
  connectionId?: string;
  name?: string;
  provider?: string;
  model?: string;
  authMode?: 'codex_oauth';
  persistent?: boolean;
  loginId?: string;
  authFlow?: 'browser';
  startedAt?: string;
  loginUrl?: string;
  codexHome?: string;
}

export interface CodexOAuthStatusResponse {
  completed: boolean;
  success: boolean;
  errorOutput?: string;
  status: {
    loggedIn: boolean;
    rawOutput?: string;
  };
}

export interface CreateTaskRequest {
  projectId: string;
  title: string;
  prompt: string;
  priority?: 'low' | 'medium' | 'high';
  scopeFiles?: string[];
  acceptanceCriteria?: string[];
  runtimeSummary?: string;
  mode: TaskApi['mode'];
  maxIterations: number;
  maxBudgetUsd: number;
}

export interface CreateProjectRequest {
  name: string;
  slug: string;
  githubOwner?: string;
  githubRepo?: string;
  defaultBranch: string;
  configYaml?: string;
  brief?: string;
  validationProfile?: ProjectValidationProfileApi;
  autoCreatePullRequest?: boolean;
  autoMergePullRequest?: boolean;
  autoCompleteTask?: boolean;
  allowSafeOperationsWithoutApproval?: boolean;
  defaultTaskMode?: TaskApi['mode'];
  aiProviderConnectionId?: string | null;
  repositoryMode?: 'existing' | 'create';
  branchMode?: 'existing' | 'create';
  branchName?: string;
  repositoryPrivate?: boolean;
  repositoryDescription?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  slug?: string;
  githubOwner?: string;
  githubRepo?: string;
  defaultBranch?: string;
  configYaml?: string;
  brief?: string | null;
  specificationReview?: {
    baseSpecificationVersion?: number;
    baseSpecificationHash?: string;
  };
  validationProfile?: ProjectValidationProfileApi | null;
  autoCreatePullRequest?: boolean;
  autoMergePullRequest?: boolean;
  autoCompleteTask?: boolean;
  allowSafeOperationsWithoutApproval?: boolean;
  defaultTaskMode?: TaskApi['mode'];
  aiProviderConnectionId?: string | null;
  isActive?: boolean;
}

export interface DeleteProjectRequest {
  confirmation: string;
  deleteGitHubRepository: boolean;
}

export interface DeleteProjectResponse {
  projectId: string;
  projectName: string;
  deletedTasks: number;
  deletedRuns: number;
  deletedRoadmapCycles: number;
  deletedRoadmapSteps: number;
  deletedGitHubRepository: boolean;
  githubRepository?: string;
}

export interface GenerateProjectRoadmapRequest {
  objective?: string;
  confirmation: string;
}

export interface DecideProjectRoadmapExtensionRequest {
  approved: boolean;
  cycleId?: string;
  objectiveOverride?: string;
}

export interface AssignProjectRepositoryRequest {
  mode: 'existing' | 'create';
  owner?: string;
  repo: string;
  defaultBranch?: string;
  branchMode?: 'existing' | 'create';
  branchName?: string;
  private?: boolean;
  description?: string;
}

export interface ProjectSummary extends ProjectApi {
  openPullRequests: number;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  currentStep: string;
  mode: TaskApi['mode'];
  iterations: number;
  maxIterations: number;
  updatedAt: string;
  branchName?: string;
  issueUrl?: string;
  pullRequestUrl?: string;
  waitingForCapabilities?: string[];
  deferredValidationCapabilities?: string[];
  plan: string[];
  testResult: string;
  diffSummary: string;
}

export interface ApprovalSummary {
  id: string;
  taskId: string;
  title: string;
  reason: string;
  risk: string;
  status: ApprovalApi['status'];
  riskLevel: ApprovalApi['riskLevel'];
  touchedFiles: string[];
  recommendation: string;
}
