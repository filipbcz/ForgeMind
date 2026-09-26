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
    await runManualSession(transport, { deviceId: 'device', credential: 'secret' }, { projectIds: ['11111111-1111-4111-8111-111111111111'], pollIntervalMs: 0, onClaim });
    expect(calls).toEqual(expect.arrayContaining(['/api/windows-runner/device/session', '/api/windows-runner/device/heartbeat', '/api/windows-runner/device/lease', '/api/windows-runner/device/control']));
    expect(onClaim).toHaveBeenCalledOnce();
    expect(request.mock.calls.every((call) => String(call[0]).startsWith('https://'))).toBe(true);
    expect(calls).not.toContain('/api/windows-runner/device/session/stop');
    const lifecycleBodies = request.mock.calls
      .filter(([input]) => /\/(?:heartbeat|lease)$/.test(new URL(String(input)).pathname))
      .map(([, init]) => JSON.parse(String(init?.body)) as { leaseSeconds?: number });
    expect(lifecycleBodies.every(({ leaseSeconds }) => leaseSeconds === 300)).toBe(true);
  });

  it('sends an explicit operator abort to the cancellation endpoint', async () => {
    const controller = new AbortController(); const calls: string[] = [];
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const path = new URL(String(input)).pathname; calls.push(path);
      const body = path.endsWith('/session') ? { sessionId: '11111111-1111-4111-8111-111111111111' }
        : path.includes('/control') ? { deviceStatus: 'idle', sessionStatus: 'active' }
        : path.endsWith('/lease') ? { job: null, lease: null } : { accepted: true };
      if (path.endsWith('/heartbeat')) controller.abort();
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await runManualSession(new WindowsRunnerTransport('https://forgemind.test', request as typeof fetch),
      { deviceId: 'device', credential: 'secret' }, { projectIds: ['11111111-1111-4111-8111-111111111111'],
        pollIntervalMs: 1, signal: controller.signal, onClaim: async () => undefined });
    expect(calls).toContain('/api/windows-runner/device/session/stop');
  });

  it('rejects non-TLS control plane URLs', () => {
    expect(() => new WindowsRunnerTransport('http://forgemind.test')).toThrow(/HTTPS/);
  });

  it('polls control while a claim runs and aborts it when remote stop is requested', async () => {
    let controls = 0;
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const body = url.endsWith('/session') ? { sessionId: '11111111-1111-4111-8111-111111111111' }
        : url.includes('/control') ? { deviceStatus: 'running', sessionStatus: controls++ === 0 ? 'active' : 'cancelled' }
        : url.endsWith('/lease') ? { job: { id: 'job' }, lease: { id: '22222222-2222-4222-8222-222222222222' } }
        : { accepted: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const transport = new WindowsRunnerTransport('https://forgemind.test', request as typeof fetch);
    const observedAbort = vi.fn();
    await runManualSession(transport, { deviceId: 'device', credential: 'secret' }, {
      projectIds: ['11111111-1111-4111-8111-111111111111'], pollIntervalMs: 1,
      onClaim: async (_claim, { signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => { observedAbort(); resolve(); }, { once: true }))
    });
    expect(observedAbort).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([input]) => String(input).includes('/control')).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a running claim alive across transient control-plane failures', async () => {
    let controls = 0; let claimed = false;
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/session')) return new Response(JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' }), { status: 200 });
      if (url.endsWith('/lease')) {
        if (claimed) return new Response(JSON.stringify({ job: null, lease: null }), { status: 200 });
        claimed = true; return new Response(JSON.stringify({ job: { id: 'job' }, lease: { id: '22222222-2222-4222-8222-222222222222' } }), { status: 200 });
      }
      if (url.includes('/control')) {
        controls += 1;
        if (controls === 2) throw new Error('temporary deploy interruption');
        return new Response(JSON.stringify({ deviceStatus: 'running', sessionStatus: controls >= 4 ? 'cancelled' : 'active' }), { status: 200 });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    });
    const transport = new WindowsRunnerTransport('https://forgemind.test', request as typeof fetch);
    let abortedBeforeCompletion = false;
    await runManualSession(transport, { deviceId: 'device', credential: 'secret' }, {
      projectIds: ['11111111-1111-4111-8111-111111111111'], pollIntervalMs: 1, controlFailureGraceMs: 100,
      onClaim: async (_claim, { signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        abortedBeforeCompletion = signal.aborted;
      }
    });
    expect(abortedBeforeCompletion).toBe(false);
    expect(controls).toBeGreaterThanOrEqual(3);
  });
});
