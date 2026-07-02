export type TaskStatus =
  | 'draft'
  | 'submitted'
  | 'planning'
  | 'running_ai'
  | 'validating'
  | 'needs_approval'
  | 'ready_for_user_review'
  | 'completed'
  | 'validation_failed';

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
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
  mode: 'safe' | 'auto' | 'full_auto';
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
  status: 'pending' | 'approved' | 'rejected';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  touchedFiles: string[];
  recommendation: string;
}

