import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from './review-prompt.js';

describe('review prompt', () => {
  it('supplies review evidence, prohibits repeated validation, and requires semantic evaluation', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-1',
      taskTitle: 'Add profile selection',
      taskPrompt: 'Implement profile selection without changing authentication.',
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
    expect(prompt).toContain('Do not repeat the supplied validation commands.');
    expect(prompt).toContain('Treat exit code 0 as evidence that a command completed, not by itself as proof');
    expect(prompt).toContain('exit code 0 establishes that every chained command exited successfully');
    expect(prompt).toContain('meaningfully verify the acceptance criteria');
    expect(prompt).toContain('smallest exact command checks needed to prove it in validationChecks');
    expect(prompt).toContain('Commands proposed in validationChecks will be safety-checked and executed by ForgeMind');
    expect(prompt).toContain('Return one criterionResults entry for every explicit acceptance criterion');
    expect(prompt).toContain('Implement profile selection without changing authentication.');
    expect(prompt).toContain('A profile can be selected.');
    expect(prompt).toContain('Command: npm test && npm run build');
    expect(prompt).toContain('+export const selected = true;');
  });

  it('preserves the beginning and end of long validation output', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-long-output',
      taskTitle: 'Build terrain runtime',
      taskPrompt: 'Build and execute the terrain runtime test.',
      repositoryPath: '/workspace',
      changedFiles: ['Tests/TerrainRuntimeTests.cpp'],
      acceptanceCriteria: ['Terrain runtime test passes.'],
      validation: {
        command: 'cmake --build --preset test && ctest --test-dir out/build/test',
        exitCode: 0,
        stdout: `CONFIGURATION_START\n${'x'.repeat(3_000)}\n100% tests passed, 0 tests failed out of 1`,
        stderr: '',
        passed: true
      },
      diff: '+int main() { return 0; }'
    });

    expect(prompt).toContain('CONFIGURATION_START');
    expect(prompt).toContain('validation output truncated:');
    expect(prompt).toContain('100% tests passed, 0 tests failed out of 1');
  });

  it('bounds very large changed-file lists without dropping the review diff', () => {
    const changedFiles = Array.from({ length: 1_000 }, (_, index) =>
      `build-validation/generated/path-${index.toString().padStart(4, '0')}/artifact.cpp`
    );
    const prompt = buildReviewPrompt({
      taskId: 'task-large-file-list',
      taskTitle: 'Review generated integration output',
      taskPrompt: 'Review the implementation without exhausting provider context.',
      repositoryPath: '/workspace',
      changedFiles,
      acceptanceCriteria: ['The implementation remains reviewable.'],
      validation: { command: 'npm test', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
      diff: '+export const reviewed = true;'
    });

    expect(prompt).toContain('additional changed file paths omitted; inspect the bounded diff below');
    expect(prompt).toContain('+export const reviewed = true;');
    expect(prompt.length).toBeLessThan(30_000);
  });

  it('limits follow-up review to the correction and previous blockers', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-2',
      taskTitle: 'Fix leaderboard fallback',
      taskPrompt: 'Use correctCount when a leaderboard score is null.',
      repositoryPath: '/workspace',
      changedFiles: ['src/leaderboard.ts'],
      acceptanceCriteria: ['Null scores use correctCount.'],
      previousReviewSummary: 'The initial implementation had one blocker.',
      previousReviewBlockers: ['score: null was treated as zero.'],
      validation: {
        command: 'npm test',
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
        passed: true
      },
      diff: '+if (score == null) return correctCount;'
    });

    expect(prompt).toContain('This packet contains only files changed by the correction pass.');
    expect(prompt).toContain('score: null was treated as zero.');
    expect(prompt).toContain('+if (score == null) return correctCount;');
  });

  it('reviews architecture boundary changes against the persisted context', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-3', taskTitle: 'Add reporting', taskPrompt: 'Add reporting without crossing persistence boundaries.', repositoryPath: '/workspace', changedFiles: ['src/reporting.ts'],
      acceptanceCriteria: ['Reporting works.'],
      validation: { command: 'npm test', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
      diff: '+import { db } from "./internal-db";',
      architectureContext: 'Reporting must depend on Persistence interfaces only.',
      architectureUpdate: { decisions: [{ summary: 'Reporting boundary', rationale: 'Keep storage replaceable.' }] }
    });

    expect(prompt).toContain('Relevant project architecture:');
    expect(prompt).toContain('Reporting must depend on Persistence interfaces only.');
    expect(prompt).toContain('Proposed architecture delta:');
  });

  it('requires criterion-by-criterion evidence when reviewing an unchanged repository state', () => {
    const prompt = buildReviewPrompt({
      taskId: 'task-4',
      taskTitle: 'Verify existing profile flow',
      taskPrompt: 'Ensure an existing profile can be selected.',
      repositoryPath: '/workspace',
      changedFiles: ['src/profile.ts'],
      acceptanceCriteria: ['An existing profile can be selected.'],
      validation: { command: 'npm test', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
      diff: '',
      reviewMode: 'existing_state',
      repositoryEvidence: '--- src/profile.ts ---\nexport function selectProfile() {}'
    });

    expect(prompt).toContain('Verify only the supplied ForgeMind existing-state evidence packet.');
    expect(prompt).toContain('Return one criterionResults entry for every explicit acceptance criterion');
    expect(prompt).toContain('Do not inspect repository files outside the supplied evidence packet');
    expect(prompt).toContain('--- src/profile.ts ---');
    expect(prompt).toContain('Diff:\n(not applicable for existing-state verification)');
  });
});
