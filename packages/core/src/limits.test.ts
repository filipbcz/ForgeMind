import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, evaluateLimits } from './limits.js';

describe('limit evaluation', () => {
  it('allows the final configured iteration to finish', () => {
    const result = evaluateLimits(
      {
        iterations: DEFAULT_LIMITS.maxIterations,
        runtimeMinutes: 0,
        changedFiles: 0,
        diffLines: 0,
        repeatedErrorCount: 0
      },
      DEFAULT_LIMITS
    );

    expect(result.ok).toBe(true);
    expect(result.signals).toEqual([]);
  });

  it('stops when the iteration limit is exceeded', () => {
    const result = evaluateLimits(
      {
        iterations: DEFAULT_LIMITS.maxIterations + 1,
        runtimeMinutes: 0,
        changedFiles: 0,
        diffLines: 0,
        repeatedErrorCount: 0
      },
      DEFAULT_LIMITS
    );

    expect(result.ok).toBe(false);
    expect(result.signals).toContain('iteration_limit_reached');
  });

  it('allows usage below operational limits', () => {
    const result = evaluateLimits(
      {
        iterations: 0,
        runtimeMinutes: 0,
        changedFiles: 0,
        diffLines: 0,
        repeatedErrorCount: 0
      },
      DEFAULT_LIMITS
    );

    expect(result.ok).toBe(true);
    expect(result.signals).toEqual([]);
  });
});
