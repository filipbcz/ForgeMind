export * from './provider.js';
export * from './openai-provider.js';
export * from './codex-provider.js';

import type { ProviderKind } from '@forgemind/core';
import type { AIProvider } from './provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { CodexProvider } from './codex-provider.js';

export function createProvider(kind: ProviderKind): AIProvider {
  if (kind === 'openai') {
    return new OpenAIProvider();
  }

  if (kind === 'codex') {
    return new CodexProvider();
  }

  throw new Error(`Provider "${kind}" is not implemented.`);
}
