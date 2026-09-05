#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { release as osRelease } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { classifyWindowsExecutionPacket, isWindowsAuthoringPacket, isWindowsExecutionPacket } from '@forgemind/core';
import { createProvider } from '@forgemind/providers';
import { WindowsCredentialStore } from './credential-store.js';
import { cleanupWindowsValidationWorkspace, executeWindowsValidation } from './executor.js';
import { executeWindowsAuthoring, LifecycleNativeImplementationProvider } from './authoring-executor.js';
import { runCapabilityProbes, windowsRunnerCapabilityProbes } from './probes.js';
import { runManualSession } from './session.js';
import { cleanupAcceptedWindowsAuthoring, prepareWindowsManagedRoots } from './managed-roots.js';
import { WindowsRunnerTransport } from './transport.js';

const RUNNER_VERSION = '0.1.0';

export type CliCommand =
  | { command: 'enroll' | 'probe'; apiUrl: string }
  | { command: 'session-start'; apiUrl: string; projectIds: string[]; workspaceRoot: string; artifactRoot: string }
  | { command: 'session-drain' | 'session-stop'; apiUrl: string; sessionId: string };

export function parseCliArgs(args: string[]): CliCommand {
  const command = args[0];
  const action = command === 'session' ? args[1] : undefined;
  const options = command === 'session' ? args.slice(2) : args.slice(1);
  const apiUrl = option(options, '--api-url');
  if (!apiUrl) throw new Error('--api-url is required.');
  if (command === 'enroll' || command === 'probe') return { command, apiUrl };
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
  const probes = await runCapabilityProbes(windowsRunnerCapabilityProbes(osRelease()));
  if (parsed.command === 'probe') {
    await transport.publishDevice(auth, { runnerVersion: RUNNER_VERSION, displayName: process.env.COMPUTERNAME ?? 'Windows runner', capabilities: probes.capabilities, probeEvidence: probes.evidence });
    stdout.write(`${JSON.stringify(probes.evidence, null, 2)}\n`); return;
  }
  if (parsed.command === 'session-start') {
    const managedRoots = await prepareWindowsManagedRoots(join(parsed.workspaceRoot, '..'));
    const adapterPolicy = readLocalAdapterPolicy();
    await transport.publishDevice(auth, { runnerVersion: RUNNER_VERSION, displayName: process.env.COMPUTERNAME ?? 'Windows runner', capabilities: probes.capabilities, probeEvidence: probes.evidence });
    const controller = new AbortController(); process.once('SIGINT', () => controller.abort());
    await runManualSession(transport, auth, { projectIds: parsed.projectIds, signal: controller.signal,
      onClaim: async (claim, context) => {
        if (!claim.job || !claim.lease) return;
        if (isWindowsAuthoringPacket(claim.job.packet)) {
          stdout.write(`Running native Windows implementation ${claim.job.packet.jobId}.\n`);
          const executed = await executeWindowsAuthoring(claim.job.packet, { deviceId: auth.deviceId, sessionId: context.sessionId,
            workspaceRoot: managedRoots.work, artifactRoot: managedRoots.diagnostics, signal: context.signal,
            managedRoots,
            provider: new LifecycleNativeImplementationProvider(createProvider('codex')) });
          const submitted = await transport.submitResult(auth, executed.result);
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
          await transport.submitResult(auth, executed.result);
          stdout.write(`${executed.result.summary}\n`);
        } finally {
          await cleanupWindowsValidationWorkspace(parsed.workspaceRoot, parsed.artifactRoot, claim.job.id);
        }
      } });
    return;
  }
  if (parsed.command === 'session-drain') { await transport.drain(auth, parsed.sessionId); return; }
  if (parsed.command === 'session-stop') { await transport.stop(auth, parsed.sessionId); return; }
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
