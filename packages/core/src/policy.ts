import type { ApprovalType, TaskMode } from './model.js';

export const ALWAYS_REQUIRES_APPROVAL: ReadonlySet<ApprovalType> = new Set([
  'budget_increase',
  'continue_after_iteration_limit',
  'new_dependency',
  'database_migration',
  'config_change',
  'deploy_staging',
  'deploy_production',
  'merge_pr',
  'delete_files',
  'github_workflow_change',
  'systemd_change',
  'nginx_config_change',
  'write_outside_repo'
]);

export function requiresApproval(type: ApprovalType, mode: TaskMode): boolean {
  if (mode === 'full_auto') {
    return type === 'deploy_production' || type === 'merge_pr' || type === 'write_outside_repo';
  }

  if (mode === 'auto') {
    return type !== 'risky_refactor' || ALWAYS_REQUIRES_APPROVAL.has(type);
  }

  return ALWAYS_REQUIRES_APPROVAL.has(type) || type === 'risky_refactor';
}

