import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { canonicalizeWorkerProbeEvidence, type WorkerCapability, type WorkerProbeEvidence } from '@forgemind/core';

export interface CapabilityProbe { capability: WorkerCapability; executable?: string; args?: readonly string[] }
export interface ProbeResult { capabilities: WorkerCapability[]; evidence: WorkerProbeEvidence[] }

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
