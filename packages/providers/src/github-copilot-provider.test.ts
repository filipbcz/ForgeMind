import { describe, expect, it } from 'vitest';
import { createProvider } from './index.js';
import { GitHubCopilotProvider } from './github-copilot-provider.js';

describe('GitHub Copilot provider', () => {
  it('constructs a github_copilot provider instance', () => {
    const provider = new GitHubCopilotProvider();
    expect(provider.kind).toBe('github_copilot');
  });

  it('is returned by the provider factory', () => {
    const provider = createProvider('github_copilot');
    expect(provider.kind).toBe('github_copilot');
  });
});