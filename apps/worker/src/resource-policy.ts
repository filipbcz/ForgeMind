import { spawnSync } from 'node:child_process';
import { rm, stat, statfs, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseAgentConfigYaml } from '@forgemind/config';

const MB = 1024 * 1024;
let cachedNetworkIsolationSupported: boolean | undefined;

export interface WorkerResourcePolicy {
  allowNetwork: boolean;
  cpuLimitSeconds?: number;
  memoryLimitMb?: number;
  diskLimitMb?: number;
  minFreeSpaceMb: number;
  retentionDays: number;
}

export interface WorkerResourceDenial {
  policy: 'resource_policy' | 'network_policy';
  reason: string;
  command?: string;
}

export class WorkerResourcePolicyError extends Error {
  constructor(
    message: string,
    readonly denial: WorkerResourceDenial
  ) {
    super(message);
    this.name = 'WorkerResourcePolicyError';
  }
}

export function resolveWorkerResourcePolicy(configYaml?: string): WorkerResourcePolicy {
  if (!configYaml) return defaultWorkerResourcePolicy();

  try {
    const config = parseAgentConfigYaml(configYaml);
    return {
      allowNetwork: config.sandbox.allow_network,
      cpuLimitSeconds: config.resources.cpu_limit_seconds,
      memoryLimitMb: config.resources.memory_limit_mb,
      diskLimitMb: config.resources.disk_limit_mb,
      minFreeSpaceMb: config.resources.min_free_space_mb,
      retentionDays: config.resources.retention_days
    };
  } catch (error) {
    throw new WorkerResourcePolicyError(
      `Worker resource policy configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { policy: 'resource_policy', reason: 'invalid_resource_policy_config' }
    );
  }
}

export async function assertFreeSpaceForWorker(path: string, policy: WorkerResourcePolicy): Promise<void> {
  if (policy.minFreeSpaceMb <= 0) return;

  let stats: Awaited<ReturnType<typeof statfs>>;
  try {
    stats = await statfs(await nearestExistingPath(path));
  } catch (error) {
    throw new WorkerResourcePolicyError(
      `Worker resource policy could not verify free disk space for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { policy: 'resource_policy', reason: 'free_space_check_unavailable' }
    );
  }

  const availableMb = Math.floor(Number(stats.bavail) * Number(stats.bsize) / MB);
  if (availableMb < policy.minFreeSpaceMb) {
    throw new WorkerResourcePolicyError(
      `Worker refused to start task because free disk space is below policy: ${availableMb} MB available, ${policy.minFreeSpaceMb} MB required.`,
      { policy: 'resource_policy', reason: 'free_space_below_policy' }
    );
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export function prepareResourcePolicyCommand(command: string, policy?: WorkerResourcePolicy): string {
  if (!policy) return command;

  const hasResourceLimit = Boolean(policy.cpuLimitSeconds || policy.memoryLimitMb || policy.diskLimitMb);
  if (process.platform === 'win32') {
    if (hasResourceLimit) {
      throw new WorkerResourcePolicyError(
        'Configured worker CPU, memory, or disk limits are unsupported on this worker runtime.',
        { policy: 'resource_policy', reason: 'resource_limits_unsupported', command }
      );
    }
    if (!policy.allowNetwork) {
      throw new WorkerResourcePolicyError(
        'Configured worker network isolation is unsupported on this worker runtime.',
        { policy: 'network_policy', reason: 'network_isolation_unsupported', command }
      );
    }
    return command;
  }

  if (policy.diskLimitMb) {
    throw new WorkerResourcePolicyError(
      'Configured worker disk quota is unsupported on this worker runtime.',
      { policy: 'resource_policy', reason: 'disk_limit_unsupported', command }
    );
  }

  const prefixes: string[] = [];
  if (policy.cpuLimitSeconds) prefixes.push(`ulimit -t ${policy.cpuLimitSeconds}`);
  if (policy.memoryLimitMb) prefixes.push(`ulimit -v ${policy.memoryLimitMb * 1024}`);
  const limitedCommand = prefixes.length > 0 ? `${prefixes.join('; ')}; ${command}` : command;
  if (policy.allowNetwork) return limitedCommand;
  if (isNetworkIsolationSupported()) return `unshare -n /bin/sh -lc ${shellQuote(limitedCommand)}`;
  throw new WorkerResourcePolicyError(
    `Configured worker network isolation is unsupported on this worker runtime, so validation command execution is denied: ${command}`,
    { policy: 'network_policy', reason: 'network_isolation_unsupported', command }
  );
}

export function isNetworkIsolationSupported(): boolean {
  if (process.platform === 'win32') return false;
  if (cachedNetworkIsolationSupported === undefined) {
    const result = spawnSync('unshare', ['-n', 'true'], {
      stdio: 'ignore',
      timeout: 5_000
    });
    cachedNetworkIsolationSupported = result.status === 0;
  }
  return cachedNetworkIsolationSupported;
}

export async function cleanupExpiredWorkerArtifacts(input: {
  workspaceRoot: string;
  activeTaskIds: ReadonlySet<string>;
  policy: WorkerResourcePolicy;
  now?: Date;
}): Promise<{ removed: string[]; kept: string[] }> {
  if (input.policy.retentionDays <= 0) return { removed: [], kept: [] };

  const cutoffMs = (input.now?.getTime() ?? Date.now()) - input.policy.retentionDays * 24 * 60 * 60 * 1000;
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(input.workspaceRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return { removed: [], kept: [] };
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(input.workspaceRoot, entry.name);
    if (input.activeTaskIds.has(entry.name)) {
      kept.push(path);
      continue;
    }

    try {
      const metadata = await stat(path);
      if (metadata.mtimeMs >= cutoffMs) {
        kept.push(path);
        continue;
      }

      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      kept.push(path);
    }
  }

  return { removed, kept };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultWorkerResourcePolicy(): WorkerResourcePolicy {
  return {
    allowNetwork: false,
    minFreeSpaceMb: 0,
    retentionDays: 14
  };
}
