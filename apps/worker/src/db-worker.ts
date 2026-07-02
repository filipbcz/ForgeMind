import { parseAgentConfigYaml } from '@forgemind/config';
import { createRepository, getPrismaClient } from '@forgemind/db';
import { createGitHubAdapterFromEnv } from '@forgemind/github';
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
  const verifyCommand = resolveVerifyCommand(claimed.project.configYaml);
  const github = await createGitHubAdapterFromEnv();

  try {
    const result = await runWorkerTask({
      project: claimed.project,
      task: claimed.task,
      providerKind,
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
          await repository.createIteration({
            taskRunId: claimed.taskRun.id,
            iterationNumber,
            ...iteration
          });
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
        iterationCount: iterationNumber
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
        iterationCount: iterationNumber
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
        iterationCount: iterationNumber
      });
    }

    await repository.recordProviderUsage({
      taskId: claimed.task.id,
      taskRunId: claimed.taskRun.id,
      provider: providerKind,
      model: providerKind,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0
    });

    return {
      claimed: true,
      taskId: claimed.task.id,
      result
    };
  } catch (error) {
    const message = toErrorMessage(error);
    await repository.failTask(claimed.task.id, message);
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      iterationCount: iterationNumber
    });
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
