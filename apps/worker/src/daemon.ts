import { runDatabaseWorkerOnce } from './db-worker.js';

export interface WorkerDaemonOptions {
  pollDelayMs?: number;
  stopWhenIdle?: boolean;
  runOnce?: () => Promise<Awaited<ReturnType<typeof runDatabaseWorkerOnce>>>;
}

export interface WorkerDaemonResult {
  processedCount: number;
  idlePollCount: number;
}

export async function runWorkerDaemon(options: WorkerDaemonOptions = {}): Promise<WorkerDaemonResult> {
  const runOnce = options.runOnce ?? runDatabaseWorkerOnce;
  const pollDelayMs = options.pollDelayMs ?? 2500;
  const stopWhenIdle = options.stopWhenIdle ?? false;

  let processedCount = 0;
  let idlePollCount = 0;

  while (true) {
    const result = await runOnce();

    if (!result.claimed) {
      idlePollCount += 1;

      if (stopWhenIdle) {
        return {
          processedCount,
          idlePollCount
        };
      }

      await delay(pollDelayMs);
      continue;
    }

    processedCount += 1;
    idlePollCount = 0;
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}