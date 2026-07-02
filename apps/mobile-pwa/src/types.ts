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

export interface ProjectApi {
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
}

export interface TaskApi {
  id: string;
  projectId: string;
  createdByUserId: string;
  title: string;
  prompt: string;
  mode: 'safe' | 'auto' | 'full_auto';
  status: TaskStatus;
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
    resultSummary: string;
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
  estimatedCostUsd: number;
  runs: Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    iterationCount: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    startedAt?: string;
    finishedAt?: string;
    summary?: string | null;
    errorMessage?: string | null;
  }>;
  records: Array<{
    id: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    estimatedCostUsd: number;
    createdAt: string;
  }>;
}

export interface CreateTaskRequest {
  projectId: string;
  title: string;
  prompt: string;
  mode: TaskApi['mode'];
  maxIterations: number;
  maxBudgetUsd: number;
}

export interface CreateProjectRequest {
  name: string;
  slug: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  configYaml?: string;
}

export interface ProjectSummary extends ProjectApi {
  openPullRequests: number;
  budgetUsd: number;
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
  budgetUsd: number;
  maxBudgetUsd: number;
  updatedAt: string;
  branchName?: string;
  issueUrl?: string;
  pullRequestUrl?: string;
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

