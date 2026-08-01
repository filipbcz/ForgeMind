import { runDatabaseWorkerOnce } from './db-worker.js';

export interface WorkerDaemonOptions {
  pollDelayMs?: number;
  stopWhenIdle?: boolean;
  runOnce?: () => Promise<Awaited<ReturnType<typeof runDatabaseWorkerOnce>>>;
  signalSource?: WorkerSignalSource;
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
  const stopWhenIdle = options.stopWhenIdle ?? false;
  const signalSource = options.signalSource ?? process;

  let processedCount = 0;
  let idlePollCount = 0;
  let drainRequested = false;
  const requestDrain = () => {
    drainRequested = true;
  };
  signalSource.on('SIGTERM', requestDrain);
  signalSource.on('SIGINT', requestDrain);

  try {
    while (!drainRequested) {
      const result = await runOnce();

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

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
