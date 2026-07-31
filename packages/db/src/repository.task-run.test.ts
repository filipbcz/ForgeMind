import { describe, expect, it, vi } from 'vitest';
import { ForgeMindRepository } from './repository.js';

function createMockPrisma() {
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
      findMany: vi.fn()
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
    approval: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    providerUsage: { create: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: 'audit_1', createdAt: new Date() })), findMany: vi.fn() },
    notificationSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    notificationSubscription: { findMany: vi.fn(), upsert: vi.fn(), findFirst: vi.fn(), delete: vi.fn(), count: vi.fn() },
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

  it('recovers stuck claimed queue jobs back to pending', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    const result = await repository.recoverStuckQueueJobs(5);

    expect(result.recoveredCount).toBe(1);
    expect(result.queueJobIds).toEqual(['queue_1']);
    expect(prisma.taskQueueJob.updateMany).toHaveBeenCalled();
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
      status: 'claimed',
      attemptCount: 1
    } as any);
    const repository = new ForgeMindRepository(prisma);

    await repository.finalizeQueueJob('queue_1', 'failed', 'temporary error');

    expect(prisma.taskQueueJob.update).toHaveBeenCalledWith({
      where: { id: 'queue_1' },
      data: expect.objectContaining({
        status: 'pending',
        claimedAt: null,
        errorMessage: 'temporary error',
        nextAttemptAt: expect.any(Date)
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
