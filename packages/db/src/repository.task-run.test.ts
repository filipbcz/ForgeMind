import { describe, expect, it, vi } from 'vitest';
import { ForgeMindRepository, mergeProjectArchitecture, sameProjectContractSemantics } from './repository.js';

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
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0)
    },
    taskRun: {
      create: taskRunCreate,
      findMany: vi.fn(async () => []),
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
    projectAuditJob: {
      count: vi.fn(async () => 0)
    },
    projectImplementationStep: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    acceptanceEvidence: {
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
    approval: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    providerUsage: { create: vi.fn(), findMany: vi.fn(async () => []) },
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
  it('compares regenerated contract semantics independently from source metadata', () => {
    const contract = {
      version: 2,
      summary: 'Project',
      invariants: ['Keep completed work.'],
      prohibitedSubstitutes: [],
      requirements: [{
        id: 'REQ-CORE', title: 'Core', description: 'Core remains implemented.',
        acceptanceCriteria: ['Core tests pass.'], status: 'active' as const,
        introducedInVersion: 1, lastChangedInVersion: 1
      }],
      releaseCriteria: ['Build passes.'],
      sourceBriefHash: 'old', sourceBriefSnapshot: 'Old brief'
    };

    expect(sameProjectContractSemantics(contract, {
      ...contract, sourceBriefHash: 'new', sourceBriefSnapshot: 'New brief'
    })).toBe(true);
    expect(sameProjectContractSemantics(contract, {
      ...contract, requirements: []
    })).toBe(false);
  });

  it('keeps the task list stable when older tasks receive later status updates', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.listTasks();

    expect(prisma.task.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' }
    });
  });

  it('sanitizes PostgreSQL-incompatible null bytes in task iteration evidence', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.createIteration({
      taskRunId: 'run_1',
      iterationNumber: 1,
      phase: 'review',
      prompt: 'review\u0000prompt',
      resultSummary: 'review\u0000summary',
      providerPrompt: 'provider\u0000prompt',
      providerResponse: 'provider\u0000response',
      diffStat: { filesChanged: 1, path: 'Binaries/CoreSim\u0000Headless' },
      validationResult: { evidence: ['state\u0000sequence'] }
    });

    expect(prisma.taskIteration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prompt: 'review\\u0000prompt',
        resultSummary: 'review\\u0000summary',
        providerPrompt: 'provider\\u0000prompt',
        providerResponse: 'provider\\u0000response',
        diffStatJson: { filesChanged: 1, path: 'Binaries/CoreSim\\u0000Headless' },
        validationResultJson: { evidence: ['state\\u0000sequence'] }
      })
    });
  });

  it('redacts provider output before persisting task iteration evidence', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.createIteration({
      taskRunId: 'run_1',
      iterationNumber: 1,
      phase: 'implementation',
      prompt: 'Implement the task',
      resultSummary: 'Provider summary copied CODEX_API_KEY=sk-summary_1234567890abcdef',
      providerPrompt: 'Use OPENAI_API_KEY=sk-prompt_1234567890abcdef',
      providerResponse: 'Saved token github_pat_1234567890abcdefghijklmnopqr in output',
      diffStat: { filesChanged: 1 },
      validationResult: { stderr: 'Authorization: Bearer sk-validation_1234567890abcdef' }
    });

    const persisted = prisma.taskIteration.create.mock.calls[0][0].data;
    expect(JSON.stringify(persisted)).toContain('[secret-redacted]');
    expect(JSON.stringify(persisted)).not.toContain('sk-summary_1234567890abcdef');
    expect(JSON.stringify(persisted)).not.toContain('sk-prompt_1234567890abcdef');
    expect(JSON.stringify(persisted)).not.toContain('github_pat_1234567890abcdefghijklmnopqr');
    expect(JSON.stringify(persisted)).not.toContain('sk-validation_1234567890abcdef');
  });

  it('redacts audit payloads before persistence', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.writeAudit({
      actorType: 'system',
      eventType: 'task_provider_activity',
      taskId: 'task_1',
      payload: {
        message: 'Provider printed Authorization: Bearer sk-audit_1234567890abcdef',
        apiKey: 'sk-object_1234567890abcdef'
      }
    });

    const persisted = prisma.auditLog.create.mock.calls[0][0].data.payload;
    expect(JSON.stringify(persisted)).toContain('[secret-redacted]');
    expect(JSON.stringify(persisted)).not.toContain('sk-audit_1234567890abcdef');
    expect(JSON.stringify(persisted)).not.toContain('sk-object_1234567890abcdef');
  });

  it('reads provider runtime status without a bounded global audit window', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);
    prisma.auditLog.findMany.mockResolvedValueOnce([
      {
        id: 'audit_success',
        actorType: 'system',
        actorId: null,
        eventType: 'provider_request_succeeded',
        projectId: null,
        taskId: 'task_1',
        payload: {
          operation: 'implement',
          provider: 'codex',
          connectionId: 'conn_1',
          model: 'gpt-5.5',
          circuitBreaker: {
            state: 'closed',
            failureCount: 0,
            failureThreshold: 3
          }
        },
        createdAt: new Date('2026-08-26T12:00:00.000Z')
      }
    ]);

    const statuses = await repository.listProviderConnectionRuntimeStatuses();

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        eventType: { in: ['provider_request_succeeded', 'provider_circuit_breaker_state'] }
      },
      orderBy: { createdAt: 'desc' }
    });
    expect(statuses).toEqual([
      expect.objectContaining({
        provider: 'codex',
        connectionId: 'conn_1',
        model: 'gpt-5.5',
        lastSuccessfulRequestAt: '2026-08-26T12:00:00.000Z',
        lastSuccessfulOperation: 'implement'
      })
    ]);
  });

  it('exports correlated diagnostics without representative secrets', async () => {
    const { prisma } = createMockPrisma();
    const createdAt = new Date('2026-08-25T10:00:00.000Z');
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1',
      projectId: 'project_1',
      createdByUserId: 'user_local_owner',
      title: 'Waiting task',
      prompt: 'Investigate the waiting validation',
      mode: 'safe',
      status: 'waiting_for_capability',
      waitingForCapabilities: ['windows'],
      deferredValidationCapabilities: [],
      githubIssueNumber: 42,
      githubIssueUrl: 'https://github.com/demo/repo/issues/42',
      branchName: 'ai/task-1',
      architectureVersionId: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      providerSessionId: null,
      providerSessionProvider: null,
      providerSessionModel: null,
      providerSessionConnectionId: null,
      providerSessionUpdatedAt: null,
      maxIterations: 10,
      maxBudgetUsd: 2,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      finishedAt: null
    });
    prisma.taskRun.findMany.mockResolvedValueOnce([{
      id: 'run_0',
      taskId: 'task_1',
      provider: 'codex',
      model: 'codex-latest',
      status: 'failed',
      iterationCount: 1,
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      usageSource: 'actual_total',
      estimatedCostUsd: 0.01,
      actualCostUsd: null,
      startedAt: new Date('2026-08-25T09:00:00.000Z'),
      finishedAt: new Date('2026-08-25T09:05:00.000Z'),
      summary: null,
      errorMessage: 'Superseded run',
      runStateJson: { version: 1, status: 'failed', reason: 'unknown' }
    }, {
      id: 'run_1',
      taskId: 'task_1',
      provider: 'codex',
      model: 'codex-latest',
      status: 'running',
      iterationCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      usageSource: 'actual_total',
      estimatedCostUsd: 0.01,
      actualCostUsd: null,
      startedAt: createdAt,
      finishedAt: null,
      summary: 'Waiting for capability',
      errorMessage: null,
      runStateJson: { version: 1, status: 'waiting', reason: 'unavailable_capability', requiredCapabilities: ['windows'] }
    }]);
    prisma.taskQueueJob.findMany.mockResolvedValueOnce([{
      id: 'queue_1',
      taskId: 'task_1',
      status: 'pending',
      reason: 'task_started',
      attemptCount: 2,
      nextAttemptAt: createdAt,
      errorMessage: 'retry with GITHUB_TOKEN=ghp_1234567890abcdefghijklmnop',
      createdAt,
      claimedAt: null,
      finishedAt: null
    }]);
    prisma.providerUsage.findMany.mockResolvedValueOnce([{
      id: 'usage_1',
      taskId: 'task_1',
      taskRunId: 'run_1',
      provider: 'codex',
      model: 'codex-latest',
      phase: 'implementation',
      attempt: 1,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
      usageSource: 'actual_total',
      credits: 0,
      estimatedCostUsd: 0.01,
      actualCostUsd: null,
      createdAt
    }]);
    prisma.auditLog.findMany.mockResolvedValueOnce([{
      id: 'audit_1',
      actorType: 'agent',
      actorId: null,
      eventType: 'task_provider_activity',
      projectId: 'project_1',
      taskId: 'task_1',
      payload: {
        taskRunId: 'run_1',
        providerUsageId: 'usage_1',
        message: 'Provider returned Authorization: Bearer sk-diagnostic_1234567890abcdef'
      },
      createdAt
    }, {
      id: 'audit_2',
      actorType: 'system',
      actorId: null,
      eventType: 'task_github_issue_created',
      projectId: 'project_1',
      taskId: 'task_1',
      payload: { issueUrl: 'https://github.com/demo/repo/issues/42' },
      createdAt
    }]);
    const repository = new ForgeMindRepository(prisma);

    const diagnostics = await repository.exportTaskDiagnostics('task_1');

    expect(diagnostics).toEqual(expect.objectContaining({
      version: 1,
      correlation: expect.objectContaining({
        task: 'task:task_1',
        run: 'task:task_1:run:run_1',
        queue: 'task:task_1:queue:queue_1',
        provider: 'task:task_1:run:run_1:provider:usage_1',
        github: 'task:task_1:github'
      }),
      waitingOrBlockedState: expect.objectContaining({
        status: 'waiting',
        reason: 'unavailable_capability',
        requiredCapabilities: ['windows']
      })
    }));
    expect(diagnostics?.runs.map((run) => [run.id, run.correlationId])).toEqual([
      ['run_0', 'task:task_1:run:run_0'],
      ['run_1', 'task:task_1:run:run_1']
    ]);
    expect(diagnostics?.auditEvents[0]?.correlation).toEqual(expect.objectContaining({
      task: 'task:task_1',
      run: 'task:task_1:run:run_1',
      provider: 'task:task_1:run:run_1:provider:usage_1'
    }));
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).toContain('[secret-redacted]');
    expect(serialized).not.toContain('sk-diagnostic_1234567890abcdef');
    expect(serialized).not.toContain('ghp_1234567890abcdefghijklmnop');
  });

  it('redacts queue and task failure errors before persistence', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.finalizeQueueJob('queue_1', 'failed', 'Queue failed with GITHUB_TOKEN=ghp_1234567890abcdefghijklmnop', false);
    await repository.failTask('task_1', 'Provider failed with sk-failure_1234567890abcdef', 'provider_failed');

    expect(JSON.stringify(prisma.taskQueueJob.update.mock.calls[0][0])).not.toContain('ghp_1234567890abcdefghijklmnop');
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('sk-failure_1234567890abcdef');
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).toContain('[secret-redacted]');
  });

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
      data: expect.objectContaining({
        taskId: 'task_1',
        provider: 'codex',
        model: 'queued',
        status: 'queued'
      })
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
      data: expect.objectContaining({
        status: 'failed',
        finishedAt: expect.any(Date),
        errorMessage: 'Worker execution was interrupted and will resume from the existing workspace.'
      })
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
      data: expect.objectContaining({
        status: 'failed',
        finishedAt: expect.any(Date),
        errorMessage: 'Worker received SIGTERM; execution will resume from the existing workspace.'
      })
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
      data: expect.objectContaining({
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        finishedAt: expect.any(Date)
      })
    });
    expect(prisma.taskRun.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: 'running' },
      data: expect.objectContaining({
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        finishedAt: expect.any(Date)
      })
    });
    expect(prisma.projectImplementationStep.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: 'running' },
      data: { status: 'cancelled', completedAt: null }
    });
  });

  it('closes a running roadmap step when validation terminally fails', async () => {
    const { prisma } = createMockPrisma();
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1', projectId: 'project_1', createdByUserId: 'user_local_owner', title: 'Task', prompt: 'Prompt',
      mode: 'safe', status: 'validating', maxIterations: 10, maxBudgetUsd: 2,
      createdAt: new Date(), updatedAt: new Date(), startedAt: new Date(), finishedAt: null
    });
    const repository = new ForgeMindRepository(prisma);

    await repository.transitionTask('task_1', 'validation_failed', { validation: { exitCode: 1 } });

    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task_1' },
      data: expect.objectContaining({
        status: 'validation_failed',
        finishedAt: expect.any(Date)
      })
    });
    expect(prisma.projectImplementationStep.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: 'running' },
      data: { status: 'cancelled', completedAt: null }
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'project_implementation_step_status_updated',
        taskId: 'task_1',
        payload: { status: 'cancelled', reason: 'task_validation_failed' }
      })
    });
  });

  it('closes a running roadmap step when worker execution fails', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    await repository.failTask('task_1', 'Provider crashed.', 'provider_failed');

    expect(prisma.projectImplementationStep.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: 'running' },
      data: { status: 'cancelled', completedAt: null }
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'project_implementation_step_status_updated',
        taskId: 'task_1',
        payload: { status: 'cancelled', reason: 'task_provider_failed' }
      })
    });
  });

  it('reconciles inconsistent roadmap steps only from linked terminal task states', async () => {
    const { prisma } = createMockPrisma();
    const finishedAt = new Date('2026-08-31T05:00:00.000Z');
    prisma.project.findUnique.mockResolvedValueOnce({ id: 'project_1' });
    prisma.projectImplementationStep.findMany = vi.fn(async () => [{
      id: 'step_completed', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 1,
      status: 'running', task: { id: 'task_completed', status: 'completed', finishedAt }
    }, {
      id: 'step_failed', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 2,
      status: 'running', task: { id: 'task_failed', status: 'validation_failed', finishedAt }
    }, {
      id: 'step_active', projectId: 'project_1', cycleId: 'cycle_1', sequenceNumber: 3,
      status: 'running', task: { id: 'task_active', status: 'reviewing', finishedAt: null }
    }]);
    prisma.projectImplementationStep.update = vi.fn(async () => ({}));
    const repository = new ForgeMindRepository(prisma);

    const result = await repository.reconcileProjectImplementationSteps('project_1');

    expect(result).toEqual({
      projectId: 'project_1', examinedSteps: 3,
      updatedSteps: [{
        stepId: 'step_completed', taskId: 'task_completed', taskStatus: 'completed',
        previousStatus: 'running', status: 'completed'
      }, {
        stepId: 'step_failed', taskId: 'task_failed', taskStatus: 'validation_failed',
        previousStatus: 'running', status: 'cancelled'
      }]
    });
    expect(prisma.projectImplementationStep.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'step_completed' }, data: { status: 'completed', completedAt: finishedAt }
    });
    expect(prisma.projectImplementationStep.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'step_failed' }, data: { status: 'cancelled', completedAt: null }
    });
  });

  it('reopens a completed roadmap step when its task is retried', async () => {
    const { prisma } = createMockPrisma();
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1', projectId: 'project_1', createdByUserId: 'user_local_owner', title: 'Task', prompt: 'Prompt',
      mode: 'safe', status: 'completed', githubIssueNumber: 1, githubIssueUrl: 'https://github.com/demo/repo/issues/1',
      branchName: 'ai/1-task', pullRequestNumber: 1, pullRequestUrl: 'https://github.com/demo/repo/pull/1',
      maxIterations: 10, maxBudgetUsd: 2, createdAt: new Date(), updatedAt: new Date(), startedAt: new Date(), finishedAt: new Date()
    });
    const repository = new ForgeMindRepository(prisma);

    await repository.retryTask('task_1', true);

    expect(prisma.projectImplementationStep.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: { in: ['completed', 'waiting_for_capability', 'cancelled'] } },
      data: { status: 'running', completedAt: null }
    });
  });

  it('reopens a cancelled roadmap step when its failed task is retried', async () => {
    const { prisma } = createMockPrisma();
    prisma.task.findUnique.mockResolvedValueOnce({
      id: 'task_1', projectId: 'project_1', createdByUserId: 'user_local_owner', title: 'Task', prompt: 'Prompt',
      mode: 'safe', status: 'validation_failed', maxIterations: 10, maxBudgetUsd: 2,
      createdAt: new Date(), updatedAt: new Date(), startedAt: new Date(), finishedAt: new Date()
    });
    const repository = new ForgeMindRepository(prisma);

    await repository.retryTask('task_1', true);

    expect(prisma.projectImplementationStep.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: { in: ['completed', 'waiting_for_capability', 'cancelled'] } },
      data: { status: 'running', completedAt: null }
    });
  });

  it('atomically completes a legacy Windows capability wait and defers its evidence', async () => {
    const { prisma } = createMockPrisma();
    const waitingTask = {
      id: 'task_1', projectId: 'project_1', createdByUserId: 'user_local_owner', title: 'Task', prompt: 'Prompt',
      mode: 'safe', status: 'waiting_for_capability', waitingForCapabilities: ['windows'],
      githubIssueNumber: 1, githubIssueUrl: 'https://github.com/demo/repo/issues/1', branchName: 'ai/1-task',
      pullRequestNumber: 1, pullRequestUrl: 'https://github.com/demo/repo/pull/1', maxIterations: 10, maxBudgetUsd: 2,
      createdAt: new Date(), updatedAt: new Date(), startedAt: new Date(), finishedAt: new Date()
    };
    prisma.task.findUnique.mockResolvedValueOnce(waitingTask);
    prisma.task.update.mockResolvedValueOnce({
      ...waitingTask,
      status: 'completed',
      waitingForCapabilities: [],
      deferredValidationCapabilities: ['windows']
    });
    const repository = new ForgeMindRepository(prisma);

    const completed = await repository.completeTaskWithDeferredValidation('task_1');

    expect(completed?.status).toBe('completed');
    expect(completed?.waitingForCapabilities).toEqual([]);
    expect(completed?.deferredValidationCapabilities).toEqual(['windows']);
    expect(prisma.projectImplementationStep.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', status: 'waiting_for_capability' },
      data: { status: 'completed', completedAt: expect.any(Date) }
    });
    expect(prisma.acceptanceEvidence.updateMany).toHaveBeenCalledWith({
      where: { taskId: 'task_1', source: 'validation_command', status: 'blocked' },
      data: { status: 'deferred' }
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

  it('atomically consumes an approved risk approval once', async () => {
    const { prisma } = createMockPrisma();
    prisma.approval.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const repository = new ForgeMindRepository(prisma);

    await expect(repository.consumeRiskApproval('approval_1')).resolves.toBe(true);
    await expect(repository.consumeRiskApproval('approval_1')).resolves.toBe(false);

    expect(prisma.approval.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'approval_1',
        status: 'approved'
      },
      data: {
        status: 'cancelled',
        resolvedAt: expect.any(Date)
      }
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorType: 'system',
        eventType: 'approval_consumed',
        payload: { approvalId: 'approval_1' }
      })
    }));
  });

  it('maps persisted capability waits to the shared unavailable capability run state', async () => {
    const { prisma } = createMockPrisma();
    prisma.taskRun.findMany.mockResolvedValueOnce([{
      id: 'run_1',
      taskId: 'task_1',
      provider: 'codex',
      model: 'codex',
      status: 'succeeded',
      iterationCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: 'estimated',
      estimatedCostUsd: 0,
      actualCostUsd: null,
      startedAt: new Date('2026-08-25T00:00:00.000Z'),
      finishedAt: new Date('2026-08-25T00:01:00.000Z'),
      summary: 'Source delivery completed.',
      errorMessage: null
    }]);
    prisma.task.findUnique.mockResolvedValueOnce({
      status: 'waiting_for_capability',
      waitingForCapabilities: ['windows']
    });
    const repository = new ForgeMindRepository(prisma);

    const usage = await repository.getTaskUsage('task_1');

    expect(usage.runs[0]?.state).toEqual(expect.objectContaining({
      status: 'waiting',
      reason: 'unavailable_capability',
      requiredCapabilities: ['windows']
    }));
  });

  it('returns persisted waiting and blocked reasons for historical task runs', async () => {
    const { prisma } = createMockPrisma();
    const waitingReasons = ['inactive_worker', 'paused_queue', 'unavailable_capability', 'approval_required', 'retry_backoff'] as const;
    const blockedReasons = [
      'validation_failed',
      'provider_failed',
      'approval_rejected',
      'budget_exceeded',
      'iteration_limit_reached',
      'repeated_error_detected',
      'worker_limit',
      'manual_review_required',
      'unknown'
    ] as const;
    prisma.taskRun.findMany.mockResolvedValueOnce([
      ...waitingReasons.map((reason, index) => ({
        id: `waiting_${reason}`,
        taskId: 'task_1',
        provider: 'codex',
        model: 'codex',
        status: 'succeeded',
        runStateJson: { version: 1, status: 'waiting', reason, requiredCapabilities: reason === 'unavailable_capability' ? ['windows'] : [] },
        iterationCount: index,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        usageSource: 'estimated',
        estimatedCostUsd: 0,
        actualCostUsd: null,
        startedAt: new Date(`2026-08-25T00:0${index}:00.000Z`),
        finishedAt: new Date(`2026-08-25T00:0${index}:30.000Z`),
        summary: null,
        errorMessage: null
      })),
      ...blockedReasons.map((reason, index) => ({
        id: `blocked_${reason}`,
        taskId: 'task_1',
        provider: 'codex',
        model: 'codex',
        status: 'failed',
        runStateJson: { version: 1, status: 'blocked', reason },
        iterationCount: index,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        usageSource: 'estimated',
        estimatedCostUsd: 0,
        actualCostUsd: null,
        startedAt: new Date(`2026-08-25T01:0${index}:00.000Z`),
        finishedAt: new Date(`2026-08-25T01:0${index}:30.000Z`),
        summary: null,
        errorMessage: null
      })),
      {
        id: 'latest_completed',
        taskId: 'task_1',
        provider: 'codex',
        model: 'codex',
        status: 'succeeded',
        runStateJson: { version: 1, status: 'succeeded' },
        iterationCount: 99,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        usageSource: 'estimated',
        estimatedCostUsd: 0,
        actualCostUsd: null,
        startedAt: new Date('2026-08-25T02:00:00.000Z'),
        finishedAt: new Date('2026-08-25T02:00:30.000Z'),
        summary: null,
        errorMessage: null
      }
    ]);
    const repository = new ForgeMindRepository(prisma);

    const usage = await repository.getTaskUsage('task_1');

    for (const reason of waitingReasons) {
      expect(usage.runs.find((run) => run.id === `waiting_${reason}`)?.state).toEqual(expect.objectContaining({
        status: 'waiting',
        reason
      }));
    }
    for (const reason of blockedReasons) {
      expect(usage.runs.find((run) => run.id === `blocked_${reason}`)?.state).toEqual(expect.objectContaining({
        status: 'blocked',
        reason
      }));
    }
  });

  it('exposes paused queue and inactive worker as distinct shared run states', async () => {
    const { prisma } = createMockPrisma();
    const repository = new ForgeMindRepository(prisma);

    const paused = await repository.setWorkerQueuePaused(true);
    const pausedStatus = await repository.getWorkerStatus();
    await repository.setWorkerQueuePaused(false);
    const inactiveStatus = await repository.getWorkerStatus();

    expect(paused.queuePaused).toBe(true);
    expect(pausedStatus.runState).toEqual(expect.objectContaining({ status: 'waiting', reason: 'paused_queue' }));
    expect(inactiveStatus.runState).toEqual(expect.objectContaining({ status: 'waiting', reason: 'inactive_worker' }));
  });
});

describe('chat API mutation delegation', () => {
  it('uses the chat mode and exact approved mutation binding', async () => {
    const findUnique = vi.fn();
    const repository = new ForgeMindRepository({ chatRun: { findUnique } } as never);
    const input = {
      runId: 'run_1', userId: 'user_1', type: 'config_change' as const,
      method: 'PUT', path: '/api/worker/queue', bodyHash: 'body_hash'
    };

    findUnique.mockResolvedValueOnce({
      status: 'running', thread: { userId: 'user_1', mode: 'full_auto' }, approvals: []
    });
    await expect(repository.isChatApiMutationAuthorized(input)).resolves.toBe(true);

    findUnique.mockResolvedValueOnce({
      status: 'running', thread: { userId: 'user_1', mode: 'safe' }, approvals: []
    });
    await expect(repository.isChatApiMutationAuthorized(input)).resolves.toBe(false);

    findUnique.mockResolvedValueOnce({
      status: 'running', thread: { userId: 'user_1', mode: 'safe' }, approvals: [{
        type: 'config_change', status: 'approved', payloadJson: {
          apiMutation: { method: 'PUT', path: '/api/worker/queue', actorId: 'user_1', bodyHash: 'body_hash' }
        }
      }]
    });
    await expect(repository.isChatApiMutationAuthorized(input)).resolves.toBe(true);
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
