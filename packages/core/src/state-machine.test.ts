import { describe, expect, it } from 'vitest';
import { canTransitionTask, TERMINAL_TASK_STATUSES } from './state-machine.js';

describe('task state machine', () => {
  it('allows the happy path from draft to submitted', () => {
    expect(canTransitionTask('draft', 'submitted')).toBe(true);
  });

  it('allows approval pauses from validating when guardrails trigger after validation starts', () => {
    expect(canTransitionTask('validating', 'needs_approval')).toBe(true);
  });

  it('allows a failed pull request check to return to AI correction', () => {
    expect(canTransitionTask('creating_pr', 'running_ai')).toBe(true);
    expect(canTransitionTask('creating_pr', 'validation_failed')).toBe(true);
  });

  it('allows disabled GitHub phases to be skipped', () => {
    expect(canTransitionTask('planning', 'creating_branch')).toBe(true);
    expect(canTransitionTask('planning', 'running_ai')).toBe(true);
    expect(canTransitionTask('creating_github_issue', 'running_ai')).toBe(true);
    expect(canTransitionTask('reviewing', 'ready_for_user_review')).toBe(true);
  });

  it('does not allow reopening terminal statuses directly', () => {
    expect(TERMINAL_TASK_STATUSES.has('completed')).toBe(true);
    expect(canTransitionTask('completed', 'running_ai')).toBe(false);
  });

  it('allows a cancelled task to close after its externally delivered pull request is verified as merged', () => {
    expect(TERMINAL_TASK_STATUSES.has('cancelled')).toBe(true);
    expect(canTransitionTask('cancelled', 'completed')).toBe(true);
    expect(canTransitionTask('cancelled', 'running_ai')).toBe(false);
  });
});
