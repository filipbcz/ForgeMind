import type { Limits } from './model.js';

export const DEFAULT_LIMITS: Limits = {
  maxIterations: 10,
  maxRuntimeMinutes: 600,
  maxChangedFiles: 20,
  maxDiffLines: 2000,
  maxRepeatedErrorCount: 3
};

export interface LimitUsage {
  iterations: number;
  runtimeMinutes: number;
  changedFiles: number;
  diffLines: number;
  repeatedErrorCount: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
}

export type LimitSignal =
  | 'iteration_limit_reached'
  | 'runtime_limit_reached'
  | 'changed_files_limit_reached'
  | 'diff_lines_limit_reached'
  | 'repeated_error_detected'
  | 'soft_usage_limit_reached'
  | 'hard_usage_limit_reached';

export interface LimitEvaluation {
  ok: boolean;
  signals: LimitSignal[];
}

export function evaluateLimits(usage: LimitUsage, limits: Limits): LimitEvaluation {
  const signals: LimitSignal[] = [];

  if (usage.iterations > limits.maxIterations) signals.push('iteration_limit_reached');
  if (usage.runtimeMinutes >= limits.maxRuntimeMinutes) signals.push('runtime_limit_reached');
  if (usage.changedFiles > limits.maxChangedFiles) signals.push('changed_files_limit_reached');
  if (usage.diffLines > limits.maxDiffLines) signals.push('diff_lines_limit_reached');
  if (usage.repeatedErrorCount >= limits.maxRepeatedErrorCount) signals.push('repeated_error_detected');
  const spendUsd = usage.actualCostUsd ?? usage.estimatedCostUsd;
  if (spendUsd !== undefined && limits.maxBudgetUsd !== undefined) {
    const hardPercent = limits.hardBudgetThresholdPercent ?? 100;
    const softPercent = limits.softBudgetThresholdPercent;
    const hardLimitUsd = (limits.maxBudgetUsd * hardPercent) / 100;
    const softLimitUsd = softPercent === undefined ? undefined : (limits.maxBudgetUsd * softPercent) / 100;
    if (spendUsd >= hardLimitUsd) {
      signals.push('hard_usage_limit_reached');
    } else if (softLimitUsd !== undefined && spendUsd >= softLimitUsd) {
      signals.push('soft_usage_limit_reached');
    }
  }

  return {
    ok: signals.length === 0,
    signals
  };
}
