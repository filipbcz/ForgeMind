import { describe, expect, it, vi } from 'vitest';
import { WindowsWorkerRepository } from './windows-worker-repository.js';

const packetDigest = 'a'.repeat(64);
const queuedPacket = {
  schemaVersion: 2, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'check_1', jobId: 'job_1', leaseId: 'pending',
  repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git', commitSha: packetDigest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
  check: { command: 'npm test', category: 'smoke', requiredCapabilities: ['windows'] }, requiredCapabilities: ['windows'],
  dispatch: { kind: 'deferred', reason: 'unsupported_validation_intent', handling: 'manual-local' },
  resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 }, expectedArtifacts: [], nonce: 'pending', inputHash: packetDigest
};

const leaseRow = {
  id: 'lease_1', jobId: 'job_1', deviceId: 'device_1', sessionId: 'session_1', status: 'active',
  claimedAt: new Date('2026-08-31T12:00:00Z'), expiresAt: new Date('2099-08-31T12:01:00Z'), nonce: 'request_1',
  job: {
    id: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1', status: 'leased',
    requiredCapabilities: ['windows'], packet: {}, createdAt: new Date('2026-08-31T11:00:00Z'), updatedAt: new Date('2026-08-31T12:00:00Z')
  },
  session: { id: 'session_1', deviceId: 'device_1', status: 'active', expiresAt: new Date('2099-08-31T12:00:00Z') },
  device: {
    id: 'device_1', status: 'reserved', capabilities: [{ key: 'windows' }],
    probeEvidence: [{ capability: { key: 'windows' }, status: 'supported' }]
  }
};

describe('WindowsWorkerRepository capability leases', () => {
  it('persists a versioned authoring packet with its exact base identity', async () => {
    const packet = { kind: 'authoring', protocolVersion: 1, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', jobId: 'job_1', leaseId: 'pending',
      repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git', baseCommitSha: 'b'.repeat(40), workspaceRoot: 'runner-managed', artifactRoot: 'runner-managed',
      step: { prompt: 'Update map', acceptanceCriteria: ['Map is updated'] },
      operations: [{ id: 'op-1', kind: 'modify', path: 'Content/map.bin', rationale: 'Update map' }], requiredCapabilities: ['windows-authoring'],
      managedRoots: ['Content'], checkpoints: [{ id: 'cp-1', label: 'Saved', afterOperationIds: ['op-1'], artifactExpectationNames: ['map'] }],
      artifactExpectations: [{ name: 'map', relativePath: 'Content/map.bin', required: true, delivery: 'artifact-store', binary: true, maxBytes: 1024 }],
      resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 }, nonce: 'pending', inputHash: packetDigest,
      authority: { database: 'none', productionHosts: 'none', globalGitHubCredentials: 'none' } } as const;
    const create = vi.fn(async () => undefined); const prisma: any = { windowsExecutionJob: { create } };
    await expect(new WindowsWorkerRepository(prisma).enqueueAuthoring({ id: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1',
      requiredCapabilities: ['windows-authoring'], packet: packet as any })).resolves.toBe('job_1');
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ packet, requiredCapabilities: ['windows-authoring'] }) });
    await expect(new WindowsWorkerRepository(prisma).enqueueAuthoring({ id: 'other', projectId: 'project_1', taskId: 'task_1', runId: 'run_1',
      requiredCapabilities: ['windows-authoring'], packet: packet as any })).rejects.toThrow('identity');
  });

  it('enqueues an AI-proposed command without a runtime approval', async () => {
    const windowsPacket = { ...queuedPacket, requiredCapabilities: ['windows', 'unreal-engine-5.8'],
      check: { ...queuedPacket.check, requiredCapabilities: ['windows', 'unreal-engine-5.8'] } };
    const tx: any = { windowsExecutionJob: { create: vi.fn(async () => undefined) } };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    await expect(new WindowsWorkerRepository(prisma).enqueue({ id: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1',
      requiredCapabilities: [...windowsPacket.requiredCapabilities].reverse(), packet: windowsPacket as any })).resolves.toBe('job_1');
    expect(tx.windowsExecutionJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: 'job_1', requiredCapabilities: [...windowsPacket.requiredCapabilities].reverse(), packet: windowsPacket
    }) });
  });

  it('serializes concurrent evidence uploads so a conflicting upload cannot overwrite the first', async () => {
    const digest = 'a'.repeat(64); let packet: any = { ...queuedPacket, leaseId: 'lease_1' }; let release: (() => void) | undefined;
    let locked = false;
    const tx: any = {
      $queryRaw: vi.fn(async () => { if (locked) await new Promise<void>((resolve) => { release = resolve; }); locked = true; return [{ id: 'job_1' }]; }),
      windowsExecutionLease: { findFirst: vi.fn(async () => ({ job: { packet } })) },
      windowsExecutionJob: { update: vi.fn(async ({ data }: any) => { packet = data.packet; }) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => { try { return await work(tx); } finally { locked = false; release?.(); release = undefined; } }) };
    const upload = (text: string) => ({ schemaVersion: 1 as const, jobId: 'job_1', leaseId: 'lease_1', inputHash: digest, commitSha: digest,
      log: { text, sizeBytes: text.length, sha256: digest }, artifacts: [] });
    const repository = new WindowsWorkerRepository(prisma);
    expect(await Promise.all([repository.uploadEvidence('device_1', upload('first')), repository.uploadEvidence('device_1', upload('second'))]))
      .toEqual(['accepted', 'conflict']);
    expect((packet as any).evidenceUpload.log.text).toBe('first');
  });

  it('projects stale devices offline and only reports idle devices with a fresh active session as compatible', async () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const device = (id: string, status: 'idle' | 'revoked', heartbeat: string, sessionStatus: 'active' | 'closed') => ({
      id, platform: 'windows', runnerVersion: '1', displayName: id, status, capabilities: [{ key: 'windows' }],
      probeEvidence: [{ capability: { key: 'windows' }, status: 'supported', provenance: 'local-probe', probedAt: '2026-09-01T11:59:55.000Z' }], lastHeartbeatAt: new Date(heartbeat),
      sessions: [{ id: `${id}-session`, deviceId: id, status: sessionStatus, startedAt: now, expiresAt: new Date(now.getTime() + 60_000), lastHeartbeatAt: new Date(heartbeat), endedAt: null }]
    });
    const fixture = device('fixture', 'idle', '2026-09-01T11:59:50.000Z', 'active'); fixture.probeEvidence[0]!.provenance = 'fixture';
    const devices = [device('eligible', 'idle', '2026-09-01T11:59:50.000Z', 'active'), fixture, device('stale', 'idle', '2026-09-01T11:00:00.000Z', 'active'),
      device('closed', 'idle', '2026-09-01T11:59:50.000Z', 'closed'), device('revoked', 'revoked', '2026-09-01T11:59:50.000Z', 'active')];
    const prisma: any = { workerDevice: { findMany: vi.fn(async () => devices) }, windowsExecutionJob: { findMany: vi.fn(async () => [{
      id: 'job_1', taskId: 'task_1', status: 'queued', waitReason: 'unavailable_capability', pendingPhase: 'validate', requiredCapabilities: ['windows'], packet: queuedPacket
    }]) } };
    const readModel = await new WindowsWorkerRepository(prisma).readOperations(undefined, now);
    expect(readModel.devices.find(({ id }) => id === 'stale')?.status).toBe('offline');
    expect(readModel.devices.find(({ id }) => id === 'revoked')?.status).toBe('revoked');
    expect(readModel.waitingValidations[0]?.compatibleDeviceIds).toEqual(['eligible']);
    expect(readModel.waitingValidations[0]).toMatchObject({ waitReason: 'unavailable_capability', pendingPhase: 'validate' });
  });

  it('persists a recoverable capacity wait without leasing or changing the pending phase', async () => {
    const execute = vi.fn(async () => 1);
    const tx: any = {
      $executeRaw: execute,
      $queryRaw: vi.fn().mockResolvedValueOnce([{ device_id: 'device_1', authorized_project_ids: ['project_1'] }]).mockResolvedValueOnce([]),
      windowsExecutionLease: { findUnique: vi.fn(async () => null) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    await expect(new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'capacity-request')).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(String((execute.mock.calls as unknown[][])[1]?.[0])).toContain('wait_reason');
  });

  it('returns an existing active lease for an idempotent claim without reserving another job', async () => {
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      windowsExecutionLease: { findUnique: vi.fn(async () => leaseRow), create: vi.fn() },
      windowsExecutionJob: { update: vi.fn() }, workerDevice: { update: vi.fn() }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const claim = await new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'request_1');
    expect(claim?.lease.id).toBe('lease_1');
    expect(tx.windowsExecutionLease.create).not.toHaveBeenCalled();
  });

  it('atomically locks and reserves only the compatible job returned by the database query', async () => {
    const legacyPacket = { ...queuedPacket, schemaVersion: 1, dispatch: undefined };
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn().mockResolvedValueOnce([{ device_id: 'device_1' }]).mockResolvedValueOnce([{ job_id: 'job_1' }]),
      windowsExecutionLease: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(leaseRow), create: vi.fn(async () => undefined)
      },
      windowsExecutionJob: { findUniqueOrThrow: vi.fn(async () => ({ packet: legacyPacket })), update: vi.fn(async () => undefined) },
      workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const claim = await new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'request_1');
    expect(claim?.job.id).toBe('job_1');
    expect(tx.windowsExecutionLease.create).toHaveBeenCalledTimes(1);
    expect(tx.windowsExecutionJob.update).toHaveBeenCalledWith({
      where: { id: 'job_1' }, data: { status: 'leased', waitReason: null, packet: { ...queuedPacket, dispatch: { kind: 'deferred', reason: 'legacy_unsafe_packet', handling: 'manual-local' }, leaseId: expect.any(String), nonce: 'request_1' } }
    });
  });

  it('requeues leased work but expires running work during crash recovery', async () => {
    const updateJobs = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
    const tx: any = {
      workerSession: { updateMany: vi.fn(async () => ({ count: 1 })) },
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: 'session_1', deviceId: 'device_1' }])
        .mockResolvedValueOnce([{ id: 'lease_1', jobId: 'job_1', deviceId: 'device_1' }]),
      windowsExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
      windowsExecutionJob: { updateMany: updateJobs }, workerDevice: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const result = await new WindowsWorkerRepository(prisma).recoverExpired(new Date('2026-08-31T12:00:00Z'));
    expect(updateJobs).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ status: 'leased' }), data: { status: 'queued' } }));
    expect(updateJobs).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ status: 'running' }), data: { status: 'expired' } }));
    expect(result.jobs).toBe(2);
  });

  it('marks an idle device offline when its session expires without a lease', async () => {
    const updateDevices = vi.fn(async () => ({ count: 1 }));
    const tx: any = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ id: 'session_1', deviceId: 'device_1' }]).mockResolvedValueOnce([]),
      workerSession: { updateMany: vi.fn(async () => ({ count: 1 })) },
      windowsExecutionLease: { updateMany: vi.fn(async () => ({ count: 0 })) },
      windowsExecutionJob: { updateMany: vi.fn(async () => ({ count: 0 })) },
      workerDevice: { updateMany: updateDevices }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const result = await new WindowsWorkerRepository(prisma).recoverExpired(new Date('2026-08-31T12:00:00Z'));
    expect(result).toEqual({ sessions: 1, leases: 0, jobs: 0 });
    expect(updateDevices).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['device_1'] }, status: { in: expect.arrayContaining(['idle', 'draining']) } }),
      data: { status: 'offline' }
    }));
  });

  it('does not return another session lease when request ids collide', async () => {
    const tx: any = {
      $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []),
      windowsExecutionLease: { findUnique: vi.fn(async () => null) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    expect(await new WindowsWorkerRepository(prisma).claimCompatible('session_2', 60, 'request_1')).toBeUndefined();
    expect(tx.windowsExecutionLease.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId_nonce: { sessionId: 'session_2', nonce: 'request_1' } }
    }));
  });

  it('returns no claim for a terminal lease retry without inserting the nonce again', async () => {
    const terminalLease = { ...leaseRow, status: 'expired' };
    const tx: any = {
      $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(),
      windowsExecutionLease: { findUnique: vi.fn(async () => terminalLease), create: vi.fn() }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    expect(await new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'request_1')).toBeUndefined();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.windowsExecutionLease.create).not.toHaveBeenCalled();
  });

  it('returns an existing active lease after its session begins draining', async () => {
    const drainingLease = {
      ...leaseRow,
      session: { ...leaseRow.session, status: 'draining' },
      device: { ...leaseRow.device, status: 'draining' }
    };
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      windowsExecutionLease: { findUnique: vi.fn(async () => drainingLease), create: vi.fn() }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const claim = await new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'request_1');
    expect(claim?.lease.id).toBe('lease_1');
    expect(tx.windowsExecutionLease.create).not.toHaveBeenCalled();
  });

  it('rejects result evidence whose immutable identity differs from the persisted execution packet', async () => {
    const digest = 'a'.repeat(64);
    const packet = {
      schemaVersion: 2, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'check_1',
      jobId: 'job_1', leaseId: 'lease_1', repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git',
      commitSha: digest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
      check: { command: 'npm test', category: 'smoke', requiredCapabilities: ['windows'] },
      dispatch: { kind: 'deferred', reason: 'unsupported_validation_intent', handling: 'manual-local' },
      requiredCapabilities: ['windows'], resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 },
      expectedArtifacts: [], nonce: 'nonce_1', inputHash: digest,
      evidenceUpload: { schemaVersion: 1, jobId: 'job_1', leaseId: 'lease_1', inputHash: digest, commitSha: digest,
        log: { text: 'fixture passed', sizeBytes: 14, sha256: digest }, artifacts: [] }
    };
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ jobId: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1', packet }]),
      windowsExecutionJob: { updateMany: vi.fn() }, windowsExecutionLease: { update: vi.fn() }, workerDevice: { update: vi.fn() }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const accepted = await new WindowsWorkerRepository(prisma).submitResult('device_1', {
      schemaVersion: 1, projectId: 'project_attacker', taskId: 'task_1', runId: 'run_1', checkId: 'check_1',
      jobId: 'job_1', leaseId: 'lease_1', deviceId: 'device_1', sessionId: 'session_1', nonce: 'nonce_1',
      inputHash: digest, commitSha: digest, observedCapabilities: [], toolVersions: [], status: 'succeeded',
      startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', summary: 'done', logHash: digest, artifacts: []
    });
    expect(accepted).toEqual({ accepted: false });
    expect(tx.windowsExecutionJob.updateMany).not.toHaveBeenCalled();
    expect(tx.windowsExecutionLease.update).not.toHaveBeenCalled();
  });

  it('accepts only an authoring result matching every lease and base identity and persists its complete tree', async () => {
    const packet = { kind: 'authoring', protocolVersion: 1, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', jobId: 'job_1', leaseId: 'lease_1',
      repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git', baseCommitSha: 'b'.repeat(40), workspaceRoot: 'runner-managed', artifactRoot: 'runner-managed',
      step: { prompt: 'Update map', acceptanceCriteria: ['Map is updated'] },
      operations: [{ id: 'op-1', kind: 'modify', path: 'Content/map.bin', rationale: 'Update' }], requiredCapabilities: ['windows-authoring'], managedRoots: ['Content'],
      checkpoints: [{ id: 'cp-1', label: 'Saved', afterOperationIds: ['op-1'], artifactExpectationNames: [] }], artifactExpectations: [],
      resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 100, maxArtifactBytes: 100 }, nonce: 'nonce_1', inputHash: packetDigest,
      authority: { database: 'none', productionHosts: 'none', globalGitHubCredentials: 'none' } } as const;
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx: any = { $queryRaw: vi.fn(async () => [{ jobId: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1', packet }]),
      windowsExecutionJob: { updateMany }, windowsExecutionLease: { update: vi.fn(async () => undefined) }, workerDevice: { update: vi.fn(async () => undefined) } };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const result = { kind: 'authoring-result', protocolVersion: 1, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', jobId: 'job_1', leaseId: 'lease_1',
      deviceId: 'device_1', sessionId: 'session_1', nonce: 'nonce_1', inputHash: packetDigest, baseCommitSha: packet.baseCommitSha,
      resultTreeSha: 'c'.repeat(40), tree: [{ path: 'Content/map.bin', kind: 'file', sha256: 'd'.repeat(64), sizeBytes: 8, binary: true, mode: '100644' }], patch: 'diff --git',
      completedOperationIds: ['op-1'], checkpointIds: ['cp-1'], artifacts: [], processes: [], status: 'succeeded', startedAt: '2026-09-01T00:00:00Z', completedAt: '2026-09-01T00:01:00Z', summary: 'done' } as const;
    const repository = new WindowsWorkerRepository(prisma);
    expect(await repository.submitResult('device_1', result as any)).toEqual({ accepted: true, packet });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'succeeded', packet: { ...packet, authoringResult: result } } }));
    expect(await repository.submitResult('device_1', { ...result, protocolVersion: 2 } as any)).toEqual({ accepted: false });
    expect(await repository.submitResult('device_1', { ...result, baseCommitSha: 'e'.repeat(40) } as any)).toEqual({ accepted: false });
  });

  it('accepts the exact deferred check result without restarting the completed task', async () => {
    const digest = 'b'.repeat(64);
    const packet = {
      schemaVersion: 2, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'validation:windows',
      jobId: 'job_1', leaseId: 'lease_1', repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git',
      commitSha: digest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
      check: { command: 'fixture.exe --validate', category: 'smoke', requiredCapabilities: ['windows'] },
      dispatch: { kind: 'deferred', reason: 'unsupported_validation_intent', handling: 'manual-local' },
      requiredCapabilities: ['windows'], resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 },
      expectedArtifacts: [], nonce: 'nonce_1', inputHash: digest,
      evidenceUpload: { schemaVersion: 1, jobId: 'job_1', leaseId: 'lease_1', inputHash: digest, commitSha: digest,
        log: { text: 'fixture passed', sizeBytes: 14, sha256: digest }, artifacts: [] }
    };
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ jobId: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1', packet }]),
      windowsExecutionJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
      windowsExecutionLease: { update: vi.fn(async () => undefined) }, workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const result = { schemaVersion: 1 as const, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'validation:windows', jobId: 'job_1', leaseId: 'lease_1',
      deviceId: 'device_1', sessionId: 'session_1', nonce: 'nonce_1', inputHash: digest, commitSha: digest, observedCapabilities: [], toolVersions: [], status: 'deferred' as const, deferredReason: 'unsupported_validation_intent' as const,
      startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', summary: 'fixture passed', logHash: digest, artifacts: [] };

    const repository = new WindowsWorkerRepository(prisma);
    expect(await repository.submitResult('device_1', result)).toEqual({ accepted: true, packet });
    expect(tx.windowsExecutionJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: { in: ['leased', 'running'] } }, data: { status: 'failed' }
    });
  });

  it('keeps an active lease reconcilable when cancellation is requested', async () => {
    const tx: any = {
      workerSession: { update: vi.fn(async () => ({ deviceId: 'device_1' })) },
      windowsExecutionLease: { count: vi.fn(async () => 1) },
      workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    await new WindowsWorkerRepository(prisma).cancelSession('session_1');
    expect(tx.workerSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }));
    expect(tx.workerDevice.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'draining' } }));
  });

  it('reconciles leased and running jobs when closeSession terminates a session', async () => {
    const updateJobs = vi.fn(async () => ({ count: 1 }));
    const tx: any = {
      workerSession: { update: vi.fn(async () => ({ deviceId: 'device_1' })) },
      windowsExecutionLease: {
        findMany: vi.fn(async () => [{ jobId: 'job_1' }]), updateMany: vi.fn(async () => ({ count: 1 }))
      },
      windowsExecutionJob: { updateMany: updateJobs }, workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    await new WindowsWorkerRepository(prisma).closeSession('session_1');
    expect(tx.workerSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'closed' }) }));
    expect(tx.windowsExecutionLease.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'released' }) }));
    expect(updateJobs).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ status: 'leased' }), data: { status: 'queued' } }));
    expect(updateJobs).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ status: 'running' }), data: { status: 'expired' } }));
  });
});
