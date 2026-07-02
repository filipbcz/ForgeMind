import { describe, expect, it } from 'vitest';
import { MockProvider } from './mock-provider.js';

describe('MockProvider', () => {
  it('requests approval when a prompt asks for a dependency change', async () => {
    const provider = new MockProvider();
    const plan = await provider.plan({ taskId: 'task_1', title: 'Test', prompt: 'Add npm dependency' });
    const result = await provider.implement({
      taskId: 'task_1',
      prompt: 'Add npm dependency',
      plan,
      repositoryPath: '/tmp/repo'
    });

    expect(result.requestedApprovals).toContain('new_dependency');
  });
});

