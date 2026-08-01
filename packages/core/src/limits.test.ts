import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, evaluateLimits } from './limits.js';

describe('limit evaluation', () => {
  it('stops when iteration limit is reached', () => {
    const result = evaluateLimits(
      {
        iterations: DEFAULT_LIMITS.maxIterations,
        runtimeMinutes: 0,
        changedFiles: 0,
        diffLines: 0,
        repeatedErrorCount: 0,
        totalTokens: 0,
        estimatedCostUsd: 0
      },
      DEFAULT_LIMITS
    );

    expect(result.ok).toBe(false);
    expect(result.signals).toContain('iteration_limit_reached');
  });

  it('allows soft budget warning without hard stop', () => {
    const result = evaluateLimits(
      {
        iterations: 0,
        runtimeMinutes: 0,
        changedFiles: 0,
        diffLines: 0,
        repeatedErrorCount: 0,
        totalTokens: 0,
        estimatedCostUsd: DEFAULT_LIMITS.maxBudgetUsd * 0.8
      },
      DEFAULT_LIMITS
    );

    expect(result.ok).toBe(true);
    expect(result.signals).toContain('budget_soft_limit_reached');
  });

  it('stops on the cumulative actual token budget', () => {
    const result = evaluateLimits(
      {
        iterations: 0,
        runtimeMinutes: 0,
        changedFiles: 0,
        diffLines: 0,
        repeatedErrorCount: 0,
        totalTokens: DEFAULT_LIMITS.maxTokens,
        estimatedCostUsd: 0
      },
      DEFAULT_LIMITS
    );

    expect(result.ok).toBe(false);
    expect(result.signals).toContain('budget_exceeded');
  });
});
