import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { WindowsExecutionPacket } from '@forgemind/core';
import { cleanupWindowsValidationWorkspace, executeWindowsValidation, findPinnedFixtureTool, mapFixtureArtifactPath, validatePngArtifact } from './executor.js';

const executeFile = promisify(execFile);
const temporaryPaths: string[] = [];

describe('fixture adapter path mapping', () => {
  it('does not duplicate the workspace-relative artifact directory', () => {
    const mapped = mapFixtureArtifactPath('/runner/work/job-1', 'artifacts/result.json');
    expect(mapped).toEqual({ artifactRoot: '/runner/work/job-1/artifacts', artifactRelativePath: 'result.json' });
    expect(join(mapped.artifactRoot, mapped.artifactRelativePath)).toBe('/runner/work/job-1/artifacts/result.json');
  });
});

describe('runtime capture decoding', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  it('accepts a complete decodable PNG and rejects signature-only or truncated evidence', () => {
    expect(() => validatePngArtifact(png)).not.toThrow();
    expect(() => validatePngArtifact(png.subarray(0, 32))).toThrow(/unreadable/);
    expect(() => validatePngArtifact(Buffer.concat([png.subarray(0, 8), Buffer.alloc(40)]))).toThrow(/unreadable/);
    const corruptCrc = Buffer.from(png); corruptCrc[29] = corruptCrc[29]! ^ 1;
    expect(() => validatePngArtifact(corruptCrc)).toThrow(/unreadable/);
  });
});

describe('managed cleanup boundaries', () => {
  it('rejects traversal and redirected job targets without deleting foreign data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgemind-managed-path-'));
    temporaryPaths.push(root);
    const workspaces = join(root, 'workspaces');
    const artifacts = join(root, 'artifacts');
    const foreign = join(root, 'foreign');
    await Promise.all([mkdir(workspaces), mkdir(artifacts), mkdir(foreign)]);
    await writeFile(join(foreign, 'keep.txt'), 'keep');

    await expect(cleanupWindowsValidationWorkspace(workspaces, artifacts, '..')).rejects.toThrow(/escapes/);
    await symlink(foreign, join(workspaces, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(cleanupWindowsValidationWorkspace(workspaces, artifacts, 'redirected')).rejects.toThrow(/symlink|junction|approved root/);
    await expect(readFile(join(foreign, 'keep.txt'), 'utf8')).resolves.toBe('keep');

    const redirectedRoot = join(root, 'redirected-root');
    await symlink(foreign, redirectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(cleanupWindowsValidationWorkspace(redirectedRoot, artifacts, 'missing-job')).rejects.toThrow(/root is a symlink or junction/);
    await expect(readFile(join(foreign, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('is idempotent for an absent exact managed target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgemind-managed-cleanup-'));
    temporaryPaths.push(root);
    const workspaces = join(root, 'workspaces');
    const artifacts = join(root, 'artifacts');
    await Promise.all([mkdir(workspaces), mkdir(artifacts)]);
    await cleanupWindowsValidationWorkspace(workspaces, artifacts, 'job-1');
    await cleanupWindowsValidationWorkspace(workspaces, artifacts, 'job-1');
  });
});

describe('fixture tool evidence', () => {
  it('requires and returns version metadata for the exact canonical executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgemind-fixture-tool-'));
    temporaryPaths.push(root);
    const executable = join(root, 'fixture.exe');
    await writeFile(executable, 'fixture');
    await expect(findPinnedFixtureTool(executable, [])).resolves.toBeUndefined();
    await expect(findPinnedFixtureTool(executable, [{ canonicalPath: executable, version: '1.2.3' }])).resolves.toEqual({ canonicalPath: executable, version: '1.2.3' });
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
      observedCapabilities: [{ key: 'windows', version: '11' }], pinnedUnrealTools: [{ tool: 'project-script', canonicalPath: gitPath, version: 'test' }],
      approvedUnrealProfiles: [{ id: 'repository-head', tool: 'project-script', size: 'standard', allowedArguments: ['rev-parse', 'HEAD'] }]
    });
    expect(adapterExecution.result).toMatchObject({ status: 'succeeded', commitSha, exitCode: 0 });
    expect(adapterExecution.result.toolVersions).toEqual([{ tool: 'project-script', version: 'test' }]);
    expect(adapterExecution.result).toMatchObject({
      checkId: adapterPacket.checkId, inputHash: adapterPacket.inputHash, leaseId: adapterPacket.leaseId,
      observedCapabilities: [{ key: 'windows', version: '11' }]
    });
    expect(adapterExecution.evidence.log.text).toContain(commitSha);
    await cleanupWindowsValidationWorkspace(workspaces, artifacts, adapterPacket.jobId);
  }, 60_000);
});
