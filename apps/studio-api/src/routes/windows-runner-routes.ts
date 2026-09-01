import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ForgeMindRepository, WindowsRunnerCredentialAdapter, WindowsRunnerPrincipal, WindowsWorkerRepository } from '@forgemind/db';
import { isWindowsExecutionResult } from '@forgemind/core';

const deviceParams = z.object({ deviceId: z.string().uuid() });
const enrollment = z.object({ deviceId: z.string().uuid(), expiresInMinutes: z.number().int().min(1).max(60).default(10) });
const redeem = z.object({ code: z.string().min(32).max(128) });
const session = z.object({ expiresInMinutes: z.number().int().min(1).max(720) });
const heartbeat = z.object({ sessionId: z.string().uuid(), leaseId: z.string().uuid().optional(), leaseSeconds: z.number().int().min(15).max(300).default(60) });
const claim = z.object({ sessionId: z.string().uuid(), requestId: z.string().min(8).max(128), leaseSeconds: z.number().int().min(15).max(300).default(60) });

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
