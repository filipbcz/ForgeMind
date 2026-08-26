import { describe, expect, it } from 'vitest';
import { createProvider } from './index.js';
import { GITHUB_COPILOT_FROZEN_MESSAGE, GitHubCopilotProvider } from './github-copilot-provider.js';

describe('GitHub Copilot provider', () => {
  it('constructs a github_copilot provider instance', () => {
    const provider = new GitHubCopilotProvider();
    expect(provider.kind).toBe('github_copilot');
  });

  it('is returned by the provider factory', () => {
    const provider = createProvider('github_copilot');
    expect(provider.kind).toBe('github_copilot');
  });

  it('does not advertise execution capabilities', () => {
    const provider = new GitHubCopilotProvider();
    expect(provider.supportsLocalRepo()).toBe(false);
    expect(provider.supportsGitHubNativeFlow()).toBe(false);
  });

  it('rejects execution without loading a Copilot runtime', async () => {
    const provider = new GitHubCopilotProvider();
    await expect(provider.plan({} as never)).rejects.toThrow(GITHUB_COPILOT_FROZEN_MESSAGE);
    await expect(provider.listModels()).rejects.toThrow(GITHUB_COPILOT_FROZEN_MESSAGE);
  });
});
