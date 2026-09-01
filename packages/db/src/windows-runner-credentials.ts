import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export const WINDOWS_RUNNER_SCOPE = 'windows_runner:device_operations' as const;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export interface WindowsRunnerPrincipal { credentialId: string; deviceId: string; scope: typeof WINDOWS_RUNNER_SCOPE }

/** Credential persistence boundary; callers never receive or store plaintext credentials. */
export class WindowsRunnerCredentialAdapter {
  constructor(private readonly prisma: PrismaClient) {}

  async createEnrollment(deviceId: string, expiresAt: Date): Promise<{ enrollmentId: string; code: string; expiresAt: string }> {
    const code = token();
    const enrollmentId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO "worker_enrollments" ("id", "device_id", "code_hash", "expires_at") VALUES (${enrollmentId}, ${deviceId}, ${hash(code)}, ${expiresAt})`;
      await this.writeAudit(tx, 'user', 'windows_runner_enrollment_created', { deviceId, enrollmentId, expiresAt: expiresAt.toISOString() });
    });
    return { enrollmentId, code, expiresAt: expiresAt.toISOString() };
  }

  async redeemEnrollment(code: string): Promise<{ deviceId: string; credential: string }> {
    const credential = token();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ deviceId: string }>>`
        UPDATE "worker_enrollments" SET "used_at" = CURRENT_TIMESTAMP
        WHERE "code_hash" = ${hash(code)} AND "used_at" IS NULL AND "expires_at" > CURRENT_TIMESTAMP
        RETURNING "device_id" AS "deviceId"`;
      if (rows.length !== 1) throw new Error('Enrollment code is invalid, expired, or already used.');
      const deviceId = rows[0]!.deviceId;
      await tx.$executeRaw`INSERT INTO "worker_credentials" ("id", "device_id", "token_hash", "scope") VALUES (${randomUUID()}, ${deviceId}, ${hash(credential)}, ${WINDOWS_RUNNER_SCOPE})`;
      await this.writeAudit(tx, 'worker', 'windows_runner_enrolled', { deviceId, scope: WINDOWS_RUNNER_SCOPE }, deviceId);
      return { deviceId, credential };
    });
  }

  async authenticate(credential: string): Promise<WindowsRunnerPrincipal | undefined> {
    const digest = hash(credential);
    const rows = await this.prisma.$queryRaw<Array<{ credentialId: string; deviceId: string; tokenHash: string; scope: string }>>`
      SELECT "id" AS "credentialId", "device_id" AS "deviceId", "token_hash" AS "tokenHash", "scope"
      FROM "worker_credentials" WHERE "token_hash" = ${digest} AND "revoked_at" IS NULL`;
    const row = rows[0];
    if (!row || row.scope !== WINDOWS_RUNNER_SCOPE || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(digest))) return undefined;
    return { credentialId: row.credentialId, deviceId: row.deviceId, scope: WINDOWS_RUNNER_SCOPE };
  }

  async rotate(deviceId: string): Promise<string> {
    const credential = token();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "worker_credentials" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "device_id" = ${deviceId} AND "revoked_at" IS NULL`;
      await tx.$executeRaw`INSERT INTO "worker_credentials" ("id", "device_id", "token_hash", "scope") VALUES (${randomUUID()}, ${deviceId}, ${hash(credential)}, ${WINDOWS_RUNNER_SCOPE})`;
      await this.writeAudit(tx, 'user', 'windows_runner_credential_rotated', { deviceId });
    });
    return credential;
  }

  async revoke(deviceId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`UPDATE "worker_credentials" SET "revoked_at" = CURRENT_TIMESTAMP WHERE "device_id" = ${deviceId} AND "revoked_at" IS NULL`;
      await tx.workerDevice.updateMany({ where: { id: deviceId }, data: { status: 'revoked' } });
      const revoked = changed > 0;
      await this.writeAudit(tx, 'user', 'windows_runner_credential_revoked', { deviceId, revoked });
      return revoked;
    });
  }

  private async writeAudit(
    tx: Pick<Prisma.TransactionClient, 'auditLog'>,
    actorType: 'user' | 'worker',
    eventType: string,
    payload: Prisma.InputJsonValue,
    actorId?: string
  ): Promise<void> {
    await tx.auditLog.create({ data: { actorType, actorId, eventType, payload } });
  }
}
