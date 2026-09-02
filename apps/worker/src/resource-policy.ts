import { rm, stat, statfs, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseAgentConfigYaml } from '@forgemind/config';

const MB = 1024 * 1024;

export interface WorkerResourcePolicy {
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

function defaultWorkerResourcePolicy(): WorkerResourcePolicy {
  return {
    minFreeSpaceMb: 0,
    retentionDays: 14
  };
}
