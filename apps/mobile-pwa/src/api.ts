import type {
  ApprovalApi,
  ApprovalSummary,
  AssignProjectRepositoryRequest,
  AuditEventApi,
  CreateProjectRequest,
  CreateTaskRequest,
  CodexOAuthCompleteResponse,
  CodexOAuthStartResponse,
  DecideProjectRoadmapExtensionRequest,
  DeleteProjectRequest,
  DeleteProjectResponse,
  GenerateProjectRoadmapRequest,
  GitHubAdapterConnectRequest,
  GitHubAdapterConnectResponse,
  GitHubAdapterStatusApi,
  GitHubBranchApi,
  GitHubRepositoryOwnerApi,
  GitHubRepositoryApi,
  NotificationSettingsApi,
  NotificationSubscriptionRequest,
  ProviderConnectRequest,
  ProviderConnectResponse,
  ProviderStatusApi,
  ProjectApi,
  ProjectRoadmapApi,
  ProjectSummary,
  TaskApi,
  TaskDiffApi,
  TaskQueueApi,
  TaskSummary,
  TaskUsageApi,
  UpdateProjectRequest,
  WorkerEventApi,
  WorkerStatusApi
} from './types.js';

const inferredApiUrl =
  typeof window === 'undefined' || window.location.hostname === 'localhost'
    ? 'http://localhost:4000'
    : window.location.origin;

export const API_URL = import.meta.env.VITE_API_URL ?? inferredApiUrl;

export function buildWebSocketUrl(taskId?: string): string {
  const base = new URL(API_URL);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/ws';
  if (taskId) {
    base.searchParams.set('taskId', taskId);
  }
  return base.toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    },
    ...init
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(formatRequestError(body, response.status));
  }

  return response.json() as Promise<T>;
}

function formatRequestError(body: string, status: number): string {
  if (!body) {
    return `Request failed: ${status}`;
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown; issues?: Array<{ path?: Array<string | number>; message?: string }> };
    if (typeof parsed.error === 'string') {
      if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
        const issues = parsed.issues
          .map((issue) => {
            const path = issue.path?.length ? `${issue.path.join('.')}: ` : '';
            return `${path}${issue.message ?? 'Invalid value'}`;
          })
          .join('; ');
        return `${parsed.error}: ${issues}`;
      }

      return parsed.error;
    }
  } catch {
    return body;
  }

  return body;
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const projects = await request<ProjectApi[]>('/api/projects');
  const tasks = await request<TaskApi[]>('/api/tasks');
  return summarizeProjects(projects, tasks);
}

export async function createProject(input: CreateProjectRequest): Promise<ProjectSummary> {
  const project = await request<ProjectApi>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return { ...project, budgetUsd: 0, openPullRequests: 0 };
}

export async function updateProject(projectId: string, input: UpdateProjectRequest): Promise<ProjectSummary> {
  const project = await request<ProjectApi>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
  return { ...project, budgetUsd: 0, openPullRequests: 0 };
}

export async function deleteProject(projectId: string, input: DeleteProjectRequest): Promise<DeleteProjectResponse> {
  return request<DeleteProjectResponse>(`/api/projects/${projectId}`, {
    method: 'DELETE',
    body: JSON.stringify(input)
  });
}

export async function assignProjectRepository(projectId: string, input: AssignProjectRepositoryRequest): Promise<ProjectSummary> {
  const project = await request<ProjectApi>(`/api/projects/${projectId}/github-repository`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return { ...project, budgetUsd: 0, openPullRequests: 0 };
}

export async function fetchProjectRoadmap(projectId: string): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/roadmap`);
}

export async function generateProjectRoadmap(projectId: string, input: GenerateProjectRoadmapRequest = {}): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/implementation-steps/generate`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function decideProjectRoadmapExtension(
  projectId: string,
  input: DecideProjectRoadmapExtensionRequest
): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/extension/decision`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function fetchTasks(): Promise<TaskSummary[]> {
  const tasks = await request<TaskApi[]>('/api/tasks');
  return tasks.map(toTaskSummary);
}

export async function fetchTaskLogs(taskId: string): Promise<AuditEventApi[]> {
  return request<AuditEventApi[]>(`/api/tasks/${taskId}/logs`);
}

export async function fetchTaskDiff(taskId: string): Promise<TaskDiffApi> {
  return request<TaskDiffApi>(`/api/tasks/${taskId}/diff`);
}

export async function fetchTaskUsage(taskId: string): Promise<TaskUsageApi> {
  return request<TaskUsageApi>(`/api/tasks/${taskId}/usage`);
}

export async function fetchTaskRuns(taskId: string): Promise<TaskUsageApi> {
  return request<TaskUsageApi>(`/api/tasks/${taskId}/runs`);
}

export async function fetchTaskQueue(taskId: string): Promise<TaskQueueApi> {
  return request<TaskQueueApi>(`/api/tasks/${taskId}/queue`);
}

export async function fetchWorkerStatus(): Promise<WorkerStatusApi> {
  return request<WorkerStatusApi>('/api/worker/status');
}

export async function fetchWorkerEvents(limit = 8): Promise<WorkerEventApi[]> {
  return request<WorkerEventApi[]>(`/api/worker/events?limit=${limit}`);
}

export async function fetchApprovals(): Promise<ApprovalSummary[]> {
  const approvals = await request<ApprovalApi[]>('/api/approvals');
  return approvals.map(toApprovalSummary);
}

export async function fetchProviderStatus(): Promise<ProviderStatusApi> {
  return request<ProviderStatusApi>('/api/providers/status');
}

export async function fetchGitHubAdapterStatus(): Promise<GitHubAdapterStatusApi> {
  return request<GitHubAdapterStatusApi>('/api/github/status');
}

export async function fetchGitHubRepositories(limit = 100): Promise<GitHubRepositoryApi[]> {
  return request<GitHubRepositoryApi[]>(`/api/github/repositories?limit=${limit}`);
}

export async function fetchGitHubRepositoryOwners(limit = 100): Promise<GitHubRepositoryOwnerApi[]> {
  return request<GitHubRepositoryOwnerApi[]>(`/api/github/repository-owners?limit=${limit}`);
}

export async function fetchGitHubBranches(owner: string, repo: string, limit = 100): Promise<GitHubBranchApi[]> {
  const params = new URLSearchParams({
    owner,
    repo,
    limit: String(limit)
  });
  return request<GitHubBranchApi[]>(`/api/github/branches?${params.toString()}`);
}

export async function connectGitHubAdapter(input: GitHubAdapterConnectRequest): Promise<GitHubAdapterConnectResponse> {
  return request<GitHubAdapterConnectResponse>('/api/github/connect', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function disconnectGitHubAdapter(): Promise<{ ok: boolean; status: GitHubAdapterStatusApi }> {
  return request<{ ok: boolean; status: GitHubAdapterStatusApi }>('/api/github/disconnect', {
    method: 'POST',
    body: '{}'
  });
}

export async function connectProvider(input: ProviderConnectRequest): Promise<ProviderConnectResponse> {
  return request<ProviderConnectResponse>('/api/providers/connect', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function startCodexOAuth(): Promise<CodexOAuthStartResponse> {
  return request<CodexOAuthStartResponse>('/api/providers/codex/oauth/start', {
    method: 'POST',
    body: '{}'
  });
}

export async function completeCodexOAuth(input: { loginId: string; model: string }): Promise<CodexOAuthCompleteResponse> {
  return request<CodexOAuthCompleteResponse>('/api/providers/codex/oauth/complete', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function fetchNotificationSettings(): Promise<NotificationSettingsApi> {
  return request<NotificationSettingsApi>('/api/notifications/settings');
}

export async function updateNotificationSettings(input: Partial<NotificationSettingsApi['settings']>): Promise<NotificationSettingsApi> {
  return request<NotificationSettingsApi>('/api/notifications/settings', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function fetchNotificationVapidPublicKey(): Promise<string> {
  const payload = await request<{ publicKey: string }>('/api/notifications/vapid-public-key');
  return payload.publicKey;
}

export async function subscribeNotification(input: NotificationSubscriptionRequest) {
  return request('/api/notifications/subscribe', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function unsubscribeNotification(endpoint: string) {
  return request('/api/notifications/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint })
  });
}

export async function createTask(input: CreateTaskRequest): Promise<TaskSummary> {
  const task = await request<TaskApi>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return toTaskSummary(task);
}

export async function startTask(taskId: string): Promise<TaskSummary> {
  const task = await request<TaskApi>(`/api/tasks/${taskId}/start`, {
    method: 'POST',
    body: '{}'
  });
  return toTaskSummary(task);
}

export async function cancelTask(taskId: string): Promise<TaskSummary> {
  const task = await request<TaskApi>(`/api/tasks/${taskId}/cancel`, {
    method: 'POST',
    body: '{}'
  });
  return toTaskSummary(task);
}

export async function retryTask(taskId: string): Promise<TaskSummary> {
  const task = await request<TaskApi>(`/api/tasks/${taskId}/retry`, {
    method: 'POST',
    body: JSON.stringify({ start: true })
  });
  return toTaskSummary(task);
}

export async function completeTask(taskId: string): Promise<TaskSummary> {
  const task = await request<TaskApi>(`/api/tasks/${taskId}/complete`, {
    method: 'POST',
    body: '{}'
  });
  return toTaskSummary(task);
}

export async function resolveApproval(id: string, status: 'approved' | 'rejected'): Promise<ApprovalSummary> {
  const approval = await request<ApprovalApi>(`/api/approvals/${id}/${status === 'approved' ? 'approve' : 'reject'}`, {
    method: 'POST',
    body: '{}'
  });
  return toApprovalSummary(approval);
}

function summarizeProjects(projects: ProjectApi[], tasks: TaskApi[]): ProjectSummary[] {
  return projects.map((project) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    return {
      ...project,
      openPullRequests: projectTasks.filter((task) => Boolean(task.pullRequestUrl)).length,
      budgetUsd: projectTasks.reduce((sum, task) => sum + estimateTaskSpend(task), 0)
    };
  });
}

export function toTaskSummary(task: TaskApi): TaskSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    currentStep: currentStep(task.status),
    mode: task.mode,
    iterations: 0,
    maxIterations: task.maxIterations,
    budgetUsd: estimateTaskSpend(task),
    maxBudgetUsd: task.maxBudgetUsd,
    updatedAt: task.updatedAt,
    branchName: task.branchName,
    issueUrl: task.githubIssueUrl,
    pullRequestUrl: task.pullRequestUrl,
    plan: task.status === 'draft' ? [] : ['Create issue and branch', 'Run provider', 'Validate result', 'Prepare draft PR'],
    testResult: task.status === 'draft' ? 'Not started' : 'See worker log',
    diffSummary: task.status === 'draft' ? 'No changes' : 'See diff summary'
  };
}

function toApprovalSummary(approval: ApprovalApi): ApprovalSummary {
  const payload = approval.payload && typeof approval.payload === 'object' ? (approval.payload as Record<string, unknown>) : {};
  const touchedFiles = Array.isArray(payload.touchedFiles) ? payload.touchedFiles.map(String) : [];

  return {
    id: approval.id,
    taskId: approval.taskId,
    title: approval.title,
    reason: approval.description,
    risk: String(payload.risk ?? approval.description),
    status: approval.status,
    riskLevel: approval.riskLevel,
    touchedFiles,
    recommendation: String(payload.recommendation ?? 'Review the requested action before approving.')
  };
}

function currentStep(status: TaskApi['status']): string {
  const labels: Record<TaskApi['status'], string> = {
    draft: 'Ready to submit',
    submitted: 'Queued for worker',
    planning: 'Worker is planning',
    waiting_for_plan_approval: 'Waiting for plan approval',
    creating_github_issue: 'Creating GitHub issue',
    creating_branch: 'Creating branch',
    running_ai: 'Provider is running',
    validating: 'Validation is running',
    reviewing: 'Review is running',
    improving: 'Applying safe improvements',
    needs_approval: 'Waiting for approval',
    creating_pr: 'Creating draft PR',
    ready_for_user_review: 'Ready for review',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    budget_exceeded: 'Budget exceeded',
    iteration_limit_reached: 'Iteration limit reached',
    repeated_error_detected: 'Repeated error detected',
    approval_rejected: 'Approval rejected',
    provider_failed: 'Provider failed',
    validation_failed: 'Validation failed'
  };
  return labels[status];
}

function estimateTaskSpend(task: TaskApi): number {
  if (task.status === 'draft') return 0;
  if (task.status === 'completed' || task.status === 'ready_for_user_review') return Math.min(task.maxBudgetUsd, 0.25);
  return Math.min(task.maxBudgetUsd, 0.1);
}
