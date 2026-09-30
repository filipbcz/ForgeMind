export interface ModelTokenPricing {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
  sourceVersion: string;
}

/** Standard-processing, short-context prices captured from the OpenAI pricing page on 2026-09-29. */
const OPENAI_PRICING: Array<{ pattern: RegExp; pricing: ModelTokenPricing }> = [
  { pattern: /^gpt-6-astra(?:-|$)/, pricing: { inputPerMillionUsd: 5, cachedInputPerMillionUsd: 0.5, outputPerMillionUsd: 25, sourceVersion: 'openai-2026-09-29' } },
  { pattern: /^gpt-6\.1-sol(?:-|$)/, pricing: { inputPerMillionUsd: 1, cachedInputPerMillionUsd: 0.05, outputPerMillionUsd: 5, sourceVersion: 'openai-2026-09-29' } },
  { pattern: /^gpt-6-luna(?:-|$)/, pricing: { inputPerMillionUsd: 0.05, cachedInputPerMillionUsd: 0.005, outputPerMillionUsd: 0.25, sourceVersion: 'openai-2026-09-29' } },
  { pattern: /^gpt-5\.6-sol(?:-|$)/, pricing: { inputPerMillionUsd: 4, cachedInputPerMillionUsd: 0.4, outputPerMillionUsd: 20, sourceVersion: 'openai-2026-09-29' } },
  { pattern: /^gpt-5\.3-codex(?:-|$)/, pricing: { inputPerMillionUsd: 1.75, cachedInputPerMillionUsd: 0.175, outputPerMillionUsd: 14, sourceVersion: 'openai-2026-09-29' } }
];

export function resolveModelTokenPricing(model: string): ModelTokenPricing | undefined {
  return OPENAI_PRICING.find((entry) => entry.pattern.test(model))?.pricing;
}

export function calculateModelCostUsd(input: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}): number | undefined {
  const pricing = resolveModelTokenPricing(input.model);
  if (!pricing || input.inputTokens === undefined || input.outputTokens === undefined) return undefined;
  const cached = Math.min(input.cachedTokens ?? 0, input.inputTokens);
  const uncached = input.inputTokens - cached;
  return Number((
    (uncached * pricing.inputPerMillionUsd + cached * pricing.cachedInputPerMillionUsd + input.outputTokens * pricing.outputPerMillionUsd)
    / 1_000_000
  ).toFixed(8));
}
