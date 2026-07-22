import { describe, expect, it } from 'vitest';
import { canTransitionTask, TERMINAL_TASK_STATUSES } from './state-machine.js';

describe('task state machine', () => {
  it('allows the happy path from draft to submitted', () => {
    expect(canTransitionTask('draft', 'submitted')).toBe(true);
  });

  it('allows approval pauses from validating when guardrails trigger after validation starts', () => {
    expect(canTransitionTask('validating', 'needs_approval')).toBe(true);
  });

  it('does not allow reopening terminal statuses directly', () => {
    expect(TERMINAL_TASK_STATUSES.has('completed')).toBe(true);
    expect(canTransitionTask('completed', 'running_ai')).toBe(false);
  });
});
