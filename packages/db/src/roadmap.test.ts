import { describe, expect, it, vi } from 'vitest';
import { advanceRoadmapAfterTaskCompletion } from './roadmap.js';

describe('roadmap task completion', () => {
  it('completes the linked step and starts the next pending step exactly once', async () => {
    const steps = [
      { id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1, title: 'First', description: 'First step', acceptanceCriteria: ['Done'], status: 'running', taskId: 'task_1' },
      { id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2, title: 'Second', description: 'Second step', acceptanceCriteria: ['Done too'], status: 'pending' }
    ];
    const createTask = vi.fn(async (input) => ({ id: 'task_2', createdByUserId: 'user_1', status: 'draft', createdAt: '', updatedAt: '', ...input }));
    const repository = {
      getImplementationStepByTaskId: vi.fn(async (taskId: string) => steps.find((step) => step.taskId === taskId)),
      updateImplementationStepStatus: vi.fn(async (stepId: string, status: string) => {
        const step = steps.find((candidate) => candidate.id === stepId)!;
        step.status = status;
        return step;
      }),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Objective', status: 'active' }],
        steps
      })),
      getProject: vi.fn(async () => ({ id: 'project_1', name: 'Project', defaultTaskMode: 'auto' })),
      createTask,
      assignTaskToImplementationStep: vi.fn(async (stepId: string, taskId: string, status: string) => {
        const step = steps.find((candidate) => candidate.id === stepId)!;
        step.taskId = taskId;
        step.status = status;
        return step;
      }),
      startTask: vi.fn(async () => ({ id: 'task_2', projectId: 'project_1', title: 'Project: Second', prompt: 'Prompt', mode: 'auto', status: 'submitted' })),
      enqueueTask: vi.fn(async () => ({ enqueued: true })),
      writeAudit: vi.fn(async () => ({ id: 'audit_1' })),
      updateProjectRoadmapCycleStatus: vi.fn()
    };

    const first = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_1');
    const second = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_1');

    expect(first.nextTask?.id).toBe('task_2');
    expect(steps.map((step) => step.status)).toEqual(['completed', 'running']);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(repository.enqueueTask).toHaveBeenCalledTimes(1);
    expect(second.nextTask).toBeUndefined();
  });
});
