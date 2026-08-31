import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ForgeMindRepository } from '@forgemind/db';
import { toErrorMessage } from '@forgemind/shared';
import { cleanupExpiredWorkerArtifacts, type WorkerResourcePolicy } from '../resource-policy.js';

export class TaskCancellationError extends Error {
  constructor() {
    super('Task execution was cancelled by the user.');
    this.name = 'TaskCancellationError';
  }
}

export async function runWorkspaceRetentionCleanup(
  repository: ForgeMindRepository,
  workspaceRoot: string,
  currentTaskId: string,
  resourcePolicy: WorkerResourcePolicy
): Promise<void> {
  const tasks = await repository.listTasks();
  const activeTaskIds = new Set(
    tasks
      .filter((task) => !['completed', 'cancelled', 'failed', 'ready_for_user_review'].includes(task.status))
      .map((task) => task.id)
  );
  // Chat workspaces have their own lifecycle and must not be removed as expired task artifacts.
  activeTaskIds.add('chat');
  activeTaskIds.add(currentTaskId);
  await cleanupExpiredWorkerArtifacts({
    workspaceRoot,
    activeTaskIds,
    policy: resourcePolicy
  });
}

export async function cleanupCompletedTaskWorkspace(workspaceRoot: string, taskId: string): Promise<void> {
  const root = resolve(workspaceRoot);
  const workspacePath = resolve(root, taskId);
  const relativePath = relative(root, workspacePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    console.warn(`Refusing to remove completed task workspace outside the configured root: ${workspacePath}`);
    return;
  }

  try {
    await rm(workspacePath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Unable to remove completed task workspace ${workspacePath}: ${toErrorMessage(error)}`);
  }
}

export function startTaskCancellationWatcher(
  repository: Pick<ForgeMindRepository, 'getTask'>,
  taskId: string,
  controller: AbortController
): () => void {
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking || controller.signal.aborted) return;
    checking = true;
    try {
      const task = await repository.getTask(taskId);
      if (task?.status === 'cancelled') controller.abort(new TaskCancellationError());
    } catch {
      // A transient read failure must not terminate the worker; the next poll retries it.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void check(), 500);
  timer.unref?.();
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function throwIfTaskCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new TaskCancellationError();
}

export function startQueueClaimHeartbeat(
  repository: {
    refreshQueueJobClaim?: (queueJobId: string) => Promise<boolean>;
  },
  queueJobId: string | undefined,
  claimTimeoutMinutes: number
): () => void {
  if (!queueJobId || typeof repository.refreshQueueJobClaim !== 'function') {
    return () => undefined;
  }

  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, claimTimeoutMinutes * 20_000));
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void repository.refreshQueueJobClaim!(queueJobId)
      .then((refreshed) => {
        if (!refreshed) {
          stopped = true;
          clearInterval(timer);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, heartbeatIntervalMs);
  timer.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

export function startProjectAuditHeartbeat(
  repository: { refreshProjectAuditClaim?: (auditJobId: string) => Promise<boolean> },
  auditJobId: string,
  claimTimeoutMinutes: number
): () => void {
  if (typeof repository.refreshProjectAuditClaim !== 'function') return () => undefined;
  const heartbeatIntervalMs = Math.max(5_000, Math.min(30_000, claimTimeoutMinutes * 20_000));
  const timer = setInterval(() => {
    void repository.refreshProjectAuditClaim!(auditJobId).catch(() => undefined);
  }, heartbeatIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function installWorkerInterruptionRecovery(input: {
  repository: {
    interruptClaimedTask?: (input: {
      queueJobId: string;
      taskId: string;
      taskRunId: string;
      signal: 'SIGTERM' | 'SIGINT';
    }) => Promise<boolean>;
  };
  queueJobId: string | undefined;
  taskId: string;
  taskRunId: string;
  stopQueueHeartbeat: () => void;
  deferInterruptSignals: boolean;
}): () => void {
  if (input.deferInterruptSignals || !input.queueJobId || typeof input.repository.interruptClaimedTask !== 'function') {
    return () => undefined;
  }

  let stopped = false;
  let handlingSignal = false;
  const handleSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    if (stopped || handlingSignal) return;
    handlingSignal = true;
    input.stopQueueHeartbeat();
    const forcedExitTimer = setTimeout(() => process.exit(1), 8_000);
    forcedExitTimer.unref();
    void input.repository.interruptClaimedTask!({
      queueJobId: input.queueJobId!,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      signal
    }).finally(() => {
      clearTimeout(forcedExitTimer);
      process.exit(0);
    });
  };
  const handleSigterm = () => handleSignal('SIGTERM');
  const handleSigint = () => handleSignal('SIGINT');
  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);

  return () => {
    if (stopped) return;
    stopped = true;
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
  };
}

export function resolveWorkerWorkspaceRoot(): string {
  if (process.env.FORGEMIND_WORKSPACE_ROOT?.trim()) {
    return resolve(process.env.FORGEMIND_WORKSPACE_ROOT);
  }

  return join(tmpdir(), 'forgemind-workspaces');
}
