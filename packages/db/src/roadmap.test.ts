import { describe, expect, it, vi } from 'vitest';
import { advanceRoadmapAfterTaskCompletion } from './roadmap.js';

describe('roadmap task completion', () => {
  it('completes the linked step and starts the next pending step exactly once', async () => {
    const steps = [
      { id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1, title: 'First', description: 'First step', acceptanceCriteria: ['Done'], status: 'running', taskId: 'task_1' },
      { id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2, title: 'Second', description: 'Second step', acceptanceCriteria: ['Done too'], status: 'pending' }
    ];
    const createAndStartRoadmapStepTask = vi.fn(async (_stepId, input) => {
      const step = steps.find((candidate) => candidate.status === 'pending');
      if (!step || steps.some((candidate) => candidate.status === 'running')) return undefined;
      step.status = 'running';
      step.taskId = 'task_2';
      return { id: 'task_2', createdByUserId: 'user_1', status: 'submitted', createdAt: '', updatedAt: '', ...input };
    });
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
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project', defaultTaskMode: 'auto',
        projectContract: {
          version: 1, summary: 'Project', invariants: [], prohibitedSubstitutes: [],
          requirements: [{ id: 'REQ-1', title: 'Feature', description: 'Feature works.', acceptanceCriteria: ['Done'] }],
          releaseCriteria: ['Build passes.']
        }
      })),
      createAndStartRoadmapStepTask,
      updateProjectRoadmapCycleStatus: vi.fn(),
      enqueueProjectAudit: vi.fn()
    };

    const first = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_1');
    const second = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_1');

    expect(first.nextTask?.id).toBe('task_2');
    expect(steps.map((step) => step.status)).toEqual(['completed', 'running']);
    expect(createAndStartRoadmapStepTask).toHaveBeenCalledTimes(1);
    expect(second.nextTask).toBeUndefined();
  });

  it('queues one completion audit instead of completing the cycle after the final step', async () => {
    const step = {
      id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1,
      title: 'Only step', description: 'Done', acceptanceCriteria: ['Done'], requirementIds: ['REQ-1'], deliverables: ['Feature'],
      status: 'running', taskId: 'task_1'
    };
    const enqueueProjectAudit = vi.fn(async () => ({ enqueued: true, job: { id: 'audit_1' } }));
    const repository = {
      getImplementationStepByTaskId: vi.fn(async () => step),
      updateImplementationStepStatus: vi.fn(async () => ({ ...step, status: 'completed' })),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Objective', status: 'active' }],
        steps: [{ ...step, status: 'completed' }]
      })),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project', defaultTaskMode: 'auto',
        projectContract: {
          version: 1, summary: 'Project', invariants: [], prohibitedSubstitutes: [],
          requirements: [{ id: 'REQ-1', title: 'Feature', description: 'Feature works.', acceptanceCriteria: ['Done'] }],
          releaseCriteria: ['Build passes.']
        }
      })),
      enqueueProjectAudit,
      updateProjectRoadmapCycleStatus: vi.fn()
    };

    const result = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_1');

    expect(result.auditQueued).toBe(true);
    expect(result.completedCycle).toBeUndefined();
    expect(enqueueProjectAudit).toHaveBeenCalledWith({
      projectId: 'project_1', cycleId: 'cycle_1', triggerTaskId: 'task_1', requirementIds: ['REQ-1']
    });
    expect(repository.updateProjectRoadmapCycleStatus).not.toHaveBeenCalled();
  });

  it('starts the next planned step before auditing completed requirements', async () => {
    const steps = [
      { id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1, title: 'API', description: 'API', acceptanceCriteria: ['API works'], requirementIds: ['REQ-API'], deliverables: ['API'], status: 'running', taskId: 'task_1' },
      { id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2, title: 'UI', description: 'UI', acceptanceCriteria: ['UI works'], requirementIds: ['REQ-UI'], deliverables: ['UI'], status: 'pending' }
    ];
    const enqueueProjectAudit = vi.fn(async () => ({ enqueued: true, job: { id: 'audit_1' } }));
    const repository = {
      getImplementationStepByTaskId: vi.fn(async () => steps[0]),
      updateImplementationStepStatus: vi.fn(async () => ({ ...steps[0], status: 'completed' })),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Objective', status: 'active' }],
        steps: [{ ...steps[0], status: 'completed' }, steps[1]],
        capabilities: []
      })),
      getProject: vi.fn(async () => ({
        id: 'project_1', name: 'Project',
        projectContract: {
          version: 1, summary: 'Project', invariants: [], prohibitedSubstitutes: [], releaseCriteria: ['Build passes'],
          requirements: [
            { id: 'REQ-API', title: 'API', description: 'API', acceptanceCriteria: ['API works'] },
            { id: 'REQ-UI', title: 'UI', description: 'UI', acceptanceCriteria: ['UI works'] }
          ]
        }
      })),
      enqueueProjectAudit,
      createAndStartRoadmapStepTask: vi.fn(async (_stepId: string, input) => {
        steps[1]!.taskId = 'task_2';
        steps[1]!.status = 'running';
        return { id: 'task_2', createdByUserId: 'user_1', status: 'submitted', createdAt: '', updatedAt: '', ...input };
      }),
    };

    const result = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_1');

    expect(result.nextTask?.id).toBe('task_2');
    expect(enqueueProjectAudit).not.toHaveBeenCalled();
    expect(repository.createAndStartRoadmapStepTask).toHaveBeenCalledTimes(1);
  });
});
