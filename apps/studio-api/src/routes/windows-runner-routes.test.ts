import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeWorkerProbeEvidence } from '@forgemind/core';
import { registerWindowsRunnerRoutes } from './windows-runner-routes.js';

function probeEvidence(capability: { key: string; version?: string }, status: 'supported' | 'unsupported' | 'error' = 'supported', overrides: Record<string, unknown> = {}) {
  const evidence = { capability, status, probedAt: '2026-09-01T00:00:00.000Z', probeVersion: '1', summary: status === 'supported' ? 'Local probe succeeded.' : 'Local probe failed.' };
  return { schemaVersion: 1, ...evidence, evidenceHash: createHash('sha256').update(canonicalizeWorkerProbeEvidence(evidence)).digest('hex'), ...overrides };
}

describe('Windows runner enrollment API', () => {
  it('creates an owner-controlled enrollment for a new offline device identity', async () => {
    const app = Fastify();
    const credentials: any = { createEnrollment: vi.fn(async () => ({ enrollmentId: 'enrollment_1', code: 'secret-code', expiresAt: '2026-09-01T00:10:00.000Z' })) };
    registerWindowsRunnerRoutes(app, {} as any, credentials, {} as any);
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const response = await app.inject({ method: 'POST', url: '/api/windows-runner/enrollments', payload: { deviceId, displayName: 'Build PC', expiresInMinutes: 10 } });
    expect(response.statusCode).toBe(200);
    expect(credentials.createEnrollment).toHaveBeenCalledWith(deviceId, expect.any(Date), 'Build PC');
  });

  it('accepts bounded hash-verified evidence idempotently and rejects prohibited paths', async () => {
    const app = Fastify(); const deviceId = '11111111-1111-4111-8111-111111111111';
    const credentials: any = { authenticate: vi.fn(async () => ({ deviceId })) }; const workers: any = { uploadEvidence: vi.fn(async () => 'duplicate') };
    registerWindowsRunnerRoutes(app, {} as any, credentials, workers);
    const text = 'fixture passed'; const content = Buffer.from('report');
    const payload = { schemaVersion: 1, jobId: '22222222-2222-4222-8222-222222222222', leaseId: '33333333-3333-4333-8333-333333333333', inputHash: 'a'.repeat(64), commitSha: 'b'.repeat(64),
      log: { text, sizeBytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }, artifacts: [{ name: 'report', relativePath: 'results/report.txt', sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'), contentBase64: content.toString('base64'), criterion: 'Fixture passes' }] };
    const response = await app.inject({ method: 'POST', url: '/api/windows-runner/device/evidence', headers: { authorization: 'Bearer token' }, payload });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ accepted: true, duplicate: true });
    expect(workers.uploadEvidence).toHaveBeenCalledWith(deviceId, payload);
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/evidence', headers: { authorization: 'Bearer token' }, payload: { ...payload, artifacts: [{ ...payload.artifacts[0], relativePath: '.git/config' }] } })).statusCode).toBe(400);
    const secret = Buffer.from('token=ghp_abcdefghijklmnopqrstuvwxyz123456');
    const secretArtifact = { ...payload.artifacts[0], sizeBytes: secret.length, sha256: createHash('sha256').update(secret).digest('hex'), contentBase64: secret.toString('base64') };
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/evidence', headers: { authorization: 'Bearer token' }, payload: { ...payload, artifacts: [secretArtifact] } })).statusCode).toBe(400);
  });
  it('rejects device operations without a scoped credential', async () => {
    const app = Fastify();
    const credentials: any = { authenticate: vi.fn(async () => undefined) };
    registerWindowsRunnerRoutes(app, {} as any, credentials, {} as any);
    const response = await app.inject({ method: 'POST', url: '/api/windows-runner/device/heartbeat', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('uses only the authenticated device for sessions and writes an audit event', async () => {
    const app = Fastify();
    const repository: any = { writeAudit: vi.fn(async () => undefined) };
    const credentials: any = { authenticate: vi.fn(async () => ({ credentialId: 'credential_1', deviceId: '11111111-1111-4111-8111-111111111111', scope: 'windows_runner:device_operations' })) };
    const workers: any = { startManualSession: vi.fn(async () => 'session_1') };
    registerWindowsRunnerRoutes(app, repository, credentials, workers);
    const response = await app.inject({ method: 'POST', url: '/api/windows-runner/device/session', headers: { authorization: 'Bearer device-token' }, payload: { expiresInMinutes: 30 } });
    expect(response.statusCode).toBe(200);
    expect(workers.startManualSession).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', expect.any(Date));
    expect(repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'windows_runner_session_started', actorId: '11111111-1111-4111-8111-111111111111' }));
  });

  it('redeems enrollment through the atomic credential adapter without route-level audit writes', async () => {
    const app = Fastify();
    const repository: any = { writeAudit: vi.fn(async () => undefined) };
    const credentials: any = { redeemEnrollment: vi.fn(async () => ({ deviceId: '11111111-1111-4111-8111-111111111111', credential: 'new-secret' })) };
    registerWindowsRunnerRoutes(app, repository, credentials, {} as any);
    const response = await app.inject({ method: 'POST', url: '/api/windows-runner/enroll', payload: { code: 'a'.repeat(32) } });
    expect(response.statusCode).toBe(200);
    expect(credentials.redeemEnrollment).toHaveBeenCalledWith('a'.repeat(32));
    expect(repository.writeAudit).not.toHaveBeenCalled();
  });

  it('binds probe publication and control actions to the authenticated device', async () => {
    const app = Fastify();
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const credentials: any = { authenticate: vi.fn(async () => ({ credentialId: 'credential_1', deviceId, scope: 'windows_runner:device_operations' })) };
    const workers: any = {
      registerDevice: vi.fn(async () => undefined),
      getControlState: vi.fn(async () => ({ deviceStatus: 'idle', sessionStatus: 'active' })),
      drainSession: vi.fn(async () => undefined)
    };
    registerWindowsRunnerRoutes(app, {} as any, credentials, workers);
    const headers = { authorization: 'Bearer device-token' };
    const evidence = probeEvidence({ key: 'windows' });
    expect((await app.inject({ method: 'PUT', url: '/api/windows-runner/device', headers, payload: { runnerVersion: '0.1.0', displayName: 'Runner', capabilities: [{ key: 'windows' }], probeEvidence: [evidence] } })).statusCode).toBe(200);
    expect(workers.registerDevice).toHaveBeenCalledWith(expect.objectContaining({ id: deviceId, capabilities: [{ key: 'windows' }], probeEvidence: [evidence] }));
    const sessionId = '22222222-2222-4222-8222-222222222222';
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/session/drain', headers, payload: { sessionId } })).statusCode).toBe(200);
    expect(workers.getControlState).toHaveBeenCalledWith(deviceId, sessionId);
    expect(workers.drainSession).toHaveBeenCalledWith(sessionId);
  });

  it.each([
    ['missing evidence', [{ key: 'unreal-engine', version: '5.8' }], []],
    ['unsuccessful evidence', [{ key: 'unreal-engine', version: '5.8' }], [{ schemaVersion: 1, capability: { key: 'unreal-engine', version: '5.8' }, status: 'unsupported', probedAt: '2026-09-01T00:00:00.000Z', probeVersion: '1', summary: 'Not installed.', evidenceHash: 'a'.repeat(64) }]],
    ['mismatched evidence', [{ key: 'unreal-engine', version: '5.8' }], [{ schemaVersion: 1, capability: { key: 'windows' }, status: 'supported', probedAt: '2026-09-01T00:00:00.000Z', probeVersion: '1', summary: 'Windows detected.', evidenceHash: 'b'.repeat(64) }]],
    ['duplicate evidence', [{ key: 'unreal-engine', version: '5.8' }], [
      { schemaVersion: 1, capability: { key: 'unreal-engine', version: '5.8' }, status: 'supported', probedAt: '2026-09-01T00:00:00.000Z', probeVersion: '1', summary: 'Detected.', evidenceHash: 'c'.repeat(64) },
      { schemaVersion: 1, capability: { key: 'unreal-engine', version: '5.8' }, status: 'supported', probedAt: '2026-09-01T00:00:01.000Z', probeVersion: '1', summary: 'Detected twice.', evidenceHash: 'd'.repeat(64) }
    ]],
    ['an invalid evidence hash', [{ key: 'unreal-engine', version: '5.8' }], [probeEvidence({ key: 'unreal-engine', version: '5.8' }, 'supported', { evidenceHash: 'e'.repeat(64) })]]
  ])('rejects capability registration with %s', async (_name, capabilities, probeEvidence) => {
    const app = Fastify();
    const credentials: any = { authenticate: vi.fn(async () => ({ credentialId: 'credential_1', deviceId: '11111111-1111-4111-8111-111111111111', scope: 'windows_runner:device_operations' })) };
    const workers: any = { registerDevice: vi.fn(async () => undefined) };
    registerWindowsRunnerRoutes(app, {} as any, credentials, workers);
    const response = await app.inject({ method: 'PUT', url: '/api/windows-runner/device', headers: { authorization: 'Bearer device-token' }, payload: { runnerVersion: '0.1.0', displayName: 'Runner', capabilities, probeEvidence } });
    expect(response.statusCode).toBe(400);
    expect(workers.registerDevice).not.toHaveBeenCalled();
  });
});
