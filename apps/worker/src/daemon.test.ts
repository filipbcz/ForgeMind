import { describe, expect, it, vi } from 'vitest';
import { runWorkerDaemon } from './daemon.js';

describe('worker daemon', () => {
  it('keeps running until no task is claimed when stopWhenIdle is enabled', async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({ claimed: true })
      .mockResolvedValueOnce({ claimed: true })
      .mockResolvedValueOnce({ claimed: false });

    const result = await runWorkerDaemon({
      runOnce,
      stopWhenIdle: true,
      pollDelayMs: 0
    });

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(result.processedCount).toBe(2);
    expect(result.idlePollCount).toBe(1);
  });
});