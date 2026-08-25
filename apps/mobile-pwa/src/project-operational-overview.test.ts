import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectsPanel } from './App.js';
import type { ProjectRoadmapApi, ProjectSummary } from './types.js';

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
    expect(markup.indexOf('Spustit další krok')).toBeLessThan(markup.indexOf('roadmap-cycle-list'));
  });

  it('keeps rendered roadmap cycles collapsed by default', () => {
    const markup = renderProjectsPanel();

    expect(markup).toContain('<details class="roadmap-cycle">');
    expect(markup).not.toContain('<details class="roadmap-cycle" open="">');
  });

  it('keeps the mobile-reachable primary action before completed history content', () => {
    const completedRoadmap = {
      ...roadmap,
      steps: roadmap.steps.map((step) => ({ ...step, status: 'completed' as const }))
    };
    const markup = renderProjectsPanel(completedRoadmap);

    expect(markup.indexOf('Spustit závěrečný audit')).toBeGreaterThan(-1);
    expect(markup.indexOf('Spustit závěrečný audit')).toBeLessThan(markup.indexOf('Foundation'));
  });
});
