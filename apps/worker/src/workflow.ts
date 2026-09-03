import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type {
  ForgeTask,
  IterationPhase,
  Project,
  ProjectArchitecture,
  ProjectArchitectureUpdate,
  ProviderKind,
  TaskActivity,
  TaskStatus
} from '@forgemind/core';
import {
  createAiBranchName,
  renderIssueBody,
  renderPullRequestBody,
  slugifyBranchSegment,
  type GitHubAdapter
} from '@forgemind/github';
import { createProvider, type AIProvider, type ImplementResult, type PlanResult, type ProviderSessionContext, type ReviewResult, type ValidationCheck } from '@forgemind/providers';
import { parseAgentConfigYaml } from '@forgemind/config';
import { nowIso, toErrorMessage, type JsonValue } from '@forgemind/shared';
import {
  collectPassedValidationCheckResults,
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

type GitHubOperation = 'create_issue' | 'create_branch' | 'commit_and_push' | 'create_draft_pr' | 'create_pull_request' | 'merge_pr' | 'comment_on_issue';

export interface WorkerTaskResume {
  kind: 'validation_retry' | 'worker_interrupted' | 'phase_retry';
  resumeFrom?: 'planning' | 'implementation' | 'validation' | 'review' | 'delivery';
  attempt?: number;
  planSummary?: string;
  planSteps?: string[];
  acceptanceCriteria?: string[];
  implementationSummary: string;
  implementationOutcome?: 'changes_made' | 'already_satisfied' | 'blocked';
  evidenceFiles?: string[];
  changedFiles?: string[];
  diffStat?: ImplementResult['diffStat'];
  architectureUpdate?: ProjectArchitectureUpdate;
  previousValidationError?: string;
  previousReviewBlockers?: string[];
  validation?: ValidationResult;
  passedValidationChecks?: ValidationCheckExecutionResult[];
  reviewSummary?: string;
  validationChecks?: ValidationCheck[];
  completedOperations?: string[];
  mergeCommitSha?: string;
  completedSatisfactionReview?: {
    inputHash: string;
    summary: string;
    criterionResults?: ReviewResult['criterionResults'];
  };
  completedReview?: {
    inputHash: string;
    verdict: ReviewResult['verdict'];
    summary: string;
    blockers: string[];
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
  status: 'ready_for_user_review' | 'completed' | 'validation_failed' | 'failed';
  issueUrl: string;
  branchName: string;
  pullRequestUrl?: string;
  workspacePath: string;
  validation: ValidationResult;
  externalValidationChecks?: ValidationCheck[];
  commitSha?: string;
  summary: string;
  architectureUpdate?: ProjectArchitectureUpdate;
  completedAt: string;
}

export async function runWorkerTask(input: WorkerTaskInput): Promise<WorkerTaskResult> {
  throwIfTaskAborted(input.signal);
  const config = resolveWorkerConfig(input.project, input);
  const resourcePolicy = input.resourcePolicy ?? resolveWorkerResourcePolicy(input.project.configYaml);
  const provider = input.provider ?? createProvider(config.providerKind);
  const reviewProvider = input.reviewProvider ?? provider;
  const taskPrompt = input.task.prompt.trim();
  const executionPrompt = buildTaskExecutionPrompt(taskPrompt);
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

  const usageSummary = input.usageSummary ?? await resolveUsageSummary(provider, executionPrompt);

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
        : `Vzdaleny commit ${workspace.resumedSync.currentHead} nezmenil obsah; zopakuji se pouze nedokoncene dorucovaci operace.`,
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
        completedAt: nowIso()
      };
    }
  }

  const isResumeRun = Boolean(input.resume);
  await input.hooks?.onStatus?.('running_ai', isResumeRun && input.resume ? { resumed: true, kind: input.resume.kind } : undefined);
  const rerunPlanning = input.resume?.resumeFrom === 'planning';
  const plan = input.resume && !rerunPlanning
    ? createResumePlan(input.resume, createDirectTaskPlan(input.task.title, input.task.acceptanceCriteria))
    : createDirectTaskPlan(input.task.title, input.task.acceptanceCriteria);
  if (!input.resume || rerunPlanning) {
    await emitTaskActivity(input.hooks, {
      phase: 'planning',
      state: 'completed',
      title: 'Zadani bylo predano implementaci',
      detail: plan.summary,
      operation: 'direct_task',
      attempt: 0,
      elapsedMs: 0
    });
  }
  let validationChecks = normalizeValidationChecks(input.resume?.validationChecks);
  let externalValidationChecks = validationChecks.filter((check) => check.target === 'windows');
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
  const resolvedReviewBlockers = new Set<string>();
  let completedAttempts = 0;
  let review: ReviewResult | undefined = input.resume?.previousReviewBlockers?.length
      ? {
          verdict: 'not_satisfied',
          summary: input.resume.reviewSummary ?? 'Resume correction for previously reported review blockers.',
          blockers: input.resume.previousReviewBlockers
        }
      : undefined;

  let resumedValidation = input.resume?.resumeFrom === 'review' || input.resume?.resumeFrom === 'delivery'
    ? input.resume.validation
    : undefined;
  const completedOperations = new Set(input.resume?.completedOperations ?? []);
  const deliveryState: DeliveryState = {
    pullRequest: resolveExistingTaskPullRequest(input.task),
    skipCommitFromResume: completedOperations.has('commit'),
    skipPushFromResume: completedOperations.has('commit_and_push'),
    issueCommented: completedOperations.has('comment_on_issue'),
    skipMergeFromResume: completedOperations.has('merge_pr'),
    resumedMergeCommitSha: input.resume?.mergeCommitSha
  };
  const firstAttempt = Math.max(1, input.resume?.attempt ?? 1);
  const passedValidationCheckResults = new Map<string, ValidationCheckExecutionResult>(
    (input.resume?.passedValidationChecks ?? [])
      .filter((result) => result.passed)
      .map((result) => [validationCheckResultKey(normalizeValidationCommandForEnvironment(result.command), result.inputHash, result.shell), result])
  );

  for (let attempt = firstAttempt; ; attempt += 1) {
    completedAttempts = attempt;
    const previousReviewForCorrection = review?.blockers.length ? review : undefined;
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
    implementation = resumedImplementation
      ?? await provider.implement({
        taskId: input.task.id,
        prompt: executionPrompt,
        plan,
        repositoryPath: workspacePath,
        session: input.providerSession,
        signal: input.signal,
        attemptNumber: attempt,
        previousValidationError: validation && !validation.passed
          ? formatValidationFailure(validation)
          : input.resume?.previousValidationError,
        previousReviewBlockers: review?.blockers.length ? review.blockers : undefined,
        onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'implementation', attempt, ...activity })
      });
    resumedImplementation = undefined;

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
    const implementationStatus = await git.status();
    const implementationChangedFiles = collectStageablePaths(implementationStatus);
    if (implementationChangedFiles.length > 0) {
      invalidateResumedDeliveryAfterWorkspaceChanges(deliveryState);
    }
    const actualDiffStat = await collectWorkspaceDiffStat(git, workspacePath, implementationStatus);
    implementation = {
      ...implementation,
      changedFiles: uniqueStrings([...implementation.changedFiles, ...implementationChangedFiles]),
      diffStat: actualDiffStat
    };

    if (implementation.outcome === 'blocked') {
      return {
        taskId: input.task.id,
        status: 'failed',
        issueUrl: issue.issueUrl,
        branchName,
        workspacePath,
        validation: validation ?? {
          command: 'not-run',
          exitCode: 1,
          stdout: '',
          stderr: implementation.summary,
          passed: false
        },
        summary: `AI reported a blocking external condition: ${implementation.summary}`,
        completedAt: nowIso()
      };
    }
    if (!isResumedImplementation) {
      validationChecks = normalizeValidationChecks(implementation.validationChecks);
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
          passed: true,
          attempt,
          changedFiles: implementationChangedFiles,
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

    const alreadySatisfied = implementation.outcome === 'already_satisfied';

    let validationStatusEmitted = false;
    while (true) {
      if (!validationStatusEmitted) {
        await input.hooks?.onStatus?.('validating', {
          attempt,
          resumed: Boolean(resumedValidation?.passed),
          kind: input.resume?.kind ?? null
        });
        validationStatusEmitted = true;
      }
      if (resumedValidation?.passed) {
        validation = resumedValidation;
        resumedValidation = undefined;
        break;
      }
      {
        const validationInputHash = await collectValidationInputHash(git, workspacePath);
        const validationWorkspacePatch = await collectValidationWorkspacePatch(git, workspacePath);
        await input.hooks?.onIterationStarted?.({
          phase: 'validation',
          prompt: summarizeValidationChecks(validationChecks),
          attempt
        });
        externalValidationChecks = validationChecks.filter((check) => check.target === 'windows');
        const localValidationChecks = validationChecks.filter((check) => check.target !== 'windows');
        const impactRationales = new Map<string, string>();
        const reusableResults = await selectReusableValidationResults(provider, localValidationChecks, passedValidationCheckResults, validationInputHash, validationWorkspacePatch, input.signal, impactRationales);
        validation = await runValidationChecks(localValidationChecks, workspacePath, async (activity) => {
          const checkLabel = `${activity.checkIndex}/${activity.checkCount}`;
          const checkpointKey = `validation:${hashCheckpointValue(activity.command)}`;
          if (activity.state === 'started') {
            await input.hooks?.onCheckpoint?.({
              key: checkpointKey,
              phase: 'validation',
              status: 'started',
              inputHash: activity.inputHash ?? validationInputHash,
              output: { command: activity.command, shell: activity.shell ?? 'system', category: activity.category ?? null }
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
                shell: activity.shell ?? 'system',
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
              shell: activity.shell ?? 'system',
              category: activity.category ?? null,
              exitCode: activity.exitCode ?? null,
              stdout: activity.stdout ?? '',
              stderr: activity.stderr ?? '',
              criterion: activity.criterion ?? null,
              rationale: activity.rationale ?? null,
              provenance: activity.provenance ? activity.provenance as unknown as JsonValue : null
            },
            errorMessage: activity.exitCode === 0 ? undefined : `Validation command exited with ${activity.exitCode ?? 1}.`
          });
        }, reusableResults, validationInputHash, input.signal, (check, decision, decisionRationale) => ({
          version: 1,
          checkFingerprint: validationCheckFingerprint(check),
          workspaceInputHash: validationInputHash,
          workspacePatch: validationWorkspacePatch,
          decision,
          decisionRationale: impactRationales.get(validationCheckFingerprint(check)) ?? decisionRationale,
          decidedAt: nowIso()
        }));
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
                shell: result.shell ?? 'system',
                inputHash: result.inputHash ?? null,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                passed: result.passed,
                criterion: result.criterion ?? null,
                rationale: result.rationale ?? null,
                provenance: result.provenance ? result.provenance as unknown as JsonValue : null
              })),
            executedCheckCount: validation.executedCheckCount ?? 0,
            reusedCheckCount: validation.reusedCheckCount ?? 0,
            failingCommand: validation.failingCommand ?? null,
            attempt,
            validationPlanRevision: 0
          }
        });
      }
      if (!validation) {
        throw new Error('Validation checkpoint is missing while resuming validation-plan correction.');
      }

      if (validation.passed) {
        break;
      }

      break;
    }

    if (validation.passed) {
      const satisfactionReview = alreadySatisfied && implementationChangedFiles.length === 0;
      const reviewInputHash = await collectReviewInputHash(
        git,
        workspacePath,
        input.task.prompt,
        plan.acceptanceCriteria,
        reviewProvider.kind,
        input.reviewProviderSession?.model
      );
      const reusableReview = input.resume?.completedReview?.inputHash === reviewInputHash
        ? input.resume.completedReview
        : undefined;
      await input.hooks?.onStatus?.('reviewing', reusableReview
        ? { attempt, resumed: true, reused: true }
        : { attempt });
      const reviewStartedAt = Date.now();
      await emitTaskActivity(input.hooks, {
        phase: 'review',
        state: reusableReview ? 'completed' : 'started',
        title: reusableReview ? 'Review bylo obnoveno z přesného checkpointu' : 'AI kontroluje výsledné změny',
        operation: 'provider_review',
        attempt
      });
      await input.hooks?.onIterationStarted?.({
        phase: 'review',
        prompt: `Review ${implementation.changedFiles.join(', ')}`,
        attempt
      });
      if (reusableReview) {
        review = {
          verdict: reusableReview.verdict,
          summary: reusableReview.summary,
          blockers: reusableReview.blockers,
          criterionResults: reusableReview.criterionResults
        };
      } else {
        let providerReview: ReviewResult;
        try {
          await input.hooks?.onCheckpoint?.({
            key: 'review:final',
            phase: 'review',
            status: 'started',
            inputHash: reviewInputHash
          });
          const nativeRepositoryReview = reviewProvider.supportsNativeRepositoryReview?.() === true;
          const reviewPacket = await collectReviewPacket(
            git,
            workspacePath,
            undefined,
            input.project.defaultBranch,
            !nativeRepositoryReview
          );
          const reviewChangedFiles = reviewPacket.changedFiles;
          const repositoryEvidence = nativeRepositoryReview
            ? undefined
            : await collectCompleteRepositorySnapshot(git, workspacePath);
          const reviewPromise = reviewProvider.review({
            taskId: input.task.id,
            taskTitle: input.task.title,
            taskPrompt: input.task.prompt,
            repositoryPath: workspacePath,
            changedFiles: reviewChangedFiles,
            acceptanceCriteria: plan.acceptanceCriteria,
            previousReviewSummary: previousReviewForCorrection?.summary,
            previousReviewBlockers: previousReviewForCorrection?.blockers,
            diff: reviewPacket.diff,
            reviewMode: satisfactionReview ? 'existing_state' : 'changes',
            repositoryEvidence,
            nativeRepositoryAccess: nativeRepositoryReview,
            localValidationCheckCount: validation.checkResults?.length ?? 0,
            deferredValidationChecks: externalValidationChecks.map((check) => ({
              command: check.command,
              criterion: check.criterion
            })),
            session: input.reviewProviderSession,
            signal: input.signal,
            onActivity: (activity) => input.hooks?.onProviderActivity?.({ phase: 'review', attempt, ...activity })
          });
          providerReview = nativeRepositoryReview && process.env.FORGEMIND_REVIEW_TIMEOUT_MS === undefined
            ? await reviewPromise
            : await withTimeout(
                reviewPromise,
                resolveReviewTimeoutMs(),
                () => new Error(`Review timed out after ${resolveReviewTimeoutMs()} ms.`)
              );
        } catch (error) {
          await input.hooks?.onCheckpoint?.({
            key: 'review:final',
            phase: 'review',
            status: 'failed',
            inputHash: reviewInputHash,
            errorMessage: toErrorMessage(error)
          });
          return {
            taskId: input.task.id,
            status: 'failed',
            issueUrl: issue.issueUrl,
            branchName,
            workspacePath,
            validation,
            externalValidationChecks,
            summary: `Review failed: ${toErrorMessage(error)}`,
            completedAt: nowIso()
          };
        }
        review = providerReview;
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
          verdict: review.verdict ?? (review.blockers.length === 0 ? 'satisfied' : 'not_satisfied'),
          blockers: review.blockers,
          criterionResults: review.criterionResults ?? [],
          alreadySatisfied: satisfactionReview,
          attempt
        }
      });
      if (!reusableReview) {
        await input.hooks?.onCheckpoint?.({
          key: 'review:final',
          phase: 'review',
          status: 'completed',
          inputHash: reviewInputHash,
          output: {
            verdict: review.verdict,
            summary: review.summary,
            blockers: review.blockers,
            criterionResults: review.criterionResults ?? []
          }
        });
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
          return {
            taskId: input.task.id,
            status: 'completed',
            issueUrl: issue.issueUrl,
            branchName,
            workspacePath,
            validation,
            externalValidationChecks,
            commitSha: await resolveHeadSha(git),
            summary,
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
          externalValidationChecks,
          review,
          usageSummary,
          attempt,
          completedAttempts,
          retryReasons,
          resolvedReviewBlockers,
          state: deliveryState
        });

        return delivery;
      }

      for (const blocker of review.blockers) {
        resolvedReviewBlockers.add(blocker);
      }

      retryReasons.push(`Review retry before attempt ${attempt + 1}: ${review.blockers.join('; ')}`);
      await input.hooks?.onStatus?.('running_ai', {
        attempt: attempt + 1,
        retryReason: review.blockers.join('; ')
      });
      continue;
    }

    const validationFailure = formatValidationFailure(validation);
    retryReasons.push(`Validation retry before attempt ${attempt + 1}: ${validationFailure}`);
    await input.hooks?.onStatus?.('running_ai', {
      attempt: attempt + 1,
      retryReason: validationFailure
    });
  }

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
  skipMergeFromResume: boolean;
  resumedMergeCommitSha?: string;
}

function invalidateResumedDeliveryAfterWorkspaceChanges(state: DeliveryState) {
  state.skipCommitFromResume = false;
  state.skipPushFromResume = false;
  state.skipMergeFromResume = false;
  state.resumedMergeCommitSha = undefined;
}

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
  externalValidationChecks: ValidationCheck[];
  review: {
    verdict?: 'satisfied' | 'not_satisfied';
    summary: string;
    blockers: string[];
  };
  usageSummary: string;
  attempt: number;
  completedAttempts: number;
  retryReasons: string[];
  resolvedReviewBlockers: Set<string>;
  state: DeliveryState;
}): Promise<WorkerTaskResult> {
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
    externalValidationChecks,
    review,
    usageSummary,
    attempt,
    completedAttempts,
    retryReasons,
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
    automaticImprovements: [],
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
    taskId: taskInput.task.id,
    status: config.autoCompleteTask && mergeConfirmed ? 'completed' : 'ready_for_user_review',
    issueUrl: issue.issueUrl,
    branchName,
    pullRequestUrl: state.pullRequest?.pullRequestUrl,
    workspacePath,
    validation,
    externalValidationChecks,
    commitSha,
    summary: mergeFailure
      ? `${review.summary}\n\nAutomatic merge was not completed: ${mergeFailure}`
      : review.summary,
    architectureUpdate: implementation.architectureUpdate,
    completedAt: nowIso()
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

async function resolveUsageSummary(provider: AIProvider, prompt: string): Promise<string> {
  try {
    return formatUsageSummary(await provider.estimateCost({ prompt, repositorySizeHint: 'small' }));
  } catch {
    return 'Cost estimate unavailable; execution continued.';
  }
}

function createResumePlan(resume: WorkerTaskResume, fallback?: PlanResult): PlanResult {
  return {
    summary:
      resume.planSummary
      ?? (resume.kind === 'worker_interrupted'
        ? 'Resume implementation after the previous worker process was interrupted.'
        : resume.kind === 'validation_retry'
          ? 'Resume the preserved implementation and rerun validation only.'
          : 'Resume the preserved workflow from its last completed phase.'),
    steps: resume.planSteps ?? fallback?.steps ?? [],
    acceptanceCriteria: resume.acceptanceCriteria ?? fallback?.acceptanceCriteria ?? []
  };
}

function throwIfTaskAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Task execution was cancelled.');
}

export function buildTaskExecutionPrompt(prompt: string): string {
  return prompt.trim();
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
  ].filter(Boolean).join('\n\n').slice(0, 6_000);
}

function normalizeMemoryTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4);
}

export function createDirectTaskPlan(title: string, acceptanceCriteria: string[] = []): PlanResult {
  return {
    summary: `Implement task: ${title}`,
    steps: ['Implement the complete supplied task scope.'],
    acceptanceCriteria: [...acceptanceCriteria]
  };
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

export async function collectValidationWorkspacePatch(git: SimpleGit, workspacePath: string): Promise<string> {
  let trackedPatch: string;
  try {
    trackedPatch = await git.diff(['HEAD', '--binary']);
  } catch {
    trackedPatch = await git.diff(['--binary']);
  }
  const status = await git.status();
  const untrackedInputs: string[] = [];
  for (const path of [...status.not_added].sort()) {
    let contentBase64: string;
    try {
      contentBase64 = (await readFile(resolve(workspacePath, path))).toString('base64');
    } catch {
      contentBase64 = Buffer.from('[unreadable]').toString('base64');
    }
    untrackedInputs.push(JSON.stringify({ path, encoding: 'base64', content: contentBase64 }));
  }
  return [trackedPatch, untrackedInputs.length > 0 ? `--- untracked validation inputs (jsonl)\n${untrackedInputs.join('\n')}` : '']
    .filter(Boolean)
    .join('\n');
}

export function validationCheckFingerprint(check: ValidationCheck): string {
  return createHash('sha256').update(JSON.stringify({
    kind: check.kind,
    command: normalizeValidationCommandForEnvironment(check.command),
    shell: check.shell ?? 'system',
    target: check.target ?? 'local',
    requiredCapabilities: check.requiredCapabilities ?? []
  })).digest('hex');
}

export async function selectReusableValidationResults(
  provider: AIProvider,
  checks: ValidationCheck[],
  priorResults: ReadonlyMap<string, ValidationCheckExecutionResult>,
  currentInputHash: string,
  currentPatch: string,
  signal?: AbortSignal,
  impactRationales: Map<string, string> = new Map()
): Promise<Map<string, ValidationCheckExecutionResult>> {
  const selected = new Map<string, ValidationCheckExecutionResult>();
  for (const check of checks) {
    const shell = check.shell ?? 'system';
    const fingerprint = validationCheckFingerprint(check);
    const key = validationCheckResultKey(check.command, currentInputHash, shell);
    const exact = priorResults.get(key);
    if (exact?.passed && exact.provenance?.version === 1 && exact.provenance.checkFingerprint === fingerprint) {
      selected.set(key, exact);
      continue;
    }
    if (!provider.assessValidationImpact) continue;
    const candidate = [...priorResults.values()].reverse().find((result) =>
      result.passed && result.command === check.command && (result.shell ?? 'system') === shell
      && result.provenance?.version === 1 && result.provenance.checkFingerprint === fingerprint);
    if (!candidate?.provenance) continue;
    const impact = await provider.assessValidationImpact({
      check,
      previousResult: { exitCode: candidate.exitCode, stdout: candidate.stdout, stderr: candidate.stderr, passed: candidate.passed, provenance: candidate.provenance },
      previousWorkspacePatch: candidate.provenance.workspacePatch,
      currentWorkspacePatch: currentPatch,
      workspaceChange: `--- previous validation inputs\n${candidate.provenance.workspacePatch}\n--- current validation inputs\n${currentPatch}`,
      signal
    });
    impactRationales.set(fingerprint, impact.rationale);
    if (!impact.reusable) continue;
    selected.set(key, {
      ...candidate,
      inputHash: currentInputHash,
      provenance: { ...candidate.provenance, workspaceInputHash: currentInputHash, workspacePatch: currentPatch, decision: 'reused', decisionRationale: impact.rationale, decidedAt: nowIso() }
    });
  }
  return selected;
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

async function collectReviewInputHash(
  git: SimpleGit,
  workspacePath: string,
  taskPrompt: string,
  acceptanceCriteria: string[],
  reviewProviderKind: ProviderKind,
  reviewProviderModel: string | undefined
): Promise<string> {
  return createHash('sha256').update(JSON.stringify({
    repositoryContentHash: await collectRepositoryContentHash(git, workspacePath),
    taskPrompt,
    acceptanceCriteria,
    reviewProviderKind,
    reviewProviderModel
  })).digest('hex');
}

async function collectRepositoryContentHash(git: SimpleGit, workspacePath: string): Promise<string> {
  const hash = createHash('sha256');
  const paths = uniqueStrings((await git.raw(['ls-files', '-co', '--exclude-standard', '-z']))
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean))
    .sort((left, right) => left.localeCompare(right));
  const workspaceRoot = resolve(workspacePath);
  for (const path of paths) {
    const target = resolve(workspaceRoot, path);
    const relativeTarget = relative(workspaceRoot, target);
    if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) continue;
    hash.update(path);
    hash.update('\0');
    try {
      hash.update(await readFile(target));
    } catch {
      hash.update('[missing]');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hashCheckpointValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
      checks.push({
        kind: 'command',
        command,
        shell: item.shell === 'powershell' || item.shell === 'cmd' || item.shell === 'bash' || item.shell === 'sh'
          ? item.shell
          : 'system',
        target: item.target === 'windows' ? 'windows' : 'local',
        requiredCapabilities: item.target === 'windows' && Array.isArray(item.requiredCapabilities)
          ? Array.from(new Set(['windows', ...item.requiredCapabilities.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0).map((value: string) => value.trim())]))
          : [],
        continueOnFailure: item.continueOnFailure === true,
        category: item.category === 'setup' || item.category === 'build' || item.category === 'database' || item.category === 'api' || item.category === 'browser' || item.category === 'smoke'
          ? item.category
          : undefined,
        timeoutMinutes: typeof item.timeoutMinutes === 'number' ? item.timeoutMinutes : undefined,
        criterion: typeof item.criterion === 'string' && item.criterion.trim() ? item.criterion.trim() : undefined,
        rationale: typeof item.rationale === 'string' && item.rationale.trim() ? item.rationale.trim() : undefined,
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
    shell: check.shell ?? 'system',
    target: check.target ?? 'local',
    requiredCapabilities: check.requiredCapabilities ?? [],
    continueOnFailure: check.continueOnFailure === true,
    category: check.category ?? null,
    timeoutMinutes: check.timeoutMinutes ?? 10,
    criterion: check.criterion ?? null,
    rationale: check.rationale ?? null
  }));
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
    case 'merge_pr':
      return 'GitHub merge';
    default:
      return describeGitHubOperation(operation).completed;
  }
}

function requiresPullRequestIntegration(config: WorkerConfig, project: Project): boolean {
  return config.createPullRequest && Boolean(project.githubOwner && project.githubRepo);
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
  issueLabel: string;
  branchPrefix: string;
  autoPush: boolean;
  createPullRequest: boolean;
  autoMergePullRequest: boolean;
  autoCompleteTask: boolean;
  createBranch: boolean;
  createIssue: boolean;
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
    issueLabel: config?.github.issue_label ?? 'ai-task',
    branchPrefix: config?.github.branch_prefix ?? 'ai/',
    autoPush: config?.workflow.auto_push ?? true,
    createPullRequest: project.autoCreatePullRequest ?? config?.workflow.create_draft_pr ?? true,
    autoMergePullRequest: project.autoMergePullRequest ?? config?.workflow.auto_merge ?? false,
    autoCompleteTask: project.autoCompleteTask ?? false,
    createBranch: config?.workflow.create_branch ?? true,
    createIssue: config?.workflow.create_issue ?? true
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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
  const changedPaths = collectStageablePaths(status);
  const untrackedPaths = new Set(status.not_added.map(normalizeRepoPath));
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
      if (!path) {
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

async function collectReviewPacket(
  git: SimpleGit,
  workspacePath: string,
  requestedPaths: string[] | undefined,
  baseBranch: string,
  includeDiff = true
): Promise<{ changedFiles: string[]; diff: string }> {
  const status = await git.status();
  const requestedPathSet = requestedPaths
    ? new Set(requestedPaths.map(normalizeRepoPath))
    : undefined;
  const workspaceChangedPaths = collectStageablePaths(status)
    .filter((path) => !requestedPathSet || requestedPathSet.has(normalizeRepoPath(path)));
  const baseRef = await resolveReviewBaseRef(git, baseBranch);
  const committedPaths = baseRef
    ? (await git.diff(['--name-only', `${baseRef}...HEAD`]))
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean)
        .filter((path) => !requestedPathSet || requestedPathSet.has(normalizeRepoPath(path)))
    : [];
  const changedPaths = uniqueStrings([...committedPaths, ...workspaceChangedPaths]);
  if (!includeDiff) {
    return { changedFiles: changedPaths, diff: '' };
  }
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

async function collectCompleteRepositorySnapshot(git: SimpleGit, workspacePath: string): Promise<string> {
  const paths = uniqueStrings((await git.raw(['ls-files', '-co', '--exclude-standard', '-z']))
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean))
    .sort((left, right) => left.localeCompare(right));
  const workspaceRoot = resolve(workspacePath);
  const sections: string[] = [`Repository snapshot (${paths.length} files):\n${paths.join('\n')}`];

  for (const path of paths) {
    const target = resolve(workspaceRoot, path);
    const relativeTarget = relative(workspaceRoot, target);
    if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) continue;
    try {
      const content = await readFile(target);
      if (content.includes(0)) {
        sections.push(`--- ${path} ---\n[binary file: ${content.length} bytes, sha256 ${createHash('sha256').update(content).digest('hex')}]`);
      } else {
        sections.push(`--- ${path} ---\n${content.toString('utf8')}`);
      }
    } catch {
      sections.push(`--- ${path} ---\n[file is missing from the current workspace]`);
    }
  }

  return sections.join('\n\n');
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
  const workspaceChangedFiles = collectStageablePaths(status);
  const changedFiles = uniqueStrings([...workspaceChangedFiles, ...(resume.changedFiles ?? [])]);
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
    .filter(Boolean);
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
    if (!path) continue;
    insertions += Number.parseInt(added ?? '0', 10) || 0;
    deletions += Number.parseInt(removed ?? '0', 10) || 0;
  }
  return { filesChanged: changedFiles.length, insertions, deletions };
}

function reconcileResumeAfterRemoteSync(
  resume: WorkerTaskResume,
  sync: ResumedWorkspaceSync
): WorkerTaskResume {
  const withoutStaleDelivery = (resume.completedOperations ?? []).filter((operation) => operation !== 'merge_pr');
  if (!sync.treeChanged) {
    return {
      ...resume,
      completedOperations: withoutStaleDelivery,
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
    reviewSummary: undefined,
    completedOperations: withoutStaleDelivery,
    mergeCommitSha: undefined,
    completedSatisfactionReview: undefined,
    completedReview: undefined
  };
}

async function configureWorkspaceGitIdentity(git: SimpleGit) {
  const authorName = process.env.FORGEMIND_GIT_AUTHOR_NAME?.trim() || 'ForgeMind Worker';
  const authorEmail =
    process.env.FORGEMIND_GIT_AUTHOR_EMAIL?.trim() || 'forgemind-worker@users.noreply.github.com';

  await git.addConfig('user.name', authorName, false, 'local');
  await git.addConfig('user.email', authorEmail, false, 'local');
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

function normalizeRepoPath(path: string): string {
  return toPortableRepoPath(path).toLowerCase();
}

function toPortableRepoPath(path: string): string {
  return path.replace(/\\/g, '/');
}
