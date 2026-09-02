import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  ExecutionArtifactResult,
  WindowsEvidenceUpload,
  WindowsExecutionPacket,
  WindowsExecutionResult,
  WorkerCapability
} from '@forgemind/core';

interface ProcessResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
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
  const workspacePath = resolveManagedPath(context.workspaceRoot, packet.jobId);
  const artifactPath = resolveManagedPath(context.artifactRoot, packet.jobId);
  await rm(workspacePath, { recursive: true, force: true });
  await rm(artifactPath, { recursive: true, force: true });
  await mkdir(dirname(workspacePath), { recursive: true });
  await mkdir(artifactPath, { recursive: true });

  const startedAt = new Date();
  const preparation = await runProcess('git.exe', ['clone', '--no-checkout', '--filter=blob:none', packet.sourceUrl, workspacePath], {
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
  }
  if (execution.status === 'succeeded') {
    const validation = await runValidationCommand(packet, workspacePath, context.signal);
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
    `[command] ${packet.check.command}`,
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

async function runValidationCommand(packet: WindowsExecutionPacket, cwd: string, signal?: AbortSignal): Promise<ProcessResult> {
  const shell = packet.check.shell ?? 'system';
  if (shell === 'powershell') return runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', packet.check.command], processOptions(packet, cwd, signal));
  if (shell === 'bash') return runProcess('bash.exe', ['-lc', packet.check.command], processOptions(packet, cwd, signal));
  if (shell === 'sh') return runProcess('sh.exe', ['-lc', packet.check.command], processOptions(packet, cwd, signal));
  return runProcess('cmd.exe', ['/d', '/s', '/c', packet.check.command], processOptions(packet, cwd, signal));
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
