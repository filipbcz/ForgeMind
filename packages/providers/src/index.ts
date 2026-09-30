export * from './provider.js';
export * from './review-prompt.js';
export * from './roadmap-review-prompt.js';
export * from './audit-prompt.js';
export * from './extension-prompt.js';
export * from './openai-provider.js';
export * from './codex-provider.js';
export * from './github-copilot-provider.js';
export * from './model-pricing.js';

import type { ProviderKind } from '@forgemind/core';
import type { AIProvider } from './provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GitHubCopilotProvider } from './github-copilot-provider.js';
import { ModelRoutedProvider, type ModelProfile, type ReasoningEffort } from './model-router.js';

export type { ModelProfile, ModelRoute, ModelWorkload, ReasoningEffort } from './model-router.js';
export { resolveModelRoute } from './model-router.js';

export interface ProviderRuntimeConfig {
  apiKey?: string;
  authMode?: 'api_key';
  codexHome?: string;
  model?: string;
  /** Use Codex CLI as the API-key-authenticated local tool runtime. */
  useCli?: boolean;
  /** Optional workload-aware model policy. Omit to preserve a single explicit model. */
  modelProfile?: ModelProfile;
  reasoningEffort?: ReasoningEffort;
}

export function createProvider(kind: ProviderKind, config?: ProviderRuntimeConfig): AIProvider {
  if (config?.modelProfile && kind !== 'github_copilot') {
    return new ModelRoutedProvider(kind, { ...config, modelProfile: config.modelProfile }, createBaseProvider);
  }
  return createBaseProvider(kind, config);
}

function createBaseProvider(kind: ProviderKind, config?: ProviderRuntimeConfig): AIProvider {
  if (kind === 'openai') {
    return new OpenAIProvider(config);
  }

  if (kind === 'codex') {
    return new CodexProvider(config);
  }

  if (kind === 'github_copilot') {
    return new GitHubCopilotProvider(config);
  }

  throw new Error(`Provider "${kind}" is not implemented.`);
}
