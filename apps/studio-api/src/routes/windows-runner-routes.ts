import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ForgeMindRepository, WindowsRunnerCredentialAdapter, WindowsRunnerPrincipal, WindowsWorkerRepository } from '@forgemind/db';
import { canonicalizeWorkerProbeEvidence, isWindowsExecutionResult } from '@forgemind/core';

const deviceParams = z.object({ deviceId: z.string().uuid() });
const enrollment = z.object({ deviceId: z.string().uuid(), expiresInMinutes: z.number().int().min(1).max(60).default(10) });
const redeem = z.object({ code: z.string().min(32).max(128) });
const session = z.object({ expiresInMinutes: z.number().int().min(1).max(720) });
const heartbeat = z.object({ sessionId: z.string().uuid(), leaseId: z.string().uuid().optional(), leaseSeconds: z.number().int().min(15).max(300).default(60) });
const claim = z.object({ sessionId: z.string().uuid(), requestId: z.string().min(8).max(128), leaseSeconds: z.number().int().min(15).max(300).default(60) });
const deviceRegistration = z.object({
  runnerVersion: z.string().min(1).max(128), displayName: z.string().min(1).max(200),
  capabilities: z.array(z.object({ key: z.string().min(1), version: z.string().min(1).optional() })),
  probeEvidence: z.array(z.object({ schemaVersion: z.literal(1), capability: z.object({ key: z.string().min(1), version: z.string().min(1).optional() }), status: z.enum(['supported', 'unsupported', 'error']), probedAt: z.string().datetime(), probeVersion: z.string().min(1), summary: z.string().min(1), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i) }))
}).superRefine((input, context) => {
  const identity = (capability: { key: string; version?: string }) => `${capability.key}\u0000${capability.version ?? ''}`;
  const capabilityIds = input.capabilities.map(identity);
  const evidenceIds = input.probeEvidence.map(({ capability }) => identity(capability));
  if (new Set(capabilityIds).size !== capabilityIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities'], message: 'Capabilities must be unique.' });
  if (new Set(evidenceIds).size !== evidenceIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence'], message: 'Probe evidence must be unique.' });
  for (const capabilityId of capabilityIds) {
    const matching = input.probeEvidence.filter((evidence) => identity(evidence.capability) === capabilityId);
    if (matching.length !== 1 || matching[0]?.status !== 'supported') context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence'], message: 'Every advertised capability requires one successful matching probe.' });
  }
  if (evidenceIds.some((evidenceId) => !capabilityIds.includes(evidenceId))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence'], message: 'Probe evidence must match an advertised capability.' });
  for (const [index, evidence] of input.probeEvidence.entries()) {
    const expectedHash = createHash('sha256').update(canonicalizeWorkerProbeEvidence(evidence)).digest('hex');
    if (evidence.evidenceHash.toLowerCase() !== expectedHash) context.addIssue({ code: z.ZodIssueCode.custom, path: ['probeEvidence', index, 'evidenceHash'], message: 'Probe evidence hash is invalid.' });
  }
});
const sessionControl = z.object({ sessionId: z.string().uuid() });
const controlQuery = z.object({ sessionId: z.string().uuid(), leaseId: z.string().uuid().optional() });

export function registerWindowsRunnerRoutes(app: FastifyInstance, repository: ForgeMindRepository, credentials: WindowsRunnerCredentialAdapter, workers: WindowsWorkerRepository) {
  app.post('/api/windows-runner/enrollments', async (request) => {
    const input = enrollment.parse(request.body);
    return credentials.createEnrollment(input.deviceId, new Date(Date.now() + input.expiresInMinutes * 60_000));
  });
  app.post('/api/windows-runner/enroll', async (request, reply) => {
    try {
      const result = await credentials.redeemEnrollment(redeem.parse(request.body).code);
      return result;
    } catch { return reply.code(401).send({ error: 'Enrollment code is invalid, expired, or already used.' }); }
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
    const sessionId = await workers.startManualSession(principal.deviceId, new Date(Date.now() + input.expiresInMinutes * 60_000));
    await repository.writeAudit({ actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_session_started', payload: { deviceId: principal.deviceId, sessionId } });
    return { sessionId };
  });
  app.put('/api/windows-runner/device', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request); const parsed = deviceRegistration.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Capabilities require unique, successful matching local probe evidence.' });
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
  app.post('/api/windows-runner/device/heartbeat', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request); const input = heartbeat.parse(request.body);
    const accepted = await workers.heartbeat(input.sessionId, input.leaseId, input.leaseSeconds, principal.deviceId);
    return accepted ? { accepted, deviceId: principal.deviceId } : reply.code(409).send({ error: 'Session or lease is not active.' });
  });
  app.post('/api/windows-runner/device/lease', { preHandler: runnerAuth(credentials) }, async (request) => {
    const principal = runnerPrincipal(request); const input = claim.parse(request.body);
    return (await workers.claimCompatible(input.sessionId, input.leaseSeconds, input.requestId, principal.deviceId)) ?? { job: null, lease: null };
  });
  app.post('/api/windows-runner/device/result', { preHandler: runnerAuth(credentials) }, async (request, reply) => {
    const principal = runnerPrincipal(request);
    if (!isWindowsExecutionResult(request.body) || request.body.deviceId !== principal.deviceId) return reply.code(400).send({ error: 'Invalid execution result.' });
    const accepted = await workers.submitResult(principal.deviceId, request.body);
    if (!accepted) return reply.code(409).send({ error: 'Execution lease is not active for this device.' });
    await repository.writeAudit({ actorType: 'system', actorId: principal.deviceId, eventType: 'windows_runner_result_submitted', taskId: request.body.taskId, projectId: request.body.projectId, payload: { deviceId: principal.deviceId, jobId: request.body.jobId, leaseId: request.body.leaseId, status: request.body.status, commitSha: request.body.commitSha } });
    return { accepted: true };
  });
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
