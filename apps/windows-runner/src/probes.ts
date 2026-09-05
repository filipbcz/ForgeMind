import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { canonicalizeWorkerProbeEvidence, type WorkerCapability, type WorkerProbeEvidence } from '@forgemind/core';

export interface CapabilityProbe {
  capability: WorkerCapability;
  executable?: string;
  args?: readonly string[];
  kind?: 'process' | 'windows-platform' | 'disk';
  path?: string;
}
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
    { capability: { key: 'windows', version: windowsVersion }, kind: 'windows-platform', executable: nodeExecutable },
    { capability: { key: 'powershell' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
    { capability: { key: 'cmd' }, executable: 'cmd.exe', args: ['/d', '/c', 'ver'] },
    { capability: { key: 'git' }, executable: 'git.exe', args: ['--version'] },
    { capability: { key: 'git-lfs' }, executable: 'git-lfs.exe', args: ['version'] },
    { capability: { key: 'node' }, executable: nodeExecutable, args: ['--version'] },
    { capability: { key: 'npm' }, executable: 'npm.cmd', args: ['--version'] },
    { capability: { key: 'cmake' }, executable: 'cmake.exe', args: ['--version'] },
    { capability: { key: 'msvc' }, executable: 'cl.exe', args: ['/Bv'] },
    { capability: { key: 'windows-sdk' }, executable: 'where.exe', args: ['rc.exe'] },
    { capability: { key: 'interactive-desktop' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "if (-not [Environment]::UserInteractive) { exit 2 }; [Environment]::UserName"] },
    { capability: { key: 'gpu' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "$g=Get-CimInstance Win32_VideoController | Where-Object {$_.AdapterRAM -gt 0} | Select-Object -First 1; if (-not $g) { exit 2 }; \"$($g.Name) driver=$($g.DriverVersion)\""] },
    { capability: { key: 'disk-capacity' }, kind: 'disk', path: environment.FORGEMIND_WINDOWS_WORKSPACE_ROOT ?? process.cwd() }
  ];
  if (environment.FORGEMIND_UNREAL_EXECUTABLE) {
    probes.push(unrealCapabilityProbe(environment.FORGEMIND_UNREAL_EXECUTABLE, environment.FORGEMIND_UNREAL_VERSION ?? 'configured'));
  }
  if (environment.FORGEMIND_CESIUM_EXECUTABLE) probes.push({ capability: { key: 'cesium', ...(environment.FORGEMIND_CESIUM_VERSION ? { version: environment.FORGEMIND_CESIUM_VERSION } : {}) },
    executable: environment.FORGEMIND_CESIUM_EXECUTABLE, args: ['--version'] });
  if (environment.FORGEMIND_ASSET_TOOL_EXECUTABLE) probes.push({ capability: { key: 'asset-tool', ...(environment.FORGEMIND_ASSET_TOOL_VERSION ? { version: environment.FORGEMIND_ASSET_TOOL_VERSION } : {}) },
    executable: environment.FORGEMIND_ASSET_TOOL_EXECUTABLE, args: ['--version'] });
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
    let status: WorkerProbeEvidence['status'] = 'supported';
    let summary = 'Local probe succeeded.';
    let capability = probe.capability;
    try {
      if (probe.kind === 'windows-platform') {
        const output = await executeProbe(probe.executable!, ['-e', "if(process.platform!=='win32')process.exit(2);process.stdout.write(process.execPath)"]);
        capability = withEvidenceMetadata(capability, probe.executable!, output);
      } else if (probe.kind === 'disk') {
        const stats = await statfs(probe.path!);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) throw new Error('free byte count is not a safe integer');
        capability = { ...capability, version: String(freeBytes), metadata: { path: probe.path!, freeBytes } };
        summary = `Local disk probe succeeded: ${freeBytes} bytes free.`;
      } else if (probe.executable) {
        const output = await executeProbe(probe.executable, probe.args ?? []);
        capability = withEvidenceMetadata(capability, probe.executable, output);
        summary = `Local tool probe succeeded: ${redactProbeOutput(output)}`;
      } else throw new Error('probe has no executable evidence source');
    } catch (error) {
      status = 'unsupported';
      summary = `Local probe failed: ${redactProbeOutput(error instanceof Error ? error.message : 'unknown error')}`;
    }
    const evidence = { capability, status, probedAt: now.toISOString(), probeVersion: '2', provenance: 'local-probe' as const, summary };
    return { schemaVersion: 1, ...evidence, evidenceHash: createHash('sha256').update(canonicalizeWorkerProbeEvidence(evidence)).digest('hex') };
  }));
  return { evidence, capabilities: evidence.filter((item) => item.status === 'supported').map((item) => item.capability) };
}

function executeProbe(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-4096); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', (error) => reject(new Error(`${error.message}; executable=${executable}`)));
    child.once('close', (code) => code === 0 ? resolve(stdout || stderr) : reject(new Error(`probe exited with code ${code}: ${stderr || stdout || 'no output'}`)));
  });
}

function withEvidenceMetadata(capability: WorkerCapability, executable: string, output: string): WorkerCapability {
  const observed = redactProbeOutput(output);
  return { ...capability, version: capability.version ?? observed.split(/\s+/).find((part) => /\d/.test(part)) ?? 'observed',
    metadata: { ...capability.metadata, executable, observed } };
}

/** Keep diagnostics useful without persisting credentials, home paths, or command output floods. */
export function redactProbeOutput(value: string): string {
  return value.replace(/(?:https?:\/\/)?[^\s:@/]+:[^\s@/]+@/gi, '[redacted]@')
    .replace(/(token|password|secret|authorization)\s*[:=]\s*[^\s;]+/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%')
    .replace(/[\r\n\t ]+/g, ' ').trim().slice(0, 500) || 'no output';
}
