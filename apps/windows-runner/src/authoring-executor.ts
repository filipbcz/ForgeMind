import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthoringTreeEntry, WindowsAuthoringPacket, WindowsAuthoringProcessResult, WindowsAuthoringResult } from '@forgemind/core';
import { redactSecrets } from '@forgemind/core';
import type { AIProvider } from '@forgemind/providers';
import { buildSandboxedProcessInvocation } from './native-sandbox.js';

export interface NativeAuthoringTools {
  root: string;
  managedRoots: { inputs: string; sourceAssets: string; cache: string; outputs: string; diagnostics: string };
  read(path: string): Promise<Buffer>;
  write(path: string, content: Buffer | string): Promise<void>;
  remove(path: string): Promise<void>;
  record(result: Omit<WindowsAuthoringProcessResult, 'leaseId' | 'sessionId'>): Promise<void>;
  nativeToolChannel: { command: string; args: string[] };
  drainNativeProcesses(): Promise<void>;
  run(input: { command: string; shell: 'powershell' | 'cmd' | 'system'; checkId?: string }): Promise<WindowsAuthoringProcessResult>;
}

export interface NativeImplementationProvider {
  implement(input: { prompt: string; acceptanceCriteria: string[]; previousValidationError?: string; previousReviewBlockers?: string[];
    operations: WindowsAuthoringPacket['operations']; tools: NativeAuthoringTools; signal?: AbortSignal }): Promise<{ summary: string; completedOperationIds: string[]; checkpointIds: string[] }>;
}

/** Bridges the runner lease to the ordinary implementation provider lifecycle.
 * Validation commands returned by the AI are executed through the native tool
 * channel without command-name or argument allowlists. */
export class LifecycleNativeImplementationProvider implements NativeImplementationProvider {
  constructor(private readonly provider: AIProvider) {}
  async implement(input: Parameters<NativeImplementationProvider['implement']>[0]) {
    const passed = new Map<string, WindowsAuthoringProcessResult>();
    let failure: WindowsAuthoringProcessResult | undefined;
    let result;
    for (let attempt = 1; ; attempt += 1) {
      if (input.signal?.aborted) throw new Error('Native implementation was cancelled.');
      const providerStarted = new Date();
      let providerStdout = '';
      let providerStderr = '';
      let processEvidenceError: Error | undefined;
      const processStarts = new Map<string, string>();
      let providerProcessIndex = 0;
      try {
        result = await this.provider.implement({
          taskId: 'native-windows-authoring', prompt: input.prompt,
          plan: { summary: input.prompt, steps: input.operations.map((operation) => operation.rationale), acceptanceCriteria: input.acceptanceCriteria },
          repositoryPath: input.tools.root, signal: input.signal, attemptNumber: attempt,
          previousValidationError: failure ? `${failure.checkId}: ${failure.command}\n${failure.stderr || failure.stdout}` : input.previousValidationError,
          previousReviewBlockers: input.previousReviewBlockers,
          nativeToolChannel: input.tools.nativeToolChannel,
          onActivity: async (activity) => {
            if (activity.kind === 'stdout') providerStdout += activity.message; else if (activity.kind === 'stderr') providerStderr += activity.message;
            if (!activity.process) return;
            const identity = activity.process.id ?? activity.process.command;
            if (activity.process.event === 'started') { processStarts.set(identity, new Date().toISOString()); return; }
            if (activity.process.stdout === undefined || activity.process.stderr === undefined) {
              processEvidenceError = new Error(`Provider command ${activity.process.id ?? activity.process.command} did not return separate stdout and stderr streams.`);
              return;
            }
            const shell = inferWindowsShell(activity.process.command);
            await input.tools.record({ checkId: activity.process.id ?? `implementation-tool-${++providerProcessIndex}`,
              command: activity.process.command, shell, exitCode: activity.process.exitCode,
              stdout: activity.process.stdout, stderr: activity.process.stderr,
              startedAt: processStarts.get(identity) ?? providerStarted.toISOString(), completedAt: new Date().toISOString() });
          }
        });
        await input.tools.drainNativeProcesses();
        if (processEvidenceError) throw processEvidenceError;
        await input.tools.record({ checkId: `implementation-provider-${attempt}`, command: 'provider.implement', shell: 'system', exitCode: 0,
          stdout: providerStdout || result.summary, stderr: providerStderr, startedAt: providerStarted.toISOString(), completedAt: new Date().toISOString() });
      } catch (error) {
        await input.tools.drainNativeProcesses();
        await input.tools.record({ checkId: `implementation-provider-${attempt}`, command: 'provider.implement', shell: 'system', exitCode: 1,
          stdout: providerStdout, stderr: [providerStderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n'), startedAt: providerStarted.toISOString(), completedAt: new Date().toISOString() });
        throw error;
      }
      failure = undefined;
      for (const [index, check] of (result.validationChecks ?? []).entries()) {
        const identity = `${check.shell ?? 'system'}\0${check.command}`;
        if (passed.has(identity)) continue;
        const shell = check.shell === 'cmd' ? 'cmd' : check.shell === 'system' ? 'system' : 'powershell';
        const process = await input.tools.run({ command: check.command, shell, checkId: `provider-check-${index + 1}` });
        if (process.exitCode === 0) passed.set(identity, process); else { failure = process; break; }
      }
      if (!failure) break;
    }
    if (!result) throw new Error('Implementation provider returned no result.');
    return { summary: result.summary, completedOperationIds: input.operations.map(({ id }) => id), checkpointIds: [] };
  }
}

function inferWindowsShell(command: string): 'powershell' | 'cmd' | 'system' {
  return /^\s*(?:cmd(?:\.exe)?)(?:\s|$)/i.test(command) ? 'cmd'
    : /^\s*(?:powershell|pwsh)(?:\.exe)?(?:\s|$)/i.test(command) ? 'powershell'
    : 'system';
}

export async function executeWindowsAuthoring(packet: WindowsAuthoringPacket, context: {
  deviceId: string; sessionId: string; workspaceRoot: string; artifactRoot: string;
  managedRoots?: NativeAuthoringTools['managedRoots']; signal?: AbortSignal; provider: NativeImplementationProvider;
}): Promise<{ result: WindowsAuthoringResult; workspacePath: string }> {
  if (process.platform !== 'win32') throw new Error('Windows authoring can run only on Windows.');
  const evidenceDirectory = managedChild(context.artifactRoot, packet.taskId);
  await mkdir(evidenceDirectory, { recursive: true });
  const suppliedRoots = context.managedRoots ?? { inputs: resolve(context.artifactRoot, 'inputs'), sourceAssets: resolve(context.artifactRoot, 'source-assets'),
    cache: resolve(context.artifactRoot, 'cache'), outputs: resolve(context.artifactRoot, 'outputs'), diagnostics: context.artifactRoot };
  await Promise.all(Object.values(suppliedRoots).map((path) => mkdir(path, { recursive: true })));
  const cacheDirectory = managedChild(suppliedRoots.cache, packet.taskId); const outputDirectory = managedChild(suppliedRoots.outputs, packet.taskId);
  const cacheIdentityPath = resolve(cacheDirectory, 'forgemind-cache-identity.json');
  try {
    const identity = JSON.parse(await readFile(cacheIdentityPath, 'utf8')) as { inputHash?: string; baseCommitSha?: string };
    if (identity.inputHash !== packet.inputHash || identity.baseCommitSha?.toLowerCase() !== packet.baseCommitSha.toLowerCase()) await rm(cacheDirectory, { recursive: true, force: true });
  } catch { await rm(cacheDirectory, { recursive: true, force: true }); }
  await Promise.all([mkdir(cacheDirectory, { recursive: true }), mkdir(outputDirectory, { recursive: true })]);
  await writeFile(cacheIdentityPath, JSON.stringify({ version: 1, inputHash: packet.inputHash, baseCommitSha: packet.baseCommitSha }), 'utf8');
  const checkpointPath = resolve(evidenceDirectory, 'authoring-checkpoint.json');
  const checkout = await prepareCheckout(packet, context.workspaceRoot, checkpointPath, outputDirectory, context.signal);
  const workspacePath = checkout.path;
  if (!checkout.resumed && packet.step.priorPatch?.trim()) {
    const prior = await spawnWithInput('git.exe', ['apply', '--binary', '--whitespace=nowarn', '-'], workspacePath, packet.step.priorPatch, context.signal);
    if (prior.exitCode !== 0) throw new Error(`Could not materialize the previous Windows attempt: ${prior.stderr}`);
  }
  const processes: WindowsAuthoringProcessResult[] = [];
  const tools = createTools(workspacePath, resolve(evidenceDirectory, 'native-processes.jsonl'), packet.resourcePolicy.timeoutSeconds * 1_000,
    context.signal, processes, packet.leaseId, context.sessionId, { ...suppliedRoots, cache: cacheDirectory, outputs: outputDirectory,
      diagnostics: evidenceDirectory }, async () => persistCheckpoint(checkpointPath, packet, workspacePath, 'in-progress', context.signal, outputDirectory));
  await persistCheckpoint(checkpointPath, packet, workspacePath, 'started', context.signal, outputDirectory);
  const startedAt = new Date();
  let status: WindowsAuthoringResult['status'] = 'succeeded';
  let authoringFailureState: import('@forgemind/core').RealEngineEvidenceState | undefined;
  let summary = 'Native implementation completed.';
  let completedOperationIds: string[] = [];
  let checkpointIds: string[] = [];
  try {
    const output = await context.provider.implement({ prompt: packet.step.prompt, acceptanceCriteria: packet.step.acceptanceCriteria,
      previousValidationError: packet.step.previousValidationError, previousReviewBlockers: packet.step.previousReviewBlockers,
      operations: packet.operations, tools, signal: context.signal });
    summary = output.summary; completedOperationIds = output.completedOperationIds; checkpointIds = output.checkpointIds;
  } catch (error) {
    status = context.signal?.aborted ? 'cancelled' : 'failed';
    summary = redactSecrets(error instanceof Error ? error.message : String(error));
    authoringFailureState = classifyAuthoringFailure(summary, context.signal?.aborted === true, processes);
  }
  await rm(resolve(workspacePath, '.forgemind-tmp'), { recursive: true, force: true });
  const changedPaths = await stageChangedPaths(workspacePath, context.signal);
  await rejectProhibitedResultPaths(packet, workspacePath, context.signal);
  const productionReviewRequired = await enforceRequiredUnrealAssets(packet, workspacePath, evidenceDirectory, changedPaths, processes, packet.resourcePolicy.timeoutSeconds * 1_000, context.signal);
  const tree = await collectTree(workspacePath);
  const treeSha = await gitTree(workspacePath, context.signal);
  const patchResult = await spawnComplete('git.exe', ['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD'], workspacePath, 30_000, context.signal);
  if (patchResult.exitCode !== 0) throw new Error(`Could not package result tree: ${patchResult.stderr}`);
  const patchBytes = Buffer.from(patchResult.stdout, 'utf8');
  const lfsObjects = await collectLfsObjects(workspacePath, context.signal);
  const outputs = await collectManagedOutputs(outputDirectory, packet.resourcePolicy.maxArtifactBytes);
  const resultBundle = { version: 1 as const, format: 'git-binary-patch' as const,
    sha256: createHash('sha256').update(patchBytes).digest('hex'), sizeBytes: patchBytes.length, lfsObjects, outputs };
  const completedAt = new Date();
  const artifacts = outputs.map((output) => ({ name: `managed-output:${output.path}`, relativePath: output.path, sizeBytes: output.sizeBytes, sha256: output.sha256 }));
  const evidenceArtifacts = [...artifacts, ...tree.filter((entry) => changedPaths.includes(entry.path)).map((entry) => ({
    name: `result-tree:${entry.path}`, relativePath: entry.path, sizeBytes: entry.sizeBytes, sha256: entry.sha256
  }))];
  const incomplete = packet.artifactExpectations.some((expectation) => expectation.required
    && !artifacts.some((artifact) => artifact.relativePath === expectation.relativePath || artifact.name === expectation.name)
    && !tree.some((entry) => entry.path === expectation.relativePath || entry.path.startsWith(`${expectation.relativePath.replace(/[\\/]$/, '')}/`)));
  const classified = packet.realEngineEvidence ? {
    ...packet.realEngineEvidence, projectId: packet.projectId, taskId: packet.taskId, runId: packet.runId,
    inputHash: packet.inputHash, resultTreeSha: treeSha, toolVersions: collectAuthoringToolVersions(processes), startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(), state: (incomplete ? 'incomplete-output'
      : authoringFailureState ?? (status === 'cancelled' ? 'cancelled' : status === 'succeeded' ? 'succeeded' : 'failed')) as import('@forgemind/core').RealEngineEvidenceState,
    artifacts: evidenceArtifacts
  } : undefined;
  await writeFile(resolve(evidenceDirectory, 'result-checkpoint.json'), JSON.stringify({ version: 1, taskId: packet.taskId,
    jobId: packet.jobId, inputHash: packet.inputHash, baseCommitSha: packet.baseCommitSha, resultTreeSha: treeSha,
    resultBundle, tree, patchBase64: patchBytes.toString('base64'), status }), 'utf8');
  return { workspacePath, result: {
    kind: 'authoring-result', protocolVersion: packet.protocolVersion, projectId: packet.projectId, taskId: packet.taskId,
    runId: packet.runId, jobId: packet.jobId, leaseId: packet.leaseId, deviceId: context.deviceId, sessionId: context.sessionId,
    nonce: packet.nonce, inputHash: packet.inputHash, baseCommitSha: packet.baseCommitSha, resultTreeSha: treeSha, resultBundle,
    tree, patch: patchResult.stdout, completedOperationIds, checkpointIds,
    artifacts, ...(classified ? { realEngineEvidence: classified } : {}),
    processes, status, contentAssessment: { technicalVerification: packet.contentPolicy.requiresUnrealAssets ? 'passed' : 'not-required',
      productionReviewRequired, rationale: productionReviewRequired
        ? 'Technical loadability and provenance are verified; usable production quality requires downstream visual or domain review.'
        : 'No separate production-quality review was requested by the acceptance criteria.' },
    startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), summary
  } };
}

export function collectAuthoringToolVersions(processes: WindowsAuthoringProcessResult[]): import('@forgemind/core').ExecutionToolVersionEvidence[] {
  const versions = new Map<string, import('@forgemind/core').ExecutionToolVersionEvidence>();
  for (const process of processes) {
    if (!process.authoring) continue;
    const pathVersion = process.authoring.executablePath.match(/(?:UE[_-]?|Unreal(?:Engine)?[_ -]?)(\d+(?:\.\d+){1,2})/i)?.[1]
      ?? process.stdout.match(/Unreal Engine\s*(\d+(?:\.\d+){1,2})/i)?.[1]
      ?? process.stderr.match(/Unreal Engine\s*(\d+(?:\.\d+){1,2})/i)?.[1]
      ?? `selected-executable:${process.authoring.executablePath}`;
    versions.set(`${process.authoring.tool}:${process.authoring.executablePath}`, {
      tool: process.authoring.tool, version: pathVersion, driverVersion: process.authoring.executablePath
    });
  }
  return [...versions.values()];
}

export function classifyAuthoringFailure(summary: string, cancelled: boolean,
  processes: WindowsAuthoringProcessResult[]): import('@forgemind/core').RealEngineEvidenceState {
  return cancelled ? 'cancelled'
    : processes.some((process) => process.terminationReason === 'timed-out') || /timed?\s*out|timeout/i.test(summary) ? 'timed-out'
    : processes.some((process) => process.terminationReason === 'missing-capability') || /missing capability|not found|enoent/i.test(summary) ? 'missing-capability'
    : 'failed';
}

function managedChild(root: string, name: string): string {
  const target = resolve(root, name); const rel = relative(resolve(root), target);
  if (!name || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Managed authoring path escapes its root.');
  return target;
}

function createTools(root: string, evidencePath: string, timeoutMs: number, signal: AbortSignal | undefined, results: WindowsAuthoringProcessResult[], leaseId: string, sessionId: string,
  managedRoots: NativeAuthoringTools['managedRoots'], checkpoint: () => Promise<void>): NativeAuthoringTools {
  let evidenceOffset = 0;
  const sandboxExecutable = process.env.FORGEMIND_CODEX_CLI_PATH?.trim() || 'codex';
  const contained = (path: string) => { const target = resolve(root, path); const rel = relative(root, target); if (rel.startsWith('..') || rel === '..') throw new Error('Tool path escapes the leased checkout.'); return target; };
  return {
    root,
    managedRoots,
    nativeToolChannel: { command: process.execPath, args: [fileURLToPath(new URL('./native-tool-server.js', import.meta.url)), root, evidencePath,
      sandboxExecutable] },
    async drainNativeProcesses() {
      let content = '';
      try { content = await readFile(evidencePath, 'utf8'); } catch { return; }
      const additions = content.slice(evidenceOffset); evidenceOffset = content.length;
      for (const line of additions.split(/\r?\n/).filter(Boolean)) {
        const value = JSON.parse(line) as Omit<WindowsAuthoringProcessResult, 'leaseId' | 'sessionId'>;
        results.push({ ...value, leaseId, sessionId });
      }
    },
    read: (path) => readFile(contained(path)),
    async write(path, content) { const target = contained(path); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content); await checkpoint(); },
    async remove(path) { await rm(contained(path), { recursive: true, force: true }); await checkpoint(); },
    async record(result) { results.push({ ...result, leaseId, sessionId, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) }); await checkpoint(); },
    async run(input) {
      const startedAt = new Date();
      const sandboxed = buildSandboxedProcessInvocation({ sandboxExecutable, checkoutRoot: root, command: input.command, shell: input.shell });
      const output = await spawnComplete(sandboxed.executable, sandboxed.args, root, timeoutMs, signal);
      const result = { leaseId, sessionId, checkId: input.checkId ?? randomUUID(), command: input.command, shell: input.shell, ...output,
        stdout: redactSecrets(output.stdout), stderr: redactSecrets(output.stderr), startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() };
      results.push(result); await checkpoint(); return result;
    }
  };
}

async function prepareCheckout(packet: WindowsAuthoringPacket, root: string, checkpointPath: string, outputRoot: string, signal?: AbortSignal): Promise<{ path: string; resumed: boolean }> {
  await mkdir(root, { recursive: true }); const path = resolve(root, packet.taskId);
  let checkpoint: AuthoringDiskCheckpoint | undefined;
  let generations: string[] = [];
  try { generations = (await readdir(dirname(checkpointPath))).filter((name) => name.startsWith(`${basename(checkpointPath)}.generation-`) && name.endsWith('.json')).sort().reverse().map((name) => resolve(dirname(checkpointPath), name)); } catch { /* no generations */ }
  for (const candidate of [...generations, checkpointPath, `${checkpointPath}.previous`]) {
    try { checkpoint = JSON.parse(await readFile(candidate, 'utf8')) as AuthoringDiskCheckpoint; if (checkpoint.version === 2) break; } catch { /* try last complete generation */ }
  }
  const checkpointMatches = checkpoint?.version === 2 && checkpoint.inputHash === packet.inputHash
    && checkpoint.baseCommitSha.toLowerCase() === packet.baseCommitSha.toLowerCase();
  try {
    const actual = await spawnComplete('git.exe', ['rev-parse', 'HEAD'], path, 30_000, signal);
    if (checkpointMatches
      && actual.exitCode === 0 && actual.stdout.trim().toLowerCase() === packet.baseCommitSha.toLowerCase()) {
      const status = await spawnComplete('git.exe', ['status', '--porcelain=v1'], path, 30_000, signal);
      if (status.exitCode === 0 && status.stdout.trim().length > 0) return { path: await realpath(path), resumed: true };
    }
  } catch { /* missing or invalid retained checkout */ }
  try { await rename(path, resolve(root, `${packet.taskId}.preserved-${Date.now()}`)); } catch (error) {
    try { await lstat(path); } catch { /* checkout did not exist */ return cloneCheckout(packet, root, path, outputRoot, signal, checkpointMatches ? checkpoint : undefined); }
    throw error;
  }
  return cloneCheckout(packet, root, path, outputRoot, signal, checkpointMatches ? checkpoint : undefined);
}

async function cloneCheckout(packet: WindowsAuthoringPacket, root: string, path: string, outputRoot: string, signal?: AbortSignal, checkpoint?: AuthoringDiskCheckpoint): Promise<{ path: string; resumed: boolean }> {
  const clone = await spawnComplete('git.exe', ['clone', '--no-checkout', packet.sourceUrl, path], root, packet.resourcePolicy.timeoutSeconds * 1000, signal);
  if (clone.exitCode !== 0) throw new Error(`Checkout clone failed: ${clone.stderr}`);
  const checkout = await spawnComplete('git.exe', ['checkout', '--detach', packet.baseCommitSha], path, packet.resourcePolicy.timeoutSeconds * 1000, signal);
  if (checkout.exitCode !== 0) throw new Error(`Checkout materialization failed: ${checkout.stderr}`);
  const actual = await spawnComplete('git.exe', ['rev-parse', 'HEAD'], path, 30_000, signal);
  if (actual.stdout.trim().toLowerCase() !== packet.baseCommitSha.toLowerCase()) throw new Error('Materialized checkout does not match the authoring base commit.');
  const canonical = await realpath(path);
  if (checkpoint) {
    await materializeLfsObjects(canonical, checkpoint.resultBundle.lfsObjects);
    await materializeOutputs(outputRoot, checkpoint.resultBundle.outputs);
    const restored = await spawnWithInput('git.exe', ['apply', '--binary', '--index', '--whitespace=nowarn', '-'], canonical, checkpoint.patch, signal);
    if (restored.exitCode !== 0) throw new Error(`Could not restore durable Windows checkpoint: ${restored.stderr}`);
    if (checkpoint.resultBundle.lfsObjects.length > 0) {
      const checkoutLfs = await spawnComplete('git.exe', ['lfs', 'checkout'], canonical, 30_000, signal);
      if (checkoutLfs.exitCode !== 0) throw new Error(`Could not restore Git LFS working files: ${checkoutLfs.stderr}`);
    }
    const restoredTree = await gitTree(canonical, signal);
    if (restoredTree.toLowerCase() !== checkpoint.resultTreeSha.toLowerCase()) throw new Error('Restored Windows checkpoint tree does not match its recorded tree.');
    return { path: canonical, resumed: true };
  }
  return { path: canonical, resumed: false };
}

async function materializeOutputs(root: string, outputs: AuthoringDiskCheckpoint['resultBundle']['outputs']): Promise<void> {
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
  for (const output of outputs) {
    const content = Buffer.from(output.contentBase64, 'base64');
    if (content.length !== output.sizeBytes || createHash('sha256').update(content).digest('hex') !== output.sha256) throw new Error(`Durable checkpoint output is corrupt: ${output.path}`);
    const target = resolve(root, output.path); const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Durable checkpoint output escapes its root.');
    await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content);
  }
}

interface AuthoringDiskCheckpoint {
  version: 2; status: string; taskId: string; inputHash: string; baseCommitSha: string; resultTreeSha: string;
  tree: AuthoringTreeEntry[]; patch: string;
  resultBundle: { version: 1; format: 'git-binary-patch'; sha256: string; sizeBytes: number;
    lfsObjects: Array<{ oid: string; sha256: string; sizeBytes: number; contentBase64: string }>;
    outputs: Array<{ path: string; sha256: string; sizeBytes: number; contentBase64: string }> };
  updatedAt: string;
}

async function persistCheckpoint(path: string, packet: WindowsAuthoringPacket, workspacePath: string, status: string, signal?: AbortSignal, outputRoot?: string): Promise<void> {
  const resultTreeSha = await gitTree(workspacePath, signal);
  const patchResult = await spawnComplete('git.exe', ['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD'], workspacePath, 30_000, signal);
  if (patchResult.exitCode !== 0) throw new Error(`Could not persist Windows checkpoint: ${patchResult.stderr}`);
  const patchBytes = Buffer.from(patchResult.stdout, 'utf8'); const lfsObjects = await collectLfsObjects(workspacePath, signal);
  const outputs = outputRoot ? await collectManagedOutputs(outputRoot, packet.resourcePolicy.maxArtifactBytes) : [];
  const tree = await collectTree(workspacePath);
  const checkpoint: AuthoringDiskCheckpoint = { version: 2, status, taskId: packet.taskId, inputHash: packet.inputHash,
    baseCommitSha: packet.baseCommitSha, resultTreeSha, tree, patch: patchResult.stdout,
    resultBundle: { version: 1, format: 'git-binary-patch', sha256: createHash('sha256').update(patchBytes).digest('hex'),
      sizeBytes: patchBytes.length, lfsObjects, outputs }, updatedAt: new Date().toISOString() };
  await writeCheckpointAtomically(path, JSON.stringify(checkpoint));
}

async function writeCheckpointAtomically(path: string, content: string): Promise<void> {
  const generation = `${path}.generation-${Date.now().toString().padStart(16, '0')}-${randomUUID()}.json`; const temporary = `${generation}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, generation);
}

async function materializeLfsObjects(root: string, objects: AuthoringDiskCheckpoint['resultBundle']['lfsObjects']): Promise<void> {
  for (const object of objects) {
    const content = Buffer.from(object.contentBase64, 'base64');
    if (content.length !== object.sizeBytes || createHash('sha256').update(content).digest('hex') !== object.oid) throw new Error(`Durable checkpoint LFS object is corrupt: ${object.oid}`);
    const target = resolve(root, '.git', 'lfs', 'objects', object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
    await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content);
  }
}

async function rejectProhibitedResultPaths(packet: WindowsAuthoringPacket, root: string, signal?: AbortSignal): Promise<void> {
  const status = await spawnComplete('git.exe', ['status', '--porcelain=v1', '-z'], root, 30_000, signal);
  const paths = status.stdout.split('\0').filter(Boolean).map((line) => line.slice(3).replaceAll('\\', '/'));
  let prohibited: string | undefined;
  for (const path of paths) {
    let sizeBytes = 0; try { const info = await lstat(resolve(root, path)); if (info.isFile()) sizeBytes = info.size; } catch { /* deleted path */ }
    if (isProhibitedAuthoringPath(path, sizeBytes, packet.contentPolicy)) { prohibited = path; break; }
  }
  if (prohibited) throw new Error(`Generated cache or raw geospatial data cannot enter an authoring result: ${prohibited}`);
}

export function isProhibitedAuthoringPath(path: string, sizeBytes: number, policy: WindowsAuthoringPacket['contentPolicy']): boolean {
  const normalized = path.replaceAll('\\', '/'); const segments = normalized.toLowerCase().split('/');
  const prohibitedExtensions = policy.prohibitedDatasetExtensions.map((extension) => extension.toLowerCase());
  if (segments.some((segment) => ['deriveddatacache', 'intermediate', 'saved'].includes(segment)
    || prohibitedExtensions.some((extension) => segment.endsWith(extension)))) return true;
  const deliverableAsset = /\.(?:uasset|umap)$/i.test(normalized);
  return sizeBytes > policy.maxUnclassifiedFileBytes && !deliverableAsset;
}

async function stageChangedPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const staged = await spawnComplete('git.exe', ['add', '-A'], root, 30_000, signal);
  if (staged.exitCode !== 0) throw new Error(`Could not stage the complete authored result: ${staged.stderr}`);
  const changed = await spawnComplete('git.exe', ['diff', '--cached', '--name-only', '-z', 'HEAD'], root, 30_000, signal);
  if (changed.exitCode !== 0) throw new Error(`Could not inspect the staged authored result: ${changed.stderr}`);
  return changed.stdout.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'));
}

async function enforceRequiredUnrealAssets(packet: WindowsAuthoringPacket, root: string, evidenceRoot: string, changedPaths: string[], processes: WindowsAuthoringProcessResult[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!packet.contentPolicy.requiresUnrealAssets) return false;
  const assets = changedPaths.filter((path) => /\.(?:uasset|umap)$/i.test(path));
  const authored = processes.find((process) => process.exitCode === 0 && process.authoring?.phase === 'author'
    && ['unreal-editor', 'unreal-python'].includes(process.authoring.tool));
  if (assets.length > 0 && authored?.authoring) {
    const verification = await verifyUnrealPackages(root, evidenceRoot, assets, authored.authoring, timeoutMs, signal);
    processes.push({ ...verification, leaseId: packet.leaseId, sessionId: processes[0]?.sessionId ?? 'authoring-session' });
  }
  return validateRequiredUnrealAssets(assets, processes, requiresProductionContent(packet.step.acceptanceCriteria));
}

export function requiresProductionContent(criteria: string[]): boolean {
  return criteria.some((criterion) => /\b(?:usable|production(?:-ready)?|non-placeholder|finished)\b/i.test(criterion)
    && /\b(?:scene|map|asset|content|environment|level)\b/i.test(criterion));
}

export function validateRequiredUnrealAssets(assets: string[], processes: WindowsAuthoringProcessResult[], requireProduction = false): boolean {
  if (assets.length === 0) throw new Error('Required Unreal authoring did not produce a .uasset or .umap payload.');
  const authored = processes.find((process) => process.exitCode === 0 && process.authoring?.phase === 'author'
    && ['unreal-editor', 'unreal-python'].includes(process.authoring.tool));
  if (!authored) throw new Error('Required Unreal content was not created or imported through a successful editor authoring API call.');
  const verified = processes.find((process) => process.exitCode === 0 && process.authoring?.phase === 'verify'
    && ['unreal-editor', 'unreal-python'].includes(process.authoring.tool)
    && process.authoring.projectRelativePath === authored.authoring?.projectRelativePath
    && assets.every((asset) => process.authoring?.loadedPackages?.includes(asset)));
  if (!verified) throw new Error(`Required Unreal packages were not subsequently loaded by the selected project: ${assets.join(', ')}`);
  return requireProduction;
}

async function verifyUnrealPackages(root: string, evidenceRoot: string, assets: string[], authoring: NonNullable<WindowsAuthoringProcessResult['authoring']>, timeoutMs: number, signal?: AbortSignal): Promise<Omit<WindowsAuthoringProcessResult, 'leaseId' | 'sessionId'>> {
  const marker = 'FORGEMIND_PACKAGE_INSPECTION:';
  const sourceNames = authoring.sourceRelativePaths.map((path) => posix.basename(path.replaceAll('\\', '/')).toLowerCase());
  const packages = assets.map((path) => ({ path, objectPath: unrealObjectPath(path, authoring.projectRelativePath), sourceNames }));
  const scriptPath = resolve(evidenceRoot, 'verify-saved-unreal-content.py');
  const script = [
    'import unreal',
    `packages = ${JSON.stringify(packages)}`,
    'failed = []',
    'for package in packages:',
    "    loaded = unreal.load_asset(package['objectPath'])",
    "    if loaded is None:",
    "        failed.append(package['path'])",
    "        continue",
    "    observations = []",
    "    if not package['path'].lower().endswith('.umap'):",
    "        try:",
    "            import_data = loaded.get_editor_property('asset_import_data')",
    "            imported_names = [__import__('os').path.basename(path).lower() for path in import_data.extract_filenames()] if import_data else []",
    "            if any(name in package['sourceNames'] for name in imported_names): observations.append('asset-import-data-matches-recorded-source')",
    "        except Exception:",
    "            pass",
    "    if package['path'].lower().endswith('.umap'):",
    "        unreal.EditorLevelLibrary.load_level(package['objectPath'])",
    "        for actor in unreal.EditorLevelLibrary.get_all_level_actors():",
    "            class_name = actor.get_class().get_name()",
    "            if class_name in ['WorldSettings', 'DefaultPhysicsVolume', 'Brush']: continue",
    "            mesh_path = ''",
    "            if class_name == 'StaticMeshActor':",
    "                component = actor.get_component_by_class(unreal.StaticMeshComponent)",
    "                if component and component.static_mesh: mesh_path = component.static_mesh.get_path_name()",
    "            if class_name != 'StaticMeshActor' or (mesh_path and not mesh_path.startswith('/Engine/BasicShapes/')):",
    "                observations.append('non-basic-level-actor-present')",
    "                break",
    "    inspection = {'path': package['path'], 'className': loaded.get_class().get_name(), 'technicalObservations': observations}",
    `    print('${marker}' + __import__('json').dumps(inspection, separators=(',', ':')))`,
    "if failed: raise RuntimeError('Could not load saved packages: ' + ', '.join(failed))"
  ].join('\n');
  await writeFile(scriptPath, script, 'utf8');
  const projectPath = await realpath(resolve(root, authoring.projectRelativePath));
  const relativeProject = relative(root, projectPath);
  if (relativeProject === '..' || relativeProject.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Selected Unreal project escapes the leased checkout.');
  const args = [projectPath, '-unattended', '-nop4', '-nosplash', `-ExecutePythonScript=${scriptPath}`];
  const startedAt = new Date();
  const output = await spawnComplete(authoring.executablePath, args, root, timeoutMs, signal);
  const inspections = output.stdout.split(/\r?\n/).filter((line) => line.includes(marker)).flatMap((line) => {
    try { return [JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim()) as { path: string; className: string; technicalObservations: string[] }]; } catch { return []; }
  });
  const loadedPackages = inspections.map(({ path }) => path);
  return { checkId: 'unreal-saved-content-load', command: [authoring.executablePath, ...args].join(' '), shell: 'system', ...output,
    startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), authoring: { tool: 'unreal-python', phase: 'verify',
      projectRelativePath: authoring.projectRelativePath, executablePath: authoring.executablePath, args: args.slice(1), sourceRelativePaths: [], loadedPackages, inspections } };
}

export function unrealObjectPath(assetPath: string, projectRelativePath: string): string {
  const normalizedAsset = assetPath.replaceAll('\\', '/');
  const projectDirectory = posix.dirname(projectRelativePath.replaceAll('\\', '/'));
  const contentPrefix = projectDirectory === '.' ? 'Content/' : `${projectDirectory}/Content/`;
  if (!normalizedAsset.toLowerCase().startsWith(contentPrefix.toLowerCase())) throw new Error(`Changed Unreal package is outside the selected project's Content directory: ${assetPath}`);
  return `/Game/${normalizedAsset.slice(contentPrefix.length).replace(/\.(?:uasset|umap)$/i, '')}`;
}

async function collectLfsObjects(root: string, signal?: AbortSignal): Promise<Array<{ oid: string; sha256: string; sizeBytes: number; contentBase64: string }>> {
  const objects: Array<{ oid: string; sha256: string; sizeBytes: number; contentBase64: string }> = [];
  for (const entry of await collectTree(root)) {
    const indexed = await spawnComplete('git.exe', ['show', `:${entry.path}`], root, 30_000, signal);
    const pointer = indexed.stdout.match(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/);
    if (!pointer) continue;
    const oid = pointer[1]!; const object = await readFile(resolve(root, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
    if (createHash('sha256').update(object).digest('hex') !== oid || object.length !== Number(pointer[2])) throw new Error(`Git LFS object does not match pointer: ${entry.path}`);
    objects.push({ oid, sha256: oid, sizeBytes: object.length, contentBase64: object.toString('base64') });
  }
  return objects;
}

async function collectManagedOutputs(root: string, maxBytes: number): Promise<Array<{ path: string; sha256: string; sizeBytes: number; contentBase64: string }>> {
  const outputs: Array<{ path: string; sha256: string; sizeBytes: number; contentBase64: string }> = []; let total = 0;
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = resolve(directory, name); const info = await lstat(path);
      if (info.isDirectory()) await visit(path); else if (info.isFile()) {
        const content = await readFile(path); total += content.length;
        if (total > maxBytes) throw new Error('Managed authoring outputs exceed the configured artifact limit.');
        outputs.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex'),
          sizeBytes: content.length, contentBase64: content.toString('base64') });
      }
    }
  }
  await visit(root); return outputs.sort((a, b) => a.path.localeCompare(b.path));
}

async function spawnComplete(executable: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true }); let stdout = ''; let stderr = ''; let timedOut = false;
  let missingCapability = false;
  child.stdout?.on('data', (v) => { stdout += String(v); }); child.stderr?.on('data', (v) => { stderr += String(v); });
  const kill = () => { if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs); signal?.addEventListener('abort', kill, { once: true });
  const exitCode = await new Promise<number | undefined>((done) => { child.once('error', (e: NodeJS.ErrnoException) => { stderr += e.message; missingCapability = e.code === 'ENOENT'; done(undefined); }); child.once('close', (code) => done(code ?? undefined)); });
  clearTimeout(timer); signal?.removeEventListener('abort', kill); return { exitCode: timedOut ? undefined : exitCode, stdout, stderr,
    ...(timedOut ? { terminationReason: 'timed-out' as const } : signal?.aborted ? { terminationReason: 'cancelled' as const }
      : missingCapability ? { terminationReason: 'missing-capability' as const } : {}) };
}

async function spawnWithInput(executable: string, args: string[], cwd: string, input: string, signal?: AbortSignal) {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true }); let stdout = ''; let stderr = '';
  child.stdout?.on('data', (value) => { stdout += String(value); }); child.stderr?.on('data', (value) => { stderr += String(value); });
  const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true }); child.stdin?.end(input);
  const exitCode = await new Promise<number | undefined>((resolveExit) => { child.once('error', (error) => { stderr += error.message; resolveExit(undefined); }); child.once('close', (code) => resolveExit(code ?? undefined)); });
  signal?.removeEventListener('abort', abort); return { exitCode, stdout, stderr };
}

async function gitTree(root: string, signal?: AbortSignal): Promise<string> {
  await spawnComplete('git.exe', ['add', '-A'], root, 30_000, signal);
  const result = await spawnComplete('git.exe', ['write-tree'], root, 30_000, signal);
  if (!/^[a-f0-9]{40}$/i.test(result.stdout.trim())) throw new Error(`Could not inspect result tree: ${result.stderr}`);
  return result.stdout.trim();
}

async function collectTree(root: string): Promise<AuthoringTreeEntry[]> {
  const entries: AuthoringTreeEntry[] = [];
  async function visit(directory: string): Promise<void> { for (const name of await readdir(directory)) { if (name === '.git') continue; const path = resolve(directory, name); const info = await lstat(path); if (info.isDirectory()) await visit(path); else { const content = info.isSymbolicLink() ? Buffer.from(await realpath(path)) : await readFile(path); entries.push({ path: relative(root, path).replaceAll('\\', '/'), kind: info.isSymbolicLink() ? 'symlink' : 'file', sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.length, binary: content.includes(0), mode: info.isSymbolicLink() ? '120000' : (info.mode & 0o111) ? '100755' : '100644' }); } } }
  await visit(root); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
