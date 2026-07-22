import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { runWorkerTask } from './workflow.js';
import type { ForgeTask, Project } from '@forgemind/core';
import type { AIProvider, CostEstimateResult, ImplementInput, ImplementResult, PlanInput, PlanResult, ReviewInput, ReviewResult } from '@forgemind/providers';
import type { GitHubAdapter } from '@forgemind/github';

function createProject(): Project {
  return {
    id: `project_${randomUUID()}`,
    name: 'MVP Scenario Project',
    slug: 'mvp-scenario-project',
    githubOwner: 'demo',
    githubRepo: 'mvp-scenario-project',
    defaultBranch: 'main',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createTask(projectId: string, title: string): ForgeTask {
  return {
    id: `task_${randomUUID()}`,
    projectId,
    createdByUserId: 'user_local_owner',
    title,
    prompt: 'Implement the requested feature, run validation and prepare draft PR.',
    mode: 'safe',
    status: 'submitted',
    maxIterations: 3,
    maxBudgetUsd: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createPassingProvider(): AIProvider {
  return {
    kind: 'codex',
    async plan(_input: PlanInput): Promise<PlanResult> {
      return {
        summary: 'Plan summary',
        steps: ['Implement feature', 'Run validation', 'Prepare PR'],
        acceptanceCriteria: ['Build succeeds', 'No validation errors']
      };
    },
    async implement(_input: ImplementInput): Promise<ImplementResult> {
      return {
        summary: 'Implementation summary',
        changedFiles: ['README.md'],
        diffStat: { filesChanged: 1, insertions: 2, deletions: 0 },
        requestedApprovals: [],
        fileUpdates: [{ path: 'README.md', content: '# MVP scenario\n' }]
      };
    },
    async review(_input: ReviewInput): Promise<ReviewResult> {
      return {
        summary: 'Review passed',
        blockers: [],
        safeImprovements: [],
        riskyChanges: []
      };
    },
    async estimateCost(): Promise<CostEstimateResult> {
      return {
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.01
      };
    },
    supportsLocalRepo() {
      return true;
    },
    supportsGitHubNativeFlow() {
      return false;
    }
  };
}

function createApprovalProvider(approvalRequired: boolean): AIProvider {
  return {
    kind: 'codex',
    async plan(_input: PlanInput): Promise<PlanResult> {
      return {
        summary: 'Plan summary',
        steps: ['Implement feature safely'],
        acceptanceCriteria: ['Approval flow works']
      };
    },
    async implement(_input: ImplementInput): Promise<ImplementResult> {
      return {
        summary: approvalRequired ? 'Implementation needs approval' : 'Implementation approved',
        changedFiles: ['src/feature.ts'],
        diffStat: { filesChanged: 1, insertions: 5, deletions: 0 },
        requestedApprovals: approvalRequired ? ['new_dependency'] : [],
        fileUpdates: [{ path: 'src/feature.ts', content: 'export const feature = true;\n' }]
      };
    },
    async review(_input: ReviewInput): Promise<ReviewResult> {
      return {
        summary: 'Review passed',
        blockers: [],
        safeImprovements: [],
        riskyChanges: []
      };
    },
    async estimateCost(): Promise<CostEstimateResult> {
      return {
        inputTokens: 8,
        outputTokens: 4,
        estimatedCostUsd: 0.005
      };
    },
    supportsLocalRepo() {
      return true;
    },
    supportsGitHubNativeFlow() {
      return false;
    }
  };
}

function createDeterministicGitHub(project: Project): GitHubAdapter {
  return {
    async createIssue() {
      return {
        issueNumber: 321,
        issueUrl: `https://github.com/${project.githubOwner}/${project.githubRepo}/issues/321`
      };
    },
    getRemoteUrl() {
      return undefined;
    },
    async createBranch() {
      return undefined;
    },
    async commitAndPush() {
      return undefined;
    },
    async createDraftPullRequest() {
      return {
        pullRequestNumber: 654,
        pullRequestUrl: `https://github.com/${project.githubOwner}/${project.githubRepo}/pull/654`
      };
    },
    async commentOnIssue() {
      return undefined;
    },
    async readCheckStatus() {
      return 'success';
    }
  };
}

describe('MVP scenario', () => {
  it('covers README happy path from task to draft PR', async () => {
    const project = createProject();
    const task = createTask(project.id, 'README happy path task');
    const workspaceRoot = join(tmpdir(), `forgemind-mvp-happy-${randomUUID()}`);

    const result = await runWorkerTask({
      project,
      task,
      provider: createPassingProvider(),
      github: createDeterministicGitHub(project),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.issueUrl).toContain('/issues/321');
    expect(result.branchName).toMatch(/^ai\//);
    expect(result.pullRequestUrl).toContain('/pull/654');
    expect(result.validation.passed).toBe(true);
    expect(result.completedAt).toBeTruthy();
  }, 10000);

  it('covers approval pause and resume with final draft PR creation', async () => {
    const project = createProject();
    const workspaceRoot = join(tmpdir(), `forgemind-mvp-approval-${randomUUID()}`);

    const pausedResult = await runWorkerTask({
      project,
      task: createTask(project.id, 'Approval required task'),
      provider: createApprovalProvider(true),
      github: createDeterministicGitHub(project),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(pausedResult.status).toBe('needs_approval');
    expect(pausedResult.approvals).toContain('new_dependency');

    const resumedResult = await runWorkerTask({
      project,
      task: createTask(project.id, 'Approval resumed task'),
      provider: createApprovalProvider(false),
      github: createDeterministicGitHub(project),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(resumedResult.status).toBe('ready_for_user_review');
    expect(resumedResult.pullRequestUrl).toContain('/pull/654');
  }, 15000);
});
