import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { isWindowsExecutionPacket } from '@forgemind/core';
import type {
  WorkerCapability, WorkerProbeEvidence, WindowsExecutionJob, WindowsExecutionLease,
  WindowsExecutionPacket, WindowsExecutionResult
} from '@forgemind/core';

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export interface RegisterWorkerDeviceInput {
  id: string;
  runnerVersion: string;
  displayName: string;
  capabilities: WorkerCapability[];
  probeEvidence: WorkerProbeEvidence[];
  metadata?: Prisma.InputJsonValue;
}

export interface EnqueueWindowsExecutionInput {
  id?: string;
  projectId: string;
  taskId: string;
  runId: string;
  requiredCapabilities: string[];
  packet: WindowsExecutionPacket;
}

export interface ClaimedWindowsExecution {
  job: WindowsExecutionJob;
  lease: WindowsExecutionLease;
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/** Persistence boundary for the manually activated Windows validation executor. */
export class WindowsWorkerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async registerDevice(input: RegisterWorkerDeviceInput): Promise<void> {
    await this.prisma.workerDevice.upsert({
      where: { id: input.id },
      create: {
        id: input.id, platform: 'windows', runnerVersion: input.runnerVersion, displayName: input.displayName,
        status: 'offline', capabilities: asJson(input.capabilities), probeEvidence: asJson(input.probeEvidence),
        metadata: input.metadata ?? {}
      },
      update: {
        runnerVersion: input.runnerVersion, displayName: input.displayName, capabilities: asJson(input.capabilities),
        probeEvidence: asJson(input.probeEvidence), metadata: input.metadata ?? {}
      }
    });
  }

  async startManualSession(deviceId: string, expiresAt: Date): Promise<string> {
    if (expiresAt.getTime() <= Date.now()) throw new Error('Worker session expiry must be in the future.');
    return this.prisma.$transaction(async (tx) => {
      const devices = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "worker_devices" WHERE "id" = ${deviceId} AND "status" <> 'revoked' FOR UPDATE`;
      if (devices.length !== 1) throw new Error('Worker device is missing or revoked.');
      const session = await tx.workerSession.create({ data: { deviceId, expiresAt } });
      await tx.workerDevice.update({ where: { id: deviceId }, data: { status: 'idle', lastHeartbeatAt: new Date() } });
      return session.id;
    });
  }

  async enqueue(input: EnqueueWindowsExecutionInput): Promise<string> {
    const id = input.id ?? randomUUID();
    await this.prisma.windowsExecutionJob.create({ data: {
      id, projectId: input.projectId, taskId: input.taskId, runId: input.runId,
      requiredCapabilities: asJson(input.requiredCapabilities), packet: asJson(input.packet)
    } });
    return id;
  }

  async claimCompatible(sessionId: string, leaseSeconds: number, requestId: string, deviceId?: string): Promise<ClaimedWindowsExecution | undefined> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error('Lease duration must be a positive integer.');
    return this.prisma.$transaction(async (tx) => {
      // Serialize only retries from this session; request ids are not global credentials.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${sessionId}:${requestId}`}, 0))`;
      const existing = await this.readClaimByNonce(tx, sessionId, requestId);
      if (existing !== undefined) return existing ?? undefined;

      // Lock the session/device before looking at jobs so competing claims cannot lock
      // different jobs and then deadlock or serialize-fail on the same device.
      const sessions = await tx.$queryRaw<Array<{ device_id: string }>>`
        SELECT s."device_id"
        FROM "worker_sessions" s
        JOIN "worker_devices" d ON d."id" = s."device_id"
        WHERE s."id" = ${sessionId} AND s."status" = 'active' AND s."expires_at" > CURRENT_TIMESTAMP
          AND d."status" = 'idle' AND (${deviceId ?? null}::text IS NULL OR d."id" = ${deviceId ?? null})
        FOR UPDATE OF s, d
      `;
      const session = sessions[0];
      if (!session) return undefined;
      const jobs = await tx.$queryRaw<Array<{ job_id: string }>>`
        SELECT candidate."id" AS job_id FROM "windows_execution_jobs" candidate
        JOIN "tasks" task ON task."id" = candidate."task_id" AND task."status" = 'waiting_for_capability'
        JOIN "task_runs" run ON run."id" = candidate."run_id" AND run."task_id" = task."id"
        JOIN "worker_devices" d ON d."id" = ${session.device_id}
        WHERE candidate."status" = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(candidate."required_capabilities") required(key)
            WHERE NOT (d."capabilities" @> jsonb_build_array(jsonb_build_object('key', required.key)))
               OR NOT (d."probe_evidence" @> jsonb_build_array(jsonb_build_object('capability', jsonb_build_object('key', required.key), 'status', 'supported')))
          )
        ORDER BY candidate."created_at", candidate."id"
        FOR UPDATE OF candidate SKIP LOCKED LIMIT 1
      `;
      const selected = jobs[0];
      if (!selected) return undefined;

      const leaseId = randomUUID();
      const expiresAt = new Date(Date.now() + leaseSeconds * 1_000);
      await tx.windowsExecutionLease.create({ data: {
        id: leaseId, jobId: selected.job_id, deviceId: session.device_id, sessionId,
        expiresAt, nonce: requestId
      } });
      await tx.windowsExecutionJob.update({ where: { id: selected.job_id }, data: { status: 'leased' } });
      await tx.workerDevice.update({ where: { id: session.device_id }, data: { status: 'reserved' } });
      const created = await this.readClaimByNonce(tx, sessionId, requestId);
      if (!created) throw new Error('New execution lease could not be read back.');
      return created;
    });
  }

  async heartbeat(sessionId: string, leaseId: string | undefined, leaseSeconds: number, deviceId?: string): Promise<boolean> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error('Lease duration must be a positive integer.');
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const sessions = await tx.$queryRaw<Array<{ id: string; device_id: string }>>`
        SELECT "id", "device_id" FROM "worker_sessions"
        WHERE "id" = ${sessionId} AND "status" IN ('active', 'draining') AND "expires_at" > ${now}
          AND (${deviceId ?? null}::text IS NULL OR "device_id" = ${deviceId ?? null})
        FOR UPDATE
      `;
      const session = sessions[0];
      if (!session) return false;
      await tx.workerSession.update({ where: { id: sessionId }, data: { lastHeartbeatAt: now } });
      if (leaseId) {
        await tx.$queryRaw`SELECT "id" FROM "windows_execution_leases" WHERE "id" = ${leaseId} FOR UPDATE`;
        const renewed = await tx.windowsExecutionLease.updateMany({
          where: { id: leaseId, sessionId, status: 'active', expiresAt: { gt: now } },
          data: { expiresAt: new Date(now.getTime() + leaseSeconds * 1_000) }
        });
        if (renewed.count !== 1) return false;
      }
      // Recovery locks leases before devices; heartbeat must use the same order.
      await tx.workerDevice.update({ where: { id: session.device_id }, data: { lastHeartbeatAt: now } });
      return true;
    });
  }

  async submitResult(deviceId: string, result: WindowsExecutionResult): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const leases = await tx.$queryRaw<Array<{ jobId: string; projectId: string; taskId: string; runId: string; packet: Prisma.JsonValue }>>`
        SELECT l."job_id" AS "jobId", j."project_id" AS "projectId", j."task_id" AS "taskId", j."run_id" AS "runId", j."packet"
        FROM "windows_execution_leases" l JOIN "windows_execution_jobs" j ON j."id" = l."job_id"
        WHERE l."id" = ${result.leaseId} AND l."job_id" = ${result.jobId} AND l."device_id" = ${deviceId}
          AND l."session_id" = ${result.sessionId} AND l."nonce" = ${result.nonce} AND l."status" = 'active'
        FOR UPDATE OF l, j`;
      const persisted = leases[0];
      if (!persisted || !isWindowsExecutionPacket(persisted.packet)) return false;
      const packet = persisted.packet;
      if (persisted.projectId !== result.projectId || persisted.taskId !== result.taskId || persisted.runId !== result.runId
        || packet.projectId !== result.projectId || packet.taskId !== result.taskId || packet.runId !== result.runId
        || packet.checkId !== result.checkId || packet.jobId !== result.jobId || packet.leaseId !== result.leaseId
        || packet.nonce !== result.nonce || packet.inputHash !== result.inputHash || packet.commitSha !== result.commitSha) return false;
      const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      const updated = await tx.windowsExecutionJob.updateMany({ where: { id: result.jobId, status: { in: ['leased', 'running'] } }, data: { status } });
      if (updated.count !== 1) return false;
      await tx.windowsExecutionLease.update({ where: { id: result.leaseId }, data: { status: result.status === 'cancelled' ? 'cancelled' : 'released', releasedAt: new Date() } });
      await tx.workerDevice.update({ where: { id: deviceId }, data: { status: 'idle' } });
      return true;
    });
  }

  async drainSession(sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.workerSession.update({ where: { id: sessionId }, data: { status: 'draining' } });
      await tx.workerDevice.update({ where: { id: session.deviceId }, data: { status: 'draining' } });
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.finishSession(sessionId, 'cancelled', 'cancelled');
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.finishSession(sessionId, 'closed', 'released');
  }

  /** Expires stale sessions/leases and deterministically makes unstarted jobs claimable again. */
  async recoverExpired(now = new Date()): Promise<{ sessions: number; leases: number; jobs: number }> {
    return this.prisma.$transaction(async (tx) => {
      const expiringSessions = await tx.$queryRaw<Array<{ id: string; deviceId: string }>>`
        SELECT "id", "device_id" AS "deviceId" FROM "worker_sessions"
        WHERE "status" IN ('active', 'draining') AND "expires_at" <= ${now}
        FOR UPDATE
      `;
      const sessions = await tx.workerSession.updateMany({
        where: { id: { in: expiringSessions.map(({ id }) => id) }, status: { in: ['active', 'draining'] } },
        data: { status: 'expired', endedAt: now }
      });
      const stale = await tx.$queryRaw<Array<{ id: string; jobId: string; deviceId: string }>>`
        SELECT l."id", l."job_id" AS "jobId", l."device_id" AS "deviceId"
        FROM "windows_execution_leases" l JOIN "worker_sessions" s ON s."id" = l."session_id"
        WHERE l."status" = 'active' AND (l."expires_at" <= ${now} OR s."status" IN ('expired', 'cancelled', 'closed'))
        FOR UPDATE OF l
      `;
      const leaseIds = stale.map(({ id }) => id);
      const jobIds = [...new Set(stale.map(({ jobId }) => jobId))];
      const deviceIds = [...new Set([...expiringSessions.map(({ deviceId }) => deviceId), ...stale.map(({ deviceId }) => deviceId)])];
      await tx.windowsExecutionLease.updateMany({ where: { id: { in: leaseIds }, status: 'active' }, data: { status: 'expired', releasedAt: now } });
      const requeuedJobs = await tx.windowsExecutionJob.updateMany({ where: { id: { in: jobIds }, status: 'leased' }, data: { status: 'queued' } });
      const expiredJobs = await tx.windowsExecutionJob.updateMany({ where: { id: { in: jobIds }, status: 'running' }, data: { status: 'expired' } });
      await tx.workerDevice.updateMany({
        where: { id: { in: deviceIds }, status: { in: ['reserved', 'running'] }, sessions: { some: { status: 'active', expiresAt: { gt: now } } } },
        data: { status: 'idle' }
      });
      await tx.workerDevice.updateMany({
        where: { id: { in: deviceIds }, status: { in: ['idle', 'reserved', 'running', 'draining'] }, sessions: { none: { status: { in: ['active', 'draining'] }, expiresAt: { gt: now } } } },
        data: { status: 'offline' }
      });
      return { sessions: sessions.count, leases: stale.length, jobs: requeuedJobs.count + expiredJobs.count };
    });
  }

  private async finishSession(sessionId: string, sessionStatus: 'cancelled' | 'closed', leaseStatus: 'cancelled' | 'released'): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const session = await tx.workerSession.update({ where: { id: sessionId }, data: { status: sessionStatus, endedAt: now } });
      const leases = await tx.windowsExecutionLease.findMany({ where: { sessionId, status: 'active' }, select: { jobId: true } });
      await tx.windowsExecutionLease.updateMany({ where: { sessionId, status: 'active' }, data: { status: leaseStatus, releasedAt: now } });
      await tx.windowsExecutionJob.updateMany({ where: { id: { in: leases.map(({ jobId }) => jobId) }, status: 'leased' }, data: { status: 'queued' } });
      await tx.windowsExecutionJob.updateMany({ where: { id: { in: leases.map(({ jobId }) => jobId) }, status: 'running' }, data: { status: 'expired' } });
      await tx.workerDevice.update({ where: { id: session.deviceId }, data: { status: 'offline' } });
    });
  }

  private async readClaimByNonce(tx: TransactionClient, sessionId: string, nonce: string): Promise<ClaimedWindowsExecution | null | undefined> {
    const lease = await tx.windowsExecutionLease.findUnique({
      where: { sessionId_nonce: { sessionId, nonce } }, include: { job: true, session: true, device: true }
    });
    const now = Date.now();
    if (!lease) return undefined;
    if (lease.status !== 'active' || lease.expiresAt.getTime() <= now
      || !['active', 'draining'].includes(lease.session.status) || lease.session.expiresAt.getTime() <= now
      || lease.session.deviceId !== lease.deviceId || !['reserved', 'running', 'draining'].includes(lease.device.status)
      || !this.isCompatible(lease.job.requiredCapabilities, lease.device.capabilities, lease.device.probeEvidence)) return null;
    return {
      lease: { schemaVersion: 1, id: lease.id, jobId: lease.jobId, deviceId: lease.deviceId, sessionId: lease.sessionId,
        status: lease.status, claimedAt: lease.claimedAt.toISOString(), expiresAt: lease.expiresAt.toISOString(), nonce: lease.nonce },
      job: { schemaVersion: 1, id: lease.job.id, projectId: lease.job.projectId, taskId: lease.job.taskId, runId: lease.job.runId,
        status: lease.job.status, requiredCapabilities: lease.job.requiredCapabilities as string[], packet: lease.job.packet as unknown as WindowsExecutionPacket,
        createdAt: lease.job.createdAt.toISOString(), updatedAt: lease.job.updatedAt.toISOString() }
    };
  }

  private isCompatible(requiredValue: Prisma.JsonValue, capabilityValue: Prisma.JsonValue, evidenceValue: Prisma.JsonValue): boolean {
    if (!Array.isArray(requiredValue) || !Array.isArray(capabilityValue) || !Array.isArray(evidenceValue)) return false;
    const required = requiredValue.filter((value): value is string => typeof value === 'string');
    const capabilities = new Set(capabilityValue.flatMap((value) => value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.key === 'string' ? [value.key] : []));
    const supported = new Set(evidenceValue.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'supported') return [];
      const capability = value.capability;
      return capability && typeof capability === 'object' && !Array.isArray(capability) && typeof capability.key === 'string' ? [capability.key] : [];
    }));
    return required.length === requiredValue.length && required.every((key) => capabilities.has(key) && supported.has(key));
  }
}
