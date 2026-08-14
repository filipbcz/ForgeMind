import type { TaskStatus } from './model.js';

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'iteration_limit_reached',
  'repeated_error_detected',
  'approval_rejected',
  'provider_failed',
  'validation_failed'
]);

const transitions: Record<TaskStatus, TaskStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['planning', 'cancelled'],
  planning: ['waiting_for_plan_approval', 'creating_github_issue', 'creating_branch', 'running_ai', 'failed', 'cancelled'],
  waiting_for_plan_approval: ['creating_github_issue', 'creating_branch', 'running_ai', 'approval_rejected', 'cancelled'],
  creating_github_issue: ['creating_branch', 'running_ai', 'failed', 'cancelled'],
  creating_branch: ['running_ai', 'failed', 'cancelled'],
  running_ai: ['validating', 'needs_approval', 'provider_failed', 'budget_exceeded', 'iteration_limit_reached', 'cancelled'],
  validating: ['reviewing', 'running_ai', 'needs_approval', 'validation_failed', 'repeated_error_detected', 'failed', 'cancelled'],
  reviewing: ['improving', 'running_ai', 'creating_pr', 'ready_for_user_review', 'needs_approval', 'failed', 'cancelled'],
  improving: ['running_ai', 'validating', 'needs_approval', 'failed', 'cancelled'],
  needs_approval: ['running_ai', 'creating_pr', 'approval_rejected', 'cancelled'],
  creating_pr: ['running_ai', 'ready_for_user_review', 'validation_failed', 'failed', 'cancelled'],
  ready_for_user_review: ['completed', 'running_ai', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: ['completed'],
  budget_exceeded: [],
  iteration_limit_reached: [],
  repeated_error_detected: [],
  approval_rejected: [],
  provider_failed: [],
  validation_failed: []
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task status transition from "${from}" to "${to}"`);
  }
}
