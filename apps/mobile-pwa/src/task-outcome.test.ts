import { describe, expect, it } from 'vitest';
import { resolveTaskOutcome } from './App.js';
import type { AuditEventApi, TaskSummary } from './types.js';

const completedTask = {
  id: 'task_1',
  projectId: 'project_1',
  title: 'Historical task',
  prompt: 'Implement it',
  acceptanceCriteria: [],
  status: 'completed',
  currentStep: 'Completed',
  mode: 'safe',
  iterations: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  plan: [],
  testResult: 'passed',
  diffSummary: ''
} satisfies TaskSummary;

function readyEvent(deliveryResult: unknown): AuditEventApi {
  return {
    id: 'audit_1',
    actorType: 'system',
    eventType: 'task_status_ready_for_user_review',
    taskId: completedTask.id,
    payload: { deliveryResult },
    createdAt: '2026-09-01T00:00:00.000Z'
  };
}

describe('task outcome presentation', () => {
  it('does not claim confirmed delivery for a legacy completed task', () => {
    expect(resolveTaskOutcome(completedTask, []).delivery).toBe('Historicky dokončeno, stav předání není známý');
  });

  it('only presents delivery as confirmed with explicit merge confirmation', () => {
    expect(resolveTaskOutcome(completedTask, [readyEvent({ status: 'completed', mergeConfirmed: null })]).delivery)
      .toBe('Historicky dokončeno, stav předání není známý');
    expect(resolveTaskOutcome(completedTask, [readyEvent({ status: 'completed', mergeConfirmed: true })]).delivery)
      .toBe('Potvrzeno');
  });
});
