import type {
  AuthLoginStartResponse,
  AuthSessionResponse,
  AssignProjectRepositoryRequest,
  AuditEventApi,
  ChatMessageApi,
  ChatRunApi,
  ChatThreadApi,
  ChatThreadDetailApi,
  CreateChatThreadRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CodexOAuthCompleteResponse,
  CodexOAuthStatusResponse,
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
  ProviderConnectionApi,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderStatusApi,
  ProjectApi,
  ProjectArchitectureSnapshotApi,
  ProjectContractSnapshotApi,
  ProjectRoadmapApi,
  SpecificationChangeImpactReviewApi,
  ProjectSpecificationSnapshotApi,
  ProjectSummary,
  TaskApi,
  TaskDiffApi,
  TaskQueueApi,
  TaskSummary,
  TaskUsageApi,
  UpdateChatThreadRequest,
  UpdateProjectRequest,
  WorkerEventApi,
  WorkerStatusApi
} from './types.js';
import type { WindowsWorkerOperationsReadModel } from '@forgemind/core';

const inferredApiUrl =
  typeof window === 'undefined' || window.location.hostname === 'localhost'
    ? 'http://localhost:4000'
    : window.location.origin;

export const API_URL = import.meta.env.VITE_API_URL ?? inferredApiUrl;

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  return request<AuthSessionResponse>('/api/auth/session');
}

export const fetchWindowsOperations = (projectId?: string) => request<WindowsWorkerOperationsReadModel>(`/api/windows-runner/operations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
export const cancelWindowsJob = (jobId: string) => request<{ accepted: boolean }>(`/api/windows-runner/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' });
export const drainWindowsSession = (sessionId: string) => request<{ accepted: boolean }>(`/api/windows-runner/sessions/${sessionId}/drain`, { method: 'POST', body: '{}' });
export const revokeWindowsDevice = (deviceId: string) => request<{ revoked: boolean }>(`/api/windows-runner/devices/${deviceId}/revoke`, { method: 'POST', body: '{}' });

export async function startGoogleLogin(): Promise<AuthLoginStartResponse> {
  return request<AuthLoginStartResponse>('/api/auth/google/login', {
    method: 'POST',
    body: '{}'
  });
}

export async function logout(): Promise<void> {
  await request('/api/auth/logout', {
    method: 'POST',
    body: '{}'
  });
}

export async function fetchChatThreads(includeArchived = false): Promise<ChatThreadApi[]> {
  return request<ChatThreadApi[]>(`/api/chat/threads?includeArchived=${includeArchived}`);
}

export async function fetchChatThread(threadId: string): Promise<ChatThreadDetailApi> {
  return request<ChatThreadDetailApi>(`/api/chat/threads/${threadId}`);
}

export async function createChatThread(input: CreateChatThreadRequest): Promise<ChatThreadApi> {
  return request<ChatThreadApi>('/api/chat/threads', { method: 'POST', body: JSON.stringify(input) });
}

export async function continueChatThreadWithRepository(threadId: string, input: CreateChatThreadRequest): Promise<ChatThreadApi> {
  return request<ChatThreadApi>(`/api/chat/threads/${threadId}/continue-with-repository`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateChatThread(threadId: string, input: UpdateChatThreadRequest): Promise<ChatThreadApi> {
  return request<ChatThreadApi>(`/api/chat/threads/${threadId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function deleteChatThread(threadId: string, confirmation: string): Promise<{ deleted: true; threadId: string }> {
  return request(`/api/chat/threads/${threadId}`, { method: 'DELETE', body: JSON.stringify({ confirmation }) });
}

export async function sendChatMessage(threadId: string, content: string): Promise<{ message: ChatMessageApi; run: ChatRunApi }> {
  return request(`/api/chat/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
}

export async function retryChatRun(runId: string): Promise<ChatRunApi> {
  return request<ChatRunApi>(`/api/chat/runs/${runId}/retry`, { method: 'POST', body: '{}' });
}

export async function cancelChatRun(runId: string): Promise<ChatRunApi> {
  return request<ChatRunApi>(`/api/chat/runs/${runId}/cancel`, { method: 'POST', body: '{}' });
}

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
  const hasBody = init?.body !== undefined && init?.body !== null;
  const method = init?.method?.toUpperCase() ?? 'GET';
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const headers: HeadersInit = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(isMutation ? { 'X-ForgeMind-CSRF': '1' } : {}),
    ...init?.headers
  };

  const response = await fetch(`${API_URL}${path}`, {
    headers,
    credentials: 'include',
    ...init
  });

  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/session' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('forgemind:authentication-required'));
    }
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
  return { ...project, openPullRequests: 0 };
}

export async function updateProject(projectId: string, input: UpdateProjectRequest): Promise<ProjectSummary> {
  const project = await request<ProjectApi>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
  return { ...project, openPullRequests: 0 };
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
  return { ...project, openPullRequests: 0 };
}

export async function fetchProjectRoadmap(projectId: string): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/roadmap`);
}

export async function fetchProjectSpecifications(projectId: string): Promise<ProjectSpecificationSnapshotApi> {
  return request<ProjectSpecificationSnapshotApi>(`/api/projects/${projectId}/specifications`);
}

export async function reviewProjectSpecificationChange(
  projectId: string,
  input: { brief: string | null }
): Promise<SpecificationChangeImpactReviewApi> {
  return request<SpecificationChangeImpactReviewApi>(`/api/projects/${projectId}/specification-review`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function fetchProjectContracts(projectId: string): Promise<ProjectContractSnapshotApi> {
  return request<ProjectContractSnapshotApi>(`/api/projects/${projectId}/contracts`);
}

export async function fetchProjectArchitectures(projectId: string): Promise<ProjectArchitectureSnapshotApi> {
  return request<ProjectArchitectureSnapshotApi>(`/api/projects/${projectId}/architectures`);
}

export async function retryProjectAudit(projectId: string): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/audit/retry`, { method: 'POST' });
}

export async function startProjectAudit(projectId: string): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/audit/start`, { method: 'POST' });
}

export async function generateProjectRoadmap(projectId: string, input: GenerateProjectRoadmapRequest): Promise<ProjectRoadmapApi> {
  return request<ProjectRoadmapApi>(`/api/projects/${projectId}/implementation-steps/generate`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function startNextProjectRoadmapStep(projectId: string): Promise<TaskSummary> {
  const task = await request<TaskApi>(`/api/projects/${projectId}/implementation-steps/start-next`, { method: 'POST' });
  return toTaskSummary(task);
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

export async function setWorkerQueuePaused(paused: boolean): Promise<WorkerStatusApi> {
  return request<WorkerStatusApi>('/api/worker/queue', {
    method: 'PUT',
    body: JSON.stringify({ paused })
  });
}

export async function fetchWorkerEvents(limit = 8): Promise<WorkerEventApi[]> {
  return request<WorkerEventApi[]>(`/api/worker/events?limit=${limit}`);
}

export async function fetchProviderStatus(): Promise<ProviderStatusApi> {
  return request<ProviderStatusApi>('/api/providers/status');
}

export async function fetchProviderConnections(): Promise<ProviderConnectionApi[]> {
  return request<ProviderConnectionApi[]>('/api/providers/connections');
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

export async function fetchProviderModels(input: ProviderModelsRequest): Promise<ProviderModelsResponse> {
  return request<ProviderModelsResponse>('/api/providers/models', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function deleteProviderConnection(connectionId: string): Promise<{ ok: boolean; connectionId: string }> {
  return request<{ ok: boolean; connectionId: string }>(`/api/providers/connections/${connectionId}`, {
    method: 'DELETE'
  });
}

export async function startCodexOAuth(input: { name?: string } = {}): Promise<CodexOAuthStartResponse> {
  return request<CodexOAuthStartResponse>('/api/providers/codex/oauth/start', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function completeCodexOAuth(input: {
  loginId: string;
  connectionId?: string;
  model: string;
  name?: string;
  isDefault?: boolean;
}): Promise<CodexOAuthCompleteResponse> {
  return request<CodexOAuthCompleteResponse>('/api/providers/codex/oauth/complete', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function fetchCodexOAuthStatus(loginId: string): Promise<CodexOAuthStatusResponse> {
  return request<CodexOAuthStatusResponse>(`/api/providers/codex/oauth/${loginId}/status`);
}

export function codexOAuthAuthorizeUrl(loginId: string, name?: string): string {
  const url = new URL(`${API_URL}/api/providers/codex/oauth/authorize`);
  url.searchParams.set('loginId', loginId);
  if (name) {
    url.searchParams.set('name', name);
  }
  return url.toString();
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

export async function fetchWindowsWorkerOperations(projectId?: string): Promise<WindowsWorkerOperationsReadModel> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request<WindowsWorkerOperationsReadModel>(`/api/windows-runner/operations${query}`);
}

export async function cancelWindowsValidation(jobId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>(`/api/windows-runner/jobs/${jobId}/cancel`, {
    method: 'POST',
    body: '{}'
  });
}

export async function drainWindowsWorkerSession(sessionId: string): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>(`/api/windows-runner/sessions/${sessionId}/drain`, {
    method: 'POST',
    body: '{}'
  });
}

export async function createWindowsRunnerEnrollment(input: {
  deviceId: string;
  displayName: string;
  expiresInMinutes?: number;
}): Promise<{ enrollmentId: string; code: string; expiresAt: string }> {
  return request('/api/windows-runner/enrollments', { method: 'POST', body: JSON.stringify(input) });
}

export async function revokeWindowsRunner(deviceId: string): Promise<{ deviceId: string; revoked: boolean }> {
  return request(`/api/windows-runner/devices/${deviceId}/revoke`, { method: 'POST', body: '{}' });
}

function summarizeProjects(projects: ProjectApi[], tasks: TaskApi[]): ProjectSummary[] {
  return projects.map((project) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    return {
      ...project,
      openPullRequests: projectTasks.filter((task) => Boolean(task.pullRequestUrl)).length
    };
  });
}

export function toTaskSummary(task: TaskApi): TaskSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    prompt: task.prompt,
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    status: task.status,
    currentStep: currentStep(task.status),
    mode: task.mode,
    iterations: 0,
    updatedAt: task.updatedAt,
    branchName: task.branchName,
    issueUrl: task.githubIssueUrl,
    pullRequestUrl: task.pullRequestUrl,
    deferredValidationCapabilities: task.deferredValidationCapabilities,
    plan: task.status === 'draft' ? [] : ['Create issue and branch', 'Run provider', 'Validate result', 'Prepare draft PR'],
    testResult: task.status === 'draft' ? 'Not started' : 'See worker log',
    diffSummary: task.status === 'draft' ? 'No changes' : 'See diff summary'
  };
}

function currentStep(status: TaskApi['status']): string {
  const labels: Record<TaskApi['status'], string> = {
    draft: 'Ready to submit',
    submitted: 'Queued for worker',
    planning: 'Worker is planning',
    creating_github_issue: 'Creating GitHub issue',
    creating_branch: 'Creating branch',
    running_ai: 'Provider is running',
    validating: 'Validation is running',
    reviewing: 'Review is running',
    improving: 'Applying safe improvements',
    creating_pr: 'Creating draft PR',
    ready_for_user_review: 'Ready for review',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    provider_failed: 'Provider failed',
    validation_failed: 'Validation failed'
  };
  return labels[status];
}
