import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const createProviderMock = vi.fn();
const runWorkerTaskMock = vi.fn();
const advanceRoadmapAfterTaskCompletionMock = vi.fn(async () => ({ advanced: false }));
const advanceRoadmapAfterTaskCapabilityWaitMock = vi.fn(async () => ({ advanced: false }));
const startNextRoadmapStepMock = vi.fn(async (): Promise<{ id: string } | undefined> => undefined);
const runCapabilityAuditMock = vi.fn();
const runReleaseAuditMock = vi.fn();
const prepareCapabilityAuditWorkspaceMock = vi.fn(async () => ({
  workspacePath: 'C:/tmp/audit',
  commitSha: 'abcdef1',
  repositoryContext: 'src/index.ts',
  cleanup: vi.fn(async () => undefined)
}));
const buildTargetedRepositoryContextMock = vi.fn(async () => 'src/index.ts');

function createClaimedTask(queueReason = 'task_started') {
  return {
    task: {
      id: 'task_1',
      projectId: 'project_1',
      createdByUserId: 'user_1',
      title: 'Task',
      prompt: 'Prompt long enough',
      mode: 'safe',
      status: 'submitted',
      maxIterations: 3,
      maxBudgetUsd: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    project: {
      id: 'project_1',
      name: 'Demo',
      slug: 'demo',
      githubOwner: 'demo',
      githubRepo: 'repo',
      defaultBranch: 'main',
      configYaml: undefined as string | undefined,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    taskRun: {
      id: 'run_1'
    },
    queueJobId: 'queue_1',
    queueReason
  };
}

const repositoryMock = {
  recoverStuckQueueJobs: vi.fn(async () => ({ recoveredCount: 0, queueJobIds: [] })),
  requeueTasksWaitingForCapabilities: vi.fn(async () => 0),
  listTasksWaitingForCapabilities: vi.fn(async () => []),
  recoverStuckProjectAudits: vi.fn(async () => 0),
  getGitHubConnectionSecret: vi.fn(async () => undefined),
  getAIProviderConnectionSecret: vi.fn(async () => undefined),
  getAIProviderConnectionSecretById: vi.fn(async (_connectionId: string): Promise<unknown> => undefined),
  claimNextSubmittedTask: vi.fn(async (): Promise<unknown> => createClaimedTask()),
  claimNextProjectAudit: vi.fn(async (): Promise<unknown> => undefined),
  listTasks: vi.fn(async (): Promise<unknown[]> => []),
  getTask: vi.fn(async (): Promise<unknown> => undefined),
  getProjectRoadmap: vi.fn(async (): Promise<unknown> => undefined),
  finalizeProjectAudit: vi.fn(async () => ({ retryScheduled: false })),
  appendProjectImplementationSteps: vi.fn(async (): Promise<Array<{ id: string }>> => []),
  updateProjectRoadmapCycleStatus: vi.fn(async () => undefined),
  setProjectRoadmapCycleExtensionProposal: vi.fn(async () => undefined),
  updateTaskRunProvider: vi.fn(async () => undefined),
  updateTaskProviderSession: vi.fn(async () => undefined),
  updateProjectPlanningSession: vi.fn(async () => undefined),
  recordCompletedTaskProjectMemory: vi.fn(async () => undefined),
  recordProviderUsage: vi.fn(async () => undefined),
  transitionTask: vi.fn(async () => undefined),
  waitTaskForCapabilities: vi.fn(async () => undefined),
  setTaskDeferredValidationCapabilities: vi.fn(async () => undefined),
  completeTaskWithDeferredValidation: vi.fn(async (): Promise<unknown> => ({ id: 'task_windows', status: 'completed' })),
  createApproval: vi.fn(async () => ({ id: 'approval_1' })),
  createIteration: vi.fn(async () => undefined),
  listTaskCheckpoints: vi.fn(async (): Promise<unknown[]> => []),
  recordTaskCheckpoint: vi.fn(async () => undefined),
  listApprovals: vi.fn(
    async (): Promise<Array<Record<string, unknown> & { taskId: string; type: string; status: string; payload: Record<string, unknown> }>> => []
  ),
  listTaskAudit: vi.fn(async (): Promise<Array<{ eventType: string; payload: Record<string, unknown>; createdAt: string }>> => []),
  getTaskDiff: vi.fn(
    async (): Promise<{
      taskId: string;
      filesChanged: number;
      insertions: number;
      deletions: number;
      iterations: Array<Record<string, unknown> & { phase: string; resultSummary: string }>;
    }> => ({
      taskId: 'task_1',
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      iterations: []
    })
  ),
  getTaskUsage: vi.fn(async () => ({
    taskId: 'task_1',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    usageSource: 'unavailable',
    actualCostUsd: null,
    runs: [],
    records: []
  })),
  failTask: vi.fn(async () => undefined),
  finishTaskRun: vi.fn(async () => undefined),
  finalizeQueueJob: vi.fn(async () => undefined),
  writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
};

vi.mock('@forgemind/db', () => ({
  advanceRoadmapAfterTaskCompletion: advanceRoadmapAfterTaskCompletionMock,
  advanceRoadmapAfterTaskCapabilityWait: advanceRoadmapAfterTaskCapabilityWaitMock,
  startNextRoadmapStep: startNextRoadmapStepMock,
  createRepository: vi.fn(() => repositoryMock),
  getPrismaClient: vi.fn(() => ({}))
}));

vi.mock('@forgemind/github', () => ({
  GitHubAppAdapter: vi.fn(function GitHubAppAdapter() {
    return {};
  }),
  createGitHubAdapterFromEnv: vi.fn(async () => ({}))
}));

vi.mock('@forgemind/providers', async () => ({
  ...await vi.importActual<typeof import('@forgemind/providers')>('@forgemind/providers'),
  createProvider: createProviderMock
}));

vi.mock('./workflow.js', () => ({
  runWorkerTask: runWorkerTaskMock,
  formatProjectArchitectureContext: vi.fn(() => '')
}));

vi.mock('./capability-audit.js', () => ({
  buildTargetedRepositoryContext: buildTargetedRepositoryContextMock,
  prepareCapabilityAuditWorkspace: prepareCapabilityAuditWorkspaceMock,
  runCapabilityAudit: runCapabilityAuditMock,
  runReleaseAudit: runReleaseAuditMock
}));

describe('db-worker policy enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMock.getGitHubConnectionSecret.mockReset();
    repositoryMock.getGitHubConnectionSecret.mockResolvedValue(undefined);
    repositoryMock.getTask.mockReset();
    repositoryMock.getTask.mockResolvedValue(undefined);
    repositoryMock.listTasks.mockReset();
    repositoryMock.listTasks.mockResolvedValue([]);
    repositoryMock.getTaskUsage.mockResolvedValue({
      taskId: 'task_1',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageSource: 'unavailable',
      actualCostUsd: null,
      runs: [],
      records: []
    });

    createProviderMock.mockReturnValue({
      estimateCost: vi.fn(async () => ({
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.01
      })),
      plan: vi.fn(),
      implement: vi.fn(),
      review: vi.fn(),
      kind: 'codex',
      supportsLocalRepo: () => true,
      supportsGitHubNativeFlow: () => false
    });

    runWorkerTaskMock.mockImplementation(async (input: { hooks?: { onGitHubOperationFailed?: (failure: { operation: string; errorMessage: string }) => Promise<void> } }) => {
      await input.hooks?.onGitHubOperationFailed?.({
        operation: 'create_pr',
        errorMessage: 'GitHub API POST /repos/demo/repo/pulls failed with 500: Internal Server Error'
      });
      throw new Error('GitHub API POST /repos/demo/repo/pulls failed with 500: Internal Server Error');
    });
  });

  it('normalizes a configured workspace root to a platform-native absolute path', async () => {
    const previousWorkspaceRoot = process.env.FORGEMIND_WORKSPACE_ROOT;
    process.env.FORGEMIND_WORKSPACE_ROOT = '/data/workspaces';

    try {
      const { resolveWorkerWorkspaceRoot } = await import('./db-worker.js');
      expect(resolveWorkerWorkspaceRoot()).toBe(resolve('/data/workspaces'));
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.FORGEMIND_WORKSPACE_ROOT;
      } else {
        process.env.FORGEMIND_WORKSPACE_ROOT = previousWorkspaceRoot;
      }
    }
  });

  it('fails a claimed task before execution when free disk space is below policy', async () => {
    const claimed = createClaimedTask();
    claimed.project.configYaml = `project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
workflow:
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
ai: {}
limits: {}
commands: {}
approval: {}
sandbox:
  allow_network: true
resources:
  min_free_space_mb: ${Number.MAX_SAFE_INTEGER}
github: {}`;
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(claimed);

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({
      claimed: true,
      taskId: 'task_1',
      status: 'failed'
    }));
    expect(runWorkerTaskMock).not.toHaveBeenCalled();
    expect(repositoryMock.failTask).toHaveBeenCalledWith(
      'task_1',
      expect.stringContaining('free disk space is below policy'),
      'failed'
    );
    expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith(
      'queue_1',
      'failed',
      expect.stringContaining('free disk space is below policy'),
      false
    );
  }, 10000);

  it('uses configured retention days when cleaning expired workspace artifacts', async () => {
    const previousWorkspaceRoot = process.env.FORGEMIND_WORKSPACE_ROOT;
    const workspaceRoot = join(tmpdir(), `forgemind-db-worker-retention-${randomUUID()}`);
    const oldInactiveWorkspace = join(workspaceRoot, 'task_old');
    const oldActiveWorkspace = join(workspaceRoot, 'task_active');
    await mkdir(oldInactiveWorkspace, { recursive: true });
    await mkdir(oldActiveWorkspace, { recursive: true });
    await writeFile(join(oldInactiveWorkspace, 'artifact.txt'), 'old\n');
    await writeFile(join(oldActiveWorkspace, 'artifact.txt'), 'active\n');
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(oldInactiveWorkspace, oldDate, oldDate);
    await utimes(oldActiveWorkspace, oldDate, oldDate);
    process.env.FORGEMIND_WORKSPACE_ROOT = workspaceRoot;

    try {
      const claimed = createClaimedTask();
      claimed.project.configYaml = `project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
workflow:
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
ai: {}
limits: {}
commands: {}
approval: {}
sandbox:
  allow_network: true
resources:
  retention_days: 1
github: {}`;
      repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(claimed);
      repositoryMock.listTasks.mockResolvedValue([{ id: 'task_active', status: 'running' }]);
      runWorkerTaskMock.mockResolvedValueOnce({
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: '',
        branchName: 'main',
        workspacePath: join(workspaceRoot, 'task_1'),
        validation: { command: 'true', exitCode: 0, stdout: '', stderr: '', passed: true },
        summary: 'Local workflow completed.',
        approvals: [],
        completedAt: new Date().toISOString()
      });

      const { runDatabaseWorkerOnce } = await import('./db-worker.js');
      await runDatabaseWorkerOnce();

      await expect(access(oldInactiveWorkspace)).rejects.toThrow();
      await expect(access(oldActiveWorkspace)).resolves.toBeUndefined();
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.FORGEMIND_WORKSPACE_ROOT;
      } else {
        process.env.FORGEMIND_WORKSPACE_ROOT = previousWorkspaceRoot;
      }
    }
  });

  it('removes a workspace immediately after the task completes', async () => {
    const previousWorkspaceRoot = process.env.FORGEMIND_WORKSPACE_ROOT;
    const workspaceRoot = join(tmpdir(), `forgemind-db-worker-completed-${randomUUID()}`);
    const workspacePath = join(workspaceRoot, 'task_1');
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, 'artifact.txt'), 'completed\n');
    process.env.FORGEMIND_WORKSPACE_ROOT = workspaceRoot;

    try {
      runWorkerTaskMock.mockResolvedValueOnce({
        taskId: 'task_1',
        status: 'completed',
        issueUrl: '',
        branchName: 'main',
        workspacePath,
        validation: { command: 'true', exitCode: 0, stdout: '', stderr: '', passed: true },
        summary: 'Task completed.',
        approvals: [],
        completedAt: new Date().toISOString()
      });

      const { runDatabaseWorkerOnce } = await import('./db-worker.js');
      await runDatabaseWorkerOnce();

      await expect(access(workspacePath)).rejects.toThrow();
      expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith('queue_1', 'succeeded');
      expect(advanceRoadmapAfterTaskCompletionMock).toHaveBeenCalledWith(repositoryMock, 'task_1');
    } finally {
      if (previousWorkspaceRoot === undefined) {
        delete process.env.FORGEMIND_WORKSPACE_ROOT;
      } else {
        process.env.FORGEMIND_WORKSPACE_ROOT = previousWorkspaceRoot;
      }
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('completes an existing Windows capability wait and advances its roadmap', async () => {
    repositoryMock.listTasksWaitingForCapabilities.mockResolvedValueOnce([{
      id: 'task_windows',
      waitingForCapabilities: ['windows']
    }] as never);
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(undefined);

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(repositoryMock.completeTaskWithDeferredValidation).toHaveBeenCalledWith('task_windows');
    expect(advanceRoadmapAfterTaskCompletionMock).toHaveBeenCalledWith(repositoryMock, 'task_windows');
    expect(result).toEqual(expect.objectContaining({ claimed: false }));
  });

  it('persists a redacted GitHub failure and keeps the daemon available for retries', async () => {
    const credentialUrl = 'https://x-access-token:secret-token@github.com/demo/repo.git';
    runWorkerTaskMock.mockImplementationOnce(async (input: { hooks?: { onGitHubOperationFailed?: (failure: { operation: string; errorMessage: string }) => Promise<void> } }) => {
      await input.hooks?.onGitHubOperationFailed?.({
        operation: 'create_pr',
        errorMessage: `Git clone failed for ${credentialUrl}`
      });
      throw new Error(`Git clone failed for ${credentialUrl}`);
    });
    const { runDatabaseWorkerOnce } = await import('./db-worker.js');

    await expect(runDatabaseWorkerOnce()).resolves.toEqual(expect.objectContaining({
      claimed: true,
      taskId: 'task_1',
      status: 'failed'
    }));

    expect(repositoryMock.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        eventType: 'task_github_operation_failed',
        taskId: 'task_1',
        payload: expect.objectContaining({
          taskRunId: 'run_1',
          queueJobId: 'queue_1',
          operation: 'create_pr',
          errorMessage: 'Git clone failed for https://[credential-redacted]@github.com/demo/repo.git'
        })
      })
    );
    expect(repositoryMock.failTask).toHaveBeenCalledWith(
      'task_1',
      'Git clone failed for https://[credential-redacted]@github.com/demo/repo.git',
      'failed'
    );
  });

  it('characterizes failed workflow lifecycle persistence before queue finalization', async () => {
    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({
      claimed: true,
      taskId: 'task_1',
      status: 'failed'
    }));
    expect(repositoryMock.finishTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      taskRunId: 'run_1',
      status: 'failed',
      errorMessage: 'GitHub API POST /repos/demo/repo/pulls failed with 500: Internal Server Error'
    }));
    expect(repositoryMock.failTask).toHaveBeenCalledWith(
      'task_1',
      'GitHub API POST /repos/demo/repo/pulls failed with 500: Internal Server Error',
      'failed'
    );
    expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith(
      'queue_1',
      'failed',
      'GitHub API POST /repos/demo/repo/pulls failed with 500: Internal Server Error'
    );
  });

  it('aborts active workflow work when the task is cancelled in the database', async () => {
    repositoryMock.getTask
      .mockResolvedValueOnce({ ...createClaimedTask().task, status: 'running_ai' })
      .mockResolvedValue({ ...createClaimedTask().task, status: 'cancelled' });
    runWorkerTaskMock.mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1', status: 'cancelled' }));
    expect(repositoryMock.finishTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      taskRunId: 'run_1',
      status: 'cancelled'
    }));
    expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith('queue_1', 'cancelled', 'Task cancelled by user.');
    expect(repositoryMock.failTask).not.toHaveBeenCalled();
  });

  it('does not decrypt GitHub credentials for a workflow with all GitHub operations disabled', async () => {
    const claimed = createClaimedTask();
    claimed.project.configYaml = `project:
  id: local-test
  name: Local test
  repo: local/local-test
  default_branch: main
workflow:
  default_mode: full_auto
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
  auto_merge: false
  allow_ai_auto_improvements: false
ai:
  primary_provider: codex
  reviewer_provider: codex
  model_profile: fast
limits:
  max_iterations: 3
  max_runtime_minutes: 60
  max_changed_files: 20
  max_diff_lines: 2000
  max_repeated_error_count: 3
commands: {}
approval:
  required_for: []
  auto_allowed: []
sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths: ["/workspace"]
  forbidden_paths: ["/etc", "/root"]
github:
  issue_label: ai-task
  branch_prefix: ai/
  pr_draft: true
  require_ci_green: false`;
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(claimed);
    repositoryMock.getGitHubConnectionSecret.mockRejectedValueOnce(new Error('Stored credential cannot be decrypted.'));
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: '',
      branchName: 'main',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'node --version', exitCode: 0, stdout: 'v22', stderr: '', passed: true },
      summary: 'Local workflow completed.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.getGitHubConnectionSecret).not.toHaveBeenCalled();
    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({ github: undefined }));
  });

  it('uses the configured reviewer connection with an independent session', async () => {
    const claimed = createClaimedTask();
    claimed.project.configYaml = `project:
  id: reviewer-test
  name: Reviewer test
  repo: local/reviewer-test
  default_branch: main
workflow:
  default_mode: safe
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
  auto_merge: false
  allow_ai_auto_improvements: false
ai:
  primary_provider: codex
  reviewer_provider: openai
  reviewer_connection_id: reviewer_openai
  model_profile: balanced
limits:
  max_iterations: 3
  max_runtime_minutes: 60
  max_changed_files: 20
  max_diff_lines: 2000
  max_repeated_error_count: 3
commands: {}
approval:
  required_for: []
  auto_allowed: []
sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths: ["/workspace"]
  forbidden_paths: ["/etc", "/root"]
github:
  issue_label: ai-task
  branch_prefix: ai/
  pr_draft: true
  require_ci_green: false`;
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(claimed);
    repositoryMock.getAIProviderConnectionSecretById.mockResolvedValueOnce({
      id: 'reviewer_openai', userId: 'user_1', name: 'Independent reviewer', isDefault: false,
      credentialSource: 'api_key', provider: 'openai', authMode: 'api_key', model: 'gpt-5.5',
      apiKey: 'secret', connectedAt: '', updatedAt: ''
    });
    createProviderMock.mockImplementation((kind: string) => ({
      kind,
      estimateCost: vi.fn(async () => ({ inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 })),
      plan: vi.fn(), implement: vi.fn(), review: vi.fn(),
      supportsLocalRepo: () => true,
      supportsGitHubNativeFlow: () => false
    }));
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'ready_for_user_review', issueUrl: '', branchName: 'main',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'node --version', exitCode: 0, stdout: 'v22', stderr: '', passed: true },
      summary: 'Reviewed independently.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    const workerInput = runWorkerTaskMock.mock.calls[0]?.[0] as {
      provider: { kind: string };
      reviewProvider: { kind: string };
      providerSession: { id?: string; onUpdate?: unknown };
      reviewProviderSession: { id?: string; provider: string; model: string; onUpdate?: unknown };
    };
    expect(workerInput.provider.kind).toBe('codex');
    expect(workerInput.reviewProvider.kind).toBe('openai');
    expect(workerInput.reviewProvider).not.toBe(workerInput.provider);
    expect(workerInput.reviewProviderSession).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    expect(workerInput.reviewProviderSession).not.toBe(workerInput.providerSession);
  });

  it('resumes an interrupted worker run from the preserved workspace', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('worker_interrupted'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 3,
      insertions: 20,
      deletions: 2,
      iterations: [
        {
          phase: 'planning',
          resultSummary: 'Existing plan',
          validationResult: {
            validationChecks: [
              {
                kind: 'command',
                command: 'npm test'
              }
            ]
          }
        }
      ]
    });
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'npm test',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: 'Resumed successfully.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          kind: 'worker_interrupted',
          planSummary: 'Existing plan',
          implementationSummary: expect.stringContaining('preserved in the workspace'),
          validationChecks: [
            expect.objectContaining({
              kind: 'command',
              command: 'npm test'
            })
          ]
        })
      })
    );
  });

  it('retries a validation failure from the preserved implementation', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 2,
      insertions: 12,
      deletions: 0,
      iterations: [
        {
          phase: 'implementation',
          prompt: 'Implement task',
          resultSummary: 'Implementation is already present.',
          validationResult: {
            passed: true,
            architectureUpdate: {
              modules: [{ name: 'Domain', responsibility: 'Business logic', paths: ['src/domain/**'], publicInterfaces: [], dependencies: [] }],
              decisions: [], conventions: [], dependencyRules: [], knownDebt: [], resolvedDebt: [], validationCommands: []
            }
          }
        },
        {
          phase: 'planning',
          prompt: 'Correct validation',
          resultSummary: 'Use the focused build command.',
          validationResult: {
            passed: true,
            validationChecks: [{ kind: 'command', command: 'cmake --preset test' }]
          }
        },
        {
          phase: 'validation',
          prompt: 'cmake --preset test',
          resultSummary: 'Validation failed.',
          validationResult: { passed: false, stderr: 'cmake: not found' }
        }
      ]
    });
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'cmake --preset test', exitCode: 0, stdout: '', stderr: '', passed: true },
      summary: 'Validation resumed successfully.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        kind: 'validation_retry',
        planSummary: 'Use the focused build command.',
        implementationSummary: 'Implementation is already present.',
        validationChecks: [{ kind: 'command', command: 'cmake --preset test' }],
        architectureUpdate: expect.objectContaining({ modules: [expect.objectContaining({ name: 'Domain' })] })
      })
    }));
  });

  it('resumes a capability gate at validation while preserving completed delivery checkpoints', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('capability_available'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1', filesChanged: 1, insertions: 5, deletions: 0,
      iterations: [
        { phase: 'planning', prompt: 'Plan', resultSummary: 'Plan', validationResult: { validationChecks: [
          { kind: 'command', command: 'npm test', requiredCapabilities: [] },
          { kind: 'command', command: 'UnrealEditor.exe Flying.uproject', requiredCapabilities: ['windows'] }
        ] }, createdAt: '2026-08-02T10:00:10.000Z' },
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implemented', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.cpp'] }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'Validate', resultSummary: 'Portable checks passed; Win64 deferred', validationResult: {
          command: 'npm test && UnrealEditor.exe Flying.uproject', exitCode: 0, stdout: '', stderr: '', passed: true,
          passedValidationChecks: [{ command: 'npm test', inputHash: 'tree-hash', exitCode: 0, stdout: 'ok', stderr: '', passed: true }],
          deferredChecks: [{ command: 'UnrealEditor.exe Flying.uproject', requiredCapabilities: ['windows'], missingCapabilities: ['windows'] }]
        }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [] }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_activity', payload: { phase: 'git', state: 'completed', operation: 'commit_and_push' }, createdAt: '2026-08-02T10:00:45.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([
      { key: 'validation:deferred', phase: 'validation', status: 'completed', inputHash: 'tree-hash', output: { evidenceVersion: 1, deferred: true, command: 'UnrealEditor.exe Flying.uproject' } },
      { key: 'external:wait_for_checks', phase: 'github', status: 'completed', inputHash: 'checks-hash', output: { status: 'success', summary: 'passed', failures: [] } },
      { key: 'external:merge_pr', phase: 'github', status: 'completed', inputHash: 'merge-hash', output: { merged: true, sha: 'abcdef1234567' } }
    ]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'completed', issueUrl: '', branchName: 'ai/1-task', workspacePath: 'C:/tmp/worker',
      validation: { command: 'UnrealEditor.exe Flying.uproject', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
      summary: 'Capability gate passed.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        kind: 'capability_available',
        resumeFrom: 'validation',
        validation: undefined,
        validationChecks: expect.arrayContaining([
          expect.objectContaining({ command: 'UnrealEditor.exe Flying.uproject', requiredCapabilities: ['windows'] })
        ]),
        passedValidationChecks: [expect.objectContaining({ command: 'npm test' })],
        completedOperations: expect.arrayContaining(['commit_and_push', 'wait_for_checks', 'merge_pr']),
        mergeCommitSha: 'abcdef1234567'
      })
    }));
  });

  it.each([
    {
      label: 'planning provider failure',
      iterations: [],
      audit: [
        { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'planning', attempt: 0 }, createdAt: '2026-08-02T10:00:10.000Z' },
        { eventType: 'task_failed', payload: { status: 'provider_failed' }, createdAt: '2026-08-02T10:00:20.000Z' }
      ],
      expected: { resumeFrom: 'planning', attempt: 1 }
    },
    {
      label: 'implementation provider failure after review blockers',
      iterations: [
        { phase: 'planning', prompt: 'Plan', resultSummary: 'Plan ready', validationResult: {}, createdAt: '2026-08-02T10:00:10.000Z' },
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Initial implementation', diffStat: { filesChanged: 2, insertions: 20, deletions: 1 }, validationResult: { changedFiles: ['src/a.ts', 'src/b.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'One blocker', validationResult: { blockers: ['Fix adapter lookup.'], safeImprovements: ['Keep the focused test.'], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      audit: [
        { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'implementation', attempt: 2 }, createdAt: '2026-08-02T10:00:45.000Z' },
        { eventType: 'task_failed', payload: { status: 'provider_failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
      ],
      expected: { resumeFrom: 'implementation', attempt: 2, previousReviewBlockers: ['Fix adapter lookup.'] }
    },
    {
      label: 'failed validation requiring AI recovery decision',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation failed', validationResult: { command: 'npm test', exitCode: 1, stdout: '', stderr: 'Assertion failed', passed: false, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' }
      ],
      audit: [
        { eventType: 'task_status_validation_failed', payload: {}, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      expected: {
        resumeFrom: 'validation',
        resumeValidationPlanRevision: true,
        validation: expect.objectContaining({ passed: false, stderr: 'Assertion failed' })
      }
    },
    {
      label: 'completed validation command replacement awaiting execution',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'missing-tool test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'missing-tool test', resultSummary: 'Validation failed', validationResult: { command: 'missing-tool test', exitCode: 1, stdout: '', stderr: 'not found', passed: false, failingCommand: 'missing-tool test', attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'planning', prompt: 'Diagnose validation', resultSummary: 'Use repository validation', validationResult: { passed: true, revisedValidationChecksOnly: true, validationChecks: [{ kind: 'command', command: 'npm test' }], validationRecovery: { action: 'replace_validation_check', rationale: 'Use the repository script.' }, attempt: 1 }, createdAt: '2026-08-02T10:00:35.000Z' }
      ],
      audit: [
        { eventType: 'task_failed', payload: { status: 'provider_failed' }, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      expected: {
        resumeFrom: 'validation',
        resumeValidationPlanRevision: false,
        validationChecks: [{ kind: 'command', command: 'npm test' }]
      }
    },
    {
      label: 'review provider failure after successful validation',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' }
      ],
      audit: [
        { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'review', attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' },
        { eventType: 'task_failed', payload: { status: 'provider_failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
      ],
      expected: { resumeFrom: 'review', validation: expect.objectContaining({ passed: true, command: 'npm test' }) }
    },
    {
      label: 'legacy validation result with warnings and a successful exit code',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'cmake --build build' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'cmake --build build', resultSummary: 'Validation failed', validationResult: { command: 'cmake --build build', exitCode: 0, stdout: 'Built target app', stderr: 'compiler warning', passed: false, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' }
      ],
      audit: [
        { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'review', attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' },
        { eventType: 'task_failed', payload: { status: 'provider_failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
      ],
      expected: { resumeFrom: 'review', validation: expect.objectContaining({ passed: true, exitCode: 0, stderr: 'compiler warning' }) }
    },
    {
      label: 'worker failure during a validation suite',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm run lint' }, { kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' }
      ],
      audit: [
        { eventType: 'task_activity', payload: { taskRunId: 'run_old', phase: 'validation', state: 'completed', operation: 'validation_command', detail: 'npm run lint', exitCode: 0 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'validation', attempt: 1 }, createdAt: '2026-08-02T10:00:31.000Z' },
        { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      expected: {
        resumeFrom: 'validation',
        passedValidationChecks: []
      }
    },
    {
      label: 'provider failure while revising validation commands',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'missing-tool test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'missing-tool test', resultSummary: 'Validation failed', validationResult: { command: 'missing-tool test', exitCode: 1, stdout: '', stderr: 'not found', passed: false, failingCommand: 'missing-tool test', attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' }
      ],
      audit: [
        { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'planning', attempt: 1 }, createdAt: '2026-08-02T10:00:31.000Z' },
        { eventType: 'task_failed', payload: { status: 'provider_failed' }, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      expected: {
        resumeFrom: 'validation',
        resumeValidationPlanRevision: true,
        validation: expect.objectContaining({ passed: false, failingCommand: 'missing-tool test' })
      }
    },
    {
      label: 'new implementation after an older failed GitHub validation',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Initial implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'github-actions old-sha', resultSummary: 'GitHub Actions failed', validationResult: { command: 'github-actions old-sha', exitCode: 1, stdout: '', stderr: 'Old commit failed', passed: false, failingCommand: 'github-actions', attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'implementation', prompt: 'Fix CI', resultSummary: 'CI correction', diffStat: { filesChanged: 1, insertions: 3, deletions: 1 }, validationResult: { changedFiles: ['tools/validate.mjs'], validationChecks: [{ kind: 'command', command: 'npm run validate' }], attempt: 2 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      audit: [
        { eventType: 'task_failed', payload: { status: 'iteration_limit_reached' }, createdAt: '2026-08-02T10:00:50.000Z' }
      ],
      expected: {
        resumeFrom: 'validation',
        validation: undefined,
        resumeValidationPlanRevision: false,
        validationChecks: [{ kind: 'command', command: 'npm run validate' }]
      }
    },
    {
      label: 'delivery failure after completed review',
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ],
      audit: [
        { eventType: 'task_activity', payload: { taskRunId: 'run_old', phase: 'git', state: 'completed', operation: 'commit' }, createdAt: '2026-08-02T10:00:42.000Z' },
        { eventType: 'task_activity', payload: { taskRunId: 'run_old', phase: 'git', state: 'completed', operation: 'commit_and_push' }, createdAt: '2026-08-02T10:00:44.000Z' },
        { eventType: 'task_github_operation_failed', payload: { taskRunId: 'run_old', operation: 'create_draft_pr' }, createdAt: '2026-08-02T10:00:46.000Z' },
        { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
      ],
      expected: { resumeFrom: 'delivery', completedOperations: expect.arrayContaining(['commit', 'commit_and_push']) }
    }
  ])('resumes exactly at $label', async ({ iterations, audit, expected }) => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 1,
      insertions: 5,
      deletions: 0,
      iterations
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce(audit);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: '', stderr: '', passed: true },
      summary: 'Resumed successfully.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({ kind: 'phase_retry', ...expected })
    }));
  });

  it('restores full validation evidence only from a versioned workspace checkpoint', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('phase_retry'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 1,
      insertions: 5,
      deletions: 0,
      iterations: [{
        phase: 'implementation',
        prompt: 'Implement',
        resultSummary: 'Implementation',
        diffStat: { filesChanged: 1, insertions: 5, deletions: 0 },
        validationResult: {
          changedFiles: ['src/a.ts'],
          validationChecks: [{ kind: 'command', command: 'npm test' }],
          attempt: 1
        },
        createdAt: '2026-08-02T10:00:20.000Z'
      }]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      {
        eventType: 'task_iteration_started',
        payload: { taskRunId: 'run_old', phase: 'validation', attempt: 1 },
        createdAt: '2026-08-02T10:00:31.000Z'
      },
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:40.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([
      {
        key: 'validation:legacy',
        phase: 'validation',
        status: 'completed',
        inputHash: 'workspace-hash',
        output: { command: 'npm run lint', exitCode: 0 }
      },
      {
        key: 'validation:current',
        phase: 'validation',
        status: 'completed',
        inputHash: 'workspace-hash',
        output: {
          evidenceVersion: 1,
          command: 'npm test',
          exitCode: 0,
          stdout: '42 tests passed',
          stderr: 'one compiler warning',
          criterion: 'The test suite passes.',
          rationale: 'Runs the repository test suite.'
        }
      }
    ]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: '42 tests passed', stderr: '', passed: true },
      summary: 'Resumed successfully.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        passedValidationChecks: [{
          command: 'npm test',
          exitCode: 0,
          stdout: '42 tests passed',
          stderr: 'one compiler warning',
          passed: true,
          inputHash: 'workspace-hash',
          criterion: 'The test suite passes.',
          rationale: 'Runs the repository test suite.'
        }]
      })
    }));
  });

  it('restores a completed GitHub checks checkpoint with its commit input hash', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 1,
      insertions: 5,
      deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([{
      key: 'external:wait_for_checks',
      phase: 'github',
      status: 'completed',
      inputHash: 'current-head-and-pr-hash',
      output: { status: 'success', summary: 'Current commit passed.', failures: [] }
    }]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'Resumed successfully.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        kind: 'phase_retry',
        resumeFrom: 'delivery',
        completedOperations: expect.arrayContaining(['wait_for_checks']),
        githubChecksInputHash: 'current-head-and-pr-hash',
        githubChecks: { status: 'success', summary: 'Current commit passed.', failures: [] }
      })
    }));
    expect(repositoryMock.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'system',
      eventType: 'task_retry_resume_decision',
      taskId: 'task_1',
      payload: expect.objectContaining({
        queueReason: 'task_retried',
        resumeFrom: 'delivery',
        skippedExternalEffects: expect.arrayContaining(['wait_for_checks'])
      })
    }));
  });

  it('restores merge completion only from a confirmed merge checkpoint', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 1,
      insertions: 5,
      deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_activity', payload: { taskRunId: 'run_old', phase: 'github', state: 'completed', operation: 'merge_pr' }, createdAt: '2026-08-02T10:00:45.000Z' },
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([{
      key: 'external:merge_pr',
      phase: 'github',
      status: 'completed',
      inputHash: 'pr-and-main',
      output: { pullRequestNumber: 42, targetBranch: 'main', merged: true, sha: 'a'.repeat(40) }
    }]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'completed', issueUrl: '', branchName: 'ai/1-task', workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'Merged.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        completedOperations: expect.arrayContaining(['merge_pr']),
        mergeCommitSha: 'a'.repeat(40)
      })
    }));
  });

  it('retries a previously completed but unmerged task from delivery without another AI implementation', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1', filesChanged: 1, insertions: 5, deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_status_completed', payload: {}, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([{
      key: 'external:commit', phase: 'git', status: 'completed', inputHash: 'validated-tree'
    }]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'ready_for_user_review', issueUrl: '', branchName: 'ai/1-task', workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'Merge pending.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        kind: 'phase_retry',
        resumeFrom: 'delivery',
        implementationSummary: 'Implementation',
        validation: expect.objectContaining({ passed: true }),
        reviewSummary: 'Review passed'
      })
    }));
  });

  it('resumes a GitHub billing failure from delivery with the last successful local validation', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('phase_retry'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1', filesChanged: 1, insertions: 5, deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' },
        { phase: 'validation', prompt: 'github-actions abc', resultSummary: 'GitHub Actions validation failed.', validationResult: { command: 'github-actions abc', exitCode: 1, stdout: '', stderr: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.', passed: false, failingCommand: 'github-actions', attempt: 1 }, createdAt: '2026-08-02T10:00:45.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_github_operation_failed', payload: { taskRunId: 'run_old', operation: 'wait_for_checks' }, createdAt: '2026-08-02T10:00:46.000Z' },
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'ready_for_user_review', issueUrl: '', branchName: 'ai/1-task', workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'CI retry pending.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        resumeFrom: 'delivery',
        validation: expect.objectContaining({ command: 'npm test', passed: true }),
        reviewSummary: 'Review passed'
      })
    }));
  });

  it('starts a new attempt budget when the user retries after the previous run exhausted attempt ten', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1', filesChanged: 1, insertions: 5, deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], attempt: 10 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 10 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 10 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_iteration_started', payload: { taskRunId: 'run_old', phase: 'review', attempt: 10 }, createdAt: '2026-08-02T10:00:35.000Z' },
      { eventType: 'task_github_operation_failed', payload: { taskRunId: 'run_old', operation: 'wait_for_checks' }, createdAt: '2026-08-02T10:00:45.000Z' },
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'ready_for_user_review', issueUrl: '', branchName: 'ai/1-task', workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'Retry pending.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({ resumeFrom: 'delivery', attempt: 1 })
    }));
  });

  it('does not restore merge completion from a legacy checkpoint without confirmation', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1', filesChanged: 1, insertions: 5, deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Implement', resultSummary: 'Implementation', diffStat: { filesChanged: 1, insertions: 5, deletions: 0 }, validationResult: { changedFiles: ['src/a.ts'], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Review passed', validationResult: { blockers: [], riskyChanges: [], attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_activity', payload: { taskRunId: 'run_old', phase: 'github', state: 'completed', operation: 'merge_pr' }, createdAt: '2026-08-02T10:00:45.000Z' },
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([{
      key: 'external:merge_pr', phase: 'github', status: 'completed', inputHash: 'legacy',
      output: { pullRequestNumber: 42, targetBranch: 'main' }
    }]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1', status: 'ready_for_user_review', issueUrl: '', branchName: 'ai/1-task', workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'Merge pending.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    const resume = runWorkerTaskMock.mock.calls.at(-1)?.[0]?.resume;
    expect(resume?.completedOperations).not.toContain('merge_pr');
    expect(resume?.mergeCommitSha).toBeUndefined();
  });

  it('restores a completed already-satisfied review checkpoint after worker failure', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(createClaimedTask('task_retried'));
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      iterations: [
        { phase: 'implementation', prompt: 'Verify', resultSummary: 'Already present', diffStat: { filesChanged: 0, insertions: 0, deletions: 0 }, validationResult: { alreadySatisfied: true, outcome: 'already_satisfied', evidenceFiles: ['src/existing.ts'], changedFiles: [], validationChecks: [{ kind: 'command', command: 'npm test' }], attempt: 1 }, createdAt: '2026-08-02T10:00:20.000Z' },
        { phase: 'validation', prompt: 'npm test', resultSummary: 'Validation passed', validationResult: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true, attempt: 1 }, createdAt: '2026-08-02T10:00:30.000Z' },
        { phase: 'review', prompt: 'Review', resultSummary: 'Existing state verified', validationResult: { blockers: [], riskyChanges: [], alreadySatisfied: true, attempt: 1 }, createdAt: '2026-08-02T10:00:40.000Z' }
      ]
    });
    repositoryMock.listTaskAudit.mockResolvedValueOnce([
      { eventType: 'task_failed', payload: { status: 'failed' }, createdAt: '2026-08-02T10:00:50.000Z' }
    ]);
    repositoryMock.listTaskCheckpoints.mockResolvedValueOnce([{
      key: 'review:already_satisfied',
      phase: 'review',
      status: 'completed',
      inputHash: 'repository-state-hash',
      output: {
        summary: 'Existing state verified',
        criterionResults: [{ criterion: 'Tests pass', status: 'satisfied', evidence: ['src/existing.ts'] }]
      }
    }]);
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'completed',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true },
      summary: 'Existing state verified',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(runWorkerTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      resume: expect.objectContaining({
        kind: 'phase_retry',
        implementationOutcome: 'already_satisfied',
        evidenceFiles: ['src/existing.ts'],
        completedSatisfactionReview: {
          inputHash: 'repository-state-hash',
          summary: 'Existing state verified',
          criterionResults: [{ criterion: 'Tests pass', status: 'satisfied', evidence: ['src/existing.ts'] }]
        }
      })
    }));
  });

  it('maps provider estimate failure to provider_failed status', async () => {
    createProviderMock.mockReturnValueOnce({
      estimateCost: vi.fn(async () => {
        throw new Error('Provider timeout');
      }),
      plan: vi.fn(),
      implement: vi.fn(),
      review: vi.fn(),
      kind: 'codex',
      supportsLocalRepo: () => true,
      supportsGitHubNativeFlow: () => false
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');

    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_1',
        status: 'provider_failed'
      })
    );
    expect(repositoryMock.failTask).toHaveBeenCalledWith('task_1', expect.stringContaining('estimate_cost failed'), 'provider_failed');
    expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith('queue_1', 'failed', expect.stringContaining('estimate_cost failed'));
  });

  it('uses fallback provider when primary provider estimate fails', async () => {
    const previousProvider = process.env.FORGEMIND_PROVIDER;
    const previousFallback = process.env.FORGEMIND_FALLBACK_PROVIDER;
    process.env.FORGEMIND_PROVIDER = 'openai';
    process.env.FORGEMIND_FALLBACK_PROVIDER = 'codex';

    createProviderMock.mockImplementation((kind: string) => {
      if (kind === 'openai') {
        return {
          estimateCost: vi.fn(async () => {
            throw new Error('Primary timed out');
          }),
          plan: vi.fn(),
          implement: vi.fn(),
          review: vi.fn(),
          kind: 'openai',
          supportsLocalRepo: () => true,
          supportsGitHubNativeFlow: () => false
        };
      }

      return {
        estimateCost: vi.fn(async () => ({
          inputTokens: 20,
          outputTokens: 10,
          estimatedCostUsd: 0.02
        })),
        plan: vi.fn(),
        implement: vi.fn(),
        review: vi.fn(),
        kind: 'codex',
        supportsLocalRepo: () => true,
        supportsGitHubNativeFlow: () => false
      };
    });

    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'node --version',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: 'done',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
    expect(createProviderMock).toHaveBeenCalledWith('openai', undefined);
    expect(createProviderMock).toHaveBeenCalledWith('codex', undefined);
    expect(repositoryMock.recordProviderUsage).not.toHaveBeenCalled();

    if (previousProvider === undefined) {
      delete process.env.FORGEMIND_PROVIDER;
    } else {
      process.env.FORGEMIND_PROVIDER = previousProvider;
    }
    if (previousFallback === undefined) {
      delete process.env.FORGEMIND_FALLBACK_PROVIDER;
    } else {
      process.env.FORGEMIND_FALLBACK_PROVIDER = previousFallback;
    }
  });

  it('uses fallback connection when primary and fallback provider kinds are the same', async () => {
    const previousPrimaryConnection = process.env.FORGEMIND_PROVIDER_CONNECTION_ID;
    const previousFallbackConnection = process.env.FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID;
    process.env.FORGEMIND_PROVIDER_CONNECTION_ID = 'conn_primary';
    process.env.FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID = 'conn_fallback';

    repositoryMock.getAIProviderConnectionSecretById.mockImplementation(async (connectionId: string) => {
      if (connectionId === 'conn_primary') {
        return {
          id: 'conn_primary',
          userId: 'user_1',
          name: 'Primary Codex',
          isDefault: false,
          credentialSource: 'api_key',
          provider: 'codex',
          authMode: 'api_key',
          model: 'gpt-5.5',
          apiKeyFingerprint: 'fp_primary',
          connectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          apiKey: 'key_primary'
        };
      }

      if (connectionId === 'conn_fallback') {
        return {
          id: 'conn_fallback',
          userId: 'user_1',
          name: 'Fallback Codex',
          isDefault: false,
          credentialSource: 'api_key',
          provider: 'codex',
          authMode: 'api_key',
          model: 'gpt-5.5-mini',
          apiKeyFingerprint: 'fp_fallback',
          connectedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          apiKey: 'key_fallback'
        };
      }

      return undefined;
    });

    createProviderMock.mockImplementation((_kind: string, config?: { apiKey?: string }) => ({
      estimateCost: vi.fn(async () => {
        if (config?.apiKey === 'key_fallback') {
          return {
            inputTokens: 40,
            outputTokens: 25,
            estimatedCostUsd: 0.03
          };
        }
        throw new Error('Primary connection timed out');
      }),
      plan: vi.fn(),
      implement: vi.fn(),
      review: vi.fn(),
      kind: 'codex',
      supportsLocalRepo: () => true,
      supportsGitHubNativeFlow: () => false
    }));

    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'node --version',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: 'done',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
    expect(createProviderMock).toHaveBeenCalledTimes(3);
    expect(createProviderMock).toHaveBeenNthCalledWith(1, 'codex', expect.objectContaining({ apiKey: 'key_primary', model: 'gpt-5.5' }));
    expect(createProviderMock).toHaveBeenNthCalledWith(2, 'codex', expect.objectContaining({ apiKey: 'key_fallback', model: 'gpt-5.5-mini' }));
    expect(createProviderMock).toHaveBeenNthCalledWith(3, 'codex', expect.objectContaining({ apiKey: 'key_primary', model: 'gpt-5.5' }));

    if (previousPrimaryConnection === undefined) {
      delete process.env.FORGEMIND_PROVIDER_CONNECTION_ID;
    } else {
      process.env.FORGEMIND_PROVIDER_CONNECTION_ID = previousPrimaryConnection;
    }
    if (previousFallbackConnection === undefined) {
      delete process.env.FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID;
    } else {
      process.env.FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID = previousFallbackConnection;
    }
  });

  it('persists actual provider usage per phase and finishes the run with measured totals', async () => {
    runWorkerTaskMock.mockImplementationOnce(async (input: {
      hooks?: {
        onProviderActivity?: (activity: Record<string, unknown>) => Promise<void>;
      };
    }) => {
      await input.hooks?.onProviderActivity?.({
        phase: 'implementation',
        attempt: 1,
        kind: 'lifecycle',
        message: 'Provider usage captured.',
        elapsedMs: 0,
        usage: {
          provider: 'codex',
          model: 'gpt-5.5',
          totalTokens: 100000,
          source: 'actual_total'
        }
      });
      await input.hooks?.onProviderActivity?.({
        phase: 'review',
        attempt: 2,
        kind: 'lifecycle',
        message: 'Provider usage captured.',
        elapsedMs: 0,
        usage: {
          provider: 'codex',
          model: 'gpt-5.5',
          totalTokens: 124947,
          source: 'actual_total'
        }
      });
      await input.hooks?.onProviderActivity?.({
        phase: 'implementation',
        attempt: 2,
        kind: 'lifecycle',
        message: 'Provider usage captured.',
        elapsedMs: 0,
        usage: {
          provider: 'codex',
          model: 'gpt-5.5',
          totalTokens: 160000,
          source: 'actual_total'
        }
      });

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: '',
        branchName: 'ai/task',
        workspacePath: 'C:/tmp/worker',
        validation: { command: 'npm test', exitCode: 0, stdout: '', stderr: '', passed: true },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.recordProviderUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'implementation',
      totalTokens: 100000,
      usageSource: 'actual_total'
    }));
    expect(repositoryMock.recordProviderUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      provider: 'codex',
      model: 'gpt-5.5',
      phase: 'review',
      attempt: 2,
      totalTokens: 124947,
      usageSource: 'actual_total',
      estimatedCostUsd: 0
    }));
    expect(repositoryMock.recordProviderUsage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      phase: 'implementation',
      totalTokens: 60000,
      usageSource: 'actual_total'
    }));
    expect(repositoryMock.finishTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      totalTokens: 284947,
      usageSource: 'actual_total',
      actualCostUsd: null
    }));
  });

  it('persists the provider session created during a task run', async () => {
    runWorkerTaskMock.mockImplementationOnce(async (input: {
      providerSession?: { onUpdate?: (session: { id: string; provider: 'codex'; model: string }) => Promise<void> };
    }) => {
      await input.providerSession?.onUpdate?.({ id: 'thread-123', provider: 'codex', model: 'gpt-5.5' });
      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: '',
        branchName: 'ai/task',
        workspacePath: 'C:/tmp/worker',
        validation: { command: 'npm test', exitCode: 0, stdout: '', stderr: '', passed: true },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.updateTaskProviderSession).toHaveBeenCalledWith({
      taskId: 'task_1',
      sessionId: 'thread-123',
      provider: 'codex',
      model: 'gpt-5.5',
      connectionId: undefined
    });
  });

  it('persists semantic task activity for realtime clients', async () => {
    runWorkerTaskMock.mockImplementationOnce(async (input: {
      hooks?: {
        onActivity?: (activity: {
          phase: 'validation';
          state: 'progress';
          title: string;
          detail: string;
          operation: string;
          attempt: number;
          elapsedMs: number;
        }) => Promise<void>;
      };
    }) => {
      await input.hooks?.onActivity?.({
        phase: 'validation',
        state: 'progress',
        title: 'Validace stále běží',
        detail: 'npm test',
        operation: 'validation_command',
        attempt: 1,
        elapsedMs: 500
      });

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: '',
        branchName: 'ai/task',
        workspacePath: 'C:/tmp/worker',
        validation: { command: 'npm test', exitCode: 0, stdout: '', stderr: '', passed: true },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.writeAudit).toHaveBeenCalledWith({
      actorType: 'agent',
      eventType: 'task_activity',
      taskId: 'task_1',
      payload: expect.objectContaining({
        phase: 'validation',
        state: 'progress',
        title: 'Validace stále běží',
        detail: 'npm test',
        operation: 'validation_command',
        attempt: 1,
        elapsedMs: 500
      })
    });
  });

  it('maps requested approvals to needs_approval policy path', async () => {
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'needs_approval',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'node --version',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: 'Approval needed for dependency change.',
      approvals: ['new_dependency'],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_1'
      })
    );
    expect(repositoryMock.transitionTask).toHaveBeenCalledWith('task_1', 'needs_approval', {
      approvals: ['new_dependency']
    });
    expect(repositoryMock.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        type: 'new_dependency'
      })
    );
  });

  it('normalizes free-form approval reasons before creating approval records', async () => {
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'needs_approval',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'node --version',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: 'Approval needed for workspace write access.',
      approvals: ['Workspace write access is required to create the React application structure and run the build.'],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_1'
      })
    );
    expect(repositoryMock.transitionTask).toHaveBeenCalledWith('task_1', 'needs_approval', {
      approvals: ['risky_refactor']
    });
    expect(repositoryMock.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        type: 'risky_refactor'
      })
    );
  });

  it('pauses for approval instead of failing when current diff line guardrail is exceeded', async () => {
    runWorkerTaskMock.mockImplementationOnce(async (input: { hooks?: { onIteration?: (iteration: { phase: 'implementation'; prompt: string; resultSummary: string; diffStat: { filesChanged: number; insertions: number; deletions: number }; validationResult: { passed: boolean } }) => Promise<void> } }) => {
      await input.hooks?.onIteration?.({
        phase: 'implementation',
        prompt: 'Create React app',
        resultSummary: 'Large scaffold created.',
        diffStat: { filesChanged: 8, insertions: 2500, deletions: 0 },
        validationResult: { passed: true }
      });

      throw new Error('The hook should stop workflow execution.');
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_1',
        status: 'needs_approval'
      })
    );
    expect(repositoryMock.transitionTask).toHaveBeenCalledWith(
      'task_1',
      'needs_approval',
      expect.objectContaining({
        approvals: ['risky_refactor'],
        limitSignal: 'diff_lines_limit_reached'
      })
    );
    expect(repositoryMock.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        type: 'risky_refactor',
        title: 'Approval required: large implementation diff'
      })
    );
    expect(repositoryMock.failTask).not.toHaveBeenCalled();
    expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith('queue_1', 'succeeded');
  });

  it('continues past the large diff guardrail in full-auto mode', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce({
      task: {
        id: 'task_full_auto',
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Full auto task',
        prompt: 'Prompt long enough',
        mode: 'full_auto',
        status: 'submitted',
        maxIterations: 3,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      project: {
        id: 'project_1',
        name: 'Demo',
        slug: 'demo',
        githubOwner: 'demo',
        githubRepo: 'repo',
        defaultBranch: 'main',
        defaultTaskMode: 'full_auto',
        allowSafeOperationsWithoutApproval: true,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      taskRun: { id: 'run_full_auto' },
      queueJobId: 'queue_full_auto'
    });
    runWorkerTaskMock.mockImplementationOnce(async (input: { hooks?: { onIteration?: (iteration: { phase: 'implementation'; prompt: string; resultSummary: string; diffStat: { filesChanged: number; insertions: number; deletions: number }; validationResult: { passed: boolean } }) => Promise<void> } }) => {
      await input.hooks?.onIteration?.({
        phase: 'implementation',
        prompt: 'Create large frontend flow',
        resultSummary: 'Large implementation completed.',
        diffStat: { filesChanged: 8, insertions: 2500, deletions: 0 },
        validationResult: { passed: true }
      });
      return {
        taskId: 'task_full_auto',
        status: 'ready_for_user_review',
        branchName: 'ai/full-auto',
        workspacePath: 'C:/tmp/worker',
        validation: { command: 'npm test', exitCode: 0, stdout: 'passed', stderr: '', passed: true },
        summary: 'Completed without approval.',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_full_auto' }));
    expect(repositoryMock.transitionTask).not.toHaveBeenCalledWith(
      'task_full_auto',
      'needs_approval',
      expect.objectContaining({ limitSignal: 'diff_lines_limit_reached' })
    );
    expect(repositoryMock.createApproval).not.toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task_full_auto' }));
  });

  it('does not cumulatively count the same diff across iterations', async () => {
    runWorkerTaskMock.mockImplementationOnce(async (input: { hooks?: { onIteration?: (iteration: { phase: 'implementation' | 'validation'; prompt: string; resultSummary: string; diffStat: { filesChanged: number; insertions: number; deletions: number }; validationResult: { passed: boolean } }) => Promise<void> } }) => {
      const diffStat = { filesChanged: 4, insertions: 1500, deletions: 0 };
      await input.hooks?.onIteration?.({
        phase: 'implementation',
        prompt: 'Create files',
        resultSummary: 'Implemented files.',
        diffStat,
        validationResult: { passed: true }
      });
      await input.hooks?.onIteration?.({
        phase: 'validation',
        prompt: 'npm run build',
        resultSummary: 'Build passed.',
        diffStat,
        validationResult: { passed: true }
      });

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
    expect(repositoryMock.transitionTask).not.toHaveBeenCalledWith(
      'task_1',
      'needs_approval',
      expect.objectContaining({ limitSignal: 'diff_lines_limit_reached' })
    );
    expect(repositoryMock.failTask).not.toHaveBeenCalled();
  });

  it('allows a completed review phase to finish after the runtime limit', async () => {
    const startedAt = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startedAt);

    runWorkerTaskMock.mockImplementationOnce(async (input: {
      hooks?: {
        onIteration?: (iteration: {
          phase: 'review';
          prompt: string;
          resultSummary: string;
          diffStat: { filesChanged: number; insertions: number; deletions: number };
          validationResult: { blockers: string[]; riskyChanges: string[]; attempt: number };
        }) => Promise<void>;
      };
    }) => {
      dateNow.mockReturnValue(startedAt + 91 * 60_000);
      await input.hooks?.onIteration?.({
        phase: 'review',
        prompt: 'Review status.txt',
        resultSummary: 'Review passed.',
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationResult: { blockers: [], riskyChanges: [], attempt: 1 }
      });

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm test',
          exitCode: 0,
          stdout: 'passed',
          stderr: '',
          passed: true
        },
        summary: 'Review passed.',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    try {
      const { runDatabaseWorkerOnce } = await import('./db-worker.js');
      const result = await runDatabaseWorkerOnce();

      expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
      expect(repositoryMock.failTask).not.toHaveBeenCalled();
      expect(repositoryMock.transitionTask).toHaveBeenCalledWith(
        'task_1',
        'ready_for_user_review',
        expect.objectContaining({ branchName: 'ai/1-task' })
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it('reuses approved large-diff resume context and ignores the same guardrail on retry', async () => {
    repositoryMock.listApprovals.mockResolvedValueOnce([
      {
        id: 'approval_1',
        taskId: 'task_1',
        type: 'risky_refactor',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: large implementation diff',
        description: 'Current diff is large.',
        riskLevel: 'high',
        payload: {
          limitSignal: 'diff_lines_limit_reached'
        },
        createdAt: new Date().toISOString()
      }
    ]);
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 8,
      insertions: 2500,
      deletions: 0,
      iterations: [
        {
          id: 'iteration_1',
          taskRunId: 'run_old',
          iterationNumber: 1,
          phase: 'implementation',
          prompt: 'Create React app',
          resultSummary: 'Large scaffold created.',
          diffStat: { filesChanged: 8, insertions: 2500, deletions: 0 },
          validationResult: { passed: true },
          createdAt: new Date().toISOString()
        }
      ]
    });

    runWorkerTaskMock.mockImplementationOnce(async (input: {
      resume?: {
        kind: 'approved_large_diff';
        implementationSummary: string;
        approvedApprovals?: string[];
      };
      hooks?: {
        onIteration?: (iteration: {
          phase: 'validation';
          prompt: string;
          resultSummary: string;
          diffStat: { filesChanged: number; insertions: number; deletions: number };
          validationResult: { passed: boolean };
        }) => Promise<void>;
      };
    }) => {
      expect(input.resume).toEqual(expect.objectContaining({
        kind: 'approved_large_diff',
        implementationSummary: 'Large scaffold created.',
        approvedApprovals: ['risky_refactor']
      }));

      await input.hooks?.onIteration?.({
        phase: 'validation',
        prompt: 'npm run build',
        resultSummary: 'Build passed.',
        diffStat: { filesChanged: 8, insertions: 2500, deletions: 0 },
        validationResult: { passed: true }
      });

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
    expect(repositoryMock.transitionTask).not.toHaveBeenCalledWith(
      'task_1',
      'needs_approval',
      expect.objectContaining({ limitSignal: 'diff_lines_limit_reached' })
    );
    expect(repositoryMock.createApproval).not.toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task_1',
        title: 'Approval required: large implementation diff'
      })
    );
  });

  it('resumes preserved workspace changes after a protected operation is approved', async () => {
    repositoryMock.listApprovals.mockResolvedValueOnce([
      {
        id: 'approval_workflow',
        taskId: 'task_1',
        type: 'github_workflow_change',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: github_workflow_change',
        description: 'GitHub workflow change approval.',
        riskLevel: 'high',
        payload: {},
        createdAt: new Date().toISOString()
      }
    ]);
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 2,
      insertions: 118,
      deletions: 4,
      iterations: [
        {
          id: 'iteration_plan',
          taskRunId: 'run_old',
          iterationNumber: 1,
          phase: 'planning',
          prompt: 'Add CI quality gate',
          resultSummary: 'Create and gate the quality workflow.',
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          validationResult: {
            validationChecks: [{ kind: 'command', command: 'npm test' }]
          },
          createdAt: new Date().toISOString()
        }
      ]
    });

    runWorkerTaskMock.mockImplementationOnce(async (input: {
      resume?: {
        kind: 'approved_operation';
        implementationSummary: string;
        approvedApprovals?: string[];
      };
    }) => {
      expect(input.resume).toEqual(expect.objectContaining({
        kind: 'approved_operation',
        implementationSummary: 'Resume workspace changes after the requested operation was approved.',
        approvedApprovals: ['github_workflow_change']
      }));

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm test',
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
  });

  it('reuses approved review approvals to resume without restarting planning', async () => {
    repositoryMock.listApprovals.mockResolvedValueOnce([
      {
        id: 'approval_1',
        taskId: 'task_1',
        type: 'new_dependency',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: new_dependency',
        description: 'Dependency approval.',
        riskLevel: 'medium',
        payload: {},
        createdAt: new Date().toISOString()
      },
      {
        id: 'approval_2',
        taskId: 'task_1',
        type: 'config_change',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: config_change',
        description: 'Config approval.',
        riskLevel: 'high',
        payload: {},
        createdAt: new Date().toISOString()
      }
    ]);
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 14,
      insertions: 2062,
      deletions: 0,
      iterations: [
        {
          id: 'iteration_plan',
          taskRunId: 'run_old',
          iterationNumber: 1,
          phase: 'planning',
          prompt: 'Create app',
          resultSummary: 'Original plan summary',
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          validationResult: { passed: true },
          createdAt: new Date().toISOString()
        },
        {
          id: 'iteration_impl',
          taskRunId: 'run_old',
          iterationNumber: 2,
          phase: 'implementation',
          prompt: 'Create app',
          resultSummary: 'Large scaffold created.',
          diffStat: { filesChanged: 14, insertions: 2062, deletions: 0 },
          validationResult: { passed: true },
          createdAt: new Date().toISOString()
        },
        {
          id: 'iteration_review',
          taskRunId: 'run_old',
          iterationNumber: 3,
          phase: 'review',
          prompt: 'Review files',
          resultSummary: 'Reviewed changes, no blockers.',
          diffStat: { filesChanged: 14, insertions: 2062, deletions: 0 },
          validationResult: { blockers: [], riskyChanges: ['new_dependency', 'config_change'] },
          createdAt: new Date().toISOString()
        }
      ]
    });

    runWorkerTaskMock.mockImplementationOnce(async (input: {
      resume?: {
        kind: 'approved_review';
        planSummary?: string;
        implementationSummary: string;
        reviewSummary?: string;
        riskyChanges?: string[];
        approvedApprovals?: string[];
      };
    }) => {
      expect(input.resume).toEqual(expect.objectContaining({
        kind: 'approved_review',
        planSummary: 'Original plan summary',
        implementationSummary: 'Large scaffold created.',
        reviewSummary: 'Reviewed changes, no blockers.',
        riskyChanges: ['new_dependency', 'config_change'],
        approvedApprovals: ['new_dependency', 'config_change']
      }));

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: 'Reviewed changes, no blockers.',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
  });

  it('prefers approved large-diff resume when it is newer than historical review approvals', async () => {
    repositoryMock.listApprovals.mockResolvedValueOnce([
      {
        id: 'approval_review_1',
        taskId: 'task_1',
        type: 'new_dependency',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: new_dependency',
        description: 'Dependency approval.',
        riskLevel: 'medium',
        payload: {},
        createdAt: '2026-07-11T10:00:00.000Z'
      },
      {
        id: 'approval_review_2',
        taskId: 'task_1',
        type: 'config_change',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: config_change',
        description: 'Config approval.',
        riskLevel: 'high',
        payload: {},
        createdAt: '2026-07-11T10:00:01.000Z'
      },
      {
        id: 'approval_large_diff',
        taskId: 'task_1',
        type: 'risky_refactor',
        status: 'approved',
        requestedBy: 'agent',
        title: 'Approval required: large implementation diff',
        description: 'Current diff is large.',
        riskLevel: 'high',
        payload: {
          limitSignal: 'diff_lines_limit_reached'
        },
        createdAt: '2026-07-11T10:05:00.000Z'
      }
    ]);
    repositoryMock.getTaskDiff.mockResolvedValueOnce({
      taskId: 'task_1',
      filesChanged: 14,
      insertions: 2062,
      deletions: 0,
      iterations: [
        {
          id: 'iteration_plan',
          taskRunId: 'run_old',
          iterationNumber: 1,
          phase: 'planning',
          prompt: 'Create app',
          resultSummary: 'Original plan summary',
          diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
          validationResult: { passed: true },
          createdAt: new Date().toISOString()
        },
        {
          id: 'iteration_impl',
          taskRunId: 'run_old',
          iterationNumber: 2,
          phase: 'implementation',
          prompt: 'Create app',
          resultSummary: 'Large scaffold created.',
          diffStat: { filesChanged: 14, insertions: 2062, deletions: 0 },
          validationResult: { passed: true },
          createdAt: new Date().toISOString()
        },
        {
          id: 'iteration_review',
          taskRunId: 'run_old',
          iterationNumber: 3,
          phase: 'review',
          prompt: 'Review files',
          resultSummary: 'Reviewed changes, no blockers.',
          diffStat: { filesChanged: 14, insertions: 2062, deletions: 0 },
          validationResult: { blockers: [], riskyChanges: ['new_dependency', 'config_change'] },
          createdAt: new Date().toISOString()
        }
      ]
    });

    runWorkerTaskMock.mockImplementationOnce(async (input: {
      resume?: {
        kind: 'approved_large_diff';
        implementationSummary: string;
        approvedApprovals?: string[];
      };
    }) => {
      expect(input.resume).toEqual(expect.objectContaining({
        kind: 'approved_large_diff',
        implementationSummary: 'Large scaffold created.'
      }));

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm run build',
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
  });

  it('records a high provider estimate without blocking the workflow', async () => {
    createProviderMock.mockReturnValueOnce({
      estimateCost: vi.fn(async () => ({
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 999
      })),
      plan: vi.fn(),
      implement: vi.fn(),
      review: vi.fn(),
      kind: 'codex',
      supportsLocalRepo: () => true,
      supportsGitHubNativeFlow: () => false
    });
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'ready_for_user_review',
      branchName: 'ai/1-task',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'npm run build',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true
      },
      summary: 'done',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(expect.objectContaining({ claimed: true, taskId: 'task_1' }));
    expect(runWorkerTaskMock).toHaveBeenCalledOnce();
    expect(repositoryMock.failTask).not.toHaveBeenCalledWith(
      'task_1',
      expect.any(String),
      'budget_exceeded'
    );
  });

  it('stops with repeated_error_detected when the same validation error repeats', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce({
      task: {
        id: 'task_1',
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Task',
        prompt: 'Prompt long enough',
        mode: 'safe',
        status: 'submitted',
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      project: {
        id: 'project_1',
        name: 'Demo',
        slug: 'demo',
        githubOwner: 'demo',
        githubRepo: 'repo',
        defaultBranch: 'main',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      taskRun: { id: 'run_1' },
      queueJobId: 'queue_1'
    });

    runWorkerTaskMock.mockImplementationOnce(async (input: { hooks?: { onIteration?: (iteration: { phase: 'validation'; prompt: string; resultSummary: string; diffStat: { filesChanged: number; insertions: number; deletions: number }; validationResult: { passed: boolean; exitCode: number; stderr: string; stdout: string } }) => Promise<void> } }) => {
      const iteration = (buildDuration: number) => ({
        phase: 'validation' as const,
        prompt: 'npm test',
        resultSummary: 'Validation failed',
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationResult: {
          passed: false,
          exitCode: 1,
          stderr: '',
          stdout: `Build success in ${buildDuration}ms\nTypeError: same failure`
        }
      });

      await input.hooks?.onIteration?.(iteration(100));
      await input.hooks?.onIteration?.(iteration(250));
      await input.hooks?.onIteration?.(iteration(900));

      return {
        taskId: 'task_1',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/1',
        branchName: 'ai/1-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'npm test',
          exitCode: 1,
          stdout: '',
          stderr: 'TypeError: same failure',
          passed: false
        },
        summary: 'failed',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_1',
        status: 'repeated_error_detected'
      })
    );
    expect(repositoryMock.failTask).toHaveBeenCalledWith('task_1', expect.stringContaining('repeated_error_detected'), 'repeated_error_detected');
  });

  it('allows the final configured iteration to finish the workflow', async () => {
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce({
      task: {
        id: 'task_2',
        projectId: 'project_1',
        createdByUserId: 'user_1',
        title: 'Task 2',
        prompt: 'Prompt long enough',
        mode: 'safe',
        status: 'submitted',
        maxIterations: 1,
        maxBudgetUsd: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      project: {
        id: 'project_1',
        name: 'Demo',
        slug: 'demo',
        githubOwner: 'demo',
        githubRepo: 'repo',
        defaultBranch: 'main',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      taskRun: { id: 'run_2' },
      queueJobId: 'queue_2'
    });

    runWorkerTaskMock.mockImplementationOnce(async (input: { hooks?: { onIteration?: (iteration: { phase: 'implementation'; prompt: string; resultSummary: string; diffStat: { filesChanged: number; insertions: number; deletions: number }; validationResult: { passed: boolean } }) => Promise<void> } }) => {
      await input.hooks?.onIteration?.({
        phase: 'implementation',
        prompt: 'Implement',
        resultSummary: 'Attempt 1',
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationResult: { passed: true }
      });

      return {
        taskId: 'task_2',
        status: 'ready_for_user_review',
        issueUrl: 'https://github.com/demo/repo/issues/2',
        branchName: 'ai/2-task',
        workspacePath: 'C:/tmp/worker',
        validation: {
          command: 'node --version',
          exitCode: 0,
          stdout: '',
          stderr: '',
          passed: true
        },
        summary: 'done',
        approvals: [],
        completedAt: new Date().toISOString()
      };
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_2',
        result: expect.objectContaining({ status: 'ready_for_user_review' })
      })
    );
    expect(repositoryMock.failTask).not.toHaveBeenCalled();
  });
  it('marks a successfully auto-merged task as completed after entering review-ready state', async () => {
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'completed',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      pullRequestUrl: 'https://github.com/demo/repo/pull/1',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'npm run build',
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
        passed: true
      },
      summary: 'Merged successfully.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.transitionTask).toHaveBeenNthCalledWith(1, 'task_1', 'ready_for_user_review', {
      pullRequestUrl: 'https://github.com/demo/repo/pull/1',
      branchName: 'ai/1-task'
    });
    expect(repositoryMock.transitionTask).toHaveBeenNthCalledWith(2, 'task_1', 'completed');
    expect(advanceRoadmapAfterTaskCompletionMock).toHaveBeenCalledWith(repositoryMock, 'task_1');
  });

  it('completes a task with deferred Windows validation evidence', async () => {
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'completed',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      pullRequestUrl: 'https://github.com/demo/repo/pull/1',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'UnrealEditor.exe Flying.uproject', exitCode: 0, stdout: '', stderr: '', passed: true,
        deferredChecks: [{
          command: 'UnrealEditor.exe Flying.uproject', criterion: 'Win64 starts',
          requiredCapabilities: ['windows'], missingCapabilities: ['windows']
        }]
      },
      requiredCapabilities: ['windows'],
      summary: 'Source delivered; Win64 gate deferred.', approvals: [], completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.setTaskDeferredValidationCapabilities).toHaveBeenCalledWith('task_1', ['windows']);
    expect(repositoryMock.transitionTask).toHaveBeenNthCalledWith(1, 'task_1', 'ready_for_user_review', {
      pullRequestUrl: 'https://github.com/demo/repo/pull/1',
      branchName: 'ai/1-task'
    });
    expect(repositoryMock.transitionTask).toHaveBeenNthCalledWith(2, 'task_1', 'completed');
    expect(repositoryMock.waitTaskForCapabilities).not.toHaveBeenCalled();
    expect(advanceRoadmapAfterTaskCompletionMock).toHaveBeenCalledWith(repositoryMock, 'task_1');
    expect(repositoryMock.finalizeQueueJob).toHaveBeenCalledWith('queue_1', 'succeeded');
    expect(repositoryMock.failTask).not.toHaveBeenCalled();
  });

  it('emits a capability waiting lifecycle state with concrete missing capabilities', async () => {
    runWorkerTaskMock.mockResolvedValueOnce({
      taskId: 'task_1',
      status: 'waiting_for_capability',
      issueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task',
      pullRequestUrl: 'https://github.com/demo/repo/pull/1',
      workspacePath: 'C:/tmp/worker',
      validation: {
        command: 'UnrealEditor.exe Flying.uproject',
        exitCode: 0,
        stdout: '',
        stderr: '',
        passed: true,
        deferredChecks: [{
          command: 'UnrealEditor.exe Flying.uproject',
          criterion: 'Win64 starts',
          requiredCapabilities: ['windows'],
          missingCapabilities: ['windows']
        }]
      },
      requiredCapabilities: ['windows'],
      summary: 'Source delivery completed; waiting for Windows validation.',
      approvals: [],
      completedAt: new Date().toISOString()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    await runDatabaseWorkerOnce();

    expect(repositoryMock.waitTaskForCapabilities).toHaveBeenCalledWith('task_1', ['windows'], expect.objectContaining({
      validation: expect.objectContaining({
        command: 'UnrealEditor.exe Flying.uproject',
        deferredChecks: [expect.objectContaining({
          requiredCapabilities: ['windows'],
          missingCapabilities: ['windows']
        })]
      })
    }));
    expect(advanceRoadmapAfterTaskCapabilityWaitMock).toHaveBeenCalledWith(repositoryMock, 'task_1');
    expect(repositoryMock.finishTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      taskRunId: 'run_1',
      status: 'succeeded',
      summary: 'Source delivery completed; waiting for Windows validation.'
    }));
  });

  it('runs capability and release audits before completing a roadmap cycle', async () => {
    const contract = {
      version: 1,
      summary: 'Demo project',
      invariants: ['Use persisted data.'],
      prohibitedSubstitutes: ['Static fixtures.'],
      requirements: [{ id: 'REQ-DEMO', title: 'Demo', description: 'Demo works.', acceptanceCriteria: ['Integration works.'] }],
      releaseCriteria: ['Build passes.']
    };
    const project = {
      id: 'project_1', name: 'Demo', slug: 'demo', githubOwner: 'demo', githubRepo: 'repo', defaultBranch: 'main',
      projectContract: contract, planningSessionId: 'project-thread-1', planningSessionProvider: 'codex',
      planningSessionModel: 'codex', isActive: true, createdAt: '', updatedAt: ''
    };
    const capability = {
      requirement: contract.requirements[0], status: 'satisfied', workItemIds: ['step_1'], evidence: [], satisfiedCriteria: 1, totalCriteria: 1
    };
    const completedPriorCycleStep = {
      id: 'step_1', projectId: project.id, cycleId: 'cycle_0', sequenceNumber: 1, title: 'Prior foundation',
      description: 'Existing implementation', acceptanceCriteria: ['Integration works.'], requirementIds: ['REQ-DEMO'],
      deliverables: ['Existing implementation'], status: 'completed'
    };
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(undefined);
    repositoryMock.claimNextProjectAudit.mockResolvedValueOnce({
      job: { id: 'audit_1', projectId: project.id, cycleId: 'cycle_1', triggerTaskId: 'task_1', requirementIds: ['REQ-DEMO'], status: 'claimed', attemptCount: 1 },
      project,
      cycle: { id: 'cycle_1', projectId: project.id, cycleNumber: 1, objective: 'Build Demo', status: 'verifying' }
    });
    repositoryMock.getProjectRoadmap
      .mockResolvedValueOnce({ projectId: project.id, cycles: [], steps: [completedPriorCycleStep], evidence: [], capabilities: [] })
      .mockResolvedValueOnce({ projectId: project.id, cycles: [], steps: [], evidence: [], capabilities: [capability] });
    runCapabilityAuditMock.mockResolvedValueOnce({ verdict: 'satisfied', summary: 'Done', criteria: [], gapWorkItems: [] });
    runReleaseAuditMock.mockResolvedValueOnce({
      verdict: 'satisfied', summary: 'Ready', criteria: [], briefCoverage: [], contractAmendments: [], gapWorkItems: []
    });
    const extensionPlan = vi.fn(async (input: { session?: { id?: string; onUpdate?: (update: { id: string; provider: 'codex'; model: string }) => Promise<void> } }) => {
      await input.session?.onUpdate?.({ id: 'project-thread-2', provider: 'codex', model: 'codex' });
      return {
        summary: 'Rozšíření přidá týmovou spolupráci nad existujícími daty projektu. Uživatelé budou moci sdílet cíle, sledovat společný pokrok a přitom zachovat soukromí individuálních záznamů.',
        steps: ['Správa týmů', 'Sdílené cíle', 'Týmový přehled'],
        acceptanceCriteria: ['Uživatel vytvoří tým.', 'Členové sledují společný cíl.', 'Soukromé záznamy zůstávají skryté.'],
        validationChecks: []
      };
    });
    createProviderMock.mockReturnValue({
      kind: 'codex',
      supportsLocalRepo: () => true,
      supportsGitHubNativeFlow: () => false,
      estimateCost: vi.fn(),
      plan: extensionPlan,
      implement: vi.fn(),
      review: vi.fn(),
      auditCapability: vi.fn(),
      auditRelease: vi.fn()
    });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toMatchObject({ claimed: true, kind: 'project_audit', status: 'awaiting_extension_approval' });
    expect(runCapabilityAuditMock).toHaveBeenCalledTimes(1);
    expect(runCapabilityAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      workItems: [expect.objectContaining({ id: 'step_1', cycleId: 'cycle_0' })]
    }));
    expect(runReleaseAuditMock).toHaveBeenCalledTimes(1);
    expect(extensionPlan).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/Celý výstup napiš česky[\s\S]*4 až 8 konkrétních funkčních oblastí[\s\S]*3 až 6 měřitelných kritérií/),
      session: expect.objectContaining({ id: 'project-thread-1', provider: 'codex', model: 'codex' })
    }));
    expect(repositoryMock.updateProjectPlanningSession).toHaveBeenCalledWith({
      projectId: 'project_1', sessionId: 'project-thread-2', provider: 'codex', model: 'codex', connectionId: undefined
    });
    expect(repositoryMock.updateProjectRoadmapCycleStatus).toHaveBeenCalledWith('cycle_1', 'completed');
    expect(repositoryMock.setProjectRoadmapCycleExtensionProposal).toHaveBeenCalledWith('cycle_1', {
      proposal: expect.stringMatching(/Rozšíření přidá týmovou spolupráci[\s\S]*## Funkční rozsah[\s\S]*- Správa týmů[\s\S]*## Měřitelná kritéria úspěchu/),
      status: 'awaiting_extension_approval'
    });
  });

  it('defers a queued capability audit while a traced roadmap step is still open', async () => {
    const requirement = {
      id: 'REQ-DEMO', title: 'Demo', description: 'Demo works.', acceptanceCriteria: ['Integration works.']
    };
    const contract = {
      version: 1,
      summary: 'Demo project',
      invariants: [],
      prohibitedSubstitutes: [],
      requirements: [requirement],
      releaseCriteria: ['Build passes.']
    };
    const project = {
      id: 'project_1', name: 'Demo', slug: 'demo', githubOwner: 'demo', githubRepo: 'repo', defaultBranch: 'main',
      projectContract: contract, isActive: true, createdAt: '', updatedAt: ''
    };
    const roadmap = {
      projectId: project.id,
      cycles: [],
      steps: [
        {
          id: 'step_1', projectId: project.id, cycleId: 'cycle_1', sequenceNumber: 1, title: 'Foundation',
          description: 'Foundation', acceptanceCriteria: ['Foundation works.'], requirementIds: ['REQ-DEMO'],
          deliverables: ['Foundation'], status: 'completed'
        },
        {
          id: 'step_2', projectId: project.id, cycleId: 'cycle_1', sequenceNumber: 2, title: 'Integration',
          description: 'Integration', acceptanceCriteria: ['Integration works.'], requirementIds: ['REQ-DEMO'],
          deliverables: ['Integration'], status: 'pending'
        }
      ],
      evidence: [],
      capabilities: [{ requirement, status: 'implementing', workItemIds: ['step_1', 'step_2'], evidence: [], satisfiedCriteria: 0, totalCriteria: 1 }]
    };
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(undefined);
    repositoryMock.claimNextProjectAudit.mockResolvedValueOnce({
      job: { id: 'audit_1', projectId: project.id, cycleId: 'cycle_1', requirementIds: ['REQ-DEMO'], status: 'claimed', attemptCount: 1 },
      project,
      cycle: { id: 'cycle_1', projectId: project.id, cycleNumber: 1, objective: 'Build Demo', status: 'verifying' }
    });
    repositoryMock.getProjectRoadmap
      .mockResolvedValueOnce(roadmap)
      .mockResolvedValueOnce(roadmap);
    startNextRoadmapStepMock.mockResolvedValueOnce({ id: 'task_2' });

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toMatchObject({ status: 'roadmap_continued', nextTaskId: 'task_2' });
    expect(runCapabilityAuditMock).not.toHaveBeenCalled();
    expect(repositoryMock.appendProjectImplementationSteps).not.toHaveBeenCalled();
    expect(repositoryMock.updateProjectRoadmapCycleStatus).toHaveBeenCalledWith('cycle_1', 'active');
    expect(repositoryMock.finalizeProjectAudit).toHaveBeenCalledWith('audit_1', 'succeeded');
  });

  it('schedules only missing brief scope and appends its requirement to the contract', async () => {
    const contract = {
      version: 1,
      summary: 'Demo project',
      invariants: ['Use persisted data.'],
      prohibitedSubstitutes: ['Static fixtures.'],
      requirements: [{ id: 'REQ-DEMO', title: 'Demo', description: 'Demo works.', acceptanceCriteria: ['Integration works.'] }],
      releaseCriteria: ['Build passes.']
    };
    const project = {
      id: 'project_1', name: 'Demo', slug: 'demo', githubOwner: 'demo', githubRepo: 'repo', defaultBranch: 'main',
      projectContract: contract, isActive: true, createdAt: '', updatedAt: ''
    };
    const capability = {
      requirement: contract.requirements[0], status: 'satisfied', workItemIds: ['step_1'], evidence: [], satisfiedCriteria: 1, totalCriteria: 1
    };
    const newRequirement = {
      id: 'REQ-EXPORT', title: 'Export', description: 'Export persisted data.',
      acceptanceCriteria: ['Users can export persisted data.'], briefReferences: ['export results']
    };
    const gapWorkItem = {
      title: 'Implement export', description: 'Add only the omitted export capability.',
      acceptanceCriteria: ['Users can export persisted data.'], inScope: ['Export'], outOfScope: ['Other features'],
      requirementIds: ['REQ-EXPORT'], deliverables: ['Export capability']
    };
    repositoryMock.claimNextSubmittedTask.mockResolvedValueOnce(undefined);
    repositoryMock.claimNextProjectAudit.mockResolvedValueOnce({
      job: { id: 'audit_2', projectId: project.id, cycleId: 'cycle_1', requirementIds: ['REQ-DEMO'], status: 'claimed', attemptCount: 1 },
      project,
      cycle: { id: 'cycle_1', projectId: project.id, cycleNumber: 1, objective: 'Build Demo', status: 'verifying' }
    });
    repositoryMock.getProjectRoadmap
      .mockResolvedValueOnce({ projectId: project.id, cycles: [], steps: [], evidence: [], capabilities: [capability] })
      .mockResolvedValueOnce({ projectId: project.id, cycles: [], steps: [], evidence: [], capabilities: [capability] });
    runReleaseAuditMock.mockResolvedValueOnce({
      verdict: 'partial', summary: 'Export was omitted.', criteria: [], briefCoverage: [],
      contractAmendments: [newRequirement], gapWorkItems: [gapWorkItem]
    });
    repositoryMock.appendProjectImplementationSteps.mockResolvedValueOnce([{ id: 'step_export' }]);

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toMatchObject({ status: 'release_gaps_scheduled', gapStepCount: 1 });
    expect(repositoryMock.appendProjectImplementationSteps).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project_1',
      cycleId: 'cycle_1',
      newRequirements: [newRequirement],
      steps: [expect.objectContaining({ requirementIds: ['REQ-EXPORT'] })]
    }));
  });
});
