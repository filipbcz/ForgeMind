import { describe, expect, it, vi } from 'vitest';
import type { WindowsAuthoringProgress } from '@forgemind/core';
import { CoalescedAuthoringProgressPublisher } from './progress-publisher.js';

const progress = (phase: WindowsAuthoringProgress['phase']): WindowsAuthoringProgress => ({
  schemaVersion: 1, jobId: 'job', leaseId: 'lease', sessionId: 'session', phase,
  checkpoint: { resultTreeSha: 'a'.repeat(40), updatedAt: '2026-09-26T00:00:00.000Z', resumedFromCheckpoint: false },
  log: { text: phase, sizeBytes: Buffer.byteLength(phase), sha256: 'b'.repeat(64) }
});

describe('CoalescedAuthoringProgressPublisher', () => {
  it('keeps only the newest update behind an in-flight delivery and flushes it', async () => {
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn().mockImplementationOnce(async () => first).mockResolvedValue(undefined);
    const publisher = new CoalescedAuthoringProgressPublisher(send, 0);
    await publisher.publish(progress('checkout'));
    await publisher.publish(progress('author'));
    await publisher.publish(progress('verify'));
    release!();
    await publisher.flush();
    expect(send.mock.calls.map(([item]) => item.phase)).toEqual(['checkout', 'verify']);
  });

  it('does not fail authoring when telemetry delivery fails', async () => {
    const publisher = new CoalescedAuthoringProgressPublisher(vi.fn(async () => { throw new Error('429'); }), 0);
    await publisher.publish(progress('author'));
    await expect(publisher.flush()).resolves.toBeUndefined();
  });
});
