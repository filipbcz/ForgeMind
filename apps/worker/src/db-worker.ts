import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentConfigYaml, toCoreLimits, type AgentConfig } from '@forgemind/config';
import { DEFAULT_LIMITS, evaluateLimits, requiresApproval, type Limits, type LimitUsage } from '@forgemind/core';
import { advanceRoadmapAfterTaskCompletion, createRepository, getPrismaClient, type AIProviderConnectionSecret } from '@forgemind/db';
import { GitHubAppAdapter, createGitHubAdapterFromEnv } from '@forgemind/github';
import { createProvider, type AIProvider } from '@forgemind/providers';
import type { ApprovalType, ProviderKind, TaskStatus } from '@forgemind/core';
import { toErrorMessage, type JsonValue } from '@forgemind/shared';
import { runWorkerTask, type WorkerTaskResume } from './workflow.js';

type ApprovedLimitSignal = 'diff_lines_limit_reached' | 'changed_files_limit_reached';

interface TaskResumeContext {
  workflowResume: WorkerTaskResume;
  ignoredLimitSignals: ApprovedLimitSignal[];
}

interface TaskDiffIterationSnapshot {
  phase: string;
  prompt: string;
  resultSummary: string;
  validationResult: unknown;
}

interface PlannedValidationCheckSnapshot {
  kind?: string;
  command?: string;
  instructions?: string;
  criterion?: string;
  rationale?: string;
}

export async function runDatabaseWorkerOnce() {
  const repository = createRepository(getPrismaClient());
  const aiProviderConnection = await readAIProviderConnectionSecret(repository);
  applyAIProviderConnectionEnv(aiProviderConnection);
  const providerOverride = process.env.FORGEMIND_PROVIDER as ProviderKind | undefined;
  const fallbackProviderOverride = process.env.FORGEMIND_FALLBACK_PROVIDER as ProviderKind | undefined;
  const providerKind = providerOverride ?? aiProviderConnection?.provider ?? 'codex';
  const providerModel = resolveProviderModel(providerKind, aiProviderConnection);
  const claimTimeoutMinutes = Number(process.env.FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES ?? 15);
  const recovery = await repository.recoverStuckQueueJobs(claimTimeoutMinutes);
  const claimed = await repository.claimNextSubmittedTask(providerKind, providerModel);

  if (!claimed) {
    return {
      claimed: false,
      message: 'No submitted task found.',
      recoveredQueueJobs: recovery.recoveredCount
    };
  }

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
  const githubConnection = await repository.getGitHubConnectionSecret();
  const github = githubConnection
    ? new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl })
    : await createGitHubAdapterFromEnv();
  const projectConfig = parseProjectConfig(claimed.project.configYaml);
  const selection = resolveProviderSelection(projectConfig, providerOverride ?? aiProviderConnection?.provider, fallbackProviderOverride);
  const { provider, getLastProviderKind } = createPolicyAwareProvider({
    primaryKind: selection.primary,
    primaryProvider: createProvider(selection.primary),
    fallbackKind: selection.fallback,
    fallbackProvider: selection.fallback ? createProvider(selection.fallback) : undefined
  });
  const limits = resolveLimits(claimed.project.configYaml, claimed.task.maxIterations, claimed.task.maxBudgetUsd);
  const resumeContext = await resolveTaskResumeContext(repository, claimed.task.id);
  let costEstimate;
  try {
    costEstimate = await provider.estimateCost({ prompt: claimed.task.prompt, repositorySizeHint: 'small' });
  } catch (error) {
    const message = toErrorMessage(error);
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
    await repository.finalizeQueueJob(claimed.queueJobId, 'failed', message);
    return {
      claimed: true,
      taskId: claimed.task.id,
      status: 'provider_failed'
    };
  }
  const initialLimitEvaluation = evaluateLimits(createLimitUsage({ estimatedCostUsd: costEstimate.estimatedCostUsd }), limits);
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

  if (initialLimitEvaluation.signals.includes('budget_exceeded')) {
    await repository.failTask(claimed.task.id, 'Budget limit exceeded before provider run.', 'budget_exceeded');
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: 'Budget limit exceeded before provider run.',
      ...getRunUsageFields()
    });
    await repository.finalizeQueueJob(claimed.queueJobId, 'failed', 'Budget limit exceeded before provider run.');
    return {
      claimed: true,
      taskId: claimed.task.id,
      status: 'budget_exceeded'
    };
  }

  try {
    const result = await runWorkerTask({
      project: claimed.project,
      task: claimed.task,
      providerKind: selection.primary,
      provider,
      verifyCommand,
      workspaceRoot,
      usageSummary: `Pre-run estimate: ${costEstimate.inputTokens} input tokens, ${costEstimate.outputTokens} output tokens, ${costEstimate.estimatedCostUsd.toFixed(4)} USD`,
      resume: resumeContext?.workflowResume,
      github,
      hooks: {
        onStatus: async (status, payload = {}) => {
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
          await repository.writeAudit({
            actorType: 'system',
            eventType: 'task_github_operation_failed',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              queueJobId: claimed.queueJobId ?? null,
              operation: failure.operation,
              errorMessage: failure.errorMessage,
              provider: getLastProviderKind(),
              model: getLastProviderKind(),
              context: failure.context ?? null
            }
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
              provider: activity.usage?.provider ?? getLastProviderKind(),
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
            repeatedErrorCount,
            estimatedCostUsd: costEstimate.estimatedCostUsd
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
      await repository.finalizeQueueJob(claimed.queueJobId, 'succeeded');
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
      await repository.finalizeQueueJob(claimed.queueJobId, 'failed', result.validation.stderr || 'Validation failed.');
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
      await repository.finalizeQueueJob(claimed.queueJobId, 'failed', result.summary);
    } else {
      await repository.transitionTask(claimed.task.id, 'ready_for_user_review', {
        pullRequestUrl: result.pullRequestUrl ?? null,
        branchName: result.branchName
      });
      if (result.status === 'completed') {
        await repository.transitionTask(claimed.task.id, 'completed');
        await advanceRoadmapAfterTaskCompletion(repository, claimed.task.id);
      }
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: result.summary,
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await repository.finalizeQueueJob(claimed.queueJobId, 'succeeded');
    }

    return {
      claimed: true,
      taskId: claimed.task.id,
      result
    };
  } catch (error) {
    if (error instanceof WorkerApprovalRequiredError) {
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: error.message,
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await repository.finalizeQueueJob(claimed.queueJobId, 'succeeded');
      return {
        claimed: true,
        taskId: claimed.task.id,
        status: 'needs_approval'
      };
    }

    const message = toErrorMessage(error);
    const status = error instanceof WorkerLimitError ? error.status : error instanceof ProviderExecutionError ? 'provider_failed' : 'failed';
    await repository.failTask(claimed.task.id, message, status);
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      iterationCount: attemptCount,
      ...getRunUsageFields()
    });
    await repository.finalizeQueueJob(claimed.queueJobId, 'failed', message);
    if (error instanceof WorkerLimitError || error instanceof ProviderExecutionError) {
      return {
        claimed: true,
        taskId: claimed.task.id,
        status
      };
    }
    throw error;
  }
}

function createPolicyAwareProvider(input: {
  primaryKind: ProviderKind;
  primaryProvider: AIProvider;
  fallbackKind?: ProviderKind;
  fallbackProvider?: AIProvider;
}): { provider: AIProvider; getLastProviderKind: () => ProviderKind } {
  let lastProviderKind: ProviderKind = input.primaryKind;

  const callWithFallback = async <T>(operation: string, action: (provider: AIProvider) => Promise<T>): Promise<T> => {
    try {
      const result = await action(input.primaryProvider);
      lastProviderKind = input.primaryKind;
      return result;
    } catch (primaryError) {
      if (input.fallbackProvider && input.fallbackKind && input.fallbackKind !== input.primaryKind) {
        try {
          const result = await action(input.fallbackProvider);
          lastProviderKind = input.fallbackKind;
          return result;
        } catch (fallbackError) {
          throw new ProviderExecutionError(operation, toErrorMessage(fallbackError), input.fallbackKind);
        }
      }

      throw new ProviderExecutionError(operation, toErrorMessage(primaryError), input.primaryKind);
    }
  };

  const provider: AIProvider = {
    kind: input.primaryKind,
    supportsLocalRepo: () => input.primaryProvider.supportsLocalRepo(),
    supportsGitHubNativeFlow: () => input.primaryProvider.supportsGitHubNativeFlow(),
    async plan(planInput) {
      return callWithFallback('plan', (provider) => provider.plan(planInput));
    },
    async implement(implementInput) {
      return callWithFallback('implement', (provider) => provider.implement(implementInput));
    },
    async review(reviewInput) {
      return callWithFallback('review', (provider) => provider.review(reviewInput));
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

function applyAIProviderConnectionEnv(connection: AIProviderConnectionSecret | undefined) {
  if (!connection) {
    return;
  }

  if (connection.provider === 'openai') {
    if (connection.apiKey) {
      process.env.OPENAI_API_KEY = connection.apiKey;
    }
    process.env.OPENAI_MODEL = connection.model;
  }

  if (connection.provider === 'codex') {
    if (connection.authMode === 'codex_oauth') {
      process.env.CODEX_AUTH_MODE = 'oauth';
      if (connection.codexHome) {
        process.env.CODEX_HOME = connection.codexHome;
      }
    } else if (connection.apiKey) {
      process.env.CODEX_API_KEY = connection.apiKey;
      delete process.env.CODEX_AUTH_MODE;
    }
    process.env.CODEX_MODEL = connection.model;
  }
}

function resolveProviderModel(provider: ProviderKind, connection: AIProviderConnectionSecret | undefined): string {
  if (connection?.provider === provider) {
    return connection.model;
  }

  if (provider === 'openai' && process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL;
  }

  if (provider === 'codex' && process.env.CODEX_MODEL) {
    return process.env.CODEX_MODEL;
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

function resolveProviderSelection(
  projectConfig: AgentConfig | undefined,
  providerOverride: ProviderKind | undefined,
  fallbackOverride: ProviderKind | undefined
): { primary: ProviderKind; fallback?: ProviderKind } {
  const primary = providerOverride ?? projectConfig?.ai.primary_provider ?? 'codex';
  const fallback = fallbackOverride ?? projectConfig?.ai.fallback_provider;

  if (!fallback || fallback === primary) {
    return { primary };
  }

  return {
    primary,
    fallback
  };
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

function resolveWorkerWorkspaceRoot(): string {
  if (process.env.FORGEMIND_WORKSPACE_ROOT?.trim()) {
    return process.env.FORGEMIND_WORKSPACE_ROOT;
  }

  return join(tmpdir(), 'forgemind-workspaces');
}

function resolveLimits(configYaml: string | undefined, maxIterations: number, maxBudgetUsd: number): Limits {
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
    maxIterations,
    maxBudgetUsd
  };
}

function createLimitUsage(overrides: Partial<LimitUsage>): LimitUsage {
  return {
    iterations: 0,
    runtimeMinutes: 0,
    changedFiles: 0,
    diffLines: 0,
    repeatedErrorCount: 0,
    estimatedCostUsd: 0,
    ...overrides
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
      signal !== 'budget_soft_limit_reached'
      && !(allowRuntimeGrace && signal === 'runtime_limit_reached')
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
    repeatedErrorCount: usage.repeatedErrorCount,
    estimatedCostUsd: usage.estimatedCostUsd
  };
}

function toLimitsPayload(limits: Limits): Record<string, JsonValue> {
  return {
    maxIterations: limits.maxIterations,
    maxRuntimeMinutes: limits.maxRuntimeMinutes,
    maxChangedFiles: limits.maxChangedFiles,
    maxDiffLines: limits.maxDiffLines,
    maxRepeatedErrorCount: limits.maxRepeatedErrorCount,
    maxBudgetUsd: limits.maxBudgetUsd,
    softBudgetThresholdPercent: limits.softBudgetThresholdPercent,
    hardBudgetThresholdPercent: limits.hardBudgetThresholdPercent
  };
}

async function resolveTaskResumeContext(
  repository: {
    listApprovals: () => Promise<Array<{ taskId: string; type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; payload: unknown; createdAt: string }>>;
    getTaskDiff: (taskId: string) => Promise<{
      iterations: TaskDiffIterationSnapshot[];
    }>;
  },
  taskId: string
): Promise<TaskResumeContext | undefined> {
  const [approvals, diff] = await Promise.all([repository.listApprovals(), repository.getTaskDiff(taskId)]);
  const taskApprovals = approvals.filter((approval) => approval.taskId === taskId);
  const approvedTypes = new Set(taskApprovals.filter((approval) => approval.status === 'approved').map((approval) => approval.type));
  const lastPlanningIteration = findLastIteration(diff.iterations, 'planning');
  const lastImplementationIteration = findLastIteration(diff.iterations, 'implementation');
  const lastReviewIteration = findLastIteration(diff.iterations, 'review');
  const approvedReviewResume = buildApprovedReviewResume(lastPlanningIteration, lastImplementationIteration, lastReviewIteration, approvedTypes);
  const latestApprovedLargeDiffAt = getLatestApprovedLargeDiffAt(taskApprovals);
  const latestApprovedReviewAt = approvedReviewResume
    ? getLatestApprovedReviewAt(taskApprovals, approvedReviewResume.riskyChanges ?? [])
    : undefined;

  if (latestApprovedLargeDiffAt && (!latestApprovedReviewAt || latestApprovedLargeDiffAt >= latestApprovedReviewAt)) {
    if (!lastImplementationIteration) {
      return undefined;
    }

    return {
      workflowResume: {
        kind: 'approved_large_diff',
        planSummary: lastPlanningIteration?.resultSummary,
        implementationSummary: lastImplementationIteration.resultSummary || 'Resuming previously approved implementation.',
        validationChecks: extractValidationChecks(lastPlanningIteration?.validationResult),
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

  return undefined;
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

function normalizeValidationCheckSnapshot(item: unknown) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }

  const check = item as PlannedValidationCheckSnapshot;
  if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
    return {
      kind: 'command' as const,
      command: check.command.trim(),
      criterion: typeof check.criterion === 'string' && check.criterion.trim() ? check.criterion.trim() : undefined,
      rationale: typeof check.rationale === 'string' && check.rationale.trim() ? check.rationale.trim() : undefined
    };
  }

  if (check.kind === 'manual' && typeof check.instructions === 'string' && check.instructions.trim()) {
    return {
      kind: 'manual' as const,
      instructions: check.instructions.trim(),
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
  if (signal === 'budget_exceeded') return 'budget_exceeded';
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
