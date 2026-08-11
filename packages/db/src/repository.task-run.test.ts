import { describe, expect, it, vi } from 'vitest';
import { ForgeMindRepository, mergeProjectArchitecture } from './repository.js';

function createMockPrisma() {
  let queuePaused = false;
  const taskRunCreate = vi.fn(async () => ({
    id: 'run_1',
    taskId: 'task_1',
    provider: 'codex',
    model: 'queued',
    status: 'queued',
    iterationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    startedAt: null,
    finishedAt: null,
    summary: null,
    errorMessage: null
  }));
  const taskRunFindFirst = vi.fn(async () => null);
  const taskQueueJobFindFirst = vi.fn(async () => ({
    id: 'queue_1',
    taskId: 'task_1',
    status: 'pending',
    reason: 'task_started',
    attemptCount: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    errorMessage: null,
    createdAt: new Date(),
    claimedAt: null,
    finishedAt: null
  }));
  const taskQueueJobFindUnique = vi.fn(async () => ({
    id: 'queue_1',
    taskId: 'task_1',
    status: 'claimed',
    attemptCount: 1,
    reason: 'task_started',
    nextAttemptAt: new Date(Date.now() - 1000),
    errorMessage: null,
    createdAt: new Date(),
    claimedAt: new Date(),
    finishedAt: null
  }));

  const prisma: any = {
    user: {
      upsert: vi.fn(async () => ({
        id: 'user_local_owner',
        email: 'owner@forgemind.local',
        name: 'Local Owner',
        role: 'owner'
      }))
    },
    project: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    task: {
      findUnique: vi.fn(async () => ({
        id: 'task_1',
        projectId: 'project_1',
        createdByUserId: 'user_local_owner',
        title: 'Task',
        prompt: 'Prompt',
        mode: 'safe',
        status: 'draft',
        githubIssueNumber: null,
        githubIssueUrl: null,
        branchName: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        finishedAt: null
      })),
      update: vi.fn(async (_args: unknown) => ({
        id: 'task_1',
        projectId: 'project_1',
        createdByUserId: 'user_local_owner',
        title: 'Task',
        prompt: 'Prompt',
        mode: 'safe',
        status: 'submitted',
        githubIssueNumber: null,
        githubIssueUrl: null,
        branchName: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        project: {
          id: 'project_1',
          name: 'Demo',
          slug: 'demo',
          githubOwner: 'demo',
          githubRepo: 'repo',
          defaultBranch: 'main',
          configYaml: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({
        id: 'task_1',
        projectId: 'project_1',
        createdByUserId: 'user_local_owner',
        title: 'Task',
        prompt: 'Prompt',
        mode: 'safe',
        status: 'submitted',
        githubIssueNumber: null,
        githubIssueUrl: null,
        branchName: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        maxIterations: 10,
        maxBudgetUsd: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: new Date(),
        finishedAt: null,
        project: {
          id: 'project_1',
          name: 'Demo',
          slug: 'demo',
          githubOwner: 'demo',
          githubRepo: 'repo',
          defaultBranch: 'main',
          configYaml: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        taskRuns: []
      })),
      create: vi.fn(),
      findMany: vi.fn(async () => [])
    },
    taskRun: {
      create: taskRunCreate,
      findFirst: taskRunFindFirst,
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async (_args: unknown) => ({
        id: 'run_1',
        taskId: 'task_1',
        provider: 'codex',
        model: 'queued',
        status: 'running',
        iterationCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        startedAt: new Date(),
        finishedAt: null,
        summary: null,
        errorMessage: null
      }))
    },
    taskQueueJob: {
      findFirst: taskQueueJobFindFirst,
      findMany: vi.fn(async () => [{ id: 'queue_1', taskId: 'task_1' }]),
      update: vi.fn(async (_args: unknown) => ({
        id: 'queue_1',
        taskId: 'task_1',
        status: 'claimed',
        reason: 'task_started',
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() - 1000),
        errorMessage: null,
        createdAt: new Date(),
        claimedAt: new Date(),
        finishedAt: null
      })),
      findUnique: taskQueueJobFindUnique,
      create: vi.fn(),
      count: vi.fn(async () => 1),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    taskIteration: { create: vi.fn(), findMany: vi.fn() },
    taskCheckpoint: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async (args: any) => ({
        id: 'checkpoint_1',
        taskId: args.create.taskId,
        taskRunId: args.create.taskRunId ?? null,
        key: args.create.key,
        phase: args.create.phase,
        status: args.create.status,
        inputHash: args.create.inputHash,
        outputJson: args.create.outputJson ?? null,
        errorMessage: args.create.errorMessage ?? null,
        startedAt: args.create.startedAt,
        completedAt: args.create.completedAt,
        updatedAt: new Date()
      }))
    },
    approval: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    providerUsage: { create: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: 'audit_1', createdAt: new Date() })), findMany: vi.fn() },
    notificationSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    notificationSubscription: { findMany: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), delete: vi.fn(), count: vi.fn() },
    $queryRawUnsafe: vi.fn(async (query: string, ...parameters: unknown[]) => {
      if (query.includes('INSERT INTO "worker_control"')) {
        queuePaused = parameters[1] === true;
      }
      if (query.includes('"worker_control"')) {
        return [{
          queuePaused,
          pausedAt: queuePaused ? new Date() : null,
          updatedAt: new Date()
        }];
      }
      return [];
    }),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    $disconnect: vi.fn()
  };

  return {
    prisma,
    taskRunCreate,
    taskRunFindFirst,
    taskQueueJobFindFirst,
    taskQueueJobFindUnique
  };
}

describe('ForgeMindRepository task runs', () => {
  it('merges architecture deltas without duplicates and resolves recorded debt', () => {
    const architecture = mergeProjectArchitecture({
      version: 1,
      summary: 'Initial architecture.',
      modules: [{ name: 'API', responsibility: 'HTTP API.', paths: ['src/api/**'], publicInterfaces: ['Api'], dependencies: [] }],
      decisions: [],
      conventions: ['Use typed routes.'],
      dependencyRules: ['API depends on domain interfaces only.'],
      knownDebt: ['Remove legacy route.'],
      validationCommands: ['npm test'],
      updatedAt: '2026-08-01T00:00:00.000Z'
    }, {
      summary: 'Layered API architecture.',
      modules: [{ name: 'API', responsibility: 'Typed HTTP boundary.', paths: ['src/api/**'], publicInterfaces: ['Api'], dependencies: ['Domain'] }],
      decisions: [{ summary: 'Introduce domain boundary', rationale: 'Prevent persistence details from leaking into routes.' }],
      conventions: ['Use typed routes.'],
      dependencyRules: ['API depends on domain interfaces only.'],
      resolvedDebt: ['Remove legacy route.'],
      validationCommands: ['npm test', 'npm run architecture:check']
    }, 'task_1', '2026-08-09T00:00:00.000Z');

    expect(architecture.modules).toHaveLength(1);
    expect(architecture.modules[0]).toMatchObject({ responsibility: 'Typed HTTP boundary.', dependencies: ['Domain'] });
    expect(architecture.knownDebt).toEqual([]);
    expect(architecture.conventions).toEqual(['Use typed routes.']);
    expect(architecture.decisions[0]).toMatchObject({ taskId: 'task_1', createdAt: '2026-08-09T00:00:00.000Z' });
    expect(architecture.validationCommands).toEqual(['npm test', 'npm run architecture:check']);
  });

  it('persists a reusable project planning session with an audit event', async () => {
    const { prisma } = createMockPrisma();
    prisma.project.findUnique.mockResolvedValueOnce({
      planningSessionId: null,
      planningSessionProvider: null,
      planningSessionModel: null,
      planningSessionConnectionId: null
    });
    const repository = new ForgeMindRepository(prisma);

    await repository.updateProjectPlanningSession({
      projectId: 'project_1',
      sessionId: 'thread_1',
      provider: 'codex',
      model: 'gpt-5.5',
      connectionId: 'connection_1'
    });

    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project_1' },
      data: {
        planningSessionId: 'thread_1',
        planningSessionProvider: 'codex',
        planningSessionModel: 'gpt-5.5',
        planningSessionConnectionId: 'connection_1',
        planningSessionUpdatedAt: expect.any(Date)
      }
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'project_planning_session_updated',
        projectId: 'project_1'
      })
    });
  });

  it('queues a task run when a task starts', async () => {
    const { prisma, taskRunCreate } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.startTask('task_1');

    expect(taskRunCreate).toHaveBeenCalledWith({
      data: {
        taskId: 'task_1',
        provider: 'codex',
        model: 'queued',
        status: 'queued'
      }
    });
  });

  it('reuses a queued task run when the worker claims the task', async () => {
    const { prisma } = createMockPrisma();
    prisma.task.findUnique = vi.fn(async () => ({
      id: 'task_1',
      projectId: 'project_1',
      createdByUserId: 'user_local_owner',
      title: 'Task',
      prompt: 'Prompt',
      mode: 'safe',
      status: 'submitted',
      githubIssueNumber: null,
      githubIssueUrl: null,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      maxIterations: 10,
      maxBudgetUsd: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      project: {
        id: 'project_1',
        name: 'Demo',
        slug: 'demo',
        githubOwner: 'demo',
        githubRepo: 'repo',
        defaultBranch: 'main',
        configYaml: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      taskRuns: [
        {
          id: 'run_1',
          taskId: 'task_1',
          provider: 'codex',
          model: 'queued',
          status: 'queued',
          iterationCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          startedAt: null,
          finishedAt: null,
          summary: null,
          errorMessage: null
        }
      ]
    }));
    const repository = new ForgeMindRepository(prisma);

    const claimed = await repository.claimNextSubmittedTask('codex', 'codex');

    expect(claimed?.task.id).toBe('task_1');
    expect(claimed?.taskRun.status).toBe('running');
    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptCount: { increment: 1 }
        })
      })
    );
  });

  it('does not claim another task while the persistent queue control is paused', async () => {
    const { prisma, taskQueueJobFindFirst } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    const paused = await repository.setWorkerQueuePaused(true);
    taskQueueJobFindFirst.mockClear();
    const claimed = await repository.claimNextSubmittedTask('codex', 'codex');
    const resumed = await repository.setWorkerQueuePaused(false);

    expect(paused.queuePaused).toBe(true);
    expect(claimed).toBeUndefined();
    expect(taskQueueJobFindFirst).not.toHaveBeenCalled();
    expect(resumed.queuePaused).toBe(false);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock(742764962030481)::text')
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'worker_queue_paused' })
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'worker_queue_resumed' })
    }));
  });

  it('recovers stuck claimed queue jobs back to pending', async () => {
    const { prisma, taskQueueJobFindUnique } = createMockPrisma();
    taskQueueJobFindUnique.mockResolvedValueOnce({
      id: 'queue_1',
      taskId: 'task_1',
      status: 'claimed',
      claimedAt: new Date(Date.now() - 10 * 60_000)
    } as any);
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1',
      projectId: 'project_1',
      status: 'running_ai'
    });
    const repository = new ForgeMindRepository(prisma);

    const result = await repository.recoverStuckQueueJobs(5);

    expect(result.recoveredCount).toBe(1);
    expect(result.queueJobIds).toEqual(['queue_1']);
    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: 'task_1',
        status: 'running'
      },
      data: {
        status: 'failed',
        finishedAt: expect.any(Date),
        errorMessage: 'Worker execution was interrupted and will resume from the existing workspace.'
      }
    });
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task_1' },
      data: {
        status: 'submitted',
        finishedAt: null
      }
    });
    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith({
      where: { id: 'queue_1' },
      data: expect.objectContaining({
        status: 'pending',
        reason: 'worker_interrupted',
        claimedAt: null,
        nextAttemptAt: expect.any(Date)
      })
    });
  });

  it('refreshes the queue claim used as the worker heartbeat', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await expect(repository.refreshQueueJobClaim('queue_1')).resolves.toBe(true);

    expect(prisma.taskQueueJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'queue_1',
        status: 'claimed'
      },
      data: {
        claimedAt: expect.any(Date)
      }
    });
  });

  it('requeues an orphaned active task without a live queue claim', async () => {
    const { prisma } = createMockPrisma();
    prisma.taskQueueJob.findMany.mockResolvedValueOnce([]);
    prisma.task.findMany.mockResolvedValueOnce([
      {
        id: 'task_1',
        projectId: 'project_1'
      }
    ]);
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1',
      projectId: 'project_1',
      status: 'running_ai'
    });
    prisma.taskQueueJob.count.mockResolvedValueOnce(0);
    prisma.taskQueueJob.create.mockResolvedValueOnce({ id: 'queue_recovered' });
    const repository = new ForgeMindRepository(prisma);

    const result = await repository.recoverStuckQueueJobs(2);

    expect(result).toEqual({
      recoveredCount: 1,
      queueJobIds: ['queue_recovered']
    });
    expect(prisma.taskQueueJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 'task_1',
        reason: 'worker_interrupted',
        status: 'pending',
        nextAttemptAt: expect.any(Date)
      }),
      select: {
        id: true
      }
    });
  });

  it('requeues an active task when the worker receives a shutdown signal', async () => {
    const { prisma } = createMockPrisma();
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1',
      projectId: 'project_1',
      status: 'running_ai'
    });
    const repository = new ForgeMindRepository(prisma);

    await expect(repository.interruptClaimedTask({
      queueJobId: 'queue_1',
      taskId: 'task_1',
      taskRunId: 'run_1',
      signal: 'SIGTERM'
    })).resolves.toBe(true);

    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run_1',
        taskId: 'task_1',
        status: 'running'
      },
      data: {
        status: 'failed',
        finishedAt: expect.any(Date),
        errorMessage: 'Worker received SIGTERM; execution will resume from the existing workspace.'
      }
    });
    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith({
      where: { id: 'queue_1' },
      data: expect.objectContaining({
        status: 'pending',
        reason: 'worker_interrupted',
        claimedAt: null
      })
    });
  });

  it('cancels pending and claimed queue jobs when task is cancelled', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.cancelTask('task_1');

    expect(prisma.taskQueueJob.updateMany).toHaveBeenCalledWith({
      where: {
        taskId: 'task_1',
        status: { in: ['pending', 'claimed'] }
      },
      data: {
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        finishedAt: expect.any(Date)
      }
    });
  });

  it('finalizes queue job only when it is still active', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.finalizeQueueJob('queue_1', 'succeeded');

    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith({
      where: {
        id: 'queue_1'
      },
      data: {
        status: 'succeeded',
        claimedAt: null,
        nextAttemptAt: null,
        errorMessage: undefined,
        finishedAt: expect.any(Date)
      }
    });
  });

  it('requeues a failed queue job with backoff while retries remain', async () => {
    const { prisma, taskQueueJobFindUnique } = createMockPrisma();
    taskQueueJobFindUnique.mockResolvedValueOnce({
      id: 'queue_1',
      taskId: 'task_1',
      status: 'claimed',
      attemptCount: 1
    } as any);
    const repository = new ForgeMindRepository(prisma);

    await repository.finalizeQueueJob('queue_1', 'failed', 'temporary error');

    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith({
      where: { id: 'queue_1' },
      data: expect.objectContaining({
        status: 'pending',
        reason: 'phase_retry',
        claimedAt: null,
        errorMessage: 'temporary error',
        nextAttemptAt: expect.any(Date)
      })
    });
    expect(prisma.task.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'task_1',
        status: { notIn: ['completed', 'cancelled'] }
      },
      data: {
        status: 'submitted',
        finishedAt: null
      }
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'task_queue_retry_scheduled',
        taskId: 'task_1',
        payload: expect.objectContaining({ resumeFromCheckpoint: true })
      })
    });
  });

  it('marks a queue job as failed after max retry attempts', async () => {
    const { prisma, taskQueueJobFindUnique } = createMockPrisma();
    taskQueueJobFindUnique.mockResolvedValueOnce({
      id: 'queue_1',
      status: 'claimed',
      attemptCount: 3
    } as any);
    const repository = new ForgeMindRepository(prisma);

    await repository.finalizeQueueJob('queue_1', 'failed', 'permanent error');

    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith({
      where: { id: 'queue_1' },
      data: {
        status: 'failed',
        claimedAt: null,
        nextAttemptAt: null,
        errorMessage: 'permanent error',
        finishedAt: expect.any(Date)
      }
    });
  });

  it('reports the latest run diff snapshot instead of summing cumulative phase snapshots', async () => {
    const { prisma } = createMockPrisma();
    prisma.taskIteration.findMany.mockResolvedValueOnce([
      createIterationFixture('run_1', 1, 'implementation', { filesChanged: 4, insertions: 100, deletions: 10 }),
      createIterationFixture('run_1', 2, 'validation', { filesChanged: 4, insertions: 100, deletions: 10 }),
      createIterationFixture('run_2', 1, 'planning', { filesChanged: 0, insertions: 0, deletions: 0 }),
      createIterationFixture('run_2', 2, 'validation', { filesChanged: 6, insertions: 140, deletions: 12 })
    ] as any);
    const repository = new ForgeMindRepository(prisma);

    const diff = await repository.getTaskDiff('task_1');

    expect(diff).toEqual(expect.objectContaining({
      filesChanged: 6,
      insertions: 140,
      deletions: 12
    }));
  });

  it('upserts a durable task checkpoint with a stable task and operation key', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    const checkpoint = await repository.recordTaskCheckpoint({
      taskId: 'task_1',
      taskRunId: 'run_1',
      key: 'external:merge_pr',
      phase: 'github',
      status: 'completed',
      inputHash: 'input-sha',
      output: { pullRequestNumber: 42 }
    });

    expect(prisma.taskCheckpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId_key: { taskId: 'task_1', key: 'external:merge_pr' } },
      update: expect.objectContaining({ status: 'completed', inputHash: 'input-sha' })
    }));
    expect(checkpoint).toEqual(expect.objectContaining({
      taskId: 'task_1',
      key: 'external:merge_pr',
      status: 'completed',
      inputHash: 'input-sha'
    }));
  });
});

function createIterationFixture(
  taskRunId: string,
  iterationNumber: number,
  phase: 'planning' | 'implementation' | 'validation' | 'review',
  diffStatJson: { filesChanged: number; insertions: number; deletions: number }
) {
  return {
    id: `${taskRunId}-${iterationNumber}`,
    taskRunId,
    iterationNumber,
    phase,
    prompt: phase,
    resultSummary: phase,
    providerPrompt: null,
    providerResponse: null,
    diffStatJson,
    validationResultJson: {},
    createdAt: new Date(`2026-07-28T00:00:0${iterationNumber}.000Z`)
  };
}
