#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { release as osRelease } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';
import { WindowsCredentialStore } from './credential-store.js';
import { cleanupWindowsValidationWorkspace, executeWindowsValidation } from './executor.js';
import { runCapabilityProbes } from './probes.js';
import { runManualSession } from './session.js';
import { WindowsRunnerTransport } from './transport.js';

const RUNNER_VERSION = '0.1.0';

export type CliCommand =
  | { command: 'enroll' | 'probe'; apiUrl: string }
  | { command: 'session-start'; apiUrl: string; minutes: number; workspaceRoot: string; artifactRoot: string }
  | { command: 'session-drain'; apiUrl: string; sessionId: string };

export function parseCliArgs(args: string[]): CliCommand {
  const command = args[0];
  const action = command === 'session' ? args[1] : undefined;
  const options = command === 'session' ? args.slice(2) : args.slice(1);
  const apiUrl = option(options, '--api-url');
  if (!apiUrl) throw new Error('--api-url is required.');
  if (command === 'enroll' || command === 'probe') return { command, apiUrl };
  if (command === 'session' && action === 'start') {
    const minutes = Number(option(options, '--minutes') ?? '60');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) throw new Error('--minutes must be an integer from 1 to 720.');
    const localRoot = process.env.LOCALAPPDATA ?? process.cwd();
    return {
      command: 'session-start', apiUrl, minutes,
      workspaceRoot: option(options, '--workspace-root') ?? join(localRoot, 'ForgeMind', 'windows-runner', 'workspaces'),
      artifactRoot: option(options, '--artifact-root') ?? join(localRoot, 'ForgeMind', 'windows-runner', 'artifacts')
    };
  }
  if (command === 'session' && action === 'drain') {
    const sessionId = option(options, '--session-id');
    if (!sessionId) throw new Error('--session-id is required.');
    return { command: 'session-drain', apiUrl, sessionId };
  }
  throw new Error('Usage: forgemind-windows-runner enroll|probe|session start|session drain --api-url https://...');
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
  const probes = await runCapabilityProbes([{ capability: { key: 'windows', version: osRelease() } }]);
  if (parsed.command === 'probe') {
    await transport.publishDevice(auth, { runnerVersion: RUNNER_VERSION, displayName: process.env.COMPUTERNAME ?? 'Windows runner', capabilities: probes.capabilities, probeEvidence: probes.evidence });
    stdout.write(`${JSON.stringify(probes.evidence, null, 2)}\n`); return;
  }
  if (parsed.command === 'session-start') {
    await transport.publishDevice(auth, { runnerVersion: RUNNER_VERSION, displayName: process.env.COMPUTERNAME ?? 'Windows runner', capabilities: probes.capabilities, probeEvidence: probes.evidence });
    const controller = new AbortController(); process.once('SIGINT', () => controller.abort());
    await runManualSession(transport, auth, { durationMinutes: parsed.minutes, signal: controller.signal,
      onClaim: async (claim, context) => {
        if (!claim.job || !claim.lease) return;
        stdout.write(`Running Windows validation ${claim.job.packet.checkId}: ${claim.job.packet.check.command}\n`);
        try {
          const executed = await executeWindowsValidation(claim.job.packet, {
            deviceId: auth.deviceId,
            sessionId: context.sessionId,
            workspaceRoot: parsed.workspaceRoot,
            artifactRoot: parsed.artifactRoot,
            observedCapabilities: probes.capabilities,
            signal: context.signal
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
}

function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
