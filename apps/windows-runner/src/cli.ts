#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { homedir, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { classifyWindowsExecutionPacket, isWindowsAuthoringPacket, isWindowsExecutionPacket, WINDOWS_AUTHORING_BLOB_CHUNK_BYTES, type WindowsAuthoringResult, type WorkerProbeEvidence } from '@forgemind/core';
import { createProvider, listCodexModels, resolveCodexBinary, type AIProvider, type ProviderModelOption } from '@forgemind/providers';
import { WindowsCredentialStore, type RunnerCredential } from './credential-store.js';
import { cleanupWindowsValidationWorkspace, executeWindowsValidation } from './executor.js';
import { executeWindowsAuthoring, LifecycleNativeImplementationProvider } from './authoring-executor.js';
import { runCapabilityProbes, windowsRunnerCapabilityProbes } from './probes.js';
import { runManualSession } from './session.js';
import { cleanupAcceptedWindowsAuthoring, prepareWindowsManagedRoots } from './managed-roots.js';
import { WindowsRunnerTransport } from './transport.js';
import { runBoundedProcess } from './process-runner.js';

const RUNNER_BUILD_ID = process.env.FORGEMIND_RUNNER_BUILD_ID?.trim().replace(/[^a-z0-9_.-]/gi, '-');
const RUNNER_VERSION = `0.2.0+authoring-v2${RUNNER_BUILD_ID ? `.${RUNNER_BUILD_ID}` : ''}`;

export type CliCommand =
  | { command: 'enroll'; apiUrl: string }
  | { command: 'probe'; apiUrl: string; json: boolean }
  | { command: 'session-start'; apiUrl: string; projectIds: string[]; workspaceRoot: string; artifactRoot: string }
  | { command: 'session-drain' | 'session-stop'; apiUrl: string; sessionId: string };

export function parseCliArgs(args: string[]): CliCommand {
  const command = args[0];
  const action = command === 'session' ? args[1] : undefined;
  const options = command === 'session' ? args.slice(2) : args.slice(1);
  const apiUrl = option(options, '--api-url');
  if (!apiUrl) throw new Error('--api-url is required.');
  if (command === 'enroll') return { command, apiUrl };
  if (command === 'probe') return { command, apiUrl, json: options.includes('--json') };
  if (command === 'session' && action === 'start') {
    const projectIds = optionsFor(options, '--project');
    if (projectIds.length === 0) throw new Error('At least one --project UUID is required for local activation.');
    if (projectIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new Error('--project values must be UUIDs.');
    const localRoot = process.env.LOCALAPPDATA ?? process.cwd();
    return {
      command: 'session-start', apiUrl, projectIds: [...new Set(projectIds)],
      workspaceRoot: option(options, '--workspace-root') ?? join(localRoot, 'ForgeMind', 'windows-runner', 'workspaces'),
      artifactRoot: option(options, '--artifact-root') ?? join(localRoot, 'ForgeMind', 'windows-runner', 'artifacts')
    };
  }
  if (command === 'session' && (action === 'drain' || action === 'stop')) {
    const sessionId = option(options, '--session-id');
    if (!sessionId) throw new Error('--session-id is required.');
    return { command: action === 'drain' ? 'session-drain' : 'session-stop', apiUrl, sessionId };
  }
  throw new Error('Usage: forgemind-windows-runner enroll|probe|session start --project <uuid>|session drain|session stop --api-url https://...');
}

export function selectLocalCodexModel(models: ProviderModelOption[], requestedModel?: string): string {
  const requested = requestedModel?.trim();
  if (models.length === 0) throw new Error('Codex reported no models available to the signed-in Windows account.');
  if (requested) {
    const selected = models.find((model) => model.id === requested);
    if (!selected) throw new Error(`Configured CODEX_MODEL "${requested}" is not available to the signed-in Windows account. Available models: ${models.map(({ id }) => id).join(', ')}.`);
    return selected.id;
  }
  return (models.find((model) => model.isDefault) ?? models[0])!.id;
}

export function assertNativeCodexCliCompatibility(help: string): void {
  const missing = ['--disable', '--ignore-user-config', '--ignore-rules', '--output-schema', '--permission-profile']
    .filter((flag) => !help.includes(flag));
  if (missing.length > 0) throw new Error(`The installed Codex CLI cannot run deterministic Windows authoring. Missing options: ${missing.join(', ')}. Update @openai/codex before starting a session.`);
}

export function requiredProbeFailures(
  evidence: readonly WorkerProbeEvidence[],
  environment: NodeJS.ProcessEnv = process.env
): WorkerProbeEvidence[] {
  const required = new Set(['windows', 'powershell', 'cmd', 'git', 'git-lfs', 'node', 'npm', 'codex', 'disk-capacity']);
  if (environment.FORGEMIND_UNREAL_EXECUTABLE) {
    for (const key of ['cmake', 'msvc', 'windows-sdk', 'interactive-desktop', 'gpu', 'unreal']) required.add(key);
  }
  return evidence.filter(({ capability, status }) => status !== 'supported' && required.has(capability.key));
}

async function runCodexCommand(binary: string, args: string[], codexHome: string): Promise<string> {
  const result = await runBoundedProcess(binary, args, { timeoutMs: 20_000, maxOutputBytes: 1_000_000,
    env: { ...process.env, CODEX_HOME: codexHome } });
  if (result.exitCode !== 0 || result.terminationReason) {
    throw new Error(`Could not inspect the installed Codex CLI: ${result.stderr || result.stdout || result.terminationReason || `exit ${result.exitCode}`}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

export async function prepareLocalCodexRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<{
  provider: AIProvider; model: string; codexHome: string; availableModels: string[];
}> {
  const codexHome = environment.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const binary = resolveCodexBinary(environment);
  const [execHelp, sandboxHelp] = await Promise.all([
    runCodexCommand(binary, ['exec', '--help'], codexHome),
    runCodexCommand(binary, ['sandbox', '--help'], codexHome)
  ]);
  assertNativeCodexCliCompatibility(`${execHelp}\n${sandboxHelp}`);
  const sandboxProbe = await runCodexCommand(binary, ['sandbox', '--permission-profile', ':workspace', '-C', process.cwd(), '--',
    'cmd.exe', '/d', '/c', 'echo FORGEMIND_SANDBOX_OK'], codexHome);
  if (!sandboxProbe.includes('FORGEMIND_SANDBOX_OK')) throw new Error('Codex Windows sandbox preflight did not execute the expected checkout-confined command.');
  const models = await listCodexModels({ codexHome, binary });
  const model = selectLocalCodexModel(models, environment.CODEX_MODEL);
  const provider = createProvider('codex', { authMode: 'codex_oauth', codexHome, model });
  const preflight = await provider.preflight();
  if (!preflight.ok) throw new Error(`Codex OAuth preflight failed before starting a Windows session: ${preflight.error?.auditSafeMessage ?? 'unknown error'}`);
  return { provider, model, codexHome, availableModels: models.map(({ id }) => id) };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (process.platform !== 'win32') throw new Error('ForgeMind Windows runner can run only on Windows.');
  const parsed = parseCliArgs(args);
  const transport = new WindowsRunnerTransport(parsed.apiUrl); const store = new WindowsCredentialStore();
  if (parsed.command === 'enroll') {
    const terminal = createInterface({ input: stdin, output: stdout });
    const code = await terminal.question('One-time enrollment code: '); terminal.close();
    const credential = await transport.enroll(code.trim()); await store.save(credential);
    stdout.write(`Enrolled device ${credential.deviceId}.\n`); return;
  }
  const auth = await store.load(); if (!auth) throw new Error('Runner is not enrolled.');
  if (parsed.command === 'session-drain') { await transport.drain(auth, parsed.sessionId); return; }
  if (parsed.command === 'session-stop') { await transport.stop(auth, parsed.sessionId); return; }
  stdout.write('[preflight] Checking Codex CLI, sandbox and OAuth...\n');
  const codexRuntime = await prepareLocalCodexRuntime();
  stdout.write(`[preflight] Codex passed; selected model ${codexRuntime.model}.\n`);
  stdout.write('[preflight] Checking local Windows capabilities...\n');
  const probes = await runCapabilityProbes(windowsRunnerCapabilityProbes(osRelease()), new Date(), (progress) => {
    stdout.write(progress.state === 'started'
      ? `[preflight] ${progress.capability.key}: checking...\n`
      : `[preflight] ${progress.capability.key}: ${progress.status === 'supported' ? 'passed' : 'FAILED'}\n`);
  });
  if (!process.env.FORGEMIND_UNREAL_EXECUTABLE) {
    stdout.write('[preflight] unreal: not configured; set FORGEMIND_UNREAL_EXECUTABLE in this process before testing Unreal authoring.\n');
  }
  stdout.write(`Codex preflight passed. Selected model: ${codexRuntime.model}. Available models: ${codexRuntime.availableModels.join(', ')}.\n`);
  const failedRequiredProbes = requiredProbeFailures(probes.evidence);
  if (parsed.command === 'probe') {
    if (parsed.json) stdout.write(`${JSON.stringify(probes.evidence, null, 2)}\n`);
    else for (const item of probes.evidence) stdout.write(`${item.status === 'supported' ? 'PASS' : 'FAIL'} ${item.capability.key}: ${item.summary}\n`);
    await transport.publishDevice(auth, { runnerVersion: RUNNER_VERSION, displayName: process.env.COMPUTERNAME ?? 'Windows runner', capabilities: probes.capabilities, probeEvidence: probes.evidence });
    assertRequiredProbesPassed(failedRequiredProbes);
    return;
  }
  if (parsed.command === 'session-start') {
    await transport.publishDevice(auth, { runnerVersion: RUNNER_VERSION, displayName: process.env.COMPUTERNAME ?? 'Windows runner', capabilities: probes.capabilities, probeEvidence: probes.evidence });
    assertRequiredProbesPassed(failedRequiredProbes);
    const managedRoots = await prepareWindowsManagedRoots(join(parsed.workspaceRoot, '..'));
    const adapterPolicy = readLocalAdapterPolicy();
    const controller = new AbortController(); process.once('SIGINT', () => controller.abort());
    await runManualSession(transport, auth, { projectIds: parsed.projectIds, signal: controller.signal,
      onClaim: async (claim, context) => {
        if (!claim.job || !claim.lease) return;
        if (isWindowsAuthoringPacket(claim.job.packet)) {
          stdout.write(`Running native Windows implementation ${claim.job.packet.jobId}.\n`);
          const executed = await executeWindowsAuthoring(claim.job.packet, { deviceId: auth.deviceId, sessionId: context.sessionId,
            workspaceRoot: managedRoots.work, artifactRoot: managedRoots.diagnostics, signal: context.signal,
            managedRoots, observedCapabilities: probes.capabilities,
            onProgress: (progress) => transport.publishAuthoringProgress(auth, progress).then(() => undefined),
            provider: new LifecycleNativeImplementationProvider(codexRuntime.provider) });
          const submitted = await submitAuthoringResultDurably(transport, auth, executed.result, context.signal,
            (message) => stdout.write(`${message}\n`));
          if (submitted.accepted && executed.result.status === 'succeeded') await cleanupAcceptedWindowsAuthoring(managedRoots, executed.result.taskId);
          stdout.write(`${executed.result.summary}\n`);
          return;
        }
        const disposition = classifyWindowsExecutionPacket(claim.job.packet);
        if (!isWindowsExecutionPacket(claim.job.packet)) {
          stdout.write(`Deferred (${disposition.status === 'deferred' ? `${disposition.handling}/${disposition.reason}` : 'manual-local'}): This runner does not support the leased protocol. No process was started.\n`);
          return;
        }
        if (disposition.status === 'deferred' && claim.job.packet.dispatch.kind !== 'deferred') {
          stdout.write(`Deferred (${disposition.handling}/${disposition.reason}): ${disposition.message} No process was started.\n`);
          return;
        }
        stdout.write(`Running Windows validation ${claim.job.packet.checkId}: ${claim.job.packet.check.command}\n`);
        try {
          const executed = await executeWindowsValidation(claim.job.packet, {
            deviceId: auth.deviceId,
            sessionId: context.sessionId,
            workspaceRoot: parsed.workspaceRoot,
            artifactRoot: parsed.artifactRoot,
            observedCapabilities: probes.capabilities,
            signal: context.signal,
            allowedFixtureExecutablePaths: adapterPolicy.allowedFixtureExecutablePaths,
            pinnedFixtureTools: adapterPolicy.pinnedFixtureTools,
            pinnedUnrealTools: adapterPolicy.pinnedUnrealTools,
            approvedUnrealProfiles: adapterPolicy.approvedUnrealProfiles,
            pinnedRuntimeApplications: adapterPolicy.pinnedRuntimeApplications,
            showLocally: (summary) => stdout.write(`${summary}\n`)
          });
          await transport.uploadEvidence(auth, executed.evidence);
          const submitted = await transport.submitResult(auth, executed.result);
          if (!submitted.accepted) throw new Error(`ForgeMind rejected Windows validation result ${executed.result.jobId}.`);
          stdout.write(`${executed.result.summary}\n`);
        } finally {
          await cleanupWindowsValidationWorkspace(parsed.workspaceRoot, parsed.artifactRoot, claim.job.id);
        }
      } });
    return;
  }
}

export async function submitAuthoringResultDurably(transport: WindowsRunnerTransport, auth: RunnerCredential, result: WindowsAuthoringResult,
  signal?: AbortSignal, report: (message: string) => void = () => undefined): Promise<{ accepted: boolean }> {
  let delayMs = 1_000;
  while (!signal?.aborted) {
    try {
      const manifest = await uploadAuthoringResultBlobs(transport, auth, result);
      const submitted = await transport.submitResult(auth, manifest);
      if (!submitted.accepted) throw new Error(`ForgeMind rejected Windows authoring result ${result.jobId}.`);
      return submitted;
    } catch (error) {
      report(`Authoring result delivery will retry: ${error instanceof Error ? error.message : String(error)}`);
      await abortableDelay(delayMs, signal);
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
  throw new Error(`Authoring result ${result.jobId} was not delivered before its lease was cancelled. The durable local checkpoint was preserved.`);
}

export async function uploadAuthoringResultBlobs(transport: WindowsRunnerTransport, auth: RunnerCredential,
  result: WindowsAuthoringResult): Promise<WindowsAuthoringResult> {
  const unique = new Map<string, { sha256: string; sizeBytes: number; contentBase64: string }>();
  const patchBytes = Buffer.from(result.patch, 'utf8');
  unique.set(result.resultBundle.sha256, { sha256: result.resultBundle.sha256, sizeBytes: patchBytes.length,
    contentBase64: patchBytes.toString('base64') });
  for (const entry of [...result.resultBundle.lfsObjects, ...result.resultBundle.outputs]) {
    if (entry.contentBase64 === undefined) continue;
    unique.set(entry.sha256, { sha256: entry.sha256, sizeBytes: entry.sizeBytes, contentBase64: entry.contentBase64 });
  }
  for (const blob of unique.values()) {
    const content = Buffer.from(blob.contentBase64, 'base64');
    if (content.length !== blob.sizeBytes) throw new Error(`Authoring blob ${blob.sha256} has an invalid decoded size.`);
    const totalChunks = Math.max(1, Math.ceil(content.length / WINDOWS_AUTHORING_BLOB_CHUNK_BYTES));
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const chunk = content.subarray(chunkIndex * WINDOWS_AUTHORING_BLOB_CHUNK_BYTES, (chunkIndex + 1) * WINDOWS_AUTHORING_BLOB_CHUNK_BYTES);
      await transport.uploadAuthoringBlobChunk(auth, { jobId: result.jobId, leaseId: result.leaseId, sessionId: result.sessionId,
        nonce: result.nonce, inputHash: result.inputHash, sha256: blob.sha256, sizeBytes: chunk.length,
        chunkIndex, totalChunks, contentBase64: chunk.toString('base64') });
    }
    await transport.completeAuthoringBlob(auth, { jobId: result.jobId, leaseId: result.leaseId, sessionId: result.sessionId,
      nonce: result.nonce, inputHash: result.inputHash, sha256: blob.sha256, sizeBytes: content.length, totalChunks });
  }
  const reference = <T extends { sha256: string; contentBase64?: string; blobSha256?: string }>(entry: T): T => {
    if (entry.contentBase64 === undefined) return entry;
    const { contentBase64: _contentBase64, ...rest } = entry;
    return { ...rest, blobSha256: entry.sha256 } as T;
  };
  return { ...result, patch: '', patchBlobSha256: result.resultBundle.sha256, resultBundle: { ...result.resultBundle,
    lfsObjects: result.resultBundle.lfsObjects.map(reference), outputs: result.resultBundle.outputs.map(reference) } };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => { const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolveDelay(); }, { once: true }); });
}

function assertRequiredProbesPassed(failures: readonly WorkerProbeEvidence[]): void {
  if (failures.length === 0) return;
  throw new Error(`Windows runner preflight failed. No session was started. Fix: ${failures.map(({ capability, summary }) => `${capability.key} (${summary})`).join('; ')}`);
}

interface LocalAdapterPolicy {
  allowedFixtureExecutablePaths: string[];
  pinnedFixtureTools: import('./executor.js').PinnedFixtureTool[];
  pinnedUnrealTools: import('./unreal-adapter.js').PinnedUnrealTool[];
  approvedUnrealProfiles: import('./unreal-adapter.js').ApprovedUnrealProfile[];
  pinnedRuntimeApplications: import('./executor.js').PinnedRuntimeApplication[];
}

function readLocalAdapterPolicy(): LocalAdapterPolicy {
  const raw = process.env.FORGEMIND_WINDOWS_ADAPTER_POLICY;
  if (!raw) return { allowedFixtureExecutablePaths: [], pinnedFixtureTools: [], pinnedUnrealTools: [], approvedUnrealProfiles: [], pinnedRuntimeApplications: [] };
  const value = JSON.parse(raw) as Partial<LocalAdapterPolicy>;
  return {
    allowedFixtureExecutablePaths: Array.isArray(value.allowedFixtureExecutablePaths) ? value.allowedFixtureExecutablePaths : [],
    pinnedFixtureTools: Array.isArray(value.pinnedFixtureTools) ? value.pinnedFixtureTools : [],
    pinnedUnrealTools: Array.isArray(value.pinnedUnrealTools) ? value.pinnedUnrealTools : [],
    approvedUnrealProfiles: Array.isArray(value.approvedUnrealProfiles) ? value.approvedUnrealProfiles : [],
    pinnedRuntimeApplications: Array.isArray(value.pinnedRuntimeApplications) ? value.pinnedRuntimeApplications : []
  };
}

function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function optionsFor(args: string[], name: string): string[] { return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
