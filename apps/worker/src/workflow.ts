import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalType, ForgeTask, IterationPhase, Project, ProviderKind, TaskStatus } from '@forgemind/core';
import {
  MockGitHubAdapter,
  createAiBranchName,
  renderIssueBody,
  renderPullRequestBody,
  type GitHubAdapter
} from '@forgemind/github';
import { createProvider, type AIProvider } from '@forgemind/providers';
import { nowIso, type JsonValue } from '@forgemind/shared';
import { runValidationCommand, type ValidationResult } from './validation.js';

export interface WorkerTaskInput {
  project: Project;
  task: ForgeTask;
  providerKind?: ProviderKind;
  workspaceRoot?: string;
  verifyCommand?: string;
  provider?: AIProvider;
  github?: GitHubAdapter;
  hooks?: WorkerTaskHooks;
}

export interface WorkerTaskHooks {
  onStatus?: (status: TaskStatus, payload?: JsonValue) => Promise<void>;
  onIssue?: (issue: { issueNumber: number; issueUrl: string }) => Promise<void>;
  onBranch?: (branchName: string) => Promise<void>;
  onPullRequest?: (pullRequest: { pullRequestNumber: number; pullRequestUrl: string }) => Promise<void>;
  onIteration?: (iteration: {
    phase: IterationPhase;
    prompt: string;
    resultSummary: string;
    diffStat: JsonValue;
    validationResult: JsonValue;
  }) => Promise<void>;
}

export interface WorkerTaskResult {
  taskId: string;
  status: 'ready_for_user_review' | 'needs_approval' | 'validation_failed';
  issueUrl: string;
  branchName: string;
  pullRequestUrl?: string;
  workspacePath: string;
  validation: ValidationResult;
  summary: string;
  approvals: ApprovalType[];
  completedAt: string;
}

export async function runWorkerTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
  const provider = input.provider ?? createProvider(input.providerKind ?? 'mock');
  const github = input.github ?? new MockGitHubAdapter();
  const workspacePath = join(input.workspaceRoot ?? join(process.cwd(), '.forgemind', 'workspaces'), input.task.id);

  await mkdir(workspacePath, { recursive: true });

  await input.hooks?.onStatus?.('creating_github_issue');
  const issue = await github.createIssue({
    project: input.project,
    task: input.task,
    labels: ['ai-task']
  });
  await input.hooks?.onIssue?.(issue);

  const branchName = createAiBranchName(issue.issueNumber, input.task.title);
  await input.hooks?.onStatus?.('creating_branch', { branchName });
  await github.createBranch(input.project, branchName, input.project.defaultBranch);
  await input.hooks?.onBranch?.(branchName);

  await input.hooks?.onStatus?.('running_ai');
  const plan = await provider.plan({
    taskId: input.task.id,
    title: input.task.title,
    prompt: input.task.prompt,
    repositoryPath: workspacePath
  });
  await input.hooks?.onIteration?.({
    phase: 'planning',
    prompt: input.task.prompt,
    resultSummary: plan.summary,
    diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
    validationResult: { passed: true }
  });

  const implementation = await provider.implement({
    taskId: input.task.id,
    prompt: input.task.prompt,
    plan,
    repositoryPath: workspacePath
  });
  await input.hooks?.onIteration?.({
    phase: 'implementation',
    prompt: input.task.prompt,
    resultSummary: implementation.summary,
    diffStat: implementation.diffStat,
    validationResult: { passed: true }
  });

  await writeFile(
    join(workspacePath, 'MOCK_IMPLEMENTATION.md'),
    [
      `# ${input.task.title}`,
      '',
      implementation.summary,
      '',
      '## Plan',
      ...plan.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      `Generated at: ${nowIso()}`
    ].join('\n'),
    'utf8'
  );

  if (implementation.requestedApprovals.length > 0) {
    return {
      taskId: input.task.id,
      status: 'needs_approval',
      issueUrl: issue.issueUrl,
      branchName,
      workspacePath,
      validation: {
        command: input.verifyCommand ?? '',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: implementation.summary,
      approvals: implementation.requestedApprovals,
      completedAt: nowIso()
    };
  }

  await input.hooks?.onStatus?.('validating');
  const validation = await runValidationCommand(input.verifyCommand ?? 'node --version', workspacePath);
  await input.hooks?.onIteration?.({
    phase: 'validation',
    prompt: validation.command,
    resultSummary: validation.passed ? 'Validation passed.' : 'Validation failed.',
    diffStat: implementation.diffStat,
    validationResult: {
      command: validation.command,
      exitCode: validation.exitCode,
      stdout: validation.stdout,
      stderr: validation.stderr,
      passed: validation.passed
    }
  });
  if (!validation.passed) {
    return {
      taskId: input.task.id,
      status: 'validation_failed',
      issueUrl: issue.issueUrl,
      branchName,
      workspacePath,
      validation,
      summary: 'Validation command failed.',
      approvals: [],
      completedAt: nowIso()
    };
  }

  await input.hooks?.onStatus?.('reviewing');
  const review = await provider.review({
    taskId: input.task.id,
    repositoryPath: workspacePath,
    changedFiles: implementation.changedFiles
  });
  await input.hooks?.onIteration?.({
    phase: 'review',
    prompt: `Review ${implementation.changedFiles.join(', ')}`,
    resultSummary: review.summary,
    diffStat: implementation.diffStat,
    validationResult: { blockers: review.blockers, riskyChanges: review.riskyChanges }
  });

  await github.commitAndPush(input.project, branchName, `AI: ${input.task.title}`);

  const pullRequestBody = renderPullRequestBody({
    summary: `${implementation.summary}\n\n${review.summary}`,
    acceptanceCriteria: plan.acceptanceCriteria,
    tests: [`${validation.command}: exit ${validation.exitCode}`],
    risks: review.blockers.length > 0 ? review.blockers : ['Mock workflow does not change the target repository yet.'],
    usage: 'MockProvider cost: 0 USD'
  });

  await input.hooks?.onStatus?.('creating_pr');
  const pr = await github.createDraftPullRequest({
    project: input.project,
    task: {
      ...input.task,
      branchName
    },
    title: `[AI] ${input.task.title}`,
    body: pullRequestBody
  });
  await input.hooks?.onPullRequest?.(pr);

  await github.commentOnIssue(input.project, issue.issueNumber, renderIssueBody(input.task));

  return {
    taskId: input.task.id,
    status: 'ready_for_user_review',
    issueUrl: issue.issueUrl,
    branchName,
    pullRequestUrl: pr.pullRequestUrl,
    workspacePath,
    validation,
    summary: review.summary,
    approvals: review.riskyChanges,
    completedAt: nowIso()
  };
}
