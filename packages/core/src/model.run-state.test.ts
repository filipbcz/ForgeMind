import { describe, expect, it } from 'vitest';
import {
  createBlockedRunState,
  createRetryScheduledRunState,
  createWaitingRunState,
  getRunStateDetail,
  getRunStateLabel,
  normalizeRunState
} from './model.js';

describe('shared task run state model', () => {
  it('models active, waiting, retry scheduled, blocked, and failed run states', () => {
    expect(normalizeRunState('running')).toMatchObject({ version: 1, status: 'running' });
    expect(createWaitingRunState('inactive_worker')).toMatchObject({ version: 1, status: 'waiting', reason: 'inactive_worker' });
    expect(createRetryScheduledRunState({ nextAttemptAt: '2026-08-25T00:00:00.000Z' })).toMatchObject({
      version: 1,
      status: 'retry_scheduled',
      reason: 'retry_backoff'
    });
    expect(createBlockedRunState('validation_failed')).toMatchObject({ version: 1, status: 'blocked', reason: 'validation_failed' });
    expect(normalizeRunState('failed')).toMatchObject({ version: 1, status: 'failed' });
  });

  it('keeps inactive worker and paused queue waiting reasons distinct', () => {
    const inactive = createWaitingRunState('inactive_worker');
    const paused = createWaitingRunState('paused_queue');

    expect(inactive.reason).not.toBe(paused.reason);
    expect(getRunStateDetail(paused)).toBeDefined();
    expect(getRunStateLabel(createRetryScheduledRunState())).toBe('Retry scheduled');
  });
});
