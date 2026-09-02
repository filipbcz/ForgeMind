import { describe, expect, it } from 'vitest';
import {
  activityWorkflowStage,
  currentExecutionEntries,
  resolveCurrentActivity,
  sanitizeProviderActivityDetail
} from './activity-display.js';

describe('activity display', () => {
  it('scopes current phase state to the latest task run', () => {
    const entries = [
      { createdAt: '2026-08-14T10:00:00.000Z', state: 'failed' as const, attempt: 1, runId: 'run_1' },
      { createdAt: '2026-08-14T10:01:00.000Z', state: 'progress' as const, attempt: 1, runId: 'run_2' }
    ];

    expect(currentExecutionEntries(entries)).toEqual([entries[1]]);
  });

  it('uses the explicitly selected run and excludes timing from older retries', () => {
    const entries = [
      { createdAt: '2026-08-14T10:00:00.000Z', state: 'completed' as const, attempt: 1, runId: 'run_1' },
      { createdAt: '2026-08-14T10:01:00.000Z', state: 'completed' as const, attempt: 2, runId: 'run_2' },
      { createdAt: '2026-08-14T10:01:01.000Z', state: 'progress' as const, attempt: 2 }
    ];

    expect(currentExecutionEntries(entries, 'run_2')).toEqual(entries.slice(1));
    expect(currentExecutionEntries(entries, 'run_3')).toEqual([]);
  });

  it('maps GitHub setup status events separately from delivery operations', () => {
    expect(activityWorkflowStage({ phase: 'github' })).toBe(1);
    expect(activityWorkflowStage({ phase: 'github', operation: 'create_branch' })).toBe(1);
    expect(activityWorkflowStage({ phase: 'github', operation: 'merge_pr' })).toBe(5);
  });

  it('does not present an old failure as current after the task advances', () => {
    const entries = [
      { createdAt: '2026-08-14T10:00:00.000Z', state: 'failed' as const, attempt: 1, runId: 'run_1' }
    ];

    expect(resolveCurrentActivity(entries, '2026-08-14T10:01:00.000Z', true)).toBeUndefined();
  });

  it('removes source patches while preserving the command result', () => {
    const message = [
      'Finished (exit 0): apply patch',
      '+ const result = document.createElement("li");',
      '+ result.className = "answer";',
      '+ return result;'
    ].join('\n');

    expect(sanitizeProviderActivityDetail('stdout', message)).toBe('Finished (exit 0): apply patch');
  });

  it('keeps diagnostics and normal command output visible', () => {
    expect(sanitizeProviderActivityDetail('stderr', 'src/app.ts(4,2): error TS2345')).toContain('TS2345');
    expect(sanitizeProviderActivityDetail('stdout', 'Finished (exit 0): npm test\n42 tests passed')).toContain('42 tests passed');
  });
});
