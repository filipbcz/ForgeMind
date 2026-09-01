import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerWindowsRunnerRoutes } from './windows-runner-routes.js';

describe('Windows runner enrollment API', () => {
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
});
