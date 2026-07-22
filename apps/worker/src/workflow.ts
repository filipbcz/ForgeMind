import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { ApprovalType, ForgeTask, IterationPhase, Project, ProviderKind, TaskMode, TaskStatus } from '@forgemind/core';
import {
  createAiBranchName,
  renderIssueBody,
  renderPullRequestBody,
  slugifyBranchSegment,
  type GitHubAdapter
} from '@forgemind/github';
import { createProvider, type AIProvider, type ImplementResult, type PlanResult, type ValidationCheck } from '@forgemind/providers';
import { parseAgentConfigYaml, type AgentConfig } from '@forgemind/config';
import { nowIso, toErrorMessage, type JsonValue } from '@forgemind/shared';
import { runValidationChecks, type ValidationResult } from './validation.js';

export interface WorkerTaskInput {
  project: Project;
  task: ForgeTask;
  providerKind?: ProviderKind;
  workspaceRoot?: string;
  verifyCommand?: string;
  usageSummary?: string;
  provider?: AIProvider;
  github?: GitHubAdapter;
  resume?: WorkerTaskResume;
  hooks?: WorkerTaskHooks;
}

type GitHubOperation = 'create_issue' | 'create_branch' | 'commit_and_push' | 'create_draft_pr' | 'create_pull_request' | 'merge_pr' | 'comment_on_issue';

export interface WorkerTaskResume {
  kind: 'approved_large_diff' | 'approved_review';
  planSummary?: string;
  implementationSummary: string;
  reviewSummary?: string;
  riskyChanges?: ApprovalType[];
  validationChecks?: ValidationCheck[];
  approvedApprovals?: ApprovalType[];
}

export interface WorkerTaskHooks {
  onStatus?: (status: TaskStatus, payload?: JsonValue) => Promise<void>;
  onIssue?: (issue: { issueNumber: number; issueUrl: string }) => Promise<void>;
  onBranch?: (branchName: string) => Promise<void>;
  onPullRequest?: (pullRequest: { pullRequestNumber: number; pullRequestUrl: string }) => Promise<void>;
  onGitHubOperationFailed?: (failure: { operation: GitHubOperation; errorMessage: string; context?: JsonValue }) => Promise<void>;
  onProviderActivity?: (activity: {
    phase: IterationPhase;
    attempt: number;
    kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace';
    message: string;
    elapsedMs: number;
  }) => Promise<void>;
  onIterationStarted?: (iteration: {
    phase: IterationPhase;
    prompt: string;
    providerPrompt?: string;
    attempt: number;
  }) => Promise<void>;
  onIteration?: (iteration: {
    phase: IterationPhase;
    prompt: string;
    resultSummary: string;
    providerPrompt?: string;
    providerResponse?: string;
    diffStat: JsonValue;
    validationResult: JsonValue;
  }) => Promise<void>;
}

export interface WorkerTaskResult {
  taskId: string;
  status: 'ready_for_user_review' | 'completed' | 'needs_approval' | 'validation_failed' | 'failed';
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
  const config = resolveWorkerConfig(input.project, input);
  const provider = input.provider ?? createProvider(config.providerKind);
  const github = input.github;
  if ((config.createIssue || config.createBranch || config.createPullRequest || config.autoPush) && !github) {
    throw new Error('GitHub adapter is required for the configured workflow.');
  }
  const workspacePath = join(input.workspaceRoot ?? join(process.cwd(), '.forgemind', 'workspaces'), input.task.id);

  await mkdir(workspacePath, { recursive: true });

  const usageSummary = input.usageSummary ?? formatUsageSummary(await provider.estimateCost({ prompt: input.task.prompt, repositorySizeHint: 'small' }));

  const existingIssue = resolveExistingTaskIssue(input.task);
  let issue = existingIssue ?? { issueNumber: 0, issueUrl: '' };
  if (config.createIssue) {
    await input.hooks?.onStatus?.('creating_github_issue', existingIssue ? { ...existingIssue, reused: true } : undefined);
    if (!existingIssue) {
      issue = await runGitHubOperation(input.hooks, 'create_issue', { taskId: input.task.id }, async () => {
        return github!.createIssue({
          project: input.project,
          task: input.task,
          labels: [config.issueLabel]
        });
      });
      await input.hooks?.onIssue?.(issue);
    }
  }

  const existingBranchName = config.createBranch && typeof input.task.branchName === 'string' && input.task.branchName.trim().length > 0
    ? input.task.branchName.trim()
    : undefined;
  const branchName = existingBranchName
    ?? (config.createBranch
      ? (issue.issueNumber > 0
          ? createAiBranchName(issue.issueNumber, input.task.title, config.branchPrefix)
          : `${config.branchPrefix}no-issue-${slugifyBranchSegment(input.task.title)}`)
      : input.project.defaultBranch);
  await input.hooks?.onStatus?.('creating_branch', { branchName, reused: Boolean(existingBranchName) });

  const remoteUrl = github ? resolveGitRemoteUrl(github, input.project) : process.env.FORGEMIND_GITHUB_REMOTE_URL;
  const reuseExistingWorkspaceRepo = Boolean(input.resume) && await hasExistingWorkspaceRepo(workspacePath);
  if (config.createBranch && !existingBranchName) {
    await runGitHubOperation(
      input.hooks,
      'create_branch',
      { branchName, fromBranch: input.project.defaultBranch },
      async () => github!.createBranch(input.project, branchName, input.project.defaultBranch)
    );
  }
  const git = await prepareWorkspaceGit(workspacePath, branchName, input.project.defaultBranch, reuseExistingWorkspaceRepo ? undefined : remoteUrl, {
    skipRemoteFetchForExistingRepo: Boolean(input.resume)
  });
  await input.hooks?.onBranch?.(branchName);

  const isResumeRun = Boolean(input.resume);
  await input.hooks?.onStatus?.('running_ai', isResumeRun && input.resume ? { resumed: true, kind: input.resume.kind } : undefined);
  await writeAgentsInstructions(workspacePath, input.project, input.task, input.project.configYaml);
  let plan = input.resume
    ? createResumePlan(input.resume)
    : await (async () => {
        await input.hooks?.onIterationStarted?.({
          phase: 'planning',
          prompt: input.task.prompt,
          attempt: 0
        });
        return provider.plan({
          taskId: input.task.id,
          title: input.task.title,
          prompt: input.task.prompt,
          repositoryPath: workspacePath,
          onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'planning', attempt: 0, ...activity })
        });
      })();
  let validationChecks = await resolveValidationChecks({
    plan,
    explicitVerifyCommand: config.verifyCommand,
    workspacePath
  });
  if (!input.resume) {
    await input.hooks?.onIteration?.({
      phase: 'planning',
      prompt: input.task.prompt,
      resultSummary: plan.summary,
      providerPrompt: plan.providerPrompt,
      providerResponse: plan.providerResponse,
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      validationResult: { passed: true, validationChecks }
    });
  }

  let implementation: ImplementResult | undefined;
  let validation: ValidationResult | undefined;
  let resumedImplementation =
    input.resume
      ? await loadResumedImplementation(git, workspacePath, input.resume.implementationSummary)
      : undefined;
  const retryReasons: string[] = [];
  const appliedSafeImprovements = new Set<string>();
  const resolvedReviewBlockers = new Set<string>();
  const approvedApprovals = new Set(normalizeRuntimeApprovals(input.resume?.approvedApprovals ?? []));
  let completedAttempts = 0;
  const verifyCommandApprovals = evaluateRuntimeApprovals(
    computeVerifyCommandApprovals(validationChecks, config.sandbox),
    config.mode,
    config.approvalRequiredFor,
    config.allowSafeOperationsWithoutApproval
  );
  if (verifyCommandApprovals.length > 0) {
    return {
      taskId: input.task.id,
      status: 'needs_approval',
      issueUrl: issue.issueUrl,
      branchName,
      workspacePath,
      validation: {
        command: summarizeValidationChecks(validationChecks),
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: `Verification command is blocked by sandbox policy: ${summarizeValidationChecks(validationChecks)}`,
      approvals: verifyCommandApprovals,
      completedAt: nowIso()
    };
  }
  let review:
    | {
      summary: string;
      blockers: string[];
      safeImprovements: string[];
      riskyChanges: ApprovalType[];
      providerPrompt?: string;
      providerResponse?: string;
      }
    | undefined;

  for (let attempt = 1; attempt <= input.task.maxIterations; attempt += 1) {
    completedAttempts = attempt;
    await input.hooks?.onIterationStarted?.({
      phase: 'implementation',
      prompt: input.task.prompt,
      attempt
    });
    const isResumedImplementation = Boolean(resumedImplementation);
    implementation = resumedImplementation
      ?? await provider.implement({
        taskId: input.task.id,
        prompt: input.task.prompt,
        plan,
        repositoryPath: workspacePath,
        attemptNumber: attempt,
        previousValidationError: validation && !validation.passed ? validation.stderr || validation.stdout || `Exit code ${validation.exitCode}` : undefined,
        previousReviewBlockers: review?.blockers.length ? review.blockers : undefined,
        previousSafeImprovements: review?.safeImprovements.length ? review.safeImprovements : undefined,
        onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'implementation', attempt, ...activity })
      });
    resumedImplementation = undefined;

    implementation = applyImplementationPolicy(implementation, workspacePath, config.sandbox);

    const implementationApprovals = filterApprovedApprovals(
      evaluateRuntimeApprovals(implementation.requestedApprovals, config.mode, config.approvalRequiredFor, config.allowSafeOperationsWithoutApproval),
      approvedApprovals
    );
    if (implementationApprovals.length > 0) {
      return {
        taskId: input.task.id,
        status: 'needs_approval',
        issueUrl: issue.issueUrl,
        branchName,
        workspacePath,
        validation: {
          command: summarizeValidationChecks(validationChecks),
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: implementation.summary,
        approvals: implementationApprovals,
        completedAt: nowIso()
      };
    }

    await writeProviderFiles(workspacePath, implementation);

    const implementationStatus = await git.status();
    const implementationChangedFiles = collectStageablePaths(implementationStatus);
    const substantiveChangedFiles = implementationChangedFiles.filter(isSubstantiveImplementationPath);
    const actualDiffStat = await collectWorkspaceDiffStat(git, workspacePath, implementationStatus);
    implementation = {
      ...implementation,
      changedFiles: uniqueStrings([...implementation.changedFiles, ...substantiveChangedFiles]).filter(isSubstantiveImplementationPath),
      diffStat: actualDiffStat
    };

    const changedPathApprovals = filterApprovedApprovals(
      evaluateRuntimeApprovals(
        computeChangedPathApprovals(implementationStatus, config.sandbox),
        config.mode,
        config.approvalRequiredFor,
        config.allowSafeOperationsWithoutApproval
      ),
      approvedApprovals
    );
    if (changedPathApprovals.length > 0) {
      return {
        taskId: input.task.id,
        status: 'needs_approval',
        issueUrl: issue.issueUrl,
        branchName,
        workspacePath,
        validation: {
          command: summarizeValidationChecks(validationChecks),
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: implementation.summary,
        approvals: changedPathApprovals,
        completedAt: nowIso()
      };
    }

    if (!isResumedImplementation) {
      await input.hooks?.onIteration?.({
        phase: 'implementation',
        prompt: input.task.prompt,
        resultSummary: implementation.summary,
        providerPrompt: implementation.providerPrompt,
        providerResponse: implementation.providerResponse,
        diffStat: implementation.diffStat,
        validationResult: {
          passed: substantiveChangedFiles.length > 0,
          attempt,
          changedFiles: substantiveChangedFiles
        }
      });
    }

    if (substantiveChangedFiles.length === 0) {
      validation = {
        command: 'implementation-changes',
        exitCode: 1,
        stdout: '',
        stderr: 'Provider did not create or modify any task files.',
        passed: false
      };
      await input.hooks?.onStatus?.('validating', { attempt });
      await input.hooks?.onIteration?.({
        phase: 'validation',
        prompt: validation.command,
        resultSummary: 'Implementation produced no task file changes.',
        diffStat: implementation.diffStat,
        validationResult: {
          command: validation.command,
          exitCode: validation.exitCode,
          stdout: validation.stdout,
          stderr: validation.stderr,
          passed: validation.passed,
          attempt
        }
      });

      if (attempt === input.task.maxIterations) {
        return {
          taskId: input.task.id,
          status: 'validation_failed',
          issueUrl: issue.issueUrl,
          branchName,
          workspacePath,
          validation,
          summary: 'Provider did not create or modify any task files.',
          approvals: [],
          completedAt: nowIso()
        };
      }

      retryReasons.push(`Implementation retry before attempt ${attempt + 1}: ${validation.stderr}`);
      await input.hooks?.onStatus?.('running_ai', {
        attempt: attempt + 1,
        retryReason: validation.stderr
      });
      continue;
    }

    await input.hooks?.onStatus?.('validating', { attempt });
    await input.hooks?.onIterationStarted?.({
      phase: 'validation',
      prompt: summarizeValidationChecks(validationChecks),
      attempt
    });
      validation = await runValidationChecks(validationChecks, workspacePath);
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
        passed: validation.passed,
        attempt
      }
    });

    if (validation.passed) {
      if (input.resume?.kind === 'approved_review') {
        await input.hooks?.onStatus?.('reviewing', { attempt, resumed: true, kind: input.resume.kind });
        review = {
          summary: input.resume.reviewSummary ?? 'Previously approved review resumed.',
          blockers: [],
          safeImprovements: [],
          riskyChanges: normalizeRuntimeApprovals(input.resume.riskyChanges ?? [])
        };
        break;
      }

      await input.hooks?.onStatus?.('reviewing', { attempt });
      await input.hooks?.onIterationStarted?.({
        phase: 'review',
        prompt: `Review ${implementation.changedFiles.join(', ')}`,
        attempt
      });
      let providerReview;
      try {
        const reviewPromise = provider.review({
            taskId: input.task.id,
            repositoryPath: workspacePath,
            changedFiles: implementation.changedFiles,
            onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'review', attempt, ...activity })
          });
        providerReview = provider.kind === 'codex' && process.env.FORGEMIND_REVIEW_TIMEOUT_MS === undefined
          ? await reviewPromise
          : await withTimeout(
              reviewPromise,
              resolveReviewTimeoutMs(),
              () => new Error(`Review timed out after ${resolveReviewTimeoutMs()} ms.`)
            );
      } catch (error) {
        return {
          taskId: input.task.id,
          status: 'failed',
          issueUrl: issue.issueUrl,
          branchName,
          workspacePath,
          validation,
          summary: `Review failed: ${toErrorMessage(error)}`,
          approvals: [],
          completedAt: nowIso()
        };
      }
      review = normalizeReviewAfterValidation({
        ...providerReview,
        riskyChanges: normalizeRuntimeApprovals(providerReview.riskyChanges)
      });
      await input.hooks?.onIteration?.({
        phase: 'review',
        prompt: `Review ${implementation.changedFiles.join(', ')}`,
        resultSummary: review.summary,
        providerPrompt: review.providerPrompt,
        providerResponse: review.providerResponse,
        diffStat: implementation.diffStat,
        validationResult: { blockers: review.blockers, riskyChanges: review.riskyChanges, attempt }
      });

      if (review.blockers.length === 0) {
        const reviewRiskApprovals = filterApprovedApprovals(
          evaluateRuntimeApprovals(review.riskyChanges, config.mode, config.approvalRequiredFor, config.allowSafeOperationsWithoutApproval),
          approvedApprovals
        );
        if (reviewRiskApprovals.length > 0) {
          return {
            taskId: input.task.id,
            status: 'needs_approval',
            issueUrl: issue.issueUrl,
            branchName,
            workspacePath,
            validation,
            summary: review.summary,
            approvals: reviewRiskApprovals,
            completedAt: nowIso()
          };
        }

        break;
      }

      for (const blocker of review.blockers) {
        resolvedReviewBlockers.add(blocker);
      }

      if (attempt === input.task.maxIterations) {
        return {
          taskId: input.task.id,
          status: 'failed',
          issueUrl: issue.issueUrl,
          branchName,
          workspacePath,
          validation,
          summary: `Review blocked completion after ${attempt} attempt(s): ${review.blockers.join('; ')}`,
          approvals: review.riskyChanges,
          completedAt: nowIso()
        };
      }

      await input.hooks?.onStatus?.('improving', {
        attempt: attempt + 1,
        retryReason: review.blockers.join('; ')
      });
      retryReasons.push(`Review retry before attempt ${attempt + 1}: ${review.blockers.join('; ')}`);
      await input.hooks?.onStatus?.('running_ai', {
        attempt: attempt + 1,
        retryReason: review.blockers.join('; ')
      });
      continue;
    }

    if (attempt === input.task.maxIterations) {
      return {
        taskId: input.task.id,
        status: 'validation_failed',
        issueUrl: issue.issueUrl,
        branchName,
        workspacePath,
        validation,
        summary: `Validation command failed after ${attempt} attempt(s).`,
        approvals: [],
        completedAt: nowIso()
      };
    }

    if (!config.verifyCommand?.trim()) {
      await input.hooks?.onIterationStarted?.({
        phase: 'planning',
        prompt: input.task.prompt,
        attempt: attempt + 1
      });
      plan = await provider.plan({
        taskId: input.task.id,
        title: input.task.title,
        prompt: input.task.prompt,
        repositoryPath: workspacePath,
        previousValidationError: validation.stderr || validation.stdout || `Exit code ${validation.exitCode}`,
        previousValidationChecks: validationChecks,
        onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'planning', attempt: attempt + 1, ...activity })
      });
      validationChecks = await resolveValidationChecks({
        plan,
        explicitVerifyCommand: config.verifyCommand,
        workspacePath
      });
      await input.hooks?.onIteration?.({
        phase: 'planning',
        prompt: input.task.prompt,
        resultSummary: plan.summary,
        providerPrompt: plan.providerPrompt,
        providerResponse: plan.providerResponse,
        diffStat: implementation.diffStat,
        validationResult: {
          passed: true,
          validationChecks,
          replannedAfterValidationError: true,
          attempt: attempt + 1
        }
      });
    }

    retryReasons.push(`Validation retry before attempt ${attempt + 1}: ${validation.stderr || validation.stdout || `Exit code ${validation.exitCode}`}`);
    await input.hooks?.onStatus?.('running_ai', {
      attempt: attempt + 1,
      retryReason: validation.stderr || validation.stdout || `Exit code ${validation.exitCode}`
    });
  }

  if (!implementation || !validation || !review) {
    throw new Error('Worker completed without implementation, validation, or review result.');
  }

  if (git) {
    await stageAndCommitChanges(git, `AI: ${input.task.title}`);
    if (config.autoPush) {
      await runGitHubOperation(
        input.hooks,
        'commit_and_push',
        { branchName, workspacePath },
        async () => github!.commitAndPush(input.project, branchName, `AI: ${input.task.title}`, workspacePath)
      );
    }
  }

  const pullRequestBody = renderPullRequestBody({
    summary: `${implementation.summary}\n\n${review.summary}`,
    acceptanceCriteria: plan.acceptanceCriteria,
    tests: [`${validation.command}: exit ${validation.exitCode}`],
    risks: review.blockers.length > 0 ? review.blockers : ['No additional review risks were reported by the provider.'],
    usage: usageSummary,
    validationReport: `${validation.command}: exit ${validation.exitCode}`,
    automaticImprovements: Array.from(appliedSafeImprovements),
    resolvedReviewBlockers: Array.from(resolvedReviewBlockers),
    executionNotes: [`Total implementation attempts: ${completedAttempts || 1}`, ...retryReasons]
  });

  let pr;
  if (config.createPullRequest) {
    const existingPullRequest = resolveExistingTaskPullRequest(input.task);
    await input.hooks?.onStatus?.('creating_pr', existingPullRequest ? { ...existingPullRequest, reused: true } : undefined);
    pr = existingPullRequest;
    if (!existingPullRequest) {
      pr = await runGitHubOperation(input.hooks, config.autoMergePullRequest ? 'create_pull_request' : 'create_draft_pr', { branchName }, async () => {
        return github!.createDraftPullRequest({
          project: input.project,
          task: {
            ...input.task,
            branchName
          },
          title: `[AI] ${input.task.title}`,
          body: pullRequestBody,
          draft: !config.autoMergePullRequest
        });
      });
      await input.hooks?.onPullRequest?.(pr);
    }
  }

  if (config.createIssue) {
    await runGitHubOperation(
      input.hooks,
      'comment_on_issue',
      { issueNumber: issue.issueNumber },
      async () => github!.commentOnIssue(input.project, issue.issueNumber, renderIssueBody(input.task))
    );
  }

  let mergeConfirmed = false;
  let mergeFailure: string | undefined;
  if (config.autoMergePullRequest && pr) {
    if (!github?.mergePullRequest) {
      mergeFailure = 'The configured GitHub adapter does not support pull request merge.';
    } else {
      try {
        const merge = await runGitHubOperation(
          input.hooks,
          'merge_pr',
          { pullRequestNumber: pr.pullRequestNumber, targetBranch: input.project.defaultBranch },
          async () => github.mergePullRequest!(input.project, pr!.pullRequestNumber)
        );
        mergeConfirmed = merge.merged;
        if (!merge.merged) mergeFailure = merge.message;
      } catch (error) {
        mergeFailure = toErrorMessage(error);
      }
    }
  }

  return {
    taskId: input.task.id,
    status: config.autoCompleteTask && mergeConfirmed ? 'completed' : 'ready_for_user_review',
    issueUrl: issue.issueUrl,
    branchName,
    pullRequestUrl: pr?.pullRequestUrl,
    workspacePath,
    validation,
    summary: mergeFailure
      ? `${review.summary}\n\nAutomatic merge was not completed: ${mergeFailure}`
      : review.summary,
    approvals: review.riskyChanges,
    completedAt: nowIso()
  };
}

function resolveGitRemoteUrl(github: GitHubAdapter, project: Project): string | undefined {
  return github.getRemoteUrl?.(project) ?? process.env.FORGEMIND_GITHUB_REMOTE_URL;
}

function formatUsageSummary(input: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }): string {
  return `Input tokens: ${input.inputTokens}, output tokens: ${input.outputTokens}, estimated cost: ${input.estimatedCostUsd.toFixed(4)} USD`;
}

function createResumePlan(resume: WorkerTaskResume): PlanResult {
  return {
    summary:
      resume.planSummary
      ?? (resume.kind === 'approved_review'
        ? 'Resume previously reviewed implementation after approval.'
        : 'Resume previously approved implementation.'),
    steps: [],
    acceptanceCriteria: [],
    validationChecks: normalizeValidationChecks(resume.validationChecks)
  };
}

async function resolveValidationChecks(input: {
  plan: PlanResult;
  explicitVerifyCommand?: string;
  workspacePath: string;
}): Promise<ValidationCheck[]> {
  if (input.explicitVerifyCommand?.trim()) {
    return [
      {
        kind: 'command',
        command: input.explicitVerifyCommand.trim(),
        rationale: 'Configured project validation command.'
      }
    ];
  }

  const plannedChecks = normalizeValidationChecks(input.plan.validationChecks);
  const commandChecks = plannedChecks.filter((check): check is Extract<ValidationCheck, { kind: 'command' }> => check.kind === 'command');
  if (commandChecks.length > 0) {
    return plannedChecks;
  }

  const inferredCommand = await inferValidationCommand(input.workspacePath, input.plan.acceptanceCriteria);
  if (inferredCommand) {
    return [
      {
        kind: 'command',
        command: inferredCommand,
        rationale: 'Inferred from repository context and acceptance criteria.'
      }
    ];
  }

  return [
    {
      kind: 'command',
      command: 'node --version',
      rationale: 'Fallback environment smoke check because no stronger validation command was planned.'
    }
  ];
}

function normalizeValidationChecks(value: unknown): ValidationCheck[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const checks: ValidationCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    if (item.kind === 'command' && typeof item.command === 'string' && item.command.trim()) {
      checks.push({
        kind: 'command',
        command: item.command.trim(),
        criterion: typeof item.criterion === 'string' && item.criterion.trim() ? item.criterion.trim() : undefined,
        rationale: typeof item.rationale === 'string' && item.rationale.trim() ? item.rationale.trim() : undefined
      });
      continue;
    }

    if (item.kind === 'manual' && typeof item.instructions === 'string' && item.instructions.trim()) {
      checks.push({
        kind: 'manual',
        instructions: item.instructions.trim(),
        criterion: typeof item.criterion === 'string' && item.criterion.trim() ? item.criterion.trim() : undefined,
        rationale: typeof item.rationale === 'string' && item.rationale.trim() ? item.rationale.trim() : undefined
      });
    }
  }

  return checks;
}

function summarizeValidationChecks(checks: ValidationCheck[]): string {
  const commands = checks.filter((check): check is Extract<ValidationCheck, { kind: 'command' }> => check.kind === 'command').map((check) => check.command);
  return commands.length > 0 ? commands.join(' && ') : 'manual-review';
}

async function inferValidationCommand(workspacePath: string, acceptanceCriteria: string[]): Promise<string | undefined> {
  const combinedCriteria = acceptanceCriteria.join('\n').toLowerCase();
  const packageManager = await detectPackageManager(workspacePath);
  const packageScripts = await readPackageScripts(workspacePath);

  if (/\bbuild\b/.test(combinedCriteria) && packageScripts.build) {
    return `${packageManager} run build`;
  }

  if (/\btests?\b/.test(combinedCriteria) && packageScripts.test) {
    return `${packageManager} test`;
  }

  if (packageScripts.build) {
    return `${packageManager} run build`;
  }

  if (packageScripts.test) {
    return `${packageManager} test`;
  }

  return undefined;
}

async function detectPackageManager(workspacePath: string): Promise<'npm' | 'pnpm' | 'yarn'> {
  const files: string[] = await readdir(workspacePath).catch(() => []);
  if (files.includes('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (files.includes('yarn.lock')) {
    return 'yarn';
  }
  return 'npm';
}

async function readPackageScripts(workspacePath: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(join(workspacePath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return packageJson.scripts ?? {};
  } catch {
    return {};
  }
}

function resolveExistingTaskIssue(task: ForgeTask): { issueNumber: number; issueUrl: string } | undefined {
  if (typeof task.githubIssueNumber === 'number' && task.githubIssueNumber > 0 && typeof task.githubIssueUrl === 'string' && task.githubIssueUrl.length > 0) {
    return {
      issueNumber: task.githubIssueNumber,
      issueUrl: task.githubIssueUrl
    };
  }

  if (typeof task.githubIssueUrl !== 'string' || task.githubIssueUrl.length === 0) {
    return undefined;
  }

  const issueNumber = parseGitHubArtifactNumber(task.githubIssueUrl, /\/issues\/(\d+)(?:$|[/?#])/);
  return issueNumber
    ? {
        issueNumber,
        issueUrl: task.githubIssueUrl
      }
    : undefined;
}

function resolveExistingTaskPullRequest(task: ForgeTask): { pullRequestNumber: number; pullRequestUrl: string } | undefined {
  if (typeof task.pullRequestNumber === 'number' && task.pullRequestNumber > 0 && typeof task.pullRequestUrl === 'string' && task.pullRequestUrl.length > 0) {
    return {
      pullRequestNumber: task.pullRequestNumber,
      pullRequestUrl: task.pullRequestUrl
    };
  }

  if (typeof task.pullRequestUrl !== 'string' || task.pullRequestUrl.length === 0) {
    return undefined;
  }

  const pullRequestNumber = parseGitHubArtifactNumber(task.pullRequestUrl, /\/pull\/(\d+)(?:$|[/?#])/);
  return pullRequestNumber
    ? {
        pullRequestNumber,
        pullRequestUrl: task.pullRequestUrl
      }
    : undefined;
}

function parseGitHubArtifactNumber(url: string, pattern: RegExp): number | undefined {
  const match = url.match(pattern);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function runGitHubOperation<T>(
  hooks: WorkerTaskHooks | undefined,
  operation: GitHubOperation,
  context: JsonValue | undefined,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    await hooks?.onGitHubOperationFailed?.({
      operation,
      errorMessage: toErrorMessage(error),
      context
    });
    throw error;
  }
}

interface WorkerConfig {
  providerKind: ProviderKind;
  mode: TaskMode;
  verifyCommand?: string;
  issueLabel: string;
  branchPrefix: string;
  autoPush: boolean;
  createPullRequest: boolean;
  autoMergePullRequest: boolean;
  autoCompleteTask: boolean;
  createBranch: boolean;
  createIssue: boolean;
  approvalRequiredFor: Set<ApprovalType>;
  allowSafeOperationsWithoutApproval: boolean;
  sandbox: {
    allowNetwork: boolean;
    allowSudo: boolean;
    forbiddenPaths: string[];
  };
}

function resolveWorkerConfig(project: Project, input: WorkerTaskInput): WorkerConfig {
  let config;
  try {
    config = project.configYaml ? parseAgentConfigYaml(project.configYaml) : undefined;
  } catch {
    config = undefined;
  }

  return {
    providerKind: input.providerKind ?? config?.ai.primary_provider ?? 'codex',
    mode: input.task.mode ?? config?.workflow.default_mode ?? 'safe',
    verifyCommand: input.verifyCommand ?? config?.commands.verify ?? config?.commands.build,
    issueLabel: config?.github.issue_label ?? 'ai-task',
    branchPrefix: config?.github.branch_prefix ?? 'ai/',
    autoPush: config?.workflow.auto_push ?? true,
    createPullRequest: project.autoCreatePullRequest ?? config?.workflow.create_draft_pr ?? true,
    autoMergePullRequest: project.autoMergePullRequest ?? config?.workflow.auto_merge ?? false,
    autoCompleteTask: project.autoCompleteTask ?? false,
    createBranch: config?.workflow.create_branch ?? true,
    createIssue: config?.workflow.create_issue ?? true,
    approvalRequiredFor: new Set((config?.approval.required_for ?? []).filter(isApprovalType)),
    allowSafeOperationsWithoutApproval: project.allowSafeOperationsWithoutApproval ?? false,
    sandbox: {
      allowNetwork: config?.sandbox.allow_network ?? false,
      allowSudo: config?.sandbox.allow_sudo ?? false,
      forbiddenPaths: config?.sandbox.forbidden_paths ?? []
    }
  };
}

const ALWAYS_APPROVAL_ACTIONS: ReadonlySet<ApprovalType> = new Set([
  'deploy_production',
  'deploy_staging',
  'merge_pr',
  'budget_increase',
  'write_outside_repo',
  'database_migration',
  'github_workflow_change',
  'systemd_change',
  'nginx_config_change',
  'delete_files'
]);

function isApprovalType(value: string): value is ApprovalType {
  return [
    'budget_increase',
    'continue_after_iteration_limit',
    'new_dependency',
    'risky_refactor',
    'database_migration',
    'config_change',
    'deploy_staging',
    'deploy_production',
    'merge_pr',
    'delete_files',
    'github_workflow_change',
    'systemd_change',
    'nginx_config_change',
    'write_outside_repo'
  ].includes(value);
}

function uniqueApprovals(values: ApprovalType[]): ApprovalType[] {
  return Array.from(new Set(values));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeRuntimeApprovals(values: readonly unknown[] | undefined): ApprovalType[] {
  const approvals: ApprovalType[] = [];
  for (const value of values ?? []) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    approvals.push(isApprovalType(trimmed) ? trimmed : mapApprovalReasonToType(trimmed));
  }

  return uniqueApprovals(approvals);
}

function mapApprovalReasonToType(reason: string): ApprovalType {
  const normalized = reason.toLowerCase();
  if (/\b(dependency|package|install|npm|pnpm|yarn)\b/.test(normalized)) return 'new_dependency';
  if (/\b(database|migration|schema|prisma)\b/.test(normalized)) return 'database_migration';
  if (/\b(delete|remove)\b/.test(normalized)) return 'delete_files';
  if (/\.github\/workflows|github workflow|github actions/.test(normalized)) return 'github_workflow_change';
  if (/outside (repo|repository|workspace)|external path|write outside/.test(normalized)) return 'write_outside_repo';
  if (/deploy.*production|production.*deploy/.test(normalized)) return 'deploy_production';
  if (/deploy.*staging|staging.*deploy/.test(normalized)) return 'deploy_staging';
  if (/\bmerge\b/.test(normalized)) return 'merge_pr';
  if (/\bnginx\b/.test(normalized)) return 'nginx_config_change';
  if (/\bsystemd\b/.test(normalized)) return 'systemd_change';
  if (/\bbudget\b/.test(normalized)) return 'budget_increase';
  if (/\bconfig\b|\bconfiguration\b/.test(normalized)) return 'config_change';
  return 'risky_refactor';
}

function evaluateRuntimeApprovals(
  requestedApprovals: readonly unknown[],
  mode: TaskMode,
  approvalRequiredFor: Set<ApprovalType>,
  allowSafeOperationsWithoutApproval = false
): ApprovalType[] {
  const approvals = normalizeRuntimeApprovals(requestedApprovals);
  if (approvals.length === 0) {
    return [];
  }

  if (mode === 'safe' && !allowSafeOperationsWithoutApproval) {
    return approvals;
  }

  return uniqueApprovals(approvals.filter((approval) => ALWAYS_APPROVAL_ACTIONS.has(approval) || approvalRequiredFor.has(approval)));
}

function filterApprovedApprovals(approvals: ApprovalType[], approvedApprovals: ReadonlySet<ApprovalType>): ApprovalType[] {
  if (approvedApprovals.size === 0) {
    return approvals;
  }

  return approvals.filter((approval) => !approvedApprovals.has(approval));
}

function computeVerifyCommandApprovals(
  validationChecks: ValidationCheck[],
  sandbox: {
    allowNetwork: boolean;
    allowSudo: boolean;
  }
): ApprovalType[] {
  const approvals: ApprovalType[] = [];

  for (const check of validationChecks) {
    if (check.kind !== 'command') {
      continue;
    }

    if (!sandbox.allowSudo && /(^|\s)sudo(\s|$)/i.test(check.command)) {
      approvals.push('config_change');
    }

    if (!sandbox.allowNetwork && /\b(curl|wget|invoke-webrequest|iwr|ncat|netcat|telnet)\b/i.test(check.command)) {
      approvals.push('config_change');
    }
  }

  return uniqueApprovals(approvals);
}

function applyImplementationPolicy(
  implementation: ImplementResult,
  workspacePath: string,
  sandbox: {
    forbiddenPaths: string[];
  }
): ImplementResult {
  const normalizedApprovals = normalizeRuntimeApprovals(implementation.requestedApprovals);
  if (!implementation.fileUpdates?.length) {
    return {
      ...implementation,
      requestedApprovals: normalizedApprovals
    };
  }

  const workspaceRoot = resolve(workspacePath);
  const approvals: ApprovalType[] = [...normalizedApprovals];
  const filteredUpdates = implementation.fileUpdates.filter((file) => {
    if (isAbsolute(file.path)) {
      approvals.push('write_outside_repo');
      return false;
    }

    const target = resolve(workspaceRoot, file.path);
    if (!target.startsWith(workspaceRoot)) {
      approvals.push('write_outside_repo');
      return false;
    }

    const normalized = file.path.replace(/\\/g, '/').toLowerCase();
    const touchesWorkflow = normalized.startsWith('.github/workflows/');
    if (touchesWorkflow) {
      approvals.push('github_workflow_change');
    }

    const forbiddenMatch = sandbox.forbiddenPaths.some((item) => normalized.includes(item.toLowerCase().replace(/\\/g, '/')));
    if (forbiddenMatch) {
      approvals.push('write_outside_repo');
      return false;
    }

    return true;
  });

  return {
    ...implementation,
    fileUpdates: filteredUpdates,
    requestedApprovals: uniqueApprovals(approvals)
  };
}

function computeChangedPathApprovals(
  status: StatusResult,
  sandbox: {
    forbiddenPaths: string[];
  }
): ApprovalType[] {
  const approvals: ApprovalType[] = [];

  for (const path of collectStageablePaths(status)) {
    if (isGeneratedWorkerPath(path)) {
      continue;
    }

    const normalized = normalizeRepoPath(path);
    if (normalized.startsWith('.github/workflows/')) {
      approvals.push('github_workflow_change');
    }

    const forbiddenMatch = sandbox.forbiddenPaths.some((item) => normalized.includes(item.toLowerCase().replace(/\\/g, '/')));
    if (forbiddenMatch) {
      approvals.push('write_outside_repo');
    }
  }

  for (const path of status.deleted) {
    if (!isGeneratedWorkerPath(path)) {
      approvals.push('delete_files');
    }
  }

  return uniqueApprovals(approvals);
}

function normalizeReviewAfterValidation(review: {
  summary: string;
  blockers: string[];
  safeImprovements: string[];
  riskyChanges: ApprovalType[];
}): {
  summary: string;
  blockers: string[];
  safeImprovements: string[];
  riskyChanges: ApprovalType[];
} {
  const blockers = review.blockers.filter((blocker) => !isValidationExecutionLimitationBlocker(blocker));
  return {
    ...review,
    blockers
  };
}

function isValidationExecutionLimitationBlocker(blocker: string): boolean {
  const normalized = blocker.toLowerCase();
  const mentionsVerificationGap =
    /\b(unable to verify|could not verify|cannot verify|can't verify|failed to verify)\b/.test(normalized)
    || /\b(could not run|cannot run|can't run|was blocked)\b/.test(normalized);
  const mentionsExecutionConstraint =
    /\b(read-only|readonly|sandbox|policy|environment)\b/.test(normalized)
    || /\b(node|npm|pnpm|yarn|vite|build commands?)\b/.test(normalized);

  return mentionsVerificationGap && mentionsExecutionConstraint;
}

function resolveReviewTimeoutMs(): number {
  const parsed = Number(process.env.FORGEMIND_REVIEW_TIMEOUT_MS ?? 120000);
  if (!Number.isFinite(parsed)) {
    return 120000;
  }

  return Math.max(1000, parsed);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(createError());
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function writeAgentsInstructions(workspacePath: string, project: Project, task: ForgeTask, configYaml?: string) {
  let projectConfig: AgentConfig | undefined;
  try {
    projectConfig = configYaml ? parseAgentConfigYaml(configYaml) : undefined;
  } catch {
    projectConfig = undefined;
  }

  const lines = [
    '# AGENTS.md',
    '',
    '## Project',
    `- name: ${project.name}`,
    `- repo: ${project.githubOwner && project.githubRepo ? `${project.githubOwner}/${project.githubRepo}` : 'not assigned'}`,
    `- default branch: ${project.defaultBranch}`,
    '',
    '## Task',
    `- title: ${task.title}`,
    `- prompt: ${task.prompt}`,
    `- mode: ${task.mode}`,
    `- max iterations: ${task.maxIterations}`,
    `- max budget: ${task.maxBudgetUsd} USD`,
    ''
  ];

  if (projectConfig) {
    lines.push('## Agent Configuration', `- primary provider: ${projectConfig.ai.primary_provider}`);
    if (projectConfig.ai.fallback_provider) {
      lines.push(`- fallback provider: ${projectConfig.ai.fallback_provider}`);
    }
    lines.push(`- create issue: ${projectConfig.workflow.create_issue}`);
    lines.push(`- create branch: ${projectConfig.workflow.create_branch}`);
    lines.push(`- create draft PR: ${projectConfig.workflow.create_draft_pr}`);
    lines.push(`- auto push: ${projectConfig.workflow.auto_push}`);
    lines.push(`- require CI green: ${projectConfig.github.require_ci_green}`);
    lines.push('', '## Verification', `- verify command: ${projectConfig.commands.verify ?? projectConfig.commands.build ?? 'not configured'}`);
  } else {
    lines.push('## Agent Configuration', '- no project config provided, using defaults');
  }

  await writeFile(join(workspacePath, 'AGENTS.md'), lines.join('\n'), 'utf8');
}

async function writeProviderFiles(workspacePath: string, implementation: ImplementResult) {
  if (!implementation.fileUpdates?.length) {
    return;
  }

  for (const file of implementation.fileUpdates) {
    const target = join(workspacePath, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
  }
}

async function collectWorkspaceDiffStat(
  git: SimpleGit,
  workspacePath: string,
  status: StatusResult
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const changedPaths = collectStageablePaths(status).filter(isSubstantiveImplementationPath);
  const untrackedPaths = new Set(status.not_added.filter(isSubstantiveImplementationPath).map(normalizeRepoPath));
  let insertions = 0;
  let deletions = 0;

  try {
    const numstat = await git.diff(['--numstat', 'HEAD']);
    for (const line of numstat.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const [added, removed, ...pathParts] = line.split(/\s+/);
      const path = pathParts.join(' ');
      if (!path || !isSubstantiveImplementationPath(path)) {
        continue;
      }

      insertions += Number.parseInt(added ?? '0', 10) || 0;
      deletions += Number.parseInt(removed ?? '0', 10) || 0;
    }
  } catch {
    // Git can fail before the first commit exists; untracked file counting below still gives a useful guardrail.
  }

  for (const path of changedPaths) {
    if (!untrackedPaths.has(normalizeRepoPath(path))) {
      continue;
    }

    try {
      const content = await readFile(join(workspacePath, path), 'utf8');
      insertions += countTextLines(content);
    } catch {
      insertions += 0;
    }
  }

  return {
    filesChanged: changedPaths.length,
    insertions,
    deletions
  };
}

async function loadResumedImplementation(
  git: SimpleGit,
  workspacePath: string,
  implementationSummary: string
): Promise<ImplementResult | undefined> {
  const status = await git.status();
  const changedFiles = collectStageablePaths(status).filter(isSubstantiveImplementationPath);
  if (changedFiles.length === 0) {
    return undefined;
  }

  return {
    summary: implementationSummary,
    changedFiles: uniqueStrings(changedFiles),
    diffStat: await collectWorkspaceDiffStat(git, workspacePath, status),
    requestedApprovals: []
  };
}

function countTextLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return content.endsWith('\n') ? content.split(/\r?\n/).length - 1 : content.split(/\r?\n/).length;
}

async function prepareWorkspaceGit(
  workspacePath: string,
  branchName: string,
  baseBranch: string,
  remoteUrl: string | undefined,
  options?: {
    skipRemoteFetchForExistingRepo?: boolean;
  }
) {
  const git = simpleGit({ baseDir: workspacePath });
  const files = await readdir(workspacePath);
  const isRepo = await isWorkspaceGitRoot(git, workspacePath);

  if (!isRepo) {
    if (remoteUrl && files.length === 0) {
      await simpleGit().clone(remoteUrl, workspacePath);
    } else {
      await git.init();
    }
  }

  if (remoteUrl) {
    const remotes = await git.getRemotes(true);
    if (!remotes.some((item) => item.name === 'origin')) {
      await git.addRemote('origin', remoteUrl);
    }
    if (!(options?.skipRemoteFetchForExistingRepo && isRepo)) {
      await git.fetch('origin');
    }
  }

  await removeStaleGeneratedInstructionsBeforeCheckout(git, workspacePath);
  await checkoutWorkspaceBranch(git, branchName, Boolean(remoteUrl));
  return git;
}

async function removeStaleGeneratedInstructionsBeforeCheckout(git: SimpleGit, workspacePath: string) {
  const status = await git.status();
  const hasUntrackedAgentsFile = status.not_added.some((path) => path.replace(/\\/g, '/') === 'AGENTS.md');
  if (!hasUntrackedAgentsFile) {
    return;
  }

  const agentsPath = join(workspacePath, 'AGENTS.md');
  let content = '';
  try {
    content = await readFile(agentsPath, 'utf8');
  } catch {
    return;
  }

  if (!content.startsWith('# AGENTS.md') || !content.includes('\n## Task\n')) {
    return;
  }

  await unlink(agentsPath);
}

async function checkoutWorkspaceBranch(git: SimpleGit, branchName: string, hasRemote: boolean) {
  const repoStatus = await git.status();
  if (repoStatus.current === branchName) {
    return;
  }

  const localBranches = await git.branchLocal();
  if (localBranches.all.includes(branchName)) {
    await git.checkout(branchName);
    return;
  }

  if (hasRemote) {
    const allBranches = await git.branch(['-a']);
    const remoteBranch = `remotes/origin/${branchName}`;
    if (allBranches.all.includes(remoteBranch)) {
      await git.checkout(['-B', branchName, `origin/${branchName}`]);
      return;
    }
  }

  await git.checkoutLocalBranch(branchName);
}

async function stageAndCommitChanges(git: SimpleGit, message: string) {
  const initialStatus = await git.status();
  const pathsToStage = collectStageablePaths(initialStatus);
  if (pathsToStage.length === 0 && initialStatus.staged.length === 0) {
    return;
  }

  if (pathsToStage.length > 0) {
    await git.add(pathsToStage);
  }

  const status = await git.status();
  if (status.staged.length === 0) {
    return;
  }

  await git.commit(message);
}

async function isWorkspaceGitRoot(git: SimpleGit, workspacePath: string): Promise<boolean> {
  try {
    const topLevel = await git.revparse(['--show-toplevel']);
    return sameResolvedPath(topLevel, workspacePath);
  } catch {
    return false;
  }
}

async function hasExistingWorkspaceRepo(workspacePath: string): Promise<boolean> {
  return await isWorkspaceGitRoot(simpleGit({ baseDir: workspacePath }), workspacePath);
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function collectStageablePaths(status: StatusResult): string[] {
  const paths = new Set<string>();

  for (const path of [...status.not_added, ...status.created, ...status.modified, ...status.deleted]) {
    paths.add(path);
  }

  for (const rename of status.renamed) {
    paths.add(rename.from);
    paths.add(rename.to);
  }

  return Array.from(paths);
}

function isSubstantiveImplementationPath(path: string): boolean {
  return !isGeneratedWorkerPath(path);
}

function isGeneratedWorkerPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return normalized === 'agents.md' || normalized === 'mock_implementation.md';
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}
