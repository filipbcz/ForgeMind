import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthoringTreeEntry, WindowsAuthoringPacket, WindowsAuthoringProcessResult, WindowsAuthoringResult } from '@forgemind/core';
import { redactSecrets } from '@forgemind/core';
import type { AIProvider } from '@forgemind/providers';
import { buildSandboxedProcessInvocation } from './native-sandbox.js';

export interface NativeAuthoringTools {
  root: string;
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
  deviceId: string; sessionId: string; workspaceRoot: string; artifactRoot: string; signal?: AbortSignal; provider: NativeImplementationProvider;
}): Promise<{ result: WindowsAuthoringResult; workspacePath: string }> {
  if (process.platform !== 'win32') throw new Error('Windows authoring can run only on Windows.');
  const workspacePath = await prepareCheckout(packet, context.workspaceRoot, context.signal);
  if (packet.step.priorPatch?.trim()) {
    const prior = await spawnWithInput('git.exe', ['apply', '--binary', '--whitespace=nowarn', '-'], workspacePath, packet.step.priorPatch, context.signal);
    if (prior.exitCode !== 0) throw new Error(`Could not materialize the previous Windows attempt: ${prior.stderr}`);
  }
  const processes: WindowsAuthoringProcessResult[] = [];
  const evidenceDirectory = managedChild(context.artifactRoot, packet.jobId);
  await rm(evidenceDirectory, { recursive: true, force: true });
  await mkdir(evidenceDirectory, { recursive: true });
  const tools = createTools(workspacePath, resolve(evidenceDirectory, 'native-processes.jsonl'), packet.resourcePolicy.timeoutSeconds * 1_000,
    context.signal, processes, packet.leaseId, context.sessionId);
  const startedAt = new Date();
  let status: WindowsAuthoringResult['status'] = 'succeeded';
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
  }
  await rm(resolve(workspacePath, '.forgemind-tmp'), { recursive: true, force: true });
  const tree = await collectTree(workspacePath);
  const treeSha = await gitTree(workspacePath, context.signal);
  const patchResult = await spawnComplete('git.exe', ['diff', '--binary', '--no-ext-diff', '--cached', 'HEAD'], workspacePath, 30_000, context.signal);
  if (patchResult.exitCode !== 0) throw new Error(`Could not package result tree: ${patchResult.stderr}`);
  return { workspacePath, result: {
    kind: 'authoring-result', protocolVersion: packet.protocolVersion, projectId: packet.projectId, taskId: packet.taskId,
    runId: packet.runId, jobId: packet.jobId, leaseId: packet.leaseId, deviceId: context.deviceId, sessionId: context.sessionId,
    nonce: packet.nonce, inputHash: packet.inputHash, baseCommitSha: packet.baseCommitSha, resultTreeSha: treeSha,
    tree, patch: patchResult.stdout, completedOperationIds, checkpointIds, artifacts: [], processes, status,
    startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), summary
  } };
}

function managedChild(root: string, name: string): string {
  const target = resolve(root, name); const rel = relative(resolve(root), target);
  if (!name || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Managed authoring path escapes its root.');
  return target;
}

function createTools(root: string, evidencePath: string, timeoutMs: number, signal: AbortSignal | undefined, results: WindowsAuthoringProcessResult[], leaseId: string, sessionId: string): NativeAuthoringTools {
  let evidenceOffset = 0;
  const sandboxExecutable = process.env.FORGEMIND_CODEX_CLI_PATH?.trim() || 'codex';
  const contained = (path: string) => { const target = resolve(root, path); const rel = relative(root, target); if (rel.startsWith('..') || rel === '..') throw new Error('Tool path escapes the leased checkout.'); return target; };
  return {
    root,
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
    async write(path, content) { const target = contained(path); await mkdir(resolve(target, '..'), { recursive: true }); const { writeFile } = await import('node:fs/promises'); await writeFile(target, content); },
    remove: (path) => rm(contained(path), { recursive: true, force: true }),
    async record(result) { results.push({ ...result, leaseId, sessionId, stdout: redactSecrets(result.stdout), stderr: redactSecrets(result.stderr) }); },
    async run(input) {
      const startedAt = new Date();
      const sandboxed = buildSandboxedProcessInvocation({ sandboxExecutable, checkoutRoot: root, command: input.command, shell: input.shell });
      const output = await spawnComplete(sandboxed.executable, sandboxed.args, root, timeoutMs, signal);
      const result = { leaseId, sessionId, checkId: input.checkId ?? randomUUID(), command: input.command, shell: input.shell, ...output,
        stdout: redactSecrets(output.stdout), stderr: redactSecrets(output.stderr), startedAt: startedAt.toISOString(), completedAt: new Date().toISOString() };
      results.push(result); return result;
    }
  };
}

async function prepareCheckout(packet: WindowsAuthoringPacket, root: string, signal?: AbortSignal): Promise<string> {
  await mkdir(root, { recursive: true }); const path = resolve(root, packet.jobId); await rm(path, { recursive: true, force: true });
  const clone = await spawnComplete('git.exe', ['clone', '--no-checkout', packet.sourceUrl, path], root, packet.resourcePolicy.timeoutSeconds * 1000, signal);
  if (clone.exitCode !== 0) throw new Error(`Checkout clone failed: ${clone.stderr}`);
  const checkout = await spawnComplete('git.exe', ['checkout', '--detach', packet.baseCommitSha], path, packet.resourcePolicy.timeoutSeconds * 1000, signal);
  if (checkout.exitCode !== 0) throw new Error(`Checkout materialization failed: ${checkout.stderr}`);
  const actual = await spawnComplete('git.exe', ['rev-parse', 'HEAD'], path, 30_000, signal);
  if (actual.stdout.trim().toLowerCase() !== packet.baseCommitSha.toLowerCase()) throw new Error('Materialized checkout does not match the authoring base commit.');
  return await realpath(path);
}

async function spawnComplete(executable: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true }); let stdout = ''; let stderr = ''; let timedOut = false;
  child.stdout?.on('data', (v) => { stdout += String(v); }); child.stderr?.on('data', (v) => { stderr += String(v); });
  const kill = () => { if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs); signal?.addEventListener('abort', kill, { once: true });
  const exitCode = await new Promise<number | undefined>((done) => { child.once('error', (e) => { stderr += e.message; done(undefined); }); child.once('close', (code) => done(code ?? undefined)); });
  clearTimeout(timer); signal?.removeEventListener('abort', kill); return { exitCode: timedOut ? undefined : exitCode, stdout, stderr };
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
