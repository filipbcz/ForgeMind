import type { ProviderKind } from '@forgemind/core';
import type { ProviderActivityHandler, ProviderUsageMeasurement } from './provider.js';

export function normalizeTokenBreakdown(input: {
  provider: ProviderKind;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}): ProviderUsageMeasurement | undefined {
  const inputTokens = normalizeTokenCount(input.inputTokens);
  const outputTokens = normalizeTokenCount(input.outputTokens);
  const cachedTokens = normalizeTokenCount(input.cachedTokens);
  const reportedTotal = normalizeTokenCount(input.totalTokens);
  const totalTokens = reportedTotal ?? (
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined
  );

  if (totalTokens === undefined) {
    return undefined;
  }

  return {
    provider: input.provider,
    model: input.model,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    source: inputTokens !== undefined && outputTokens !== undefined ? 'actual_breakdown' : 'actual_total'
  };
}

export async function emitCapturedUsage(
  handler: ProviderActivityHandler | undefined,
  usage: ProviderUsageMeasurement | undefined
): Promise<void> {
  if (!handler || !usage) {
    return;
  }

  await handler({
    kind: 'lifecycle',
    message: `Provider usage captured: ${usage.totalTokens} total token(s).`,
    elapsedMs: 0,
    usage
  });
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}
