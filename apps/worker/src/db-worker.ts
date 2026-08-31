import { parseAgentConfigYaml, type AgentConfig } from '@forgemind/config';
import { activeProjectContractRequirements, createBlockedRunState, createFailedRunState, createWaitingRunState, isNonBlockingDeferredValidation } from '@forgemind/core';
import { advanceRoadmapAfterTaskCapabilityWait, advanceRoadmapAfterTaskCompletion, createRepository, getPrismaClient, startNextRoadmapStep, type AIProviderConnectionSecret, type ForgeMindRepository } from '@forgemind/db';
import { GitHubAppAdapter, createGitHubAdapterFromEnv } from '@forgemind/github';
import { buildProjectExtensionProposalPrompt, createProvider, formatProjectExtensionProposal, normalizeProviderError, type AIProvider, type ProviderSessionContext, type ProviderUsageMeasurement } from '@forgemind/providers';
import type { NormalizedProviderErrorDetails, ProviderCircuitBreakerSnapshot, ProviderKind } from '@forgemind/core';
import { toErrorMessage } from '@forgemind/shared';
import { formatProjectArchitectureContext, runWorkerTask } from './workflow.js';
import { buildTargetedRepositoryContext, prepareCapabilityAuditWorkspace, runCapabilityAudit, runReleaseAudit } from './capability-audit.js';
import { resolveWorkerCapabilities } from './worker-capabilities.js';
import { runNextChatTurn } from './chat-worker.js';
import { hasSatisfiedReleaseAudit, recordTaskAcceptanceEvidence, sanitizeAuditErrorMessage } from './db-worker/audit.js';
import { buildIterationErrorFingerprint, resolveTaskResumeContext } from './db-worker/checkpoints.js';
import { cleanupCompletedTaskWorkspace, installWorkerInterruptionRecovery, resolveWorkerWorkspaceRoot, runWorkspaceRetentionCleanup, startProjectAuditHeartbeat, startQueueClaimHeartbeat, startTaskCancellationWatcher, TaskCancellationError, throwIfTaskCancelled } from './db-worker/lifecycle.js';
import { extractAttemptNumber, handleWorkerLimitsOrThrow, isApprovalType, normalizeRuntimeApprovals, resolveBlockedRunReason, resolveLimits, WorkerApprovalRequiredError, WorkerLimitError } from './db-worker/limits.js';
import { normalizeProviderUsageMeasurement } from './db-worker/provider-usage.js';
import {
  assertFreeSpaceForWorker,
  resolveWorkerResourcePolicy,
  type WorkerResourcePolicy
} from './resource-policy.js';

export { recordTaskAcceptanceEvidence } from './db-worker/audit.js';
export { resolveWorkerWorkspaceRoot } from './db-worker/lifecycle.js';

let preferChatQueue = true;

export async function runDatabaseWorkerOnce(options: { deferInterruptSignals?: boolean } = {}) {
  const repository = createRepository(getPrismaClient());
  const defaultAIProviderConnection = await readAIProviderConnectionSecret(repository);
  const providerOverride = process.env.FORGEMIND_PROVIDER as ProviderKind | undefined;
  const fallbackProviderOverride = process.env.FORGEMIND_FALLBACK_PROVIDER as ProviderKind | undefined;
  const providerConnectionIdOverride = process.env.FORGEMIND_PROVIDER_CONNECTION_ID?.trim() || undefined;
  const fallbackProviderConnectionIdOverride = process.env.FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID?.trim() || undefined;
  const providerKind = providerOverride ?? defaultAIProviderConnection?.provider ?? 'codex';
  const providerModel = resolveProviderModel(providerKind, defaultAIProviderConnection);
  const claimTimeoutMinutes = Number(process.env.FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES ?? 2);
  const recovery = await repository.recoverStuckQueueJobs(claimTimeoutMinutes);
  const recoveredChatRuns = await repository.recoverStuckChatRuns(claimTimeoutMinutes);
  const workerCapabilities = resolveWorkerCapabilities();
  const requeuedCapabilityTasks = await repository.requeueTasksWaitingForCapabilities(workerCapabilities);
  const deferredCapabilityTasks = await repository.listTasksWaitingForCapabilities();
  for (const task of deferredCapabilityTasks) {
    if (isNonBlockingDeferredValidation(task.waitingForCapabilities ?? [])) {
      const completed = await repository.completeTaskWithDeferredValidation(task.id);
      if (completed) {
        await advanceRoadmapAfterTaskCompletion(repository, task.id);
        await cleanupCompletedTaskWorkspace(resolveWorkerWorkspaceRoot(), task.id);
      }
    }
  }
  const recoveredProjectAudits = await repository.recoverStuckProjectAudits(claimTimeoutMinutes);
  if (preferChatQueue) {
    const chatResult = await runNextChatTurn(repository);
    if (chatResult) {
      preferChatQueue = false;
      return chatResult;
    }
  }
  const auditResult = await runNextProjectAudit({
    repository,
    defaultConnection: defaultAIProviderConnection,
    providerOverride,
    fallbackProviderOverride,
    providerConnectionIdOverride,
    fallbackProviderConnectionIdOverride
  });
  if (auditResult) return auditResult;
  const claimed = await repository.claimNextSubmittedTask(providerKind, providerModel);

  if (!claimed) {
    const chatResult = await runNextChatTurn(repository);
    if (chatResult) {
      preferChatQueue = false;
      return chatResult;
    }
    return {
      claimed: false,
      message: 'No submitted task or project audit found.',
      recoveredQueueJobs: recovery.recoveredCount,
      recoveredChatRuns,
      recoveredProjectAudits,
      requeuedCapabilityTasks
    };
  }
  preferChatQueue = true;
  const stopQueueHeartbeat = startQueueClaimHeartbeat(repository, claimed.queueJobId, claimTimeoutMinutes);
  const taskAbortController = new AbortController();
  const stopCancellationWatcher = startTaskCancellationWatcher(repository, claimed.task.id, taskAbortController);
  const stopInterruptionRecovery = installWorkerInterruptionRecovery({
    repository,
    queueJobId: claimed.queueJobId,
    taskId: claimed.task.id,
    taskRunId: claimed.taskRun.id,
    stopQueueHeartbeat,
    deferInterruptSignals: options.deferInterruptSignals ?? false
  });
  const finalizeQueueJob = async (
    status: 'succeeded' | 'failed' | 'cancelled',
    errorMessage?: string,
    retryable = true
  ) => {
    stopQueueHeartbeat();
    stopCancellationWatcher();
    stopInterruptionRecovery();
    if (!retryable) {
      await repository.finalizeQueueJob(claimed.queueJobId, status, errorMessage, false);
    } else if (errorMessage === undefined) {
      await repository.finalizeQueueJob(claimed.queueJobId, status);
    } else {
      await repository.finalizeQueueJob(claimed.queueJobId, status, errorMessage);
    }
  };

  let iterationNumber = 0;
  let attemptCount = 0;
  let changedFiles = 0;
  let diffLines = 0;
  let repeatedErrorCount = 0;
  let lastErrorFingerprint: string | undefined;
  const cumulativeProviderTotals = new Map<string, ProviderUsageMeasurement>();
  let lastProviderActivityAuditAt = 0;
  const measuredUsage = {
    measurements: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    completeBreakdown: true,
    actualCostUsd: 0,
    completeCost: true
  };
  const startedAtMs = Date.now();
  const verifyCommand = resolveVerifyCommand(claimed.project.configYaml);
  const workspaceRoot = resolveWorkerWorkspaceRoot();
  const projectConfig = parseProjectConfig(claimed.project.configYaml);
  const requiresGitHub = !projectConfig
    || projectConfig.workflow.create_issue
    || projectConfig.workflow.create_branch
    || projectConfig.workflow.create_draft_pr
    || projectConfig.workflow.auto_push;
  const githubConnection = requiresGitHub ? await repository.getGitHubConnectionSecret() : undefined;
  const github = requiresGitHub
    ? (githubConnection
        ? new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl })
        : await createGitHubAdapterFromEnv())
    : undefined;
  const limits = resolveLimits(claimed.project.configYaml, claimed.task.maxIterations);
  let resourcePolicy: WorkerResourcePolicy;
  try {
    resourcePolicy = resolveWorkerResourcePolicy(claimed.project.configYaml);
    await runWorkspaceRetentionCleanup(repository, workspaceRoot, claimed.task.id, resourcePolicy);
    await assertFreeSpaceForWorker(workspaceRoot, resourcePolicy);
  } catch (error) {
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    await repository.failTask(claimed.task.id, message, 'failed');
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      iterationCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: 'unavailable',
      estimatedCostUsd: 0,
      actualCostUsd: null
    });
    await finalizeQueueJob('failed', message, false);
    return {
      claimed: true,
      taskId: claimed.task.id,
      status: 'failed'
    };
  }
  const selection = await resolveProviderSelection({
    repository,
    projectConfig,
    projectProviderConnectionId: claimed.project.aiProviderConnectionId,
    defaultConnection: defaultAIProviderConnection,
    providerOverride,
    fallbackProviderOverride,
    providerConnectionIdOverride,
    fallbackProviderConnectionIdOverride
  });
  const selectedProviderModel = resolveProviderModel(selection.primary.kind, selection.primary.connection);
  if (claimed.taskRun.provider !== selection.primary.kind || claimed.taskRun.model !== selectedProviderModel) {
    await repository.updateTaskRunProvider({
      taskRunId: claimed.taskRun.id,
      provider: selection.primary.kind,
      model: selectedProviderModel
    });
    claimed.taskRun.provider = selection.primary.kind;
    claimed.taskRun.model = selectedProviderModel;
  }
  const primaryRuntimeProvider = buildRuntimeProvider(selection.primary.kind, selection.primary.connection);
  const fallbackRuntimeProvider = selection.fallback
    ? buildRuntimeProvider(selection.fallback.kind, selection.fallback.connection)
    : undefined;
  const { provider, getLastProviderKind } = createPolicyAwareProvider({
    primary: primaryRuntimeProvider,
    fallback: fallbackRuntimeProvider,
    audit: (event) => repository.writeAudit({
      actorType: 'system',
      eventType: event.eventType,
      taskId: claimed.task.id,
      payload: {
        taskRunId: claimed.taskRun.id,
        queueJobId: claimed.queueJobId ?? null,
        ...event.payload
      }
    })
  });
  const reviewerSelection = await resolveReviewerSelection({
    repository,
    projectConfig,
    primary: selection.primary,
    fallback: selection.fallback,
    defaultConnection: defaultAIProviderConnection
  });
  const reviewProvider = buildRuntimeProvider(reviewerSelection.kind, reviewerSelection.connection).provider;
  const reviewProviderModel = resolveProviderModel(reviewerSelection.kind, reviewerSelection.connection);
  const primaryConnectionId = selection.primary.connection?.id;
  const hasCompatibleProviderSession = claimed.task.providerSessionProvider === selection.primary.kind
    && claimed.task.providerSessionModel === selectedProviderModel
    && claimed.task.providerSessionConnectionId === primaryConnectionId;
  const providerSession: ProviderSessionContext = {
    id: hasCompatibleProviderSession ? claimed.task.providerSessionId : undefined,
    provider: hasCompatibleProviderSession ? claimed.task.providerSessionProvider : selection.primary.kind,
    model: hasCompatibleProviderSession ? claimed.task.providerSessionModel : selectedProviderModel,
    onUpdate: async (session) => {
      const connectionId = session.provider === selection.primary.kind
        ? selection.primary.connection?.id
        : selection.fallback?.connection?.id;
      await repository.updateTaskProviderSession({
        taskId: claimed.task.id,
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        connectionId
      });
    }
  };
  const resumeContext = await resolveTaskResumeContext(
    repository,
    claimed.task.id,
    claimed.queueReason,
    claimed.taskRun.id,
    claimed.task.maxIterations
  );
  if (resumeContext?.workflowResume) {
    const resume = resumeContext.workflowResume;
    await repository.writeAudit({
      actorType: 'system',
      eventType: 'task_retry_resume_decision',
      taskId: claimed.task.id,
      payload: {
        taskRunId: claimed.taskRun.id,
        queueJobId: claimed.queueJobId ?? null,
        queueReason: claimed.queueReason ?? null,
        kind: resume.kind,
        resumeFrom: resume.resumeFrom ?? null,
        attempt: resume.attempt ?? null,
        skippedExternalEffects: resume.completedOperations ?? [],
        reusedValidationChecks: resume.passedValidationChecks?.map((check) => ({
          command: check.command,
          inputHash: check.inputHash ?? null
        })) ?? []
      }
    });
  }
  let costEstimate;
  try {
    costEstimate = await provider.estimateCost({ prompt: claimed.task.prompt, repositorySizeHint: 'small' });
  } catch (error) {
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    await repository.failTask(claimed.task.id, message, 'provider_failed');
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      iterationCount: attemptCount,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: 'unavailable',
      estimatedCostUsd: 0,
      actualCostUsd: null
    });
    await finalizeQueueJob('failed', message);
    return {
      claimed: true,
      taskId: claimed.task.id,
      status: 'provider_failed'
    };
  }
  const getRunUsageFields = () => ({
    inputTokens: measuredUsage.completeBreakdown ? measuredUsage.inputTokens : 0,
    outputTokens: measuredUsage.completeBreakdown ? measuredUsage.outputTokens : 0,
    totalTokens: measuredUsage.totalTokens,
    usageSource:
      measuredUsage.measurements === 0
        ? 'unavailable'
        : (measuredUsage.completeBreakdown ? 'actual_breakdown' : 'actual_total'),
    estimatedCostUsd: costEstimate.estimatedCostUsd,
    actualCostUsd:
      measuredUsage.measurements > 0 && measuredUsage.completeCost
        ? measuredUsage.actualCostUsd
        : null
  });

  try {
    const result = await runWorkerTask({
      project: claimed.project,
      task: claimed.task,
      providerKind: selection.primary.kind,
      provider,
      reviewProvider,
      verifyCommand,
      workspaceRoot,
      resourcePolicy,
      usageSummary: `Pre-run estimate: ${costEstimate.inputTokens} input tokens, ${costEstimate.outputTokens} output tokens, ${costEstimate.estimatedCostUsd.toFixed(4)} USD`,
      resume: resumeContext?.workflowResume,
      providerSession,
      reviewProviderSession: {
        provider: reviewerSelection.kind,
        model: reviewProviderModel
      },
      github,
      signal: taskAbortController.signal,
      hooks: {
        onActivity: async (activity) => {
          await repository.writeAudit({
            actorType: activity.phase === 'github' ? 'github' : 'agent',
            eventType: activity.operation === 'command_denied' ? 'command_denied' : 'task_activity',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              phase: activity.phase,
              state: activity.state,
              title: activity.title,
              detail: activity.detail ?? null,
              operation: activity.operation ?? null,
              attempt: activity.attempt ?? null,
              elapsedMs: activity.elapsedMs ?? null,
              exitCode: activity.exitCode ?? null,
              metadata: activity.metadata ?? null
            }
          });
        },
        onStatus: async (status, payload = {}) => {
          throwIfTaskCancelled(taskAbortController.signal);
          await repository.transitionTask(claimed.task.id, status, payload);
        },
        onIterationStarted: async (iteration) => {
          await repository.writeAudit({
            actorType: 'agent',
            eventType: 'task_iteration_started',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              phase: iteration.phase,
              prompt: iteration.prompt,
              providerPrompt: iteration.providerPrompt ?? null,
              attempt: iteration.attempt
            }
          });
        },
        onIssue: async (issue) => {
          await repository.updateTaskGitHubFields(claimed.task.id, {
            githubIssueNumber: issue.issueNumber,
            githubIssueUrl: issue.issueUrl
          });
        },
        onBranch: async (branchName) => {
          await repository.updateTaskGitHubFields(claimed.task.id, { branchName });
        },
        onPullRequest: async (pullRequest) => {
          await repository.updateTaskGitHubFields(claimed.task.id, {
            pullRequestNumber: pullRequest.pullRequestNumber,
            pullRequestUrl: pullRequest.pullRequestUrl
          });
        },
        onGitHubOperationFailed: async (failure) => {
          const errorMessage = sanitizeAuditErrorMessage(failure.errorMessage);
          await repository.writeAudit({
            actorType: 'system',
            eventType: 'task_github_operation_failed',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              queueJobId: claimed.queueJobId ?? null,
              operation: failure.operation,
              errorMessage,
              provider: getLastProviderKind(),
              model: getLastProviderKind(),
              context: failure.context ?? null
            }
          });
        },
        onCheckpoint: async (checkpoint) => {
          await repository.recordTaskCheckpoint({
            taskId: claimed.task.id,
            taskRunId: claimed.taskRun.id,
            ...checkpoint
          });
        },
        onProviderActivity: async (activity) => {
          let normalizedUsage: ProviderUsageMeasurement | undefined;
          if (activity.usage) {
            const usage = normalizeProviderUsageMeasurement(activity.phase, activity.usage, cumulativeProviderTotals);
            normalizedUsage = usage;
            measuredUsage.measurements += 1;
            measuredUsage.totalTokens += usage.totalTokens;
            if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
              measuredUsage.completeBreakdown = false;
            } else {
              measuredUsage.inputTokens += usage.inputTokens;
              measuredUsage.outputTokens += usage.outputTokens;
              measuredUsage.cachedTokens += usage.cachedTokens ?? 0;
            }
            if (usage.actualCostUsd === undefined) {
              measuredUsage.completeCost = false;
            } else {
              measuredUsage.actualCostUsd += usage.actualCostUsd;
            }

            await repository.recordProviderUsage({
              taskId: claimed.task.id,
              taskRunId: claimed.taskRun.id,
              provider: usage.provider,
              model: usage.model,
              phase: activity.phase,
              attempt: activity.attempt,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              cachedTokens: usage.cachedTokens ?? 0,
              totalTokens: usage.totalTokens,
              usageSource: usage.source,
              estimatedCostUsd: 0,
              actualCostUsd: usage.actualCostUsd
            });
          }
          const now = Date.now();
          if (activity.kind === 'workspace' && now - lastProviderActivityAuditAt < 1_500) {
            return;
          }
          if (activity.kind === 'workspace') {
            lastProviderActivityAuditAt = now;
          }
          await repository.writeAudit({
            actorType: 'agent',
            eventType: 'task_provider_activity',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              phase: activity.phase,
              attempt: activity.attempt,
              kind: activity.kind,
              message: activity.message,
              elapsedMs: activity.elapsedMs,
              provider: activity.usage?.provider ?? (activity.phase === 'review' ? reviewerSelection.kind : getLastProviderKind()),
              usage: normalizedUsage
                ? {
                    provider: normalizedUsage.provider,
                    model: normalizedUsage.model,
                    totalTokens: normalizedUsage.totalTokens,
                    inputTokens: normalizedUsage.inputTokens ?? null,
                    outputTokens: normalizedUsage.outputTokens ?? null,
                    cachedTokens: normalizedUsage.cachedTokens ?? null,
                    source: normalizedUsage.source,
                    actualCostUsd: normalizedUsage.actualCostUsd ?? null
                  }
                : null
            }
          });
          if (normalizedUsage) {
            await handleWorkerLimitsOrThrow(
              repository,
              claimed.task.id,
              {
                iterations: attemptCount,
                runtimeMinutes: (Date.now() - startedAtMs) / 60_000,
                changedFiles,
                diffLines,
                repeatedErrorCount,
                estimatedCostUsd: costEstimate.estimatedCostUsd,
                actualCostUsd: measuredUsage.completeCost ? measuredUsage.actualCostUsd : undefined
              },
              limits,
              resumeContext?.ignoredLimitSignals ?? [],
              claimed.task.mode,
              new Set((projectConfig?.approval.required_for ?? []).filter(isApprovalType)),
              claimed.project.allowSafeOperationsWithoutApproval ?? false
            );
          }
        },
        onIteration: async (iteration) => {
          iterationNumber += 1;
          const diffStat = iteration.diffStat && typeof iteration.diffStat === 'object' && !Array.isArray(iteration.diffStat) ? iteration.diffStat : {};
          changedFiles = Math.max(changedFiles, typeof diffStat.filesChanged === 'number' ? diffStat.filesChanged : 0);
          const currentDiffLines =
            (typeof diffStat.insertions === 'number' ? diffStat.insertions : 0) + (typeof diffStat.deletions === 'number' ? diffStat.deletions : 0);
          diffLines = Math.max(diffLines, currentDiffLines);

          const errorFingerprint = buildIterationErrorFingerprint(iteration.phase, iteration.validationResult);
          if (errorFingerprint) {
            repeatedErrorCount = errorFingerprint === lastErrorFingerprint ? repeatedErrorCount + 1 : 1;
            lastErrorFingerprint = errorFingerprint;
          } else {
            repeatedErrorCount = 0;
            lastErrorFingerprint = undefined;
          }

          await repository.createIteration({
            taskRunId: claimed.taskRun.id,
            iterationNumber,
            ...iteration
          });

          attemptCount = Math.max(attemptCount, extractAttemptNumber(iteration));

          const usage = {
            iterations: attemptCount,
            runtimeMinutes: (Date.now() - startedAtMs) / 60_000,
            changedFiles,
            diffLines,
            repeatedErrorCount
          };
          await handleWorkerLimitsOrThrow(
            repository,
            claimed.task.id,
            usage,
            limits,
            resumeContext?.ignoredLimitSignals ?? [],
            claimed.task.mode,
            new Set((projectConfig?.approval.required_for ?? []).filter(isApprovalType)),
            claimed.project.allowSafeOperationsWithoutApproval ?? false,
            iteration.phase === 'review'
          );
        }
      }
    });
    throwIfTaskCancelled(taskAbortController.signal);

    await recordTaskAcceptanceEvidence(repository, {
      project: claimed.project,
      taskId: claimed.task.id,
      taskRunId: claimed.taskRun.id,
      result
    });

    if (result.status === 'needs_approval') {
      const approvalTypes = normalizeRuntimeApprovals(result.approvals);
      await repository.transitionTask(claimed.task.id, 'needs_approval', { approvals: approvalTypes });
      for (const approvalType of approvalTypes) {
        await repository.createApproval({
          taskId: claimed.task.id,
          type: approvalType,
          requestedBy: 'agent',
          title: `Approval required: ${approvalType}`,
          description: `Worker requested approval for ${approvalType}.`,
          riskLevel: approvalType === 'new_dependency' ? 'medium' : 'high',
          payload: {
            risk: 'Potentially risky agent action.',
            recommendation: 'Review the diff and approve only when the change is intended.',
            touchedFiles: []
          }
        });
      }
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: result.summary,
        runState: createWaitingRunState('approval_required', { detail: result.summary }),
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('succeeded');
    } else if (result.status === 'waiting_for_capability') {
      await repository.waitTaskForCapabilities(claimed.task.id, result.requiredCapabilities ?? [], {
        validation: {
          command: result.validation.command,
          deferredChecks: (result.validation.deferredChecks ?? []).map((check) => ({
            command: check.command,
            category: check.category ?? null,
            criterion: check.criterion ?? null,
            rationale: check.rationale ?? null,
            requiredCapabilities: check.requiredCapabilities,
            missingCapabilities: check.missingCapabilities
          }))
        },
        pullRequestUrl: result.pullRequestUrl ?? null,
        commitSha: result.commitSha ?? null
      });
      await advanceRoadmapAfterTaskCapabilityWait(repository, claimed.task.id);
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: result.summary,
        runState: createWaitingRunState('unavailable_capability', {
          detail: result.summary,
          requiredCapabilities: result.requiredCapabilities ?? []
        }),
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('succeeded');
    } else if (result.status === 'validation_failed') {
      await repository.transitionTask(claimed.task.id, 'validation_failed', {
        validation: {
          command: result.validation.command,
          exitCode: result.validation.exitCode,
          stdout: result.validation.stdout,
          stderr: result.validation.stderr,
          passed: result.validation.passed
        }
      });
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'failed',
        summary: result.summary,
        errorMessage: result.validation.stderr || 'Validation failed.',
        runState: createBlockedRunState('validation_failed', result.validation.stderr || 'Validation failed.'),
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('failed', result.validation.stderr || 'Validation failed.', false);
    } else if (result.status === 'failed') {
      await repository.failTask(claimed.task.id, result.summary, 'failed');
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'failed',
        summary: result.summary,
        errorMessage: result.summary,
        runState: createFailedRunState('unknown', result.summary),
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('failed', result.summary, false);
    } else {
      if (result.requiredCapabilities?.length) {
        await repository.setTaskDeferredValidationCapabilities(claimed.task.id, result.requiredCapabilities);
      }
      await repository.transitionTask(claimed.task.id, 'ready_for_user_review', {
        pullRequestUrl: result.pullRequestUrl ?? null,
        branchName: result.branchName
      });
      if (result.status === 'completed') {
        await repository.transitionTask(claimed.task.id, 'completed');
        await repository.recordCompletedTaskProjectMemory({
          taskId: claimed.task.id,
          summary: result.summary,
          commitSha: result.commitSha,
          architectureUpdate: result.architectureUpdate
        });
        await advanceRoadmapAfterTaskCompletion(repository, claimed.task.id);
      }
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: result.summary,
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('succeeded');
      if (result.status === 'completed') {
        await cleanupCompletedTaskWorkspace(workspaceRoot, claimed.task.id);
      }
    }

    return {
      claimed: true,
      taskId: claimed.task.id,
      result
    };
  } catch (error) {
    if (error instanceof TaskCancellationError || taskAbortController.signal.aborted) {
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('cancelled', 'Task cancelled by user.');
      return {
        claimed: true,
        taskId: claimed.task.id,
        status: 'cancelled'
      };
    }
    if (error instanceof WorkerApprovalRequiredError) {
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: error.message,
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('succeeded');
      return {
        claimed: true,
        taskId: claimed.task.id,
        status: 'needs_approval'
      };
    }

    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    const status = error instanceof WorkerLimitError ? error.status : error instanceof ProviderExecutionError ? 'provider_failed' : 'failed';
    await repository.failTask(claimed.task.id, message, status);
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      runState: createBlockedRunState(resolveBlockedRunReason(status), message),
      iterationCount: attemptCount,
      ...getRunUsageFields()
    });
    await finalizeQueueJob('failed', message);
    return {
      claimed: true,
      taskId: claimed.task.id,
      status
    };
  }
}

async function runNextProjectAudit(input: {
  repository: ForgeMindRepository;
  defaultConnection?: AIProviderConnectionSecret;
  providerOverride?: ProviderKind;
  fallbackProviderOverride?: ProviderKind;
  providerConnectionIdOverride?: string;
  fallbackProviderConnectionIdOverride?: string;
}) {
  const claimed = await input.repository.claimNextProjectAudit();
  if (!claimed) return undefined;

  const stopAuditHeartbeat = startProjectAuditHeartbeat(
    input.repository,
    claimed.job.id,
    Number(process.env.FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES ?? 2)
  );
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const contract = claimed.project.projectContract;
    if (!contract) throw new Error('Project contract is required before the completion audit can run.');
    const githubConnection = await input.repository.getGitHubConnectionSecret();
    const github = githubConnection
      ? new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl })
      : await createGitHubAdapterFromEnv();
    const projectConfig = parseProjectConfig(claimed.project.configYaml);
    const selection = await resolveProviderSelection({
      repository: input.repository,
      projectConfig,
      projectProviderConnectionId: claimed.project.aiProviderConnectionId,
      defaultConnection: input.defaultConnection,
      providerOverride: input.providerOverride,
      fallbackProviderOverride: input.fallbackProviderOverride,
      providerConnectionIdOverride: input.providerConnectionIdOverride,
      fallbackProviderConnectionIdOverride: input.fallbackProviderConnectionIdOverride
    });
    const { provider, getLastProviderKind } = createPolicyAwareProvider({
      primary: buildRuntimeProvider(selection.primary.kind, selection.primary.connection),
      fallback: selection.fallback ? buildRuntimeProvider(selection.fallback.kind, selection.fallback.connection) : undefined,
      audit: (event) => input.repository.writeAudit({
        actorType: 'system',
        eventType: event.eventType,
        projectId: claimed.project.id,
        taskId: claimed.job.triggerTaskId,
        payload: {
          auditJobId: claimed.job.id,
          cycleId: claimed.cycle.id,
          ...event.payload
        }
      })
    });
    const triggerTask = claimed.job.triggerTaskId
      ? await input.repository.getTask(claimed.job.triggerTaskId)
      : undefined;
    const workspace = await prepareCapabilityAuditWorkspace({
      workspaceRoot: resolveWorkerWorkspaceRoot(),
      project: claimed.project,
      github,
      preferredBranch: triggerTask?.branchName
    });
    cleanup = workspace.cleanup;

    let lastActivityAt = 0;
    const onActivity = async (activity: { kind: string; message: string; elapsedMs: number }) => {
      const now = Date.now();
      if (activity.kind !== 'lifecycle' && now - lastActivityAt < 2_000) return;
      lastActivityAt = now;
      await input.repository.writeAudit({
        actorType: 'agent',
        eventType: 'project_audit_activity',
        projectId: claimed.project.id,
        taskId: claimed.job.triggerTaskId,
        payload: {
          auditJobId: claimed.job.id,
          cycleId: claimed.cycle.id,
          kind: activity.kind,
          message: activity.message.slice(0, 4_000),
          elapsedMs: activity.elapsedMs
        }
      });
    };

    const targetRequirementIds = new Set(
      claimed.job.requirementIds.length > 0
        ? claimed.job.requirementIds
        : activeProjectContractRequirements(contract).map((requirement) => requirement.id)
    );
    let deferredRequirementCount = 0;
    for (const requirement of contract.requirements.filter((item) => targetRequirementIds.has(item.id))) {
      const roadmap = await input.repository.getProjectRoadmap(claimed.project.id);
      const capability = roadmap?.capabilities.find((item) => item.requirement.id === requirement.id);
      if (capability?.status === 'satisfied') continue;

      const requirementWorkItems = (roadmap?.steps ?? []).filter((step) =>
        step.requirementIds.includes(requirement.id)
      );
      if (requirementWorkItems.some((step) => step.status === 'pending' || step.status === 'running')) {
        deferredRequirementCount += 1;
        continue;
      }
      const workItems = requirementWorkItems.filter((step) => step.status === 'completed');
      const audit = await runCapabilityAudit({
        repository: input.repository,
        provider,
        project: claimed.project,
        cycleId: claimed.cycle.id,
        requirement,
        workItems,
        workspacePath: workspace.workspacePath,
        commitSha: workspace.commitSha,
        repositoryContext: [
          formatProjectArchitectureContext(claimed.project.projectArchitecture, `${requirement.title} ${requirement.description}`),
          await buildTargetedRepositoryContext(workspace.workspacePath, [
            requirement.id,
            requirement.title,
            requirement.description,
            ...requirement.acceptanceCriteria
          ])
        ].filter(Boolean).join('\n\n'),
        onActivity
      });

      if (audit.verdict === 'blocked') {
        await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', audit.summary);
        return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
      }
      if (audit.verdict === 'partial') {
        const created = await input.repository.appendProjectImplementationSteps({
          projectId: claimed.project.id,
          cycleId: claimed.cycle.id,
          steps: audit.gapWorkItems.map((step) => ({
            title: step.title,
            description: formatGapStepDescription(step),
            acceptanceCriteria: step.acceptanceCriteria,
            requirementIds: step.requirementIds,
            deliverables: step.deliverables,
            changeRationale: step.changeRationale,
            dependsOnStepTitles: step.dependsOnStepTitles,
            validationFocus: step.validationFocus
          }))
        });
        if (created.length === 0) {
          const message = 'Capability audit found a gap but did not produce a new, traceable work item.';
          await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', message);
          return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
        }
        await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
        const nextTask = await startNextRoadmapStep(input.repository, claimed.project.id, claimed.cycle.id);
        return {
          claimed: true,
          kind: 'project_audit',
          projectId: claimed.project.id,
          status: 'gaps_scheduled',
          gapStepCount: created.length,
          nextTaskId: nextTask?.id,
          provider: getLastProviderKind()
        };
      }
    }

    const finalRoadmap = await input.repository.getProjectRoadmap(claimed.project.id);
    const remainingSteps = finalRoadmap?.steps.filter((step) =>
      step.cycleId === claimed.cycle.id && (step.status === 'pending' || step.status === 'running')
    ) ?? [];
    if (remainingSteps.length > 0) {
      await input.repository.updateProjectRoadmapCycleStatus(claimed.cycle.id, 'active');
      await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
      const nextTask = await startNextRoadmapStep(input.repository, claimed.project.id, claimed.cycle.id);
      return {
        claimed: true,
        kind: 'project_audit',
        projectId: claimed.project.id,
        status: deferredRequirementCount > 0 ? 'roadmap_continued' : 'capabilities_satisfied',
        nextTaskId: nextTask?.id,
        provider: getLastProviderKind()
      };
    }
    const allSatisfied = Boolean(finalRoadmap?.capabilities.length)
      && finalRoadmap!.capabilities.every((capability) => capability.status === 'satisfied');
    if (!allSatisfied) throw new Error('Capability audit finished without satisfying every project requirement.');

    if (!hasSatisfiedReleaseAudit(finalRoadmap?.evidence ?? [], contract, workspace.commitSha)) {
      const releaseFocus = [
        contract.summary,
        ...contract.invariants,
        ...contract.releaseCriteria,
        ...activeProjectContractRequirements(contract).flatMap((requirement) => [
          requirement.id,
          requirement.title,
          requirement.description,
          ...requirement.acceptanceCriteria
        ])
      ];
      const releaseAudit = await runReleaseAudit({
        repository: input.repository,
        provider,
        project: claimed.project,
        cycleId: claimed.cycle.id,
        workspacePath: workspace.workspacePath,
        commitSha: workspace.commitSha,
        repositoryContext: [
          formatProjectArchitectureContext(claimed.project.projectArchitecture, contract.summary),
          await buildTargetedRepositoryContext(workspace.workspacePath, releaseFocus)
        ].filter(Boolean).join('\n\n'),
        onActivity
      });
      if (releaseAudit.verdict === 'blocked') {
        await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', releaseAudit.summary);
        return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
      }
      if (releaseAudit.verdict === 'partial') {
        const created = await input.repository.appendProjectImplementationSteps({
          projectId: claimed.project.id,
          cycleId: claimed.cycle.id,
          newRequirements: releaseAudit.contractAmendments,
          steps: releaseAudit.gapWorkItems.map((step) => ({
            title: step.title,
            description: formatGapStepDescription(step),
            acceptanceCriteria: step.acceptanceCriteria,
            requirementIds: step.requirementIds,
            deliverables: step.deliverables,
            changeRationale: step.changeRationale,
            dependsOnStepTitles: step.dependsOnStepTitles,
            validationFocus: step.validationFocus
          }))
        });
        if (created.length === 0) {
          const message = 'Release audit found a gap but did not produce a new, traceable work item.';
          await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', message);
          return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
        }
        await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
        const nextTask = await startNextRoadmapStep(input.repository, claimed.project.id, claimed.cycle.id);
        return {
          claimed: true,
          kind: 'project_audit',
          projectId: claimed.project.id,
          status: 'release_gaps_scheduled',
          gapStepCount: created.length,
          nextTaskId: nextTask?.id,
          provider: getLastProviderKind()
        };
      }
    }

    const planningProviderModel = resolveProviderModel(selection.primary.kind, selection.primary.connection);
    const planningConnectionId = selection.primary.connection?.id;
    const hasCompatiblePlanningSession = claimed.project.planningSessionProvider === selection.primary.kind
      && claimed.project.planningSessionModel === planningProviderModel
      && claimed.project.planningSessionConnectionId === planningConnectionId;
    const planningSession: ProviderSessionContext = {
      id: hasCompatiblePlanningSession ? claimed.project.planningSessionId : undefined,
      provider: selection.primary.kind,
      model: planningProviderModel,
      onUpdate: async (session) => {
        const connectionId = session.provider === selection.primary.kind
          ? selection.primary.connection?.id
          : selection.fallback?.connection?.id;
        await input.repository.updateProjectPlanningSession({
          projectId: claimed.project.id,
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          connectionId
        });
      }
    };
    const extensionPlan = await provider.plan({
      taskId: `project-extension:${claimed.cycle.id}`,
      title: `Next extension for ${claimed.project.name}`,
      prompt: buildProjectExtensionProposalPrompt({
        projectName: claimed.project.name,
        completedObjective: claimed.cycle.objective,
        contractVersion: contract.version,
        contractSummary: contract.summary,
        completedCapabilities: activeProjectContractRequirements(contract).map((requirement) => requirement.title),
        projectBrief: claimed.project.brief,
        continuation: hasCompatiblePlanningSession
      }),
      repositoryPath: workspace.workspacePath,
      onActivity,
      session: planningSession
    });
    const extensionProposal = formatProjectExtensionProposal(extensionPlan);
    await input.repository.updateProjectRoadmapCycleStatus(claimed.cycle.id, 'completed');
    await input.repository.setProjectRoadmapCycleExtensionProposal(claimed.cycle.id, {
      proposal: extensionProposal,
      status: 'awaiting_extension_approval'
    });
    await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
    return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'awaiting_extension_approval', provider: getLastProviderKind() };
  } catch (error) {
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    const finalized = await input.repository.finalizeProjectAudit(claimed.job.id, 'failed', message);
    return {
      claimed: true,
      kind: 'project_audit',
      projectId: claimed.project.id,
      status: finalized.retryScheduled ? 'retry_scheduled' : 'failed',
      errorMessage: message
    };
  } finally {
    stopAuditHeartbeat();
    await cleanup?.();
  }
}

function formatGapStepDescription(step: {
  description: string;
  inScope: string[];
  outOfScope: string[];
}): string {
  return [
    step.description,
    step.inScope.length > 0 ? `In scope:\n${step.inScope.map((item) => `- ${item}`).join('\n')}` : '',
    step.outOfScope.length > 0 ? `Out of scope:\n${step.outOfScope.map((item) => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

interface RuntimeProvider {
  kind: ProviderKind;
  contextId: string;
  connectionId: string | null;
  model: string | null;
  provider: AIProvider;
}

function buildRuntimeProvider(kind: ProviderKind, connection?: AIProviderConnectionSecret): RuntimeProvider {
  const contextId = connection?.id ?? `${kind}:env`;

  return {
    kind,
    contextId,
    connectionId: connection?.id ?? null,
    model: resolveProviderModel(kind, connection),
    provider: createProvider(kind, connection?.provider === kind ? {
      apiKey: connection.apiKey,
      authMode: connection.authMode,
      codexHome: connection.codexHome,
      model: connection.model
    } : undefined)
  };
}

interface ProviderPolicyAuditEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

interface PolicyAwareProviderInput {
  primary: RuntimeProvider;
  fallback?: RuntimeProvider;
  audit?: (event: ProviderPolicyAuditEvent) => Promise<unknown>;
}

function createPolicyAwareProvider(input: PolicyAwareProviderInput): { provider: AIProvider; getLastProviderKind: () => ProviderKind } {
  let lastProviderKind: ProviderKind = input.primary.kind;
  const failureThreshold = clampNumber(Number(process.env.FORGEMIND_PROVIDER_CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 3), 1, 10);
  const openMs = clampNumber(Number(process.env.FORGEMIND_PROVIDER_CIRCUIT_BREAKER_OPEN_MS ?? 300_000), 1_000, 3_600_000);

  const callWithFallback = async <T>(operation: string, action: (provider: AIProvider) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const primaryBreaker = getProviderCircuitBreaker(input.primary.contextId, failureThreshold);
    const primaryAvailability = resolveCircuitBreakerAvailability(primaryBreaker);
    if (primaryAvailability.state === 'open') {
      await auditProviderCircuitBreaker(input, input.primary, operation, 'primary_skipped', primaryBreaker);
      return callFallbackOrThrow(operation, action, signal, new ProviderExecutionError(operation, 'circuit breaker is open', input.primary.kind), true);
    }

    try {
      const result = await action(input.primary.provider);
      lastProviderKind = input.primary.kind;
      await recordProviderSuccess(input, input.primary, operation, primaryBreaker);
      return result;
    } catch (primaryError) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new TaskCancellationError();
      }
      const normalizedPrimaryError = normalizeProviderError(input.primary.kind, primaryError);
      await recordProviderFailure(input, input.primary, operation, primaryBreaker, normalizedPrimaryError.toDetails(), openMs);
      return callFallbackOrThrow(operation, action, signal, primaryError, normalizedPrimaryError.retryable);
    }
  };

  const callFallbackOrThrow = async <T>(
    operation: string,
    action: (provider: AIProvider) => Promise<T>,
    signal: AbortSignal | undefined,
    primaryError: unknown,
    primaryIsRetryable: boolean
  ): Promise<T> => {
    const fallback = input.fallback;
    const shouldUseFallback = Boolean(
      primaryIsRetryable
      && fallback
      && providersAreSemanticallyEquivalent(input.primary, fallback)
      && (fallback.kind !== input.primary.kind || fallback.contextId !== input.primary.contextId)
    );
    if (fallback && shouldUseFallback) {
      const fallbackBreaker = getProviderCircuitBreaker(fallback.contextId, failureThreshold);
      const fallbackAvailability = resolveCircuitBreakerAvailability(fallbackBreaker);
      if (fallbackAvailability.state === 'open') {
        await auditProviderCircuitBreaker(input, fallback, operation, 'primary_skipped', fallbackBreaker);
        throw new ProviderExecutionError(operation, 'primary and fallback circuit breakers are open', input.primary.kind);
      }
      await input.audit?.({
        eventType: 'provider_fallback_used',
        payload: {
          operation,
          primaryProvider: input.primary.kind,
          primaryConnectionId: input.primary.connectionId,
          fallbackProvider: fallback.kind,
          fallbackConnectionId: fallback.connectionId,
          fallbackModel: fallback.model,
          policy: 'semantically_equivalent_same_operation_retryable_primary_failure'
        }
      });
      try {
        const result = await action(fallback.provider);
        lastProviderKind = fallback.kind;
        await recordProviderSuccess(input, fallback, operation, fallbackBreaker);
        return result;
      } catch (fallbackError) {
        const normalizedFallbackError = normalizeProviderError(fallback.kind, fallbackError);
        await recordProviderFailure(input, fallback, operation, fallbackBreaker, normalizedFallbackError.toDetails(), openMs);
        throw new ProviderExecutionError(operation, toErrorMessage(fallbackError), fallback.kind);
      }
    }

    if (fallback && primaryIsRetryable && !providersAreSemanticallyEquivalent(input.primary, fallback)) {
      await input.audit?.({
        eventType: 'provider_fallback_skipped',
        payload: {
          operation,
          primaryProvider: input.primary.kind,
          primaryConnectionId: input.primary.connectionId,
          primaryModel: input.primary.model,
          fallbackProvider: fallback.kind,
          fallbackConnectionId: fallback.connectionId,
          fallbackModel: fallback.model,
          reason: 'fallback_not_semantically_equivalent'
        }
      });
    }

    throw new ProviderExecutionError(operation, toErrorMessage(primaryError), input.primary.kind);
  };

  const provider: AIProvider = {
    kind: input.primary.kind,
    async preflight(signal) {
      return callWithFallback('preflight', (provider) => provider.preflight(signal), signal);
    },
    supportsLocalRepo: () => input.primary.provider.supportsLocalRepo(),
    supportsGitHubNativeFlow: () => input.primary.provider.supportsGitHubNativeFlow(),
    async plan(planInput) {
      return callWithFallback('plan', (provider) => provider.plan(planInput), planInput.signal);
    },
    async implement(implementInput) {
      return callWithFallback('implement', (provider) => provider.implement(implementInput), implementInput.signal);
    },
    async review(reviewInput) {
      return callWithFallback('review', (provider) => provider.review(reviewInput), reviewInput.signal);
    },
    async auditCapability(auditInput) {
      return callWithFallback('audit_capability', (provider) => {
        if (!provider.auditCapability) throw new Error('Configured provider does not support capability audits.');
        return provider.auditCapability(auditInput);
      });
    },
    async auditRelease(auditInput) {
      return callWithFallback('audit_release', (provider) => {
        if (!provider.auditRelease) throw new Error('Configured provider does not support release audits.');
        return provider.auditRelease(auditInput);
      });
    },
    async estimateCost(costInput) {
      return callWithFallback('estimate_cost', (provider) => provider.estimateCost(costInput));
    }
  };

  return {
    provider,
    getLastProviderKind: () => lastProviderKind
  };
}

function providersAreSemanticallyEquivalent(primary: RuntimeProvider, fallback: RuntimeProvider): boolean {
  return primary.kind === fallback.kind && primary.model === fallback.model;
}

interface ProviderCircuitBreakerRuntimeState extends ProviderCircuitBreakerSnapshot {
  halfOpenInFlight?: boolean;
}

const providerCircuitBreakers = new Map<string, ProviderCircuitBreakerRuntimeState>();

export function resetProviderCircuitBreakersForTests(): void {
  if (process.env.NODE_ENV === 'test') providerCircuitBreakers.clear();
}

function getProviderCircuitBreaker(contextId: string, failureThreshold: number): ProviderCircuitBreakerRuntimeState {
  const existing = providerCircuitBreakers.get(contextId);
  if (existing) {
    existing.failureThreshold = failureThreshold;
    return existing;
  }
  const created: ProviderCircuitBreakerRuntimeState = {
    state: 'closed',
    failureCount: 0,
    failureThreshold
  };
  providerCircuitBreakers.set(contextId, created);
  return created;
}

function resolveCircuitBreakerAvailability(state: ProviderCircuitBreakerRuntimeState): { state: 'closed' | 'open' | 'half_open' } {
  if (state.state !== 'open' || !state.openedUntil) return { state: state.state };
  const openedUntilMs = Date.parse(state.openedUntil);
  if (Number.isFinite(openedUntilMs) && openedUntilMs > Date.now()) return { state: 'open' };
  if (state.halfOpenInFlight) return { state: 'open' };
  state.state = 'half_open';
  state.halfOpenInFlight = true;
  return { state: 'half_open' };
}

async function recordProviderSuccess(
  input: PolicyAwareProviderInput,
  runtimeProvider: RuntimeProvider,
  operation: string,
  breaker: ProviderCircuitBreakerRuntimeState
): Promise<void> {
  const wasRecovering = breaker.state !== 'closed' || breaker.failureCount > 0;
  breaker.state = 'closed';
  breaker.failureCount = 0;
  breaker.openedAt = undefined;
  breaker.openedUntil = undefined;
  breaker.lastFailureAt = undefined;
  breaker.lastFailureKind = undefined;
  breaker.lastFailureMessage = undefined;
  breaker.halfOpenInFlight = false;
  await input.audit?.({
    eventType: 'provider_request_succeeded',
    payload: {
      operation,
      provider: runtimeProvider.kind,
      connectionId: runtimeProvider.connectionId,
      model: runtimeProvider.model,
      circuitBreaker: snapshotProviderCircuitBreaker(breaker),
      recoveredCircuitBreaker: wasRecovering
    }
  });
}

async function recordProviderFailure(
  input: PolicyAwareProviderInput,
  runtimeProvider: RuntimeProvider,
  operation: string,
  breaker: ProviderCircuitBreakerRuntimeState,
  error: NormalizedProviderErrorDetails,
  openMs: number
): Promise<void> {
  const now = new Date();
  breaker.failureCount = Math.min(breaker.failureCount + 1, breaker.failureThreshold);
  breaker.lastFailureAt = now.toISOString();
  breaker.lastFailureKind = error.kind;
  breaker.lastFailureMessage = error.auditSafeMessage;
  breaker.halfOpenInFlight = false;
  if (error.retryable && breaker.failureCount >= breaker.failureThreshold) {
    breaker.state = 'open';
    breaker.openedAt = now.toISOString();
    breaker.openedUntil = new Date(now.getTime() + openMs).toISOString();
  } else if (breaker.state === 'half_open') {
    breaker.state = 'open';
    breaker.openedAt = now.toISOString();
    breaker.openedUntil = new Date(now.getTime() + openMs).toISOString();
  }

  await auditProviderCircuitBreaker(input, runtimeProvider, operation, 'failure_recorded', breaker, error);
}

async function auditProviderCircuitBreaker(
  input: PolicyAwareProviderInput,
  runtimeProvider: RuntimeProvider,
  operation: string,
  reason: 'failure_recorded' | 'primary_skipped',
  breaker: ProviderCircuitBreakerRuntimeState,
  error?: NormalizedProviderErrorDetails
): Promise<void> {
  await input.audit?.({
    eventType: 'provider_circuit_breaker_state',
    payload: {
      operation,
      reason,
      provider: runtimeProvider.kind,
      connectionId: runtimeProvider.connectionId,
      model: runtimeProvider.model,
      circuitBreaker: snapshotProviderCircuitBreaker(breaker),
      error: error
        ? {
            kind: error.kind,
            retryable: error.retryable,
            statusCode: error.statusCode ?? null,
            auditSafeMessage: error.auditSafeMessage
          }
        : null
    }
  });
}

function snapshotProviderCircuitBreaker(state: ProviderCircuitBreakerRuntimeState): ProviderCircuitBreakerSnapshot {
  return {
    state: state.state,
    failureCount: state.failureCount,
    failureThreshold: state.failureThreshold,
    openedAt: state.openedAt,
    openedUntil: state.openedUntil,
    lastFailureAt: state.lastFailureAt,
    lastFailureKind: state.lastFailureKind,
    lastFailureMessage: state.lastFailureMessage
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseProjectConfig(configYaml?: string): AgentConfig | undefined {
  if (!configYaml) return undefined;

  try {
    return parseAgentConfigYaml(configYaml);
  } catch {
    return undefined;
  }
}

async function readAIProviderConnectionSecret(repository: {
  getAIProviderConnectionSecret?: () => Promise<AIProviderConnectionSecret | undefined>;
}): Promise<AIProviderConnectionSecret | undefined> {
  return repository.getAIProviderConnectionSecret ? repository.getAIProviderConnectionSecret() : undefined;
}

async function readAIProviderConnectionSecretById(
  repository: {
    getAIProviderConnectionSecretById?: (connectionId: string) => Promise<AIProviderConnectionSecret | undefined>;
  },
  connectionId: string
): Promise<AIProviderConnectionSecret | undefined> {
  return repository.getAIProviderConnectionSecretById ? repository.getAIProviderConnectionSecretById(connectionId) : undefined;
}

async function resolveProviderSelection(input: {
  repository: {
    getAIProviderConnectionSecretById?: (connectionId: string) => Promise<AIProviderConnectionSecret | undefined>;
  };
  projectConfig: AgentConfig | undefined;
  projectProviderConnectionId?: string;
  defaultConnection?: AIProviderConnectionSecret;
  providerOverride?: ProviderKind;
  fallbackProviderOverride?: ProviderKind;
  providerConnectionIdOverride?: string;
  fallbackProviderConnectionIdOverride?: string;
}): Promise<{
  primary: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
  fallback?: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
}> {
  const primaryConnectionId = input.providerConnectionIdOverride
    ?? input.projectConfig?.ai.primary_connection_id?.trim()
    ?? input.projectProviderConnectionId;
  const primaryConnection = primaryConnectionId
    ? await readAIProviderConnectionSecretById(input.repository, primaryConnectionId)
    : input.defaultConnection;

  if (primaryConnectionId && !primaryConnection) {
    throw new Error(`Primary provider connection "${primaryConnectionId}" does not exist.`);
  }

  const primaryKind = input.providerOverride
    ?? primaryConnection?.provider
    ?? input.projectConfig?.ai.primary_provider
    ?? 'codex';
  const normalizedPrimaryConnection = primaryConnection?.provider === primaryKind ? primaryConnection : undefined;

  const fallbackConnectionId = input.fallbackProviderConnectionIdOverride
    ?? input.projectConfig?.ai.fallback_connection_id?.trim();
  const fallbackConnection = fallbackConnectionId
    ? await readAIProviderConnectionSecretById(input.repository, fallbackConnectionId)
    : undefined;

  if (fallbackConnectionId && !fallbackConnection) {
    throw new Error(`Fallback provider connection "${fallbackConnectionId}" does not exist.`);
  }

  const fallbackKind = input.fallbackProviderOverride
    ?? fallbackConnection?.provider
    ?? input.projectConfig?.ai.fallback_provider;

  if (!fallbackKind) {
    return { primary: { kind: primaryKind, connection: normalizedPrimaryConnection } };
  }

  const normalizedFallbackConnection = fallbackConnection?.provider === fallbackKind ? fallbackConnection : undefined;
  const hasDistinctFallback =
    fallbackKind !== primaryKind
    || (normalizedFallbackConnection?.id ?? null) !== (normalizedPrimaryConnection?.id ?? null);

  if (!hasDistinctFallback) {
    return { primary: { kind: primaryKind, connection: normalizedPrimaryConnection } };
  }

  return {
    primary: { kind: primaryKind, connection: normalizedPrimaryConnection },
    fallback: { kind: fallbackKind, connection: normalizedFallbackConnection }
  };
}

async function resolveReviewerSelection(input: {
  repository: {
    getAIProviderConnectionSecretById?: (connectionId: string) => Promise<AIProviderConnectionSecret | undefined>;
  };
  projectConfig: AgentConfig | undefined;
  primary: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
  fallback?: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
  defaultConnection?: AIProviderConnectionSecret;
}): Promise<{ kind: ProviderKind; connection?: AIProviderConnectionSecret }> {
  const kind = input.projectConfig?.ai.reviewer_provider ?? input.primary.kind;
  const connectionId = input.projectConfig?.ai.reviewer_connection_id?.trim();
  if (connectionId) {
    const connection = await readAIProviderConnectionSecretById(input.repository, connectionId);
    if (!connection) throw new Error(`Reviewer provider connection "${connectionId}" does not exist.`);
    if (connection.provider !== kind) {
      throw new Error(`Reviewer provider connection "${connectionId}" is configured for ${connection.provider}, not ${kind}.`);
    }
    return { kind, connection };
  }
  if (input.primary.kind === kind) return { kind, connection: input.primary.connection };
  if (input.fallback?.kind === kind) return { kind, connection: input.fallback.connection };
  if (input.defaultConnection?.provider === kind) return { kind, connection: input.defaultConnection };
  return { kind };
}

function resolveProviderModel(provider: ProviderKind, connection: AIProviderConnectionSecret | undefined): string {
  if (connection?.provider === provider) {
    return connection.model;
  }

  if (provider === 'github_copilot' && process.env.COPILOT_MODEL) {
    return process.env.COPILOT_MODEL;
  }

  if (provider === 'openai' && process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL;
  }

  if (provider === 'codex' && process.env.CODEX_MODEL) {
    return process.env.CODEX_MODEL;
  }

  if (provider === 'github_copilot') {
    return 'gpt-5.4';
  }

  return provider;
}

function resolveVerifyCommand(configYaml?: string): string | undefined {
  if (process.env.FORGEMIND_VERIFY_COMMAND) {
    return process.env.FORGEMIND_VERIFY_COMMAND;
  }

  if (!configYaml) {
    return undefined;
  }

  try {
    const config = parseAgentConfigYaml(configYaml);
    return config.commands.verify ?? config.commands.build;
  } catch {
    return undefined;
  }
}

class ProviderExecutionError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly providerKind: ProviderKind
  ) {
    super(`Provider ${providerKind} ${operation} failed: ${message}`);
    this.name = 'ProviderExecutionError';
  }
}
