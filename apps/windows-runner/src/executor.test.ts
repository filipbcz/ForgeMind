import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsExecutionPacket } from '@forgemind/core';
import { cleanupWindowsValidationWorkspace, executeWindowsValidation } from './executor.js';

const executeFile = promisify(execFile);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('Windows validation executor', () => {
  it('checks out the immutable commit, executes the AI command, and hashes its evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgemind-windows-runner-'));
    temporaryPaths.push(root);
    const source = join(root, 'source');
    const workspaces = join(root, 'workspaces');
    const artifacts = join(root, 'artifacts');
    await executeFile('git.exe', ['init', source]);
    await executeFile('git.exe', ['-C', source, 'config', 'user.email', 'runner@test.invalid']);
    await executeFile('git.exe', ['-C', source, 'config', 'user.name', 'ForgeMind runner test']);
    await writeFile(join(source, 'tracked.txt'), 'immutable source\n');
    await executeFile('git.exe', ['-C', source, 'add', 'tracked.txt']);
    await executeFile('git.exe', ['-C', source, 'commit', '-m', 'fixture']);
    const { stdout } = await executeFile('git.exe', ['-C', source, 'rev-parse', 'HEAD']);
    const commitSha = stdout.trim();
    const packet: WindowsExecutionPacket = {
      schemaVersion: 1,
      projectId: 'project_1',
      taskId: 'task_1',
      runId: 'run_1',
      checkId: 'check_1',
      jobId: 'job_1',
      leaseId: 'lease_1',
      repository: 'local/fixture',
      sourceUrl: source,
      commitSha,
      workspaceRoot: workspaces,
      artifactRoot: artifacts,
      check: {
        command: 'echo validated>result.txt',
        category: 'smoke',
        requiredCapabilities: ['windows']
      },
      requiredCapabilities: ['windows'],
      resourcePolicy: { timeoutSeconds: 30, maxLogBytes: 32_000, maxArtifactBytes: 1_024 },
      expectedArtifacts: [{ name: 'result', relativePath: 'result.txt', required: true }],
      nonce: 'nonce_1',
      inputHash: 'a'.repeat(64)
    };

    const execution = await executeWindowsValidation(packet, {
      deviceId: 'device_1',
      sessionId: 'session_1',
      workspaceRoot: workspaces,
      artifactRoot: artifacts,
      observedCapabilities: [{ key: 'windows' }]
    });

    expect(execution.result).toMatchObject({ status: 'succeeded', commitSha, exitCode: 0 });
    expect(execution.result.artifacts).toEqual([expect.objectContaining({ name: 'result', relativePath: 'result.txt' })]);
    expect(execution.evidence.log.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(execution.evidence.artifacts[0]!.contentBase64, 'base64').toString().trim()).toBe('validated');
    expect((await readFile(join(execution.workspacePath, 'tracked.txt'), 'utf8')).trim()).toBe('immutable source');

    await cleanupWindowsValidationWorkspace(workspaces, artifacts, packet.jobId);
  }, 60_000);
});
