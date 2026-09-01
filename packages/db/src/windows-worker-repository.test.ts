import { describe, expect, it, vi } from 'vitest';
import { WindowsWorkerRepository } from './windows-worker-repository.js';

const packetDigest = 'a'.repeat(64);
const queuedPacket = {
  schemaVersion: 1, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'check_1', jobId: 'job_1', leaseId: 'pending',
  repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git', commitSha: packetDigest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
  check: { command: 'npm test', category: 'smoke', requiredCapabilities: ['windows'] }, requiredCapabilities: ['windows'],
  resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 }, expectedArtifacts: [], nonce: 'pending', inputHash: packetDigest
  , executionAdapter: { kind: 'fixture', profileId: 'fixture-validation-v1' }
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
  it('enqueues Unreal work only with a separately approved record scoped to the exact packet', async () => {
    const unrealPacket = { ...queuedPacket, executionAdapter: { kind: 'unreal' as const, profile: { kind: 'unreal-validation' as const,
      profileId: 'resave-packages', tool: 'unreal-editor-cmd' as const } }, unrealApprovalId: 'approval_1', requiredCapabilities: ['windows', 'unreal-engine-5.8'],
      check: { ...queuedPacket.check, requiredCapabilities: ['windows', 'unreal-engine-5.8'] } };
    const approval = { id: 'approval_1', approvedByUserId: 'owner_1', resolvedAt: new Date(), payloadJson: {
      operation: 'windows_unreal_validation', jobId: 'job_1', checkId: 'check_1', commitSha: packetDigest, inputHash: packetDigest
    } };
    const tx: any = { approval: { findFirst: vi.fn(async () => approval) }, auditLog: { create: vi.fn() }, windowsExecutionJob: { create: vi.fn() } };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    await expect(new WindowsWorkerRepository(prisma).enqueue({ id: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1',
      requiredCapabilities: [...unrealPacket.requiredCapabilities].reverse(), packet: unrealPacket as any })).resolves.toBe('job_1');
    expect(tx.approval.findFirst).toHaveBeenCalledWith({ where: { id: 'approval_1', taskId: 'task_1', status: 'approved' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'windows_unreal_approval_verified',
      payload: expect.objectContaining({ approvalId: 'approval_1', commitSha: packetDigest, inputHash: packetDigest }) }) });

    tx.approval.findFirst.mockResolvedValue({ ...approval, payloadJson: { ...approval.payloadJson, commitSha: 'b'.repeat(64) } });
    await expect(new WindowsWorkerRepository(prisma).enqueue({ id: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1',
      requiredCapabilities: unrealPacket.requiredCapabilities, packet: unrealPacket as any })).rejects.toThrow('separate approved record');
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
      probeEvidence: [{ capability: { key: 'windows' }, status: 'supported' }], lastHeartbeatAt: new Date(heartbeat),
      sessions: [{ id: `${id}-session`, deviceId: id, status: sessionStatus, startedAt: now, expiresAt: new Date(now.getTime() + 60_000), lastHeartbeatAt: new Date(heartbeat), endedAt: null }]
    });
    const devices = [device('eligible', 'idle', '2026-09-01T11:59:50.000Z', 'active'), device('stale', 'idle', '2026-09-01T11:00:00.000Z', 'active'),
      device('closed', 'idle', '2026-09-01T11:59:50.000Z', 'closed'), device('revoked', 'revoked', '2026-09-01T11:59:50.000Z', 'active')];
    const prisma: any = { workerDevice: { findMany: vi.fn(async () => devices) }, windowsExecutionJob: { findMany: vi.fn(async () => [{
      id: 'job_1', taskId: 'task_1', status: 'queued', requiredCapabilities: ['windows'], packet: queuedPacket
    }]) } };
    const readModel = await new WindowsWorkerRepository(prisma).readOperations(undefined, now);
    expect(readModel.devices.find(({ id }) => id === 'stale')?.status).toBe('offline');
    expect(readModel.devices.find(({ id }) => id === 'revoked')?.status).toBe('revoked');
    expect(readModel.waitingValidations[0]?.compatibleDeviceIds).toEqual(['eligible']);
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
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn().mockResolvedValueOnce([{ device_id: 'device_1' }]).mockResolvedValueOnce([{ job_id: 'job_1' }]),
      windowsExecutionLease: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(leaseRow), create: vi.fn(async () => undefined)
      },
      windowsExecutionJob: { findUniqueOrThrow: vi.fn(async () => ({ packet: queuedPacket })), update: vi.fn(async () => undefined) },
      workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const claim = await new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'request_1');
    expect(claim?.job.id).toBe('job_1');
    expect(tx.windowsExecutionLease.create).toHaveBeenCalledTimes(1);
    expect(tx.windowsExecutionJob.update).toHaveBeenCalledWith({
      where: { id: 'job_1' }, data: { status: 'leased', packet: { ...queuedPacket, leaseId: expect.any(String), nonce: 'request_1' } }
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
      schemaVersion: 1, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'check_1',
      jobId: 'job_1', leaseId: 'lease_1', repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git',
      commitSha: digest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
      check: { command: 'npm test', category: 'smoke', requiredCapabilities: ['windows'] },
      requiredCapabilities: ['windows'], resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 },
      expectedArtifacts: [], nonce: 'nonce_1', inputHash: digest, executionAdapter: { kind: 'fixture', profileId: 'fixture-validation-v1' },
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
    expect(accepted).toBe(false);
    expect(tx.windowsExecutionJob.updateMany).not.toHaveBeenCalled();
    expect(tx.windowsExecutionLease.update).not.toHaveBeenCalled();
  });

  it('reconciles only the exact deferred check and queues one resume after a successful result', async () => {
    const digest = 'b'.repeat(64);
    const packet = {
      schemaVersion: 1, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'validation:windows',
      jobId: 'job_1', leaseId: 'lease_1', repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git',
      commitSha: digest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
      check: { command: 'fixture.exe --validate', category: 'smoke', requiredCapabilities: ['windows'] },
      requiredCapabilities: ['windows'], resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 },
      expectedArtifacts: [], nonce: 'nonce_1', inputHash: digest, executionAdapter: { kind: 'fixture', profileId: 'fixture-validation-v1' },
      evidenceUpload: { schemaVersion: 1, jobId: 'job_1', leaseId: 'lease_1', inputHash: digest, commitSha: digest,
        log: { text: 'fixture passed', sizeBytes: 14, sha256: digest }, artifacts: [] }
    };
    const checkpointUpdate = vi.fn(async () => ({ count: 1 }));
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ jobId: 'job_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1', packet }]),
      taskCheckpoint: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ status: 'completed', inputHash: digest, outputJson: { deferred: true, command: 'fixture.exe --validate', commitSha: 'c'.repeat(64) } })
          .mockResolvedValue({ status: 'completed', inputHash: digest, outputJson: { deferred: true, command: 'fixture.exe --validate', commitSha: digest } }),
        updateMany: checkpointUpdate
      },
      task: { findUnique: vi.fn(async () => ({ id: 'task_1', status: 'waiting_for_capability' })), update: vi.fn(async () => undefined) },
      taskRun: { findUnique: vi.fn(async () => ({ provider: 'codex', model: 'test' })), create: vi.fn(async () => undefined) },
      taskQueueJob: { count: vi.fn(async () => 0), create: vi.fn(async () => undefined) },
      projectImplementationStep: { updateMany: vi.fn(async () => ({ count: 1 })) },
      windowsExecutionJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
      windowsExecutionLease: { update: vi.fn(async () => undefined) }, workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const result = { schemaVersion: 1 as const, projectId: 'project_1', taskId: 'task_1', runId: 'run_1', checkId: 'validation:windows', jobId: 'job_1', leaseId: 'lease_1',
      deviceId: 'device_1', sessionId: 'session_1', nonce: 'nonce_1', inputHash: digest, commitSha: digest, observedCapabilities: [], toolVersions: [], status: 'succeeded' as const,
      startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:01:00.000Z', summary: 'fixture passed', logHash: digest, artifacts: [] };

    const repository = new WindowsWorkerRepository(prisma);
    expect(await repository.submitResult('device_1', result)).toBe(false);
    expect(tx.windowsExecutionJob.updateMany).not.toHaveBeenCalled();
    expect(await repository.submitResult('device_1', result)).toBe(true);
    expect(checkpointUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ taskId: 'task_1', key: 'validation:windows', inputHash: digest }) }));
    expect(tx.taskQueueJob.create).toHaveBeenCalledWith({ data: expect.objectContaining({ taskId: 'task_1', reason: 'windows_validation_completed' }) });
  });

  it.each([
    ['cancelSession', 'cancelled', 'cancelled'],
    ['closeSession', 'closed', 'released']
  ] as const)('reconciles leased and running jobs when %s terminates a session', async (method, sessionStatus, leaseStatus) => {
    const updateJobs = vi.fn(async () => ({ count: 1 }));
    const tx: any = {
      workerSession: { update: vi.fn(async () => ({ deviceId: 'device_1' })) },
      windowsExecutionLease: {
        findMany: vi.fn(async () => [{ jobId: 'job_1' }]), updateMany: vi.fn(async () => ({ count: 1 }))
      },
      windowsExecutionJob: { updateMany: updateJobs }, workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    await new WindowsWorkerRepository(prisma)[method]('session_1');
    expect(tx.workerSession.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: sessionStatus }) }));
    expect(tx.windowsExecutionLease.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: leaseStatus }) }));
    expect(updateJobs).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: expect.objectContaining({ status: 'leased' }), data: { status: 'queued' } }));
    expect(updateJobs).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ status: 'running' }), data: { status: 'expired' } }));
  });
});
