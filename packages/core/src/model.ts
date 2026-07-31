import type { IsoDateString, JsonValue } from '@forgemind/shared';

export type ProviderKind = 'codex' | 'openai';

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
  | 'validation_failed';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type IterationPhase =
  | 'planning'
  | 'implementation'
  | 'validation'
  | 'review'
  | 'approval'
  | 'pr_creation';

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
  maxBudgetUsd: number;
  softBudgetThresholdPercent: number;
  hardBudgetThresholdPercent: number;
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
  autoCreatePullRequest?: boolean;
  autoMergePullRequest?: boolean;
  autoCompleteTask?: boolean;
  allowSafeOperationsWithoutApproval?: boolean;
  defaultTaskMode?: TaskMode;
  isActive: boolean;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export type ProjectRoadmapCycleStatus = 'active' | 'awaiting_extension_approval' | 'completed';

export type ProjectImplementationStepStatus = 'pending' | 'running' | 'completed' | 'cancelled';

export interface ProjectRoadmapCycle {
  id: string;
  projectId: string;
  cycleNumber: number;
  objective: string;
  extensionProposal?: string;
  status: ProjectRoadmapCycleStatus;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  completedAt?: IsoDateString;
}

export interface ProjectImplementationStep {
  id: string;
  projectId: string;
  cycleId: string;
  sequenceNumber: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
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
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  branchName?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
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
