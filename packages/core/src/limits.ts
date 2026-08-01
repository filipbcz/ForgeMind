import type { Limits } from './model.js';

export const DEFAULT_LIMITS: Limits = {
  maxIterations: 10,
  maxRuntimeMinutes: 90,
  maxChangedFiles: 20,
  maxDiffLines: 2000,
  maxRepeatedErrorCount: 3,
  maxTokens: 250_000,
  maxBudgetUsd: 2,
  softBudgetThresholdPercent: 75,
  hardBudgetThresholdPercent: 100
};

export interface LimitUsage {
  iterations: number;
  runtimeMinutes: number;
  changedFiles: number;
  diffLines: number;
  repeatedErrorCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export type LimitSignal =
  | 'iteration_limit_reached'
  | 'runtime_limit_reached'
  | 'changed_files_limit_reached'
  | 'diff_lines_limit_reached'
  | 'repeated_error_detected'
  | 'budget_soft_limit_reached'
  | 'budget_exceeded';

export interface LimitEvaluation {
  ok: boolean;
  signals: LimitSignal[];
}

export function evaluateLimits(usage: LimitUsage, limits: Limits): LimitEvaluation {
  const signals: LimitSignal[] = [];

  if (usage.iterations >= limits.maxIterations) signals.push('iteration_limit_reached');
  if (usage.runtimeMinutes >= limits.maxRuntimeMinutes) signals.push('runtime_limit_reached');
  if (usage.changedFiles > limits.maxChangedFiles) signals.push('changed_files_limit_reached');
  if (usage.diffLines > limits.maxDiffLines) signals.push('diff_lines_limit_reached');
  if (usage.repeatedErrorCount >= limits.maxRepeatedErrorCount) signals.push('repeated_error_detected');
  if (usage.totalTokens >= limits.maxTokens) signals.push('budget_exceeded');

  const budgetPercent = limits.maxBudgetUsd === 0 ? 100 : (usage.estimatedCostUsd / limits.maxBudgetUsd) * 100;
  if (budgetPercent >= limits.hardBudgetThresholdPercent) {
    signals.push('budget_exceeded');
  } else if (budgetPercent >= limits.softBudgetThresholdPercent) {
    signals.push('budget_soft_limit_reached');
  }

  return {
    ok: signals.length === 0 || signals.every((signal) => signal === 'budget_soft_limit_reached'),
    signals
  };
}
