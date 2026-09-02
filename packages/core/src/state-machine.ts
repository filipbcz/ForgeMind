import type { TaskStatus } from './model.js';

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'provider_failed',
  'validation_failed'
]);

const transitions: Record<TaskStatus, TaskStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['planning', 'cancelled'],
  planning: ['creating_github_issue', 'creating_branch', 'running_ai', 'failed', 'cancelled'],
  creating_github_issue: ['creating_branch', 'running_ai', 'failed', 'cancelled'],
  creating_branch: ['running_ai', 'failed', 'cancelled'],
  running_ai: ['validating', 'provider_failed', 'failed', 'cancelled'],
  validating: ['reviewing', 'running_ai', 'validation_failed', 'failed', 'cancelled'],
  reviewing: ['improving', 'running_ai', 'creating_pr', 'ready_for_user_review', 'failed', 'cancelled'],
  improving: ['running_ai', 'validating', 'failed', 'cancelled'],
  creating_pr: ['running_ai', 'ready_for_user_review', 'validation_failed', 'failed', 'cancelled'],
  ready_for_user_review: ['completed', 'running_ai', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: ['completed'],
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
