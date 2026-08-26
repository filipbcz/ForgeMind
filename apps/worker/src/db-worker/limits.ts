import { parseAgentConfigYaml, toCoreLimits } from '@forgemind/config';
import { DEFAULT_LIMITS, evaluateLimits, requiresApproval, type ApprovalType, type Limits, type LimitUsage, type RunBlockedReason, type TaskStatus } from '@forgemind/core';
import type { JsonValue } from '@forgemind/shared';

export type ApprovedLimitSignal = 'diff_lines_limit_reached' | 'changed_files_limit_reached';

export function resolveBlockedRunReason(status: TaskStatus): RunBlockedReason {
  if (
    status === 'validation_failed'
    || status === 'provider_failed'
    || status === 'budget_exceeded'
    || status === 'iteration_limit_reached'
    || status === 'repeated_error_detected'
    || status === 'approval_rejected'
  ) {
    return status;
  }
  return 'unknown';
}

export function isApprovalType(value: string): value is ApprovalType {
  return [
    'budget_increase',
    'continue_after_iteration_limit',
    'new_dependency',
    'risky_refactor',
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
  ].includes(value);
}

export function normalizeRuntimeApprovals(values: readonly unknown[] | undefined): ApprovalType[] {
  const approvals: ApprovalType[] = [];
  for (const value of values ?? []) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    approvals.push(isApprovalType(trimmed) ? trimmed : mapApprovalReasonToType(trimmed));
  }

  return Array.from(new Set(approvals));
}

export function mapApprovalReasonToType(reason: string): ApprovalType {
  const normalized = reason.toLowerCase();
  if (/\b(dependency|package|install|npm|pnpm|yarn)\b/.test(normalized)) return 'new_dependency';
  if (/\b(database|migration|schema|prisma)\b/.test(normalized)) return 'database_migration';
  if (/\b(delete|remove)\b/.test(normalized)) return 'delete_files';
  if (/\.github\/workflows|github workflow|github actions/.test(normalized)) return 'github_workflow_change';
  if (/outside (repo|repository|workspace)|external path|write outside/.test(normalized)) return 'write_outside_repo';
  if (/deploy.*production|production.*deploy/.test(normalized)) return 'deploy_production';
  if (/deploy.*staging|staging.*deploy/.test(normalized)) return 'deploy_staging';
  if (/\bmerge\b/.test(normalized)) return 'merge_pr';
  if (/\bnginx\b/.test(normalized)) return 'nginx_config_change';
  if (/\bsystemd\b/.test(normalized)) return 'systemd_change';
  if (/\bbudget\b/.test(normalized)) return 'budget_increase';
  if (/\bconfig\b|\bconfiguration\b/.test(normalized)) return 'config_change';
  return 'risky_refactor';
}

export function resolveLimits(configYaml: string | undefined, maxIterations: number): Limits {
  let limits = DEFAULT_LIMITS;
  if (configYaml) {
    try {
      limits = toCoreLimits(parseAgentConfigYaml(configYaml));
    } catch {
      limits = DEFAULT_LIMITS;
    }
  }

  return {
    ...limits,
    maxIterations
  };
}

export function extractAttemptNumber(iteration: {
  phase: string;
  validationResult?: unknown;
}): number {
  const payload =
    iteration.validationResult && typeof iteration.validationResult === 'object' && !Array.isArray(iteration.validationResult)
      ? (iteration.validationResult as Record<string, unknown>)
      : undefined;
  const attempt = typeof payload?.attempt === 'number' && Number.isFinite(payload.attempt) ? payload.attempt : undefined;

  if (attempt && attempt > 0) {
    return attempt;
  }

  return iteration.phase === 'planning' ? 0 : 1;
}

export async function handleWorkerLimitsOrThrow(
  repository: {
    transitionTask: (taskId: string, status: TaskStatus, payload?: JsonValue) => Promise<unknown>;
    writeAudit?: (input: {
      actorType: 'user' | 'agent' | 'system' | 'github';
      eventType: string;
      taskId?: string;
      payload: JsonValue;
    }) => Promise<unknown>;
    listApprovals?: () => Promise<Array<{
      taskId: string;
      type: string;
      status: string;
      payload: JsonValue;
    }>>;
    createApproval: (input: {
      taskId: string;
      type: ApprovalType;
      requestedBy: 'system' | 'agent' | 'user';
      title: string;
      description: string;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      payload: JsonValue;
    }) => Promise<unknown>;
  },
  taskId: string,
  usage: LimitUsage,
  limits: Limits,
  ignoredLimitSignals: ApprovedLimitSignal[] = [],
  taskMode: 'safe' | 'auto' | 'full_auto' = 'safe',
  approvalRequiredFor: ReadonlySet<ApprovalType> = new Set(),
  allowSafeOperationsWithoutApproval = false,
  allowRuntimeGrace = false
): Promise<void> {
  const limitEvaluation = evaluateLimits(usage, limits);
  const ignoredSignals = new Set(ignoredLimitSignals);
  const stopSignal = limitEvaluation.signals.find(
    (signal) =>
      !(allowRuntimeGrace && signal === 'runtime_limit_reached')
      && !ignoredSignals.has(signal as ApprovedLimitSignal)
  );
  if (!stopSignal) return;

  if (stopSignal === 'soft_usage_limit_reached' || stopSignal === 'hard_usage_limit_reached') {
    if (await hasApprovedUsageLimitOverride(repository, taskId, stopSignal)) {
      return;
    }

    const usagePayload = toLimitUsagePayload(usage);
    const limitsPayload = toLimitsPayload(limits);
    const isHardLimit = stopSignal === 'hard_usage_limit_reached';
    const description = isHardLimit
      ? 'Measured provider usage reached the configured hard budget threshold. Worker spending is paused until a budget increase is approved or the usage limit configuration changes.'
      : 'Measured provider usage reached the configured soft budget threshold. Approval is required before the worker continues spending.';

    await repository.writeAudit?.({
      actorType: 'system',
      eventType: 'usage_limit_approval_requested',
      taskId,
      payload: {
        approvalType: 'budget_increase',
        limitSignal: stopSignal,
        usage: usagePayload,
        limits: limitsPayload,
        retryBounded: true
      }
    });
    await repository.transitionTask(taskId, 'needs_approval', {
      approvals: ['budget_increase'],
      limitSignal: stopSignal,
      usage: usagePayload
    });
    await repository.createApproval({
      taskId,
      type: 'budget_increase',
      requestedBy: 'agent',
      title: isHardLimit ? 'Approval required: hard usage limit reached' : 'Approval required: soft usage limit reached',
      description,
      riskLevel: isHardLimit ? 'critical' : 'medium',
      payload: {
        risk: isHardLimit ? 'Further provider spend is blocked by the configured hard limit.' : 'Provider spend has crossed the configured soft threshold.',
        recommendation: 'Review measured provider usage and approve only if additional spend is intended.',
        limitSignal: stopSignal,
        usage: usagePayload,
        limits: limitsPayload
      }
    });
    throw new WorkerApprovalRequiredError(description);
  }

  if (stopSignal === 'diff_lines_limit_reached' || stopSignal === 'changed_files_limit_reached') {
    const approvalType: ApprovalType = 'risky_refactor';
    const modeRequiresApproval = taskMode === 'safe' && allowSafeOperationsWithoutApproval
      ? false
      : requiresApproval(approvalType, taskMode);
    if (!modeRequiresApproval && !approvalRequiredFor.has(approvalType)) return;

    const usagePayload = toLimitUsagePayload(usage);
    const limitsPayload = toLimitsPayload(limits);
    const description =
      stopSignal === 'diff_lines_limit_reached'
        ? `Current diff has ${usage.diffLines} changed line(s), which exceeds the configured limit of ${limits.maxDiffLines}.`
        : `Current diff touches ${usage.changedFiles} file(s), which exceeds the configured limit of ${limits.maxChangedFiles}.`;

    await repository.transitionTask(taskId, 'needs_approval', {
      approvals: [approvalType],
      limitSignal: stopSignal,
      usage: usagePayload
    });
    await repository.createApproval({
      taskId,
      type: approvalType,
      requestedBy: 'agent',
      title: 'Approval required: large implementation diff',
      description,
      riskLevel: 'high',
      payload: {
        risk: 'Implementation diff exceeds configured guardrails.',
        recommendation: 'Review the current diff and approve only if the size and scope are intended.',
        limitSignal: stopSignal,
        usage: usagePayload,
        limits: limitsPayload
      }
    });
    throw new WorkerApprovalRequiredError(description);
  }

  throw new WorkerLimitError(stopSignalToTaskStatus(stopSignal), `Worker stopped because limit signal "${stopSignal}" was reached.`);
}

export function toLimitUsagePayload(usage: LimitUsage): Record<string, JsonValue> {
  return {
    iterations: usage.iterations,
    runtimeMinutes: usage.runtimeMinutes,
    changedFiles: usage.changedFiles,
    diffLines: usage.diffLines,
    repeatedErrorCount: usage.repeatedErrorCount,
    estimatedCostUsd: usage.estimatedCostUsd ?? null,
    actualCostUsd: usage.actualCostUsd ?? null
  };
}

export function toLimitsPayload(limits: Limits): Record<string, JsonValue> {
  return {
    maxIterations: limits.maxIterations,
    maxRuntimeMinutes: limits.maxRuntimeMinutes,
    maxChangedFiles: limits.maxChangedFiles,
    maxDiffLines: limits.maxDiffLines,
    maxRepeatedErrorCount: limits.maxRepeatedErrorCount,
    maxBudgetUsd: limits.maxBudgetUsd ?? null,
    softBudgetThresholdPercent: limits.softBudgetThresholdPercent ?? null,
    hardBudgetThresholdPercent: limits.hardBudgetThresholdPercent ?? null
  };
}

export function stopSignalToTaskStatus(signal: string): TaskStatus {
  if (signal === 'iteration_limit_reached') return 'iteration_limit_reached';
  if (signal === 'repeated_error_detected') return 'repeated_error_detected';
  return 'failed';
}

async function hasApprovedUsageLimitOverride(
  repository: {
    listApprovals?: () => Promise<Array<{
      taskId: string;
      type: string;
      status: string;
      payload: JsonValue;
    }>>;
  },
  taskId: string,
  signal: string
): Promise<boolean> {
  const approvals = await repository.listApprovals?.();
  return approvals?.some((approval) => (
    approval.taskId === taskId
    && approval.type === 'budget_increase'
    && approval.status === 'approved'
    && approvalPayloadMatchesUsageSignal(approval.payload, signal)
  )) ?? false;
}

function approvalPayloadMatchesUsageSignal(payload: JsonValue, signal: string): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const payloadSignal = (payload as Record<string, unknown>).limitSignal;
  if (payloadSignal === 'hard_usage_limit_reached') {
    return signal === 'hard_usage_limit_reached' || signal === 'soft_usage_limit_reached';
  }
  return payloadSignal === signal;
}

export class WorkerLimitError extends Error {
  constructor(
    readonly status: TaskStatus,
    message: string
  ) {
    super(message);
    this.name = 'WorkerLimitError';
  }
}

export class WorkerApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerApprovalRequiredError';
  }
}
