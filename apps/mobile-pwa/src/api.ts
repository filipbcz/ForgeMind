import type { ApprovalApi, ApprovalSummary, CreateTaskRequest, ProjectApi, ProjectSummary, TaskApi, TaskSummary } from './types.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export const fallbackProjects: ProjectSummary[] = [
  {
    id: 'project_demo_gallery',
    name: 'Demo Static Gallery',
    slug: 'demo-static-gallery',
    githubOwner: 'demo',
    githubRepo: 'demo-static-gallery',
    defaultBranch: 'main',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    openPullRequests: 0,
    budgetUsd: 0
  }
];

export const fallbackTasks: TaskSummary[] = [];
export const fallbackApprovals: ApprovalSummary[] = [];

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
    throw new Error(body || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const projects = await request<ProjectApi[]>('/api/projects');
  const tasks = await request<TaskApi[]>('/api/tasks');
  return summarizeProjects(projects, tasks);
}

export async function fetchTasks(): Promise<TaskSummary[]> {
  const tasks = await request<TaskApi[]>('/api/tasks');
  return tasks.map(toTaskSummary);
}

export async function fetchApprovals(): Promise<ApprovalSummary[]> {
  const approvals = await request<ApprovalApi[]>('/api/approvals');
  return approvals.map(toApprovalSummary);
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
    method: 'POST'
  });
  return toTaskSummary(task);
}

export async function resolveApproval(id: string, status: 'approved' | 'rejected'): Promise<ApprovalSummary> {
  const approval = await request<ApprovalApi>(`/api/approvals/${id}/${status === 'approved' ? 'approve' : 'reject'}`, {
    method: 'POST'
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
    testResult: task.status === 'draft' ? 'Not started' : 'Waiting for worker result',
    diffSummary: task.status === 'draft' ? 'No changes' : 'Waiting for worker diff'
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

