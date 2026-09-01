import { describe, expect, it, vi } from 'vitest';
import { WINDOWS_RUNNER_SCOPE, WindowsRunnerCredentialAdapter } from './windows-runner-credentials.js';

function transactionalPrisma(tx: Record<string, unknown>) {
  return { $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)) } as any;
}

describe('WindowsRunnerCredentialAdapter', () => {
  it('redeems a one-time code, creates its credential, and audits in one transaction', async () => {
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ deviceId: 'device_1' }]),
      $executeRaw: vi.fn(async () => 1),
      auditLog: { create: vi.fn(async () => undefined) }
    };
    const prisma = transactionalPrisma(tx);
    const result = await new WindowsRunnerCredentialAdapter(prisma).redeemEnrollment('enrollment-code');
    expect(result.deviceId).toBe('device_1');
    expect(result.credential).toHaveLength(43);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      actorType: 'worker', actorId: 'device_1', eventType: 'windows_runner_enrolled',
      payload: { deviceId: 'device_1', scope: WINDOWS_RUNNER_SCOPE }
    }) });
  });

  it('rejects an expired or reused enrollment without creating credentials or audit events', async () => {
    const tx: any = {
      $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(), auditLog: { create: vi.fn() }
    };
    const adapter = new WindowsRunnerCredentialAdapter(transactionalPrisma(tx));
    await expect(adapter.redeemEnrollment('expired-code')).rejects.toThrow('invalid, expired, or already used');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rolls back enrollment consumption when credential insertion fails', async () => {
    const insertionFailure = new Error('credential insert failed');
    const tx: any = {
      $queryRaw: vi.fn(async () => [{ deviceId: 'device_1' }]),
      $executeRaw: vi.fn(async () => { throw insertionFailure; }),
      auditLog: { create: vi.fn() }
    };
    const prisma: any = {
      $transaction: vi.fn(async (work: (client: unknown) => unknown) => {
        try { return await work(tx); } catch (error) { throw error; }
      })
    };
    await expect(new WindowsRunnerCredentialAdapter(prisma).redeemEnrollment('one-time-code')).rejects.toBe(insertionFailure);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('fails the security mutation transaction when its audit event cannot persist', async () => {
    const auditFailure = new Error('audit unavailable');
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      auditLog: { create: vi.fn(async () => { throw auditFailure; }) }
    };
    const prisma = transactionalPrisma(tx);
    await expect(new WindowsRunnerCredentialAdapter(prisma).createEnrollment('device_1', new Date('2099-01-01T00:00:00Z'))).rejects.toBe(auditFailure);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('atomically audits rotation and revocation and rejects revoked credentials', async () => {
    const tx: any = {
      $executeRaw: vi.fn(async () => 1),
      auditLog: { create: vi.fn(async () => undefined) },
      workerDevice: { updateMany: vi.fn(async () => ({ count: 1 })) }
    };
    const prisma: any = transactionalPrisma(tx);
    prisma.$queryRaw = vi.fn(async () => []);
    const adapter = new WindowsRunnerCredentialAdapter(prisma);
    expect(await adapter.rotate('device_1')).toHaveLength(43);
    expect(await adapter.revoke('device_1')).toBe(true);
    expect(await adapter.authenticate('revoked-token')).toBeUndefined();
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'windows_runner_credential_rotated' }) });
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'windows_runner_credential_revoked' }) });
  });
});
