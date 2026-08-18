import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import {
  buildTaskExecutionPrompt,
  compactTaskExecutionPrompt,
  createRoadmapTaskPlan,
  inferRepositoryInstallCommand,
  isInspectionOnlyValidationCommand,
  isReviewSummaryOnlyPath,
  normalizeValidationChecks,
  replaceFailedValidationCheck,
  resolveValidationChecks,
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
  it('infers a frozen dependency install from the repository lockfile', async () => {
    const workspacePath = join(tmpdir(), `forgemind-worker-install-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'package.json'), '{"private":true}\n', 'utf8');
    await writeFile(join(workspacePath, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');

    await expect(inferRepositoryInstallCommand(workspacePath)).resolves.toBe('npm ci');

    await mkdir(join(workspacePath, 'node_modules'));
    await expect(inferRepositoryInstallCommand(workspacePath)).resolves.toBeUndefined();
  });

  it('creates a persistent workspace virtual environment for declared Python validation dependencies', async () => {
    const workspacePath = join(tmpdir(), `forgemind-worker-python-install-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'requirements-dev.txt'), 'pytest==8.4.1\njsonschema==4.25.0\n', 'utf8');

    await expect(inferRepositoryInstallCommand(workspacePath)).resolves.toBe(
      'python3 -m venv .venv && .venv/bin/python -m pip install --disable-pip-version-check -r requirements-dev.txt'
    );

    await mkdir(join(workspacePath, '.venv'));
    await expect(inferRepositoryInstallCommand(workspacePath)).resolves.toContain('requirements-dev.txt');
  });

  it('runs the local provider workflow end-to-end without GitHub operations', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-test-${randomUUID()}`);
    let capturedReviewInput: ReviewInput | undefined;
    const implementationReview = vi.fn();
    const provider = createProviderStub({ review: implementationReview });
    const reviewProvider = createProviderStub({
      review: vi.fn(async (input): Promise<ReviewResult> => {
        capturedReviewInput = input;
        return {
          summary: 'Review passed',
          blockers: [],
          safeImprovements: [],
          riskyChanges: []
        };
      })
    });

    const result = await runWorkerTask({
      project: demoProject,
      task: demoTask,
      provider,
      reviewProvider,
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
        taskPrompt: demoTask.prompt,
        acceptanceCriteria: ['Validation passes'],
        validation: expect.objectContaining({
          command: 'node --version',
          exitCode: 0,
          passed: true
        }),
        diff: expect.stringContaining('diff --git a/status.txt b/status.txt')
      })
    );
    expect(implementationReview).not.toHaveBeenCalled();
    expect(reviewProvider.review).toHaveBeenCalledOnce();
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
    await expect(access(join(workspacePath, 'AGENTS.md'))).rejects.toThrow();
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
    const mergeCommitSha = 'a'.repeat(40);
    const createPullRequest = vi.fn(createGitHubStub().createDraftPullRequest);
    const mergePullRequest = vi.fn(async () => ({
      merged: true,
      sha: mergeCommitSha,
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
    expect(result.commitSha).toBe(mergeCommitSha);
    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: false }), undefined);
    expect(mergePullRequest).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: 'main' }), 4321, undefined);
  }, 10000);

  it('feeds failed GitHub Actions output back to AI and merges only after the corrected commit passes', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-ci-retry-${randomUUID()}`);
    let implementationAttempt = 0;
    const implement = vi.fn(async (input: ImplementInput): Promise<ImplementResult> => {
      implementationAttempt += 1;
      return {
        summary: implementationAttempt === 1 ? 'Initial implementation' : 'Windows CI correction',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: implementationAttempt === 1 ? 0 : 1 },
        requestedApprovals: [],
        fileUpdates: [{ path: 'status.txt', content: implementationAttempt === 1 ? 'initial\n' : 'corrected\n' }]
      };
    });
    const waitForChecks = vi.fn()
      .mockResolvedValueOnce({
        status: 'failure',
        summary: 'Native build: telemetry.cpp(101): error C2589: illegal token',
        failures: [{
          name: 'Native build',
          detailsUrl: 'https://github.com/demo/demo/actions/runs/1/job/2',
          output: 'telemetry.cpp(101): error C2589: illegal token'
        }]
      })
      .mockResolvedValueOnce({
        status: 'success',
        summary: '1 GitHub check(s) passed.',
        failures: []
      });
    const createPullRequest = vi.fn(createGitHubStub().createDraftPullRequest);
    const mergePullRequest = vi.fn(async () => ({
      merged: true,
      sha: 'merge-sha',
      message: 'Pull Request successfully merged'
    }));
    const statuses: string[] = [];

    const result = await runWorkerTask({
      project: {
        ...gitEnabledProject,
        configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true'),
        autoCreatePullRequest: true,
        autoMergePullRequest: true,
        autoCompleteTask: true
      },
      task: { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 3 },
      provider: createProviderStub({ implement }),
      github: createGitHubStub({ createDraftPullRequest: createPullRequest, mergePullRequest, waitForChecks }),
      verifyCommand: 'node --version',
      workspaceRoot,
      hooks: {
        async onStatus(status) {
          statuses.push(status);
        }
      }
    });

    expect(result.status).toBe('completed');
    expect(implement).toHaveBeenCalledTimes(2);
    expect(implement.mock.calls[1]?.[0].previousValidationError).toContain('error C2589');
    expect(createPullRequest).toHaveBeenCalledOnce();
    expect(waitForChecks).toHaveBeenCalledTimes(2);
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(statuses).toContain('running_ai');
  }, 15000);

  it('checkpoints GitHub Checks API failures for delivery-only retry', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-ci-api-failure-${randomUUID()}`);
    const onGitHubOperationFailed = vi.fn();

    await expect(runWorkerTask({
      project: {
        ...gitEnabledProject,
        configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true'),
        autoCreatePullRequest: true
      },
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider: createProviderStub(),
      github: createGitHubStub({
        async waitForChecks() {
          throw new Error('GitHub Checks API unavailable');
        }
      }),
      verifyCommand: 'node --version',
      workspaceRoot,
      hooks: { onGitHubOperationFailed }
    })).rejects.toThrow('GitHub Checks API unavailable');

    expect(onGitHubOperationFailed).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'wait_for_checks',
      errorMessage: 'GitHub Checks API unavailable'
    }));
  }, 10000);

  it('fails closed when green CI is required but no GitHub check is discovered', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-ci-required-${randomUUID()}`);
    const mergePullRequest = vi.fn(async () => ({ merged: true, sha: 'unexpected', message: 'Unexpected merge' }));

    await expect(runWorkerTask({
      project: {
        ...gitEnabledProject,
        configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true'),
        autoCreatePullRequest: true,
        autoMergePullRequest: true,
        autoCompleteTask: true
      },
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider: createProviderStub(),
      github: createGitHubStub({
        mergePullRequest,
        async waitForChecks() {
          return { status: 'not_configured', summary: 'No GitHub check run was discovered.', failures: [] };
        }
      }),
      verifyCommand: 'node --version',
      workspaceRoot
    })).rejects.toThrow('CI is required, but no GitHub check was discovered');

    expect(mergePullRequest).not.toHaveBeenCalled();
  }, 10000);

  it('does not ask AI to repair a GitHub billing failure', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-ci-billing-${randomUUID()}`);
    const implement = vi.fn(createProviderStub().implement);
    const onGitHubOperationFailed = vi.fn();

    await expect(runWorkerTask({
      project: {
        ...gitEnabledProject,
        configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true'),
        autoCreatePullRequest: true,
        autoMergePullRequest: true,
        autoCompleteTask: true
      },
      task: { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 3 },
      provider: createProviderStub({ implement }),
      github: createGitHubStub({
        async waitForChecks() {
          return {
            status: 'failure',
            summary: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.',
            failures: []
          };
        }
      }),
      verifyCommand: 'node --version',
      workspaceRoot,
      hooks: { onGitHubOperationFailed }
    })).rejects.toThrow('GitHub Actions infrastructure blocked execution');

    expect(implement).toHaveBeenCalledOnce();
    expect(onGitHubOperationFailed).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'wait_for_checks',
      errorMessage: expect.stringContaining('spending limit')
    }));
  }, 10000);

  it('fails delivery and records a failed checkpoint when GitHub does not confirm the automatic merge', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-auto-merge-rejected-${randomUUID()}`);
    const checkpoints: Array<{ key: string; status: string; output?: unknown; errorMessage?: string }> = [];
    await expect(runWorkerTask({
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
      workspaceRoot,
      hooks: {
        async onCheckpoint(checkpoint) {
          checkpoints.push(checkpoint);
        }
      }
    })).rejects.toThrow('was not merged: Base branch protection blocked the merge.');

    expect(checkpoints).toContainEqual(expect.objectContaining({
      key: 'external:merge_pr',
      status: 'failed',
      errorMessage: expect.stringContaining('Base branch protection blocked the merge.')
    }));
    expect(checkpoints).not.toContainEqual(expect.objectContaining({
      key: 'external:merge_pr',
      status: 'completed'
    }));
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
  }, 15000);

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
  }, 15000);

  it('keeps an approved protected operation valid across correction attempts in the same task', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-approved-operation-retry-${randomUUID()}`);
    const attempts: ImplementInput[] = [];
    const provider: AIProvider = {
      ...createProviderStub(),
      async plan(input: PlanInput): Promise<PlanResult> {
        if (input.validationFailure) {
          return {
            summary: 'Repair the implementation after validation detected the failed state.',
            steps: [],
            acceptanceCriteria: [],
            validationChecks: [],
            validationRecovery: {
              action: 'repair_implementation',
              rationale: 'The configured validation command correctly detected invalid content.'
            }
          };
        }
        return {
          summary: 'Plan summary',
          steps: ['Implement task'],
          acceptanceCriteria: ['Validation passes']
        };
      },
      async implement(input: ImplementInput): Promise<ImplementResult> {
        attempts.push(input);
        return {
          summary: `Correction attempt ${input.attemptNumber}`,
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: ['delete_files'],
          validationChecks: [],
          fileUpdates: [{
            path: 'status.txt',
            content: input.attemptNumber === 1 ? 'fail\n' : 'pass\n'
          }]
        };
      }
    };

    const result = await runWorkerTask({
      project: demoProject,
      task: { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 },
      provider,
      verifyCommand: `node -e "const { readFileSync } = require('node:fs'); process.exit(readFileSync('status.txt', 'utf8').trim() === 'pass' ? 0 : 1)"`,
      workspaceRoot,
      resume: {
        kind: 'approved_operation',
        resumeFrom: 'implementation',
        implementationSummary: 'Continue after approval.',
        approvedApprovals: ['delete_files']
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(attempts).toHaveLength(2);
    expect(result.approvals).not.toContain('delete_files');
  }, 15000);

  it('resumes a failed implementation attempt with its original review blockers', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-implementation-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'partial\n', 'utf8');

    const plan = vi.fn();
    const implement = vi.fn(async (input: ImplementInput): Promise<ImplementResult> => {
      expect(input.attemptNumber).toBe(2);
      expect(input.previousReviewBlockers).toEqual(['Fix adapter lookup.']);
      expect(input.previousSafeImprovements).toEqual(['Keep the focused test.']);
      return {
        summary: 'Corrected only the reported blocker.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
        requestedApprovals: [],
        fileUpdates: [{ path: 'status.txt', content: 'corrected\n' }]
      };
    });
    const review = vi.fn(async (input: ReviewInput): Promise<ReviewResult> => {
      expect(input.previousReviewBlockers).toEqual(['Fix adapter lookup.']);
      return { summary: 'Review passed', blockers: [], safeImprovements: [], riskyChanges: [] };
    });
    const provider = createProviderStub({ plan, implement, review });

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider,
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'implementation',
        attempt: 2,
        planSummary: 'Original plan',
        planSteps: ['Preserve the existing implementation.'],
        acceptanceCriteria: ['The resumed review receives the original criterion.'],
        implementationSummary: 'Partial implementation is preserved.',
        previousReviewBlockers: ['Fix adapter lookup.'],
        previousSafeImprovements: ['Keep the focused test.'],
        validation: { command: 'node --version', exitCode: 0, stdout: 'v22', stderr: '', passed: true },
        validationChecks: [{ kind: 'command', command: 'node --version' }]
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(plan).not.toHaveBeenCalled();
    expect(implement).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      acceptanceCriteria: ['The resumed review receives the original criterion.']
    }));
    expect(await readFile(join(workspacePath, 'status.txt'), 'utf8')).toBe('corrected\n');
  }, 15000);

  it('resumes review without repeating implementation or successful validation', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-review-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'implemented\n', 'utf8');

    const plan = vi.fn();
    const implement = vi.fn();
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review resumed and passed.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));
    const iterationPhases: string[] = [];
    const provider = createProviderStub({ plan, implement, review });

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider,
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'review',
        attempt: 1,
        planSummary: 'Original plan',
        implementationSummary: 'Implementation already completed.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validation: { command: 'node -e "process.exit(9)"', exitCode: 0, stdout: 'Previously passed', stderr: '', passed: true },
        validationChecks: [{ kind: 'command', command: 'node -e "process.exit(9)"' }]
      },
      hooks: {
        onIteration: async (iteration) => {
          iterationPhases.push(iteration.phase);
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.stdout).toBe('Previously passed');
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
    expect(iterationPhases).toEqual(['review']);
  }, 15000);

  it('resumes an interrupted validation suite without rerunning passed checks', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-validation-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const project = { ...demoProject, configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"', 'commands: {}') };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'implemented\n', 'utf8');

    const plan = vi.fn();
    const implement = vi.fn();
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review passed.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));
    const provider = createProviderStub({ plan, implement, review });
    const validationInputHash = createHash('sha256')
      .update('status.txt')
      .update('implemented\n')
      .digest('hex');

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'validation',
        attempt: 1,
        implementationSummary: 'Implementation already completed.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationChecks: [
          { kind: 'command', command: 'node -e "process.exit(9)"' },
          { kind: 'command', command: 'node --version' }
        ],
        passedValidationChecks: [{
          command: 'node -e "process.exit(9)"',
          exitCode: 0,
          stdout: 'Passed before interruption.',
          stderr: '',
          passed: true,
          inputHash: validationInputHash
        }]
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.validation.executedCheckCount).toBe(1);
    expect(result.validation.reusedCheckCount).toBe(1);
    expect(result.validation.stdout).toContain('Passed before interruption.');
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      validation: expect.objectContaining({ stdout: expect.stringContaining('Passed before interruption.') })
    }));
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
  }, 15000);

  it('resumes failed validation-plan revision without rerunning the invalid command', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-validation-plan-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const project = { ...demoProject, configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"', 'commands: {}') };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'implemented\n', 'utf8');

    const plan = vi.fn(async (input: PlanInput): Promise<PlanResult> => {
      expect(input.previousValidationError).toContain('missing-tool: not found');
      expect(input.validationFailure).toEqual({
        command: 'missing-tool test',
        exitCode: 1,
        stdout: '',
        stderr: 'missing-tool: not found'
      });
      return {
        summary: 'Replaced unavailable validation command.',
        steps: [],
        acceptanceCriteria: [],
        validationChecks: [{ kind: 'command', command: 'node --version' }],
        validationRecovery: {
          action: 'replace_validation_check',
          rationale: 'The original command is unavailable; use an executable repository-safe replacement.'
        }
      };
    });
    const implement = vi.fn();
    const statuses: string[] = [];
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review passed.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));
    const provider = createProviderStub({ plan, implement, review });

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'validation',
        attempt: 1,
        implementationSummary: 'Implementation already completed.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationChecks: [{ kind: 'command', command: 'missing-tool test' }],
        validation: {
          command: 'missing-tool test',
          exitCode: 1,
          stdout: '',
          stderr: 'missing-tool: not found',
          passed: false,
          failingCommand: 'missing-tool test'
        },
        resumeValidationPlanRevision: true
      },
      hooks: {
        onStatus: async (status) => {
          statuses.push(status);
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.validation.command).toBe('node --version');
    expect(plan).toHaveBeenCalledOnce();
    expect(implement).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
    expect(statuses).toEqual(expect.arrayContaining(['running_ai', 'validating', 'reviewing']));
    expect(statuses.indexOf('validating')).toBeLessThan(statuses.indexOf('reviewing'));
  }, 15000);

  it('removes a failed check when AI selects an equivalent check that already passed', () => {
    const checks = [
      { kind: 'command' as const, command: 'node tools/forge_validate.js architecture' },
      { kind: 'command' as const, command: 'python tools/forge_validate.py architecture' }
    ];

    expect(replaceFailedValidationCheck(
      checks,
      'python tools/forge_validate.py architecture',
      [{ kind: 'command', command: 'node tools/forge_validate.js architecture' }]
    )).toEqual([
      { kind: 'command', command: 'node tools/forge_validate.js architecture' }
    ]);
  });

  it('does not re-add persisted architecture checks to an authoritative resume plan', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-authoritative-validation-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'implemented\n', 'utf8');
    const implement = vi.fn();
    const plan = vi.fn();
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review passed.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));

    const result = await runWorkerTask({
      project: {
        ...demoProject,
        configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"', 'commands: {}'),
        projectArchitecture: {
          version: 1,
          summary: 'Validation architecture.',
          modules: [],
          decisions: [],
          conventions: [],
          dependencyRules: [],
          knownDebt: [],
          validationCommands: ['missing-tool architecture'],
          updatedAt: new Date().toISOString()
        }
      },
      task,
      provider: createProviderStub({ plan, implement, review }),
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'validation',
        attempt: 1,
        implementationSummary: 'Implementation already completed.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationChecks: [{ kind: 'command', command: 'node --version' }]
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.command).toBe('node --version');
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
  }, 15000);

  it('keeps an authoritative resume validation plan and adds checks from a correction implementation', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-correction-authoritative-validation-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const mergePullRequest = vi.fn(async () => ({
      merged: true,
      sha: 'merge-sha',
      message: 'Pull Request successfully merged'
    }));
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review passed.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));
    const implement = vi.fn(async (): Promise<ImplementResult> => ({
      outcome: 'changes_made',
      summary: 'The correction adds an authoritative Windows validation command.',
      changedFiles: ['validator.txt'],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      requestedApprovals: [],
      fileUpdates: [{ path: 'validator.txt', content: 'windows validation\n' }],
      validationChecks: [
        { kind: 'command', command: 'node --version' },
        {
          kind: 'command',
          command: `node -e "process.exit(0)"`,
          criterion: 'Win64 application starts successfully.',
          requiredCapabilities: ['windows', 'unreal-engine-5.8']
        }
      ]
    }));

    const result = await runWorkerTask({
      project: {
        ...gitEnabledProject,
        configYaml: gitProjectConfig.replace('commands:\n  verify: "node --version"', 'commands: {}'),
        autoCreatePullRequest: true,
        autoMergePullRequest: true,
        autoCompleteTask: true,
        projectArchitecture: {
          version: 1,
          summary: 'Validation architecture.',
          modules: [],
          decisions: [],
          conventions: [],
          dependencyRules: [],
          knownDebt: [],
          validationCommands: ['missing-tool architecture'],
          updatedAt: new Date().toISOString()
        }
      },
      task,
      provider: createProviderStub({ implement, review }),
      github: createGitHubStub({ mergePullRequest }),
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'implementation',
        attempt: 1,
        implementationSummary: 'Previous implementation.',
        previousReviewBlockers: ['Review lacked cumulative evidence.'],
        validationChecks: [{ kind: 'command', command: 'node --version' }]
      }
    });

    expect(result.status).toBe('completed');
    expect(result.validation.command).toBe(`node --version && node -e "process.exit(0)"`);
    expect(result.validation.deferredChecks).toEqual([
      expect.objectContaining({
        command: `node -e "process.exit(0)"`,
        requiredCapabilities: ['windows', 'unreal-engine-5.8'],
        missingCapabilities: expect.arrayContaining(['unreal-engine-5.8'])
      })
    ]);
    expect(result.requiredCapabilities).toContain('unreal-engine-5.8');
    expect(result.summary).toContain('Windows-specific validation was deferred to the final project audit.');
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(implement).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
  }, 15000);

  it('resumes delivery without repeating AI, commit, or push checkpoints', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-delivery-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`,
      branchName: 'ai/1234-resume-delivery'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'implemented\n', 'utf8');

    const plan = vi.fn();
    const implement = vi.fn();
    const review = vi.fn();
    const commitAndPush = vi.fn(async () => undefined);
    const createDraftPullRequest = vi.fn(async () => ({
      pullRequestNumber: 4321,
      pullRequestUrl: 'https://github.com/demo/demo-static-gallery/pull/4321'
    }));
    const github = createGitHubStub({ commitAndPush, createDraftPullRequest });
    const provider = createProviderStub({ plan, implement, review });

    const result = await runWorkerTask({
      project: gitEnabledProject,
      task,
      provider,
      github,
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'delivery',
        attempt: 1,
        planSummary: 'Original plan',
        implementationSummary: 'Implementation already completed.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validation: { command: 'node --version', exitCode: 0, stdout: 'Previously passed', stderr: '', passed: true },
        reviewSummary: 'Review already passed.',
        completedOperations: ['commit', 'commit_and_push']
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(createDraftPullRequest).toHaveBeenCalledOnce();
  }, 15000);

  it('reruns GitHub checks when the resumed checkpoint belongs to an older commit', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-resume-stale-checks-${randomUUID()}`);
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/issues/1234`,
      branchName: 'ai/1234-resume-stale-checks',
      pullRequestNumber: 4321,
      pullRequestUrl: `https://github.com/${demoProject.githubOwner}/${demoProject.githubRepo}/pull/4321`
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'corrected\n', 'utf8');
    const git = simpleGit({ baseDir: workspacePath });
    await git.init();
    await git.addConfig('user.name', 'ForgeMind Test');
    await git.addConfig('user.email', 'forgemind-test@example.com');
    await git.add('.');
    await git.commit('Correct CI');
    await git.checkoutLocalBranch(task.branchName);
    const currentHead = (await git.revparse(['HEAD'])).trim();

    const waitForChecks = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'Current commit passed.',
      failures: []
    }));
    const commitAndPush = vi.fn(async () => undefined);

    const result = await runWorkerTask({
      project: {
        ...gitEnabledProject,
        configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true')
      },
      task,
      provider: createProviderStub({ plan: vi.fn(), implement: vi.fn(), review: vi.fn() }),
      github: createGitHubStub({ commitAndPush, waitForChecks }),
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'delivery',
        attempt: 2,
        planSummary: 'Original plan',
        implementationSummary: 'CI correction already completed.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
        validation: { command: 'npm run validate', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
        reviewSummary: 'Review already passed.',
        completedOperations: ['commit', 'commit_and_push', 'wait_for_checks', 'comment_on_issue'],
        githubChecks: { status: 'success', summary: 'Old commit passed.', failures: [] },
        githubChecksInputHash: createHash('sha256').update(`old-head:${task.pullRequestNumber}`).digest('hex')
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(waitForChecks).toHaveBeenCalledWith(expect.anything(), currentHead, expect.anything());
    expect(result.githubChecks?.summary).toBe('Current commit passed.');
  }, 15000);

  it('fast-forwards a clean resumed workspace and reruns only GitHub checks for an empty remote commit', async () => {
    const root = join(tmpdir(), `forgemind-worker-resume-remote-empty-${randomUUID()}`);
    const remotePath = join(root, 'remote.git');
    const sourcePath = join(root, 'source');
    const workspaceRoot = join(root, 'workspaces');
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: 'https://github.com/demo/demo-static-gallery/issues/1234',
      branchName: 'ai/1234-remote-empty',
      pullRequestNumber: 4321,
      pullRequestUrl: 'https://github.com/demo/demo-static-gallery/pull/4321'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(remotePath, { recursive: true });
    await simpleGit({ baseDir: remotePath }).init(true);
    await mkdir(sourcePath, { recursive: true });
    const sourceGit = simpleGit({ baseDir: sourcePath });
    await sourceGit.init();
    await sourceGit.addConfig('user.name', 'ForgeMind Test');
    await sourceGit.addConfig('user.email', 'forgemind-test@example.com');
    await writeFile(join(sourcePath, 'status.txt'), 'implemented\n', 'utf8');
    await sourceGit.add('.');
    await sourceGit.commit('Initial implementation');
    await sourceGit.branch(['-M', 'main']);
    await sourceGit.addRemote('origin', remotePath);
    await sourceGit.push(['-u', 'origin', 'main']);
    await sourceGit.checkoutLocalBranch(task.branchName);
    await sourceGit.push(['-u', 'origin', task.branchName]);
    await mkdir(workspaceRoot, { recursive: true });
    await simpleGit().clone(remotePath, workspacePath, ['--branch', task.branchName]);
    await sourceGit.commit('External empty commit', undefined, { '--allow-empty': null });
    await sourceGit.push('origin', task.branchName);
    const remoteHead = (await sourceGit.revparse(['HEAD'])).trim();

    const plan = vi.fn();
    const implement = vi.fn();
    const review = vi.fn();
    const waitForChecks = vi.fn(async () => ({ status: 'success' as const, summary: 'Fresh CI passed.', failures: [] }));
    const result = await runWorkerTask({
      project: { ...gitEnabledProject, configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true') },
      task,
      provider: createProviderStub({ plan, implement, review }),
      github: createGitHubStub({ getRemoteUrl: () => remotePath, waitForChecks }),
      workspaceRoot,
      resume: {
        kind: 'phase_retry', resumeFrom: 'delivery', attempt: 1,
        planSummary: 'Original plan', implementationSummary: 'Implementation complete.',
        changedFiles: ['status.txt'], diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validation: { command: 'node --version', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
        reviewSummary: 'Review passed.',
        completedOperations: ['commit', 'commit_and_push', 'wait_for_checks'],
        githubChecks: { status: 'success', summary: 'Old CI passed.', failures: [] },
        githubChecksInputHash: createHash('sha256').update(`old-head:${task.pullRequestNumber}`).digest('hex')
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect((await simpleGit({ baseDir: workspacePath }).revparse(['HEAD'])).trim()).toBe(remoteHead);
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(waitForChecks).toHaveBeenCalledWith(expect.anything(), remoteHead, expect.anything());
  }, 20000);

  it('preserves a dirty correction across an empty remote commit and delivers the corrected head', async () => {
    const root = join(tmpdir(), `forgemind-worker-resume-dirty-remote-empty-${randomUUID()}`);
    const remotePath = join(root, 'remote.git');
    const sourcePath = join(root, 'source');
    const workspaceRoot = join(root, 'workspaces');
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: 'https://github.com/demo/demo-static-gallery/issues/1234',
      branchName: 'ai/1234-dirty-remote-empty',
      pullRequestNumber: 4321,
      pullRequestUrl: 'https://github.com/demo/demo-static-gallery/pull/4321'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(remotePath, { recursive: true });
    await simpleGit({ baseDir: remotePath }).init(true);
    await mkdir(sourcePath, { recursive: true });
    const sourceGit = simpleGit({ baseDir: sourcePath });
    await sourceGit.init();
    await sourceGit.addConfig('user.name', 'ForgeMind Test');
    await sourceGit.addConfig('user.email', 'forgemind-test@example.com');
    await writeFile(join(sourcePath, 'status.txt'), 'stale implementation\n', 'utf8');
    await sourceGit.add('.');
    await sourceGit.commit('Initial implementation');
    await sourceGit.branch(['-M', 'main']);
    await sourceGit.addRemote('origin', remotePath);
    await sourceGit.push(['-u', 'origin', 'main']);
    await sourceGit.checkoutLocalBranch(task.branchName);
    await sourceGit.push(['-u', 'origin', task.branchName]);
    await mkdir(workspaceRoot, { recursive: true });
    await simpleGit().clone(remotePath, workspacePath, ['--branch', task.branchName]);
    const workspaceGit = simpleGit({ baseDir: workspacePath });
    const staleHead = (await workspaceGit.revparse(['HEAD'])).trim();
    await writeFile(join(workspacePath, 'status.txt'), 'corrected implementation\n', 'utf8');
    await sourceGit.commit('External empty commit', undefined, { '--allow-empty': null });
    await sourceGit.push('origin', task.branchName);
    const remoteEmptyHead = (await sourceGit.revparse(['HEAD'])).trim();

    const reviewInputs: ReviewInput[] = [];
    const implement = vi.fn(async (): Promise<ImplementResult> => ({
      summary: 'The preserved workspace correction addresses the previous review blocker.',
      changedFiles: ['status.txt'],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
      requestedApprovals: [],
      validationChecks: [{ kind: 'command', command: 'node --version' }]
    }));
    const review = vi.fn(async (reviewInput: ReviewInput): Promise<ReviewResult> => {
      reviewInputs.push(reviewInput);
      return { summary: 'Correction passed review.', blockers: [], safeImprovements: [], riskyChanges: [] };
    });
    const commitAndPush = vi.fn(async (_project: Project, branchName: string, _message: string, repositoryPath: string) => {
      await simpleGit({ baseDir: repositoryPath }).push('origin', branchName);
    });
    const waitForChecks = vi.fn(async () => ({
      status: 'success' as const,
      summary: 'Corrected head passed.',
      failures: []
    }));

    const result = await runWorkerTask({
      project: { ...gitEnabledProject, configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true') },
      task,
      provider: createProviderStub({ implement, review }),
      github: createGitHubStub({ getRemoteUrl: () => remotePath, commitAndPush, waitForChecks }),
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'implementation',
        attempt: 2,
        planSummary: 'Original plan',
        acceptanceCriteria: ['The correction is delivered and CI passes.'],
        implementationSummary: 'Previous implementation failed review.',
        previousReviewBlockers: ['Replace the stale implementation.'],
        validationChecks: [{ kind: 'command', command: 'node --version' }],
        completedOperations: ['commit', 'commit_and_push', 'wait_for_checks'],
        githubChecks: { status: 'success', summary: 'Stale head passed.', failures: [] },
        githubChecksInputHash: createHash('sha256').update(`${staleHead}:${task.pullRequestNumber}`).digest('hex')
      }
    });

    const deliveredHead = (await workspaceGit.revparse(['HEAD'])).trim();
    await sourceGit.fetch('origin', task.branchName);
    const remoteDeliveredHead = (await sourceGit.revparse([`origin/${task.branchName}`])).trim();
    expect(result.status).toBe('ready_for_user_review');
    expect((await workspaceGit.show(['HEAD:status.txt'])).trim()).toBe('corrected implementation');
    expect((await workspaceGit.raw(['rev-parse', 'HEAD^'])).trim()).toBe(remoteEmptyHead);
    expect(deliveredHead).not.toBe(staleHead);
    expect(remoteDeliveredHead).toBe(deliveredHead);
    expect(commitAndPush).toHaveBeenCalledOnce();
    expect(waitForChecks).toHaveBeenCalledWith(expect.anything(), deliveredHead, expect.anything());
    expect(reviewInputs[0]?.diff).toContain('+corrected implementation');
    expect(reviewInputs[0]?.diff).not.toContain('+stale implementation');
  }, 20000);

  it('reruns validation and review after a remote commit changes the resumed workspace tree', async () => {
    const root = join(tmpdir(), `forgemind-worker-resume-remote-tree-${randomUUID()}`);
    const remotePath = join(root, 'remote.git');
    const sourcePath = join(root, 'source');
    const workspaceRoot = join(root, 'workspaces');
    const task = {
      ...demoTask,
      id: `task_${randomUUID()}`,
      githubIssueNumber: 1234,
      githubIssueUrl: 'https://github.com/demo/demo-static-gallery/issues/1234',
      branchName: 'ai/1234-remote-tree',
      pullRequestNumber: 4321,
      pullRequestUrl: 'https://github.com/demo/demo-static-gallery/pull/4321'
    };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(remotePath, { recursive: true });
    await simpleGit({ baseDir: remotePath }).init(true);
    await mkdir(sourcePath, { recursive: true });
    const sourceGit = simpleGit({ baseDir: sourcePath });
    await sourceGit.init();
    await sourceGit.addConfig('user.name', 'ForgeMind Test');
    await sourceGit.addConfig('user.email', 'forgemind-test@example.com');
    await writeFile(join(sourcePath, 'status.txt'), 'implemented\n', 'utf8');
    await sourceGit.add('.');
    await sourceGit.commit('Initial implementation');
    await sourceGit.branch(['-M', 'main']);
    await sourceGit.addRemote('origin', remotePath);
    await sourceGit.push(['-u', 'origin', 'main']);
    await sourceGit.checkoutLocalBranch(task.branchName);
    await sourceGit.push(['-u', 'origin', task.branchName]);
    await mkdir(workspaceRoot, { recursive: true });
    await simpleGit().clone(remotePath, workspacePath, ['--branch', task.branchName]);
    await writeFile(join(sourcePath, 'external-fix.txt'), 'fixed\n', 'utf8');
    await sourceGit.add('external-fix.txt');
    await sourceGit.commit('External implementation fix');
    await sourceGit.push('origin', task.branchName);

    const plan = vi.fn();
    const implement = vi.fn();
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Updated tree reviewed.', blockers: [], safeImprovements: [], riskyChanges: []
    }));
    const validationIterations: Array<{ validationResult: unknown }> = [];
    const result = await runWorkerTask({
      project: { ...gitEnabledProject, configYaml: gitProjectConfig.replace('auto_push: false', 'auto_push: true') },
      task,
      provider: createProviderStub({ plan, implement, review }),
      github: createGitHubStub({
        getRemoteUrl: () => remotePath,
        waitForChecks: async () => ({ status: 'success', summary: 'Updated CI passed.', failures: [] })
      }),
      workspaceRoot,
      hooks: {
        onIteration: async (iteration) => {
          if (iteration.phase === 'validation') validationIterations.push(iteration);
        }
      },
      resume: {
        kind: 'phase_retry', resumeFrom: 'delivery', attempt: 1,
        planSummary: 'Original plan', implementationSummary: 'Implementation complete.',
        changedFiles: ['status.txt'], diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationChecks: [{ kind: 'command', command: 'node --version', category: 'smoke' }],
        validation: { command: 'node --version', exitCode: 0, stdout: 'old pass', stderr: '', passed: true },
        reviewSummary: 'Old review passed.',
        completedOperations: ['commit', 'commit_and_push', 'wait_for_checks']
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(plan).not.toHaveBeenCalled();
    expect(implement).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
    expect(validationIterations).toHaveLength(1);
    expect(validationIterations[0]?.validationResult).toEqual(expect.objectContaining({ passed: true }));
  }, 20000);

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

  it('uses validation commands proposed by the implementation AI', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-planned-validation-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace(
        'commands:\n  verify: "node --version"\n',
        'commands:\n  install: "node --version"\n'
      )
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
              command: `node -e "process.exit(9)"`,
              criterion: 'Build passes',
              rationale: 'Outdated planning-time validation must not run.'
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
          validationChecks: [
            {
              kind: 'command',
              command: `node -e "process.exit(0)"`,
              criterion: 'Build passes',
              rationale: 'Selected after implementation from the resulting repository.'
            }
          ],
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
    expect(result.validation.command).toContain('node --version');
    expect(result.validation.command).toContain('node -e');
    expect(result.validation.command).not.toContain('process.exit(9)');
  }, 10000);

  it('continues without inventing an environment smoke check when AI has no executable validation', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-missing-ai-validation-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const provider: AIProvider = {
      ...createProviderStub(),
      async plan(): Promise<PlanResult> {
        return {
          summary: 'Implement the requested change.',
          steps: ['Update status'],
          acceptanceCriteria: ['Status is updated'],
          validationChecks: []
        };
      },
      async implement(): Promise<ImplementResult> {
        return {
          summary: 'Implementation completed without a validation proposal.',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          validationChecks: [],
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      }
    };

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.command).toBe('no-executable-checks');
    expect(result.validation.stdout).toContain('validation was skipped');
    expect(result.validation.command).not.toContain('node --version');
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
    const validationStatuses: string[] = [];
    const successfulValidationCommand = `node -e "process.stdout.write('already-passed')"`;
    const firstCorrectedValidationCommand = `node -e "process.stdout.write('first-corrected')"`;
    const secondFailedValidationCommand = `node -e "process.stderr.write('sh: 1: docker: not found'); process.exit(1)"`;
    const secondCorrectedValidationCommand = `node -e "process.stdout.write('second-corrected')"`;

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
                command: successfulValidationCommand,
                criterion: 'Unrelated successful validation.',
                rationale: 'Must not run again after correcting another check.'
              },
              {
                kind: 'command',
                command: `node -e "process.stderr.write('sh: 1: tsc: not found'); process.exit(1)"`,
                criterion: 'Initial failing validation.',
                rationale: 'Synthetic failure for retry.'
              },
              {
                kind: 'command',
                command: secondFailedValidationCommand,
                criterion: 'Second unavailable validation tool.',
                rationale: 'Must be corrected without repeating previous checks.'
              }
            ]
          };
        }

        if (planCalls.length === 2) {
          return {
            summary: 'Updated plan with the first corrected validation command.',
            steps: [],
            acceptanceCriteria: ['Build passes'],
            validationRecovery: {
              action: 'replace_validation_check',
              rationale: 'Replace the unavailable validation command.'
            },
            validationChecks: [
              {
                kind: 'command',
                command: successfulValidationCommand,
                criterion: 'Unrelated successful validation.',
                rationale: 'Provider repeated it despite the focused correction request.'
              },
              {
                kind: 'command',
                command: firstCorrectedValidationCommand,
                criterion: 'First corrected validation.',
                rationale: 'Adjusted after the first validation failure.'
              },
              {
                kind: 'command',
                command: secondFailedValidationCommand,
                criterion: 'Second unavailable validation tool.',
                rationale: 'Provider repeated an unrelated pending check.'
              }
            ]
          };
        }

        return {
          summary: 'Updated plan with the second corrected validation command.',
          steps: [],
          acceptanceCriteria: ['Build passes'],
          validationRecovery: {
            action: 'replace_validation_check',
            rationale: 'Replace the second unavailable validation command.'
          },
          validationChecks: [
            {
              kind: 'command',
              command: successfulValidationCommand,
              criterion: 'Unrelated successful validation.',
              rationale: 'Provider repeated it despite the focused correction request.'
            },
            {
              kind: 'command',
              command: firstCorrectedValidationCommand,
              criterion: 'First corrected validation.',
              rationale: 'Provider repeated the already passed first correction.'
            },
            {
              kind: 'command',
              command: secondCorrectedValidationCommand,
              criterion: 'Second corrected validation.',
              rationale: 'Adjusted after the second validation failure.'
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
          validationChecks: input.plan.validationChecks,
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
        onStatus: async (status) => {
          if (status === 'validating') {
            validationStatuses.push(status);
          }
        },
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
    expect(result.validation.executedCheckCount).toBe(1);
    expect(result.validation.reusedCheckCount).toBe(2);
    await expect(access(join(result.workspacePath, 'AGENTS.md'))).rejects.toThrow();
    expect(planCalls).toHaveLength(3);
    expect(implementCalls).toHaveLength(1);
    expect(validationStatuses).toEqual(['validating']);
    expect(planCalls[0]?.prompt).not.toContain('very long project brief');
    expect(planCalls[1]?.prompt).toContain('Diagnose the single failed validation check');
    expect(planCalls[1]?.prompt).toContain('Do not repeat successful or unrelated checks');
    expect(planCalls[1]?.prompt).not.toContain('very long project brief');
    expect(planCalls[1]?.previousValidationError).toContain('tsc: not found');
    expect(planCalls[1]?.validationFailure).toEqual(expect.objectContaining({
      exitCode: 1,
      stderr: expect.stringContaining('tsc: not found')
    }));
    expect(planCalls[1]?.previousValidationChecks).toEqual([
      expect.objectContaining({
        kind: 'command',
        command: expect.stringContaining('tsc: not found')
      })
    ]);
    expect(planCalls[2]?.previousValidationChecks).toEqual([
      expect.objectContaining({
        kind: 'command',
        command: expect.stringContaining('docker: not found')
      })
    ]);
    expect(taskActivities.filter((activity) => (
      activity.state === 'started'
      && activity.detail === successfulValidationCommand
    ))).toHaveLength(1);
    expect(taskActivities.filter((activity) => (
      activity.state === 'started'
      && activity.detail === firstCorrectedValidationCommand
    ))).toHaveLength(1);
    expect(taskActivities.filter((activity) => (
      activity.state === 'started'
      && activity.detail === secondCorrectedValidationCommand
    ))).toHaveLength(1);
    expect(taskActivities).toContainEqual(expect.objectContaining({
      phase: 'validation',
      state: 'completed',
      title: expect.stringContaining('pouzit checkpoint'),
      detail: expect.stringContaining('znovu se nespousti')
    }));
    expect(planningIterations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'planning',
          validationResult: expect.objectContaining({
            revisedValidationChecksOnly: true,
            validationChecks: expect.arrayContaining([
              expect.objectContaining({ command: secondCorrectedValidationCommand })
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

  it('continues AI validation recovery beyond two failed replacement commands', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-validation-recovery-depth-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const failingCommands = [1, 2, 3].map((number) => (
      `node -e "process.stderr.write('validation-failure-${number}'); process.exit(1)"`
    ));
    const planCalls: PlanInput[] = [];
    const provider = createProviderStub({
      plan: vi.fn(async (input: PlanInput): Promise<PlanResult> => {
        planCalls.push(input);
        if (!input.validationFailure) {
          return {
            summary: 'Initial validation plan.',
            steps: ['Implement and validate'],
            acceptanceCriteria: ['Validation passes'],
            validationChecks: [{ kind: 'command', command: failingCommands[0]! }]
          };
        }
        const recoveryIndex = planCalls.length - 2;
        const replacement = failingCommands[recoveryIndex + 1] ?? 'node --version';
        return {
          summary: `Validation recovery ${recoveryIndex + 1}.`,
          steps: [],
          acceptanceCriteria: [],
          validationChecks: [{ kind: 'command', command: replacement }],
          validationRecovery: {
            action: 'replace_validation_check',
            rationale: 'Replace only the failed validation command.'
          }
        };
      }),
      implement: vi.fn(async (input: ImplementInput): Promise<ImplementResult> => ({
        summary: 'Implementation summary.',
        changedFiles: ['status.txt'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        requestedApprovals: [],
        validationChecks: input.plan.validationChecks,
        fileUpdates: [{ path: 'status.txt', content: 'implemented\n' }]
      }))
    });

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(planCalls).toHaveLength(4);
    expect(planCalls.slice(1).map((call) => call.validationFailure?.stderr)).toEqual([
      'validation-failure-1',
      'validation-failure-2',
      'validation-failure-3'
    ]);
  }, 20000);

  it('reuses successful validation checks across implementation retries when repository inputs did not change', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-validation-retry-checkpoint-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const stableCommand = `node -e "process.stdout.write('stable')"`;
    const failingCommand = `node -e "process.stderr.write('assertion failed'); process.exit(1)"`;
    const correctedCommand = `node -e "process.stdout.write('corrected')"`;
    const taskActivities: TaskActivity[] = [];
    let implementationAttempt = 0;
    const provider: AIProvider = {
      ...createProviderStub(),
      async plan(input: PlanInput): Promise<PlanResult> {
        if (input.validationFailure) {
          return {
            summary: 'The implementation must be corrected.',
            steps: [],
            acceptanceCriteria: [],
            validationChecks: [],
            validationRecovery: {
              action: 'repair_implementation',
              rationale: 'The command correctly detected the failed implementation state.'
            }
          };
        }
        return {
          summary: 'Validate the implementation.',
          steps: ['Implement', 'Validate'],
          acceptanceCriteria: ['Validation passes'],
          validationChecks: []
        };
      },
      async implement(): Promise<ImplementResult> {
        implementationAttempt += 1;
        return {
          summary: implementationAttempt === 1 ? 'Implemented the change.' : 'Corrected only the failed validation check.',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          validationChecks: [
            { kind: 'command', command: stableCommand },
            { kind: 'command', command: implementationAttempt === 1 ? failingCommand : correctedCommand }
          ],
          fileUpdates: [{ path: 'status.txt', content: 'implemented\n' }]
        };
      }
    };

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 },
      provider,
      workspaceRoot,
      hooks: {
        onActivity: async (activity) => {
          taskActivities.push(activity);
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(implementationAttempt).toBe(2);
    expect(result.validation.executedCheckCount).toBe(1);
    expect(result.validation.reusedCheckCount).toBe(1);
    expect(taskActivities.filter((activity) => activity.state === 'started' && activity.detail === stableCommand)).toHaveLength(1);
    expect(taskActivities).toContainEqual(expect.objectContaining({
      phase: 'validation',
      state: 'completed',
      title: expect.stringContaining('pouzit checkpoint'),
      detail: expect.stringContaining(stableCommand)
    }));
  }, 15000);

  it('lets AI decide how to recover from a missing system toolchain', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-missing-toolchain-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const plan = vi.fn(async (input: PlanInput): Promise<PlanResult> => input.validationFailure
      ? {
          summary: 'The required CMake toolchain is unavailable.',
          steps: [],
          acceptanceCriteria: [],
          validationChecks: [],
          validationRecovery: {
            action: 'blocked',
            rationale: 'CMake is required for this criterion and cannot be installed safely in the current runtime.'
          }
        }
      : {
          summary: 'Build with CMake.',
          steps: ['Build'],
          acceptanceCriteria: ['CMake build passes'],
          validationChecks: [{
            kind: 'command',
            command: `node -e "process.stderr.write('/bin/sh: 1: cmake: not found'); process.exit(127)"`,
            criterion: 'CMake build passes'
          }]
        });
    const provider: AIProvider = {
      ...createProviderStub(),
      plan,
      async implement(input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: 'Implementation summary',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          validationChecks: input.plan.validationChecks,
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      }
    };

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider,
      workspaceRoot
    });

    expect(result.status).toBe('validation_failed');
    expect(result.summary).toContain('cannot be installed safely');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1]?.[0].validationFailure).toEqual(expect.objectContaining({
      exitCode: 127,
      stderr: '/bin/sh: 1: cmake: not found'
    }));
  }, 10000);

  it('defers an artifact consumer when its platform-specific producer was deferred', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-deferred-artifact-${randomUUID()}`);
    const projectWithoutVerify = {
      ...demoProject,
      configYaml: noGitProjectConfig.replace('commands:\n  verify: "node --version"\n', 'commands: {}\n')
    };
    const reportCheck = `node -e "require('node:fs').readFileSync('shipping-report.json')"`;
    const plan = vi.fn(async (input: PlanInput): Promise<PlanResult> => input.validationFailure
      ? {
          summary: 'The report check depends on the deferred Windows benchmark.',
          steps: [],
          acceptanceCriteria: [],
          validationChecks: [],
          validationRecovery: {
            action: 'blocked',
            rationale: 'The missing Windows benchmark report artifact cannot be validated until the Windows benchmark runs.'
          }
        }
      : {
          summary: 'Produce and validate the benchmark report.',
          steps: ['Implement benchmark gate'],
          acceptanceCriteria: ['Benchmark report is valid'],
          validationChecks: [
            {
              kind: 'command',
              command: 'Flying-Win64-Shipping.exe --write-report shipping-report.json',
              criterion: 'Produce the benchmark report.',
              requiredCapabilities: ['windows', 'unreal-engine-5.8']
            },
            {
              kind: 'command',
              command: reportCheck,
              criterion: 'Validate the generated benchmark report.'
            },
            { kind: 'command', command: 'node --version', criterion: 'Portable repository validation passes.' }
          ]
        });
    const provider: AIProvider = {
      ...createProviderStub(),
      plan,
      async implement(input: ImplementInput): Promise<ImplementResult> {
        return {
          summary: 'Implemented benchmark gate.',
          changedFiles: ['status.txt'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          requestedApprovals: [],
          validationChecks: input.plan.validationChecks,
          fileUpdates: [{ path: 'status.txt', content: 'ok\n' }]
        };
      }
    };

    const result = await runWorkerTask({
      project: projectWithoutVerify,
      task: { ...demoTask, id: `task_${randomUUID()}` },
      provider,
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation.passed).toBe(true);
    expect(result.validation.deferredChecks).toEqual([
      expect.objectContaining({ command: 'Flying-Win64-Shipping.exe --write-report shipping-report.json' }),
      expect.objectContaining({
        command: reportCheck,
        requiredCapabilities: ['windows', 'unreal-engine-5.8']
      })
    ]);
    expect(result.validation.checkResults).toEqual([
      expect.objectContaining({ command: 'node --version', passed: true })
    ]);
    expect(plan).toHaveBeenCalledTimes(2);
  }, 15000);

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

  it('keeps the compact project contract with the current roadmap step', () => {
    expect(compactTaskExecutionPrompt([
      'Project: Flying',
      'Parent objective:',
      'A very long brief that is intentionally omitted from every implementation call.',
      '',
      'Project contract:',
      'Summary: Czech offline simulator.',
      'Global invariants:',
      '- Use real Czech runway data.',
      'Requirements covered by this work item:',
      '- REQ-RUNWAYS: Import runway thresholds.',
      '',
      'Current implementation step:',
      'Import runway thresholds.',
      '',
      'Acceptance Criteria:',
      '- Import tests pass.'
    ].join('\n'))).toBe([
      'Project contract:',
      'Summary: Czech offline simulator.',
      'Global invariants:',
      '- Use real Czech runway data.',
      'Requirements covered by this work item:',
      '- REQ-RUNWAYS: Import runway thresholds.',
      '',
      'Current implementation step:',
      'Import runway thresholds.',
      '',
      'Acceptance Criteria:',
      '- Import tests pass.'
    ].join('\n'));
  });

  it('adds only a bounded relevant slice of project memory to a task prompt', () => {
    const prompt = buildTaskExecutionPrompt('Implement leaderboard score sorting.', {
      version: 1,
      baseCommitSha: 'abc123',
      updatedAt: '2026-08-08T10:00:00.000Z',
      recentWork: [
        {
          taskId: 'task-1',
          title: 'Add leaderboard API',
          summary: 'Added score persistence and sorting.',
          changedFiles: ['src/leaderboard.ts'],
          completedAt: '2026-08-08T09:00:00.000Z'
        },
        {
          taskId: 'task-2',
          title: 'Unrelated profile colors',
          summary: 'Changed profile colors.',
          changedFiles: ['src/profile.css'],
          completedAt: '2026-08-08T08:00:00.000Z'
        }
      ]
    });

    expect(prompt).toContain('Project memory');
    expect(prompt).toContain('Add leaderboard API');
    expect(prompt).toContain('Last recorded successful commit: abc123');
    expect(prompt.length).toBeLessThanOrEqual('Implement leaderboard score sorting.'.length + 4_000);
  });

  it('adds only relevant architecture modules and binding project boundaries', () => {
    const prompt = buildTaskExecutionPrompt('Implement leaderboard score sorting.', undefined, {
      version: 1,
      summary: 'Feature modules depend on shared persistence interfaces.',
      modules: [
        { name: 'Leaderboard', responsibility: 'Own scores and ranking.', paths: ['src/leaderboard/**'], publicInterfaces: ['LeaderboardRepository'], dependencies: ['Persistence'] },
        { name: 'Profiles', responsibility: 'Own profile colors.', paths: ['src/profiles/**'], publicInterfaces: ['ProfileService'], dependencies: [] }
      ],
      decisions: [{ id: 'arch-1', summary: 'Repository boundary', rationale: 'Keep storage replaceable.', createdAt: '' }],
      conventions: ['Use dependency injection at module boundaries.'],
      dependencyRules: ['Feature modules must not import another feature module internals.'],
      knownDebt: [],
      validationCommands: ['npm run architecture:check'],
      updatedAt: ''
    });

    expect(prompt).toContain('Project architecture');
    expect(prompt).toContain('LeaderboardRepository');
    expect(prompt).not.toContain('ProfileService');
    expect(prompt).toContain('npm run architecture:check');
  });

  it('deduplicates persisted architecture checks into the validation plan', async () => {
    const checks = await resolveValidationChecks({
      plan: {
        summary: 'Plan', steps: [], acceptanceCriteria: [],
        validationChecks: [{ kind: 'command', command: 'npm test' }]
      },
      architectureCommands: ['npm run architecture:check', 'npm test']
    });

    expect(checks.map((check) => check.command)).toEqual(['npm test', 'npm run architecture:check']);
  });

  it('drops architecture checks already covered by a broader planned command', async () => {
    const checks = await resolveValidationChecks({
      plan: {
        summary: 'Plan', steps: [], acceptanceCriteria: [],
        validationChecks: [{ kind: 'command', command: 'npm run lint && npm test && npm run build' }]
      },
      architectureCommands: ['npm run lint', 'npm run test:architecture', 'npm test', 'npm run build']
    });

    expect(checks.map((check) => check.command)).toEqual([
      'npm run lint && npm test && npm run build',
      'npm run test:architecture'
    ]);
  });

  it('configures a CMake preset before persisted build and CTest consumers', async () => {
    const workspacePath = join(tmpdir(), `forgemind-cmake-validation-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'CMakePresets.json'), JSON.stringify({
      version: 6,
      configurePresets: [{ name: 'ninja-debug', generator: 'Ninja', binaryDir: '${sourceDir}/build/ninja-debug' }]
    }), 'utf8');

    const checks = await resolveValidationChecks({
      plan: {
        summary: 'Plan', steps: [], acceptanceCriteria: [],
        validationChecks: [{ kind: 'command', command: 'cmake --build --preset ninja-debug', category: 'build' }]
      },
      architectureCommands: ['ctest --preset ninja-debug --output-on-failure'],
      workspacePath
    });

    expect(checks.map((check) => check.command)).toEqual([
      'cmake --preset ninja-debug',
      'cmake --build --preset ninja-debug',
      'ctest --preset ninja-debug --output-on-failure'
    ]);
    expect(checks[0]?.category).toBe('setup');
  });

  it('builds one ordered validation suite for install, Docker, migrations, readiness and AI checks', async () => {
    const workspacePath = join(tmpdir(), `forgemind-profile-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'compose.yml'), 'services: {}\n', 'utf8');

    const checks = await resolveValidationChecks({
      plan: {
        summary: 'Plan', steps: [], acceptanceCriteria: [],
        validationChecks: [
          { kind: 'command', command: 'npm run build', category: 'build' },
          { kind: 'command', command: 'npm run test:api', category: 'api' },
          { kind: 'command', command: 'npm run test:e2e', category: 'browser' }
        ]
      },
      installCommand: 'npm ci',
      workspacePath,
      validationProfile: {
        version: 1,
        enabled: true,
        dockerComposeFiles: ['compose.yml'],
        dockerComposeServices: ['postgres', 'api'],
        requiredEnvironmentVariables: [],
        migrationCommands: ['npm run db:migrate'],
        readinessCommands: ['npm run test:health'],
        commandTimeoutMinutes: 15
      }
    });

    expect(checks.map((check) => check.command)).toEqual([
      'npm ci',
      'docker compose -f "compose.yml" up -d --wait postgres api',
      'npm run db:migrate',
      'npm run test:health',
      'npm run build',
      'npm run test:api',
      'npm run test:e2e'
    ]);
    expect(checks.slice(1, 4).every((check) => check.timeoutMinutes === 15)).toBe(true);
  });

  it('derives a roadmap task plan without a separate provider planning call', () => {
    const plan = createRoadmapTaskPlan([
      'Current implementation step:',
      'Add leaderboard API.',
      '',
      'Step description and scope:',
      'Expose persisted leaderboard entries through the API.',
      '',
      'Execution boundary:',
      '- Implement only this step.',
      '',
      'Acceptance Criteria:',
      '- GET /api/leaderboard returns persisted scores.',
      '- Existing tests pass.'
    ].join('\n'));

    expect(plan).toEqual({
      summary: 'Implement roadmap step: Add leaderboard API.',
      steps: ['Expose persisted leaderboard entries through the API.'],
      acceptanceCriteria: [
        'GET /api/leaderboard returns persisted scores.',
        'Existing tests pass.'
      ],
      validationChecks: []
    });
  });

  it('drops repository inspection and manual checks from executable validation', () => {
    const command = 'git diff -- README.md docs AGENTS.md 2>/dev/null || git diff -- README.md';

    expect(isInspectionOnlyValidationCommand(command)).toBe(true);
    expect(isInspectionOnlyValidationCommand('git diff --exit-code -- README.md')).toBe(false);
    expect(normalizeValidationChecks([
      {
        kind: 'command',
        command,
        criterion: 'Documentation matches the implementation.'
      },
      {
        kind: 'manual',
        instructions: 'Inspect the documentation.'
      }
    ])).toEqual([]);
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
      async plan(input: PlanInput): Promise<PlanResult> {
        if (input.validationFailure) {
          return {
            summary: 'The validation command is correct and the implementation marker must be repaired.',
            steps: [],
            acceptanceCriteria: [],
            validationChecks: [],
            validationRecovery: {
              action: 'repair_implementation',
              rationale: 'The command correctly detected invalid repository content.'
            }
          };
        }
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
    expect(attempts[1]?.previousValidationError).toContain('Exit code: 1');
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

  it('completes an already-satisfied task only after independent evidence review', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-already-satisfied-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'existing proof\n', 'utf8');
    const existingGit = simpleGit({ baseDir: workspacePath });
    await existingGit.init();
    await existingGit.addConfig('user.name', 'Test');
    await existingGit.addConfig('user.email', 'test@example.com');
    await existingGit.add('.');
    await existingGit.commit('Existing implementation');
    const review = vi.fn(async (input: ReviewInput): Promise<ReviewResult> => ({
      summary: 'Independent review confirmed the existing implementation.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: [],
      criterionResults: [{
        criterion: 'Validation passes',
        status: 'satisfied',
        evidence: ['status.txt contains the existing implementation and validation passed.']
      }]
    }));
    const implement = vi.fn(async (): Promise<ImplementResult> => ({
      outcome: 'already_satisfied',
      summary: 'Existing implementation and tests already satisfy the task.',
      changedFiles: [],
      evidenceFiles: ['status.txt'],
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      requestedApprovals: [],
      validationChecks: [{ kind: 'command', command: 'node --version', category: 'smoke' }]
    }));
    const provider = createProviderStub({ implement, review });
    const statuses: string[] = [];

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider,
      workspaceRoot,
      hooks: {
        onStatus: async (status) => {
          statuses.push(status);
        }
      }
    });

    expect(result.status).toBe('completed');
    expect(result.validation.passed).toBe(true);
    expect(result.summary).toContain('Independent review confirmed');
    expect(implement).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      taskPrompt: task.prompt,
      reviewMode: 'existing_state',
      changedFiles: ['status.txt'],
      repositoryEvidence: expect.stringContaining('existing proof')
    }));
    expect(statuses).toContain('reviewing');
  });

  it('resumes an already-satisfied implementation without invoking implementation again', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-already-satisfied-validation-resume-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'existing proof\n', 'utf8');
    const existingGit = simpleGit({ baseDir: workspacePath });
    await existingGit.init();
    await existingGit.addConfig('user.name', 'Test');
    await existingGit.addConfig('user.email', 'test@example.com');
    await existingGit.add('.');
    await existingGit.commit('Existing implementation');
    const implement = vi.fn(async () => {
      throw new Error('Implementation must not be repeated.');
    });
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Resumed existing state verified.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: [],
      criterionResults: [{ criterion: 'Validation passes', status: 'satisfied', evidence: ['status.txt'] }]
    }));

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider: createProviderStub({ implement, review }),
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'validation',
        implementationSummary: 'Existing implementation.',
        implementationOutcome: 'already_satisfied',
        evidenceFiles: ['status.txt'],
        diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
        acceptanceCriteria: ['Validation passes'],
        validationChecks: [{ kind: 'command', command: 'node --version', category: 'smoke' }]
      }
    });

    expect(result.status).toBe('completed');
    expect(implement).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ reviewMode: 'existing_state' }));
  });

  it('reuses a completed already-satisfied audit only while the workspace hash is unchanged', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-already-satisfied-resume-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'existing proof\n', 'utf8');
    const existingGit = simpleGit({ baseDir: workspacePath });
    await existingGit.init();
    await existingGit.addConfig('user.name', 'Test');
    await existingGit.addConfig('user.email', 'test@example.com');
    await existingGit.add('.');
    await existingGit.commit('Existing implementation');
    const validationInputHash = createHash('sha256').digest('hex');
    const repositoryStateHash = createHash('sha256')
      .update((await existingGit.revparse(['HEAD^{tree}'])).trim())
      .update('\0')
      .update(validationInputHash)
      .digest('hex');
    const inputHash = createHash('sha256').update(JSON.stringify({
      repositoryStateHash,
      taskPrompt: task.prompt,
      acceptanceCriteria: ['Validation passes'],
      evidenceFiles: ['status.txt']
    })).digest('hex');
    const provider = createProviderStub({
      implement: vi.fn(async () => {
        throw new Error('Implementation must not be repeated.');
      }),
      review: vi.fn(async () => {
        throw new Error('Review must not be repeated.');
      })
    });

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider,
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'review',
        implementationSummary: 'Existing implementation.',
        evidenceFiles: ['status.txt'],
        acceptanceCriteria: ['Validation passes'],
        validation: { command: 'node --version', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
        completedSatisfactionReview: {
          inputHash,
          summary: 'Existing state independently verified.',
          criterionResults: [{ criterion: 'Validation passes', status: 'satisfied', evidence: ['status.txt'] }]
        }
      }
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Existing state independently verified.');
    expect(provider.implement).not.toHaveBeenCalled();
    expect(provider.review).not.toHaveBeenCalled();
  });

  it('returns insufficient already-satisfied evidence to implementation with exact blockers', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-already-satisfied-repair-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'status.txt'), 'incomplete\n', 'utf8');
    const existingGit = simpleGit({ baseDir: workspacePath });
    await existingGit.init();
    await existingGit.addConfig('user.name', 'Test');
    await existingGit.addConfig('user.email', 'test@example.com');
    await existingGit.add('.');
    await existingGit.commit('Incomplete implementation');

    const implement = vi.fn(async (input: ImplementInput): Promise<ImplementResult> => input.attemptNumber === 1
      ? {
          outcome: 'already_satisfied',
          summary: 'Claimed existing implementation.',
          changedFiles: [],
          evidenceFiles: ['status.txt'],
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          requestedApprovals: [],
          validationChecks: [{ kind: 'command', command: 'node --version', category: 'smoke' }]
        }
      : {
          outcome: 'changes_made',
          summary: 'Implemented the missing behavior.',
          changedFiles: ['status.txt'],
          evidenceFiles: [],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
          requestedApprovals: [],
          validationChecks: [{ kind: 'command', command: 'node --version', category: 'smoke' }],
          fileUpdates: [{ path: 'status.txt', content: 'complete\n' }]
        });
    const review = vi.fn(async (input: ReviewInput): Promise<ReviewResult> => input.reviewMode === 'existing_state'
      ? {
          summary: 'The supplied file does not prove the criterion.',
          blockers: [],
          safeImprovements: [],
          riskyChanges: [],
          criterionResults: [{ criterion: 'Validation passes', status: 'insufficient_evidence', evidence: [] }]
        }
      : { summary: 'Correction passed review.', blockers: [], safeImprovements: [], riskyChanges: [] });

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider: createProviderStub({ implement, review }),
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(implement).toHaveBeenCalledTimes(2);
    expect(implement.mock.calls[1]?.[0].previousReviewBlockers).toContain(
      'Acceptance criterion is insufficient_evidence: Validation passes'
    );
    expect(review).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('reports actual diff stats for newly created untracked files', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-untracked-diff-${randomUUID()}`);
    const implementationDiffStats: Array<{ filesChanged?: number; insertions?: number; deletions?: number }> = [];
    const reviewInputs: ReviewInput[] = [];
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
        reviewInputs.push(_input);
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
    expect(reviewInputs[0]?.diff).toContain('diff --git a/src/App.tsx b/src/App.tsx');
    expect(reviewInputs[0]?.diff).not.toContain('diff --git a/src/app.tsx b/src/app.tsx');
  }, 10000);

  it('excludes dependency and build output directories from diff metrics and review', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-generated-output-diff-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}` };
    const review = vi.fn(async (): Promise<ReviewResult> => ({
      summary: 'Review passed.',
      blockers: [],
      safeImprovements: [],
      riskyChanges: []
    }));
    const diffStats: ImplementResult['diffStat'][] = [];
    const implement = vi.fn(async (input: ImplementInput): Promise<ImplementResult> => {
      await mkdir(join(input.repositoryPath, 'node_modules', 'yaml'), { recursive: true });
      await writeFile(join(input.repositoryPath, 'node_modules', 'yaml', 'index.js'), 'generated\n', 'utf8');
      await mkdir(join(input.repositoryPath, 'out', 'build', 'test'), { recursive: true });
      await writeFile(join(input.repositoryPath, 'out', 'build', 'test', 'artifact.txt'), 'generated\n', 'utf8');
      await mkdir(join(input.repositoryPath, 'build-jsbsim-acceptance', '_deps', 'jsbsim'), { recursive: true });
      await writeFile(join(input.repositoryPath, 'build-jsbsim-acceptance', 'CMakeCache.txt'), 'generated\n', 'utf8');
      await writeFile(join(input.repositoryPath, 'build-jsbsim-acceptance', '_deps', 'jsbsim', 'artifact.o'), 'generated\n', 'utf8');
      return {
        summary: 'Created one source file.',
        changedFiles: ['src/result.ts'],
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        requestedApprovals: [],
        fileUpdates: [{ path: 'src/result.ts', content: 'export const result = true;\n' }]
      };
    });

    const result = await runWorkerTask({
      project: demoProject,
      task,
      provider: createProviderStub({ implement, review }),
      verifyCommand: 'node --version',
      workspaceRoot,
      hooks: {
        onIteration: async (iteration) => {
          if (iteration.phase === 'implementation') diffStats.push(iteration.diffStat as ImplementResult['diffStat']);
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(diffStats[0]).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      changedFiles: ['src/result.ts'],
      diff: expect.not.stringContaining('node_modules')
    }));
    const firstReviewInput = (review.mock.calls as unknown as Array<[ReviewInput]>)[0]?.[0];
    expect(firstReviewInput?.diff).not.toContain('out/build');
    expect(firstReviewInput?.changedFiles).not.toContain('build-jsbsim-acceptance/CMakeCache.txt');
    expect(firstReviewInput?.diff).not.toContain('build-jsbsim-acceptance');
    const committedFiles = (await simpleGit({ baseDir: join(workspaceRoot, task.id) }).show([
      '--name-only',
      '--format=',
      'HEAD'
    ])).split(/\r?\n/).filter(Boolean);
    expect(committedFiles).toEqual(['src/result.ts']);
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

  it('includes committed task-branch changes in every correction review packet', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-cumulative-review-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    const git = simpleGit({ baseDir: workspacePath });
    await git.init();
    await git.addConfig('user.name', 'ForgeMind Test');
    await git.addConfig('user.email', 'forgemind-test@example.com');
    await writeFile(join(workspacePath, 'base.txt'), 'base\n', 'utf8');
    await git.add('.');
    await git.commit('Base');
    await git.raw(['branch', 'main', 'HEAD']);
    await git.checkoutLocalBranch('ai/task-review');
    await mkdir(join(workspacePath, '.github', 'workflows'), { recursive: true });
    await writeFile(join(workspacePath, '.github', 'workflows', 'native-soak.yml'), 'name: Native soak\n', 'utf8');
    await git.add('.');
    await git.commit('Add soak workflow');
    await writeFile(join(workspacePath, 'validator.mjs'), 'export const valid = true;\n', 'utf8');

    const reviewInputs: ReviewInput[] = [];
    const review = vi.fn(async (input: ReviewInput): Promise<ReviewResult> => {
      reviewInputs.push(input);
      return {
        summary: 'Cumulative review passed.',
        blockers: [],
        safeImprovements: [],
        riskyChanges: []
      };
    });
    const implement = vi.fn(async (): Promise<ImplementResult> => ({
      outcome: 'already_satisfied',
      summary: 'The branch already contains the requested workflow.',
      changedFiles: [],
      evidenceFiles: ['.github/workflows/native-soak.yml', 'validator.mjs'],
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      requestedApprovals: [],
      validationChecks: [{ kind: 'command', command: 'node --version' }]
    }));

    const result = await runWorkerTask({
      project: {
        ...demoProject,
        defaultBranch: 'main',
        configYaml: noGitProjectConfig.replace('create_branch: false', 'create_branch: true')
      },
      task: { ...task, branchName: 'ai/task-review' },
      provider: createProviderStub({ implement, review }),
      github: createGitHubStub(),
      verifyCommand: 'node --version',
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'implementation',
        attempt: 2,
        implementationSummary: 'Previous implementation.',
        previousReviewBlockers: ['Review did not see committed task changes.'],
        validationChecks: [{ kind: 'command', command: 'node --version' }]
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(reviewInputs).toHaveLength(1);
    expect(reviewInputs[0]?.changedFiles).toEqual(expect.arrayContaining([
      '.github/workflows/native-soak.yml',
      'validator.mjs'
    ]));
    expect(reviewInputs[0]?.diff).toContain('native-soak.yml');
    expect(reviewInputs[0]?.diff).toContain('validator.mjs');
  }, 15000);

  it('reviews the final corrected file instead of a stale committed version plus an overlay', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-worker-final-correction-review-${randomUUID()}`);
    const task = { ...demoTask, id: `task_${randomUUID()}`, maxIterations: 2 };
    const workspacePath = join(workspaceRoot, task.id);
    await mkdir(workspacePath, { recursive: true });
    const git = simpleGit({ baseDir: workspacePath });
    await git.init();
    await git.addConfig('user.name', 'ForgeMind Test');
    await git.addConfig('user.email', 'forgemind-test@example.com');
    await writeFile(join(workspacePath, 'base.txt'), 'base\n', 'utf8');
    await git.add('.');
    await git.commit('Base');
    await git.raw(['branch', 'main', 'HEAD']);
    await git.checkoutLocalBranch('ai/task-final-review');
    await writeFile(join(workspacePath, 'compatibility.cpp'), 'reject legacy data\n', 'utf8');
    await git.add('.');
    await git.commit('Initial incompatible implementation');
    await writeFile(join(workspacePath, 'compatibility.cpp'), 'accept legacy data safely\n', 'utf8');

    const reviewInputs: ReviewInput[] = [];
    const result = await runWorkerTask({
      project: {
        ...demoProject,
        defaultBranch: 'main',
        configYaml: noGitProjectConfig.replace('create_branch: false', 'create_branch: true')
      },
      task: { ...task, branchName: 'ai/task-final-review' },
      provider: createProviderStub({
        implement: vi.fn(async (): Promise<ImplementResult> => ({
          summary: 'The preserved correction resolves the compatibility blocker.',
          changedFiles: ['compatibility.cpp'],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
          requestedApprovals: [],
          validationChecks: [{ kind: 'command', command: 'node --version' }]
        })),
        review: vi.fn(async (reviewInput: ReviewInput): Promise<ReviewResult> => {
          reviewInputs.push(reviewInput);
          return { summary: 'Final state passed review.', blockers: [], safeImprovements: [], riskyChanges: [] };
        })
      }),
      github: createGitHubStub(),
      verifyCommand: 'node --version',
      workspaceRoot,
      resume: {
        kind: 'phase_retry',
        resumeFrom: 'implementation',
        attempt: 2,
        implementationSummary: 'Initial implementation failed review.',
        previousReviewBlockers: ['Preserve compatibility with legacy data.'],
        validationChecks: [{ kind: 'command', command: 'node --version' }]
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(reviewInputs).toHaveLength(1);
    expect(reviewInputs[0]?.diff).toContain('+accept legacy data safely');
    expect(reviewInputs[0]?.diff).not.toContain('+reject legacy data');
    expect((reviewInputs[0]?.diff.match(/diff --git/g) ?? [])).toHaveLength(1);
  }, 15000);

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
      async plan(input: PlanInput): Promise<PlanResult> {
        if (input.validationFailure) {
          return {
            summary: 'Repair the implementation detected by the configured validation command.',
            steps: [],
            acceptanceCriteria: [],
            validationChecks: [],
            validationRecovery: {
              action: 'repair_implementation',
              rationale: 'The validation command correctly detected the failed implementation state.'
            }
          };
        }
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
    expect(createdPrs[0]?.body).toContain('Validation retry before attempt 2:');
    expect(createdPrs[0]?.body).toContain('Exit code: 1');
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
