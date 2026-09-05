import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { canonicalizeWorkerProbeEvidence, deferLegacyWindowsExecutionPacket, isWindowsAuthoringPacket, isWindowsAuthoringResult, isWindowsExecutionPacket, isWindowsExecutionResult, WINDOWS_DEVICE_OFFLINE_AFTER_MS } from '@forgemind/core';
import type {
  WorkerCapability, WorkerProbeEvidence, WindowsExecutionJob, WindowsExecutionLease,
  WindowsAuthoringPacket, WindowsCapabilityWaitReason, WindowsExecutionPacket, WindowsExecutionResult, WindowsJobPacket, WindowsJobResult, WindowsPendingPhase
} from '@forgemind/core';
import type { WindowsEvidenceUpload, WindowsWorkerOperationsReadModel } from '@forgemind/core';

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
  pendingPhase?: WindowsPendingPhase;
}

export interface EnqueueWindowsAuthoringInput extends Omit<EnqueueWindowsExecutionInput, 'packet'> {
  packet: WindowsAuthoringPacket;
}

export interface ClaimedWindowsExecution {
  job: WindowsExecutionJob;
  lease: WindowsExecutionLease;
}

export interface WindowsRunnerControlState {
  deviceStatus: string;
  sessionStatus: string;
  leaseStatus?: string;
  jobStatus?: string;
}

export interface SubmittedWindowsResult {
  accepted: boolean;
  packet?: WindowsJobPacket;
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const sameCapabilitySet = (left: string[], right: string[]): boolean => left.length === right.length
  && new Set(left).size === left.length && new Set(right).size === right.length
  && left.every((capability) => right.includes(capability));
const PROBE_MAX_AGE_MS = 5 * 60_000;
const LARGE_FLYING_FREE_BYTES = 100 * 1024 ** 3;

function verifiedCapabilities(input: RegisterWorkerDeviceInput, now = new Date()): WorkerCapability[] {
  return input.capabilities.filter((capability) => input.probeEvidence.some((evidence) => {
    if (evidence.status !== 'supported' || evidence.provenance !== 'local-probe' || JSON.stringify(evidence.capability) !== JSON.stringify(capability)) return false;
    const age = now.getTime() - Date.parse(evidence.probedAt);
    if (!Number.isFinite(age) || age < -60_000 || age > PROBE_MAX_AGE_MS || !/^[a-f0-9]{64}$/i.test(evidence.evidenceHash)) return false;
    const canonical = canonicalizeWorkerProbeEvidence(evidence);
    return createHash('sha256').update(canonical).digest('hex') === evidence.evidenceHash;
  }));
}

function capabilitySatisfies(device: { capabilities: WorkerCapability[]; probeEvidence: WorkerProbeEvidence[] }, key: string, now: Date): boolean {
  if (key === 'disk-free-100gb') {
    const disk = device.capabilities.find((item) => item.key === 'disk-capacity');
    const evidence = device.probeEvidence.find((item) => item.status === 'supported' && item.provenance === 'local-probe' && JSON.stringify(item.capability) === JSON.stringify(disk));
    const age = evidence ? now.getTime() - Date.parse(evidence.probedAt) : Number.NaN;
    return Number.isFinite(age) && age >= 0 && age <= PROBE_MAX_AGE_MS
      && typeof disk?.metadata?.freeBytes === 'number' && disk.metadata.freeBytes >= LARGE_FLYING_FREE_BYTES;
  }
  const advertised = device.capabilities.find((item) => item.key === key);
  if (!advertised) return false;
  const evidence = device.probeEvidence.find((item) => item.status === 'supported' && item.provenance === 'local-probe' && JSON.stringify(item.capability) === JSON.stringify(advertised));
  const age = evidence ? now.getTime() - Date.parse(evidence.probedAt) : Number.NaN;
  if (!Number.isFinite(age) || age < 0 || age > PROBE_MAX_AGE_MS) return false;
  return true;
}

/** Persistence boundary for the manually activated Windows validation executor. */
export class WindowsWorkerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async registerDevice(input: RegisterWorkerDeviceInput): Promise<void> {
    const capabilities = verifiedCapabilities(input);
    await this.prisma.workerDevice.upsert({
      where: { id: input.id },
      create: {
        id: input.id, platform: 'windows', runnerVersion: input.runnerVersion, displayName: input.displayName,
        status: 'offline', capabilities: asJson(capabilities), probeEvidence: asJson(input.probeEvidence),
        metadata: input.metadata ?? {}
      },
      update: {
        runnerVersion: input.runnerVersion, displayName: input.displayName, capabilities: asJson(capabilities),
        probeEvidence: asJson(input.probeEvidence), metadata: input.metadata ?? {}
      }
    });
  }

  async getControlState(deviceId: string, sessionId: string, leaseId?: string): Promise<WindowsRunnerControlState | undefined> {
    const session = await this.prisma.workerSession.findFirst({
      where: { id: sessionId, deviceId },
      include: { device: true }
    });
    if (!session) return undefined;
    const lease = leaseId ? await this.prisma.windowsExecutionLease.findFirst({
      where: { id: leaseId, sessionId, deviceId }, include: { job: true }
    }) : undefined;
    return {
      deviceStatus: session.device.status,
      sessionStatus: session.status,
      leaseStatus: lease?.status,
      jobStatus: lease?.job.status
    };
  }

  async startManualSession(deviceId: string, expiresAt: Date, authorizedProjectIds: string[]): Promise<string> {
    if (expiresAt.getTime() <= Date.now()) throw new Error('Worker session expiry must be in the future.');
    if (authorizedProjectIds.length === 0 || new Set(authorizedProjectIds).size !== authorizedProjectIds.length) throw new Error('At least one unique authorized project is required.');
    return this.prisma.$transaction(async (tx) => {
      const devices = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "worker_devices" WHERE "id" = ${deviceId} AND "status" <> 'revoked' FOR UPDATE`;
      if (devices.length !== 1) throw new Error('Worker device is missing or revoked.');
      const projects = await tx.project.count({ where: { id: { in: authorizedProjectIds } } });
      if (projects !== authorizedProjectIds.length) throw new Error('One or more authorized projects do not exist.');
      const previousSessions = await tx.workerSession.findMany({ where: { deviceId, status: { in: ['active', 'draining'] } }, select: { id: true } });
      const previousSessionIds = previousSessions.map(({ id }) => id);
      const previousLeases = await tx.windowsExecutionLease.findMany({ where: { sessionId: { in: previousSessionIds }, status: 'active' }, select: { jobId: true } });
      if (previousLeases.length > 0) throw new Error('The device still owns an active process; stop it and wait for cancellation reconciliation before starting another session.');
      const previousJobIds = previousLeases.map(({ jobId }) => jobId);
      const now = new Date();
      await tx.workerSession.updateMany({ where: { id: { in: previousSessionIds } }, data: { status: 'expired', endedAt: now } });
      await tx.windowsExecutionLease.updateMany({ where: { sessionId: { in: previousSessionIds }, status: 'active' }, data: { status: 'expired', releasedAt: now } });
      await tx.windowsExecutionJob.updateMany({ where: { id: { in: previousJobIds }, status: 'leased' }, data: { status: 'queued' } });
      await tx.windowsExecutionJob.updateMany({ where: { id: { in: previousJobIds }, status: 'running' }, data: { status: 'expired' } });
      const session = await tx.workerSession.create({ data: { deviceId, expiresAt, authorizedProjectIds: asJson(authorizedProjectIds) } });
      await tx.workerDevice.update({ where: { id: deviceId }, data: { status: 'idle', lastHeartbeatAt: new Date() } });
      return session.id;
    });
  }

  async enqueue(input: EnqueueWindowsExecutionInput): Promise<string> {
    const id = input.id ?? randomUUID();
    if (input.packet.jobId !== id || input.packet.taskId !== input.taskId || input.packet.projectId !== input.projectId
      || input.packet.runId !== input.runId || !sameCapabilitySet(input.packet.requiredCapabilities, input.requiredCapabilities)
      || !isWindowsExecutionPacket(input.packet)) {
      throw new Error('Windows execution enqueue identity is invalid.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.windowsExecutionJob.create({ data: {
        id, projectId: input.projectId, taskId: input.taskId, runId: input.runId,
        requiredCapabilities: asJson(input.requiredCapabilities), packet: asJson(input.packet), pendingPhase: input.pendingPhase ?? 'validate'
      } });
    });
    return id;
  }

  async enqueueAuthoring(input: EnqueueWindowsAuthoringInput): Promise<string> {
    const id = input.id ?? randomUUID();
    if (input.packet.jobId !== id || input.packet.taskId !== input.taskId || input.packet.projectId !== input.projectId
      || input.packet.runId !== input.runId || !sameCapabilitySet(input.packet.requiredCapabilities, input.requiredCapabilities)
      || !isWindowsAuthoringPacket(input.packet)) throw new Error('Windows authoring enqueue identity is invalid.');
    await this.prisma.windowsExecutionJob.create({ data: { id, projectId: input.projectId, taskId: input.taskId, runId: input.runId,
      requiredCapabilities: asJson(input.requiredCapabilities), packet: asJson(input.packet), pendingPhase: input.pendingPhase ?? 'author' } });
    return id;
  }

  /** Waits for the lease result without imposing a workflow retry or duration
   * limit. Cancellation remains controlled by the owning task run. */
  async waitForAuthoringResult(jobId: string, signal?: AbortSignal): Promise<import('@forgemind/core').WindowsAuthoringResult> {
    while (!signal?.aborted) {
      const job = await this.prisma.windowsExecutionJob.findUnique({ where: { id: jobId }, select: { status: true, packet: true } });
      if (!job) throw new Error('Windows authoring job was not found.');
      const packet = job.packet as unknown as WindowsAuthoringPacket & { authoringResult?: import('@forgemind/core').WindowsAuthoringResult };
      if (packet.authoringResult && isWindowsAuthoringResult(packet.authoringResult)) return packet.authoringResult;
      if (['cancelled', 'expired'].includes(job.status)) throw new Error(`Windows authoring job ${job.status}.`);
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
    throw new Error('Windows authoring was cancelled.');
  }

  async uploadEvidence(deviceId: string, upload: WindowsEvidenceUpload): Promise<'accepted' | 'duplicate' | 'conflict'> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT j."id" FROM "windows_execution_jobs" j
        JOIN "windows_execution_leases" l ON l."job_id" = j."id"
        WHERE j."id" = ${upload.jobId} AND l."id" = ${upload.leaseId} AND l."device_id" = ${deviceId} AND l."status" = 'active'
        FOR UPDATE OF j, l`;
      if (locked.length !== 1) return 'conflict';
      const lease = await tx.windowsExecutionLease.findFirst({ where: { id: upload.leaseId, jobId: upload.jobId, deviceId, status: 'active' }, include: { job: true } });
      if (!lease || !isWindowsExecutionPacket(lease.job.packet)) return 'conflict';
      const packet = lease.job.packet;
      if (packet.inputHash !== upload.inputHash || packet.commitSha !== upload.commitSha) return 'conflict';
      const existing = (packet as unknown as { evidenceUpload?: WindowsEvidenceUpload }).evidenceUpload;
      if (existing) return JSON.stringify(existing) === JSON.stringify(upload) ? 'duplicate' : 'conflict';
      const packetWithEvidence = Object.assign({}, packet as WindowsExecutionPacket, { evidenceUpload: upload });
      await tx.windowsExecutionJob.update({ where: { id: upload.jobId }, data: { packet: asJson(packetWithEvidence) } });
      return 'accepted';
    });
  }

  async readOperations(projectId?: string, now = new Date()): Promise<WindowsWorkerOperationsReadModel> {
    const [devices, jobs] = await Promise.all([
      this.prisma.workerDevice.findMany({ include: { sessions: { orderBy: { startedAt: 'desc' }, take: 5 } }, orderBy: { displayName: 'asc' } }),
      this.prisma.windowsExecutionJob.findMany({ where: projectId ? { projectId } : undefined, orderBy: { createdAt: 'desc' }, take: 100 })
    ]);
    const heartbeatCutoff = now.getTime() - WINDOWS_DEVICE_OFFLINE_AFTER_MS;
    const mappedDevices = devices.map((device) => ({ schemaVersion: 1 as const, id: device.id, platform: 'windows' as const, runnerVersion: device.runnerVersion,
      displayName: device.displayName, status: device.status !== 'revoked' && (!device.lastHeartbeatAt || device.lastHeartbeatAt.getTime() < heartbeatCutoff) ? 'offline' as const : device.status,
      capabilities: device.capabilities as unknown as WorkerCapability[],
      probeEvidence: device.probeEvidence as unknown as WorkerProbeEvidence[],
      lastHeartbeatAt: device.lastHeartbeatAt?.toISOString(), sessions: device.sessions.map((session) => ({ schemaVersion: 1 as const, id: session.id,
        deviceId: session.deviceId, status: session.status, startedAt: session.startedAt.toISOString(), expiresAt: session.expiresAt.toISOString(),
        lastHeartbeatAt: session.lastHeartbeatAt.toISOString(), endedAt: session.endedAt?.toISOString() })) }));
    return { schemaVersion: 1, devices: mappedDevices, waitingValidations: jobs.filter((job) => job.status === 'queued').map((job) => {
      const packet = job.packet as unknown as WindowsExecutionPacket; const required = job.requiredCapabilities as string[];
      return { jobId: job.id, taskId: job.taskId, criterion: packet.check?.criterion, requiredCapabilities: required,
        waitReason: (job.waitReason === 'insufficient_capacity' ? 'insufficient_capacity' : 'unavailable_capability') as WindowsCapabilityWaitReason,
        pendingPhase: job.pendingPhase as WindowsPendingPhase,
        compatibleDeviceIds: mappedDevices.filter((device) => device.status === 'idle'
          && device.sessions.some((session) => session.status === 'active' && Date.parse(session.expiresAt) > now.getTime() && Date.parse(session.lastHeartbeatAt) >= heartbeatCutoff)
          && required.every((key) => capabilitySatisfies(device, key, now))).map((device) => device.id) };
    }), evidence: jobs.flatMap((job) => { const packet = job.packet as unknown as WindowsExecutionPacket & { evidenceUpload?: WindowsEvidenceUpload };
      return packet.evidenceUpload ? [{ jobId: job.id, taskId: job.taskId, checkId: packet.checkId, criterion: packet.check.criterion,
        commitSha: packet.commitSha, log: packet.evidenceUpload.log, artifacts: packet.evidenceUpload.artifacts.map(({ contentBase64: _content, ...artifact }) => artifact) }] : []; }) };
  }

  async cancelJob(jobId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const leases = await tx.windowsExecutionLease.findMany({ where: { jobId, status: 'active' } });
      await tx.windowsExecutionLease.updateMany({ where: { jobId, status: 'active' }, data: { status: 'cancelled', releasedAt: new Date() } });
      const changed = await tx.windowsExecutionJob.updateMany({ where: { id: jobId, status: { in: ['queued', 'leased', 'running'] } }, data: { status: 'cancelled' } });
      await tx.workerDevice.updateMany({ where: { id: { in: leases.map((lease) => lease.deviceId) }, status: { in: ['reserved', 'running'] } }, data: { status: 'idle' } });
      return changed.count === 1;
    });
  }

  async claimCompatible(sessionId: string, leaseSeconds: number, requestId: string, deviceId?: string, authoringProtocolVersions: number[] = []): Promise<ClaimedWindowsExecution | undefined> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error('Lease duration must be a positive integer.');
    return this.prisma.$transaction(async (tx) => {
      // Serialize only retries from this session; request ids are not global credentials.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${sessionId}:${requestId}`}, 0))`;
      const existing = await this.readClaimByNonce(tx, sessionId, requestId);
      if (existing !== undefined) return existing ?? undefined;

      // Lock the session/device before looking at jobs so competing claims cannot lock
      // different jobs and then deadlock or serialize-fail on the same device.
      const sessions = await tx.$queryRaw<Array<{ device_id: string; authorized_project_ids: string[] }>>`
        SELECT s."device_id", s."authorized_project_ids"
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
        JOIN "tasks" task ON task."id" = candidate."task_id" AND task."status" IN ('completed', 'ready_for_user_review')
        JOIN "task_runs" run ON run."id" = candidate."run_id" AND run."task_id" = task."id"
        JOIN "worker_devices" d ON d."id" = ${session.device_id}
        WHERE candidate."status" = 'queued'
          AND candidate."project_id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(session.authorized_project_ids)}::jsonb))
          AND (candidate."packet"->>'kind' IS DISTINCT FROM 'authoring'
            OR candidate."packet"->>'protocolVersion' = ANY(${authoringProtocolVersions.map(String)}::text[]))
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(candidate."required_capabilities") required(key)
            WHERE required.key <> 'disk-free-100gb' AND (NOT (d."capabilities" @> jsonb_build_array(jsonb_build_object('key', required.key)))
               OR NOT (d."probe_evidence" @> jsonb_build_array(jsonb_build_object('capability', jsonb_build_object('key', required.key), 'status', 'supported'))))
          )
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(d."capabilities") capability
            WHERE capability->>'key' = ANY(ARRAY(SELECT jsonb_array_elements_text(candidate."required_capabilities")))
              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d."probe_evidence") evidence
                WHERE evidence->>'status' = 'supported' AND evidence->>'provenance' = 'local-probe' AND evidence->'capability' = capability
                  AND (evidence->>'probedAt')::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                  AND evidence->>'evidenceHash' ~ '^[a-f0-9]{64}$')
          )
          AND (NOT (candidate."required_capabilities" @> '["disk-free-100gb"]'::jsonb)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(d."capabilities") disk
              JOIN LATERAL jsonb_array_elements(d."probe_evidence") evidence ON evidence->'capability' = disk
              WHERE disk->>'key' = 'disk-capacity' AND (disk->'metadata'->>'freeBytes')::numeric >= ${LARGE_FLYING_FREE_BYTES}
                AND evidence->>'status' = 'supported' AND evidence->>'provenance' = 'local-probe'
                AND (evidence->>'probedAt')::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                AND evidence->>'evidenceHash' ~ '^[a-f0-9]{64}$'))
        ORDER BY candidate."created_at", candidate."id"
        FOR UPDATE OF candidate SKIP LOCKED LIMIT 1
      `;
      const selected = jobs[0];
      if (!selected) {
        await tx.$executeRaw`
          UPDATE "windows_execution_jobs" candidate SET "wait_reason" =
            CASE WHEN candidate."required_capabilities" @> '["disk-free-100gb"]'::jsonb
              AND NOT EXISTS (SELECT 1 FROM "worker_devices" capacity_device,
                LATERAL jsonb_array_elements(capacity_device."capabilities") disk,
                LATERAL jsonb_array_elements(capacity_device."probe_evidence") evidence
                WHERE capacity_device."id" = ${session.device_id} AND disk->>'key' = 'disk-capacity'
                  AND evidence->'capability' = disk AND evidence->>'status' = 'supported'
                  AND evidence->>'provenance' = 'local-probe'
                  AND (evidence->>'probedAt')::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                  AND evidence->>'evidenceHash' ~ '^[a-f0-9]{64}$'
                  AND (disk->'metadata'->>'freeBytes')::numeric >= ${LARGE_FLYING_FREE_BYTES})
              THEN 'insufficient_capacity' ELSE 'unavailable_capability' END
          WHERE candidate."status" = 'queued'
            AND candidate."project_id" IN (SELECT jsonb_array_elements_text(${JSON.stringify(session.authorized_project_ids)}::jsonb))`;
        return undefined;
      }

      const selectedJob = await tx.windowsExecutionJob.findUniqueOrThrow({ where: { id: selected.job_id } });
      const selectedPacket = selectedJob.packet;
      const leasedPacket: WindowsJobPacket = isWindowsExecutionPacket(selectedPacket) || isWindowsAuthoringPacket(selectedPacket)
        ? selectedPacket
        : deferLegacyWindowsExecutionPacket(selectedPacket) ?? quarantineInvalidPacket(selectedJob, selectedPacket);
      const leaseId = randomUUID();
      const expiresAt = new Date(Date.now() + leaseSeconds * 1_000);
      await tx.windowsExecutionLease.create({ data: {
        id: leaseId, jobId: selected.job_id, deviceId: session.device_id, sessionId,
        expiresAt, nonce: requestId
      } });
      await tx.windowsExecutionJob.update({
        where: { id: selected.job_id },
        data: { status: 'leased', waitReason: null, packet: asJson({ ...leasedPacket, leaseId, nonce: requestId }) }
      });
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
      await tx.workerSession.update({ where: { id: sessionId }, data: { lastHeartbeatAt: now, expiresAt: new Date(now.getTime() + leaseSeconds * 1_000) } });
      if (leaseId) {
        await tx.$queryRaw`SELECT "id" FROM "windows_execution_leases" WHERE "id" = ${leaseId} FOR UPDATE`;
        const renewed = await tx.windowsExecutionLease.updateMany({
          where: { id: leaseId, sessionId, status: 'active', expiresAt: { gt: now } },
          data: { expiresAt: new Date(now.getTime() + leaseSeconds * 1_000) }
        });
        if (renewed.count !== 1) return false;
        const lease = await tx.windowsExecutionLease.findUnique({ where: { id: leaseId }, select: { jobId: true } });
        if (!lease) return false;
        await tx.windowsExecutionJob.updateMany({ where: { id: lease.jobId, status: 'leased' }, data: { status: 'running' } });
        await tx.workerDevice.updateMany({ where: { id: session.device_id, status: 'reserved' }, data: { status: 'running' } });
      }
      // Recovery locks leases before devices; heartbeat must use the same order.
      await tx.workerDevice.update({ where: { id: session.device_id }, data: { lastHeartbeatAt: now } });
      return true;
    });
  }

  async submitResult(deviceId: string, result: WindowsJobResult): Promise<SubmittedWindowsResult> {
    if ((!isWindowsExecutionResult(result) && !isWindowsAuthoringResult(result)) || result.deviceId !== deviceId) return { accepted: false };
    return this.prisma.$transaction(async (tx) => {
      const leases = await tx.$queryRaw<Array<{ jobId: string; projectId: string; taskId: string; runId: string; packet: Prisma.JsonValue; sessionStatus: string }>>`
        SELECT l."job_id" AS "jobId", j."project_id" AS "projectId", j."task_id" AS "taskId", j."run_id" AS "runId", j."packet", s."status"::text AS "sessionStatus"
        FROM "windows_execution_leases" l JOIN "windows_execution_jobs" j ON j."id" = l."job_id"
        JOIN "worker_sessions" s ON s."id" = l."session_id"
        WHERE l."id" = ${result.leaseId} AND l."job_id" = ${result.jobId} AND l."device_id" = ${deviceId}
          AND l."session_id" = ${result.sessionId} AND l."nonce" = ${result.nonce} AND l."status" = 'active'
        FOR UPDATE OF l, j`;
      const persisted = leases[0];
      if (!persisted || (!isWindowsExecutionPacket(persisted.packet) && !isWindowsAuthoringPacket(persisted.packet))) return { accepted: false };
      const packet = persisted.packet as WindowsJobPacket;
      if (persisted.projectId !== result.projectId || persisted.taskId !== result.taskId || persisted.runId !== result.runId
        || packet.projectId !== result.projectId || packet.taskId !== result.taskId || packet.runId !== result.runId
        || packet.jobId !== result.jobId || packet.leaseId !== result.leaseId || packet.nonce !== result.nonce || packet.inputHash !== result.inputHash) return { accepted: false };
      if (isWindowsAuthoringPacket(packet)) {
        if (!isWindowsAuthoringResult(result) || result.protocolVersion !== packet.protocolVersion
          || result.baseCommitSha !== packet.baseCommitSha
          || result.completedOperationIds.some((id) => !packet.operations.some((operation) => operation.id === id))
          || result.checkpointIds.some((id) => !packet.checkpoints.some((checkpoint) => checkpoint.id === id))) return { accepted: false };
      } else {
        if (!isWindowsExecutionResult(result) || packet.checkId !== result.checkId || packet.commitSha !== result.commitSha) return { accepted: false };
      }
      if (isWindowsAuthoringPacket(packet) && isWindowsAuthoringResult(result)) {
        const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed';
        const updated = await tx.windowsExecutionJob.updateMany({ where: { id: result.jobId, status: { in: ['leased', 'running'] } }, data: { status,
          packet: asJson({ ...packet, authoringResult: result }) } });
        if (updated.count !== 1) throw new Error('Execution job changed while its result was being reconciled.');
        await tx.windowsExecutionLease.update({ where: { id: result.leaseId }, data: { status: result.status === 'cancelled' ? 'cancelled' : 'released', releasedAt: new Date() } });
        await tx.workerDevice.update({ where: { id: deviceId }, data: { status: persisted.sessionStatus === 'active' ? 'idle' : 'offline' } });
        return { accepted: true, packet };
      }
      const validationResult = result as WindowsExecutionResult;
      const evidence = (packet as WindowsExecutionPacket & { evidenceUpload?: WindowsEvidenceUpload }).evidenceUpload;
      if (!evidence || evidence.log.sha256.toLowerCase() !== validationResult.logHash.toLowerCase()
        || evidence.artifacts.length !== validationResult.artifacts.length
        || validationResult.artifacts.some((artifact) => !evidence.artifacts.some((uploaded) => uploaded.name === artifact.name
          && uploaded.relativePath === artifact.relativePath && uploaded.sizeBytes === artifact.sizeBytes
          && uploaded.sha256.toLowerCase() === artifact.sha256.toLowerCase()))) return { accepted: false };
      const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      const updated = await tx.windowsExecutionJob.updateMany({ where: { id: result.jobId, status: { in: ['leased', 'running'] } }, data: { status } });
      if (updated.count !== 1) throw new Error('Execution job changed while its result was being reconciled.');
      await tx.windowsExecutionLease.update({ where: { id: result.leaseId }, data: { status: result.status === 'cancelled' ? 'cancelled' : 'released', releasedAt: new Date() } });
      await tx.workerDevice.update({ where: { id: deviceId }, data: { status: persisted.sessionStatus === 'active' ? 'idle' : 'offline' } });
      return { accepted: true, packet };
    });
  }

  async drainSession(sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.workerSession.update({ where: { id: sessionId }, data: { status: 'draining' } });
      const activeLease = await tx.windowsExecutionLease.count({ where: { sessionId, status: 'active' } });
      await tx.workerDevice.update({ where: { id: session.deviceId }, data: { status: activeLease ? 'draining' : 'offline' } });
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const session = await tx.workerSession.update({ where: { id: sessionId }, data: { status: 'cancelled', endedAt: now } });
      const activeLease = await tx.windowsExecutionLease.count({ where: { sessionId, status: 'active' } });
      await tx.workerDevice.update({ where: { id: session.deviceId }, data: { status: activeLease ? 'draining' : 'offline' } });
    });
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
        WHERE l."status" = 'active' AND (l."expires_at" <= ${now} OR s."status" IN ('expired', 'closed'))
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
        status: lease.job.status, requiredCapabilities: lease.job.requiredCapabilities as string[], packet: lease.job.packet as unknown as WindowsJobPacket,
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

function quarantineInvalidPacket(
  job: { id: string; projectId: string; taskId: string; runId: string; requiredCapabilities: unknown },
  value: unknown
): WindowsExecutionPacket {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawCheck = raw.check && typeof raw.check === 'object' && !Array.isArray(raw.check) ? raw.check as Record<string, unknown> : {};
  const capabilities = Array.isArray(job.requiredCapabilities)
    ? Array.from(new Set(job.requiredCapabilities.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())))
    : [];
  if (!capabilities.includes('windows')) capabilities.unshift('windows');
  const commitSha = typeof raw.commitSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(raw.commitSha) ? raw.commitSha : '0'.repeat(40);
  const inputHash = typeof raw.inputHash === 'string' && /^[a-f0-9]{64}$/i.test(raw.inputHash)
    ? raw.inputHash
    : createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
  return {
    schemaVersion: 2, projectId: job.projectId, taskId: job.taskId, runId: job.runId,
    checkId: typeof raw.checkId === 'string' && raw.checkId.trim() ? raw.checkId : `invalid:${job.id}`,
    jobId: job.id, leaseId: 'pending', repository: typeof raw.repository === 'string' && raw.repository.trim() ? raw.repository : 'invalid/packet',
    sourceUrl: typeof raw.sourceUrl === 'string' && raw.sourceUrl.trim() ? raw.sourceUrl : 'invalid-packet', commitSha,
    workspaceRoot: 'runner-managed', artifactRoot: 'runner-managed',
    check: { command: typeof rawCheck.command === 'string' && rawCheck.command.trim() ? rawCheck.command : 'Invalid Windows validation packet',
      category: 'smoke', requiredCapabilities: capabilities },
    dispatch: { kind: 'deferred', reason: raw.schemaVersion === 1 ? 'legacy_unsafe_packet' : 'unsupported_validation_intent', handling: 'manual-local' }, requiredCapabilities: capabilities,
    resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 256_000, maxArtifactBytes: 0 }, expectedArtifacts: [], nonce: 'pending', inputHash
  };
}
