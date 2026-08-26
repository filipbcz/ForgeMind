import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  canStartProjectAudit,
  projectAuditMatchesStatusFilter,
  projectCycleMatchesStatusFilter,
  projectEvidenceMatchesStatusFilter,
  ProjectsPanel,
  projectStepMatchesStatusFilter
} from './App.js';
import type {
  AcceptanceEvidenceApi,
  ProjectAuditJobApi,
  ProjectImplementationStepApi,
  ProjectRoadmapApi,
  ProjectRoadmapCycleApi,
  ProjectSummary
} from './types.js';

const project: ProjectSummary = {
  id: 'project_1',
  name: 'ForgeMind Studio',
  slug: 'forgemind-studio',
  defaultBranch: 'main',
  brief: 'Build a project overview that keeps current operations reachable first.',
  autoCreatePullRequest: true,
  autoMergePullRequest: false,
  autoCompleteTask: false,
  allowSafeOperationsWithoutApproval: false,
  defaultTaskMode: 'safe',
  isActive: true,
  createdAt: '',
  updatedAt: '',
  openPullRequests: 0
};

const roadmap: ProjectRoadmapApi = {
  projectId: 'project_1',
  cycles: [
    {
      id: 'cycle_1',
      projectId: 'project_1',
      cycleNumber: 1,
      objective: 'Build the operational overview.',
      status: 'active',
      createdAt: '',
      updatedAt: ''
    }
  ],
  steps: [
    {
      id: 'step_1',
      projectId: 'project_1',
      cycleId: 'cycle_1',
      sequenceNumber: 1,
      title: 'Foundation',
      description: '',
      acceptanceCriteria: [],
      requirementIds: [],
      deliverables: [],
      changeRationale: '',
      dependsOnStepTitles: [],
      validationFocus: ['implementation'],
      status: 'completed',
      taskId: 'task_1',
      createdAt: '',
      updatedAt: ''
    },
    {
      id: 'step_2',
      projectId: 'project_1',
      cycleId: 'cycle_1',
      sequenceNumber: 2,
      title: 'Mobile action',
      description: '',
      acceptanceCriteria: [],
      requirementIds: [],
      deliverables: [],
      changeRationale: '',
      dependsOnStepTitles: ['Foundation'],
      validationFocus: ['regression'],
      status: 'pending',
      createdAt: '',
      updatedAt: ''
    }
  ],
  evidence: [],
  capabilities: [],
  auditJobs: []
};

function renderProjectsPanel(sourceRoadmap: ProjectRoadmapApi = roadmap): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectsPanel, {
        projects: [project],
        tasks: [],
        selectedProjectId: project.id,
        onSelectProject: vi.fn(),
        roadmap: sourceRoadmap,
        roadmapLoading: false,
        specificationsLoading: false,
        contractsLoading: false,
        architecturesLoading: false,
        saving: false,
        reviewingSpecification: false,
        updatingProject: false,
        projectUpdated: false,
        updatingAutomation: false,
        automationUpdated: false,
        assigningRepository: false,
        generatingRoadmap: false,
        decidingExtension: false,
        retryingAudit: false,
        startingAudit: false,
        startingRoadmapStep: false,
        deletingProject: false,
        onCreateProject: vi.fn(),
        onAssignProjectRepository: vi.fn(),
        onUpdateProjectBrief: vi.fn(),
        onConfirmProjectBrief: vi.fn(),
        onAbandonProjectBriefReview: vi.fn(),
        onUpdateProjectAutomation: vi.fn(),
        onGenerateRoadmap: vi.fn(),
        onDecideExtension: vi.fn(),
        onRetryAudit: vi.fn(),
        onStartAudit: vi.fn(),
        onStartNextRoadmapStep: vi.fn(),
        onDeleteProject: vi.fn(),
        githubRepositories: [],
        githubRepositoriesLoading: false,
        githubRepositoryOwners: [],
        githubRepositoryOwnersLoading: false
      })
    )
  );
}

describe('project operational overview layout', () => {
  it('renders current state and primary action before project metrics and roadmap history', () => {
    const markup = renderProjectsPanel();

    expect(markup.indexOf('project-operational-overview')).toBeGreaterThan(-1);
    expect(markup.indexOf('Připraven další krok')).toBeLessThan(markup.indexOf('Open PR'));
    expect(markup.indexOf('Spustit další krok')).toBeLessThan(markup.indexOf('Roadmap projektu'));
  });

  it('separates roadmap history contract evidence and audit views', () => {
    const markup = renderProjectsPanel();

    expect(markup).toContain('Projektové roadmap views');
    expect(markup).toContain('Roadmap');
    expect(markup).toContain('Historie cyklů');
    expect(markup).toContain('Kontrakt');
    expect(markup).toContain('Evidence');
    expect(markup).toContain('Audity');
    expect(markup).toContain('Aktivní roadmap view');
    expect(markup).not.toContain('roadmap-cycle-list');
  });

  it('renders status filters and distinct roadmap step and audit action groups', () => {
    const completedRoadmap = {
      ...roadmap,
      steps: roadmap.steps.map((step) => ({ ...step, status: 'completed' as const }))
    };
    const markup = renderProjectsPanel(completedRoadmap);

    expect(markup).toContain('Filtr stavu položek');
    expect(markup).toContain('Aktivní');
    expect(markup).toContain('Čekající');
    expect(markup).toContain('Selhané');
    expect(markup).toContain('Dokončené');
    expect(markup).toContain('Generování roadmapy');
    expect(markup).toContain('Spuštění dalšího kroku');
    expect(markup).toContain('Auditní akce');
    expect(markup.indexOf('Generování roadmapy')).toBeLessThan(markup.indexOf('Spuštění dalšího kroku'));
    expect(markup.indexOf('Spuštění dalšího kroku')).toBeLessThan(markup.indexOf('Auditní akce'));
    expect(markup.indexOf('Pregenerovat kroky')).toBeGreaterThan(markup.indexOf('Generování roadmapy'));
    expect(markup.indexOf('Spustit dalsi krok')).toBeGreaterThan(markup.indexOf('Spuštění dalšího kroku'));
    expect(markup.lastIndexOf('Spustit závěrečný audit')).toBeGreaterThan(markup.indexOf('Auditní akce'));
    expect(markup.indexOf('Spustit závěrečný audit')).toBeGreaterThan(-1);
  });

  it('explains that contract save and roadmap generation are separate while preserving evidence', () => {
    const markup = renderProjectsPanel();

    expect(markup).toContain('Ulozeni zadani roadmapu nespousti.');
    expect(markup).toContain('Nova roadmapa vznikne az po potvrzeni tady');
    expect(markup).toContain('dokoncene kroky a jejich evidence');
  });

  it('keeps active roadmap steps scoped to the latest cycle', () => {
    const sourceRoadmap: ProjectRoadmapApi = {
      ...roadmap,
      cycles: [
        {
          ...roadmap.cycles[0]!,
          id: 'cycle_1',
          cycleNumber: 1,
          status: 'completed'
        },
        {
          ...roadmap.cycles[0]!,
          id: 'cycle_2',
          cycleNumber: 2,
          objective: 'Current cycle',
          status: 'active'
        }
      ],
      steps: [
        {
          ...roadmap.steps[1]!,
          id: 'old_pending_step',
          cycleId: 'cycle_1',
          title: 'Historical pending step'
        },
        {
          ...roadmap.steps[0]!,
          id: 'current_completed_step',
          cycleId: 'cycle_2',
          title: 'Current completed step'
        }
      ]
    };

    const markup = renderProjectsPanel(sourceRoadmap);

    expect(markup).toContain('Žádné kroky neodpovídají filtru.');
    expect(markup).not.toContain('Historical pending step');
    expect(markup).not.toContain('Current completed step');
  });
});

describe('project roadmap status filters', () => {
  it('maps implementation steps to active waiting failed and completed filters', () => {
    const step = roadmap.steps[0]!;
    const withStatus = (status: ProjectImplementationStepApi['status']): ProjectImplementationStepApi => ({ ...step, status });

    expect(projectStepMatchesStatusFilter(withStatus('pending'), 'active')).toBe(true);
    expect(projectStepMatchesStatusFilter(withStatus('running'), 'active')).toBe(true);
    expect(projectStepMatchesStatusFilter(withStatus('waiting_for_capability'), 'waiting')).toBe(true);
    expect(projectStepMatchesStatusFilter(withStatus('cancelled'), 'failed')).toBe(true);
    expect(projectStepMatchesStatusFilter(withStatus('completed'), 'completed')).toBe(true);
  });

  it('maps cycles evidence and audits to the shared project filters', () => {
    const cycle = roadmap.cycles[0]!;
    const withCycleStatus = (status: ProjectRoadmapCycleApi['status']): ProjectRoadmapCycleApi => ({ ...cycle, status });
    const audit: ProjectAuditJobApi = {
      id: 'audit_1',
      projectId: project.id,
      cycleId: cycle.id,
      requirementIds: [],
      status: 'pending',
      attemptCount: 1,
      createdAt: '',
      updatedAt: ''
    };
    const evidence: AcceptanceEvidenceApi = {
      id: 'evidence_1',
      projectId: project.id,
      cycleId: cycle.id,
      requirementId: 'REQ-1',
      criterionKey: 'criterion',
      criterion: 'criterion',
      source: 'validation_command',
      status: 'passed',
      evidenceKey: 'npm-test',
      contractVersion: 1,
      payload: {},
      createdAt: '',
      updatedAt: ''
    };

    expect(projectCycleMatchesStatusFilter(withCycleStatus('active'), 'active')).toBe(true);
    expect(projectCycleMatchesStatusFilter(withCycleStatus('awaiting_extension_approval'), 'waiting')).toBe(true);
    expect(projectCycleMatchesStatusFilter(withCycleStatus('blocked'), 'failed')).toBe(true);
    expect(projectCycleMatchesStatusFilter(withCycleStatus('completed'), 'completed')).toBe(true);
    expect(projectAuditMatchesStatusFilter({ ...audit, status: 'claimed' }, 'active')).toBe(true);
    expect(projectAuditMatchesStatusFilter(audit, 'waiting')).toBe(true);
    expect(projectAuditMatchesStatusFilter({ ...audit, status: 'blocked' }, 'failed')).toBe(true);
    expect(projectAuditMatchesStatusFilter({ ...audit, status: 'succeeded' }, 'completed')).toBe(true);
    expect(projectEvidenceMatchesStatusFilter({ ...evidence, status: 'deferred' }, 'waiting')).toBe(true);
    expect(projectEvidenceMatchesStatusFilter({ ...evidence, status: 'failed' }, 'failed')).toBe(true);
    expect(projectEvidenceMatchesStatusFilter(evidence, 'completed')).toBe(true);
  });

  it('allows final audit only for an active completed latest cycle without a blocking audit job', () => {
    const cycle = roadmap.cycles[0]!;
    const completedSteps = roadmap.steps.map((step) => ({ ...step, status: 'completed' as const }));
    const pendingAudit: ProjectAuditJobApi = {
      id: 'audit_1',
      projectId: project.id,
      cycleId: cycle.id,
      requirementIds: [],
      status: 'pending',
      attemptCount: 1,
      createdAt: '',
      updatedAt: ''
    };

    expect(canStartProjectAudit(cycle, completedSteps, undefined)).toBe(true);
    expect(canStartProjectAudit({ ...cycle, status: 'completed' }, completedSteps, undefined)).toBe(false);
    expect(canStartProjectAudit(cycle, completedSteps, pendingAudit)).toBe(false);
    expect(canStartProjectAudit(cycle, completedSteps, { ...pendingAudit, status: 'succeeded' })).toBe(true);
    expect(canStartProjectAudit(cycle, roadmap.steps, undefined)).toBe(false);
  });
});
