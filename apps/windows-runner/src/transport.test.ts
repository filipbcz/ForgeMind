import { describe, expect, it, vi } from 'vitest';
import { WindowsRunnerTransport } from './transport.js';

describe('Windows runner transport', () => {
  it('returns parsed JSON and applies a request timeout', async () => {
    const request = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    });
    const transport = new WindowsRunnerTransport('https://forgemind.test', request as typeof fetch);
    await expect(transport.submitResult({ deviceId: 'device', credential: 'secret' }, {} as never)).resolves.toEqual({ accepted: true });
  });

  it('preserves a bounded redacted server diagnostic', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'token=ghp_abcdefghijklmnopqrstuvwxyz123456 failed validation' }), { status: 413 }));
    const transport = new WindowsRunnerTransport('https://forgemind.test', request as typeof fetch);
    await expect(transport.submitResult({ deviceId: 'device', credential: 'secret' }, {} as never))
      .rejects.toThrow('ForgeMind API request failed (413): token=[secret-redacted] failed validation');
  });

  it('rejects non-JSON success responses explicitly', async () => {
    const transport = new WindowsRunnerTransport('https://forgemind.test', vi.fn(async () => new Response('proxy page', { status: 200 })) as typeof fetch);
    await expect(transport.control({ deviceId: 'device', credential: 'secret' }, 'session')).rejects.toThrow('invalid JSON');
  });
});
