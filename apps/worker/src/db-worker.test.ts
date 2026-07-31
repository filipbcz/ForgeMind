import { beforeEach, describe, expect, it, vi } from 'vitest';

const createProviderMock = vi.fn();
const runWorkerTaskMock = vi.fn();
const advanceRoadmapAfterTaskCompletionMock = vi.fn(async () => ({ advanced: false }));

const repositoryMock = {
  recoverStuckQueueJobs: vi.fn(async () => ({ recoveredCount: 0, queueJobIds: [] })),
  getGitHubConnectionSecret: vi.fn(async () => undefined),
  claimNextSubmittedTask: vi.fn(async (): Promise<unknown> => ({
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
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    taskRun: {
      id: 'run_1'
    },
    queueJobId: 'queue_1'
  })),
  recordProviderUsage: vi.fn(async () => undefined),
  transitionTask: vi.fn(async () => undefined),
  createApproval: vi.fn(async () => ({ id: 'approval_1' })),
  createIteration: vi.fn(async () => undefined),
  listApprovals: vi.fn(
    async (): Promise<Array<Record<string, unknown> & { taskId: string; type: string; status: string; payload: Record<string, unknown> }>> => []
  ),
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
  failTask: vi.fn(async () => undefined),
  finishTaskRun: vi.fn(async () => undefined),
  finalizeQueueJob: vi.fn(async () => undefined),
  writeAudit: vi.fn(async () => ({ id: 'audit_1' }))
};

vi.mock('@forgemind/db', () => ({
  advanceRoadmapAfterTaskCompletion: advanceRoadmapAfterTaskCompletionMock,
  createRepository: vi.fn(() => repositoryMock),
  getPrismaClient: vi.fn(() => ({}))
}));

vi.mock('@forgemind/github', () => ({
  GitHubAppAdapter: vi.fn(function GitHubAppAdapter() {
    return {};
  }),
  createGitHubAdapterFromEnv: vi.fn(async () => ({}))
}));

vi.mock('@forgemind/providers', () => ({
  createProvider: createProviderMock
}));

vi.mock('./workflow.js', () => ({
  runWorkerTask: runWorkerTaskMock
}));

describe('db-worker policy enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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

  it('persists structured audit event when workflow reports GitHub operation failure', async () => {
    const { runDatabaseWorkerOnce } = await import('./db-worker.js');

    await expect(runDatabaseWorkerOnce()).rejects.toThrow('500: Internal Server Error');

    expect(repositoryMock.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        eventType: 'task_github_operation_failed',
        taskId: 'task_1',
        payload: expect.objectContaining({
          taskRunId: 'run_1',
          queueJobId: 'queue_1',
          operation: 'create_pr',
          errorMessage: expect.stringContaining('500: Internal Server Error')
        })
      })
    );
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
    expect(createProviderMock).toHaveBeenCalledWith('openai');
    expect(createProviderMock).toHaveBeenCalledWith('codex');
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

  it('persists actual provider usage per phase and finishes the run with measured totals', async () => {
    runWorkerTaskMock.mockImplementationOnce(async (input: {
      hooks?: {
        onProviderActivity?: (activity: Record<string, unknown>) => Promise<void>;
      };
    }) => {
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

    expect(repositoryMock.recordProviderUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      model: 'gpt-5.5',
      phase: 'review',
      attempt: 2,
      totalTokens: 124947,
      usageSource: 'actual_total',
      estimatedCostUsd: 0
    }));
    expect(repositoryMock.finishTaskRun).toHaveBeenCalledWith(expect.objectContaining({
      totalTokens: 124947,
      usageSource: 'actual_total',
      actualCostUsd: null
    }));
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

  it('stops with budget_exceeded before running workflow when estimate is over budget', async () => {
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

    const { runDatabaseWorkerOnce } = await import('./db-worker.js');
    const result = await runDatabaseWorkerOnce();

    expect(result).toEqual(
      expect.objectContaining({
        claimed: true,
        taskId: 'task_1',
        status: 'budget_exceeded'
      })
    );
    expect(runWorkerTaskMock).not.toHaveBeenCalled();
    expect(repositoryMock.failTask).toHaveBeenCalledWith('task_1', 'Budget limit exceeded before provider run.', 'budget_exceeded');
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
      const iteration = {
        phase: 'validation' as const,
        prompt: 'npm test',
        resultSummary: 'Validation failed',
        diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        validationResult: {
          passed: false,
          exitCode: 1,
          stderr: 'TypeError: same failure',
          stdout: ''
        }
      };

      await input.hooks?.onIteration?.(iteration);
      await input.hooks?.onIteration?.(iteration);
      await input.hooks?.onIteration?.(iteration);

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

  it('stops with iteration_limit_reached when max iterations are exhausted', async () => {
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
        status: 'iteration_limit_reached'
      })
    );
    expect(repositoryMock.failTask).toHaveBeenCalledWith('task_2', expect.stringContaining('iteration_limit_reached'), 'iteration_limit_reached');
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
});
