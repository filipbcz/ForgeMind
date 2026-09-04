import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsExecutionPacket } from '@forgemind/core';
import { cleanupWindowsValidationWorkspace, executeWindowsValidation, mapFixtureArtifactPath } from './executor.js';

const executeFile = promisify(execFile);
const temporaryPaths: string[] = [];

describe('fixture adapter path mapping', () => {
  it('does not duplicate the workspace-relative artifact directory', () => {
    const mapped = mapFixtureArtifactPath('/runner/work/job-1', 'artifacts/result.json');
    expect(mapped).toEqual({ artifactRoot: '/runner/work/job-1/artifacts', artifactRelativePath: 'result.json' });
    expect(join(mapped.artifactRoot, mapped.artifactRelativePath)).toBe('/runner/work/job-1/artifacts/result.json');
  });
});

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'win32')('Windows validation executor', () => {
  it('defers unsupported AI commands without cloning or starting a shell', async () => {
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
      schemaVersion: 2,
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
      dispatch: { kind: 'deferred', reason: 'unsupported_validation_intent', handling: 'manual-local' },
      requiredCapabilities: ['windows'],
      resourcePolicy: { timeoutSeconds: 30, maxLogBytes: 32_000, maxArtifactBytes: 1_024 },
      expectedArtifacts: [],
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

    expect(execution.result).toMatchObject({ status: 'deferred', deferredReason: 'unsupported_validation_intent', commitSha });
    expect(execution.result.artifacts).toEqual([]);
    expect(execution.evidence.log.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(execution.evidence.log.text).toContain('No command was executed');
    await expect(stat(execution.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await cleanupWindowsValidationWorkspace(workspaces, artifacts, packet.jobId);

    const { stdout: whereGit } = await executeFile('where.exe', ['git.exe']);
    const gitPath = whereGit.split(/\r?\n/).find(Boolean)!;
    const adapterPacket: WindowsExecutionPacket = {
      ...packet,
      jobId: 'job_2',
      dispatch: {
        kind: 'unreal-validation', profileId: 'repository-head', tool: 'project-script', executablePath: gitPath,
        workingDirectoryRelativePath: '.', args: ['rev-parse', 'HEAD'], size: 'standard', minimumLargeJobFreeSpaceBytes: 0
      }
    };
    const adapterExecution = await executeWindowsValidation(adapterPacket, {
      deviceId: 'device_1', sessionId: 'session_1', workspaceRoot: workspaces, artifactRoot: artifacts,
      observedCapabilities: [{ key: 'windows' }], pinnedUnrealTools: [{ tool: 'project-script', canonicalPath: gitPath, version: 'test' }],
      approvedUnrealProfiles: [{ id: 'repository-head', tool: 'project-script', size: 'standard', allowedArguments: ['rev-parse', 'HEAD'] }]
    });
    expect(adapterExecution.result).toMatchObject({ status: 'succeeded', commitSha, exitCode: 0 });
    expect(adapterExecution.evidence.log.text).toContain(commitSha);
    await cleanupWindowsValidationWorkspace(workspaces, artifacts, adapterPacket.jobId);
  }, 60_000);
});
