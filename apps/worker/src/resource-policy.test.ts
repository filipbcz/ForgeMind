import { access, mkdir, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertFreeSpaceForWorker,
  cleanupExpiredWorkerArtifacts,
  resolveWorkerResourcePolicy,
  type WorkerResourcePolicy
} from './resource-policy.js';

const basePolicy: WorkerResourcePolicy = {
  minFreeSpaceMb: 0,
  retentionDays: 14
};

describe('worker storage policy', () => {
  it('refuses to start when free disk space is below the operational minimum', async () => {
    await expect(assertFreeSpaceForWorker(tmpdir(), {
      ...basePolicy,
      minFreeSpaceMb: Number.MAX_SAFE_INTEGER
    })).rejects.toThrow('free disk space is below policy');
  });

  it('removes expired task artifacts without deleting active or fresh work', async () => {
    const workspaceRoot = join(tmpdir(), `forgemind-retention-${randomUUID()}`);
    const expiredTask = join(workspaceRoot, 'task_expired');
    const activeTask = join(workspaceRoot, 'task_active');
    const freshTask = join(workspaceRoot, 'task_fresh');
    await mkdir(expiredTask, { recursive: true });
    await mkdir(activeTask, { recursive: true });
    await mkdir(freshTask, { recursive: true });
    await writeFile(join(expiredTask, 'artifact.txt'), 'old\n');
    await writeFile(join(activeTask, 'artifact.txt'), 'active\n');
    await writeFile(join(freshTask, 'artifact.txt'), 'fresh\n');
    const oldDate = new Date('2026-01-01T00:00:00.000Z');
    await utimes(expiredTask, oldDate, oldDate);
    await utimes(activeTask, oldDate, oldDate);

    const result = await cleanupExpiredWorkerArtifacts({
      workspaceRoot,
      activeTaskIds: new Set(['task_active']),
      policy: { ...basePolicy, retentionDays: 7 },
      now: new Date('2026-02-01T00:00:00.000Z')
    });

    expect(result.removed).toEqual([expiredTask]);
    await expect(access(expiredTask)).rejects.toThrow();
    await expect(access(activeTask)).resolves.toBeUndefined();
    await expect(access(freshTask)).resolves.toBeUndefined();
  });

  it('parses only storage safeguards from project configuration', () => {
    const policy = resolveWorkerResourcePolicy(`project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
workflow: {}
ai: {}
limits: {}
resources:
  min_free_space_mb: 1024
  retention_days: 5
github: {}
`);

    expect(policy).toEqual({ minFreeSpaceMb: 1024, retentionDays: 5 });
  });

  it('reports invalid storage policy configuration', () => {
    expect(() => resolveWorkerResourcePolicy(`project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
workflow: {}
ai: {}
limits: {}
resources:
  min_free_space_mb: invalid
github: {}
`)).toThrow('resource policy configuration is invalid');
  });
});
