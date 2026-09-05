import { randomUUID } from 'node:crypto';
import type { RunnerCredential } from './credential-store.js';
import type { WindowsRunnerTransport, LeaseClaim } from './transport.js';

export interface SessionOptions {
  projectIds: string[];
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onClaim: (claim: LeaseClaim, context: { sessionId: string; signal: AbortSignal }) => Promise<void>;
}

/** A renewable foreground session. Nothing is claimed before this method is explicitly called. */
export async function runManualSession(transport: WindowsRunnerTransport, auth: RunnerCredential, options: SessionOptions): Promise<string> {
  const { sessionId } = await transport.startSession(auth, options.projectIds);
  const local = new AbortController();
  const stop = () => local.abort(); options.signal?.addEventListener('abort', stop, { once: true });
  const interval = options.pollIntervalMs ?? 5_000;
  let draining = false; let leaseId: string | undefined;
  try {
    while (!local.signal.aborted) {
      const state = await transport.control(auth, sessionId, leaseId);
      if (['cancelled', 'expired', 'closed'].includes(state.sessionStatus) || state.leaseStatus === 'cancelled' || state.jobStatus === 'cancelled') break;
      draining ||= state.sessionStatus === 'draining';
      await transport.heartbeat(auth, sessionId, leaseId);
      if (draining && !leaseId) break;
      if (!leaseId && !draining) {
        const claim = await transport.claim(auth, sessionId, randomUUID());
        leaseId = claim.lease?.id;
        if (claim.lease) {
          const activeLeaseId = claim.lease.id;
          const execution = new AbortController();
          const abortExecution = () => execution.abort();
          local.signal.addEventListener('abort', abortExecution, { once: true });
          let executionFinished = false;
          const monitor = (async () => {
            while (!executionFinished && !execution.signal.aborted) {
              await delay(Math.min(interval, 15_000), execution.signal);
              if (executionFinished || execution.signal.aborted) break;
              try {
                const active = await transport.control(auth, sessionId, activeLeaseId);
                if (['cancelled', 'expired', 'closed'].includes(active.sessionStatus)
                  || active.leaseStatus === 'cancelled' || active.jobStatus === 'cancelled') {
                  execution.abort();
                  local.abort();
                  break;
                }
                await transport.heartbeat(auth, sessionId, activeLeaseId);
              } catch {
                execution.abort();
                local.abort();
                break;
              }
            }
          })();
          try {
            await options.onClaim(claim, { sessionId, signal: execution.signal });
          } finally {
            executionFinished = true;
            execution.abort();
            local.signal.removeEventListener('abort', abortExecution);
            await monitor;
            leaseId = undefined;
          }
        }
      }
      await delay(interval, local.signal);
    }
  } finally {
    options.signal?.removeEventListener('abort', stop);
    try { await transport.stop(auth, sessionId); } catch { /* server may already have cancelled or expired it */ }
  }
  return sessionId;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
}
