import type { RunBlockedReason, TaskStatus } from '@forgemind/core';

export function resolveBlockedRunReason(status: TaskStatus): RunBlockedReason {
  if (
    status === 'validation_failed'
    || status === 'provider_failed'
  ) {
    return status;
  }
  return 'unknown';
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
