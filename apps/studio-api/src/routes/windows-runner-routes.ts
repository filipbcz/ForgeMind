import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChatGPTPlanTokenSet, ForgeMindRepository, WindowsRunnerCredentialAdapter, WindowsRunnerPrincipal, WindowsWorkerRepository } from '@forgemind/db';
import { CHATGPT_PLAN_SCOPE, validateChatGPTIdToken } from '@forgemind/providers';
import { canonicalizeWorkerProbeEvidence, isWindowsAuthoringPacket, isWindowsAuthoringResult, isWindowsExecutionResult, redactSecrets, windowsAuthoringResultValidationIssues, WINDOWS_AUTHORING_BLOB_CHUNK_BYTES, WINDOWS_AUTHORING_MANIFEST_MAX_BYTES, WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES, WINDOWS_EVIDENCE_MAX_ARTIFACTS, WINDOWS_EVIDENCE_MAX_LOG_BYTES } from '@forgemind/core';

const deviceParams = z.object({ deviceId: z.string().uuid() });
const enrollment = z.object({
  deviceId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(200).default('Windows runner'),
  expiresInMinutes: z.number().int().min(1).max(60).default(10)
});
const redeem = z.object({ code: z.string().min(32).max(128) });
const session = z.object({ projectIds: z.array(z.string().uuid()).min(1).max(100).refine((ids) => new Set(ids).size === ids.length) });
const heartbeat = z.object({ sessionId: z.string().uuid(), leaseId: z.string().uuid().optional(), leaseSeconds: z.number().int().min(15).max(300).default(60) });
const claim = z.object({ sessionId: z.string().uuid(), requestId: z.string().min(8).max(128), leaseSeconds: z.number().int().min(15).max(300).default(60),
  authoringProtocolVersions: z.array(z.number().int().positive()).max(8).default([]) });
const deviceRegistration = z.object({
  runnerVersion: z.string().min(1).max(128), displayName: z.string().min(1).max(200),
  capabilities: z.array(z.object({ key: z.string().min(1), version: z.string().min(1).optional(), metadata: z.record(z.string(), z.any()).optional() })),
  probeEvidence: z.array(z.object({ schemaVersion: z.literal(1), capability: z.object({ key: z.string().min(1), version: z.string().min(1).optional(), metadata: z.record(z.string(), z.any()).optional() }), status: z.enum(['supported', 'unsupported', 'error']), probedAt: z.string().datetime(), probeVersion: z.string().min(1), provenance: z.enum(['local-probe', 'fixture']), summary: z.string().min(1), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i) }))
}).superRefine((input, context) => {
  const identity = (capability: { key: string; version?: string }) => `${capability.key}\u0000${capability.version ?? ''}`;
  const capabilityIds = input.capabilities.map(identity);
  const evidenceIds = input.probeEvidence.map(({ capability }) => identity(capability));
  if (new Set(capabilityIds).size !== capabilityIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities'], message: 'Capabilities must be unique.' });
  if (new Set(evidenceIds).size !== evidenceIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence'], message: 'Probe evidence must be unique.' });
  for (const capabilityId of capabilityIds) {
    const matching = input.probeEvidence.filter((evidence) => identity(evidence.capability) === capabilityId);
    if (matching.length !== 1 || matching[0]?.status !== 'supported' || matching[0]?.provenance !== 'local-probe') context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence'], message: 'Every advertised capability requires one successful matching local probe.' });
  }
  if (input.probeEvidence.some((evidence) => evidence.status === 'supported' && !capabilityIds.includes(identity(evidence.capability)))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence'], message: 'Successful probe evidence must match an advertised capability.' });
  for (const [index, evidence] of input.probeEvidence.entries()) {
    const expectedHash = createHash('sha256').update(canonicalizeWorkerProbeEvidence(evidence)).digest('hex');
    if (evidence.evidenceHash.toLowerCase() !== expectedHash) context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence', index, 'evidenceHash'], message: 'Probe evidence hash is invalid.' });
  }
});
const sessionControl = z.object({ sessionId: z.string().uuid() });
const controlQuery = z.object({ sessionId: z.string().uuid(), leaseId: z.string().uuid().optional() });

/** Legacy runner builds used this sentinel when a durable Unreal checkpoint
 * had packages but no retained process provenance. The top-level
 * authenticated session is authoritative, so narrowly repair only that known
 * value; arbitrary child identity mismatches remain invalid. */
export function normalizeLegacyAuthoringProcessSession(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const result = value as Record<string, unknown>;
  if (result.kind !== 'authoring-result' || typeof result.sessionId !== 'string' || !Array.isArray(result.processes)) return value;
  if (!result.processes.some((process) => process && typeof process === 'object'
    && (process as Record<string, unknown>).sessionId === 'authoring-session')) return value;
  if (!result.processes.every((process) => {
    if (!process || typeof process !== 'object') return false;
    const record = process as Record<string, unknown>;
    return (record.sessionId === 'authoring-session' || record.sessionId === result.sessionId)
      && record.leaseId === result.leaseId;
  })) return value;
  return { ...result, processes: result.processes.map((process) => {
    const record = process as Record<string, unknown>;
    return record.sessionId === 'authoring-session' ? { ...record, sessionId: result.sessionId } : record;
  }) };
}
const sha = z.string().regex(/^[a-f0-9]{64}$/i);
const gitCommitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
const LEGACY_AUTHORING_LOG_MAX_BYTES = WINDOWS_EVIDENCE_MAX_LOG_BYTES * 4;

function truncateUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

const authoringProgress = z.object({ schemaVersion: z.literal(1), jobId: z.string().uuid(), leaseId: z.string().uuid(), sessionId: z.string().uuid(),
  phase: z.enum(['checkout', 'author', 'verify', 'build', 'cook', 'package']), checkpoint: z.object({ resultTreeSha: gitCommitSha,
    updatedAt: z.string().datetime(), resumedFromCheckpoint: z.boolean() }), log: z.object({ text: z.string(), sizeBytes: z.number().int().nonnegative(), sha256: sha }) });
const artifactResult = z.object({ name: z.string().min(1), relativePath: z.string().min(1), mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(), sha256: sha });
const realEngineEvidence = z.object({ classification: z.enum(['automated-scenario', 'benchmark', 'soak', 'build-validation', 'capture', 'shipping']),
  buildId: z.string().min(1), scenario: z.string().min(1), settings: z.record(z.string(), z.any()), projectId: z.string().min(1), taskId: z.string().min(1),
  runId: z.string().min(1), inputHash: sha, resultTreeSha: gitCommitSha, toolVersions: z.array(z.object({ tool: z.string().min(1), version: z.string().min(1), driverVersion: z.string().min(1).optional() })),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(), durationMs: z.number().int().nonnegative(),
  state: z.enum(['succeeded', 'failed', 'timed-out', 'cancelled', 'missing-capability', 'incomplete-output']), exitCode: z.number().int().optional(), artifacts: z.array(artifactResult),
  shippingExecutable: z.object({ relativePath: z.string().regex(/\.exe$/i), sha256: sha, platform: z.literal('Win64'), configuration: z.literal('Shipping'), current: z.boolean() }).optional() });
const evidenceUpload = z.object({ schemaVersion: z.literal(1), jobId: z.string().uuid(), leaseId: z.string().uuid(), inputHash: sha, commitSha: gitCommitSha,
  log: z.object({ text: z.string(), sizeBytes: z.number().int().nonnegative(), sha256: sha }), artifacts: z.array(z.object({ name: z.string().min(1).max(200),
    relativePath: z.string().min(1).max(500), mimeType: z.string().min(1).max(200).optional(), sizeBytes: z.number().int().nonnegative(), sha256: sha, contentBase64: z.string(), criterion: z.string().min(1).max(2000) })).max(WINDOWS_EVIDENCE_MAX_ARTIFACTS),
  realEngineEvidence: realEngineEvidence.optional() });
const authoringBlobIdentity = z.object({ jobId: z.string().uuid(), leaseId: z.string().uuid(), sessionId: z.string().uuid(),
  nonce: z.string().min(8).max(128), inputHash: sha, sha256: sha });
const authoringBlobChunk = authoringBlobIdentity.extend({ sizeBytes: z.number().int().nonnegative().max(WINDOWS_AUTHORING_BLOB_CHUNK_BYTES),
  chunkIndex: z.number().int().nonnegative(), totalChunks: z.number().int().positive().max(65_536),
  contentBase64: z.string().max(Math.ceil(WINDOWS_AUTHORING_BLOB_CHUNK_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) });
const authoringBlobComplete = authoringBlobIdentity.extend({ sizeBytes: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive().max(65_536) });
const chatGPTEnrollmentExchange = z.object({ code: z.string().min(20) });
const chatGPTEnrollmentComplete = z.object({
  uploadToken: z.string().min(32),
  nonce: z.string().min(16),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  scope: z.string(),
  expiresIn: z.number().int().positive().max(86_400)
});

export function registerWindowsRunnerRoutes(app: FastifyInstance, repository: ForgeMindRepository, credentials: WindowsRunnerCredentialAdapter, workers: WindowsWorkerRepository) {
  app.post('/api/windows-runner/enrollments', async (request) => {
    const input = enrollment.parse(request.body);
    return credentials.createEnrollment(input.deviceId, new Date(Date.now() + input.expiresInMinutes * 60_000), input.displayName);
  });
  app.post('/api/windows-runner/enroll', async (request, reply) => {
    try {
      const result = await credentials.redeemEnrollment(redeem.parse(request.body).code);
      return result;
    } catch { return reply.code(401).send({ error: 'Enrollment code is invalid, expired, or already used.' }); }
  });
  app.post('/api/windows-runner/device/chatgpt-plan/enroll', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    try {
      const input = chatGPTEnrollmentExchange.parse(request.body);
      const providerRepository = repository as ForgeMindRepository & {
        exchangeChatGPTPlanEnrollment?: ForgeMindRepository['exchangeChatGPTPlanEnrollment'];
      };
      if (!providerRepository.exchangeChatGPTPlanEnrollment) throw new Error('ChatGPT plan enrollment storage is unavailable.');
      return reply.send(await providerRepository.exchangeChatGPTPlanEnrollment(input.code));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'ChatGPT plan enrollment failed.' });
    }
  });
  app.post('/api/windows-runner/device/chatgpt-plan/complete', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    try {
      const input = chatGPTEnrollmentComplete.parse(request.body);
      const scopes = input.scope.split(/\s+/).filter(Boolean);
      if (!scopes.includes(CHATGPT_PLAN_SCOPE)) throw new Error('ChatGPT plan usage permission was not granted.');
      const identity = await validateChatGPTIdToken({ idToken: input.idToken, clientId: input.clientId, nonce: input.nonce });
      const tokenSet: ChatGPTPlanTokenSet = {
        clientId: input.clientId,
        subject: identity.subject,
        issuer: identity.issuer,
        email: identity.email,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        idToken: input.idToken,
        scopes,
        expiresAt: new Date(Date.now() + input.expiresIn * 1_000).toISOString()
      };
      const providerRepository = repository as ForgeMindRepository & {
        completeChatGPTPlanEnrollment?: ForgeMindRepository['completeChatGPTPlanEnrollment'];
      };
      if (!providerRepository.completeChatGPTPlanEnrollment) throw new Error('ChatGPT plan enrollment storage is unavailable.');
      const connection = await providerRepository.completeChatGPTPlanEnrollment(input.uploadToken, tokenSet);
      return reply.send({ ok: true, connection });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'ChatGPT credential validation failed.' });
    }
  });
  app.get('/api/windows-runner/device/provider-pool', { preHandler: runnerAuth(credentials) }, async (_request, reply) => {
    try {
      const providerRepository = repository as ForgeMindRepository & {
        listAIProviderConnectionSecrets?: ForgeMindRepository['listAIProviderConnectionSecrets'];
        listAIProviderConnections?: ForgeMindRepository['listAIProviderConnections'];
      };
      if (!providerRepository.listAIProviderConnectionSecrets) throw new Error('AI provider connection storage is unavailable.');
      const [secrets, snapshots] = await Promise.all([
        providerRepository.listAIProviderConnectionSecrets(),
        providerRepository.listAIProviderConnections?.() ?? Promise.resolve([])
      ]);
      const eligible = (connection: { provider: string; authMode: string; isDefault: boolean; automaticFailover: boolean }) => connection.provider === 'codex'
        && connection.authMode !== 'codex_oauth'
        && (connection.isDefault || connection.automaticFailover);
      const connections = secrets
        .filter(eligible)
        .flatMap((connection) => {
          const credential = connection.authMode === 'chatgpt_plan_oauth' ? connection.accessToken : connection.apiKey;
          return credential ? [{
            id: connection.id,
            name: connection.name,
            authMode: connection.authMode,
            model: connection.model,
            allowedModels: connection.allowedModels ?? [],
            credential
          }] : [];
        });
      const availableIds = new Set(connections.map(({ id }) => id));
      const unavailableConnections = snapshots
        .filter(eligible)
        .filter(({ id }) => !availableIds.has(id))
        .map(({ id, name, authMode }) => ({ id, name, authMode, reason: 'credential_unavailable' as const }));
      return reply.header('cache-control', 'no-store').send({ connections, unavailableConnections });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'AI provider pool is unavailable.' });
    }
  });
  app.post('/api/windows-runner/devices/:deviceId/rotate', async (request) => {
    const { deviceId } = deviceParams.parse(request.params);
    const credential = await credentials.rotate(deviceId);
    return { deviceId, credential, scope: 'windows_runner:device_operations' };
  });
  app.post('/api/windows-runner/devices/:deviceId/revoke', async (request) => {
    const { deviceId } = deviceParams.parse(request.params);
    const revoked = await credentials.revoke(deviceId);
    return { deviceId, revoked };
  });
  app.post('/api/windows-runner/device/session', { preHandler: runnerAuth(credentials) }, async (request) => {
    const principal = runnerPrincipal(request); const input = session.parse(request.body);
    const sessionId = await workers.startManualSession(principal.deviceId, new Date(Date.now() + 60_000), input.projectIds);
    await repository.writeAudit({ actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_session_started', payload: { deviceId: principal.deviceId, sessionId, projectIds: input.projectIds } });
    return { sessionId };
  });
  app.put('/api/windows-runner/device', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request); const parsed = deviceRegistration.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({
      error: `Capability evidence is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')}`
    });
    const input = parsed.data;
    await workers.registerDevice({ id: principal.deviceId, ...input });
    return { accepted: true, deviceId: principal.deviceId };
  });
  app.get('/api/windows-runner/device/control', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request); const input = controlQuery.parse(request.query);
    const state = await workers.getControlState(principal.deviceId, input.sessionId, input.leaseId);
    return state ?? reply.code(404).send({ error: 'Session was not found.' });
  });
  app.post('/api/windows-runner/device/session/drain', { preHandler: runnerAuth(credentials) }, async (request) => {
    const principal = runnerPrincipal(request); const input = sessionControl.parse(request.body);
    const state = await workers.getControlState(principal.deviceId, input.sessionId);
    if (!state) return { accepted: false };
    await workers.drainSession(input.sessionId); return { accepted: true };
  });
  app.post('/api/windows-runner/device/session/close', { preHandler: runnerAuth(credentials) }, async (request) => {
    const principal = runnerPrincipal(request); const input = sessionControl.parse(request.body);
    const state = await workers.getControlState(principal.deviceId, input.sessionId);
    if (!state) return { accepted: false };
    await workers.closeSession(input.sessionId); return { accepted: true };
  });
  app.post('/api/windows-runner/device/session/stop', { preHandler: runnerAuth(credentials) }, async (request) => {
    const principal = runnerPrincipal(request); const input = sessionControl.parse(request.body);
    const state = await workers.getControlState(principal.deviceId, input.sessionId);
    if (!state) return { accepted: false };
    await workers.cancelSession(input.sessionId);
    await repository.writeAudit({ actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_session_stopped', payload: { deviceId: principal.deviceId, sessionId: input.sessionId } });
    return { accepted: true };
  });
  app.post('/api/windows-runner/device/heartbeat', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request); const input = heartbeat.parse(request.body);
    const accepted = await workers.heartbeat(input.sessionId, input.leaseId, input.leaseSeconds, principal.deviceId);
    return accepted ? { accepted, deviceId: principal.deviceId } : reply.code(409).send({ error: 'Session or lease is not active.' });
  });
  app.post('/api/windows-runner/device/lease', { preHandler: runnerAuth(credentials) }, async (request) => {
    const principal = runnerPrincipal(request); const input = claim.parse(request.body);
    return (await workers.claimCompatible(input.sessionId, input.leaseSeconds, input.requestId, principal.deviceId, input.authoringProtocolVersions)) ?? { job: null, lease: null };
  });
  app.post('/api/windows-runner/device/authoring-blob/chunk', { preHandler: runnerAuth(credentials), bodyLimit: Math.ceil(WINDOWS_AUTHORING_BLOB_CHUNK_BYTES / 3) * 4 + 16_384 }, async (request, reply) => {
    const principal = runnerPrincipal(request); const parsed = authoringBlobChunk.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid authoring blob chunk.' });
    const outcome = await workers.uploadAuthoringBlobChunk(principal.deviceId, parsed.data);
    return outcome === 'conflict' ? reply.code(409).send({ error: 'Authoring blob chunk conflicts with the active lease.' })
      : { accepted: true, duplicate: outcome === 'duplicate' };
  });
  app.post('/api/windows-runner/device/authoring-blob/complete', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request); const parsed = authoringBlobComplete.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid authoring blob completion request.' });
    const outcome = await workers.completeAuthoringBlob(principal.deviceId, parsed.data);
    return outcome === 'conflict' ? reply.code(409).send({ error: 'Authoring blob is incomplete or conflicts with the active lease.' })
      : { accepted: true, duplicate: outcome === 'duplicate' };
  });
  app.post('/api/windows-runner/device/result', { preHandler: runnerAuth(credentials), bodyLimit: WINDOWS_AUTHORING_MANIFEST_MAX_BYTES }, async (request, reply) => {
    const principal = runnerPrincipal(request);
    const result = normalizeLegacyAuthoringProcessSession(request.body);
    if (!isWindowsExecutionResult(result) && !isWindowsAuthoringResult(result)) {
      const issues = windowsAuthoringResultValidationIssues(result);
      const detail = issues.length ? ` Invalid sections: ${issues.join(', ')}.` : '';
      return reply.code(400).send({ error: `Invalid execution result.${detail}`, ...(issues.length ? { issues } : {}) });
    }
    if (result.deviceId !== principal.deviceId) return reply.code(403).send({ error: 'Execution result device identity does not match the authenticated runner.' });
    const outcome = await workers.submitResult(principal.deviceId, result);
    if (!outcome.accepted || !outcome.packet) return reply.code(409).send({ error: 'Execution lease is not active for this device.' });
    if (isWindowsAuthoringPacket(outcome.packet)) {
      if (!isWindowsAuthoringResult(result)) return reply.code(409).send({ error: 'Result protocol does not match the leased job.' });
      await repository.writeAudit({ actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_authoring_result_submitted',
        taskId: result.taskId, projectId: result.projectId, payload: { deviceId: principal.deviceId, jobId: result.jobId,
          leaseId: result.leaseId, status: result.status, baseCommitSha: result.baseCommitSha,
          resultTreeSha: result.resultTreeSha, binaryEntries: result.tree.filter((entry) => entry.binary).length } });
      return { accepted: true, evidenceRecorded: false };
    }
    if (!isWindowsExecutionResult(result)) return reply.code(409).send({ error: 'Result protocol does not match the leased job.' });
    let evidenceRecorded = false;
    const context = outcome.packet.evidenceContext;
    if (context) {
      try {
        await repository.recordAcceptanceEvidence({
          projectId: result.projectId,
          cycleId: context.cycleId,
          stepId: context.stepId,
          taskId: result.taskId,
          taskRunId: result.runId,
          requirementIds: context.requirementIds,
          criterion: outcome.packet.check.criterion ?? outcome.packet.check.command,
          source: 'artifact',
          status: result.status === 'succeeded' ? 'passed' : result.status === 'deferred' ? 'deferred' : 'failed',
          evidenceIdentity: `windows:${result.jobId}`,
          contractVersion: context.contractVersion,
          commitSha: result.commitSha,
          command: outcome.packet.check.command,
          exitCode: result.exitCode,
          payload: {
            platform: 'windows',
            deviceId: principal.deviceId,
            summary: result.summary,
            logHash: result.logHash,
            realEngineEvidence: result.realEngineEvidence ? JSON.parse(JSON.stringify(result.realEngineEvidence)) : null,
            artifacts: result.artifacts.map((artifact) => ({ ...artifact }))
          }
        });
        evidenceRecorded = true;
      } catch (error) {
        await repository.writeAudit({
          actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_evidence_record_failed',
          taskId: result.taskId, projectId: result.projectId,
          payload: { jobId: result.jobId, errorMessage: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    await repository.writeAudit({ actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_result_submitted', taskId: result.taskId, projectId: result.projectId, payload: { deviceId: principal.deviceId, jobId: result.jobId, leaseId: result.leaseId, status: result.status, commitSha: result.commitSha } });
    return { accepted: true, evidenceRecorded };
  });
  app.post('/api/windows-runner/device/authoring-progress', { preHandler: runnerAuth(credentials),
    bodyLimit: LEGACY_AUTHORING_LOG_MAX_BYTES + 100_000 }, async (request, reply) => {
    const principal = runnerPrincipal(request); const parsed = authoringProgress.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid authoring progress.' });
    const input = parsed.data; const rawText = redactSecrets(input.log.text); const rawSizeBytes = Buffer.byteLength(rawText);
    if (rawText !== input.log.text || rawSizeBytes !== input.log.sizeBytes || rawSizeBytes > LEGACY_AUTHORING_LOG_MAX_BYTES
      || createHash('sha256').update(rawText).digest('hex') !== input.log.sha256.toLowerCase()) return reply.code(400).send({ error: 'Authoring progress log is invalid.' });
    const text = truncateUtf8Tail(rawText, WINDOWS_EVIDENCE_MAX_LOG_BYTES);
    const progress = { ...input, log: { text, sizeBytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') } };
    const accepted = await workers.recordAuthoringProgress(principal.deviceId, progress);
    return accepted ? { accepted } : reply.code(409).send({ error: 'Execution lease is not active for this device.' });
  });
  app.post('/api/windows-runner/device/evidence', { preHandler: runnerAuth(credentials), bodyLimit: WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES + WINDOWS_EVIDENCE_MAX_LOG_BYTES + 100_000 }, async (request, reply) => {
    const principal = runnerPrincipal(request); const parsed = evidenceUpload.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid evidence upload.' });
    const upload = parsed.data; const logBytes = Buffer.byteLength(upload.log.text); let artifactBytes = 0;
    if (logBytes !== upload.log.sizeBytes || logBytes > WINDOWS_EVIDENCE_MAX_LOG_BYTES || createHash('sha256').update(upload.log.text).digest('hex') !== upload.log.sha256.toLowerCase()) return reply.code(400).send({ error: 'Log size or hash is invalid.' });
    const forbidden = /(^|[\\/])(?:\.git|Users?|home|workspace)(?:[\\/]|$)|(?:^|[\\/])(?:\.env|environment)(?:\.|[\\/]|$)/i;
    for (const artifact of upload.artifacts) { if (forbidden.test(artifact.relativePath) || artifact.relativePath.includes('..')) return reply.code(400).send({ error: 'Artifact path is prohibited.' });
      const bytes = Buffer.from(artifact.contentBase64, 'base64'); artifactBytes += bytes.length;
      if (bytes.length !== artifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256.toLowerCase()) return reply.code(400).send({ error: 'Artifact size or hash is invalid.' });
      const decodedText = bytes.toString('utf8');
      if (redactSecrets(decodedText) !== decodedText) return reply.code(400).send({ error: 'Artifact content contains secret-like values and must be redacted before hashing.' }); }
    if (artifactBytes > WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES) return reply.code(413).send({ error: 'Artifact upload exceeds its limit.' });
    const redacted = redactSecrets(upload);
    if (JSON.stringify(redacted) !== JSON.stringify(upload)) return reply.code(400).send({ error: 'Evidence contains secret-like values and must be redacted before hashing.' });
    const outcome = await workers.uploadEvidence(principal.deviceId, redacted);
    return outcome === 'conflict' ? reply.code(409).send({ error: 'Evidence conflicts with the lease or an existing upload.' }) : { accepted: true, duplicate: outcome === 'duplicate' };
  });
  app.get('/api/windows-runner/operations', async (request) => workers.readOperations(z.object({ projectId: z.string().uuid().optional() }).parse(request.query).projectId));
  app.get('/api/windows-runner/jobs/:jobId/artifacts/:sha256', async (request, reply) => {
    const input = z.object({ jobId: z.string().uuid(), sha256: sha }).parse(request.params);
    const artifact = await workers.readArtifact(input.jobId, input.sha256);
    if (!artifact) return reply.code(404).send({ error: 'Artifact is missing, unreadable, or does not match its recorded hash.' });
    return reply.header('content-type', artifact.mimeType).header('content-disposition', 'inline').send(artifact.content);
  });
  app.post('/api/windows-runner/jobs/:jobId/cancel', async (request) => { const jobId = z.object({ jobId: z.string().uuid() }).parse(request.params).jobId; const accepted = await workers.cancelJob(jobId);
    await repository.writeAudit({ actorType: 'user', eventType: 'windows_runner_job_cancelled', payload: { jobId, accepted } }); return { accepted }; });
  app.post('/api/windows-runner/sessions/:sessionId/drain', async (request) => { const sessionId = z.object({ sessionId: z.string().uuid() }).parse(request.params).sessionId; await workers.drainSession(sessionId);
    await repository.writeAudit({ actorType: 'user', eventType: 'windows_runner_session_draining', payload: { sessionId } }); return { accepted: true }; });
  app.post('/api/windows-runner/sessions/:sessionId/stop', async (request) => { const sessionId = z.object({ sessionId: z.string().uuid() }).parse(request.params).sessionId; await workers.cancelSession(sessionId);
    await repository.writeAudit({ actorType: 'user', eventType: 'windows_runner_session_stopped', payload: { sessionId } }); return { accepted: true }; });
  app.post('/api/windows-runner/sessions/:sessionId/resume', async (request) => { const sessionId = z.object({ sessionId: z.string().uuid() }).parse(request.params).sessionId; const resumedSessionId = await workers.resumeSession(sessionId);
    await repository.writeAudit({ actorType: 'user', eventType: 'windows_runner_session_resumed', payload: { sessionId, resumedSessionId } }); return { accepted: true, sessionId: resumedSessionId }; });
}

function runnerAuth(credentials: WindowsRunnerCredentialAdapter) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Runner authentication required.' });
    const principal = await credentials.authenticate(value.slice(7).trim());
    if (!principal) return reply.code(403).send({ error: 'Runner credential is invalid or revoked.' });
    (request as FastifyRequest & { runnerPrincipal: WindowsRunnerPrincipal }).runnerPrincipal = principal;
  };
}
function runnerPrincipal(request: FastifyRequest) { return (request as FastifyRequest & { runnerPrincipal: WindowsRunnerPrincipal }).runnerPrincipal; }
