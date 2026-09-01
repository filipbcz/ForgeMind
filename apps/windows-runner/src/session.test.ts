import { describe, expect, it, vi } from 'vitest';
import { runManualSession } from './session.js';
import { WindowsRunnerTransport } from './transport.js';

describe('Windows runner manual session', () => {
  it('uses HTTPS, publishes no claim before manual start, then heartbeats and honors cancellation', async () => {
    const calls: string[] = []; let controls = 0;
    const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input); calls.push(new URL(url).pathname);
      const body = url.endsWith('/session') ? { sessionId: '11111111-1111-4111-8111-111111111111' }
        : url.includes('/control') ? { deviceStatus: 'idle', sessionStatus: controls++ ? 'cancelled' : 'active' }
        : url.endsWith('/lease') ? { job: { id: 'job' }, lease: { id: '22222222-2222-4222-8222-222222222222' } }
        : { accepted: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const transport = new WindowsRunnerTransport('https://forgemind.test', request as typeof fetch);
    expect(calls).toEqual([]);
    const onClaim = vi.fn(async () => undefined);
    await runManualSession(transport, { deviceId: 'device', credential: 'secret' }, { durationMinutes: 5, pollIntervalMs: 0, onClaim });
    expect(calls).toEqual(expect.arrayContaining(['/api/windows-runner/device/session', '/api/windows-runner/device/heartbeat', '/api/windows-runner/device/lease', '/api/windows-runner/device/control']));
    expect(onClaim).toHaveBeenCalledOnce();
    expect(request.mock.calls.every((call) => String(call[0]).startsWith('https://'))).toBe(true);
  });

  it('rejects non-TLS control plane URLs', () => {
    expect(() => new WindowsRunnerTransport('http://forgemind.test')).toThrow(/HTTPS/);
  });
});
