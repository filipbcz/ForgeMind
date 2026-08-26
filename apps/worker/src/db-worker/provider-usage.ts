import type { ProviderUsageMeasurement } from '@forgemind/providers';

export function normalizeProviderUsageMeasurement(
  phase: string,
  usage: ProviderUsageMeasurement,
  cumulativeTotals: Map<string, ProviderUsageMeasurement>
): ProviderUsageMeasurement {
  if (usage.source !== 'actual_total') return usage;

  const stream = phase === 'review' ? 'review' : 'implementation';
  const key = `${usage.provider}:${usage.model}:${stream}`;
  const previous = cumulativeTotals.get(key);
  cumulativeTotals.set(key, usage);
  if (!previous || usage.totalTokens < previous.totalTokens) return usage;

  return {
    ...usage,
    totalTokens: usage.totalTokens - previous.totalTokens,
    inputTokens: subtractCumulativeValue(usage.inputTokens, previous.inputTokens),
    outputTokens: subtractCumulativeValue(usage.outputTokens, previous.outputTokens),
    cachedTokens: subtractCumulativeValue(usage.cachedTokens, previous.cachedTokens),
    actualCostUsd: subtractCumulativeValue(usage.actualCostUsd, previous.actualCostUsd)
  };
}

function subtractCumulativeValue(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined) return current;
  return Math.max(0, current - previous);
}
