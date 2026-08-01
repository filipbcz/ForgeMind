import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import {
  compactTaskExecutionPrompt,
  isInspectionOnlyValidationCommand,
  isReviewSummaryOnlyPath,
  isValidationCommandDefinitionFailure,
  normalizeValidationChecks,
  runWorkerTask
} from './workflow.js';
import type { ForgeTask, Project, TaskActivity } from '@forgemind/core';
import type { AIProvider, CostEstimateResult, ImplementInput, ImplementResult, PlanInput, PlanResult, ReviewInput, ReviewResult } from '@forgemind/providers';
import type { CreateDraftPullRequestInput, GitHubAdapter } from '@forgemind/github';

const noGitProjectConfig = `project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
  default_branch: main
workflow:
  default_mode: safe
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
  auto_merge: false
  allow_ai_auto_improvements: true
ai:
  primary_provider: codex
  reviewer_provider: codex
  model_profile: balanced
limits:
  max_iterations: 10
  max_runtime_minutes: 60
  max_changed_files: 20
  max_diff_lines: 2000
  max_repeated_error_count: 3
  max_budget_usd: 2
  soft_budget_threshold_percent: 75
  hard_budget_threshold_percent: 100
commands:
  verify: "node --version"
approval:
  required_for: []
  auto_allowed: []
sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths:
    - /workspace
  forbidden_paths:
    - /etc
    - /root
    - /home/*/.ssh
    - /var/run/docker.sock
github:
  issue_label: "ai-task"
  branch_prefix: "ai/"
  pr_draft: true
  require_ci_green: true
`;

const gitProjectConfig = noGitProjectConfig
  .replace('create_issue: false', 'create_issue: true')
  .replace('create_branch: false', 'create_branch: true')
  .replace('create_draft_pr: false', 'create_draft_pr: true');

const demoProject: Project = {
  id: `project_${randomUUID()}`,
  name: 'Demo Static Gallery',
  slug: 'demo-static-gallery',
  githubOwner: 'demo',
  githubRepo: 'demo-static-gallery',
  defaultBranch: 'main',
  configYaml: noGitProjectConfig,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const gitEnabledProject: Project = {
  ...demoProject,
  configYaml: gitProjectConfig
};

const demoTask: ForgeTask = {
  id: `task_${randomUUID()}`,
  projectId: demoProject.id,
  createdByUserId: 'user_local_owner',
  title: 'ForgeMind workflow',
  prompt: 'Simulate a safe implementation and validate the worker lifecycle.',
  mode: 'safe',
  status: 'submitted',
  maxIterations: 10,
  maxBudgetUsd: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function createProviderStub(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    kind: 'codex',
    async plan(): Promise<PlanResult> {
      return {
        summary: 'Plan summary',
        steps: ['Implement task'],
        acceptanceCriteria: ['Validation passes']
      };
    },
    async implement(): Promise<ImplementResult> {
      return {
        summary: 'Implementation summary',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        requestedApprovals: [],
        fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
      };
    },
    async review(): Promise<ReviewResult> {
      return {
        summary: 'Review passed',
        blockers: [],
        safeImprovements: [],
        riskyChanges: []
      };
    },
    async estimateCost(): Promise<CostEstimateResult> {
      return {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0
      };
    },
    supportsLocalRepo() {
      return true;
    },
    supportsGitHubNativeFlow() {
      return false;
    },
    ...overrides
  } as AIProvider;
}

function createGitHubStub(overrides: Partial<GitHubAdapter> = {}): GitHubAdapter {
  return {
    async createIssue(input) {
      return {
        issueNumber: 1234,
        issueUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/issues/1234`
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
    async createDraftPullRequest(input) {
      return {
        pullRequestNumber: 4321,
        pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/4321`
      };
    },
    async commentOnIssue() {
      return undefined;
    },
    async readCheckStatus() {
      return 'success';
    },
    ...overrides
  };
}

describe('worker workflow', () => {
  it('runs the local provider workflow end-to-end without GitHub operations', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-test-${randomUUID()}`);
    let capturedReviewInput: ReviewInput | undefined;
    const provider = createProviderStub({
      async review(input): Promise<ReviewResult> {
        capturedReviewInput = input;
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      }
    });

    const result = await runWorkerTask({
      project: demoProject,
      task: demoTask,
      provider,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.issueUrl).toBe('');
    expect(result.pullRequestUrl).toBeUndefined();
    expect(result.validation.passed).toBe(true);
    expect(result.summary).toContain('Review passed');
    expect(result.workspacePath).toContain(workspaceRoot);
    expect(capturedReviewInput).toEqual(
      expect.objectContaining({
        taskId: demoTask.id,
        taskTitle: demoTask.title,
        acceptanceCriteria: ['Validation passes'],
        validation: expect.objectContaining({
          command: 'node --version',
          exitCode: 0,
          passed: true
        }),
        diff: expect.stringContaining('diff --git a/status.txt b/status.txt')
      })
    );
    expect(capturedReviewInput?.diff).toContain('+ok');

    const workspaceGit = simpleGit({ baseDir: result.workspacePath });
    await expect(workspaceGit.raw(['config', '--local', '--get', 'user.name'])).resolves.toBe(
      'ForgeMind Worker\n'
    );
    await expect(workspaceGit.raw(['config', '--local', '--get', 'user.email'])).resolves.toBe(
      'forgemind-worker@users.noreply.github.com\n'
    );
  }, 15000);

  it('initializes ignored local workspaces as standalone git repositories', async () => {
    const workspaceRoot = join(process.cwd(), '.forgemind', `worker-ignored-workspace-${randomUUID()}`);

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`
      },
      provider: createProviderStub(),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.workspacePath).toContain(workspaceRoot);
  }, 10000);

  it('removes stale generated AGENTS.md before checking out an existing workspace branch', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-stale-agents-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });

    const git = simpleGit({ baseDir: workspacePath });
    await git.init();
    await git.addConfig('user.email', 'worker@example.test');
    await git.addConfig('user.name', 'ForgeMind Worker Test');
    await writeFile(join(workspacePath, 'AGENTS.md'), '# Repository instructions\n', 'utf8');
    await git.add('AGENTS.md');
    await git.commit('Add repository instructions');
    await git.checkoutLocalBranch('scratch');
    await git.rm('AGENTS.md');
    await git.commit('Remove instructions on scratch');
    await writeFile(join(workspacePath, 'AGENTS.md'), '# AGENTS.md\n\n## Project\n\n## Task\nstale worker file\n', 'utf8');

    const result = await runWorkerTask({
      project: {
        ...demoProject,
        configYaml: noGitProjectConfig
      },
      task,
      provider: createProviderStub(),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.branchName).toBe('main');
    await expect(readFile(join(workspacePath, 'AGENTS.md'), 'utf8')).resolves.toContain(`- title: ${task.title}`);
  }, 15000);

  it('supports disabled create_issue in project config', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-no-issue-${randomUUID()}`);
    const projectWithConfig = {
      ...demoProject,
      configYaml: gitProjectConfig.replace('create_issue: true', 'create_issue: false')
    };

    const result = await runWorkerTask({
      project: projectWithConfig,
      task: demoTask,
      provider: createProviderStub(),
      github: createGitHubStub(),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.issueUrl).toBe('');
    expect(result.branchName).toMatch(/^ai\/no-issue-/);
    expect(result.pullRequestUrl).toContain(`https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/pull/`);
    expect(result.validation.passed).toBe(true);
  }, 10000);

  it('completes a task only after GitHub confirms the configured automatic merge', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-auto-merge-${randomUUID()}`);
    const createPullRequest = vi.fn(createGitHubStub().createDraftPullRequest);
    const mergePullRequest = vi.fn(async () => ({
      merged: true,
      sha: 'merge-sha',
      message: 'Pull Request successfully merged'
    }));

    const result = await runWorkerTask({
      project: {
        ...gitEnabledProject,
        autoCreatePullRequest: true,
        autoMergePullRequest: true,
        autoCompleteTask: true
      },
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider: createProviderStub(),
      github: createGitHubStub({ createDraftPullRequest: createPullRequest, mergePullRequest }),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('completed');
    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: false }));
    expect(mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: 'main' }), 4321);
  }, 10000);

  it('keeps a task ready for review when GitHub does not confirm the automatic merge', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-auto-merge-rejected-${randomUUID()}`);
    const result = await runWorkerTask({
      project: {
        ...gitEnabledProject,
        autoCreatePullRequest: true,
        autoMergePullRequest: true,
        autoCompleteTask: true
      },
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider: createProviderStub(),
      github: createGitHubStub({
        async mergePullRequest() {
          return { merged: false, message: 'Base branch protection blocked the merge.' };
        }
      }),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.summary).toContain('Base branch protection blocked the merge.');
  }, 10000);

  it('reuses existing GitHub issue, branch, and draft pull request on retry', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-reuse-github-${randomUUID()}`);
    const createIssue = vi.fn(async () => ({
      issueNumber: 999,
      issueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/999`
    }));
    const createBranch = vi.fn(async () => undefined);
    const createDraftPullRequest = vi.fn(async () => ({
      pullRequestNumber: 999,
      pullRequestUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/pull/999`
    }));
    const commentOnIssue = vi.fn(async () => undefined);

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Use existing branch'],
          acceptanceCriteria: ['Retry should reuse existing GitHub artifacts']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const github: GitHubAdapter = {
      createIssue,
      getRemoteUrl() {
        return undefined;
      },
      createBranch,
      async commitAndPush() {
        return undefined;
      },
      createDraftPullRequest,
      commentOnIssue,
      async readCheckStatus() {
        return 'success';
      }
    };

    const result = await runWorkerTask({
      project: gitEnabledProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        githubIssueNumber: 1234,
        githubIssueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`,
        branchName: 'ai/1234-forgemind-workflow',
        pullRequestNumber: 4321,
        pullRequestUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/pull/4321`
      },
      provider,
      github,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.issueUrl).toBe(`https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`);
    expect(result.branchName).toBe('ai/1234-forgemind-workflow');
    expect(result.pullRequestUrl).toBe(`https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/pull/4321`);
    expect(createIssue).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
    expect(createDraftPullRequest).not.toHaveBeenCalled();
    expect(commentOnIssue).toHaveBeenCalledOnce();
  }, 10000);

  it('resumes approved large diffs from existing workspace changes without rerunning implementation', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-approved-diff-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`,
      branchName: 'ai/1234-forgemind-workflow'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'pass\n', 'utf8');

    const implement = vi.fn(async (): Promise<ImplementResult> => {
      return {
        summary: 'Unexpected fresh implementation',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        requestedApprovals: [],
        fileUpdates: [{ path: 'status.txt', content: 'pass\n' }]
      };
    });

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Validate existing workspace'],
          acceptanceCriteria: ['Existing workspace should continue after approval']
        };
      },
      implement,
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const createDraftPullRequest = vi.fn(async (input: CreateDraftPullRequestInput) => ({
      pullRequestNumber: 4321,
      pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/4321`
    }));

    const github: GitHubAdapter = {
      async createIssue() {
        return {
          issueNumber: 999,
          issueUrl: 'https://github.com/demo/demo-static-gallery/issues/999'
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
      createDraftPullRequest,
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    const result = await runWorkerTask({
      project: gitEnabledProject,
      task,
      provider,
      github,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot,
      resume: {
        kind: 'approved_large_diff',
        implementationSummary: 'Large scaffold created.'
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.branchName).toBe(task.branchName);
    expect(implement).not.toHaveBeenCalled();
    expect(createDraftPullRequest).toHaveBeenCalledOnce();
  }, 10000);

  it('does not re-request an approved github workflow change when resuming the preserved diff', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-approved-workflow-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`,
      branchName: 'ai/1234-forgemind-workflow'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(join(workspacePath, '.github', 'workflows'), { recursive: true });
    await writeFile(join(workspacePath, '.github', 'workflows', 'build.yml'), 'name: build\n', 'utf8');
    await writeFile(join(workspacePath, 'status.txt'), 'pass\n', 'utf8');

    const implement = vi.fn(async (): Promise<ImplementResult> => ({
      summary: 'Unexpected fresh implementation',
      changedFiles: ['status.txt'],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      requestedApprovals: [],
      fileUpdates: [{ path: 'status.txt', content: 'pass\n' }]
    }));

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Validate existing workspace'],
          acceptanceCriteria: ['Existing workspace should continue after approval']
        };
      },
      implement,
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const github: GitHubAdapter = {
      async createIssue() {
        return {
          issueNumber: 999,
          issueUrl: 'https://github.com/demo/demo-static-gallery/issues/999'
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
      async createDraftPullRequest(input: CreateDraftPullRequestInput) {
        return {
          pullRequestNumber: 4321,
          pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/4321`
        };
      },
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    const result = await runWorkerTask({
      project: gitEnabledProject,
      task,
      provider,
      github,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot,
      resume: {
        kind: 'approved_operation',
        implementationSummary: 'GitHub workflow changes preserved.',
        approvedApprovals: ['github_workflow_change']
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.approvals).not.toContain('github_workflow_change');
    expect(implement).not.toHaveBeenCalled();
  }, 10000);

  it('resumes approved review risk changes without rerunning planning, implementation, or review', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-approved-review-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`,
      branchName: 'ai/1234-forgemind-workflow'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'pass\n', 'utf8');

    const plan = vi.fn(async (): Promise<PlanResult> => ({
      summary: 'Unexpected new planning',
      steps: [],
      acceptanceCriteria: []
    }));
    const implement = vi.fn(async (): Promise<ImplementResult> => ({
      summary: 'Unexpected new implementation',
      changedFiles: ['status.txt'],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      requestedApprovals: [],
      fileUpdates: [{ path: 'status.txt', content: 'pass\n' }]
    }));
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Unexpected new review',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));
    const statuses: string[] = [];
    const iterations: string[] = [];

    const provider: AIProvider = {
      kind: 'codex',
      plan,
      implement,
      review,
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const createDraftPullRequest = vi.fn(async (input: CreateDraftPullRequestInput) => ({
      pullRequestNumber: 4321,
      pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/4321`
    }));

    const github: GitHubAdapter = {
      async createIssue() {
        return {
          issueNumber: 999,
          issueUrl: 'https://github.com/demo/demo-static-gallery/issues/999'
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
      createDraftPullRequest,
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    const result = await runWorkerTask({
      project: gitEnabledProject,
      task,
      provider,
      github,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot,
      resume: {
        kind: 'approved_review',
        planSummary: 'Original plan summary',
        implementationSummary: 'Large scaffold created.',
        reviewSummary: 'Reviewed changes, no blockers.',
        riskyChanges: ['new_dependency', 'config_change']
      },
      hooks: {
        onStatus: async (status) => {
          statuses.push(status);
        },
        onIteration: async (iteration) => {
          iterations.push(iteration.phase);
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.summary).toBe('Reviewed changes, no blockers.');
    expect(result.validation.passed).toBe(true);
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(iterations).toEqual(['validation']);
    expect(statuses).toContain('reviewing');
    expect(createDraftPullRequest).toHaveBeenCalledOnce();
  }, 10000);

  it('uses AI planned validation commands when no explicit verifyCommand is configured', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-planned-validation-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Scaffold app', 'Build app'],
          acceptanceCriteria: ['Build passes'],
          validationChecks: [
            {
              kind: 'command',
              command: `node -e "process.exit(0)"`,
              criterion: 'Build passes',
              rationale: 'Simulated build check for the test harness.'
            }
          ]
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`
      },
      provider,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.validation.command).toContain('node -e');
  }, 10000);

  it('replans validation checks after a validation failure when no explicit verify command is configured', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-replan-validation-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const planCalls: PlanInput[] = [];
    const implementCalls: ImplementInput[] = [];
    const planningIterations: Array<{ phase: string; validationResult: unknown }> = [];
    const taskActivities: TaskActivity[] = [];

    const provider: AIProvider = {
      kind: 'codex',
      async plan(input: PlanInput): Promise<PlanResult> {
        planCalls.push(input);
        if (planCalls.length === 1) {
          return {
            summary: 'Initial plan with broken Windows command.',
            steps: ['Create sanity file', 'Validate output'],
            acceptanceCriteria: ['Build passes'],
            validationChecks: [
              {
                kind: 'command',
                command: `node -e "process.stderr.write('Missing script: missing-validation-script'); process.exit(1)"`,
                criterion: 'Initial failing validation.',
                rationale: 'Synthetic failure for retry.'
              }
            ]
          };
        }

        return {
          summary: 'Updated plan with corrected validation command.',
          steps: ['Reuse created file', 'Run corrected validation'],
          acceptanceCriteria: ['Build passes'],
          validationChecks: [
            {
              kind: 'command',
              command: "node -e \"process.exit(0)\"",
              criterion: 'Corrected validation.',
              rationale: 'Adjusted after validation failure.'
            }
          ]
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        implementCalls.push(input);
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        prompt: 'Parent objective:\nA very long project brief that is not needed for execution.\n\nCurrent implementation step:\nFix validation handling.\n\nAcceptance Criteria:\n- Validation passes.',
        maxIterations: 3
      },
      provider,
      workspaceRoot,
      hooks: {
        onActivity: async (activity) => {
          taskActivities.push(activity);
        },
        onIteration: async (iteration) => {
          if (iteration.phase === 'planning') {
            planningIterations.push({ phase: iteration.phase, validationResult: iteration.validationResult });
          }
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(planCalls).toHaveLength(2);
    expect(implementCalls).toHaveLength(1);
    expect(planCalls[0]?.prompt).not.toContain('very long project brief');
    expect(planCalls[1]?.prompt).toContain('Revise validation checks only');
    expect(planCalls[1]?.prompt).not.toContain('very long project brief');
    expect(planCalls[1]?.previousValidationError).toContain('Missing script');
    expect(planCalls[1]?.previousValidationChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'command',
          command: expect.stringContaining('Missing script: missing-validation-script')
        })
      ])
    );
    expect(planningIterations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'planning',
          validationResult: expect.objectContaining({
            revisedValidationChecksOnly: true,
            validationChecks: expect.arrayContaining([
              expect.objectContaining({
                command: expect.stringContaining('process.exit(0)')
              })
            ])
          })
        })
      ])
    );
    expect(taskActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'planning',
          state: 'started',
          operation: 'provider_plan',
          attempt: 1
        }),
        expect.objectContaining({
          phase: 'planning',
          state: 'completed',
          operation: 'provider_plan',
          attempt: 1,
          elapsedMs: expect.any(Number)
        })
      ])
    );
  }, 20000);

  it('keeps only the current roadmap step in provider execution context', () => {
    expect(compactTaskExecutionPrompt([
      'Project: Demo',
      'Parent objective:',
      'Large reusable brief.',
      '',
      'Current implementation step:',
      'Add leaderboard API.',
      '',
      'Acceptance Criteria:',
      '- GET /api/leaderboard works.'
    ].join('\n'))).toBe([
      'Current implementation step:',
      'Add leaderboard API.',
      '',
      'Acceptance Criteria:',
      '- GET /api/leaderboard works.'
    ].join('\n'));
  });

  it('distinguishes invalid validation commands from implementation failures', () => {
    expect(isValidationCommandDefinitionFailure({
      command: 'npm run missing',
      exitCode: 1,
      stdout: '',
      stderr: 'Missing script: "missing"',
      passed: false
    })).toBe(true);
    expect(isValidationCommandDefinitionFailure({
      command: 'npm test',
      exitCode: 1,
      stdout: 'Expected 2 but received 1',
      stderr: '',
      passed: false
    })).toBe(false);
  });

  it('moves repository inspection out of executable validation', () => {
    const command = 'git diff -- README.md docs AGENTS.md 2>/dev/null || git diff -- README.md';

    expect(isInspectionOnlyValidationCommand(command)).toBe(true);
    expect(isInspectionOnlyValidationCommand('git diff --exit-code -- README.md')).toBe(false);
    expect(normalizeValidationChecks([{
      kind: 'command',
      command,
      criterion: 'Documentation matches the implementation.'
    }])).toEqual([expect.objectContaining({
      kind: 'manual',
      criterion: 'Documentation matches the implementation.'
    })]);
  });

  it('omits generated dependency metadata from detailed review context', () => {
    expect(isReviewSummaryOnlyPath('package-lock.json')).toBe(true);
    expect(isReviewSummaryOnlyPath('src/domain/leaderboard.ts')).toBe(false);
  });

  it('retries implementation after a validation failure within max iterations', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-retry-${randomUUID()}`);
    const attempts: ImplementInput[] = [];

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Write validation marker'],
          acceptanceCriteria: ['Validation should pass']
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        attempts.push(input);
        const isPassingAttempt = (input.attemptNumber ?? 1) >= 2;

        return {
          summary: `Attempt ${input.attemptNumber}`,
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
          requestedApprovals: [],
          fileUpdates: [
            {
              path: 'status.txt',
              content: isPassingAttempt ? 'pass\n' : 'fail\n'
            }
          ]
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        return {
          summary: 'Review summary',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        maxIterations: 2
      },
      provider,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.attemptNumber).toBe(1);
    expect(attempts[0]?.previousValidationError).toBeUndefined();
    expect(attempts[1]?.attemptNumber).toBe(2);
    expect(attempts[1]?.previousValidationError).toContain('Exit code 1');
  }, 10000);

  it('does not synthesize placeholder implementation output for local providers without task changes', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-empty-local-provider-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      maxIterations: 1
    };
    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Create app files'],
          acceptanceCriteria: ['Build passes']
        };
      },
      async implement(_input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: 'No files were written.',
          changedFiles: [],
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          requestedApprovals: []
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        throw new Error('Review should not run without task changes.');
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('validation_failed');
    expect(result.summary).toContain('Provider did not create or modify any task files.');
    await expect(readFile(join(workspaceRoot, task.id, 'MOCK_IMPLEMENTATION.md'), 'utf8')).rejects.toThrow();
  });

  it('reports actual diff stats for newly created untracked files', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-untracked-diff-${randomUUID()}`);
    const implementationDiffStats: Array<{ filesChanged?: number; insertions?: number; deletions?: number }> = [];
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`
    };
    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Create React entrypoint'],
          acceptanceCriteria: ['File exists']
        };
      },
      async implement(_input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: 'Created app entrypoint.',
          changedFiles: ['src/App.tsx'],
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [
            {
              path: 'src/App.tsx',
              content: ['export function App() {', '  return <main>Hello</main>;', '}', ''].join('\n')
            }
          ]
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        return {
          summary: 'Review passed.',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider,
      verifyCommand: 'node --version',
      workspaceRoot,
      hooks: {
        onIteration: async (iteration) => {
          if (iteration.phase === 'implementation' && iteration.diffStat && typeof iteration.diffStat === 'object' && !Array.isArray(iteration.diffStat)) {
            implementationDiffStats.push(iteration.diffStat as { filesChanged?: number; insertions?: number; deletions?: number });
          }
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(implementationDiffStats[0]).toEqual(
      expect.objectContaining({
        filesChanged: 1,
        insertions: 3,
        deletions: 0
      })
    );
  }, 10000);

  it('normalizes free-form provider approval reasons to ApprovalType values', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-approval-normalize-${randomUUID()}`);

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Create app structure'],
          acceptanceCriteria: ['Approval should use a DB enum value']
        };
      },
      async implement(_input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: 'Workspace write access is required.',
          changedFiles: [],
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          requestedApprovals: [
            'Workspace write access is required to create the React application structure and run the build.'
          ] as unknown as ImplementResult['requestedApprovals']
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        return {
          summary: 'Review should not run',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`
      },
      provider,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('needs_approval');
    expect(result.approvals).toEqual(['risky_refactor']);
  });

  it('retries implementation after review blockers within max iterations', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-review-retry-${randomUUID()}`);
    const attempts: ImplementInput[] = [];
    const reviewInputs: ReviewInput[] = [];
    let reviewAttempt = 0;

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Write implementation marker'],
          acceptanceCriteria: ['Review should pass']
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        attempts.push(input);
        return {
          summary: `Attempt ${input.attemptNumber}`,
          changedFiles: input.attemptNumber === 1 ? ['status.txt', 'stable.txt'] : ['status.txt'],
          diffStat: { filesChanged: input.attemptNumber === 1 ? 2 : 1, insertions: input.attemptNumber === 1 ? 2 : 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [
            {
              path: 'status.txt',
              content: `attempt-${input.attemptNumber}\n`
            },
            ...(input.attemptNumber === 1 ? [{ path: 'stable.txt', content: 'already-reviewed\n' }] : [])
          ]
        };
      },
      async review(input: ReviewInput): Promise<ReviewResult> {
        reviewInputs.push(input);
        reviewAttempt += 1;
        if (reviewAttempt === 1) {
          return {
            summary: 'Review found blockers',
            blockers: ['Add missing guard clause'],
            safeImprovements: [],
            riskyChanges: []
          };
        }

        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        maxIterations: 2
      },
      provider,
      verifyCommand: `node -e "process.exit(0)"`,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.previousReviewBlockers).toBeUndefined();
    expect(attempts[1]?.previousReviewBlockers).toEqual(['Add missing guard clause']);
    expect(reviewInputs).toHaveLength(2);
    expect(reviewInputs[0]?.changedFiles).toEqual(expect.arrayContaining(['status.txt', 'stable.txt']));
    expect(reviewInputs[1]?.changedFiles).toEqual(['status.txt']);
    expect(reviewInputs[1]?.diff).toContain('status.txt');
    expect(reviewInputs[1]?.diff).not.toContain('stable.txt');
    expect(reviewInputs[1]?.previousReviewBlockers).toEqual(['Add missing guard clause']);
  }, 10000);

  it('ignores review blockers caused only by read-only validation limitations after successful validation', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-review-validation-limit-${randomUUID()}`);
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review completed with one non-actionable blocker.',
      blockers: [
        'Unable to verify the acceptance criterion that the build passes: node execution was blocked by the current read-only review environment policy, so I could not run npm/Vite build commands.',
        'The sandbox cannot create a namespace: bwrap has no permissions. With approval policy never, I cannot bypass this to read index.html or inspect the diff.'
      ],
      safeImprovements: [],
      riskyChanges: []
    }));

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Create file', 'Run build'],
          acceptanceCriteria: ['Build passes']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'pass\n' }]
        };
      },
      review,
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`
      },
      provider,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.summary).toContain('Review completed');
    expect(review).toHaveBeenCalledOnce();
  }, 10000);

  it('fails fast when review exceeds the configured timeout', async () => {
    const previousReviewTimeout = process.env.FORGEMIND_REVIEW_TIMEOUT_MS;
    process.env.FORGEMIND_REVIEW_TIMEOUT_MS = '50';

    const workspaceRoot = join(tmpdir(), `forgemind-worker-review-timeout-${randomUUID()}`);
    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Implement task', 'Review changes'],
          acceptanceCriteria: ['Build passes']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'pass\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return await new Promise<ReviewResult>(() => undefined);
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    try {
      const result = await runWorkerTask({
        project: demoProject,
        task: {
          ...demoTask,
          id: `task_${randomUUID()}`
        },
        provider,
        verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
        workspaceRoot
      });

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('Review timed out');
      expect(result.validation.passed).toBe(true);
    } finally {
      if (previousReviewTimeout === undefined) {
        delete process.env.FORGEMIND_REVIEW_TIMEOUT_MS;
      } else {
        process.env.FORGEMIND_REVIEW_TIMEOUT_MS = previousReviewTimeout;
      }
    }
  }, 10000);

  it('does not retry implementation automatically for safe improvements from review', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-safe-improvements-${randomUUID()}`);
    const attempts: ImplementInput[] = [];
    let reviewAttempt = 0;

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Write implementation marker'],
          acceptanceCriteria: ['Safe improvements should be auto-applied']
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        attempts.push(input);
        return {
          summary: `Attempt ${input.attemptNumber}`,
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [
            {
              path: 'status.txt',
              content: `attempt-${input.attemptNumber}\n`
            }
          ]
        };
      },
      async review(_input: ReviewInput): Promise<ReviewResult> {
        reviewAttempt += 1;
        if (reviewAttempt === 1) {
          return {
            summary: 'Review suggested safe improvements',
            blockers: [],
            safeImprovements: ['Apply suggested null guard'],
            riskyChanges: []
          };
        }

        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 12,
          outputTokens: 6,
          estimatedCostUsd: 0.0042
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        maxIterations: 2
      },
      provider,
      verifyCommand: `node -e "process.exit(0)"`,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.previousSafeImprovements).toBeUndefined();
    expect(reviewAttempt).toBe(1);
  }, 10000);

  it('includes retry details in the draft pull request body', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-pr-body-${randomUUID()}`);
    const createdPrs: CreateDraftPullRequestInput[] = [];
    const attempts: ImplementInput[] = [];

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Implement fix'],
          acceptanceCriteria: ['PR body should include retry notes']
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        attempts.push(input);
        return {
          summary: `Attempt ${input.attemptNumber}`,
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [
            {
              path: 'status.txt',
              content: (input.attemptNumber ?? 1) >= 2 ? 'pass\n' : 'fail\n'
            }
          ]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 12,
          outputTokens: 6,
          estimatedCostUsd: 0.0042
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const github: GitHubAdapter = {
      async createIssue(input) {
        return {
          issueNumber: 1234,
          issueUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/issues/1234`
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
      async createDraftPullRequest(input) {
        createdPrs.push(input);
        return {
          pullRequestNumber: 4321,
          pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/4321`
        };
      },
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    const result = await runWorkerTask({
      project: gitEnabledProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        maxIterations: 2
      },
      provider,
      github,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(attempts).toHaveLength(2);
    expect(createdPrs).toHaveLength(1);
    expect(createdPrs[0]?.body).toContain('## Průběh běhu');
    expect(createdPrs[0]?.body).toContain('Total implementation attempts: 2');
    expect(createdPrs[0]?.body).toContain('Validation retry before attempt 2: Exit code 1');
    expect(createdPrs[0]?.body).toContain('Input tokens: 12, output tokens: 6, estimated cost: 0.0042 USD');
    expect(createdPrs[0]?.body).toContain('## Poslední validace');
    expect(createdPrs[0]?.body).toContain('## Vyřešené review blokery');
  }, 10000);

  it('fails after exhausting review retries without creating a pull request', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-review-failed-${randomUUID()}`);
    const createdPrs: CreateDraftPullRequestInput[] = [];

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Keep trying'],
          acceptanceCriteria: ['Review must pass']
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: `Attempt ${input.attemptNumber}`,
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'pass\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review still blocked',
          blockers: ['Still missing guard clause'],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const github: GitHubAdapter = {
      async createIssue(input) {
        return {
          issueNumber: 1234,
          issueUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/issues/1234`
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
      async createDraftPullRequest(input) {
        createdPrs.push(input);
        return {
          pullRequestNumber: 4321,
          pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/4321`
        };
      },
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        maxIterations: 2
      },
      provider,
      github,
      verifyCommand: `node -e "process.exit(0)"`,
      workspaceRoot
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Review blocked completion after 2 attempt(s)');
    expect(createdPrs).toHaveLength(0);
  }, 15000);

  it('emits structured GitHub failure hook when branch creation fails', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-github-failure-${randomUUID()}`);
    const onGitHubOperationFailed = vi.fn(async () => undefined);

    const provider: AIProvider = {
      kind: 'codex',
      async plan(_input: PlanInput): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['step'],
          acceptanceCriteria: ['ac']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'impl',
          changedFiles: [],
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          requestedApprovals: []
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'review',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const github: GitHubAdapter = {
      async createIssue(input) {
        return {
          issueNumber: 1234,
          issueUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/issues/1234`
        };
      },
      getRemoteUrl() {
        return undefined;
      },
      async createBranch() {
        throw new Error('GitHub API POST /repos/demo/demo-repo/git/refs failed with 403: Forbidden');
      },
      async commitAndPush() {
        return undefined;
      },
      async createDraftPullRequest() {
        return {
          pullRequestNumber: 1,
          pullRequestUrl: 'https://github.com/demo/demo-repo/pull/1'
        };
      },
      async commentOnIssue() {
        return undefined;
      },
      async readCheckStatus() {
        return 'success';
      }
    };

    await expect(
      runWorkerTask({
        project: gitEnabledProject,
        task: {
          ...demoTask,
          id: `task_${randomUUID()}`
        },
        provider,
        github,
        verifyCommand: 'node --version',
        workspaceRoot,
        hooks: {
          onGitHubOperationFailed
        }
      })
    ).rejects.toThrow('403: Forbidden');

    expect(onGitHubOperationFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'create_branch',
        errorMessage: expect.stringContaining('403: Forbidden')
      })
    );
  });

  it('requires approval for risky review changes in safe mode', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-safe-policy-${randomUUID()}`);

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Implement task'],
          acceptanceCriteria: ['Review approval should be required']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review found risky refactor',
          blockers: [],
          safeImprovements: [],
          riskyChanges: ['risky_refactor']
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        mode: 'safe'
      },
      provider,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('needs_approval');
    expect(result.approvals).toContain('risky_refactor');
  });

  it('allows non-protected operations in safe mode when the project opts out of safe approvals', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-safe-auto-approval-${randomUUID()}`);
    const result = await runWorkerTask({
      project: {
        ...demoProject,
        allowSafeOperationsWithoutApproval: true
      },
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        mode: 'safe'
      },
      provider: createProviderStub({
        async review(): Promise<ReviewResult> {
          return {
            summary: 'Review found a non-protected change',
            blockers: [],
            safeImprovements: [],
            riskyChanges: ['risky_refactor']
          };
        }
      }),
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.approvals).toEqual(['risky_refactor']);
  }, 15000);

  it('still requires approval for protected operations when safe approvals are disabled', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-protected-approval-${randomUUID()}`);
    const onIteration = vi.fn(async () => undefined);
    const result = await runWorkerTask({
      project: {
        ...demoProject,
        allowSafeOperationsWithoutApproval: true
      },
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        mode: 'safe'
      },
      provider: createProviderStub({
        async implement(): Promise<ImplementResult> {
          return {
            summary: 'Database migration requested',
            changedFiles: [],
            diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
            requestedApprovals: ['database_migration']
          };
        }
      }),
      verifyCommand: 'node --version',
      workspaceRoot,
      hooks: { onIteration }
    });

    expect(result.status).toBe('needs_approval');
    expect(result.approvals).toEqual(['database_migration']);
    expect(onIteration).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'implementation',
      resultSummary: 'Database migration requested'
    }));
  }, 15000);

  it('allows non-required risky changes in auto mode', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-auto-policy-${randomUUID()}`);
    const projectWithConfig = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('default_mode: safe', 'default_mode: auto').replace('required_for: []', 'required_for:\n    - deploy')
    };

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Implement task'],
          acceptanceCriteria: ['Auto mode should proceed']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review risky but auto-allowed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: ['risky_refactor']
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: projectWithConfig,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        mode: 'auto'
      },
      provider,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
  }, 10000);

  it('blocks forbidden verify command by requesting approval', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-command-policy-${randomUUID()}`);

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        mode: 'safe'
      },
      provider: createProviderStub(),
      verifyCommand: 'sudo npm test',
      workspaceRoot
    });

    expect(result.status).toBe('needs_approval');
    expect(result.approvals).toContain('config_change');
    expect(result.summary).toContain('blocked by sandbox policy');
  });

  it('blocks write outside workspace by requesting approval', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-path-policy-${randomUUID()}`);

    const provider: AIProvider = {
      kind: 'codex',
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Plan summary',
          steps: ['Write outside workspace'],
          acceptanceCriteria: ['Should be blocked']
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['../outside.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          fileUpdates: [{ path: '../outside.txt', content: 'forbidden\n' }]
        };
      },
      async review(): Promise<ReviewResult> {
        return {
          summary: 'Review summary',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      },
      async estimateCost(): Promise<CostEstimateResult> {
        return {
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0
        };
      },
      supportsLocalRepo() {
        return true;
      },
      supportsGitHubNativeFlow() {
        return false;
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: {
        ...demoTask,
        id: `task_${randomUUID()}`,
        mode: 'safe'
      },
      provider,
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('needs_approval');
    expect(result.approvals).toContain('write_outside_repo');
  });
});
