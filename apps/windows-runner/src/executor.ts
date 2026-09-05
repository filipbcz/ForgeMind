import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  ExecutionArtifactResult,
  ExecutionToolVersionEvidence,
  WindowsEvidenceUpload,
  WindowsExecutionPacket,
  WindowsExecutionResult,
  WorkerCapability
} from '@forgemind/core';
import { redactSecrets } from '@forgemind/core';
import { SafeFixtureExecutor } from './fixture-executor.js';
import { PinnedUnrealCommandAdapter, type ApprovedUnrealProfile, type PinnedUnrealTool } from './unreal-adapter.js';

interface ProcessResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'deferred';
  exitCode?: number;
  stdout: string;
  stderr: string;
  toolVersions?: ExecutionToolVersionEvidence[];
}

export interface WindowsExecutionContext {
  deviceId: string;
  sessionId: string;
  workspaceRoot: string;
  artifactRoot: string;
  observedCapabilities: WorkerCapability[];
  signal?: AbortSignal;
  allowedFixtureExecutablePaths?: readonly string[];
  pinnedFixtureTools?: readonly PinnedFixtureTool[];
  pinnedUnrealTools?: readonly PinnedUnrealTool[];
  approvedUnrealProfiles?: readonly ApprovedUnrealProfile[];
  confirmLargeUnrealJob?: (summary: string) => Promise<boolean>;
  showLocally?: (summary: string) => void;
}

export interface PinnedFixtureTool { canonicalPath: string; version: string }

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
  const workspacePath = await prepareManagedDirectory(context.workspaceRoot, packet.jobId, true);
  const artifactPath = await prepareManagedDirectory(context.artifactRoot, packet.jobId, true);

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
  const logText = truncateUtf8(redactSecrets([
    `[intent] ${packet.check.command}`,
    `[adapter] ${packet.dispatch.kind}`,
    execution.stdout ? `[stdout]\n${execution.stdout}` : '',
    execution.stderr ? `[stderr]\n${execution.stderr}` : ''
  ].filter(Boolean).join('\n\n')), packet.resourcePolicy.maxLogBytes);
  const logHash = sha256(Buffer.from(logText));
  const completedAt = new Date();
  const plainArtifacts = artifacts.map(({ contentBase64: _content, ...artifact }) => artifact);
  const missingRequiredOutput = packet.expectedArtifacts.some((expected) => expected.required
    && !plainArtifacts.some((artifact) => artifact.name === expected.name && artifact.relativePath === expected.relativePath));
  const classified = packet.realEngineEvidence ? {
    ...packet.realEngineEvidence, projectId: packet.projectId, taskId: packet.taskId, runId: packet.runId,
    inputHash: packet.inputHash, resultTreeSha: packet.commitSha, toolVersions: execution.toolVersions ?? [],
    startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs: completedAt.getTime() - startedAt.getTime(),
    state: (missingRequiredOutput ? 'incomplete-output' : execution.status === 'timed_out' ? 'timed-out'
      : execution.status === 'cancelled' ? 'cancelled' : execution.exitCode === 2 ? 'missing-capability'
      : execution.status === 'succeeded' ? 'succeeded' : 'failed') as import('@forgemind/core').RealEngineEvidenceState,
    exitCode: execution.exitCode, artifacts: plainArtifacts
  } : undefined;
  const evidence: WindowsEvidenceUpload = {
    schemaVersion: 1,
    jobId: packet.jobId,
    leaseId: packet.leaseId,
    inputHash: packet.inputHash,
    commitSha: packet.commitSha,
    log: { text: logText, sizeBytes: Buffer.byteLength(logText), sha256: logHash },
    artifacts: artifacts.map((artifact) => ({ ...artifact, criterion: packet.check.criterion ?? packet.check.command })),
    ...(classified ? { realEngineEvidence: classified } : {})
  };
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
    toolVersions: execution.toolVersions ?? [],
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
    artifacts: plainArtifacts,
    ...(classified ? { realEngineEvidence: classified } : {})
  };
  return { evidence, result, workspacePath };
}

export async function cleanupWindowsValidationWorkspace(workspaceRoot: string, artifactRoot: string, jobId: string): Promise<void> {
  await Promise.all([removeManagedDirectory(workspaceRoot, jobId), removeManagedDirectory(artifactRoot, jobId)]);
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
    const fixtureTool = await findPinnedFixtureTool(dispatch.executablePath, context.pinnedFixtureTools ?? []);
    if (!fixtureTool) return { status: 'failed', exitCode: 2, stdout: '', stderr: 'Fixture executable has no canonical pinned version metadata.' };
    const result = await new SafeFixtureExecutor().execute({
      kind: 'fixture-validation', executablePath: dispatch.executablePath,
      inputRelativePath: dispatch.inputRelativePath, artifactRelativePath: fixtureTarget.artifactRelativePath
    }, {
      workspaceRoot: cwd,
      artifactRoot: fixtureArtifactRoot,
      allowedExecutablePaths: [...(context.allowedFixtureExecutablePaths ?? []), fixtureTool.canonicalPath],
      timeoutMs: packet.resourcePolicy.timeoutSeconds * 1_000,
      minimumFreeSpaceBytes: dispatch.minimumFreeSpaceBytes,
      maxConcurrentProcesses: dispatch.maxConcurrentProcesses
    }, context.signal);
    return { ...result, stdout: '', stderr: '', toolVersions: [{ tool: `fixture:${basename(fixtureTool.canonicalPath)}`, version: fixtureTool.version }] };
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
  const result = await runProcess(prepared.executablePath, [...prepared.args], processOptions(packet, prepared.workingDirectory, context.signal));
  return { ...result, toolVersions: [{ tool: dispatch.tool, version: prepared.toolVersion }] };
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
    assertSafeArtifactPath(expected.relativePath);
    const source = resolveContained(workspacePath, expected.relativePath);
    try {
      const canonicalSource = await realpath(source);
      ensureCanonicalWithin(await realpath(workspacePath), canonicalSource, 'Artifact');
      const info = await stat(canonicalSource);
      if (!info.isFile()) throw new Error(`Expected artifact is not a file: ${expected.relativePath}`);
      totalBytes += info.size;
      if (totalBytes > packet.resourcePolicy.maxArtifactBytes) throw new Error('Windows validation artifacts exceed the configured limit.');
      const content = await readFile(canonicalSource);
      if (redactSecrets(content.toString('utf8')) !== content.toString('utf8')) throw new Error(`Expected artifact contains secret-like content: ${expected.relativePath}`);
      resolveContained(await realpath(artifactPath), expected.relativePath);
      results.push({
        name: expected.name,
        relativePath: expected.relativePath,
        mimeType: expected.mimeType ?? inferArtifactMimeType(expected.relativePath),
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
  if (!childPath || childPath.startsWith('..') || isAbsolute(childPath) || dirname(candidate) !== resolvedRoot) throw new Error('Managed Windows worker path escapes its configured root or is not a direct child.');
  return candidate;
}

async function prepareManagedDirectory(root: string, child: string, recreate: boolean): Promise<string> {
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  if (!equalCanonicalPath(canonicalRoot, root)) throw new Error('Runner-managed root is a symlink or junction.');
  const candidate = resolveManagedPath(canonicalRoot, child);
  await rejectRedirectedManagedTarget(canonicalRoot, candidate);
  if (recreate) await rm(candidate, { recursive: true, force: true });
  await mkdir(candidate, { recursive: true });
  const canonicalCandidate = await realpath(candidate);
  if (!equalCanonicalPath(canonicalCandidate, candidate)) throw new Error('Runner-managed path is redirected outside its exact approved target.');
  ensureCanonicalWithin(canonicalRoot, canonicalCandidate, 'Runner-managed path');
  return canonicalCandidate;
}

async function removeManagedDirectory(root: string, child: string): Promise<void> {
  let canonicalRoot: string;
  try { canonicalRoot = await realpath(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!equalCanonicalPath(canonicalRoot, root)) throw new Error('Runner-managed root is a symlink or junction.');
  const candidate = resolveManagedPath(canonicalRoot, child);
  await rejectRedirectedManagedTarget(canonicalRoot, candidate);
  await rm(candidate, { recursive: true, force: true });
}

async function rejectRedirectedManagedTarget(canonicalRoot: string, candidate: string): Promise<void> {
  const { lexical, canonical } = await deepestExistingAncestor(candidate);
  if (!equalCanonicalPath(canonicalRoot, canonical)) ensureCanonicalWithin(canonicalRoot, canonical, 'Runner-managed path');
  if (!equalCanonicalPath(canonical, lexical)) throw new Error('Runner-managed path contains a symlink or junction and will not be removed.');
}

async function deepestExistingAncestor(candidate: string): Promise<{ lexical: string; canonical: string }> {
  let current = candidate;
  while (true) {
    try { return { lexical: current, canonical: await realpath(current) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function findPinnedFixtureTool(executablePath: string, tools: readonly PinnedFixtureTool[]): Promise<PinnedFixtureTool | undefined> {
  const executable = await realpath(executablePath);
  for (const tool of tools) if (equalCanonicalPath(await realpath(tool.canonicalPath), executable) && tool.version.trim()) return tool;
  return undefined;
}

function ensureCanonicalWithin(root: string, candidate: string, label: string): void {
  const childPath = relative(root, candidate);
  if (!childPath || childPath.startsWith('..') || isAbsolute(childPath)) throw new Error(`${label} escapes its approved root.`);
}

function equalCanonicalPath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US');
}

function assertSafeArtifactPath(relativePath: string): void {
  const forbidden = /(^|[\\/])(?:\.git|Users?|home|workspace)(?:[\\/]|$)|(?:^|[\\/])(?:\.env|environment)(?:\.|[\\/]|$)/i;
  if (forbidden.test(relativePath)) throw new Error(`Artifact path is prohibited: ${relativePath}`);
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
    stderr: [left.stderr, right.stderr].filter(Boolean).join('\n'),
    toolVersions: right.toolVersions ?? left.toolVersions
  };
}

function inferArtifactMimeType(relativePath: string): string {
  const extension = relativePath.slice(relativePath.lastIndexOf('.')).toLocaleLowerCase('en-US');
  return ({
    '.json': 'application/json', '.txt': 'text/plain', '.log': 'text/plain', '.xml': 'application/xml',
    '.html': 'text/html', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.zip': 'application/zip', '.pdf': 'application/pdf'
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
