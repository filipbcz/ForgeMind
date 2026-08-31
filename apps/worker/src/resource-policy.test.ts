import { describe, expect, it } from 'vitest';
import { access, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { runValidationChecks } from './validation.js';
import {
  assertFreeSpaceForWorker,
  cleanupExpiredWorkerArtifacts,
  isNetworkIsolationSupported,
  prepareResourcePolicyCommand,
  resolveWorkerResourcePolicy,
  type WorkerResourcePolicy
} from './resource-policy.js';

const basePolicy: WorkerResourcePolicy = {
  allowNetwork: false,
  minFreeSpaceMb: 0,
  retentionDays: 14
};

describe('worker resource policy', () => {
  it('refuses to start when free disk space is below policy', async () => {
    await expect(assertFreeSpaceForWorker(tmpdir(), {
      ...basePolicy,
      minFreeSpaceMb: Number.MAX_SAFE_INTEGER
    })).rejects.toThrow('free disk space is below policy');
  });

  it('wraps validation commands with configured CPU and memory limits on supported runtimes', () => {
    if (process.platform === 'win32') {
      expect(() => prepareResourcePolicyCommand('node --version', {
        ...basePolicy,
        allowNetwork: true,
        cpuLimitSeconds: 2,
        memoryLimitMb: 128
      })).toThrow('unsupported');
      return;
    }

    const command = prepareResourcePolicyCommand('node --version', {
      ...basePolicy,
      allowNetwork: true,
      cpuLimitSeconds: 2,
      memoryLimitMb: 128
    });

    expect(command).toBe('ulimit -t 2; ulimit -v 131072; node --version');
  });

  it('runs validation checks through configured CPU and memory limits on supported runtimes', async () => {
    const result = await runValidationChecks(
      [{ kind: 'command', command: 'true', category: 'smoke' }],
      tmpdir(),
      undefined,
      new Map(),
      undefined,
      undefined,
      new Set(),
      undefined,
      {
        ...basePolicy,
        allowNetwork: true,
        cpuLimitSeconds: 2,
        memoryLimitMb: 128
      }
    );

    if (process.platform === 'win32') {
      expect(result.passed).toBe(false);
      expect(result.stderr).toContain('unsupported');
      return;
    }

    expect(result.passed).toBe(true);
    expect(result.checkResults?.[0]?.command).toBe('ulimit -t 2; ulimit -v 131072; true');
  });

  it('wraps all validation commands in network isolation when network is disabled', () => {
    if (process.platform === 'win32') {
      expect(() => prepareResourcePolicyCommand('true', basePolicy)).toThrow('network isolation is unsupported');
      return;
    }

    if (isNetworkIsolationSupported()) {
      const command = prepareResourcePolicyCommand('true', basePolicy);
      expect(command).toBe("unshare -n /bin/sh -lc 'true'");
    } else {
      expect(() => prepareResourcePolicyCommand('true', basePolicy)).toThrow('network isolation is unsupported');
    }
  });

  it('fails closed when a configured disk quota cannot be applied', () => {
    expect(() => prepareResourcePolicyCommand('node --version', {
      ...basePolicy,
      diskLimitMb: 256
    })).toThrow('unsupported on this worker runtime');
  });

  it('prevents network access from validation commands without relying on command text patterns', async () => {
    const result = await runValidationChecks(
      [{
        kind: 'command',
        command: `node -e "process.exit(0)"`,
        category: 'api',
        timeoutMinutes: 1
      }],
      tmpdir(),
      undefined,
      new Map(),
      undefined,
      undefined,
      new Set(),
      undefined,
      basePolicy
    );

    expect(result.passed).toBe(false);
    if (isNetworkIsolationSupported()) {
      expect(result.checkResults?.[0]?.command).toContain('unshare -n');
    } else {
      expect(result.stderr).toContain('network isolation is unsupported');
    }
  });

  it('allows network commands when policy enables network', () => {
    expect(prepareResourcePolicyCommand('curl https://example.com', {
      ...basePolicy,
      allowNetwork: true
    })).toBe('curl https://example.com');
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

  it('parses resource policy from project configuration', () => {
    const policy = resolveWorkerResourcePolicy(`project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
workflow: {}
ai: {}
limits: {}
commands: {}
approval: {}
sandbox:
  allow_network: true
resources:
  cpu_limit_seconds: 3
  memory_limit_mb: 256
  min_free_space_mb: 1024
  retention_days: 5
github: {}
`);

    expect(policy).toEqual(expect.objectContaining({
      allowNetwork: true,
      cpuLimitSeconds: 3,
      memoryLimitMb: 256,
      minFreeSpaceMb: 1024,
      retentionDays: 5
    }));
  });

  it('fails closed when configured resource policy is invalid', () => {
    expect(() => resolveWorkerResourcePolicy(`project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
workflow: {}
ai: {}
limits: {}
commands: {}
approval: {}
sandbox: {}
resources:
  min_free_space_mb: invalid
github: {}
`)).toThrow('resource policy configuration is invalid');
  });
});
