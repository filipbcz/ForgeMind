import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { canonicalizeWorkerProbeEvidence, type WorkerCapability, type WorkerProbeEvidence } from '@forgemind/core';

export interface CapabilityProbe { capability: WorkerCapability; executable?: string; args?: readonly string[] }
export interface ProbeResult { capabilities: WorkerCapability[]; evidence: WorkerProbeEvidence[] }

export const unrealCapabilityProbe = (executable: string, version: string): CapabilityProbe => ({
  capability: { key: 'unreal', version, metadata: { executable } }, executable, args: ['-version']
});

/**
 * Capabilities published by the runner must be backed by a local process probe.
 * Extra installations can be declared as JSON in FORGEMIND_WINDOWS_TOOL_PROBES;
 * declaring them is not sufficient -- the configured executable still has to run.
 */
export function windowsRunnerCapabilityProbes(
  windowsVersion: string,
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath
): CapabilityProbe[] {
  const probes: CapabilityProbe[] = [
    { capability: { key: 'windows', version: windowsVersion } },
    { capability: { key: 'powershell' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
    { capability: { key: 'cmd' }, executable: 'cmd.exe', args: ['/d', '/c', 'ver'] },
    { capability: { key: 'git' }, executable: 'git.exe', args: ['--version'] },
    { capability: { key: 'node' }, executable: nodeExecutable, args: ['--version'] },
    { capability: { key: 'npm' }, executable: 'npm.cmd', args: ['--version'] },
    { capability: { key: 'cmake' }, executable: 'cmake.exe', args: ['--version'] },
    { capability: { key: 'msvc' }, executable: 'cl.exe', args: ['/Bv'] }
  ];
  if (environment.FORGEMIND_UNREAL_EXECUTABLE) {
    probes.push(unrealCapabilityProbe(environment.FORGEMIND_UNREAL_EXECUTABLE, environment.FORGEMIND_UNREAL_VERSION ?? 'configured'));
  }
  if (environment.FORGEMIND_WINDOWS_TOOL_PROBES) probes.push(...parseConfiguredToolProbes(environment.FORGEMIND_WINDOWS_TOOL_PROBES));
  const identities = new Set<string>();
  return probes.filter(({ capability }) => {
    const identity = `${capability.key}\u0000${capability.version ?? ''}`;
    if (identities.has(identity)) return false;
    identities.add(identity); return true;
  });
}

export function parseConfiguredToolProbes(value: string): CapabilityProbe[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('FORGEMIND_WINDOWS_TOOL_PROBES must be valid JSON.'); }
  if (!Array.isArray(parsed)) throw new Error('FORGEMIND_WINDOWS_TOOL_PROBES must be a JSON array.');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Tool probe ${index} must be an object.`);
    const candidate = item as Record<string, unknown>;
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
    const executable = typeof candidate.executable === 'string' ? candidate.executable.trim() : '';
    if (!key || key === 'windows' || !executable) throw new Error(`Tool probe ${index} requires a non-Windows key and executable.`);
    if (candidate.version !== undefined && (typeof candidate.version !== 'string' || !candidate.version.trim())) throw new Error(`Tool probe ${index} version must be a non-empty string.`);
    if (candidate.args !== undefined && (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== 'string'))) throw new Error(`Tool probe ${index} args must be a string array.`);
    return {
      capability: { key, ...(typeof candidate.version === 'string' ? { version: candidate.version.trim() } : {}) },
      executable,
      args: (candidate.args as string[] | undefined) ?? ['--version']
    };
  });
}

export async function runCapabilityProbes(probes: readonly CapabilityProbe[], now = new Date()): Promise<ProbeResult> {
  const evidence = await Promise.all(probes.map(async (probe): Promise<WorkerProbeEvidence> => {
    let status: WorkerProbeEvidence['status'] = 'supported'; let summary = 'Local platform probe succeeded.';
    if (probe.executable) {
      try { const output = await executeProbe(probe.executable, probe.args ?? []); summary = `Local tool probe succeeded: ${output.trim().slice(0, 200)}`; }
      catch (error) { status = 'unsupported'; summary = `Local tool probe failed: ${error instanceof Error ? error.message : 'unknown error'}`; }
    }
    const evidence = { capability: probe.capability, status, probedAt: now.toISOString(), probeVersion: '1', summary };
    return { schemaVersion: 1, ...evidence, evidenceHash: createHash('sha256').update(canonicalizeWorkerProbeEvidence(evidence)).digest('hex') };
  }));
  return { evidence, capabilities: evidence.filter((item) => item.status === 'supported').map((item) => item.capability) };
}

function executeProbe(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`probe exited with code ${code}`)));
  });
}
