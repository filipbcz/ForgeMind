import { describe, expect, it } from 'vitest';
import type { ProjectRoadmapApi } from './types.js';
import { summarizeProjectProgress } from './project-progress.js';

function roadmap(overrides: Partial<ProjectRoadmapApi> = {}): ProjectRoadmapApi {
  return {
    projectId: 'project_1',
    cycles: [{
      id: 'cycle_1',
      projectId: 'project_1',
      cycleNumber: 1,
      objective: 'Build the application',
      status: 'active',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z'
    }],
    steps: [
      {
        id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1,
        title: 'Foundation', description: '', acceptanceCriteria: [], requirementIds: [], deliverables: [],
        changeRationale: '', dependsOnStepTitles: [], validationFocus: ['implementation'],
        status: 'completed', taskId: 'task_1', createdAt: '', updatedAt: ''
      },
      {
        id: 'step_2', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2,
        title: 'User flow', description: '', acceptanceCriteria: [], requirementIds: [], deliverables: [],
        changeRationale: '', dependsOnStepTitles: [], validationFocus: ['implementation'],
        status: 'pending', createdAt: '', updatedAt: ''
      }
    ],
    evidence: [],
    capabilities: [],
    auditJobs: [],
    ...overrides
  };
}

describe('summarizeProjectProgress', () => {
  it('shows the next roadmap step after the selected task is completed', () => {
    expect(summarizeProjectProgress(roadmap(), 'task_1')).toMatchObject({
      tone: 'active',
      headline: 'Další krok 2: User flow',
      completedSteps: 1,
      totalSteps: 2,
      taskPosition: 1
    });
  });

  it('shows that a completed implementation is waiting for a manual audit', () => {
    const source = roadmap({
      steps: [{
        id: 'step_1', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1,
        title: 'Only step', description: 'Done', acceptanceCriteria: ['Done'], requirementIds: ['REQ-1'],
        deliverables: ['Feature'], changeRationale: 'Complete the only planned capability.',
        dependsOnStepTitles: [], validationFocus: [], status: 'completed', taskId: 'task_1',
        createdAt: '', updatedAt: ''
      }]
    });

    expect(summarizeProjectProgress(source, 'task_1')).toMatchObject({
      tone: 'attention',
      headline: 'Implementace je hotová, audit čeká'
    });
  });

  it('prioritizes a running project audit over roadmap steps', () => {
    const summary = summarizeProjectProgress(roadmap({
      auditJobs: [{
        id: 'audit_1', projectId: 'project_1', cycleId: 'cycle_1', requirementIds: [],
        status: 'claimed', attemptCount: 1, createdAt: '', updatedAt: ''
      }]
    }), 'task_1');

    expect(summary.headline).toBe('Probíhá projektový audit');
    expect(summary.tone).toBe('active');
  });

  it('shows a running repair step instead of a previous failed audit', () => {
    const source = roadmap({
      auditJobs: [{
        id: 'audit_1', projectId: 'project_1', cycleId: 'cycle_1', requirementIds: [],
        status: 'failed', attemptCount: 1, errorMessage: 'Missing behavior', createdAt: '', updatedAt: ''
      }]
    });
    source.steps[1]!.status = 'running';

    expect(summarizeProjectProgress(source, 'task_1')).toMatchObject({
      tone: 'active',
      headline: 'Probíhá krok 2: User flow'
    });
  });

  it('shows when the project is waiting for an extension decision', () => {
    const source = roadmap();
    source.cycles[0]!.status = 'awaiting_extension_approval';
    source.steps[1]!.status = 'completed';

    expect(summarizeProjectProgress(source, 'task_1')).toMatchObject({
      tone: 'attention',
      headline: 'Čeká se na rozhodnutí o rozšíření',
      completedSteps: 2
    });
  });
});
