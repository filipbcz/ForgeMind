import { describe, expect, it, vi } from 'vitest';
import { advanceRoadmapAfterTaskCapabilityWait, advanceRoadmapAfterTaskCompletion } from './roadmap.js';

const configuredProjectYaml = `
project:
  id: project_1
  name: Project
  repo: demo/repo
  default_branch: main
  type: node
  runtime: node
workflow:
  default_mode: safe
  create_issue: true
  create_branch: true
  create_draft_pr: true
  auto_push: true
  auto_merge: false
  allow_ai_auto_improvements: false
ai:
  primary_provider: codex
  reviewer_provider: codex
  model_profile: balanced
limits:
  max_iterations: 4
  max_runtime_minutes: 60
  max_changed_files: 20
  max_diff_lines: 1000
  max_repeated_error_count: 2
commands: {}
approval:
  required_for: []
  auto_allowed: []
sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths: [/workspace]
  forbidden_paths: [/etc]
github:
  issue_label: ai-task
  branch_prefix: ai/
  pr_draft: true
  require_ci_green: true
`;

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
        configYaml: configuredProjectYaml,
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
    expect(createAndStartRoadmapStepTask).toHaveBeenCalledWith('step_2', expect.objectContaining({ maxIterations: 4 }));
    expect(second.nextTask).toBeUndefined();
  });

  it('leaves a contract cycle ready for a manually started audit after the final step', async () => {
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

    expect(result.auditQueued).toBe(false);
    expect(result.completedCycle).toBeUndefined();
    expect(enqueueProjectAudit).not.toHaveBeenCalled();
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

  it('does not start a later step while its declared dependency is not completed', async () => {
    const createAndStartRoadmapStepTask = vi.fn();
    const repository = {
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Objective', status: 'active' }],
        steps: [
          { id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1, title: 'First', description: 'First', acceptanceCriteria: ['Done'], status: 'cancelled', taskId: 'task_1' },
          { id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2, title: 'Second', description: 'Second', acceptanceCriteria: ['Done'], dependsOnStepTitles: ['First'], status: 'pending' }
        ]
      })),
      getProject: vi.fn(async () => ({ id: 'project_1', name: 'Project', defaultTaskMode: 'auto' })),
      createAndStartRoadmapStepTask
    };

    const result = await import('./roadmap.js').then(({ startNextRoadmapStep }) => (
      startNextRoadmapStep(repository as never, 'project_1', 'cycle_1')
    ));

    expect(result).toBeUndefined();
    expect(createAndStartRoadmapStepTask).not.toHaveBeenCalled();
  });

  it('marks a capability-blocked step as waiting and starts an independent step', async () => {
    const steps = [
      { id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1, title: 'Win64 gate', description: 'Run Win64', acceptanceCriteria: ['Runs'], dependsOnStepTitles: [], status: 'running', taskId: 'task_1' },
      { id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2, title: 'Docs', description: 'Document', acceptanceCriteria: ['Documented'], dependsOnStepTitles: [], status: 'pending' }
    ];
    const repository = {
      getImplementationStepByTaskId: vi.fn(async () => steps[0]),
      updateImplementationStepStatus: vi.fn(async (_id: string, status: string) => {
        steps[0]!.status = status;
        return steps[0];
      }),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Objective', status: 'active' }],
        steps
      })),
      getProject: vi.fn(async () => ({ id: 'project_1', name: 'Project', defaultTaskMode: 'auto' })),
      createAndStartRoadmapStepTask: vi.fn(async () => ({ id: 'task_2' }))
    };

    const result = await advanceRoadmapAfterTaskCapabilityWait(repository as never, 'task_1');

    expect(steps[0]!.status).toBe('waiting_for_capability');
    expect(result.nextTask?.id).toBe('task_2');
  });

  it('does not audit a cycle while another step still waits for a capable worker', async () => {
    const completedTaskStep = { id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2, title: 'Docs', status: 'running', taskId: 'task_2' };
    const enqueueProjectAudit = vi.fn();
    const repository = {
      getImplementationStepByTaskId: vi.fn(async () => completedTaskStep),
      updateImplementationStepStatus: vi.fn(async () => ({ ...completedTaskStep, status: 'completed' })),
      getProjectRoadmap: vi.fn(async () => ({
        projectId: 'project_1',
        cycles: [{ id: 'cycle_1', projectId: 'project_1', cycleNumber: 1, objective: 'Objective', status: 'active' }],
        steps: [
          { id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1, title: 'Win64 gate', status: 'waiting_for_capability', taskId: 'task_1' },
          { ...completedTaskStep, status: 'completed' }
        ]
      })),
      getProject: vi.fn(async () => ({ id: 'project_1', name: 'Project', projectContract: { version: 1, requirements: [], invariants: [], prohibitedSubstitutes: [], releaseCriteria: [] } })),
      enqueueProjectAudit
    };

    const result = await advanceRoadmapAfterTaskCompletion(repository as never, 'task_2');

    expect(result.auditQueued).toBeUndefined();
    expect(enqueueProjectAudit).not.toHaveBeenCalled();
  });
});
