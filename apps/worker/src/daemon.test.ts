import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
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
    expect(result.drained).toBe(false);
  });

  it('finishes the claimed task after SIGTERM and does not claim another one', async () => {
    const signalSource = new EventEmitter();
    const runOnce = vi.fn().mockImplementation(async () => {
      signalSource.emit('SIGTERM');
      return { claimed: true };
    });

    const result = await runWorkerDaemon({ runOnce, signalSource, pollDelayMs: 0 });

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processedCount: 1, idlePollCount: 0, drained: true });
  });
});
