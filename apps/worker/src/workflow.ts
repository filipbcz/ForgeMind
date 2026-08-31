import { access, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type {
  ApprovalType,
  ForgeTask,
  IterationPhase,
  Project,
  ProjectArchitecture,
  ProjectArchitectureUpdate,
  ProjectMemory,
  ProjectValidationProfile,
  ProviderKind,
  TaskActivity,
  TaskMode,
  TaskStatus
} from '@forgemind/core';
import { isNonBlockingDeferredValidation } from '@forgemind/core';
import {
  createAiBranchName,
  renderIssueBody,
  renderPullRequestBody,
  slugifyBranchSegment,
  type GitHubCheckFailure,
  type GitHubChecksResult,
  type GitHubAdapter
} from '@forgemind/github';
import { createProvider, type AIProvider, type ImplementResult, type PlanResult, type ProviderSessionContext, type ReviewResult, type ValidationCheck } from '@forgemind/providers';
import { parseAgentConfigYaml, type AgentConfig } from '@forgemind/config';
import { nowIso, toErrorMessage, type JsonValue } from '@forgemind/shared';
import {
  collectPassedValidationCheckResults,
  createValidationEnvironment,
  formatValidationFailure,
  normalizeValidationCommandForEnvironment,
  runValidationChecks,
  validationCheckResultKey,
  type ValidationCheckExecutionResult,
  type ValidationResult
} from './validation.js';
import {
  assertFreeSpaceForWorker,
  resolveWorkerResourcePolicy,
  type WorkerResourcePolicy
} from './resource-policy.js';

export interface WorkerTaskInput {
  project: Project;
  task: ForgeTask;
  providerKind?: ProviderKind;
  workspaceRoot?: string;
  verifyCommand?: string;
  usageSummary?: string;
  provider?: AIProvider;
  reviewProvider?: AIProvider;
  github?: GitHubAdapter;
  resume?: WorkerTaskResume;
  providerSession?: ProviderSessionContext;
  reviewProviderSession?: ProviderSessionContext;
  hooks?: WorkerTaskHooks;
  signal?: AbortSignal;
  resourcePolicy?: WorkerResourcePolicy;
}

type GitHubOperation = 'create_issue' | 'create_branch' | 'commit_and_push' | 'create_draft_pr' | 'create_pull_request' | 'wait_for_checks' | 'merge_pr' | 'comment_on_issue';

export interface WorkerTaskResume {
  kind: 'approved_large_diff' | 'approved_operation' | 'approved_review' | 'validation_retry' | 'worker_interrupted' | 'phase_retry' | 'capability_available';
  resumeFrom?: 'planning' | 'implementation' | 'validation' | 'review' | 'delivery';
  attempt?: number;
  planSummary?: string;
  planSteps?: string[];
  acceptanceCriteria?: string[];
  implementationSummary: string;
  implementationOutcome?: 'changes_made' | 'already_satisfied';
  evidenceFiles?: string[];
  changedFiles?: string[];
  diffStat?: ImplementResult['diffStat'];
  architectureUpdate?: ProjectArchitectureUpdate;
  previousValidationError?: string;
  previousReviewBlockers?: string[];
  previousSafeImprovements?: string[];
  validation?: ValidationResult;
  passedValidationChecks?: ValidationCheckExecutionResult[];
  resumeValidationPlanRevision?: boolean;
  reviewSummary?: string;
  riskyChanges?: ApprovalType[];
  validationChecks?: ValidationCheck[];
  approvedApprovals?: ApprovalType[];
  completedOperations?: string[];
  githubChecks?: GitHubChecksResult;
  githubChecksInputHash?: string;
  mergeCommitSha?: string;
  completedSatisfactionReview?: {
    inputHash: string;
    summary: string;
    criterionResults?: ReviewResult['criterionResults'];
  };
}

interface ResumedWorkspaceSync {
  previousHead: string;
  currentHead: string;
  treeChanged: boolean;
  changedFiles: string[];
  diffStat: ImplementResult['diffStat'];
}

export interface WorkerTaskHooks {
  onStatus?: (status: TaskStatus, payload?: JsonValue) => Promise<void>;
  onActivity?: (activity: TaskActivity) => Promise<void>;
  onIssue?: (issue: { issueNumber: number; issueUrl: string }) => Promise<void>;
  onBranch?: (branchName: string) => Promise<void>;
  onPullRequest?: (pullRequest: { pullRequestNumber: number; pullRequestUrl: string }) => Promise<void>;
  onGitHubOperationFailed?: (failure: { operation: GitHubOperation; errorMessage: string; context?: JsonValue }) => Promise<void>;
  onCheckpoint?: (checkpoint: {
    key: string;
    phase: TaskActivity['phase'];
    status: 'started' | 'completed' | 'failed';
    inputHash: string;
    output?: JsonValue;
    errorMessage?: string;
  }) => Promise<void>;
  onProviderActivity?: (activity: {
    phase: IterationPhase;
    attempt: number;
    kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace';
    message: string;
    elapsedMs: number;
    usage?: import('@forgemind/providers').ProviderUsageMeasurement;
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
  status: 'ready_for_user_review' | 'completed' | 'needs_approval' | 'validation_failed' | 'waiting_for_capability' | 'failed';
  issueUrl: string;
  branchName: string;
  pullRequestUrl?: string;
  workspacePath: string;
  validation: ValidationResult;
  commitSha?: string;
  githubChecks?: GitHubChecksResult;
  summary: string;
  approvals: ApprovalType[];
  architectureUpdate?: ProjectArchitectureUpdate;
  requiredCapabilities?: string[];
  completedAt: string;
}

export async function runWorkerTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
  throwIfTaskAborted(input.signal);
  const config = resolveWorkerConfig(input.project, input);
  const resourcePolicy = input.resourcePolicy ?? resolveWorkerResourcePolicy(input.project.configYaml);
  const provider = input.provider ?? createProvider(config.providerKind);
  const reviewProvider = input.reviewProvider ?? provider;
  const taskPrompt = compactTaskExecutionPrompt(input.task.prompt);
  const executionPrompt = buildTaskExecutionPrompt(taskPrompt, input.project.projectMemory, input.project.projectArchitecture);
  const github = input.github;
  if ((config.createIssue || config.createBranch || config.createPullRequest || config.autoPush) && !github) {
    throw new Error('GitHub adapter is required for the configured workflow.');
  }
  const workspacePath = join(input.workspaceRoot ?? join(process.cwd(), '.forgemind', 'workspaces'), input.task.id);

  const workspaceStartedAt = Date.now();
  await emitTaskActivity(input.hooks, {
    phase: 'workspace',
    state: 'started',
    title: 'Připravuji pracovní adresář',
    detail: workspacePath,
    operation: 'prepare_workspace'
  });
  await mkdir(workspacePath, { recursive: true });
  await assertFreeSpaceForWorker(workspacePath, resourcePolicy);

  const usageSummary = input.usageSummary ?? formatUsageSummary(await provider.estimateCost({ prompt: executionPrompt, repositorySizeHint: 'small' }));

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
        }, input.signal);
      }, input.signal);
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
  if (config.createBranch) {
    await input.hooks?.onStatus?.('creating_branch', { branchName, reused: Boolean(existingBranchName) });
  }

  const remoteUrl = github ? resolveGitRemoteUrl(github, input.project) : process.env.FORGEMIND_GITHUB_REMOTE_URL;
  if (config.createBranch && !existingBranchName) {
    await runGitHubOperation(
      input.hooks,
      'create_branch',
      { branchName, fromBranch: input.project.defaultBranch },
      async () => github!.createBranch(input.project, branchName, input.project.defaultBranch, input.signal),
      input.signal
    );
  }
  const workspace = await prepareWorkspaceGit(workspacePath, branchName, input.project.defaultBranch, remoteUrl, {
    syncRemoteBranch: Boolean(input.resume)
  });
  const git = workspace.git;
  if (input.resume && workspace.resumedSync) {
    input = {
      ...input,
      resume: reconcileResumeAfterRemoteSync(input.resume, workspace.resumedSync)
    };
    await emitTaskActivity(input.hooks, {
      phase: 'workspace',
      state: 'completed',
      title: 'Pracovni vetev byla aktualizovana',
      detail: workspace.resumedSync.treeChanged
        ? `Vzdaleny commit ${workspace.resumedSync.currentHead} zmenil obsah; validace a review probehnou znovu.`
        : `Vzdaleny commit ${workspace.resumedSync.currentHead} nezmenil obsah; zopakuji se pouze GitHub checks.`,
      operation: 'sync_remote_branch'
    });
  }
  await emitTaskActivity(input.hooks, {
    phase: 'workspace',
    state: 'completed',
    title: 'Pracovní adresář je připravený',
    detail: branchName,
    operation: 'prepare_workspace',
    elapsedMs: Date.now() - workspaceStartedAt
  });
  await input.hooks?.onBranch?.(branchName);

  const completedSatisfactionReview = input.resume?.completedSatisfactionReview;
  if (
    completedSatisfactionReview
    && input.resume?.validation?.passed
    && !requiresPullRequestIntegration(config, input.project)
  ) {
    const currentInputHash = await collectSatisfactionReviewInputHash(
      git,
      workspacePath,
      input.task.prompt,
      input.resume.acceptanceCriteria ?? [],
      input.resume.evidenceFiles ?? []
    );
    if (currentInputHash === completedSatisfactionReview.inputHash) {
      await input.hooks?.onStatus?.('validating', { resumed: true, reused: true });
      await input.hooks?.onStatus?.('reviewing', { resumed: true, reused: true });
      await emitTaskActivity(input.hooks, {
        phase: 'review',
        state: 'completed',
        title: 'Audit existujiciho stavu byl obnoven',
        detail: completedSatisfactionReview.summary,
        operation: 'provider_review',
        elapsedMs: 0
      });
      await emitTaskActivity(input.hooks, {
        phase: 'completion',
        state: 'completed',
        title: 'Task je dokoncen bez zbytecnych zmen',
        detail: completedSatisfactionReview.summary,
        operation: 'finish_task'
      });
      return {
        taskId: input.task.id,
        status: 'completed',
        issueUrl: issue.issueUrl,
        branchName,
        workspacePath,
        validation: input.resume.validation,
        commitSha: await resolveHeadSha(git),
        summary: completedSatisfactionReview.summary,
        approvals: [],
        completedAt: nowIso()
      };
    }
  }

  const isResumeRun = Boolean(input.resume);
  await input.hooks?.onStatus?.('running_ai', isResumeRun && input.resume ? { resumed: true, kind: input.resume.kind } : undefined);
  let cleanupGeneratedAgentsInstructions = await writeAgentsInstructions(
    workspacePath,
    input.project,
    input.task,
    taskPrompt,
    input.project.configYaml
  );
  const roadmapPlan = createRoadmapTaskPlan(executionPrompt);
  const rerunPlanning = input.resume?.resumeFrom === 'planning';
  let plan = input.resume && !rerunPlanning
    ? createResumePlan(input.resume, roadmapPlan)
    : roadmapPlan ?? await (async () => {
        const startedAt = Date.now();
        await emitTaskActivity(input.hooks, {
          phase: 'planning',
          state: 'started',
          title: 'AI připravuje plán',
          operation: 'provider_plan',
          attempt: 0
        });
        await input.hooks?.onIterationStarted?.({
          phase: 'planning',
          prompt: executionPrompt,
          attempt: 0
        });
        const result = await provider.plan({
          taskId: input.task.id,
          title: input.task.title,
          prompt: executionPrompt,
          repositoryPath: workspacePath,
          session: input.providerSession,
          signal: input.signal,
          onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'planning', attempt: 0, ...activity })
        });
        await emitTaskActivity(input.hooks, {
          phase: 'planning',
          state: 'completed',
          title: 'Implementační plán je připravený',
          detail: result.summary,
          operation: 'provider_plan',
          attempt: 0,
          elapsedMs: Date.now() - startedAt
        });
        return result;
      })();
  if ((!input.resume || rerunPlanning) && roadmapPlan) {
    await emitTaskActivity(input.hooks, {
      phase: 'planning',
      state: 'completed',
      title: 'PlĂˇn byl odvozen z roadmap kroku',
      detail: roadmapPlan.summary,
      operation: 'roadmap_plan',
      attempt: 0,
      elapsedMs: 0
    });
  }
  const installCommand = config.installCommand ?? await inferRepositoryInstallCommand(workspacePath);
  const hasAuthoritativeResumeValidationPlan = Boolean(input.resume?.validationChecks?.length);
  let validationChecks = await resolveValidationChecks({
    plan,
    installCommand,
    architectureCommands: input.resume?.validationChecks?.length
      ? undefined
      : input.project.projectArchitecture?.validationCommands,
    validationProfile: input.project.validationProfile,
    workspacePath
  });
  if (!input.resume || rerunPlanning) {
    await input.hooks?.onIteration?.({
      phase: 'planning',
      prompt: executionPrompt,
      resultSummary: plan.summary,
      providerPrompt: plan.providerPrompt,
      providerResponse: plan.providerResponse,
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      validationResult: {
        passed: true,
        steps: plan.steps,
        acceptanceCriteria: plan.acceptanceCriteria,
        validationChecks: validationChecksToJson(validationChecks)
      }
    });
  }

  let implementation: ImplementResult | undefined;
  let validation: ValidationResult | undefined = input.resume?.validation;
  const reuseImplementationCheckpoint = Boolean(
    input.resume
    && input.resume.resumeFrom !== 'planning'
    && input.resume.resumeFrom !== 'implementation'
  );
  let resumedImplementation =
    input.resume && reuseImplementationCheckpoint
      ? await loadResumedImplementation(git, workspacePath, input.resume)
      : undefined;
  const retryReasons: string[] = [];
  const appliedSafeImprovements = new Set<string>();
  const resolvedReviewBlockers = new Set<string>();
  let reviewerRequiredValidationChecks: ValidationCheck[] = [];
  const approvedApprovals = new Set(normalizeRuntimeApprovals(input.resume?.approvedApprovals ?? []));
  let completedAttempts = 0;
  const verifyCommandApprovals = filterApprovedApprovals(
    evaluateRuntimeApprovals(
      computeVerifyCommandApprovals(validationChecks, config.sandbox),
      config.mode,
      config.approvalRequiredFor,
      config.allowSafeOperationsWithoutApproval
    ),
    approvedApprovals
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
  let review: ReviewResult | undefined = input.resume?.previousReviewBlockers?.length
      ? {
          summary: input.resume.reviewSummary ?? 'Resume correction for previously reported review blockers.',
          blockers: input.resume.previousReviewBlockers,
          safeImprovements: input.resume.previousSafeImprovements ?? [],
          riskyChanges: normalizeRuntimeApprovals(input.resume.riskyChanges ?? [])
        }
      : undefined;

  let resumedValidation = input.resume?.resumeFrom === 'review' || input.resume?.resumeFrom === 'delivery'
    ? input.resume.validation
    : undefined;
  const resumeDelivery = input.resume?.resumeFrom === 'delivery';
  const completedOperations = new Set(input.resume?.completedOperations ?? []);
  const deliveryState: DeliveryState = {
    pullRequest: resolveExistingTaskPullRequest(input.task),
    skipCommitFromResume: completedOperations.has('commit'),
    skipPushFromResume: completedOperations.has('commit_and_push'),
    issueCommented: completedOperations.has('comment_on_issue'),
    skipChecksFromResume: completedOperations.has('wait_for_checks'),
    skipMergeFromResume: completedOperations.has('merge_pr'),
    resumedGitHubChecks: input.resume?.githubChecks,
    resumedGitHubChecksInputHash: input.resume?.githubChecksInputHash,
    resumedMergeCommitSha: input.resume?.mergeCommitSha
  };
  const firstAttempt = Math.max(1, Math.min(input.task.maxIterations, input.resume?.attempt ?? 1));
  const passedValidationCheckResults = new Map<string, ValidationCheckExecutionResult>(
    (input.resume?.passedValidationChecks ?? [])
      .filter((result) => result.passed)
      .map((result) => [validationCheckResultKey(normalizeValidationCommandForEnvironment(result.command), result.inputHash), result])
  );

  for (let attempt = firstAttempt; attempt <= input.task.maxIterations; attempt += 1) {
    completedAttempts = attempt;
    const previousReviewForCorrection = review?.blockers.length ? review : undefined;
    const beforeCorrectionSnapshot = previousReviewForCorrection
      ? await collectChangedPathSnapshot(git, workspacePath)
      : new Map<string, string>();
    const implementationStartedAt = Date.now();
    await emitTaskActivity(input.hooks, {
      phase: 'implementation',
      state: 'started',
      title: 'AI implementuje změny',
      detail: `Pokus ${attempt}`,
      operation: 'provider_implement',
      attempt
    });
    await input.hooks?.onIterationStarted?.({
      phase: 'implementation',
      prompt: executionPrompt,
      attempt
    });
    const isResumedImplementation = Boolean(resumedImplementation);
    const attemptApprovedApprovals = approvedApprovals;
    implementation = resumedImplementation
      ?? await provider.implement({
        taskId: input.task.id,
        prompt: executionPrompt,
        plan: { ...plan, validationChecks },
        repositoryPath: workspacePath,
        session: input.providerSession,
        signal: input.signal,
        attemptNumber: attempt,
        previousValidationError: input.resume?.previousValidationError
          ?? (validation && !validation.passed ? formatValidationFailure(validation) : undefined),
        previousReviewBlockers: review?.blockers.length ? review.blockers : undefined,
        previousSafeImprovements: review?.safeImprovements.length ? review.safeImprovements : undefined,
        onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'implementation', attempt, ...activity })
      });
    resumedImplementation = undefined;

    implementation = await applyImplementationPolicy(implementation, workspacePath, config.sandbox);
    await emitTaskActivity(input.hooks, {
      phase: 'implementation',
      state: 'completed',
      title: 'Implementace AI skončila',
      detail: implementation.summary,
      operation: 'provider_implement',
      attempt,
      elapsedMs: Date.now() - implementationStartedAt
    });

    await writeProviderFiles(workspacePath, implementation);
    if (cleanupGeneratedAgentsInstructions) {
      await cleanupGeneratedAgentsInstructions();
      cleanupGeneratedAgentsInstructions = undefined;
    }

    const implementationStatus = await git.status();
    const implementationChangedFiles = collectStageablePaths(implementationStatus);
    if (implementationChangedFiles.length > 0) {
      invalidateResumedDeliveryAfterWorkspaceChanges(deliveryState);
    }
    const substantiveChangedFiles = implementationChangedFiles.filter(isSubstantiveImplementationPath);
    const correctionChangedFiles = previousReviewForCorrection
      ? await collectSnapshotChanges(beforeCorrectionSnapshot, implementationStatus, workspacePath)
      : [];
    const actualDiffStat = await collectWorkspaceDiffStat(git, workspacePath, implementationStatus);
    implementation = {
      ...implementation,
      changedFiles: uniqueStrings([...implementation.changedFiles, ...substantiveChangedFiles]).filter(isSubstantiveImplementationPath),
      diffStat: actualDiffStat
    };
    if (!isResumedImplementation) {
      if (hasAuthoritativeResumeValidationPlan) {
        const proposedChecks = mergeValidationCheckUpdates(
          normalizeValidationChecks(implementation.validationChecks),
          reviewerRequiredValidationChecks
        );
        const newArchitectureCommands = implementation.architectureUpdate?.validationCommands ?? [];
        if (proposedChecks.length > 0 || newArchitectureCommands.length > 0) {
          validationChecks = await resolveValidationChecks({
            plan: {
              ...plan,
              validationChecks: mergeValidationCheckUpdates(validationChecks, proposedChecks)
            },
            architectureCommands: newArchitectureCommands,
            validationProfile: input.project.validationProfile,
            workspacePath
          });
        }
      } else {
        validationChecks = await resolveValidationChecks({
          plan: {
            ...plan,
            validationChecks: mergeValidationCheckUpdates(
              normalizeValidationChecks(implementation.validationChecks),
              reviewerRequiredValidationChecks
            )
          },
          installCommand,
          architectureCommands: [
            ...(input.project.projectArchitecture?.validationCommands ?? []),
            ...(implementation.architectureUpdate?.validationCommands ?? [])
          ],
          validationProfile: input.project.validationProfile,
          workspacePath
        });
      }
    }

    if (!isResumedImplementation) {
      const alreadySatisfied = implementation.outcome === 'already_satisfied';
      await input.hooks?.onIteration?.({
        phase: 'implementation',
        prompt: executionPrompt,
        resultSummary: implementation.summary,
        providerPrompt: implementation.providerPrompt,
        providerResponse: implementation.providerResponse,
        diffStat: implementation.diffStat,
        validationResult: {
          passed: substantiveChangedFiles.length > 0 || alreadySatisfied,
          attempt,
          changedFiles: substantiveChangedFiles,
          alreadySatisfied,
          outcome: implementation.outcome ?? 'changes_made',
          evidenceFiles: implementation.evidenceFiles ?? [],
          architectureUpdate: implementation.architectureUpdate
            ? implementation.architectureUpdate as unknown as JsonValue
            : null,
          validationChecks: validationChecksToJson(validationChecks)
        }
      });
    }

    const implementationApprovals = evaluateRuntimeApprovals(
      implementation.requestedApprovals,
      config.mode,
      config.approvalRequiredFor,
      config.allowSafeOperationsWithoutApproval
    );
    const changedPathApprovals = evaluateRuntimeApprovals(
      computeChangedPathApprovals(implementationStatus, config.sandbox),
      config.mode,
      config.approvalRequiredFor,
      config.allowSafeOperationsWithoutApproval
    );
    const validationCommandApprovals = evaluateRuntimeApprovals(
      computeVerifyCommandApprovals(validationChecks, config.sandbox),
      config.mode,
      config.approvalRequiredFor,
      config.allowSafeOperationsWithoutApproval
    );
    const pendingImplementationApprovals = filterApprovedApprovals(
      uniqueApprovals([...implementationApprovals, ...changedPathApprovals, ...validationCommandApprovals]),
      attemptApprovedApprovals
    );
    if (pendingImplementationApprovals.length > 0) {
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
        approvals: pendingImplementationApprovals,
        completedAt: nowIso()
      };
    }

    const alreadySatisfied = implementation.outcome === 'already_satisfied';
    const hasAlreadySatisfiedValidation = Boolean(
      normalizeValidationChecks(implementation.validationChecks).length > 0
    );
    if (
      substantiveChangedFiles.length === 0
      && !isResumedImplementation
      && (!alreadySatisfied || !hasAlreadySatisfiedValidation)
    ) {
      const missingProof = alreadySatisfied && !hasAlreadySatisfiedValidation;
      validation = {
        command: 'implementation-changes',
        exitCode: 1,
        stdout: '',
        stderr: missingProof
          ? 'Provider marked the task as already satisfied without an executable validation check.'
          : 'Provider did not create or modify any task files.',
        passed: false
      };
      await input.hooks?.onStatus?.('validating', { attempt });
      await input.hooks?.onIteration?.({
        phase: 'validation',
        prompt: validation.command,
        resultSummary: missingProof
          ? 'Already-satisfied result did not include executable proof.'
          : 'Implementation produced no task file changes.',
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
          summary: validation.stderr,
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

    let validationPlanRevisionCount = 0;
    const isFirstResumedAttempt = attempt === firstAttempt;
    let resumeValidationPlanRevision = isFirstResumedAttempt && input.resume?.resumeValidationPlanRevision === true;
    let validationRecoveryFeedback: string | undefined;
    let invalidValidationRecoveryResponseCount = 0;
    let validationStatusEmitted = false;
    while (true) {
      if (!validationStatusEmitted) {
        await input.hooks?.onStatus?.('validating', {
          attempt,
          resumed: Boolean(resumedValidation?.passed || resumeValidationPlanRevision),
          kind: input.resume?.kind ?? null
        });
        validationStatusEmitted = true;
      }
      if (resumedValidation?.passed) {
        validation = resumedValidation;
        resumedValidation = undefined;
        break;
      }
      if (!resumeValidationPlanRevision) {
        const validationInputHash = await collectValidationInputHash(git, workspacePath);
        await input.hooks?.onIterationStarted?.({
          phase: 'validation',
          prompt: summarizeValidationChecks(validationChecks),
          attempt
        });
        validation = await runValidationChecks(validationChecks, workspacePath, async (activity) => {
          const checkLabel = `${activity.checkIndex}/${activity.checkCount}`;
          const checkpointKey = `validation:${hashCheckpointValue(activity.command)}`;
          if (activity.state === 'denied') {
            const denialPayload: JsonValue = {
              policy: activity.denial?.policy ?? 'filesystem_isolation',
              reason: activity.denial?.reason ?? 'unknown',
              command: activity.command,
              path: activity.denial?.path ?? null,
              resolvedPath: activity.denial?.resolvedPath ?? null,
              workspacePath: activity.denial?.workspacePath ?? workspacePath
            };
            await emitTaskActivity(input.hooks, {
              phase: 'validation',
              state: 'failed',
              title: `Validace ${checkLabel} byla zamitnuta sandboxem`,
              detail: activity.stderr,
              operation: 'command_denied',
              attempt,
              elapsedMs: activity.elapsedMs,
              exitCode: activity.exitCode,
              metadata: denialPayload
            });
            await input.hooks?.onCheckpoint?.({
              key: checkpointKey,
              phase: 'validation',
              status: 'failed',
              inputHash: activity.inputHash ?? validationInputHash,
              output: {
                evidenceVersion: 1,
                command: activity.command,
                denied: true,
                denial: denialPayload,
                category: activity.category ?? null,
                criterion: activity.criterion ?? null,
                rationale: activity.rationale ?? null
              },
              errorMessage: activity.stderr
            });
            return;
          }
          if (activity.state === 'deferred') {
            await emitTaskActivity(input.hooks, {
              phase: 'validation',
              state: 'completed',
              title: `Validace ${checkLabel} ceka na jine prostredi`,
              detail: activity.message,
              operation: 'validation_deferred',
              attempt,
              elapsedMs: 0
            });
            await input.hooks?.onCheckpoint?.({
              key: checkpointKey,
              phase: 'validation',
              status: 'completed',
              inputHash: activity.inputHash ?? validationInputHash,
              output: {
                evidenceVersion: 1,
                deferred: true,
                command: activity.command,
                category: activity.category ?? null,
                criterion: activity.criterion ?? null,
                rationale: activity.rationale ?? null,
                requiredCapabilities: activity.requiredCapabilities ?? []
              }
            });
            return;
          }
          if (activity.state === 'started') {
            await input.hooks?.onCheckpoint?.({
              key: checkpointKey,
              phase: 'validation',
              status: 'started',
              inputHash: activity.inputHash ?? validationInputHash,
              output: { command: activity.command, category: activity.category ?? null }
            });
            await emitTaskActivity(input.hooks, {
              phase: 'validation',
              state: 'started',
              title: describeValidationCheckActivity(activity.category, 'started', checkLabel),
              detail: activity.command,
              operation: 'validation_command',
              attempt,
              elapsedMs: activity.elapsedMs
            });
            return;
          }
          if (activity.state === 'output') {
            await emitTaskActivity(input.hooks, {
              phase: 'validation',
              state: 'progress',
              title: describeValidationCheckActivity(activity.category, 'progress', checkLabel),
              detail: activity.message,
              operation: activity.stream ?? 'validation_output',
              attempt,
              elapsedMs: activity.elapsedMs
            });
            return;
          }
          if (activity.state === 'terminated') {
            const terminationPayload: JsonValue = {
              reason: activity.termination?.reason ?? 'unknown',
              pid: activity.termination?.pid ?? null,
              signal: activity.termination?.signal ?? null,
              processGroupTerminated: activity.termination?.processGroupTerminated ?? false,
              errorMessage: activity.termination?.errorMessage ?? null
            };
            await emitTaskActivity(input.hooks, {
              phase: 'validation',
              state: 'failed',
              title: `Validace ${checkLabel} ukoncila strom procesu`,
              detail: activity.message ?? activity.command,
              operation: 'validation_command',
              attempt,
              elapsedMs: activity.elapsedMs,
              metadata: terminationPayload
            });
            await input.hooks?.onCheckpoint?.({
              key: checkpointKey,
              phase: 'validation',
              status: 'failed',
              inputHash: activity.inputHash ?? validationInputHash,
              output: {
                evidenceVersion: 1,
                command: activity.command,
                category: activity.category ?? null,
                termination: terminationPayload,
                criterion: activity.criterion ?? null,
                rationale: activity.rationale ?? null
              },
              errorMessage: activity.message ?? 'Validation command process tree was terminated.'
            });
            return;
          }
          await emitTaskActivity(input.hooks, {
            phase: 'validation',
            state: activity.exitCode === 0 ? 'completed' : 'failed',
            title: activity.reused
              ? `${describeValidationCheckCategory(activity.category)} ${checkLabel} - pouzit checkpoint`
              : describeValidationCheckActivity(activity.category, activity.exitCode === 0 ? 'completed' : 'failed', checkLabel),
            detail: activity.reused
              ? `${activity.command} (drive prosla, znovu se nespousti)`
              : activity.command,
            operation: 'validation_command',
            attempt,
            elapsedMs: activity.elapsedMs,
            exitCode: activity.exitCode
          });
          await input.hooks?.onCheckpoint?.({
            key: checkpointKey,
            phase: 'validation',
            status: activity.exitCode === 0 ? 'completed' : 'failed',
            inputHash: activity.inputHash ?? validationInputHash,
            output: {
              evidenceVersion: 1,
              command: activity.command,
              category: activity.category ?? null,
              exitCode: activity.exitCode ?? null,
              stdout: activity.stdout ?? '',
              stderr: activity.stderr ?? '',
              criterion: activity.criterion ?? null,
              rationale: activity.rationale ?? null
            },
            errorMessage: activity.exitCode === 0 ? undefined : `Validation command exited with ${activity.exitCode ?? 1}.`
          });
        }, passedValidationCheckResults, validationInputHash, input.signal, undefined, {
          workspacePath,
          forbiddenPaths: config.sandbox.forbiddenPaths
        }, resourcePolicy);
        collectPassedValidationCheckResults(validation, passedValidationCheckResults);
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
            passedValidationCommands: (validation.checkResults ?? [])
              .filter((result) => result.passed)
              .map((result) => result.command),
            passedValidationChecks: (validation.checkResults ?? [])
              .filter((result) => result.passed)
              .map((result) => ({
                command: result.command,
                inputHash: result.inputHash ?? null,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                passed: result.passed,
                criterion: result.criterion ?? null,
                rationale: result.rationale ?? null
              })),
            executedCheckCount: validation.executedCheckCount ?? 0,
            reusedCheckCount: validation.reusedCheckCount ?? 0,
            failingCommand: validation.failingCommand ?? null,
            deferredChecks: (validation.deferredChecks ?? []).map((check) => ({
              command: check.command,
              category: check.category ?? null,
              criterion: check.criterion ?? null,
              rationale: check.rationale ?? null,
              requiredCapabilities: check.requiredCapabilities,
              missingCapabilities: check.missingCapabilities
            })),
            attempt,
            validationPlanRevision: validationPlanRevisionCount
          }
        });
      }
      if (!validation) {
        throw new Error('Validation checkpoint is missing while resuming validation-plan correction.');
      }

      if (validation.passed) {
        break;
      }

      if (validation.denied) {
        return {
          taskId: input.task.id,
          status: 'validation_failed',
          issueUrl: issue.issueUrl,
          branchName,
          workspacePath,
          validation,
          summary: validation.stderr,
          approvals: [],
          completedAt: nowIso()
        };
      }

      validationPlanRevisionCount += 1;
      const failedValidationCheck = findFailedValidationCheck(validationChecks, validation.failingCommand);
      if (!failedValidationCheck) {
        validation = {
          ...validation,
          stderr: `${validation.stderr}\nForgeMind could not identify the failed validation check.`.trim()
        };
        break;
      }
      const failedExecution = validation.checkResults?.find((result) => (
        normalizeValidationCommandForEnvironment(result.command)
          === normalizeValidationCommandForEnvironment(failedValidationCheck.command)
      ));
      const validationFailure = {
        command: failedExecution?.command ?? validation.failingCommand ?? failedValidationCheck.command,
        exitCode: failedExecution?.exitCode ?? validation.exitCode,
        stdout: failedExecution?.stdout ?? validation.stdout,
        stderr: failedExecution?.stderr ?? validation.stderr
      };
      const validationRevisionContext = buildValidationRevisionContext(failedValidationCheck, validationRecoveryFeedback);
      const replanningStartedAt = Date.now();
      await emitTaskActivity(input.hooks, {
        phase: 'planning',
        state: 'started',
        title: 'AI vyhodnocuje chybu validace',
        operation: 'provider_plan',
        attempt
      });
      await input.hooks?.onIterationStarted?.({
        phase: 'planning',
        prompt: validationRevisionContext,
        attempt
      });
      const revisedValidationPlan = await provider.plan({
        taskId: input.task.id,
        title: input.task.title,
        prompt: validationRevisionContext,
        repositoryPath: workspacePath,
        previousValidationError: formatValidationFailure(validation),
        previousValidationChecks: [failedValidationCheck],
        validationFailure,
        session: input.providerSession,
        signal: input.signal,
        onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'planning', attempt, ...activity })
      });
      await emitTaskActivity(input.hooks, {
        phase: 'planning',
        state: 'completed',
        title: 'AI rozhodla o dalším postupu',
        detail: revisedValidationPlan.summary,
        operation: 'provider_plan',
        attempt,
        elapsedMs: Date.now() - replanningStartedAt
      });
      const recoveryDecision = normalizeValidationRecoveryDecision(revisedValidationPlan);
      if (!recoveryDecision) {
        invalidValidationRecoveryResponseCount += 1;
        if (invalidValidationRecoveryResponseCount >= 3) {
          throw new Error('AI returned three invalid validation recovery decisions.');
        }
        validationRecoveryFeedback = 'Previous AI response did not contain a valid validationRecovery action and rationale.';
        resumeValidationPlanRevision = true;
        continue;
      }
      validationRecoveryFeedback = undefined;

      if (recoveryDecision.action === 'blocked') {
        invalidValidationRecoveryResponseCount = 0;
        const deferredPrerequisites = deferredChecksMatchingBlocker(
          recoveryDecision.rationale,
          validation.deferredChecks ?? []
        );
        await input.hooks?.onIteration?.({
          phase: 'planning',
          prompt: validationRevisionContext,
          resultSummary: revisedValidationPlan.summary,
          providerPrompt: revisedValidationPlan.providerPrompt,
          providerResponse: revisedValidationPlan.providerResponse,
          diffStat: implementation.diffStat,
          validationResult: {
            passed: false,
            validationRecovery: recoveryDecision as unknown as JsonValue,
            attempt,
            validationPlanRevision: validationPlanRevisionCount
          }
        });
        if (deferredPrerequisites.length > 0) {
          const inheritedCapabilities = uniqueStrings(deferredPrerequisites.flatMap((check) => check.requiredCapabilities));
          validationChecks = validationChecks.map((check) => (
            normalizeValidationCommandForEnvironment(check.command)
              === normalizeValidationCommandForEnvironment(failedValidationCheck.command)
              ? { ...check, requiredCapabilities: uniqueStrings([...(check.requiredCapabilities ?? []), ...inheritedCapabilities]) }
              : check
          ));
          resumeValidationPlanRevision = false;
          continue;
        }
        return {
          taskId: input.task.id,
          status: 'validation_failed',
          issueUrl: issue.issueUrl,
          branchName,
          workspacePath,
          validation,
          summary: recoveryDecision.rationale,
          approvals: [],
          completedAt: nowIso()
        };
      }

      if (recoveryDecision.action === 'repair_implementation') {
        invalidValidationRecoveryResponseCount = 0;
        validation = {
          ...validation,
          ...validationFailure,
          passed: false,
          failingCommand: validationFailure.command
        };
        await input.hooks?.onIteration?.({
          phase: 'planning',
          prompt: validationRevisionContext,
          resultSummary: revisedValidationPlan.summary,
          providerPrompt: revisedValidationPlan.providerPrompt,
          providerResponse: revisedValidationPlan.providerResponse,
          diffStat: implementation.diffStat,
          validationResult: {
            passed: true,
            validationRecovery: recoveryDecision as unknown as JsonValue,
            attempt,
            validationPlanRevision: validationPlanRevisionCount
          }
        });
        break;
      }

      const revisedValidationChecks = replaceFailedValidationCheck(
        validationChecks,
        validation.failingCommand,
        revisedValidationPlan.validationChecks
      );
      if (!revisedValidationChecks) {
        invalidValidationRecoveryResponseCount += 1;
        if (invalidValidationRecoveryResponseCount >= 3) {
          throw new Error('AI returned three invalid replacement validation check sets.');
        }
        validationRecoveryFeedback = 'Previous AI response selected replace_validation_check but did not provide a distinct executable replacement.';
        resumeValidationPlanRevision = true;
        continue;
      }
      validationChecks = revisedValidationChecks;
      invalidValidationRecoveryResponseCount = 0;
      resumeValidationPlanRevision = false;
      await input.hooks?.onIteration?.({
        phase: 'planning',
        prompt: validationRevisionContext,
        resultSummary: revisedValidationPlan.summary,
        providerPrompt: revisedValidationPlan.providerPrompt,
        providerResponse: revisedValidationPlan.providerResponse,
        diffStat: implementation.diffStat,
        validationResult: {
          passed: true,
          validationChecks: validationChecksToJson(validationChecks),
          validationRecovery: recoveryDecision as unknown as JsonValue,
          revisedValidationChecksOnly: true,
          attempt,
          validationPlanRevision: validationPlanRevisionCount
        }
      });

      const revisedVerifyCommandApprovals = filterApprovedApprovals(
        evaluateRuntimeApprovals(
          computeVerifyCommandApprovals(validationChecks, config.sandbox),
          config.mode,
          config.approvalRequiredFor,
          config.allowSafeOperationsWithoutApproval
        ),
        attemptApprovedApprovals
      );
      if (revisedVerifyCommandApprovals.length > 0) {
        return {
          taskId: input.task.id,
          status: 'needs_approval',
          issueUrl: issue.issueUrl,
          branchName,
          workspacePath,
          validation,
          summary: `Revised verification command is blocked by sandbox policy: ${summarizeValidationChecks(validationChecks)}`,
          approvals: revisedVerifyCommandApprovals,
          completedAt: nowIso()
        };
      }
    }

    if (validation.passed) {
      const satisfactionReview = alreadySatisfied && substantiveChangedFiles.length === 0;
      const reviewResume = input.resume;
      if (reviewResume && (
        reviewResume.kind === 'approved_review'
        || resumeDelivery
        || (reviewResume.kind === 'capability_available' && isFirstResumedAttempt)
      )) {
        await input.hooks?.onStatus?.('reviewing', { attempt, resumed: true, kind: reviewResume.kind });
        review = {
          summary: reviewResume.reviewSummary ?? 'Previously approved review resumed.',
          blockers: [],
          safeImprovements: [],
          riskyChanges: normalizeRuntimeApprovals(reviewResume.riskyChanges ?? [])
        };
      } else {
        await input.hooks?.onStatus?.('reviewing', { attempt });
      const reviewStartedAt = Date.now();
      const satisfactionReviewInputHash = satisfactionReview
        ? await collectSatisfactionReviewInputHash(
            git,
            workspacePath,
            input.task.prompt,
            plan.acceptanceCriteria,
            implementation.evidenceFiles ?? []
          )
        : undefined;
      await emitTaskActivity(input.hooks, {
        phase: 'review',
        state: 'started',
        title: 'AI kontroluje výsledné změny',
        operation: 'provider_review',
        attempt
      });
      await input.hooks?.onIterationStarted?.({
        phase: 'review',
        prompt: `Review ${implementation.changedFiles.join(', ')}`,
        attempt
      });
      let providerReview;
      let satisfactionEvidenceErrors: string[] = [];
      try {
        if (satisfactionReviewInputHash) {
          await input.hooks?.onCheckpoint?.({
            key: 'review:already_satisfied',
            phase: 'review',
            status: 'started',
            inputHash: satisfactionReviewInputHash
          });
        }
        const satisfactionEvidence = satisfactionReview
          ? await collectSatisfactionEvidence(git, workspacePath, implementation.evidenceFiles ?? [])
          : undefined;
        satisfactionEvidenceErrors = satisfactionEvidence?.errors ?? [];
        const requestedReviewFiles = satisfactionEvidence?.files
          ?? (previousReviewForCorrection
            ? (correctionChangedFiles.length > 0 ? uniqueStrings(correctionChangedFiles) : undefined)
            : implementation.changedFiles);
        const reviewPacket: { changedFiles: string[]; diff: string } = satisfactionReview
          ? { changedFiles: requestedReviewFiles ?? [], diff: '' }
          : await collectReviewPacket(
              git,
              workspacePath,
              requestedReviewFiles,
              input.project.defaultBranch
            );
        const reviewChangedFiles = reviewPacket.changedFiles;
        const reviewDiff = reviewPacket.diff;
        const reviewPromise = reviewProvider.review({
            taskId: input.task.id,
            taskTitle: input.task.title,
            taskPrompt: input.task.prompt,
            repositoryPath: workspacePath,
            changedFiles: reviewChangedFiles,
            acceptanceCriteria: plan.acceptanceCriteria,
            previousReviewSummary: previousReviewForCorrection?.summary,
            previousReviewBlockers: previousReviewForCorrection?.blockers,
            validation,
            diff: reviewDiff,
            reviewMode: satisfactionReview ? 'existing_state' : 'changes',
            repositoryEvidence: satisfactionEvidence?.packet,
            architectureContext: formatProjectArchitectureContext(
              input.project.projectArchitecture,
              reviewChangedFiles.join(' ')
            ),
            architectureUpdate: implementation.architectureUpdate,
            session: input.reviewProviderSession,
            signal: input.signal,
            onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'review', attempt, ...activity })
          });
        providerReview = reviewProvider.kind === 'codex' && process.env.FORGEMIND_REVIEW_TIMEOUT_MS === undefined
          ? await reviewPromise
          : await withTimeout(
              reviewPromise,
              resolveReviewTimeoutMs(),
              () => new Error(`Review timed out after ${resolveReviewTimeoutMs()} ms.`)
            );
      } catch (error) {
        if (satisfactionReviewInputHash) {
          await input.hooks?.onCheckpoint?.({
            key: 'review:already_satisfied',
            phase: 'review',
            status: 'failed',
            inputHash: satisfactionReviewInputHash,
            errorMessage: toErrorMessage(error)
          });
        }
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
      }, validation.deferredChecks ?? []);
      if (satisfactionReview) {
        review = normalizeSatisfactionReview(
          review,
          plan.acceptanceCriteria,
          satisfactionEvidenceErrors,
          new Set((validation.deferredChecks ?? []).flatMap((check) => check.criterion ? [check.criterion.trim()] : []))
        );
      }
      const reviewValidationChecks = normalizeValidationChecks(review.validationChecks);
      if (review.blockers.length > 0 && reviewValidationChecks.length > 0) {
        reviewerRequiredValidationChecks = mergeValidationCheckUpdates(
          reviewerRequiredValidationChecks,
          reviewValidationChecks
        );
        validationChecks = await resolveValidationChecks({
          plan: {
            ...plan,
            validationChecks: mergeValidationCheckUpdates(validationChecks, reviewValidationChecks)
          },
          installCommand,
          validationProfile: input.project.validationProfile,
          workspacePath
        });
      }
      await emitTaskActivity(input.hooks, {
        phase: 'review',
        state: review.blockers.length > 0 ? 'failed' : 'completed',
        title: review.blockers.length > 0 ? 'Review našlo blokující problém' : 'Review je dokončené',
        detail: review.summary,
        operation: 'provider_review',
        attempt,
        elapsedMs: Date.now() - reviewStartedAt
      });
      await input.hooks?.onIteration?.({
        phase: 'review',
        prompt: `Review ${implementation.changedFiles.join(', ')}`,
        resultSummary: review.summary,
        providerPrompt: review.providerPrompt,
        providerResponse: review.providerResponse,
        diffStat: implementation.diffStat,
        validationResult: {
          blockers: review.blockers,
          riskyChanges: review.riskyChanges,
          validationChecks: validationChecksToJson(validationChecks),
          criterionResults: review.criterionResults ?? [],
          alreadySatisfied: satisfactionReview,
          attempt
        }
      });
      if (satisfactionReviewInputHash) {
        await input.hooks?.onCheckpoint?.({
          key: 'review:already_satisfied',
          phase: 'review',
          status: review.blockers.length === 0 ? 'completed' : 'failed',
          inputHash: satisfactionReviewInputHash,
          output: {
            summary: review.summary,
            criterionResults: review.criterionResults ?? []
          },
          errorMessage: review.blockers.length === 0 ? undefined : review.blockers.join('\n')
        });
      }
      }

      if (review.blockers.length === 0) {
        if (satisfactionReview && !requiresPullRequestIntegration(config, input.project)) {
          const summary = review.summary.trim() || implementation.summary.trim() || 'Existing implementation satisfies the task.';
          await emitTaskActivity(input.hooks, {
            phase: 'completion',
            state: 'completed',
            title: 'Task je dokoncen bez zbytecnych zmen',
            detail: summary,
            operation: 'finish_task'
          });
          const deferredChecks = validation.deferredChecks ?? [];
          const { blockingCapabilities, deferredCapabilities } = partitionDeferredValidationCapabilities(deferredChecks);
          const deferUntilProjectAudit = deferredCapabilities.length > 0 && blockingCapabilities.length === 0;
          const requiredCapabilities = deferUntilProjectAudit ? deferredCapabilities : blockingCapabilities;
          return {
            taskId: input.task.id,
            status: requiredCapabilities.length > 0 && !deferUntilProjectAudit ? 'waiting_for_capability' : 'completed',
            issueUrl: issue.issueUrl,
            branchName,
            workspacePath,
            validation,
            commitSha: await resolveHeadSha(git),
            summary: deferUntilProjectAudit
              ? `${summary}\n\nWindows-specific validation was deferred to the final project audit.`
              : summary,
            approvals: [],
            requiredCapabilities: requiredCapabilities.length > 0 ? requiredCapabilities : undefined,
            completedAt: nowIso()
          };
        }
        const resumedApprovedReview = reviewResume
          && (reviewResume.kind === 'approved_review' || resumeDelivery);
        const reviewRiskApprovals = resumedApprovedReview
          ? []
          : filterApprovedApprovals(
              evaluateRuntimeApprovals(review.riskyChanges, config.mode, config.approvalRequiredFor, config.allowSafeOperationsWithoutApproval),
              attemptApprovedApprovals
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

        const delivery = await deliverWorkerAttempt({
          input,
          config,
          github,
          git,
          issue,
          branchName,
          workspacePath,
          plan,
          implementation,
          validation,
          review,
          usageSummary,
          attempt,
          completedAttempts,
          retryReasons,
          appliedSafeImprovements,
          resolvedReviewBlockers,
          state: deliveryState
        });

        if (delivery.kind === 'completed') {
          const deferredChecks = validation.deferredChecks ?? [];
          const { blockingCapabilities, deferredCapabilities } = partitionDeferredValidationCapabilities(deferredChecks);
          const deferUntilProjectAudit = deferredCapabilities.length > 0 && blockingCapabilities.length === 0;
          const requiredCapabilities = deferUntilProjectAudit ? deferredCapabilities : blockingCapabilities;
          if (requiredCapabilities.length > 0 && delivery.result.status === 'completed' && !deferUntilProjectAudit) {
            return {
              ...delivery.result,
              status: 'waiting_for_capability',
              requiredCapabilities,
              summary: `${delivery.result.summary}\n\nSource delivery completed. Authoritative validation is waiting for worker capabilities: ${requiredCapabilities.join(', ')}.`
            };
          }
          if (requiredCapabilities.length > 0) {
            return {
              ...delivery.result,
              requiredCapabilities,
              summary: deferUntilProjectAudit
                ? `${delivery.result.summary}\n\nWindows-specific validation was deferred to the final project audit.`
                : delivery.result.summary
            };
          }
          return delivery.result;
        }

        validation = delivery.validation;
        await input.hooks?.onIterationStarted?.({
          phase: 'validation',
          prompt: validation.command,
          attempt
        });
        await input.hooks?.onIteration?.({
          phase: 'validation',
          prompt: validation.command,
          resultSummary: 'GitHub Actions validation failed.',
          diffStat: implementation.diffStat,
          validationResult: {
            command: validation.command,
            exitCode: validation.exitCode,
            stdout: validation.stdout,
            stderr: validation.stderr,
            passed: false,
            attempt,
            githubChecks: delivery.failures.map((failure) => ({
              name: failure.name,
              detailsUrl: failure.detailsUrl ?? null,
              output: failure.output
            }))
          }
        });

        if (attempt === input.task.maxIterations) {
          return {
            taskId: input.task.id,
            status: 'validation_failed',
            issueUrl: issue.issueUrl,
            branchName,
            pullRequestUrl: deliveryState.pullRequest?.pullRequestUrl,
            workspacePath,
            validation,
            summary: `GitHub Actions failed after ${attempt} attempt(s).`,
            approvals: [],
            completedAt: nowIso()
          };
        }

        retryReasons.push(`GitHub Actions retry before attempt ${attempt + 1}: ${delivery.validation.stderr}`);
        await input.hooks?.onStatus?.('running_ai', {
          attempt: attempt + 1,
          retryReason: delivery.validation.stderr
        });
        continue;
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

    const validationFailure = formatValidationFailure(validation);
    retryReasons.push(`Validation retry before attempt ${attempt + 1}: ${validationFailure}`);
    await input.hooks?.onStatus?.('running_ai', {
      attempt: attempt + 1,
      retryReason: validationFailure
    });
  }

  throw new Error('Worker exhausted all implementation attempts without a deliverable result.');
}

function describeValidationCheckActivity(
  category: ValidationCheck['category'],
  state: 'started' | 'progress' | 'completed' | 'failed',
  checkLabel: string
): string {
  const label = describeValidationCheckCategory(category);
  const suffix = state === 'started'
    ? 'se spousti'
    : state === 'progress'
      ? 'stale bezi'
      : state === 'completed'
        ? 'prosla'
        : 'selhala';
  return `${label} ${checkLabel} ${suffix}`;
}

function describeValidationCheckCategory(category: ValidationCheck['category']): string {
  switch (category) {
    case 'setup': return 'Priprava prostredi';
    case 'build': return 'Build';
    case 'database': return 'Databazova validace';
    case 'api': return 'API validace';
    case 'browser': return 'Browser validace';
    case 'smoke': return 'Smoke test';
    default: return 'Validace';
  }
}

interface DeliveryState {
  pullRequest?: { pullRequestNumber: number; pullRequestUrl: string };
  skipCommitFromResume: boolean;
  skipPushFromResume: boolean;
  issueCommented: boolean;
  skipChecksFromResume: boolean;
  skipMergeFromResume: boolean;
  resumedGitHubChecks?: GitHubChecksResult;
  resumedGitHubChecksInputHash?: string;
  resumedMergeCommitSha?: string;
}

function invalidateResumedDeliveryAfterWorkspaceChanges(state: DeliveryState) {
  state.skipCommitFromResume = false;
  state.skipPushFromResume = false;
  state.skipChecksFromResume = false;
  state.skipMergeFromResume = false;
  state.resumedGitHubChecks = undefined;
  state.resumedGitHubChecksInputHash = undefined;
  state.resumedMergeCommitSha = undefined;
}

type DeliveryAttemptOutcome =
  | { kind: 'completed'; result: WorkerTaskResult }
  | { kind: 'ci_failure'; validation: ValidationResult; failures: GitHubCheckFailure[] };

async function deliverWorkerAttempt(input: {
  input: WorkerTaskInput;
  config: WorkerConfig;
  github?: GitHubAdapter;
  git: SimpleGit;
  issue: { issueNumber: number; issueUrl: string };
  branchName: string;
  workspacePath: string;
  plan: PlanResult;
  implementation: ImplementResult;
  validation: ValidationResult;
  review: {
    summary: string;
    blockers: string[];
    safeImprovements: string[];
    riskyChanges: ApprovalType[];
  };
  usageSummary: string;
  attempt: number;
  completedAttempts: number;
  retryReasons: string[];
  appliedSafeImprovements: Set<string>;
  resolvedReviewBlockers: Set<string>;
  state: DeliveryState;
}): Promise<DeliveryAttemptOutcome> {
  const {
    config,
    github,
    git,
    issue,
    branchName,
    workspacePath,
    plan,
    implementation,
    validation,
    review,
    usageSummary,
    attempt,
    completedAttempts,
    retryReasons,
    appliedSafeImprovements,
    resolvedReviewBlockers,
    state
  } = input;
  const taskInput = input.input;
  throwIfTaskAborted(taskInput.signal);

  if (state.skipCommitFromResume) {
    await emitSkippedExternalEffect(taskInput.hooks, 'commit', 'git', attempt);
  } else {
    throwIfTaskAborted(taskInput.signal);
    const commitStartedAt = Date.now();
    const commitInputHash = await collectValidationInputHash(git, workspacePath);
    await taskInput.hooks?.onCheckpoint?.({ key: 'external:commit', phase: 'git', status: 'started', inputHash: commitInputHash });
    await emitTaskActivity(taskInput.hooks, {
      phase: 'git',
      state: 'started',
      title: 'Vytvarim Git commit',
      detail: `AI: ${taskInput.task.title}`,
      operation: 'commit'
    });
    try {
      await stageAndCommitChanges(git, `AI: ${taskInput.task.title}`);
    } catch (error) {
      await taskInput.hooks?.onCheckpoint?.({
        key: 'external:commit', phase: 'git', status: 'failed', inputHash: commitInputHash, errorMessage: toErrorMessage(error)
      });
      throw error;
    }
    await emitTaskActivity(taskInput.hooks, {
      phase: 'git',
      state: 'completed',
      title: 'Git commit je pripraveny',
      operation: 'commit',
      elapsedMs: Date.now() - commitStartedAt
    });
    await taskInput.hooks?.onCheckpoint?.({ key: 'external:commit', phase: 'git', status: 'completed', inputHash: commitInputHash });
  }
  state.skipCommitFromResume = false;

  if (config.autoPush) {
    if (state.skipPushFromResume) {
      await emitSkippedExternalEffect(taskInput.hooks, 'commit_and_push', 'git', attempt);
    } else {
      await runGitHubOperation(
        taskInput.hooks,
        'commit_and_push',
        { branchName, workspacePath },
        async () => github!.commitAndPush(taskInput.project, branchName, `AI: ${taskInput.task.title}`, workspacePath, taskInput.signal),
        taskInput.signal
      );
    }
  }
  state.skipPushFromResume = false;

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

  if (config.createPullRequest) {
    await taskInput.hooks?.onStatus?.('creating_pr', state.pullRequest ? { ...state.pullRequest, reused: true } : undefined);
    if (!state.pullRequest) {
      state.pullRequest = await runGitHubOperation(
        taskInput.hooks,
        config.autoMergePullRequest ? 'create_pull_request' : 'create_draft_pr',
        { branchName },
        async () => github!.createDraftPullRequest({
          project: taskInput.project,
          task: {
            ...taskInput.task,
            branchName
          },
          title: `[AI] ${taskInput.task.title}`,
          body: pullRequestBody,
          draft: !config.autoMergePullRequest
        }, taskInput.signal),
        taskInput.signal
      );
      await taskInput.hooks?.onPullRequest?.(state.pullRequest);
    }
  }

  if (config.createIssue) {
    if (state.issueCommented) {
      await emitSkippedExternalEffect(taskInput.hooks, 'comment_on_issue', 'github', attempt);
    } else {
      await runGitHubOperation(
        taskInput.hooks,
        'comment_on_issue',
        { issueNumber: issue.issueNumber },
        async () => github!.commentOnIssue(taskInput.project, issue.issueNumber, renderIssueBody(taskInput.task), taskInput.signal),
        taskInput.signal
      );
      state.issueCommented = true;
    }
  }

  let githubChecks: GitHubChecksResult | undefined;
  if (config.requireCiGreen && config.autoPush && state.pullRequest && github?.waitForChecks && state.skipChecksFromResume) {
    const headSha = (await git.revparse(['HEAD'])).trim();
    const currentInputHash = hashCheckpointValue(`${headSha}:${state.pullRequest.pullRequestNumber}`);
    if (state.resumedGitHubChecks && state.resumedGitHubChecksInputHash === currentInputHash) {
      githubChecks = state.resumedGitHubChecks;
      await emitSkippedExternalEffect(taskInput.hooks, 'wait_for_checks', 'github', attempt, {
        inputHash: currentInputHash,
        summary: state.resumedGitHubChecks.summary
      });
    } else {
      state.skipChecksFromResume = false;
    }
  } else if (state.skipChecksFromResume) {
    githubChecks = state.resumedGitHubChecks;
    await emitSkippedExternalEffect(taskInput.hooks, 'wait_for_checks', 'github', attempt, {
      inputHash: state.resumedGitHubChecksInputHash ?? null,
      summary: state.resumedGitHubChecks?.summary ?? null
    });
  }
  if (config.requireCiGreen && config.autoPush && state.pullRequest && github?.waitForChecks && !state.skipChecksFromResume) {
    throwIfTaskAborted(taskInput.signal);
    const headSha = (await git.revparse(['HEAD'])).trim();
    const checksInputHash = hashCheckpointValue(`${headSha}:${state.pullRequest.pullRequestNumber}`);
    await taskInput.hooks?.onCheckpoint?.({ key: 'external:wait_for_checks', phase: 'github', status: 'started', inputHash: checksInputHash });
    const checksStartedAt = Date.now();
    await emitTaskActivity(taskInput.hooks, {
      phase: 'github',
      state: 'started',
      title: 'Cekam na GitHub Actions',
      detail: headSha,
      operation: 'wait_for_checks',
      attempt
    });
    let checks: GitHubChecksResult;
    try {
      checks = await github.waitForChecks(taskInput.project, headSha, {
        signal: taskInput.signal,
        onProgress: async (message) => emitTaskActivity(taskInput.hooks, {
          phase: 'github',
          state: 'progress',
          title: 'GitHub Actions stale bezi',
          detail: message,
          operation: 'wait_for_checks',
          attempt,
          elapsedMs: Date.now() - checksStartedAt
        })
      });
      throwIfTaskAborted(taskInput.signal);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      await emitTaskActivity(taskInput.hooks, {
        phase: 'github',
        state: 'failed',
        title: 'GitHub Actions se nepodarilo nacist',
        detail: errorMessage,
        operation: 'wait_for_checks',
        attempt,
        elapsedMs: Date.now() - checksStartedAt
      });
      await taskInput.hooks?.onGitHubOperationFailed?.({
        operation: 'wait_for_checks',
        errorMessage,
        context: { headSha, pullRequestNumber: state.pullRequest.pullRequestNumber }
      });
      await taskInput.hooks?.onCheckpoint?.({ key: 'external:wait_for_checks', phase: 'github', status: 'failed', inputHash: checksInputHash, errorMessage });
      throw error;
    }

    if (checks.status === 'timeout' || checks.status === 'not_configured') {
      await emitTaskActivity(taskInput.hooks, {
        phase: 'github',
        state: 'failed',
        title: checks.status === 'not_configured' ? 'GitHub Actions nebylo nalezeno' : 'Cekani na GitHub Actions vyprselo',
        detail: checks.summary,
        operation: 'wait_for_checks',
        attempt,
        elapsedMs: Date.now() - checksStartedAt
      });
      await taskInput.hooks?.onGitHubOperationFailed?.({
        operation: 'wait_for_checks',
        errorMessage: checks.summary,
        context: { headSha, pullRequestNumber: state.pullRequest.pullRequestNumber }
      });
      await taskInput.hooks?.onCheckpoint?.({ key: 'external:wait_for_checks', phase: 'github', status: 'failed', inputHash: checksInputHash, errorMessage: checks.summary });
      throw new Error(checks.status === 'not_configured'
        ? `CI is required, but no GitHub check was discovered for ${headSha}.`
        : checks.summary);
    }

    if (checks.status === 'failure') {
      const infrastructureFailure = isGitHubInfrastructureFailure(checks);
      await emitTaskActivity(taskInput.hooks, {
        phase: 'github',
        state: 'failed',
        title: 'GitHub Actions naslo chybu',
        detail: checks.summary,
        operation: 'wait_for_checks',
        attempt,
        elapsedMs: Date.now() - checksStartedAt
      });
      await taskInput.hooks?.onCheckpoint?.({
        key: 'external:wait_for_checks',
        phase: 'github',
        status: 'failed',
        inputHash: checksInputHash,
        output: { status: checks.status, summary: checks.summary },
        errorMessage: checks.summary
      });
      if (infrastructureFailure) {
        const errorMessage = `GitHub Actions infrastructure blocked execution: ${checks.summary}`;
        await taskInput.hooks?.onGitHubOperationFailed?.({
          operation: 'wait_for_checks',
          errorMessage,
          context: { headSha, pullRequestNumber: state.pullRequest.pullRequestNumber, infrastructureFailure: true }
        });
        throw new Error(errorMessage);
      }
      return {
        kind: 'ci_failure',
        validation: {
          command: `github-actions ${headSha}`,
          exitCode: 1,
          stdout: '',
          stderr: checks.summary,
          passed: false,
          failingCommand: 'github-actions'
        },
        failures: checks.failures
      };
    }

    await emitTaskActivity(taskInput.hooks, {
      phase: 'github',
      state: 'completed',
      title: checks.status === 'success' ? 'GitHub Actions proslo' : 'Repozitar nema automaticke GitHub checks',
      detail: checks.summary,
      operation: 'wait_for_checks',
      attempt,
      elapsedMs: Date.now() - checksStartedAt
    });
    githubChecks = checks;
    await taskInput.hooks?.onCheckpoint?.({
      key: 'external:wait_for_checks', phase: 'github', status: 'completed', inputHash: checksInputHash,
      output: {
        status: checks.status,
        summary: checks.summary,
        failures: checks.failures.map((failure) => ({
          name: failure.name,
          output: failure.output,
          detailsUrl: failure.detailsUrl ?? null
        }))
      }
    });
  }
  state.skipChecksFromResume = false;

  let mergeConfirmed = false;
  let mergeFailure: string | undefined;
  let mergeCommitSha: string | undefined;
  if (config.autoMergePullRequest && state.pullRequest && state.skipMergeFromResume) {
    mergeConfirmed = true;
    mergeCommitSha = state.resumedMergeCommitSha;
    await emitSkippedExternalEffect(taskInput.hooks, 'merge_pr', 'github', attempt, {
      mergeCommitSha: mergeCommitSha ?? null,
      pullRequestNumber: state.pullRequest.pullRequestNumber
    });
  } else if (config.autoMergePullRequest && state.pullRequest) {
    if (!github?.mergePullRequest) {
      mergeFailure = 'The configured GitHub adapter does not support pull request merge.';
    } else {
      const merge = await runGitHubOperation(
        taskInput.hooks,
        'merge_pr',
        { pullRequestNumber: state.pullRequest.pullRequestNumber, targetBranch: taskInput.project.defaultBranch },
        async () => {
          const result = await github.mergePullRequest!(taskInput.project, state.pullRequest!.pullRequestNumber, taskInput.signal);
          if (!result.merged) {
            throw new Error(`Pull request #${state.pullRequest!.pullRequestNumber} was not merged: ${result.message}`);
          }
          return result;
        },
        taskInput.signal,
        (result) => ({
          pullRequestNumber: state.pullRequest!.pullRequestNumber,
          targetBranch: taskInput.project.defaultBranch,
          merged: true,
          sha: result.sha ?? null
        })
      );
      mergeConfirmed = merge.merged;
      mergeCommitSha = merge.merged && merge.sha && /^[a-f0-9]{7,64}$/i.test(merge.sha)
        ? merge.sha
        : undefined;
      if (!merge.merged) mergeFailure = merge.message;
    }
  }
  state.skipMergeFromResume = false;

  await emitTaskActivity(taskInput.hooks, {
    phase: 'completion',
    state: 'completed',
    title: config.autoCompleteTask && mergeConfirmed ? 'Task je dokonceny' : 'Vysledek je pripraveny k prevzeti',
    detail: state.pullRequest?.pullRequestUrl,
    operation: 'finish_task'
  });
  // A squash merge creates a different commit identity for the validated tree.
  // Evidence must follow the commit that the project audit will clone from main.
  const commitSha = mergeCommitSha ?? await resolveHeadSha(git);
  return {
    kind: 'completed',
    result: {
      taskId: taskInput.task.id,
      status: config.autoCompleteTask && mergeConfirmed ? 'completed' : 'ready_for_user_review',
      issueUrl: issue.issueUrl,
      branchName,
      pullRequestUrl: state.pullRequest?.pullRequestUrl,
      workspacePath,
      validation,
      commitSha,
      githubChecks,
      summary: mergeFailure
        ? `${review.summary}\n\nAutomatic merge was not completed: ${mergeFailure}`
        : review.summary,
      approvals: review.riskyChanges,
      architectureUpdate: implementation.architectureUpdate,
      completedAt: nowIso()
    }
  };
}

async function resolveHeadSha(git: SimpleGit): Promise<string | undefined> {
  try {
    const sha = (await git.revparse(['HEAD'])).trim();
    return /^[a-f0-9]{7,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function resolveGitRemoteUrl(github: GitHubAdapter, project: Project): string | undefined {
  return github.getRemoteUrl?.(project) ?? process.env.FORGEMIND_GITHUB_REMOTE_URL;
}

function formatUsageSummary(input: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }): string {
  return `Input tokens: ${input.inputTokens}, output tokens: ${input.outputTokens}, estimated cost: ${input.estimatedCostUsd.toFixed(4)} USD`;
}

function createResumePlan(resume: WorkerTaskResume, fallback?: PlanResult): PlanResult {
  return {
    summary:
      resume.planSummary
      ?? (resume.kind === 'approved_review'
        ? 'Resume previously reviewed implementation after approval.'
        : resume.kind === 'worker_interrupted'
          ? 'Resume implementation after the previous worker process was interrupted.'
          : resume.kind === 'validation_retry'
            ? 'Resume the preserved implementation and rerun validation only.'
          : 'Resume previously approved implementation.'),
    steps: resume.planSteps ?? fallback?.steps ?? [],
    acceptanceCriteria: resume.acceptanceCriteria ?? fallback?.acceptanceCriteria ?? [],
    validationChecks: normalizeValidationChecks(resume.validationChecks)
  };
}

function throwIfTaskAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Task execution was cancelled.');
}

export function compactTaskExecutionPrompt(prompt: string): string {
  const normalized = prompt.trim();
  const projectContractMarker = 'Project contract:';
  const currentStepMarker = 'Current implementation step:';
  const contractIndex = normalized.lastIndexOf(projectContractMarker);
  const markerIndex = normalized.lastIndexOf(currentStepMarker);

  if (markerIndex < 0) {
    return normalized;
  }

  return normalized.slice(contractIndex >= 0 && contractIndex < markerIndex ? contractIndex : markerIndex).trim();
}

export function buildTaskExecutionPrompt(
  prompt: string,
  memory?: ProjectMemory,
  architecture?: ProjectArchitecture
): string {
  const architectureContext = formatProjectArchitectureContext(architecture, prompt);
  const promptWithArchitecture = architectureContext
    ? `${prompt}\n\n${architectureContext}`
    : prompt;
  if (!memory?.recentWork.length) return promptWithArchitecture;

  const promptTerms = new Set(normalizeMemoryTerms(prompt));
  const ranked = memory.recentWork
    .map((entry, index) => ({
      entry,
      index,
      score: normalizeMemoryTerms(`${entry.title} ${entry.summary} ${entry.changedFiles.join(' ')}`)
        .reduce((total, term) => total + (promptTerms.has(term) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const matching = ranked.filter((candidate) => candidate.score > 0);
  const relevant = (matching.length > 0 ? matching : ranked.slice(0, 1))
    .slice(0, 3)
    .map(({ entry }) => [
      `- ${entry.title}: ${entry.summary.slice(0, 600)}`,
      entry.changedFiles.length ? `  Changed files: ${entry.changedFiles.slice(0, 12).join(', ')}` : '',
      entry.commitSha ? `  Commit: ${entry.commitSha}` : ''
    ].filter(Boolean).join('\n'));

  return [
    promptWithArchitecture,
    'Project memory (supporting context only; inspect the current repository and prefer it when memory is stale):',
    ...relevant,
    memory.baseCommitSha ? `Last recorded successful commit: ${memory.baseCommitSha}` : ''
  ].filter(Boolean).join('\n\n').slice(0, prompt.length + 8_000);
}

export function formatProjectArchitectureContext(
  architecture: ProjectArchitecture | undefined,
  focus = ''
): string {
  if (!architecture) return '';
  const focusTerms = new Set(normalizeMemoryTerms(focus));
  const modules = architecture.modules
    .map((module, index) => ({
      module,
      index,
      score: normalizeMemoryTerms(`${module.name} ${module.responsibility} ${module.paths.join(' ')} ${module.publicInterfaces.join(' ')}`)
        .reduce((total, term) => total + (focusTerms.has(term) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const relevantModules = (modules.some((item) => item.score > 0)
    ? modules.filter((item) => item.score > 0)
    : modules.slice(0, 3)).slice(0, 6);

  return [
    'Project architecture (binding boundaries; inspect the repository and update through architectureUpdate when this task intentionally changes them):',
    architecture.summary,
    architecture.dependencyRules.length ? `Dependency rules:\n${architecture.dependencyRules.map((item) => `- ${item}`).join('\n')}` : '',
    architecture.conventions.length ? `Conventions:\n${architecture.conventions.map((item) => `- ${item}`).join('\n')}` : '',
    relevantModules.length ? `Relevant modules:\n${relevantModules.map(({ module }) => [
      `- ${module.name}: ${module.responsibility}`,
      module.paths.length ? `  Paths: ${module.paths.join(', ')}` : '',
      module.publicInterfaces.length ? `  Public interfaces: ${module.publicInterfaces.join(', ')}` : '',
      module.dependencies.length ? `  Allowed dependencies: ${module.dependencies.join(', ')}` : ''
    ].filter(Boolean).join('\n')).join('\n')}` : '',
    architecture.decisions.length ? `Recent architecture decisions:\n${architecture.decisions.slice(-5).map((item) => `- ${item.summary}: ${item.rationale}`).join('\n')}` : '',
    architecture.knownDebt.length ? `Known architecture debt (do not expand unintentionally):\n${architecture.knownDebt.slice(-8).map((item) => `- ${item}`).join('\n')}` : '',
    architecture.validationCommands.length ? `Architecture validation commands to include when applicable:\n${architecture.validationCommands.map((item) => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n').slice(0, 6_000);
}

function normalizeMemoryTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);
}

export function createRoadmapTaskPlan(prompt: string): PlanResult | undefined {
  if (
    !prompt.includes('Current implementation step:')
    || !prompt.includes('Step description and scope:')
    || !prompt.includes('Execution boundary:')
  ) {
    return undefined;
  }

  const title = readPromptSection(prompt, 'Current implementation step:');
  const description = readPromptSection(prompt, 'Step description and scope:');
  if (!title || !description) {
    return undefined;
  }

  const acceptanceCriteria = readPromptSection(prompt, 'Acceptance Criteria:')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);

  return {
    summary: `Implement roadmap step: ${title}`,
    steps: [description],
    acceptanceCriteria,
    validationChecks: []
  };
}

function readPromptSection(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start < 0) return '';

  const sectionStart = start + heading.length;
  const remainder = prompt.slice(sectionStart).replace(/^\s*\r?\n?/, '');
  const nextHeading = remainder.search(/\r?\n\r?\n(?=[A-Z][^\r\n]*:)/);
  return (nextHeading < 0 ? remainder : remainder.slice(0, nextHeading)).trim();
}

function buildValidationRevisionContext(failedCheck: ValidationCheck, previousDecisionError?: string): string {
  return [
    'Diagnose the single failed validation check. Do not create or repeat a general implementation plan.',
    'Inspect the repository and decide whether the check is wrong, the implementation must be repaired, or progress is genuinely blocked.',
    'Return replacement validationChecks only when validationRecovery.action is replace_validation_check.',
    'Do not repeat successful or unrelated checks.',
    'Return only executable replacement checks that verify a criterion through their exit code.',
    'Do not use shell redirection or fallback command chains in validation commands.',
    'Do not modify repository files during this diagnosis.',
    `Failed check: ${failedCheck.command}`,
    `Criterion: ${failedCheck.criterion ?? 'Preserve the criterion of the failed check.'}`,
    previousDecisionError ? `Correction required: ${previousDecisionError}` : ''
  ].filter(Boolean).join('\n');
}

function normalizeValidationRecoveryDecision(plan: PlanResult): PlanResult['validationRecovery'] | undefined {
  const decision = plan.validationRecovery;
  if (!decision || typeof decision.rationale !== 'string' || !decision.rationale.trim()) {
    return undefined;
  }
  if (
    decision.action !== 'replace_validation_check'
    && decision.action !== 'repair_implementation'
    && decision.action !== 'blocked'
  ) {
    return undefined;
  }
  return { action: decision.action, rationale: decision.rationale.trim() };
}

function findFailedValidationCheck(
  checks: ValidationCheck[],
  failingCommand?: string
): Extract<ValidationCheck, { kind: 'command' }> | undefined {
  if (!failingCommand) {
    return undefined;
  }
  const failingKey = normalizeValidationCommandForEnvironment(failingCommand);
  return checks.find((check): check is Extract<ValidationCheck, { kind: 'command' }> => (
    check.kind === 'command'
    && normalizeValidationCommandForEnvironment(check.command) === failingKey
  ));
}

export function replaceFailedValidationCheck(
  currentChecks: ValidationCheck[],
  failingCommand: string | undefined,
  proposedChecks: unknown
): ValidationCheck[] | undefined {
  const failedCheck = findFailedValidationCheck(currentChecks, failingCommand);
  if (!failedCheck || !failingCommand) {
    return undefined;
  }

  const failedIndex = currentChecks.indexOf(failedCheck);
  const existingOtherIdentities = new Set(
    currentChecks
      .filter((_, index) => index !== failedIndex)
      .map(validationCheckIdentity)
  );
  const failedIdentity = validationCheckIdentity(failedCheck);
  const distinctProposals = normalizeValidationChecks(proposedChecks).filter((check) => (
    validationCheckIdentity(check) !== failedIdentity
  ));
  if (distinctProposals.length === 0) {
    return undefined;
  }
  const replacements = distinctProposals.filter((check) => {
    const identity = validationCheckIdentity(check);
    return !existingOtherIdentities.has(identity);
  });

  return [
    ...currentChecks.slice(0, failedIndex),
    ...replacements,
    ...currentChecks.slice(failedIndex + 1)
  ];
}

function validationCheckIdentity(check: ValidationCheck): string {
  return `command:${normalizeValidationCommandForEnvironment(check.command)}`;
}

export async function resolveValidationChecks(input: {
  plan: PlanResult;
  installCommand?: string;
  architectureCommands?: string[];
  validationProfile?: ProjectValidationProfile;
  workspacePath?: string;
}): Promise<ValidationCheck[]> {
  let checks = normalizeValidationChecks(input.plan.validationChecks);

  const architectureChecks = (input.architectureCommands ?? [])
    .map((command) => command.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((command): ValidationCheck => ({
      kind: 'command',
      command,
      criterion: 'Project architecture boundaries remain valid.',
      rationale: 'Persisted project architecture validation command.'
    }));
  checks = deduplicateValidationChecks([...checks, ...architectureChecks]);

  const installCommand = input.installCommand?.trim();
  if (installCommand && !checks.some((check) => check.command.trim() === installCommand)) {
    checks = [{
      kind: 'command',
      command: installCommand,
      category: 'setup',
      rationale: 'Configured repository dependency installation command.'
    }, ...checks];
  }

  const profiledChecks = input.validationProfile?.enabled
    ? await applyProjectValidationProfile(checks, input.validationProfile, input.workspacePath)
    : checks;
  return orderValidationChecksByPrerequisite(
    deduplicateValidationChecks(profiledChecks),
    input.workspacePath
  );
}

async function orderValidationChecksByPrerequisite(
  checks: ValidationCheck[],
  workspacePath?: string
): Promise<ValidationCheck[]> {
  const ordered = [...checks];
  const configuredPresets = await readCmakeConfigurePresets(workspacePath);
  const consumedPresets = uniqueStrings(ordered.flatMap((check) => extractConsumedCmakePresets(check.command)));

  for (const preset of consumedPresets) {
    let consumerIndex = ordered.findIndex((check) => extractConsumedCmakePresets(check.command).includes(preset));
    if (consumerIndex < 0) continue;
    const producerIndex = ordered.findIndex((check) => extractConfiguredCmakePresets(check.command).includes(preset));
    if (producerIndex < 0 && configuredPresets.has(preset)) {
      ordered.splice(consumerIndex, 0, {
        kind: 'command',
        command: `cmake --preset ${/^[a-zA-Z0-9_.-]+$/.test(preset) ? preset : quoteCommandArgument(preset)}`,
        category: 'setup',
        criterion: `Configure the CMake preset "${preset}" before build and CTest commands.`,
        rationale: 'Required prerequisite inferred from the committed CMake configure preset.'
      });
      continue;
    }
    if (producerIndex > consumerIndex) {
      const [producer] = ordered.splice(producerIndex, 1);
      ordered.splice(consumerIndex, 0, producer!);
    }
  }

  return deduplicateValidationChecks(ordered);
}

async function readCmakeConfigurePresets(workspacePath?: string): Promise<Set<string>> {
  const names = new Set<string>();
  if (!workspacePath) return names;
  for (const fileName of ['CMakePresets.json', 'CMakeUserPresets.json']) {
    try {
      const parsed = JSON.parse(await readFile(join(workspacePath, fileName), 'utf8')) as {
        configurePresets?: Array<{ name?: unknown }>;
      };
      for (const preset of parsed.configurePresets ?? []) {
        if (typeof preset.name === 'string' && preset.name.trim()) names.add(preset.name.trim());
      }
    } catch {
      // Missing or non-JSON preset files cannot provide a deterministic prerequisite.
    }
  }
  return names;
}

function extractConfiguredCmakePresets(command: string): string[] {
  return extractCmakePresetArguments(command, /(?:^|\s)cmake\s+--preset(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s&]+))/i);
}

function extractConsumedCmakePresets(command: string): string[] {
  return uniqueStrings([
    ...extractCmakePresetArguments(command, /(?:^|\s)cmake\s+--build\s+--preset(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s&]+))/i),
    ...extractCmakePresetArguments(command, /(?:^|\s)ctest\s+--preset(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s&]+))/i)
  ]);
}

function extractCmakePresetArguments(command: string, pattern: RegExp): string[] {
  return splitValidationConjunctions(command).flatMap((segment) => {
    const match = segment.match(pattern);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    return value?.trim() ? [value.trim()] : [];
  });
}

export function deduplicateValidationChecks(checks: ValidationCheck[]): ValidationCheck[] {
  const exact = checks.filter((check, index, all) => {
    const identity = validationCheckIdentity(check);
    return all.findIndex((candidate) => validationCheckIdentity(candidate) === identity) === index;
  });
  const segments = exact.map((check) => splitValidationConjunctions(check.command));
  return exact.filter((_check, index) => !segments.some((coveringSegments, coveringIndex) => {
    if (coveringIndex === index || coveringSegments.length <= segments[index]!.length) return false;
    return segments[index]!.every((segment) => coveringSegments.includes(segment));
  }));
}

function mergeValidationCheckUpdates(
  currentChecks: ValidationCheck[],
  proposedChecks: ValidationCheck[]
): ValidationCheck[] {
  const merged = [...currentChecks];
  for (const proposed of proposedChecks) {
    const existingIndex = merged.findIndex((check) => validationCheckIdentity(check) === validationCheckIdentity(proposed));
    if (existingIndex < 0) {
      merged.push(proposed);
      continue;
    }

    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      ...proposed,
      category: proposed.category ?? existing.category,
      criterion: proposed.criterion ?? existing.criterion,
      rationale: proposed.rationale ?? existing.rationale,
      timeoutMinutes: proposed.timeoutMinutes ?? existing.timeoutMinutes,
      requiredCapabilities: proposed.requiredCapabilities ?? existing.requiredCapabilities
    };
  }
  return deduplicateValidationChecks(merged);
}

function splitValidationConjunctions(command: string): string[] {
  const parts: string[] = [];
  let part = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      part += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      part += character;
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      part += character;
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      part += character;
      continue;
    }
    if (!quote && character === '&' && command[index + 1] === '&') {
      if (part.trim()) parts.push(normalizeValidationCommandForEnvironment(part.trim()));
      part = '';
      index += 1;
      continue;
    }
    part += character;
  }
  if (part.trim()) parts.push(normalizeValidationCommandForEnvironment(part.trim()));
  return parts;
}

async function applyProjectValidationProfile(
  checks: ValidationCheck[],
  profile: ProjectValidationProfile,
  workspacePath?: string
): Promise<ValidationCheck[]> {
  const validationEnvironment = createValidationEnvironment();
  const missingVariables = profile.requiredEnvironmentVariables.filter((name) => !validationEnvironment[name]);
  if (missingVariables.length > 0) {
    throw new Error(`Validation environment is missing required variables: ${missingVariables.join(', ')}`);
  }

  const preparation: ValidationCheck[] = [];
  if (profile.dockerComposeFiles.length > 0 || profile.dockerComposeServices.length > 0) {
    if (!workspacePath) {
      throw new Error('Workspace path is required for Docker Compose validation.');
    }
    const composeArguments: string[] = [];
    for (const file of profile.dockerComposeFiles) {
      const resolvedFile = resolve(workspacePath, file);
      const relativeFile = relative(resolve(workspacePath), resolvedFile);
      if (!relativeFile || isAbsolute(file) || isAbsolute(relativeFile) || relativeFile.startsWith('..')) {
        throw new Error(`Docker Compose file must be a workspace-relative path: ${file}`);
      }
      if (!await pathExists(resolve(workspacePath, file))) {
        throw new Error(`Docker Compose file does not exist in the workspace: ${file}`);
      }
      composeArguments.push('-f', quoteCommandArgument(file.replace(/\\/g, '/')));
    }
    for (const service of profile.dockerComposeServices) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)) {
        throw new Error(`Invalid Docker Compose service name: ${service}`);
      }
    }
    preparation.push({
      kind: 'command',
      command: ['docker compose', ...composeArguments, 'up -d --wait', ...profile.dockerComposeServices].join(' '),
      category: 'setup',
      timeoutMinutes: profile.commandTimeoutMinutes,
      rationale: 'ForgeMind project validation environment.'
    });
  }
  preparation.push(...profile.migrationCommands.map((command): ValidationCheck => ({
    kind: 'command', command, category: 'database', timeoutMinutes: profile.commandTimeoutMinutes,
    rationale: 'Configured project validation database migration.'
  })));
  preparation.push(...profile.readinessCommands.map((command): ValidationCheck => ({
    kind: 'command', command, category: 'smoke', timeoutMinutes: profile.commandTimeoutMinutes,
    rationale: 'Configured project validation readiness check.'
  })));

  const setupEnd = checks.findIndex((check) => check.category !== 'setup');
  const splitAt = setupEnd < 0 ? checks.length : setupEnd;
  return [...checks.slice(0, splitAt), ...preparation, ...checks.slice(splitAt)]
    .filter((check, index, all) => all.findIndex((candidate) => candidate.command === check.command) === index);
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function collectValidationInputHash(git: SimpleGit, workspacePath: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    hash.update(await git.diff(['HEAD', '--binary']));
  } catch {
    hash.update(await git.diff(['--binary']));
  }
  const status = await git.status();
  for (const path of [...status.not_added].sort()) {
    hash.update(path);
    try {
      hash.update(await readFile(resolve(workspacePath, path)));
    } catch {
      hash.update('[unreadable]');
    }
  }
  return hash.digest('hex');
}

async function collectRepositoryStateInputHash(git: SimpleGit, workspacePath: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    hash.update((await git.revparse(['HEAD^{tree}'])).trim());
  } catch {
    hash.update('[no-head]');
  }
  hash.update('\0');
  hash.update(await collectValidationInputHash(git, workspacePath));
  return hash.digest('hex');
}

async function collectSatisfactionReviewInputHash(
  git: SimpleGit,
  workspacePath: string,
  taskPrompt: string,
  acceptanceCriteria: string[],
  evidenceFiles: string[]
): Promise<string> {
  return createHash('sha256').update(JSON.stringify({
    repositoryStateHash: await collectRepositoryStateInputHash(git, workspacePath),
    taskPrompt,
    acceptanceCriteria,
    evidenceFiles
  })).digest('hex');
}

function hashCheckpointValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export async function inferRepositoryInstallCommand(workspacePath: string): Promise<string | undefined> {
  const commands: string[] = [];
  if (await pathExists(join(workspacePath, 'package.json')) && !await pathExists(join(workspacePath, 'node_modules'))) {
    if (
      await pathExists(join(workspacePath, 'package-lock.json'))
      || await pathExists(join(workspacePath, 'npm-shrinkwrap.json'))
    ) {
      commands.push('npm ci');
    } else if (await pathExists(join(workspacePath, 'pnpm-lock.yaml'))) {
      commands.push('corepack pnpm install --frozen-lockfile');
    } else if (await pathExists(join(workspacePath, 'yarn.lock'))) {
      const packageManager = await readPackageManager(workspacePath);
      commands.push(packageManager?.startsWith('yarn@1.')
        ? 'corepack yarn install --frozen-lockfile'
        : 'corepack yarn install --immutable');
    } else if (
      await pathExists(join(workspacePath, 'bun.lock'))
      || await pathExists(join(workspacePath, 'bun.lockb'))
    ) {
      commands.push('bun install --frozen-lockfile');
    }
  }

  const pythonRequirements = await firstExistingPath(workspacePath, [
    'requirements-dev.lock',
    'requirements.lock',
    'requirements-dev.txt',
    'requirements.txt'
  ]);
  if (pythonRequirements) {
    const virtualEnvironmentPython = process.platform === 'win32'
      ? '.venv\\Scripts\\python.exe'
      : '.venv/bin/python';
    commands.push(
      `python3 -m venv .venv && ${virtualEnvironmentPython} -m pip install --disable-pip-version-check -r ${pythonRequirements}`
    );
  }

  return commands.length > 0 ? commands.join(' && ') : undefined;
}

async function firstExistingPath(workspacePath: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathExists(join(workspacePath, candidate))) return candidate;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageManager(workspacePath: string): Promise<string | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(join(workspacePath, 'package.json'), 'utf8')) as { packageManager?: unknown };
    return typeof packageJson.packageManager === 'string' ? packageJson.packageManager : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeValidationChecks(value: unknown): ValidationCheck[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const checks: ValidationCheck[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    if (item.kind === 'command' && typeof item.command === 'string' && item.command.trim()) {
      const command = item.command.trim();
      if (isInspectionOnlyValidationCommand(command)) {
        continue;
      }
      checks.push({
        kind: 'command',
        command,
        category: item.category === 'setup' || item.category === 'build' || item.category === 'database' || item.category === 'api' || item.category === 'browser' || item.category === 'smoke'
          ? item.category
          : undefined,
        criterion: typeof item.criterion === 'string' && item.criterion.trim() ? item.criterion.trim() : undefined,
        rationale: typeof item.rationale === 'string' && item.rationale.trim() ? item.rationale.trim() : undefined,
        requiredCapabilities: Array.isArray(item.requiredCapabilities)
          ? Array.from(new Set(item.requiredCapabilities
              .filter((capability: unknown): capability is string => typeof capability === 'string')
              .map((capability: string) => capability.trim().toLowerCase())
              .filter(Boolean)))
          : undefined
      });
      continue;
    }

  }

  return checks;
}

function validationChecksToJson(checks: ValidationCheck[]): JsonValue[] {
  return checks.map((check) => ({
    kind: check.kind,
    command: check.command,
    category: check.category ?? null,
    criterion: check.criterion ?? null,
    rationale: check.rationale ?? null,
    requiredCapabilities: check.requiredCapabilities ?? []
  }));
}

export function isInspectionOnlyValidationCommand(command: string): boolean {
  const normalized = command.trim();
  if (/^git\s+(?:status|log|show)\b/i.test(normalized)) {
    return true;
  }

  return /^git\s+diff\b/i.test(normalized)
    && !/--(?:exit-code|quiet)\b/i.test(normalized)
    && !/\|\s*(?:grep|findstr|select-string)\b/i.test(normalized);
}

function summarizeValidationChecks(checks: ValidationCheck[]): string {
  const commands = checks.map((check) => check.command);
  return commands.length > 0 ? commands.join(' && ') : 'no-executable-checks';
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
  action: () => Promise<T>,
  signal?: AbortSignal,
  completedOutput?: (result: T) => JsonValue
): Promise<T> {
  throwIfTaskAborted(signal);
  const startedAt = Date.now();
  const label = describeGitHubOperation(operation);
  const phase = operation === 'commit_and_push' ? 'git' : 'github';
  const inputHash = hashCheckpointValue(JSON.stringify(context ?? null));
  await hooks?.onCheckpoint?.({
    key: `external:${operation}`,
    phase,
    status: 'started',
    inputHash,
    output: context
  });
  await emitTaskActivity(hooks, {
    phase,
    state: 'started',
    title: label.started,
    operation
  });
  try {
    const result = await action();
    throwIfTaskAborted(signal);
    await emitTaskActivity(hooks, {
      phase,
      state: 'completed',
      title: label.completed,
      operation,
      elapsedMs: Date.now() - startedAt
    });
    await hooks?.onCheckpoint?.({
      key: `external:${operation}`,
      phase,
      status: 'completed',
      inputHash,
      output: completedOutput ? completedOutput(result) : context
    });
    return result;
  } catch (error) {
    await emitTaskActivity(hooks, {
      phase,
      state: 'failed',
      title: label.failed,
      detail: toErrorMessage(error),
      operation,
      elapsedMs: Date.now() - startedAt
    });
    await hooks?.onCheckpoint?.({
      key: `external:${operation}`,
      phase,
      status: 'failed',
      inputHash,
      output: context,
      errorMessage: toErrorMessage(error)
    });
    await hooks?.onGitHubOperationFailed?.({
      operation,
      errorMessage: toErrorMessage(error),
      context
    });
    throw error;
  }
}

async function emitSkippedExternalEffect(
  hooks: WorkerTaskHooks | undefined,
  operation: GitHubOperation | 'commit',
  phase: TaskActivity['phase'],
  attempt: number,
  metadata?: JsonValue
): Promise<void> {
  await emitTaskActivity(hooks, {
    phase,
    state: 'completed',
    title: `${describeExternalEffectForAudit(operation)} was skipped from checkpoint`,
    detail: 'Checkpoint-safe retry reused a completed external effect.',
    operation,
    attempt,
    elapsedMs: 0,
    metadata: skippedExternalEffectMetadata(metadata)
  });
}

function skippedExternalEffectMetadata(metadata?: JsonValue): JsonValue {
  const base: Record<string, JsonValue> = { retryDecision: 'skip_completed_external_effect' };
  if (metadata === undefined) return base;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return { ...base, ...metadata };
  }
  return { ...base, value: metadata };
}

function describeExternalEffectForAudit(operation: GitHubOperation | 'commit'): string {
  switch (operation) {
    case 'commit':
      return 'Git commit';
    case 'commit_and_push':
      return 'Git push';
    case 'comment_on_issue':
      return 'GitHub issue comment';
    case 'wait_for_checks':
      return 'GitHub checks wait';
    case 'merge_pr':
      return 'GitHub merge';
    default:
      return describeGitHubOperation(operation).completed;
  }
}

function requiresPullRequestIntegration(config: WorkerConfig, project: Project): boolean {
  return config.createPullRequest && Boolean(project.githubOwner && project.githubRepo);
}

function isGitHubInfrastructureFailure(checks: GitHubChecksResult): boolean {
  const message = [checks.summary, ...checks.failures.map((failure) => failure.output)].join('\n');
  return /job was not started|account payments? (?:have )?failed|spending limit|billing (?:issue|problem|limit)|hosted runner.*(?:unavailable|quota)|no hosted compute minutes/i.test(message);
}

async function emitTaskActivity(hooks: WorkerTaskHooks | undefined, activity: TaskActivity): Promise<void> {
  await hooks?.onActivity?.(activity);
}

function describeGitHubOperation(operation: GitHubOperation) {
  const labels: Record<GitHubOperation, { started: string; completed: string; failed: string }> = {
    create_issue: {
      started: 'Vytvářím GitHub issue',
      completed: 'GitHub issue je připravené',
      failed: 'Vytvoření GitHub issue selhalo'
    },
    create_branch: {
      started: 'Vytvářím pracovní branch',
      completed: 'Pracovní branch je připravená',
      failed: 'Vytvoření branche selhalo'
    },
    commit_and_push: {
      started: 'Odesílám změny na GitHub',
      completed: 'Změny jsou na GitHubu',
      failed: 'Odeslání změn selhalo'
    },
    create_draft_pr: {
      started: 'Vytvářím draft pull request',
      completed: 'Draft pull request je připravený',
      failed: 'Vytvoření pull requestu selhalo'
    },
    create_pull_request: {
      started: 'Vytvářím pull request',
      completed: 'Pull request je připravený',
      failed: 'Vytvoření pull requestu selhalo'
    },
    wait_for_checks: {
      started: 'Čekám na GitHub Actions',
      completed: 'GitHub Actions je dokončené',
      failed: 'GitHub Actions selhalo'
    },
    merge_pr: {
      started: 'Slučuji pull request',
      completed: 'Pull request je sloučený',
      failed: 'Sloučení pull requestu selhalo'
    },
    comment_on_issue: {
      started: 'Aktualizuji GitHub issue',
      completed: 'GitHub issue je aktualizované',
      failed: 'Aktualizace GitHub issue selhala'
    }
  };
  return labels[operation];
}

interface WorkerConfig {
  providerKind: ProviderKind;
  mode: TaskMode;
  installCommand?: string;
  issueLabel: string;
  branchPrefix: string;
  autoPush: boolean;
  createPullRequest: boolean;
  autoMergePullRequest: boolean;
  autoCompleteTask: boolean;
  createBranch: boolean;
  createIssue: boolean;
  requireCiGreen: boolean;
  approvalRequiredFor: Set<ApprovalType>;
  allowSafeOperationsWithoutApproval: boolean;
  sandbox: {
    allowNetwork: boolean;
    allowSudo: boolean;
    forbiddenPaths: string[];
  };
}

interface CanonicalForbiddenPath {
  resolvedPath?: string;
  pattern?: RegExp;
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
    installCommand: config?.commands.install,
    issueLabel: config?.github.issue_label ?? 'ai-task',
    branchPrefix: config?.github.branch_prefix ?? 'ai/',
    autoPush: config?.workflow.auto_push ?? true,
    createPullRequest: project.autoCreatePullRequest ?? config?.workflow.create_draft_pr ?? true,
    autoMergePullRequest: project.autoMergePullRequest ?? config?.workflow.auto_merge ?? false,
    autoCompleteTask: project.autoCompleteTask ?? false,
    createBranch: config?.workflow.create_branch ?? true,
    createIssue: config?.workflow.create_issue ?? true,
    requireCiGreen: config?.github.require_ci_green ?? true,
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

function partitionDeferredValidationCapabilities(
  checks: import('./validation.js').DeferredValidationCheck[]
): { blockingCapabilities: string[]; deferredCapabilities: string[] } {
  const deferredChecks = checks.filter((check) => isNonBlockingDeferredValidation(check.requiredCapabilities));
  const blockingChecks = checks.filter((check) => !isNonBlockingDeferredValidation(check.requiredCapabilities));
  return {
    blockingCapabilities: uniqueStrings(blockingChecks.flatMap((check) => check.missingCapabilities)),
    deferredCapabilities: uniqueStrings(deferredChecks.flatMap((check) => check.requiredCapabilities))
  };
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
    if (!sandbox.allowSudo && /(^|\s)sudo(\s|$)/i.test(check.command)) {
      approvals.push('config_change');
    }

    if (!sandbox.allowNetwork && /\b(curl|wget|invoke-webrequest|iwr|ncat|netcat|telnet)\b/i.test(check.command)) {
      approvals.push('config_change');
    }
  }

  return uniqueApprovals(approvals);
}

async function applyImplementationPolicy(
  implementation: ImplementResult,
  workspacePath: string,
  sandbox: {
    forbiddenPaths: string[];
  }
): Promise<ImplementResult> {
  const normalizedApprovals = normalizeRuntimeApprovals(implementation.requestedApprovals);
  if (!implementation.fileUpdates?.length) {
    return {
      ...implementation,
      requestedApprovals: normalizedApprovals
    };
  }

  const workspaceRoot = await canonicalizeWorkerPath(workspacePath);
  const approvals: ApprovalType[] = [...normalizedApprovals];
  const forbiddenPaths = await Promise.all(
    uniqueStrings(['/var/run/docker.sock', ...sandbox.forbiddenPaths])
      .map((item) => canonicalizeForbiddenPolicyPath(item, workspaceRoot))
  );
  const filteredUpdates: NonNullable<ImplementResult['fileUpdates']> = [];
  for (const file of implementation.fileUpdates) {
    if (isAbsolute(file.path)) {
      approvals.push('write_outside_repo');
      continue;
    }

    const target = await canonicalizeWorkerPath(resolve(workspaceRoot, file.path));
    if (!isWorkerPathInside(workspaceRoot, target)) {
      approvals.push('write_outside_repo');
      continue;
    }

    const normalized = file.path.replace(/\\/g, '/').toLowerCase();
    const touchesWorkflow = normalized.startsWith('.github/workflows/');
    if (touchesWorkflow) {
      approvals.push('github_workflow_change');
    }

    const forbiddenMatch = forbiddenPaths.some((forbiddenPath) => matchesWorkerForbiddenPath(forbiddenPath, target));
    if (forbiddenMatch) {
      approvals.push('write_outside_repo');
      continue;
    }

    filteredUpdates.push(file);
  }

  return {
    ...implementation,
    fileUpdates: filteredUpdates,
    requestedApprovals: uniqueApprovals(approvals)
  };
}

async function canonicalizeForbiddenPolicyPath(path: string, workspaceRoot: string): Promise<CanonicalForbiddenPath> {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('*')) {
    const absolutePattern = isAbsolute(path) ? normalized : resolve(workspaceRoot, normalized).replace(/\\/g, '/');
    return { pattern: workerWildcardPathPattern(absolutePattern) };
  }
  return { resolvedPath: await canonicalizeWorkerPath(isAbsolute(path) ? path : resolve(workspaceRoot, path)) };
}

async function canonicalizeWorkerPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = await nearestExistingWorkerParent(path);
    const relativeTail = relative(parent.originalPath, resolve(path));
    return resolve(parent.realPath, relativeTail);
  }
}

async function nearestExistingWorkerParent(path: string): Promise<{ originalPath: string; realPath: string }> {
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      return { originalPath: current, realPath: await realpath(current) };
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return { originalPath: current, realPath: current };
      current = parent;
    }
  }
}

function isWorkerPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isWorkerPathSameOrDescendant(parent: string, child: string): boolean {
  return isWorkerPathInside(parent, child) || isWorkerPathInside(child, parent);
}

function matchesWorkerForbiddenPath(forbiddenPath: CanonicalForbiddenPath, resolvedPath: string): boolean {
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  if (forbiddenPath.pattern?.test(normalizedPath)) return true;
  return Boolean(forbiddenPath.resolvedPath && isWorkerPathSameOrDescendant(forbiddenPath.resolvedPath, resolvedPath));
}

function workerWildcardPathPattern(path: string): RegExp {
  const escaped = path
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}(?:/|$)`);
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

function normalizeReviewAfterValidation(
  review: ReviewResult,
  deferredChecks: import('./validation.js').DeferredValidationCheck[] = []
): ReviewResult {
  const blockers = review.blockers.filter((blocker) => (
    !isValidationExecutionLimitationBlocker(blocker)
    && !isDeferredValidationOnlyBlocker(blocker, deferredChecks)
  ));
  return {
    ...review,
    blockers
  };
}

function normalizeSatisfactionReview(
  review: ReviewResult,
  acceptanceCriteria: string[],
  evidenceErrors: string[],
  deferredCriteria: ReadonlySet<string> = new Set()
): ReviewResult {
  const blockers = [...review.blockers, ...evidenceErrors];
  const results = review.criterionResults ?? [];
  const byCriterion = new Map<string, typeof results>();
  for (const result of results) {
    const key = result.criterion.trim();
    if (!acceptanceCriteria.some((criterion) => criterion.trim() === key)) {
      blockers.push(`Existing-state review evaluated an unknown acceptance criterion: ${result.criterion}`);
    }
    byCriterion.set(key, [...(byCriterion.get(key) ?? []), result]);
  }

  for (const criterion of acceptanceCriteria) {
    const matches = byCriterion.get(criterion.trim()) ?? [];
    if (matches.length !== 1) {
      blockers.push(matches.length === 0
        ? `Existing-state review did not evaluate acceptance criterion: ${criterion}`
        : `Existing-state review returned duplicate verdicts for acceptance criterion: ${criterion}`);
      continue;
    }
    const verdict = matches[0]!;
    if (verdict.status === 'deferred' && deferredCriteria.has(criterion.trim())) {
      continue;
    }
    if (verdict.status !== 'satisfied') {
      blockers.push(`Acceptance criterion is ${verdict.status}: ${criterion}`);
    } else if (verdict.evidence.length === 0 || verdict.evidence.every((item) => !item.trim())) {
      blockers.push(`Acceptance criterion has no concrete evidence: ${criterion}`);
    }
  }

  return { ...review, blockers: uniqueStrings(blockers) };
}

function isDeferredValidationOnlyBlocker(
  blocker: string,
  deferredChecks: import('./validation.js').DeferredValidationCheck[]
): boolean {
  return deferredChecksMatchingBlocker(blocker, deferredChecks).length > 0;
}

function deferredChecksMatchingBlocker(
  blocker: string,
  deferredChecks: import('./validation.js').DeferredValidationCheck[]
): import('./validation.js').DeferredValidationCheck[] {
  if (deferredChecks.length === 0) return [];
  const normalized = blocker.toLowerCase();
  const describesMissingEvidence = (
    /\b(?:cannot|can't|could not|unable to)\b.*\b(?:verify|validate|run|execute|access)\b/.test(normalized)
    || /\b(?:unavailable|not available|not verified|not run|blocked)\b/.test(normalized)
    || /\bmissing\b.*\b(?:evidence|artifact|runtime|capabilit(?:y|ies)|worker|environment)\b/.test(normalized)
  );
  if (!describesMissingEvidence) return [];
  return deferredChecks.filter((check) => [
    check.criterion,
    ...check.requiredCapabilities,
    ...check.missingCapabilities
  ].filter(Boolean).some((token) => normalized.includes(String(token).toLowerCase())));
}

function isValidationExecutionLimitationBlocker(blocker: string): boolean {
  const normalized = blocker.toLowerCase();
  const mentionsVerificationGap =
    /\b(unable to verify|could not verify|cannot verify|can't verify|failed to verify)\b/.test(normalized)
    || /\b(could not run|cannot run|can't run|was blocked)\b/.test(normalized)
    || /\b(could not|cannot|can't|unable to)\b.*\b(inspect|read|access)\b/.test(normalized);
  const mentionsExecutionConstraint =
    /\b(read-only|readonly|sandbox|policy|environment)\b/.test(normalized)
    || /\b(node|npm|pnpm|yarn|vite|build commands?|bwrap|namespace|permissions?)\b/.test(normalized);

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

async function writeAgentsInstructions(
  workspacePath: string,
  project: Project,
  task: ForgeTask,
  executionPrompt: string,
  configYaml?: string
) {
  const agentsPath = join(workspacePath, 'AGENTS.md');
  if (await pathExists(agentsPath)) {
    return undefined;
  }

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
    `- mode: ${task.mode}`,
    `- max iterations: ${task.maxIterations}`,
    '',
    '## Current Step Context',
    executionPrompt,
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
  } else {
    lines.push('## Agent Configuration', '- no project config provided, using defaults');
  }

  const generatedContent = lines.join('\n');
  await writeFile(agentsPath, generatedContent, 'utf8');
  return async () => {
    try {
      if (await readFile(agentsPath, 'utf8') === generatedContent) {
        await unlink(agentsPath);
      }
    } catch {
      // The provider may have removed the temporary instructions itself.
    }
  };
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

const MAX_REVIEW_DIFF_CHARS = 120_000;
const MAX_SATISFACTION_EVIDENCE_FILES = 12;
const MAX_SATISFACTION_EVIDENCE_CHARS = 48_000;
const MAX_SATISFACTION_FILE_CHARS = 8_000;

async function collectSatisfactionEvidence(
  git: SimpleGit,
  workspacePath: string,
  requestedPaths: string[]
): Promise<{ files: string[]; packet: string; errors: string[] }> {
  const trackedPaths = (await git.raw(['ls-files']))
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  const trackedByNormalizedPath = new Map(trackedPaths.map((path) => [normalizeRepoPath(path), path]));
  const requested = uniqueStrings(requestedPaths.map((path) => path.trim()).filter(Boolean));
  const errors: string[] = [];
  if (requested.length > MAX_SATISFACTION_EVIDENCE_FILES) {
    errors.push(`Existing-state evidence lists ${requested.length} files; at most ${MAX_SATISFACTION_EVIDENCE_FILES} are allowed.`);
  }

  const files: string[] = [];
  const sections: string[] = [];
  let remaining = MAX_SATISFACTION_EVIDENCE_CHARS;
  const workspaceRoot = resolve(workspacePath);
  for (const requestedPath of requested.slice(0, MAX_SATISFACTION_EVIDENCE_FILES)) {
    if (isAbsolute(requestedPath)) {
      errors.push(`Evidence file must be repository-relative: ${requestedPath}`);
      continue;
    }
    const trackedPath = trackedByNormalizedPath.get(normalizeRepoPath(requestedPath));
    if (!trackedPath || !isSubstantiveImplementationPath(trackedPath)) {
      errors.push(`Evidence file is not a tracked repository file: ${requestedPath}`);
      continue;
    }
    const target = resolve(workspaceRoot, trackedPath);
    const relativeTarget = relative(workspaceRoot, target);
    if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
      errors.push(`Evidence file resolves outside the repository: ${requestedPath}`);
      continue;
    }
    try {
      const content = await readFile(target, 'utf8');
      if (content.includes('\0')) {
        errors.push(`Evidence file is binary and cannot be reviewed: ${trackedPath}`);
        continue;
      }
      if (remaining <= 0) {
        errors.push('Existing-state evidence exceeded the total character limit.');
        break;
      }
      const limit = Math.min(MAX_SATISFACTION_FILE_CHARS, remaining);
      const bounded = content.length > limit
        ? `${content.slice(0, limit)}\n[file truncated: ${content.length} characters total]`
        : content;
      sections.push(`--- ${trackedPath} ---\n${bounded}`);
      files.push(trackedPath);
      remaining -= bounded.length;
    } catch {
      errors.push(`Evidence file could not be read: ${trackedPath}`);
    }
  }

  if (files.length === 0) errors.push('No readable tracked evidence file was supplied for existing-state review.');
  return {
    files,
    packet: sections.join('\n\n'),
    errors: uniqueStrings(errors)
  };
}

async function collectReviewPacket(
  git: SimpleGit,
  workspacePath: string,
  requestedPaths: string[] | undefined,
  baseBranch: string
): Promise<{ changedFiles: string[]; diff: string }> {
  const status = await git.status();
  const requestedPathSet = requestedPaths
    ? new Set(requestedPaths.map(normalizeRepoPath))
    : undefined;
  const workspaceChangedPaths = collectStageablePaths(status)
    .filter(isSubstantiveImplementationPath)
    .filter((path) => !requestedPathSet || requestedPathSet.has(normalizeRepoPath(path)));
  const baseRef = await resolveReviewBaseRef(git, baseBranch);
  const committedPaths = baseRef
    ? (await git.diff(['--name-only', `${baseRef}...HEAD`]))
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean)
        .filter(isSubstantiveImplementationPath)
        .filter((path) => !requestedPathSet || requestedPathSet.has(normalizeRepoPath(path)))
    : [];
  const changedPaths = uniqueStrings([...committedPaths, ...workspaceChangedPaths]);
  const summaryOnlyPaths = changedPaths.filter(isReviewSummaryOnlyPath);
  const reviewPaths = changedPaths.filter((path) => !isReviewSummaryOnlyPath(path));
  const untrackedPaths = new Set(status.not_added.map(normalizeRepoPath));
  const trackedPaths = reviewPaths.filter((path) => !untrackedPaths.has(normalizeRepoPath(path)));
  const sections: string[] = [];

  if (summaryOnlyPaths.length > 0) {
    sections.push([
      '[Generated dependency metadata omitted from detailed review; authoritative validation covers consistency.]',
      ...summaryOnlyPaths.map((path) => `- ${path}`)
    ].join('\n'));
  }

  if (baseRef && trackedPaths.length > 0) {
    try {
      const finalDiff = await git.diff(['--unified=3', baseRef, '--', ...trackedPaths]);
      if (finalDiff.trim()) {
        sections.push(finalDiff);
      }
    } catch {
      // Fall back to the workspace-only diff below when the base ref cannot be compared.
    }
  }

  if (!baseRef && trackedPaths.length > 0) {
    try {
      const trackedDiff = await git.diff(['--unified=3', 'HEAD', '--', ...trackedPaths]);
      if (trackedDiff.trim()) {
        sections.push(trackedDiff);
      }
    } catch {
      // A repository without an initial commit only contains untracked files, handled below.
    }
  }

  for (const path of reviewPaths) {
    if (!untrackedPaths.has(normalizeRepoPath(path))) {
      continue;
    }

    sections.push(await renderUntrackedFileDiff(workspacePath, path));
  }

  return {
    changedFiles: changedPaths,
    diff: truncateReviewDiff(sections.filter(Boolean).join('\n'))
  };
}

async function resolveReviewBaseRef(git: SimpleGit, baseBranch: string): Promise<string | undefined> {
  for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
    try {
      const head = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
      const candidateHead = (await git.raw(['rev-parse', '--verify', `${candidate}^{commit}`])).trim();
      const mergeBase = (await git.raw(['merge-base', candidate, 'HEAD'])).trim();
      if (head !== candidateHead && mergeBase === candidateHead) return candidate;
    } catch {
      // Try the next candidate. Local workspaces do not always have a remote-tracking base branch.
    }
  }
  return undefined;
}

async function collectChangedPathSnapshot(
  git: SimpleGit,
  workspacePath: string
): Promise<Map<string, string>> {
  return collectChangedPathSnapshotFromStatus(await git.status(), workspacePath);
}

async function collectChangedPathSnapshotFromStatus(
  status: StatusResult,
  workspacePath: string
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const path of collectStageablePaths(status).filter(isSubstantiveImplementationPath)) {
    const normalized = normalizeRepoPath(path);
    try {
      snapshot.set(normalized, (await readFile(join(workspacePath, path))).toString('base64'));
    } catch {
      snapshot.set(normalized, '[missing]');
    }
  }
  return snapshot;
}

async function collectSnapshotChanges(
  before: Map<string, string>,
  afterStatus: StatusResult,
  workspacePath: string
): Promise<string[]> {
  const after = await collectChangedPathSnapshotFromStatus(afterStatus, workspacePath);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path));
}

export function isReviewSummaryOnlyPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return normalized === 'package-lock.json'
    || normalized === 'npm-shrinkwrap.json'
    || normalized === 'pnpm-lock.yaml'
    || normalized === 'yarn.lock'
    || normalized === 'bun.lock'
    || normalized === 'bun.lockb';
}

async function renderUntrackedFileDiff(workspacePath: string, path: string): Promise<string> {
  const displayPath = toPortableRepoPath(path);
  try {
    const content = await readFile(join(workspacePath, path), 'utf8');
    const lines = content.length === 0 ? [] : content.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') {
      lines.pop();
    }
    const header = [
      `diff --git a/${displayPath} b/${displayPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${displayPath}`
    ];
    if (lines.length === 0) {
      return header.join('\n');
    }

    return [...header, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
  } catch {
    return `diff --git a/${displayPath} b/${displayPath}\n[unreadable or binary file]`;
  }
}

function truncateReviewDiff(diff: string): string {
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) {
    return diff;
  }

  const retainedChars = Math.floor((MAX_REVIEW_DIFF_CHARS - 100) / 2);
  return [
    diff.slice(0, retainedChars),
    `\n[diff truncated: ${diff.length} characters total]\n`,
    diff.slice(-retainedChars)
  ].join('');
}

async function loadResumedImplementation(
  git: SimpleGit,
  workspacePath: string,
  resume: WorkerTaskResume
): Promise<ImplementResult | undefined> {
  const status = await git.status();
  const workspaceChangedFiles = collectStageablePaths(status).filter(isSubstantiveImplementationPath);
  const changedFiles = uniqueStrings([...workspaceChangedFiles, ...(resume.changedFiles ?? [])]).filter(isSubstantiveImplementationPath);
  if (changedFiles.length === 0 && !resume.diffStat && resume.implementationOutcome !== 'already_satisfied') {
    return undefined;
  }

  return {
    outcome: resume.implementationOutcome,
    summary: resume.implementationSummary,
    changedFiles: uniqueStrings(changedFiles),
    evidenceFiles: resume.evidenceFiles,
    diffStat: workspaceChangedFiles.length > 0
      ? await collectWorkspaceDiffStat(git, workspacePath, status)
      : resume.diffStat ?? { filesChanged: changedFiles.length, insertions: 0, deletions: 0 },
    requestedApprovals: [],
    architectureUpdate: resume.architectureUpdate
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
    syncRemoteBranch?: boolean;
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
    const hasOrigin = remotes.some((item) => item.name === 'origin');
    if (!hasOrigin) {
      await git.addRemote('origin', remoteUrl);
    } else {
      await git.raw(['remote', 'set-url', 'origin', remoteUrl]);
    }
    await git.fetch('origin');
  }

  await configureWorkspaceGitIdentity(git);
  await removeStaleGeneratedInstructionsBeforeCheckout(git, workspacePath);
  await checkoutWorkspaceBranch(git, branchName, Boolean(remoteUrl));
  const resumedSync = options?.syncRemoteBranch && remoteUrl
    ? await fastForwardCleanWorkspaceToRemote(git, branchName)
    : undefined;
  return { git, resumedSync };
}

async function fastForwardCleanWorkspaceToRemote(
  git: SimpleGit,
  branchName: string
): Promise<ResumedWorkspaceSync | undefined> {
  const status = await git.status();

  const remoteRef = `origin/${branchName}`;
  const branches = await git.branch(['-r']);
  if (!branches.all.includes(remoteRef)) return undefined;

  const previousHead = (await git.revparse(['HEAD'])).trim();
  const currentRemoteHead = (await git.revparse([remoteRef])).trim();
  if (previousHead === currentRemoteHead) return undefined;

  try {
    await git.raw(['merge-base', '--is-ancestor', previousHead, currentRemoteHead]);
  } catch {
    return undefined;
  }

  const previousTree = (await git.revparse([`${previousHead}^{tree}`])).trim();
  const remoteTree = (await git.revparse([`${currentRemoteHead}^{tree}`])).trim();
  if (status.files.length > 0 && previousTree !== remoteTree) return undefined;

  await git.merge(['--ff-only', remoteRef]);
  const currentHead = (await git.revparse(['HEAD'])).trim();
  const currentTree = (await git.revparse([`${currentHead}^{tree}`])).trim();
  const changedFiles = (await git.diff(['--name-only', `${previousHead}..${currentHead}`]))
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
    .filter(isSubstantiveImplementationPath);
  const diffStat = await collectCommittedRangeDiffStat(git, previousHead, currentHead, changedFiles);

  return {
    previousHead,
    currentHead,
    treeChanged: previousTree !== currentTree,
    changedFiles,
    diffStat
  };
}

async function collectCommittedRangeDiffStat(
  git: SimpleGit,
  previousHead: string,
  currentHead: string,
  changedFiles: string[]
): Promise<ImplementResult['diffStat']> {
  let insertions = 0;
  let deletions = 0;
  const numstat = await git.diff(['--numstat', `${previousHead}..${currentHead}`]);
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed, ...pathParts] = line.split(/\s+/);
    const path = pathParts.join(' ');
    if (!path || !isSubstantiveImplementationPath(path)) continue;
    insertions += Number.parseInt(added ?? '0', 10) || 0;
    deletions += Number.parseInt(removed ?? '0', 10) || 0;
  }
  return { filesChanged: changedFiles.length, insertions, deletions };
}

function reconcileResumeAfterRemoteSync(
  resume: WorkerTaskResume,
  sync: ResumedWorkspaceSync
): WorkerTaskResume {
  const withoutStaleDelivery = (resume.completedOperations ?? []).filter((operation) => (
    operation !== 'wait_for_checks' && operation !== 'merge_pr'
  ));
  if (!sync.treeChanged) {
    return {
      ...resume,
      completedOperations: withoutStaleDelivery,
      githubChecks: undefined,
      githubChecksInputHash: undefined,
      mergeCommitSha: undefined
    };
  }

  return {
    ...resume,
    resumeFrom: 'validation',
    changedFiles: uniqueStrings([...(resume.changedFiles ?? []), ...sync.changedFiles]),
    diffStat: sync.diffStat,
    validation: undefined,
    passedValidationChecks: [],
    resumeValidationPlanRevision: false,
    reviewSummary: undefined,
    riskyChanges: undefined,
    completedOperations: withoutStaleDelivery,
    githubChecks: undefined,
    githubChecksInputHash: undefined,
    mergeCommitSha: undefined,
    completedSatisfactionReview: undefined
  };
}

async function configureWorkspaceGitIdentity(git: SimpleGit) {
  const authorName = process.env.FORGEMIND_GIT_AUTHOR_NAME?.trim() || 'ForgeMind Worker';
  const authorEmail =
    process.env.FORGEMIND_GIT_AUTHOR_EMAIL?.trim() || 'forgemind-worker@users.noreply.github.com';

  await git.addConfig('user.name', authorName, false, 'local');
  await git.addConfig('user.email', authorEmail, false, 'local');
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
  const pathsToStage = collectStageablePaths(initialStatus).filter(isSubstantiveImplementationPath);
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
  const segments = normalized.split('/');
  const rootSegment = segments[0] ?? '';
  return normalized === 'agents.md'
    || normalized === 'mock_implementation.md'
    || segments.includes('node_modules')
    || segments.includes('.venv')
    || normalized === 'out/build'
    || normalized.startsWith('out/build/')
    || normalized === 'build'
    || normalized.startsWith('build/')
    || (rootSegment.startsWith('build-') && !SOURCE_BUILD_ROOTS.has(rootSegment))
    || segments.some((segment) => segment.startsWith('cmake-build-'));
}

const SOURCE_BUILD_ROOTS = new Set([
  'build-scripts',
  'build-support',
  'build-system',
  'build-tools'
]);

function normalizeRepoPath(path: string): string {
  return toPortableRepoPath(path).toLowerCase();
}

function toPortableRepoPath(path: string): string {
  return path.replace(/\\/g, '/');
}
