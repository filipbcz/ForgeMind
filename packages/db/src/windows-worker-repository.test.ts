import { describe, expect, it, vi } from 'vitest';
import { WindowsWorkerRepository } from './windows-worker-repository.js';

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
      windowsExecutionJob: { update: vi.fn(async () => undefined) },
      workerDevice: { update: vi.fn(async () => undefined) }
    };
    const prisma: any = { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) };
    const claim = await new WindowsWorkerRepository(prisma).claimCompatible('session_1', 60, 'request_1');
    expect(claim?.job.id).toBe('job_1');
    expect(tx.windowsExecutionLease.create).toHaveBeenCalledTimes(1);
    expect(tx.windowsExecutionJob.update).toHaveBeenCalledWith({ where: { id: 'job_1' }, data: { status: 'leased' } });
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
