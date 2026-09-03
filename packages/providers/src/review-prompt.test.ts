import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from './review-prompt.js';

describe('review prompt', () => {
  it('limits review to repository inspection and task satisfaction', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-1',
      taskTitle: 'Add profile selection',
      taskPrompt: 'Implement profile selection without changing authentication.',
      repositoryPath: '/workspace',
      changedFiles: ['src/app.ts'],
      acceptanceCriteria: ['A profile can be selected.'],
      diff: '',
      localValidationCheckCount: 1
    });

    expect(prompt).toContain('Inspect the current repository in read-only mode');
    expect(prompt).toContain('1 local validation check(s) passed.');
    expect(prompt).toContain('Do not run builds or tests');
    expect(prompt).toContain('Return blockers only for concrete missing or incorrect implementation.');
    expect(prompt).toContain('Return verdict "satisfied"');
    expect(prompt).toContain('A profile can be selected.');
    expect(prompt).not.toContain('npm test');
    expect(prompt).not.toContain('validationChecks');
  });

  it('does not send a diff to a provider with native read-only repository access', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-native',
      taskTitle: 'Inspect repository',
      taskPrompt: 'Implement the requested repository change.',
      repositoryPath: '/workspace',
      changedFiles: ['src/app.ts'],
      acceptanceCriteria: [],
      diff: 'SECRET LARGE DIFF',
      nativeRepositoryAccess: true,
      deferredValidationChecks: [{ command: 'cmake --build build', criterion: 'Windows build passes.' }]
    });

    expect(prompt).not.toContain('SECRET LARGE DIFF');
    expect(prompt).toContain('No local executable validation ran; 1 environment-specific check(s) are deferred');
    expect(prompt).toContain('Deferred environment-specific validation (not executed and not passed)');
  });

  it('rechecks the complete repository after a correction', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-2',
      taskTitle: 'Fix leaderboard fallback',
      taskPrompt: 'Use correctCount when a leaderboard score is null.',
      repositoryPath: '/workspace',
      changedFiles: ['src/leaderboard.ts'],
      acceptanceCriteria: ['Null scores use correctCount.'],
      previousReviewSummary: 'The initial implementation had one blocker.',
      previousReviewBlockers: ['score: null was treated as zero.'],
      diff: ''
    });

    expect(prompt).toContain('score: null was treated as zero.');
    expect(prompt).toContain('Re-evaluate the complete current repository');
    expect(prompt).toContain('did not introduce regressions elsewhere');
  });

  it('bounds changed-file context because the repository remains authoritative', () => {
    const changedFiles = Array.from({ length: 1_000 }, (_, index) => `generated/path-${index}/artifact.cpp`);
    const prompt = buildReviewPrompt({
      taskId: 'task-3',
      taskTitle: 'Review generated output',
      taskPrompt: 'Verify the implementation.',
      repositoryPath: '/workspace',
      changedFiles,
      acceptanceCriteria: [],
      diff: ''
    });

    expect(prompt).toContain('additional changed file paths omitted');
    expect(prompt.length).toBeLessThan(30_000);
  });
});
