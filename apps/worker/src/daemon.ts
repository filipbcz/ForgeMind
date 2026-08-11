import { runDatabaseWorkerOnce } from './db-worker.js';

export interface WorkerDaemonOptions {
  pollDelayMs?: number;
  errorDelayMs?: number;
  stopWhenIdle?: boolean;
  runOnce?: () => Promise<Awaited<ReturnType<typeof runDatabaseWorkerOnce>>>;
  signalSource?: WorkerSignalSource;
  onError?: (error: Error, consecutiveErrorCount: number) => void | Promise<void>;
}

export interface WorkerDaemonResult {
  processedCount: number;
  idlePollCount: number;
  drained: boolean;
}

interface WorkerSignalSource {
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export async function runWorkerDaemon(options: WorkerDaemonOptions = {}): Promise<WorkerDaemonResult> {
  const runOnce = options.runOnce ?? (() => runDatabaseWorkerOnce({ deferInterruptSignals: true }));
  const pollDelayMs = options.pollDelayMs ?? 2500;
  const errorDelayMs = options.errorDelayMs ?? pollDelayMs;
  const stopWhenIdle = options.stopWhenIdle ?? false;
  const signalSource = options.signalSource ?? process;

  let processedCount = 0;
  let idlePollCount = 0;
  let drainRequested = false;
  let consecutiveErrorCount = 0;
  const requestDrain = () => {
    drainRequested = true;
  };
  signalSource.on('SIGTERM', requestDrain);
  signalSource.on('SIGINT', requestDrain);

  try {
    while (!drainRequested) {
      let result: Awaited<ReturnType<typeof runDatabaseWorkerOnce>>;
      try {
        result = await runOnce();
        consecutiveErrorCount = 0;
      } catch (error) {
        consecutiveErrorCount += 1;
        const sanitized = sanitizeDaemonError(error);
        if (options.onError) {
          await options.onError(sanitized, consecutiveErrorCount);
        } else {
          console.error(`Worker daemon poll failed; retrying (${consecutiveErrorCount}): ${sanitized.message}`);
        }
        await delay(errorDelayMs);
        continue;
      }

      if (!result.claimed) {
        idlePollCount += 1;

        if (stopWhenIdle) {
          break;
        }

        await delay(pollDelayMs);
        continue;
      }

      processedCount += 1;
      idlePollCount = 0;
    }
  } finally {
    signalSource.off('SIGTERM', requestDrain);
    signalSource.off('SIGINT', requestDrain);
  }

  return { processedCount, idlePollCount, drained: drainRequested };
}

function sanitizeDaemonError(error: unknown): Error {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s]+@/gi, '$1[credential-redacted]@');
  return new Error(message);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
