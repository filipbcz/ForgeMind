import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from './review-prompt.js';

describe('review prompt', () => {
  it('supplies bounded review evidence and prohibits repeated validation', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-1',
      taskTitle: 'Add profile selection',
      repositoryPath: '/workspace',
      changedFiles: ['src/app.ts'],
      acceptanceCriteria: ['A profile can be selected.'],
      validation: {
        command: 'npm test && npm run build',
        exitCode: 0,
        stdout: 'tests passed',
        stderr: '',
        passed: true
      },
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+export const selected = true;'
    });

    expect(prompt).toContain('Do not run shell commands, tests, builds, type checks, linters, Git commands, or other tools.');
    expect(prompt).toContain('Treat the supplied successful validation result as authoritative');
    expect(prompt).toContain('A profile can be selected.');
    expect(prompt).toContain('Command: npm test && npm run build');
    expect(prompt).toContain('+export const selected = true;');
  });
});
