import type { ApprovalSummary, ProjectSummary, TaskSummary } from './types.js';

export const projects: ProjectSummary[] = [
  {
    id: 'project_demo_gallery',
    name: 'Demo Static Gallery',
    slug: 'demo-static-gallery',
    openPullRequests: 1,
    budgetUsd: 0.38
  },
  {
    id: 'project_forgemind',
    name: 'ForgeMind',
    slug: 'forgemind',
    openPullRequests: 0,
    budgetUsd: 0.12
  }
];

export const initialTasks: TaskSummary[] = [
  {
    id: 'task_gallery',
    projectId: 'project_demo_gallery',
    title: 'Galerie podle dne',
    prompt: 'Seskupit statickou galerii podle dne, přidat fullscreen náhled a šipky.',
    status: 'ready_for_user_review',
    currentStep: 'Draft PR připravený k revizi',
    mode: 'safe',
    iterations: 3,
    maxIterations: 10,
    budgetUsd: 0.38,
    maxBudgetUsd: 2,
    updatedAt: '2026-07-02T20:28:00.000Z',
    branchName: 'ai/123-gallery-by-date',
    issueUrl: 'https://github.com/demo/demo-static-gallery/issues/123',
    pullRequestUrl: 'https://github.com/demo/demo-static-gallery/pull/124',
    plan: ['Vytvořit branch', 'Upravit data galerie', 'Doplnit fullscreen ovládání', 'Spustit build'],
    testResult: 'npm run build: exit 0',
    diffSummary: '+218 -34 napříč 4 soubory'
  },
  {
    id: 'task_dependency',
    projectId: 'project_forgemind',
    title: 'Provider adapter',
    prompt: 'Doplnit adapter pro nového providera a odhad nákladů.',
    status: 'needs_approval',
    currentStep: 'Čeká na schválení nové dependency',
    mode: 'safe',
    iterations: 1,
    maxIterations: 10,
    budgetUsd: 0.12,
    maxBudgetUsd: 2,
    updatedAt: '2026-07-02T20:35:00.000Z',
    branchName: 'ai/124-provider-adapter',
    plan: ['Rozšířit provider API', 'Doplnit adapter', 'Doplnit testy'],
    testResult: 'Pozastaveno před validací',
    diffSummary: 'Návrh změny package.json'
  }
];

export const initialApprovals: ApprovalSummary[] = [
  {
    id: 'approval_dependency',
    taskId: 'task_dependency',
    title: 'Nová dependency',
    reason: 'Provider navrhuje přidat balíček pro práci s GitHub App tokeny.',
    risk: 'Nová produkční dependency může ovlivnit build, audit závislostí a deployment.',
    status: 'pending',
    riskLevel: 'medium',
    touchedFiles: ['package.json', 'package-lock.json', 'packages/github/src/index.ts'],
    recommendation: 'Schválit pouze pokud adapter nejde rozumně postavit nad stávajícími knihovnami.'
  }
];

