import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseAgentConfigYaml, toCoreLimits, type AgentConfig } from '@forgemind/config';
import { activeProjectContractRequirements, DEFAULT_LIMITS, evaluateLimits, requiresApproval, type Limits, type LimitUsage } from '@forgemind/core';
import { advanceRoadmapAfterTaskCompletion, createRepository, getPrismaClient, startNextRoadmapStep, type AIProviderConnectionSecret, type ForgeMindRepository } from '@forgemind/db';
import { GitHubAppAdapter, createGitHubAdapterFromEnv, type GitHubChecksResult } from '@forgemind/github';
import { buildProjectExtensionProposalPrompt, createProvider, formatProjectExtensionProposal, type AIProvider, type ProviderSessionContext, type ReviewResult, type ValidationCheck } from '@forgemind/providers';
import type { AcceptanceEvidence, ApprovalType, Project, ProjectArchitectureUpdate, ProjectContract, ProviderKind, TaskStatus } from '@forgemind/core';
import { toErrorMessage, type JsonValue } from '@forgemind/shared';
import { formatProjectArchitectureContext, runWorkerTask, type WorkerTaskResult, type WorkerTaskResume } from './workflow.js';
import { buildTargetedRepositoryContext, prepareCapabilityAuditWorkspace, runCapabilityAudit, runReleaseAudit } from './capability-audit.js';
import { formatValidationFailure } from './validation.js';

type ApprovedLimitSignal = 'diff_lines_limit_reached' | 'changed_files_limit_reached';

class TaskCancellationError extends Error {
  constructor() {
    super('Task execution was cancelled by the user.');
    this.name = 'TaskCancellationError';
  }
}

interface TaskResumeContext {
  workflowResume: WorkerTaskResume;
  ignoredLimitSignals: ApprovedLimitSignal[];
}

interface TaskDiffIterationSnapshot {
  phase: string;
  prompt: string;
  resultSummary: string;
  diffStat?: unknown;
  validationResult: unknown;
  createdAt?: string;
}

interface TaskAuditSnapshot {
  eventType: string;
  payload: unknown;
  createdAt: string;
}

interface PlannedValidationCheckSnapshot {
  kind?: string;
  command?: string;
  instructions?: string;
  criterion?: string;
  rationale?: string;
  category?: string;
}

interface TaskCheckpointSnapshot {
  key: string;
  phase: string;
  status: 'started' | 'completed' | 'failed';
  inputHash: string;
  output?: unknown;
}

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
  const recoveredProjectAudits = await repository.recoverStuckProjectAudits(claimTimeoutMinutes);
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
    return {
      claimed: false,
      message: 'No submitted task or project audit found.',
      recoveredQueueJobs: recovery.recoveredCount,
      recoveredProjectAudits
    };
  }
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
    errorMessage?: string
  ) => {
    stopQueueHeartbeat();
    stopCancellationWatcher();
    stopInterruptionRecovery();
    if (errorMessage === undefined) {
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
    fallback: fallbackRuntimeProvider
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
    claimed.taskRun.id
  );
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
            eventType: 'task_activity',
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
              exitCode: activity.exitCode ?? null
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
          if (activity.usage) {
            measuredUsage.measurements += 1;
            measuredUsage.totalTokens += activity.usage.totalTokens;
            if (activity.usage.inputTokens === undefined || activity.usage.outputTokens === undefined) {
              measuredUsage.completeBreakdown = false;
            } else {
              measuredUsage.inputTokens += activity.usage.inputTokens;
              measuredUsage.outputTokens += activity.usage.outputTokens;
              measuredUsage.cachedTokens += activity.usage.cachedTokens ?? 0;
            }
            if (activity.usage.actualCostUsd === undefined) {
              measuredUsage.completeCost = false;
            } else {
              measuredUsage.actualCostUsd += activity.usage.actualCostUsd;
            }

            await repository.recordProviderUsage({
              taskId: claimed.task.id,
              taskRunId: claimed.taskRun.id,
              provider: activity.usage.provider,
              model: activity.usage.model,
              phase: activity.phase,
              attempt: activity.attempt,
              inputTokens: activity.usage.inputTokens ?? 0,
              outputTokens: activity.usage.outputTokens ?? 0,
              cachedTokens: activity.usage.cachedTokens ?? 0,
              totalTokens: activity.usage.totalTokens,
              usageSource: activity.usage.source,
              estimatedCostUsd: 0,
              actualCostUsd: activity.usage.actualCostUsd
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
              usage: activity.usage
                ? {
                    provider: activity.usage.provider,
                    model: activity.usage.model,
                    totalTokens: activity.usage.totalTokens,
                    inputTokens: activity.usage.inputTokens ?? null,
                    outputTokens: activity.usage.outputTokens ?? null,
                    cachedTokens: activity.usage.cachedTokens ?? null,
                    source: activity.usage.source,
                    actualCostUsd: activity.usage.actualCostUsd ?? null
                  }
                : null
            }
          });
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
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('failed', result.validation.stderr || 'Validation failed.');
    } else if (result.status === 'failed') {
      await repository.failTask(claimed.task.id, result.summary, 'failed');
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'failed',
        summary: result.summary,
        errorMessage: result.summary,
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('failed', result.summary);
    } else {
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

function startTaskCancellationWatcher(
  repository: Pick<ForgeMindRepository, 'getTask'>,
  taskId: string,
  controller: AbortController
): () => void {
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking || controller.signal.aborted) return;
    checking = true;
    try {
      const task = await repository.getTask(taskId);
      if (task?.status === 'cancelled') controller.abort(new TaskCancellationError());
    } catch {
      // A transient read failure must not terminate the worker; the next poll retries it.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 500);
  timer.unref?.();
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function throwIfTaskCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new TaskCancellationError();
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
      fallback: selection.fallback ? buildRuntimeProvider(selection.fallback.kind, selection.fallback.connection) : undefined
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

function sanitizeAuditErrorMessage(message: string): string {
  return message.replace(/https:\/\/[^@\s]+@/gi, 'https://[credential-redacted]@');
}

function hasSatisfiedReleaseAudit(evidence: AcceptanceEvidence[], contract: ProjectContract, commitSha: string): boolean {
  const passedCriteria = new Set(evidence
    .filter((item) =>
      item.source === 'repository_audit'
      && item.status === 'passed'
      && item.contractVersion === contract.version
      && item.commitSha === commitSha
      && item.criterion.startsWith('Release: ')
    )
    .map((item) => item.criterion.slice('Release: '.length).replace(/\s+/g, ' ').trim().toLowerCase()));
  return [...contract.invariants, ...contract.releaseCriteria, 'Original brief coverage']
    .every((criterion) => passedCriteria.has(criterion.replace(/\s+/g, ' ').trim().toLowerCase()));
}

interface RuntimeProvider {
  kind: ProviderKind;
  contextId: string;
  provider: AIProvider;
}

function buildRuntimeProvider(kind: ProviderKind, connection?: AIProviderConnectionSecret): RuntimeProvider {
  const contextId = connection?.id ?? `${kind}:env`;

  return {
    kind,
    contextId,
    provider: createProvider(kind, connection?.provider === kind ? {
      apiKey: connection.apiKey,
      authMode: connection.authMode,
      codexHome: connection.codexHome,
      model: connection.model
    } : undefined)
  };
}

function createPolicyAwareProvider(input: {
  primary: RuntimeProvider;
  fallback?: RuntimeProvider;
}): { provider: AIProvider; getLastProviderKind: () => ProviderKind } {
  let lastProviderKind: ProviderKind = input.primary.kind;

  const callWithFallback = async <T>(operation: string, action: (provider: AIProvider) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      const result = await action(input.primary.provider);
      lastProviderKind = input.primary.kind;
      return result;
    } catch (primaryError) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new TaskCancellationError();
      }
      const fallback = input.fallback;
      const shouldUseFallback = Boolean(
        fallback
        && (fallback.kind !== input.primary.kind || fallback.contextId !== input.primary.contextId)
      );
      if (fallback && shouldUseFallback) {
        try {
          const result = await action(fallback.provider);
          lastProviderKind = fallback.kind;
          return result;
        } catch (fallbackError) {
          throw new ProviderExecutionError(operation, toErrorMessage(fallbackError), fallback.kind);
        }
      }

      throw new ProviderExecutionError(operation, toErrorMessage(primaryError), input.primary.kind);
    }
  };

  const provider: AIProvider = {
    kind: input.primary.kind,
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

  return Array.from(new Set(approvals));
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

export function resolveWorkerWorkspaceRoot(): string {
  if (process.env.FORGEMIND_WORKSPACE_ROOT?.trim()) {
    return resolve(process.env.FORGEMIND_WORKSPACE_ROOT);
  }

  return join(tmpdir(), 'forgemind-workspaces');
}

function resolveLimits(configYaml: string | undefined, maxIterations: number): Limits {
  let limits = DEFAULT_LIMITS;
  if (configYaml) {
    try {
      limits = toCoreLimits(parseAgentConfigYaml(configYaml));
    } catch {
      limits = DEFAULT_LIMITS;
    }
  }

  return {
    ...limits,
    maxIterations
  };
}

function extractAttemptNumber(iteration: {
  phase: string;
  validationResult?: unknown;
}): number {
  const payload =
    iteration.validationResult && typeof iteration.validationResult === 'object' && !Array.isArray(iteration.validationResult)
      ? (iteration.validationResult as Record<string, unknown>)
      : undefined;
  const attempt = typeof payload?.attempt === 'number' && Number.isFinite(payload.attempt) ? payload.attempt : undefined;

  if (attempt && attempt > 0) {
    return attempt;
  }

  return iteration.phase === 'planning' ? 0 : 1;
}

async function handleWorkerLimitsOrThrow(
  repository: {
    transitionTask: (taskId: string, status: TaskStatus, payload?: JsonValue) => Promise<unknown>;
    createApproval: (input: {
      taskId: string;
      type: ApprovalType;
      requestedBy: 'system' | 'agent' | 'user';
      title: string;
      description: string;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      payload: JsonValue;
    }) => Promise<unknown>;
  },
  taskId: string,
  usage: LimitUsage,
  limits: Limits,
  ignoredLimitSignals: ApprovedLimitSignal[] = [],
  taskMode: 'safe' | 'auto' | 'full_auto' = 'safe',
  approvalRequiredFor: ReadonlySet<ApprovalType> = new Set(),
  allowSafeOperationsWithoutApproval = false,
  allowRuntimeGrace = false
): Promise<void> {
  const limitEvaluation = evaluateLimits(usage, limits);
  const ignoredSignals = new Set(ignoredLimitSignals);
  const stopSignal = limitEvaluation.signals.find(
    (signal) =>
      !(allowRuntimeGrace && signal === 'runtime_limit_reached')
      && !ignoredSignals.has(signal as ApprovedLimitSignal)
  );
  if (!stopSignal) return;

  if (stopSignal === 'diff_lines_limit_reached' || stopSignal === 'changed_files_limit_reached') {
    const approvalType: ApprovalType = 'risky_refactor';
    const modeRequiresApproval = taskMode === 'safe' && allowSafeOperationsWithoutApproval
      ? false
      : requiresApproval(approvalType, taskMode);
    if (!modeRequiresApproval && !approvalRequiredFor.has(approvalType)) return;

    const usagePayload = toLimitUsagePayload(usage);
    const limitsPayload = toLimitsPayload(limits);
    const description =
      stopSignal === 'diff_lines_limit_reached'
        ? `Current diff has ${usage.diffLines} changed line(s), which exceeds the configured limit of ${limits.maxDiffLines}.`
        : `Current diff touches ${usage.changedFiles} file(s), which exceeds the configured limit of ${limits.maxChangedFiles}.`;

    await repository.transitionTask(taskId, 'needs_approval', {
      approvals: [approvalType],
      limitSignal: stopSignal,
      usage: usagePayload
    });
    await repository.createApproval({
      taskId,
      type: approvalType,
      requestedBy: 'agent',
      title: 'Approval required: large implementation diff',
      description,
      riskLevel: 'high',
      payload: {
        risk: 'Implementation diff exceeds configured guardrails.',
        recommendation: 'Review the current diff and approve only if the size and scope are intended.',
        limitSignal: stopSignal,
        usage: usagePayload,
        limits: limitsPayload
      }
    });
    throw new WorkerApprovalRequiredError(description);
  }

  throw new WorkerLimitError(stopSignalToTaskStatus(stopSignal), `Worker stopped because limit signal "${stopSignal}" was reached.`);
}

function toLimitUsagePayload(usage: LimitUsage): Record<string, JsonValue> {
  return {
    iterations: usage.iterations,
    runtimeMinutes: usage.runtimeMinutes,
    changedFiles: usage.changedFiles,
    diffLines: usage.diffLines,
    repeatedErrorCount: usage.repeatedErrorCount
  };
}

function toLimitsPayload(limits: Limits): Record<string, JsonValue> {
  return {
    maxIterations: limits.maxIterations,
    maxRuntimeMinutes: limits.maxRuntimeMinutes,
    maxChangedFiles: limits.maxChangedFiles,
    maxDiffLines: limits.maxDiffLines,
    maxRepeatedErrorCount: limits.maxRepeatedErrorCount
  };
}

function startQueueClaimHeartbeat(
  repository: {
    refreshQueueJobClaim?: (queueJobId: string) => Promise<boolean>;
  },
  queueJobId: string | undefined,
  claimTimeoutMinutes: number
): () => void {
  if (!queueJobId || typeof repository.refreshQueueJobClaim !== 'function') {
    return () => undefined;
  }

  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, claimTimeoutMinutes * 20_000));
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void repository.refreshQueueJobClaim!(queueJobId)
      .then((refreshed) => {
        if (!refreshed) {
          stopped = true;
          clearInterval(timer);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, heartbeatIntervalMs);
  timer.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

function startProjectAuditHeartbeat(
  repository: { refreshProjectAuditClaim?: (auditJobId: string) => Promise<boolean> },
  auditJobId: string,
  claimTimeoutMinutes: number
): () => void {
  if (typeof repository.refreshProjectAuditClaim !== 'function') return () => undefined;
  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, claimTimeoutMinutes * 20_000));
  const timer = setInterval(() => {
    void repository.refreshProjectAuditClaim!(auditJobId).catch(() => undefined);
  }, heartbeatIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function installWorkerInterruptionRecovery(input: {
  repository: {
    interruptClaimedTask?: (input: {
      queueJobId: string;
      taskId: string;
      taskRunId: string;
      signal: 'SIGTERM' | 'SIGINT';
    }) => Promise<boolean>;
  };
  queueJobId: string | undefined;
  taskId: string;
  taskRunId: string;
  stopQueueHeartbeat: () => void;
  deferInterruptSignals: boolean;
}): () => void {
  if (input.deferInterruptSignals || !input.queueJobId || typeof input.repository.interruptClaimedTask !== 'function') {
    return () => undefined;
  }

  let stopped = false;
  let handlingSignal = false;
  const handleSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    if (stopped || handlingSignal) return;
    handlingSignal = true;
    input.stopQueueHeartbeat();
    const forcedExitTimer = setTimeout(() => process.exit(1), 8_000);
    forcedExitTimer.unref();
    void input.repository.interruptClaimedTask!({
      queueJobId: input.queueJobId!,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      signal
    }).finally(() => {
      clearTimeout(forcedExitTimer);
      process.exit(0);
    });
  };
  const handleSigterm = () => handleSignal('SIGTERM');
  const handleSigint = () => handleSignal('SIGINT');
  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);

  return () => {
    if (stopped) return;
    stopped = true;
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
  };
}

async function resolveTaskResumeContext(
  repository: {
    listApprovals: () => Promise<Array<{ taskId: string; type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; payload: unknown; createdAt: string }>>;
    listTaskAudit: (taskId: string) => Promise<TaskAuditSnapshot[]>;
    getTaskDiff: (taskId: string) => Promise<{
      iterations: TaskDiffIterationSnapshot[];
    }>;
    listTaskCheckpoints?: (taskId: string) => Promise<TaskCheckpointSnapshot[]>;
  },
  taskId: string,
  queueReason?: string,
  currentTaskRunId?: string
): Promise<TaskResumeContext | undefined> {
  const [approvals, diff, audit, checkpoints] = await Promise.all([
    repository.listApprovals(),
    repository.getTaskDiff(taskId),
    repository.listTaskAudit(taskId),
    repository.listTaskCheckpoints?.(taskId) ?? Promise.resolve([])
  ]);
  const taskApprovals = approvals.filter((approval) => approval.taskId === taskId);
  const approvedTypes = new Set(taskApprovals.filter((approval) => approval.status === 'approved').map((approval) => approval.type));
  const lastPlanningIteration = findLastIteration(diff.iterations, 'planning');
  const lastImplementationIteration = findLastIteration(diff.iterations, 'implementation');
  const lastValidationIteration = findLastIteration(diff.iterations, 'validation');
  const lastReviewIteration = findLastIteration(diff.iterations, 'review');
  const architectureUpdate = extractArchitectureUpdate(lastImplementationIteration);
  const implementationResume = extractImplementationResume(lastImplementationIteration);
  const approvedReviewResume = buildApprovedReviewResume(lastPlanningIteration, lastImplementationIteration, lastReviewIteration, approvedTypes);
  if (approvedReviewResume) approvedReviewResume.architectureUpdate = architectureUpdate;
  const latestApprovedLargeDiffAt = getLatestApprovedLargeDiffAt(taskApprovals);
  const latestApprovedReviewAt = approvedReviewResume
    ? getLatestApprovedReviewAt(taskApprovals, approvedReviewResume.riskyChanges ?? [])
    : undefined;

  if (queueReason === 'task_retried' || queueReason === 'worker_interrupted' || queueReason === 'phase_retry') {
    const phaseRetryResume = buildPhaseRetryResume(diff.iterations, audit, approvedTypes, currentTaskRunId, checkpoints);
    if (phaseRetryResume) {
      return {
        workflowResume: phaseRetryResume,
        ignoredLimitSignals: [],
      };
    }
  }

  if (queueReason === 'worker_interrupted') {
    return {
      workflowResume: {
        kind: 'worker_interrupted',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary:
          lastImplementationIteration?.resultSummary
          ?? 'Continue the implementation preserved in the workspace after the worker was interrupted.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  if (queueReason === 'task_retried' && lastImplementationIteration && isFailedValidationIteration(lastValidationIteration)) {
    return {
      workflowResume: {
        kind: 'validation_retry',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary: lastImplementationIteration.resultSummary || 'Resume the preserved implementation for validation.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  if (latestApprovedLargeDiffAt && (!latestApprovedReviewAt || latestApprovedLargeDiffAt >= latestApprovedReviewAt)) {
    if (!lastImplementationIteration) {
      return undefined;
    }

    return {
      workflowResume: {
        kind: 'approved_large_diff',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary: lastImplementationIteration.resultSummary || 'Resuming previously approved implementation.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: ['diff_lines_limit_reached', 'changed_files_limit_reached']
    };
  }

  if (approvedReviewResume) {
    return {
      workflowResume: {
        ...approvedReviewResume,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  if (approvedTypes.size > 0 && (lastPlanningIteration || lastImplementationIteration)) {
    return {
      workflowResume: {
        kind: 'approved_operation',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary:
          lastImplementationIteration?.resultSummary
          ?? 'Resume workspace changes after the requested operation was approved.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  return undefined;
}

function buildPhaseRetryResume(
  iterations: TaskDiffIterationSnapshot[],
  audit: TaskAuditSnapshot[],
  approvedTypes: ReadonlySet<ApprovalType>,
  currentTaskRunId?: string,
  checkpoints: TaskCheckpointSnapshot[] = []
): WorkerTaskResume | undefined {
  const failureAt = findLatestFailureTimestamp(audit);
  if (failureAt === undefined) {
    return undefined;
  }

  const completedIterations = [...iterations].sort((left, right) => timestampOf(left.createdAt) - timestampOf(right.createdAt));
  const latestIteration = completedIterations.at(-1);
  const latestImplementation = findLastIteration(completedIterations, 'implementation');
  const latestValidation = findLastIteration(completedIterations, 'validation');
  const latestReview = findLastIteration(completedIterations, 'review');
  const latestPlanning = findLastIteration(completedIterations, 'planning');
  const relevantAudit = audit.filter((event) => {
    const payload = asRecord(event.payload);
    return !currentTaskRunId || payload?.taskRunId !== currentTaskRunId;
  });
  const latestGitHubFailure = [...relevantAudit]
    .reverse()
    .find((event) => event.eventType === 'task_github_operation_failed' && timestampOf(event.createdAt) <= failureAt);
  const latestIterationStarted = [...relevantAudit]
    .reverse()
    .find((event) => event.eventType === 'task_iteration_started' && timestampOf(event.createdAt) <= failureAt);
  const latestCompletedAt = timestampOf(latestIteration?.createdAt);
  const inFlightPhase = latestIterationStarted && timestampOf(latestIterationStarted.createdAt) > latestCompletedAt
    ? normalizeResumePhase(asRecord(latestIterationStarted.payload)?.phase)
    : undefined;

  let resumeFrom: NonNullable<WorkerTaskResume['resumeFrom']>;
  if (latestGitHubFailure && timestampOf(latestGitHubFailure.createdAt) > latestCompletedAt) {
    const failedOperation = asRecord(latestGitHubFailure.payload)?.operation;
    resumeFrom = failedOperation === 'create_issue' || failedOperation === 'create_branch' ? 'planning' : 'delivery';
  } else if (inFlightPhase === 'planning' && isFailedValidationIteration(latestValidation)) {
    resumeFrom = 'validation';
  } else if (inFlightPhase) {
    resumeFrom = inFlightPhase;
  } else if (latestIteration?.phase === 'review') {
    resumeFrom = extractReviewBlockers(latestReview).length > 0 ? 'implementation' : 'delivery';
  } else if (latestIteration?.phase === 'validation') {
    resumeFrom = isFailedValidationIteration(latestValidation) ? 'validation' : 'review';
  } else if (latestIteration?.phase === 'implementation') {
    resumeFrom = 'validation';
  } else if (latestIteration?.phase === 'planning') {
    const planningResult = asRecord(latestIteration.validationResult);
    const recoveryDecision = asRecord(planningResult?.validationRecovery);
    resumeFrom = planningResult?.revisedValidationChecksOnly === true || recoveryDecision?.action === 'blocked'
      ? 'validation'
      : 'implementation';
  } else {
    resumeFrom = 'planning';
  }

  const latestImplementationAt = timestampOf(latestImplementation?.createdAt);
  const validationIsCurrent = Boolean(
    latestValidation
    && timestampOf(latestValidation.createdAt) >= latestImplementationAt
  );
  const validation = validationIsCurrent
    ? extractValidationResult(latestValidation?.validationResult)
    : undefined;
  const reviewBlockers = extractReviewBlockers(latestReview);
  const reviewSafeImprovements = extractStringArray(latestReview?.validationResult, 'safeImprovements');
  const reviewRisks = normalizeRuntimeApprovals(extractUnknownArray(latestReview?.validationResult, 'riskyChanges'));
  const implementationPayload = asRecord(latestImplementation?.validationResult);
  const changedFiles = Array.isArray(implementationPayload?.changedFiles)
    ? implementationPayload.changedFiles.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const diffStat = normalizeResumeDiffStat(latestImplementation?.diffStat);
  const startedPayload = asRecord(latestIterationStarted?.payload);
  const attempt = typeof startedPayload?.attempt === 'number' && Number.isFinite(startedPayload.attempt)
    ? Math.max(1, Math.trunc(startedPayload.attempt))
    : extractLatestAttempt(completedIterations);
  const completedOperations = relevantAudit
    .filter((event) => timestampOf(event.createdAt) >= timestampOf(latestImplementation?.createdAt))
    .filter((event) => event.eventType === 'task_activity')
    .map((event) => asRecord(event.payload))
    .filter((payload) => payload?.state === 'completed' && typeof payload.operation === 'string')
    .map((payload) => payload!.operation as string);
  completedOperations.push(...checkpoints
    .filter((checkpoint) => checkpoint.status === 'completed' && checkpoint.key.startsWith('external:'))
    .map((checkpoint) => checkpoint.key.slice('external:'.length)));
  const completedValidationCommands = relevantAudit
    .filter((event) => timestampOf(event.createdAt) >= timestampOf(latestImplementation?.createdAt))
    .filter((event) => event.eventType === 'task_activity')
    .map((event) => asRecord(event.payload))
    .filter((payload) => (
      payload?.phase === 'validation'
      && payload.operation === 'validation_command'
      && payload.state === 'completed'
      && payload.exitCode === 0
      && typeof payload.detail === 'string'
    ))
    .map((payload) => payload!.detail as string);
  const persistedValidationCommands = validationIsCurrent
    ? extractStringArray(latestValidation?.validationResult, 'passedValidationCommands')
    : [];
  const passedValidationChecks: NonNullable<WorkerTaskResume['passedValidationChecks']> = Array.from(new Set([
    ...completedValidationCommands,
    ...persistedValidationCommands
  ])).map((command) => ({
      command,
      exitCode: 0,
      stdout: 'Previously passed before the worker retry.',
      stderr: '',
      passed: true
  }));
  for (const checkpoint of checkpoints.filter((item) => item.status === 'completed' && item.key.startsWith('validation:'))) {
    const output = asRecord(checkpoint.output);
    const command = typeof output?.command === 'string' ? output.command : undefined;
    if (!command || passedValidationChecks.some((item) => item.command === command && item.inputHash === checkpoint.inputHash)) continue;
    passedValidationChecks.push({
      command,
      exitCode: 0,
      stdout: 'Previously passed before the worker retry.',
      stderr: '',
      passed: true,
      inputHash: checkpoint.inputHash
    });
  }
  const latestPlanningResult = latestIteration?.phase === 'planning'
    ? asRecord(latestIteration.validationResult)
    : undefined;
  const completedValidationReplacement = latestPlanningResult?.revisedValidationChecksOnly === true;
  const resumeValidationPlanRevision = (
    resumeFrom === 'validation'
    && !completedValidationReplacement
    && Boolean(validation && !validation.passed && validation.failingCommand)
  );
  const githubChecksCheckpoint = [...checkpoints].reverse().find((checkpoint) => (
    checkpoint.status === 'completed' && checkpoint.key === 'external:wait_for_checks'
  ));
  const githubChecksOutput = asRecord(githubChecksCheckpoint?.output);
  const githubChecks: GitHubChecksResult | undefined = githubChecksOutput
    && (githubChecksOutput.status === 'success' || githubChecksOutput.status === 'not_configured')
    && typeof githubChecksOutput.summary === 'string'
    ? {
        status: githubChecksOutput.status as 'success' | 'not_configured',
        summary: githubChecksOutput.summary,
        failures: Array.isArray(githubChecksOutput.failures)
          ? githubChecksOutput.failures.flatMap((failure) => {
              const item = asRecord(failure);
              return item && typeof item.name === 'string' && typeof item.output === 'string'
                ? [{
                    name: item.name,
                    output: item.output,
                    detailsUrl: typeof item.detailsUrl === 'string' ? item.detailsUrl : undefined
                  }]
                : [];
            })
          : []
      }
    : undefined;
  const satisfactionReviewCheckpoint = [...checkpoints].reverse().find((checkpoint) => (
    checkpoint.status === 'completed' && checkpoint.key === 'review:already_satisfied'
  ));
  const satisfactionReviewOutput = asRecord(satisfactionReviewCheckpoint?.output);
  const completedSatisfactionReview = satisfactionReviewCheckpoint
    && typeof satisfactionReviewOutput?.summary === 'string'
    ? {
        inputHash: satisfactionReviewCheckpoint.inputHash,
        summary: satisfactionReviewOutput.summary,
        criterionResults: extractCriterionResults(satisfactionReviewOutput.criterionResults)
      }
    : undefined;

  return {
    kind: 'phase_retry',
    resumeFrom,
    attempt,
    planSummary: latestPlanning?.resultSummary,
    planSteps: extractStringArray(latestPlanning?.validationResult, 'steps'),
    acceptanceCriteria: extractStringArray(latestPlanning?.validationResult, 'acceptanceCriteria'),
    implementationSummary: latestImplementation?.resultSummary
      ?? 'Continue from the implementation preserved in the workspace.',
    ...extractImplementationResume(latestImplementation),
    changedFiles,
    diffStat,
    architectureUpdate: extractArchitectureUpdate(latestImplementation),
    previousValidationError: resumeFrom === 'implementation' && validation && !validation.passed
      ? formatValidationFailure(validation)
      : undefined,
    previousReviewBlockers: resumeFrom === 'implementation' ? reviewBlockers : undefined,
    previousSafeImprovements: resumeFrom === 'implementation' ? reviewSafeImprovements : undefined,
    validation,
    passedValidationChecks,
    resumeValidationPlanRevision,
    reviewSummary: latestReview?.resultSummary,
    riskyChanges: reviewRisks,
    validationChecks: extractLatestValidationChecks(completedIterations),
    approvedApprovals: Array.from(approvedTypes),
    completedOperations: Array.from(new Set(completedOperations)),
    githubChecks,
    githubChecksInputHash: githubChecksCheckpoint?.inputHash,
    completedSatisfactionReview
  };
}

function extractCriterionResults(value: unknown): ReviewResult['criterionResults'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results = value.flatMap((entry) => {
    const item = asRecord(entry);
    if (
      !item
      || typeof item.criterion !== 'string'
      || (item.status !== 'satisfied' && item.status !== 'not_satisfied' && item.status !== 'insufficient_evidence')
      || !Array.isArray(item.evidence)
      || item.evidence.some((evidence) => typeof evidence !== 'string')
    ) {
      return [];
    }
    const status = item.status as 'satisfied' | 'not_satisfied' | 'insufficient_evidence';
    return [{
      criterion: item.criterion,
      status,
      evidence: item.evidence as string[]
    }];
  });
  return results.length > 0 ? results : undefined;
}

function extractImplementationResume(
  iteration: TaskDiffIterationSnapshot | undefined
): Pick<WorkerTaskResume, 'implementationOutcome' | 'evidenceFiles'> {
  const payload = asRecord(iteration?.validationResult);
  const implementationOutcome = payload?.outcome === 'already_satisfied' || payload?.alreadySatisfied === true
    ? 'already_satisfied'
    : payload?.outcome === 'changes_made'
      ? 'changes_made'
      : undefined;
  const evidenceFiles = extractStringArray(iteration?.validationResult, 'evidenceFiles');
  return {
    implementationOutcome,
    evidenceFiles: evidenceFiles.length > 0 ? evidenceFiles : undefined
  };
}

function findLatestFailureTimestamp(audit: TaskAuditSnapshot[]): number | undefined {
  const failure = [...audit].reverse().find((event) => (
    event.eventType === 'task_failed'
    || event.eventType === 'task_worker_interrupted'
    || event.eventType === 'task_status_validation_failed'
    || event.eventType === 'task_status_iteration_limit_reached'
    || event.eventType === 'task_status_repeated_error_detected'
  ));
  return failure ? timestampOf(failure.createdAt) : undefined;
}

function normalizeResumePhase(value: unknown): WorkerTaskResume['resumeFrom'] | undefined {
  if (value === 'planning' || value === 'implementation' || value === 'validation' || value === 'review') {
    return value;
  }
  if (value === 'git' || value === 'github' || value === 'completion') {
    return 'delivery';
  }
  return undefined;
}

function extractValidationResult(value: unknown): WorkerTaskResume['validation'] {
  const payload = asRecord(value);
  const passed = resolveValidationPassed(payload);
  if (!payload || passed === undefined) return undefined;
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : passed ? 0 : 1;
  return {
    command: typeof payload.command === 'string' ? payload.command : 'resumed-validation',
    exitCode,
    stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
    stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
    passed,
    executedCheckCount: typeof payload.executedCheckCount === 'number' ? payload.executedCheckCount : undefined,
    reusedCheckCount: typeof payload.reusedCheckCount === 'number' ? payload.reusedCheckCount : undefined,
    failingCommand: !passed
      ? typeof payload.failingCommand === 'string'
        ? payload.failingCommand
        : typeof payload.command === 'string' ? payload.command : undefined
      : undefined
  };
}

function resolveValidationPassed(payload: Record<string, unknown> | undefined): boolean | undefined {
  if (!payload) return undefined;
  if (typeof payload.exitCode === 'number') return payload.exitCode === 0;
  return typeof payload.passed === 'boolean' ? payload.passed : undefined;
}

function extractReviewBlockers(iteration: TaskDiffIterationSnapshot | undefined): string[] {
  return extractStringArray(iteration?.validationResult, 'blockers');
}

function extractArchitectureUpdate(iteration: TaskDiffIterationSnapshot | undefined): ProjectArchitectureUpdate | undefined {
  const payload = asRecord(iteration?.validationResult);
  const update = asRecord(payload?.architectureUpdate);
  return update ? update as unknown as ProjectArchitectureUpdate : undefined;
}

function extractStringArray(value: unknown, key: string): string[] {
  return extractUnknownArray(value, key).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function extractUnknownArray(value: unknown, key: string): unknown[] {
  const payload = asRecord(value);
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}

function extractLatestValidationChecks(iterations: TaskDiffIterationSnapshot[]): WorkerTaskResume['validationChecks'] {
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const checks = extractValidationChecks(iterations[index]?.validationResult);
    if (checks?.length) return checks;
  }
  return undefined;
}

function normalizeResumeDiffStat(value: unknown): WorkerTaskResume['diffStat'] | undefined {
  const payload = asRecord(value);
  if (!payload) return undefined;
  const filesChanged = typeof payload.filesChanged === 'number' ? payload.filesChanged : 0;
  const insertions = typeof payload.insertions === 'number' ? payload.insertions : 0;
  const deletions = typeof payload.deletions === 'number' ? payload.deletions : 0;
  return { filesChanged, insertions, deletions };
}

function extractLatestAttempt(iterations: TaskDiffIterationSnapshot[]): number {
  return iterations.reduce((latest, iteration) => {
    const payload = asRecord(iteration.validationResult);
    return typeof payload?.attempt === 'number' ? Math.max(latest, Math.trunc(payload.attempt)) : latest;
  }, 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestampOf(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isFailedValidationIteration(iteration: TaskDiffIterationSnapshot | undefined): boolean {
  return resolveValidationPassed(asRecord(iteration?.validationResult)) === false;
}

function buildApprovedReviewResume(
  planningIteration:
    | {
        resultSummary: string;
        validationResult?: unknown;
      }
    | undefined,
  implementationIteration: { resultSummary: string } | undefined,
  reviewIteration:
    | {
        resultSummary: string;
        validationResult?: unknown;
      }
    | undefined,
  approvedTypes: ReadonlySet<ApprovalType>
): WorkerTaskResume | undefined {
  if (!implementationIteration || !reviewIteration) {
    return undefined;
  }

  const validationResult =
    reviewIteration.validationResult && typeof reviewIteration.validationResult === 'object' && !Array.isArray(reviewIteration.validationResult)
      ? (reviewIteration.validationResult as Record<string, JsonValue>)
      : undefined;
  const blockers = Array.isArray(validationResult?.blockers)
    ? validationResult.blockers.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const riskyChanges = Array.isArray(validationResult?.riskyChanges)
    ? normalizeRuntimeApprovals(validationResult.riskyChanges)
    : [];

  if (blockers.length > 0 || riskyChanges.length === 0 || !riskyChanges.every((item) => approvedTypes.has(item))) {
    return undefined;
  }

  return {
    kind: 'approved_review',
    planSummary: planningIteration?.resultSummary,
    planSteps: extractStringArray(planningIteration?.validationResult, 'steps'),
    acceptanceCriteria: extractStringArray(planningIteration?.validationResult, 'acceptanceCriteria'),
    implementationSummary: implementationIteration.resultSummary || 'Resuming previously reviewed implementation.',
    reviewSummary: reviewIteration.resultSummary || 'Previously reviewed implementation resumed.',
    riskyChanges,
    validationChecks: extractValidationChecks(planningIteration?.validationResult)
  };
}

function extractValidationChecks(validationResult: unknown): WorkerTaskResume['validationChecks'] {
  if (!validationResult || typeof validationResult !== 'object' || Array.isArray(validationResult)) {
    return undefined;
  }

  const payload = validationResult as Record<string, unknown>;
  if (!Array.isArray(payload.validationChecks)) {
    return undefined;
  }

  const checks = payload.validationChecks
    .map((item) => normalizeValidationCheckSnapshot(item))
    .filter((item): item is NonNullable<ReturnType<typeof normalizeValidationCheckSnapshot>> => Boolean(item));

  return checks.length > 0 ? checks : undefined;
}

function getLatestApprovedLargeDiffAt(
  approvals: Array<{ type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; payload: unknown; createdAt: string }>
): number | undefined {
  const timestamps = approvals
    .filter((approval) => approval.status === 'approved' && approval.type === 'risky_refactor')
    .filter((approval) => {
      const payload = approval.payload && typeof approval.payload === 'object' && !Array.isArray(approval.payload)
        ? (approval.payload as Record<string, JsonValue>)
        : undefined;
      const limitSignal = typeof payload?.limitSignal === 'string' ? payload.limitSignal : undefined;
      return limitSignal === 'diff_lines_limit_reached' || limitSignal === 'changed_files_limit_reached';
    })
    .map((approval) => Date.parse(approval.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (timestamps.length === 0) {
    return undefined;
  }

  return Math.max(...timestamps);
}

function getLatestApprovedReviewAt(
  approvals: Array<{ type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; createdAt: string }>,
  riskyChanges: ApprovalType[]
): number | undefined {
  const relevant = new Set(riskyChanges);
  const timestamps = approvals
    .filter((approval) => approval.status === 'approved' && relevant.has(approval.type))
    .map((approval) => Date.parse(approval.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (timestamps.length === 0) {
    return undefined;
  }

  return Math.max(...timestamps);
}

function normalizeValidationCheckSnapshot(item: unknown): ValidationCheck | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }

  const check = item as PlannedValidationCheckSnapshot;
  if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
    return {
      kind: 'command' as const,
      command: check.command.trim(),
      category: check.category === 'setup' || check.category === 'build' || check.category === 'database' || check.category === 'api' || check.category === 'browser' || check.category === 'smoke'
        ? check.category
        : undefined,
      criterion: typeof check.criterion === 'string' && check.criterion.trim() ? check.criterion.trim() : undefined,
      rationale: typeof check.rationale === 'string' && check.rationale.trim() ? check.rationale.trim() : undefined
    };
  }

  return undefined;
}

function findLastIteration<T extends { phase: string }>(iterations: T[], phase: string): T | undefined {
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    if (iterations[index]?.phase === phase) {
      return iterations[index];
    }
  }

  return undefined;
}

export async function recordTaskAcceptanceEvidence(
  repository: ForgeMindRepository,
  input: { project: Project; taskId: string; taskRunId: string; result: WorkerTaskResult }
): Promise<void> {
  const contract = input.project.projectContract;
  if (!contract) return;

  try {
    const step = await repository.getImplementationStepByTaskId(input.taskId);
    if (!step || step.requirementIds.length === 0) return;

    for (const check of input.result.validation.checkResults ?? []) {
      if (!check.criterion?.trim()) continue;
      await repository.recordAcceptanceEvidence({
        projectId: input.project.id,
        cycleId: step.cycleId,
        stepId: step.id,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        requirementIds: step.requirementIds,
        criterion: check.criterion,
        source: 'validation_command',
        status: check.passed ? 'passed' : 'failed',
        evidenceIdentity: check.command,
        contractVersion: contract.version,
        commitSha: input.result.commitSha,
        command: check.command,
        exitCode: check.exitCode,
        payload: {
          rationale: check.rationale ?? null,
          stdout: limitEvidenceText(check.stdout),
          stderr: limitEvidenceText(check.stderr)
        }
      });
    }

    if (input.result.githubChecks?.status === 'success' && input.result.commitSha) {
      await repository.recordAcceptanceEvidence({
        projectId: input.project.id,
        cycleId: step.cycleId,
        stepId: step.id,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        requirementIds: step.requirementIds,
        criterion: `GitHub checks pass for work item: ${step.title}`,
        source: 'github_check',
        status: 'passed',
        evidenceIdentity: `github-checks:${input.result.commitSha}`,
        contractVersion: contract.version,
        commitSha: input.result.commitSha,
        payload: { summary: limitEvidenceText(input.result.githubChecks.summary) }
      });
    }
  } catch (error) {
    await repository.writeAudit({
      actorType: 'system',
      eventType: 'acceptance_evidence_record_failed',
      projectId: input.project.id,
      taskId: input.taskId,
      payload: { errorMessage: toErrorMessage(error), taskRunId: input.taskRunId }
    });
  }
}

function limitEvidenceText(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[evidence output truncated]`;
}

function buildIterationErrorFingerprint(phase: string, validationResult: unknown): string | undefined {
  if (!validationResult || typeof validationResult !== 'object' || Array.isArray(validationResult)) {
    return undefined;
  }

  const payload = validationResult as Record<string, unknown>;
  const normalizedPhase = String(phase);

  if (normalizedPhase === 'validation') {
    const passed = payload.passed === true;
    if (passed) return undefined;

    const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : 'unknown';
    const stderr = typeof payload.stderr === 'string' && payload.stderr.trim().length > 0 ? payload.stderr.trim() : '';
    const stdout = typeof payload.stdout === 'string' && payload.stdout.trim().length > 0 ? payload.stdout.trim() : '';
    const signature = stderr || stdout || String(exitCode);
    return `validation:${signature}`;
  }

  if (normalizedPhase === 'review') {
    const blockers = Array.isArray(payload.blockers) ? payload.blockers.filter((item) => typeof item === 'string' && item.length > 0) : [];
    if (blockers.length === 0) return undefined;
    return `review:${blockers.join('|')}`;
  }

  return undefined;
}

function stopSignalToTaskStatus(signal: string): TaskStatus {
  if (signal === 'iteration_limit_reached') return 'iteration_limit_reached';
  if (signal === 'repeated_error_detected') return 'repeated_error_detected';
  return 'failed';
}

class WorkerLimitError extends Error {
  constructor(
    readonly status: TaskStatus,
    message: string
  ) {
    super(message);
    this.name = 'WorkerLimitError';
  }
}

class WorkerApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerApprovalRequiredError';
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
