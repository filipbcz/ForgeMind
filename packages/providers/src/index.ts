export * from './provider.js';
export * from './review-prompt.js';
export * from './openai-provider.js';
export * from './codex-provider.js';
export * from './github-copilot-provider.js';

import type { ProviderKind } from '@forgemind/core';
import type { AIProvider } from './provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GitHubCopilotProvider } from './github-copilot-provider.js';

export function createProvider(kind: ProviderKind): AIProvider {
  if (kind === 'openai') {
    return new OpenAIProvider();
  }

  if (kind === 'codex') {
    return new CodexProvider();
  }

  if (kind === 'github_copilot') {
    return new GitHubCopilotProvider();
  }

  throw new Error(`Provider "${kind}" is not implemented.`);
}
