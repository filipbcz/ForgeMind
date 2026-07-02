import { parseAgentConfigYaml, toCoreLimits } from '@forgemind/config';
import { DEFAULT_LIMITS, evaluateLimits, type Limits, type LimitUsage } from '@forgemind/core';
import { createRepository, getPrismaClient } from '@forgemind/db';
import { createGitHubAdapterFromEnv } from '@forgemind/github';
import { createProvider } from '@forgemind/providers';
import type { ProviderKind, TaskStatus } from '@forgemind/core';
import { toErrorMessage } from '@forgemind/shared';
import { runWorkerTask } from './workflow.js';

export async function runDatabaseWorkerOnce() {
  const repository = createRepository(getPrismaClient());
  const providerKind = (process.env.FORGEMIND_PROVIDER ?? 'mock') as ProviderKind;
  const claimed = await repository.claimNextSubmittedTask(providerKind, providerKind);

  if (!claimed) {
    return {
      claimed: false,
      message: 'No submitted task found.'
    };
  }

  let iterationNumber = 0;
  let changedFiles = 0;
  let diffLines = 0;
  const verifyCommand = resolveVerifyCommand(claimed.project.configYaml);
  const github = await createGitHubAdapterFromEnv();
  const provider = createProvider(providerKind);
  const limits = resolveLimits(claimed.project.configYaml, claimed.task.maxIterations, claimed.task.maxBudgetUsd);
  const costEstimate = await provider.estimateCost({ prompt: claimed.task.prompt, repositorySizeHint: 'small' });
  const initialLimitEvaluation = evaluateLimits(createLimitUsage({ estimatedCostUsd: costEstimate.estimatedCostUsd }), limits);

  await repository.recordProviderUsage({
    taskId: claimed.task.id,
    taskRunId: claimed.taskRun.id,
    provider: providerKind,
    model: providerKind,
    inputTokens: costEstimate.inputTokens,
    outputTokens: costEstimate.outputTokens,
    estimatedCostUsd: costEstimate.estimatedCostUsd
  });

  if (initialLimitEvaluation.signals.includes('budget_exceeded')) {
    await repository.failTask(claimed.task.id, 'Budget limit exceeded before provider run.', 'budget_exceeded');
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: 'Budget limit exceeded before provider run.',
      inputTokens: costEstimate.inputTokens,
      outputTokens: costEstimate.outputTokens,
      estimatedCostUsd: costEstimate.estimatedCostUsd
    });
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
      providerKind,
      provider,
      verifyCommand,
      github,
      hooks: {
        onStatus: async (status, payload = {}) => {
          await repository.transitionTask(claimed.task.id, status, payload);
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
        onIteration: async (iteration) => {
          iterationNumber += 1;
          const diffStat = iteration.diffStat && typeof iteration.diffStat === 'object' && !Array.isArray(iteration.diffStat) ? iteration.diffStat : {};
          changedFiles = Math.max(changedFiles, typeof diffStat.filesChanged === 'number' ? diffStat.filesChanged : 0);
          diffLines += (typeof diffStat.insertions === 'number' ? diffStat.insertions : 0) + (typeof diffStat.deletions === 'number' ? diffStat.deletions : 0);

          await repository.createIteration({
            taskRunId: claimed.taskRun.id,
            iterationNumber,
            ...iteration
          });

          const limitEvaluation = evaluateLimits(
            createLimitUsage({
              iterations: iterationNumber,
              changedFiles,
              diffLines,
              estimatedCostUsd: costEstimate.estimatedCostUsd
            }),
            limits
          );
          const stopSignal = limitEvaluation.signals.find((signal) => signal !== 'budget_soft_limit_reached');
          if (stopSignal) {
            throw new WorkerLimitError(stopSignalToTaskStatus(stopSignal), `Worker stopped because limit signal "${stopSignal}" was reached.`);
          }
        }
      }
    });

    if (result.status === 'needs_approval') {
      await repository.transitionTask(claimed.task.id, 'needs_approval', { approvals: result.approvals });
      for (const approvalType of result.approvals) {
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
        iterationCount: iterationNumber,
        inputTokens: costEstimate.inputTokens,
        outputTokens: costEstimate.outputTokens,
        estimatedCostUsd: costEstimate.estimatedCostUsd
      });
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
        iterationCount: iterationNumber,
        inputTokens: costEstimate.inputTokens,
        outputTokens: costEstimate.outputTokens,
        estimatedCostUsd: costEstimate.estimatedCostUsd
      });
    } else {
      await repository.transitionTask(claimed.task.id, 'ready_for_user_review', {
        pullRequestUrl: result.pullRequestUrl ?? null,
        branchName: result.branchName
      });
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: result.summary,
        iterationCount: iterationNumber,
        inputTokens: costEstimate.inputTokens,
        outputTokens: costEstimate.outputTokens,
        estimatedCostUsd: costEstimate.estimatedCostUsd
      });
    }

    return {
      claimed: true,
      taskId: claimed.task.id,
      result
    };
  } catch (error) {
    const message = toErrorMessage(error);
    const status = error instanceof WorkerLimitError ? error.status : 'failed';
    await repository.failTask(claimed.task.id, message, status);
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      iterationCount: iterationNumber,
      inputTokens: costEstimate.inputTokens,
      outputTokens: costEstimate.outputTokens,
      estimatedCostUsd: costEstimate.estimatedCostUsd
    });
    if (error instanceof WorkerLimitError) {
      return {
        claimed: true,
        taskId: claimed.task.id,
        status
      };
    }
    throw error;
  }
}

function resolveVerifyCommand(configYaml?: string): string {
  if (process.env.FORGEMIND_VERIFY_COMMAND) {
    return process.env.FORGEMIND_VERIFY_COMMAND;
  }

  if (!configYaml) {
    return 'node --version';
  }

  try {
    const config = parseAgentConfigYaml(configYaml);
    return config.commands.verify ?? config.commands.build ?? 'node --version';
  } catch {
    return 'node --version';
  }
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
