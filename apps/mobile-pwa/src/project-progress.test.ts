import { describe, expect, it } from 'vitest';
import type { ProjectRoadmapApi, TaskSummary } from './types.js';
import { summarizeProjectOperationalOverview, summarizeProjectProgress } from './project-progress.js';

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

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'task_2',
    projectId: 'project_1',
    title: 'Windows validation',
    prompt: '',
    acceptanceCriteria: [],
    status: 'submitted',
    currentStep: '',
    mode: 'safe',
    iterations: 0,
    updatedAt: '',
    plan: [],
    testResult: '',
    diffSummary: '',
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
    source.cycles[0]!.status = 'awaiting_extension_decision';
    source.steps[1]!.status = 'completed';

    expect(summarizeProjectProgress(source, 'task_1')).toMatchObject({
      tone: 'attention',
      headline: 'Čeká se na rozhodnutí o rozšíření',
      completedSteps: 2
    });
  });
});

describe('summarizeProjectOperationalOverview', () => {
  it('offers the recorded audit proposal instead of claiming there is no manual action', () => {
    const source = roadmap();
    source.cycles[0]!.status = 'partial';
    source.steps.forEach(step => { step.status = 'completed'; });
    source.auditJobs = [{
      id: 'audit_1', projectId: 'project_1', cycleId: 'cycle_1', requirementIds: [], status: 'succeeded',
      attemptCount: 1, createdAt: '', updatedAt: '', gapProposalStatus: 'proposed',
      gapProposal: { kind: 'capability', commitSha: 'a'.repeat(40), summary: 'Repair docs.', steps: [], newRequirements: [] }
    }];
    expect(summarizeProjectOperationalOverview(source)).toMatchObject({
      tone: 'attention', state: 'Audit navrhuje opravu', primaryAction: 'review_audit_gaps'
    });
    expect(summarizeProjectProgress(source, 'task_1').headline).toBe('Audit navrhuje opravu');
    source.auditJobs[0]!.gapProposalStatus = 'dismissed';
    expect(summarizeProjectOperationalOverview(source).primaryAction).toBe('none');
  });

  it('puts the next active step and start action first', () => {
    expect(summarizeProjectOperationalOverview(roadmap())).toMatchObject({
      tone: 'active',
      state: 'Připraven další krok',
      activeStep: 'Krok 2: User flow',
      blockers: [],
      primaryAction: 'start_next_step',
      primaryActionLabel: 'Spustit další krok'
    });
  });

  it('maps completed implementation to the manual audit action', () => {
    const source = roadmap();
    source.steps[1]!.status = 'completed';

    expect(summarizeProjectOperationalOverview(source)).toMatchObject({
      tone: 'attention',
      state: 'Audit čeká na spuštění',
      activeStep: '2/2 kroků dokončeno.',
      primaryAction: 'start_audit'
    });
  });

  it('maps blocked audit state to a retry audit action with the audit blocker first', () => {
    const source = roadmap({
      auditJobs: [{
        id: 'audit_1', projectId: 'project_1', cycleId: 'cycle_1', requirementIds: [],
        status: 'blocked', attemptCount: 2, errorMessage: 'Manual evidence missing', createdAt: '', updatedAt: ''
      }]
    });

    expect(summarizeProjectOperationalOverview(source)).toMatchObject({
      tone: 'attention',
      state: 'Audit vyžaduje pozornost',
      blockers: ['Manual evidence missing'],
      primaryAction: 'retry_audit',
      primaryActionLabel: 'Opakovat pouze audit'
    });
  });

  it('maps extension approval wait to the extension decision action', () => {
    const source = roadmap();
    source.cycles[0]!.status = 'awaiting_extension_decision';

    expect(summarizeProjectOperationalOverview(source)).toMatchObject({
      tone: 'attention',
      state: 'Čeká rozhodnutí',
      primaryAction: 'review_extension',
      primaryActionLabel: 'Zobrazit rozhodnutí'
    });
  });

  it('does not offer to start a pending roadmap step that already has a task', () => {
    const source = roadmap();
    source.steps[1]!.taskId = 'task_2';

    expect(summarizeProjectOperationalOverview(source)).toMatchObject({
      tone: 'completed',
      state: 'Cyklus dokončen',
      primaryAction: 'none'
    });
  });
});
