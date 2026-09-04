import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  ExecutionArtifactResult,
  WindowsEvidenceUpload,
  WindowsExecutionPacket,
  WindowsExecutionResult,
  WorkerCapability
} from '@forgemind/core';
import { SafeFixtureExecutor } from './fixture-executor.js';
import { PinnedUnrealCommandAdapter, type ApprovedUnrealProfile, type PinnedUnrealTool } from './unreal-adapter.js';

interface ProcessResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'deferred';
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export interface WindowsExecutionContext {
  deviceId: string;
  sessionId: string;
  workspaceRoot: string;
  artifactRoot: string;
  observedCapabilities: WorkerCapability[];
  signal?: AbortSignal;
  allowedFixtureExecutablePaths?: readonly string[];
  pinnedUnrealTools?: readonly PinnedUnrealTool[];
  approvedUnrealProfiles?: readonly ApprovedUnrealProfile[];
  confirmLargeUnrealJob?: (summary: string) => Promise<boolean>;
  showLocally?: (summary: string) => void;
}

export interface ExecutedWindowsValidation {
  evidence: WindowsEvidenceUpload;
  result: WindowsExecutionResult;
  workspacePath: string;
}

export async function executeWindowsValidation(
  packet: WindowsExecutionPacket,
  context: WindowsExecutionContext
): Promise<ExecutedWindowsValidation> {
  if (process.platform !== 'win32') throw new Error('Windows validation can run only on Windows.');
  if (packet.schemaVersion !== 2) throw new Error('Legacy or unsupported Windows execution packet is deferred for manual-local handling.');
  const workspacePath = resolveManagedPath(context.workspaceRoot, packet.jobId);
  const artifactPath = resolveManagedPath(context.artifactRoot, packet.jobId);
  await rm(workspacePath, { recursive: true, force: true });
  await rm(artifactPath, { recursive: true, force: true });
  await mkdir(dirname(workspacePath), { recursive: true });
  await mkdir(artifactPath, { recursive: true });
  const approvedWorkspaceRoot = await realpath(dirname(workspacePath));
  const approvedArtifactRoot = await realpath(artifactPath);
  if (resolve(approvedWorkspaceRoot, packet.jobId) !== workspacePath || approvedArtifactRoot !== artifactPath) {
    throw new Error('Runner-managed roots could not be canonicalized to the approved local roots.');
  }

  const startedAt = new Date();
  const preparation: ProcessResult = packet.dispatch.kind === 'deferred'
    ? { status: 'deferred', stdout: '', stderr: `Deferred (${packet.dispatch.handling}): ${packet.dispatch.reason}. No process was executed.` }
    : await runProcess('git.exe', ['clone', '--no-checkout', '--filter=blob:none', packet.sourceUrl, workspacePath], {
        cwd: context.workspaceRoot,
        timeoutMs: packet.resourcePolicy.timeoutSeconds * 1_000,
        maxOutputBytes: packet.resourcePolicy.maxLogBytes,
        signal: context.signal
      });
  let execution = preparation;
  if (preparation.status === 'succeeded') {
    const checkout = await runProcess('git.exe', ['checkout', '--detach', packet.commitSha], {
      cwd: workspacePath,
      timeoutMs: packet.resourcePolicy.timeoutSeconds * 1_000,
      maxOutputBytes: packet.resourcePolicy.maxLogBytes,
      signal: context.signal
    });
    execution = mergeProcessResults(preparation, checkout);
    if (checkout.status === 'succeeded') {
      const verified = await runProcess('git.exe', ['rev-parse', 'HEAD'], processOptions(packet, workspacePath, context.signal));
      execution = mergeProcessResults(execution, verified);
      if (verified.status === 'succeeded' && verified.stdout.trim().toLocaleLowerCase('en-US') !== packet.commitSha.toLocaleLowerCase('en-US')) {
        execution = mergeProcessResults(execution, { status: 'failed', exitCode: 1, stdout: '', stderr: 'Checked-out commit does not match the packet commit.' });
      }
    }
  }
  if (execution.status === 'succeeded') {
    const validation = await runValidationAdapter(packet, workspacePath, context);
    execution = mergeProcessResults(execution, validation);
  }

  let artifacts: Array<ExecutionArtifactResult & { contentBase64: string }> = [];
  try {
    artifacts = await collectArtifacts(packet, workspacePath, artifactPath);
  } catch (error) {
    execution = {
      ...execution,
      status: 'failed',
      exitCode: execution.exitCode ?? 1,
      stderr: [execution.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n')
    };
  }
  const logText = truncateUtf8([
    `[intent] ${packet.check.command}`,
    `[adapter] ${packet.dispatch.kind}`,
    execution.stdout ? `[stdout]\n${execution.stdout}` : '',
    execution.stderr ? `[stderr]\n${execution.stderr}` : ''
  ].filter(Boolean).join('\n\n'), packet.resourcePolicy.maxLogBytes);
  const logHash = sha256(Buffer.from(logText));
  const evidence: WindowsEvidenceUpload = {
    schemaVersion: 1,
    jobId: packet.jobId,
    leaseId: packet.leaseId,
    inputHash: packet.inputHash,
    commitSha: packet.commitSha,
    log: { text: logText, sizeBytes: Buffer.byteLength(logText), sha256: logHash },
    artifacts: artifacts.map((artifact) => ({ ...artifact, criterion: packet.check.criterion ?? packet.check.command }))
  };
  const completedAt = new Date();
  const result: WindowsExecutionResult = {
    schemaVersion: 1,
    projectId: packet.projectId,
    taskId: packet.taskId,
    runId: packet.runId,
    checkId: packet.checkId,
    jobId: packet.jobId,
    leaseId: packet.leaseId,
    deviceId: context.deviceId,
    sessionId: context.sessionId,
    nonce: packet.nonce,
    inputHash: packet.inputHash,
    commitSha: packet.commitSha,
    observedCapabilities: context.observedCapabilities,
    toolVersions: [],
    status: execution.status,
    ...(execution.status === 'deferred' ? {
      deferredReason: packet.dispatch.kind === 'deferred' ? packet.dispatch.reason : 'manual_local_required' as const
    } : {}),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    exitCode: execution.exitCode,
    summary: execution.status === 'succeeded'
      ? `Windows validation passed: ${packet.check.command}`
      : `Windows validation ${execution.status}: ${packet.check.command}`,
    logHash,
    artifacts: artifacts.map(({ contentBase64: _content, ...artifact }) => artifact)
  };
  return { evidence, result, workspacePath };
}

export async function cleanupWindowsValidationWorkspace(workspaceRoot: string, artifactRoot: string, jobId: string): Promise<void> {
  await Promise.all([
    rm(resolveManagedPath(workspaceRoot, jobId), { recursive: true, force: true }),
    rm(resolveManagedPath(artifactRoot, jobId), { recursive: true, force: true })
  ]);
}

async function runValidationAdapter(packet: WindowsExecutionPacket, cwd: string, context: WindowsExecutionContext): Promise<ProcessResult> {
  const dispatch = packet.dispatch;
  context.showLocally?.(`Windows validation intent: ${packet.check.command}\nAdapter: ${dispatch.kind}`);
  if (dispatch.kind === 'deferred') return {
    status: 'deferred', stdout: '',
    stderr: `Deferred (${dispatch.handling}): ${dispatch.reason}. No command was executed.`
  };
  if (dispatch.kind === 'fixture-validation') {
    // Packet artifact paths are workspace-relative, while SafeFixtureExecutor's
    // artifact path is relative to artifactRoot. Split the path at that boundary
    // instead of applying the workspace-relative prefix twice.
    const fixtureTarget = mapFixtureArtifactPath(cwd, dispatch.artifactRelativePath);
    const fixtureArtifactRoot = fixtureTarget.artifactRoot;
    await mkdir(fixtureArtifactRoot, { recursive: true });
    const result = await new SafeFixtureExecutor().execute({
      kind: 'fixture-validation', executablePath: dispatch.executablePath,
      inputRelativePath: dispatch.inputRelativePath, artifactRelativePath: fixtureTarget.artifactRelativePath
    }, {
      workspaceRoot: cwd,
      artifactRoot: fixtureArtifactRoot,
      allowedExecutablePaths: context.allowedFixtureExecutablePaths ?? [],
      timeoutMs: packet.resourcePolicy.timeoutSeconds * 1_000,
      minimumFreeSpaceBytes: dispatch.minimumFreeSpaceBytes,
      maxConcurrentProcesses: dispatch.maxConcurrentProcesses
    }, context.signal);
    return { ...result, stdout: '', stderr: '' };
  }
  const workingDirectory = resolve(cwd, dispatch.workingDirectoryRelativePath);
  const prepared = await new PinnedUnrealCommandAdapter({
    canonicalize: realpath,
    async freeSpaceBytes(value) { const { statfs } = await import('node:fs/promises'); const info = await statfs(value, { bigint: true }); return Number(info.bavail * info.bsize); },
    confirmLargeJob: context.confirmLargeUnrealJob ?? (async () => false),
    showLocally: context.showLocally ?? ((summary) => process.stdout.write(`${summary}\n`))
  }).prepare({
    kind: 'unreal-validation', profileId: dispatch.profileId, tool: dispatch.tool,
    executablePath: dispatch.executablePath, workingDirectory, args: dispatch.args, size: dispatch.size
  }, {
    workspaceRoot: cwd, pinnedTools: context.pinnedUnrealTools ?? [], approvedProfiles: context.approvedUnrealProfiles ?? [],
    minimumLargeJobFreeSpaceBytes: dispatch.minimumLargeJobFreeSpaceBytes
  });
  if (prepared.status !== 'ready') return { status: 'failed', exitCode: 2, stdout: '', stderr: `${prepared.status}: ${prepared.reason}: ${prepared.message}` };
  return runProcess(prepared.executablePath, [...prepared.args], processOptions(packet, prepared.workingDirectory, context.signal));
}

export function mapFixtureArtifactPath(workspacePath: string, workspaceRelativePath: string): { artifactRoot: string; artifactRelativePath: string } {
  return {
    artifactRoot: resolve(workspacePath, dirname(workspaceRelativePath)),
    artifactRelativePath: basename(workspaceRelativePath)
  };
}

function processOptions(packet: WindowsExecutionPacket, cwd: string, signal?: AbortSignal) {
  return {
    cwd,
    timeoutMs: packet.resourcePolicy.timeoutSeconds * 1_000,
    maxOutputBytes: packet.resourcePolicy.maxLogBytes,
    signal
  };
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }
): Promise<ProcessResult> {
  if (options.signal?.aborted) return { status: 'cancelled', stdout: '', stderr: '' };
  const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk, options.maxOutputBytes); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk, options.maxOutputBytes); });
  let controlled: 'cancelled' | 'timed_out' | undefined;
  const terminate = async (reason: 'cancelled' | 'timed_out') => {
    if (controlled) return;
    controlled = reason;
    if (!child.pid) return;
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolveKill());
      killer.once('close', () => resolveKill());
    });
  };
  const timer = setTimeout(() => void terminate('timed_out'), options.timeoutMs);
  const abortListener = () => void terminate('cancelled');
  options.signal?.addEventListener('abort', abortListener, { once: true });
  const exitCode = await new Promise<number | undefined>((resolveExit) => {
    child.once('error', (error) => {
      stderr = appendBounded(stderr, Buffer.from(error.message), options.maxOutputBytes);
      resolveExit(undefined);
    });
    child.once('close', (code) => resolveExit(code ?? undefined));
  });
  clearTimeout(timer);
  options.signal?.removeEventListener('abort', abortListener);
  return {
    status: controlled ?? (exitCode === 0 ? 'succeeded' : 'failed'),
    exitCode,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8')
  };
}

async function collectArtifacts(packet: WindowsExecutionPacket, workspacePath: string, artifactPath: string) {
  const results: Array<ExecutionArtifactResult & { contentBase64: string }> = [];
  let totalBytes = 0;
  for (const expected of packet.expectedArtifacts) {
    const source = resolveContained(workspacePath, expected.relativePath);
    try {
      const info = await stat(source);
      if (!info.isFile()) throw new Error(`Expected artifact is not a file: ${expected.relativePath}`);
      totalBytes += info.size;
      if (totalBytes > packet.resourcePolicy.maxArtifactBytes) throw new Error('Windows validation artifacts exceed the configured limit.');
      const content = await readFile(source);
      resolveContained(artifactPath, expected.relativePath);
      results.push({
        name: expected.name,
        relativePath: expected.relativePath,
        sizeBytes: content.length,
        sha256: sha256(content),
        contentBase64: content.toString('base64')
      });
    } catch (error) {
      if (expected.required) throw error;
    }
  }
  return results;
}

function resolveManagedPath(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, child);
  const childPath = relative(resolvedRoot, candidate);
  if (!childPath || childPath.startsWith('..') || isAbsolute(childPath)) throw new Error('Managed Windows worker path escapes its configured root.');
  return candidate;
}

function resolveContained(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error('Artifact path must be relative.');
  const candidate = resolve(root, relativePath);
  const childPath = relative(resolve(root), candidate);
  if (!childPath || childPath.startsWith('..') || isAbsolute(childPath)) throw new Error('Artifact path escapes the validation workspace.');
  return candidate;
}

function appendBounded(current: Buffer, next: Uint8Array, maxBytes: number): Buffer {
  const combined = Buffer.concat([current, next]);
  return Buffer.from(combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes));
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes ? value : bytes.subarray(bytes.length - maxBytes).toString('utf8');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function mergeProcessResults(left: ProcessResult, right: ProcessResult): ProcessResult {
  return {
    status: right.status,
    exitCode: right.exitCode,
    stdout: [left.stdout, right.stdout].filter(Boolean).join('\n'),
    stderr: [left.stderr, right.stderr].filter(Boolean).join('\n')
  };
}
