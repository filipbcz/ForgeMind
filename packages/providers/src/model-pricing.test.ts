import { describe, expect, it } from 'vitest';
import { calculateModelCostUsd, resolveModelTokenPricing } from './model-pricing.js';

describe('model pricing', () => {
  it('calculates uncached, cached and output token cost', () => {
    expect(calculateModelCostUsd({ model: 'gpt-6.1-sol', inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000 }))
      .toBe(1.025);
  });

  it('matches dated snapshots and leaves unknown models unpriced', () => {
    expect(resolveModelTokenPricing('gpt-6-astra-2026-09-01')?.sourceVersion).toBe('openai-2026-09-29');
    expect(calculateModelCostUsd({ model: 'private-model', inputTokens: 10, outputTokens: 10 })).toBeUndefined();
  });
});
