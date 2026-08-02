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
}

export type LimitSignal =
  | 'iteration_limit_reached'
  | 'runtime_limit_reached'
  | 'changed_files_limit_reached'
  | 'diff_lines_limit_reached'
  | 'repeated_error_detected';

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

  return {
    ok: signals.length === 0,
    signals
  };
}
