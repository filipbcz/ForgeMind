import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 as windowsPath } from 'node:path';
import { canonicalizeWorkerProbeEvidence, type WorkerCapability, type WorkerProbeEvidence } from '@forgemind/core';
import { resolveCodexBinary } from '@forgemind/providers';
import { runBoundedProcess } from './process-runner.js';

export interface CapabilityProbe {
  capability: WorkerCapability;
  executable?: string;
  args?: readonly string[];
  kind?: 'process' | 'process-alternatives' | 'windows-platform' | 'disk' | 'msvc' | 'unreal';
  alternatives?: readonly CapabilityProbeCommand[];
  path?: string;
  timeoutMs?: number;
  expectedVersion?: string;
}

export interface CapabilityProbeCommand {
  executable: string;
  args: readonly string[];
  input?: string;
  label?: string;
  outputPattern?: RegExp;
  expectedOutput?: string;
}

export interface ProbeResult { capabilities: WorkerCapability[]; evidence: WorkerProbeEvidence[] }
export interface ProbeProgress { capability: WorkerCapability; state: 'started' | 'completed'; status?: WorkerProbeEvidence['status']; summary?: string }

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const MSVC_PROBE_TIMEOUT_MS = 120_000;
const UNREAL_PROBE_TIMEOUT_MS = 240_000;

const PROJ_PYTHON_PROBE = [
  'import math',
  'import pyproj',
  'transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)',
  'x, y = transformer.transform(14.4179, 50.1266)',
  'assert math.isfinite(x) and math.isfinite(y)',
  'print(f"PROJ {pyproj.proj_version_str} pyproj {pyproj.__version__} transformed={x:.3f},{y:.3f}")'
].join('\n');

const GIS_PYTHON_PROBE = [
  'import numpy as np',
  'import rasterio',
  'from rasterio.io import MemoryFile',
  'from rasterio.transform import from_origin',
  'cells = np.array([[1, 2], [3, 4]], dtype="uint16")',
  'with MemoryFile() as memory:',
  '    with memory.open(driver="GTiff", width=2, height=2, count=1, dtype="uint16", crs="EPSG:5514", transform=from_origin(-750000, -1040000, 10, 10)) as dataset:',
  '        dataset.write(cells, 1)',
  '    with memory.open() as dataset:',
  '        restored = dataset.read(1)',
  '        assert dataset.crs.to_epsg() == 5514 and restored.tolist() == cells.tolist()',
  'print(f"rasterio {rasterio.__version__} GDAL {rasterio.__gdal_version__} EPSG:5514 cells={restored.size}")'
].join('\n');

export const unrealCapabilityProbe = (executable: string, version: string): CapabilityProbe => ({
  capability: { key: 'unreal', version, metadata: { executable } },
  executable,
  kind: 'unreal',
  timeoutMs: UNREAL_PROBE_TIMEOUT_MS,
  ...(version === 'configured' ? {} : { expectedVersion: version })
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
  const programFilesX86 = environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const probes: CapabilityProbe[] = [
    { capability: { key: 'windows', version: windowsVersion }, kind: 'windows-platform', executable: nodeExecutable },
    { capability: { key: 'powershell' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'] },
    { capability: { key: 'cmd' }, executable: 'cmd.exe', args: ['/d', '/c', 'ver'] },
    { capability: { key: 'git' }, executable: 'git.exe', args: ['--version'] },
    { capability: { key: 'git-lfs' }, executable: 'git-lfs.exe', args: ['version'] },
    { capability: { key: 'node' }, executable: nodeExecutable, args: ['--version'] },
    { capability: { key: 'https-download', metadata: { transport: 'runner-managed', resume: true, provenance: 'sha256' } },
      executable: nodeExecutable, args: ['-e', "if(typeof fetch!=='function')process.exit(2);process.stdout.write('runner-managed HTTPS fetch available')"] },
    { capability: { key: 'npm', metadata: { executable: 'npm.cmd' } }, executable: environment.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd --version'] },
    { capability: { key: 'cmake' }, executable: 'cmake.exe', args: ['--version'] },
    { capability: { key: 'msvc', metadata: { target: 'x64' } }, kind: 'msvc', timeoutMs: MSVC_PROBE_TIMEOUT_MS,
      executable: windowsPath.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe') },
    { capability: { key: 'windows-sdk' }, executable: 'where.exe', args: ['rc.exe'] },
    { capability: { key: 'interactive-desktop' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "if (-not [Environment]::UserInteractive) { exit 2 }; [Environment]::UserName"] },
    { capability: { key: 'gpu' }, executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "$g=Get-CimInstance Win32_VideoController | Where-Object {$_.AdapterRAM -gt 0} | Select-Object -First 1; if (-not $g) { exit 2 }; \"$($g.Name) driver=$($g.DriverVersion)\""] },
    { capability: { key: 'disk-capacity' }, kind: 'disk', path: environment.FORGEMIND_WINDOWS_WORKSPACE_ROOT ?? process.cwd() },
    geospatialProbe('proj', buildProjProbeCommands(environment), environment.FORGEMIND_PROJ_VERSION),
    geospatialProbe('gis-processing', buildGisProbeCommands(environment), environment.FORGEMIND_GIS_PROCESSING_VERSION)
  ];
  probes.push({ capability: { key: 'codex' }, executable: resolveCodexBinary(environment), args: ['--version'] });
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
    identities.add(identity);
    return true;
  });
}

function geospatialProbe(key: 'proj' | 'gis-processing', alternatives: CapabilityProbeCommand[], expectedVersion?: string): CapabilityProbe {
  return {
    capability: { key, ...(expectedVersion ? { version: expectedVersion } : {}) },
    kind: 'process-alternatives',
    alternatives,
    ...(expectedVersion ? { expectedVersion } : {})
  };
}

function buildProjProbeCommands(environment: NodeJS.ProcessEnv): CapabilityProbeCommand[] {
  const commands: CapabilityProbeCommand[] = [];
  if (environment.FORGEMIND_PROJ_EXECUTABLE) {
    commands.push({
      executable: environment.FORGEMIND_PROJ_EXECUTABLE,
      args: ['EPSG:4326', 'EPSG:5514'],
      input: '14.4179 50.1266\n',
      label: 'configured PROJ cs2cs',
      outputPattern: coordinatePairPattern(),
      expectedOutput: 'a finite transformed coordinate pair'
    });
  }
  commands.push({ executable: 'cs2cs.exe', args: ['EPSG:4326', 'EPSG:5514'], input: '14.4179 50.1266\n', label: 'native PROJ cs2cs',
    outputPattern: coordinatePairPattern(), expectedOutput: 'a finite transformed coordinate pair' });
  commands.push(...pythonProbeCommands(environment, PROJ_PYTHON_PROBE, 'pyproj coordinate transform', /transformed=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/));
  return deduplicateProbeCommands(commands);
}

function buildGisProbeCommands(environment: NodeJS.ProcessEnv): CapabilityProbeCommand[] {
  const commands: CapabilityProbeCommand[] = [];
  if (environment.FORGEMIND_GIS_PROCESSING_EXECUTABLE) {
    commands.push({
      executable: environment.FORGEMIND_GIS_PROCESSING_EXECUTABLE,
      args: ['-s_srs', 'EPSG:4326', '-t_srs', 'EPSG:5514'],
      input: '14.4179 50.1266\n',
      label: 'configured GDAL transform',
      outputPattern: coordinatePairPattern(),
      expectedOutput: 'a finite transformed coordinate pair'
    });
  }
  commands.push({ executable: 'gdaltransform.exe', args: ['-s_srs', 'EPSG:4326', '-t_srs', 'EPSG:5514'], input: '14.4179 50.1266\n', label: 'native GDAL transform',
    outputPattern: coordinatePairPattern(), expectedOutput: 'a finite transformed coordinate pair' });
  commands.push(...pythonProbeCommands(environment, GIS_PYTHON_PROBE, 'rasterio in-memory GeoTIFF', /EPSG:5514 cells=4/));
  return deduplicateProbeCommands(commands);
}

function pythonProbeCommands(environment: NodeJS.ProcessEnv, script: string, label: string, outputPattern: RegExp): CapabilityProbeCommand[] {
  const commands: CapabilityProbeCommand[] = [];
  if (environment.FORGEMIND_PYTHON_EXECUTABLE) {
    commands.push({ executable: environment.FORGEMIND_PYTHON_EXECUTABLE, args: ['-c', script], label: `${label} (configured Python)`, outputPattern, expectedOutput: 'the completed operation marker' });
  }
  commands.push(
    { executable: 'python.exe', args: ['-c', script], label: `${label} (python.exe)`, outputPattern, expectedOutput: 'the completed operation marker' },
    { executable: 'py.exe', args: ['-3', '-c', script], label: `${label} (py.exe)`, outputPattern, expectedOutput: 'the completed operation marker' }
  );
  return commands;
}

function coordinatePairPattern(): RegExp {
  return /(?:^|\s)-?\d+(?:\.\d+)?(?:\s+|\t)-?\d+(?:\.\d+)?/m;
}

function deduplicateProbeCommands(commands: CapabilityProbeCommand[]): CapabilityProbeCommand[] {
  const identities = new Set<string>();
  return commands.filter((command) => {
    const identity = `${command.executable.toLocaleLowerCase('en-US')}\u0000${command.args.join('\u0000')}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
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

export async function runCapabilityProbes(
  probes: readonly CapabilityProbe[],
  now = new Date(),
  onProgress?: (progress: ProbeProgress) => void
): Promise<ProbeResult> {
  const evidence = await Promise.all(probes.map(async (probe): Promise<WorkerProbeEvidence> => {
    onProgress?.({ capability: probe.capability, state: 'started' });
    let status: WorkerProbeEvidence['status'] = 'supported';
    let summary = 'Local probe succeeded.';
    let capability = probe.capability;
    try {
      if (probe.kind === 'windows-platform') {
        const output = await executeProbe(probe.executable!, ['-e', "if(process.platform!=='win32')process.exit(2);process.stdout.write(process.execPath)"], probe.timeoutMs);
        capability = withEvidenceMetadata(capability, probe.executable!, output);
      } else if (probe.kind === 'disk') {
        const stats = await statfs(probe.path!);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) throw new Error('free byte count is not a safe integer');
        capability = { ...capability, version: String(freeBytes), metadata: { path: probe.path!, freeBytes } };
        summary = `Local disk probe succeeded: ${freeBytes} bytes free.`;
      } else if (probe.kind === 'msvc') {
        const result = await runMsvcCapabilityProbe(probe);
        capability = result.capability;
        summary = result.summary;
      } else if (probe.kind === 'unreal') {
        const result = await runUnrealCapabilityProbe(probe);
        capability = result.capability;
        summary = result.summary;
      } else if (probe.kind === 'process-alternatives') {
        const result = await runFirstSuccessfulProbe(probe);
        capability = withEvidenceMetadata(capability, result.command.executable, result.output);
        capability = { ...capability, metadata: { ...capability.metadata, probe: result.command.label ?? result.command.executable } };
        summary = `Local ${result.command.label ?? 'tool'} probe succeeded: ${redactProbeOutput(result.output)}`;
      } else if (probe.executable) {
        const output = await executeProbe(probe.executable, probe.args ?? [], probe.timeoutMs);
        assertExpectedVersion(probe, output);
        capability = withEvidenceMetadata(capability, probe.executable, output);
        summary = `Local tool probe succeeded: ${redactProbeOutput(output)}`;
      } else throw new Error('probe has no executable evidence source');
    } catch (error) {
      status = 'unsupported';
      summary = `Local probe failed: ${redactProbeOutput(error instanceof Error ? error.message : 'unknown error')}`;
    }
    capability = normalizeCapability(capability);
    const unsigned = { capability, status, probedAt: now.toISOString(), probeVersion: '3', provenance: 'local-probe' as const, summary };
    const item = { schemaVersion: 1 as const, ...unsigned, evidenceHash: createHash('sha256').update(canonicalizeWorkerProbeEvidence(unsigned)).digest('hex') };
    onProgress?.({ capability: probe.capability, state: 'completed', status, summary });
    return item;
  }));
  return { evidence, capabilities: evidence.filter((item) => item.status === 'supported').map((item) => item.capability) };
}

async function runFirstSuccessfulProbe(probe: CapabilityProbe): Promise<{ command: CapabilityProbeCommand; output: string }> {
  const alternatives = probe.alternatives ?? [];
  if (alternatives.length === 0) throw new Error('probe has no process alternatives');
  const failures: string[] = [];
  for (const command of alternatives) {
    try {
      const output = await executeProbe(command.executable, command.args, probe.timeoutMs, undefined, command.input);
      if (command.outputPattern && !command.outputPattern.test(output)) {
        throw new Error(`probe returned success without ${command.expectedOutput ?? 'the expected output'}: ${output || 'no output'}`);
      }
      assertExpectedVersion(probe, output);
      return { command, output };
    } catch (error) {
      failures.push(`${command.label ?? command.executable}: ${redactProbeOutput(error instanceof Error ? error.message : 'unknown error')}`);
    }
  }
  throw new Error(`none of the local probe alternatives succeeded (${failures.join('; ')})`);
}

/** Keep capability property order stable across JSON transport and Zod parsing,
 * because the evidence hash intentionally covers the canonical JSON payload. */
function normalizeCapability(capability: WorkerCapability): WorkerCapability {
  return {
    key: capability.key,
    ...(capability.version ? { version: capability.version } : {}),
    ...(capability.metadata ? { metadata: capability.metadata } : {})
  };
}

async function runMsvcCapabilityProbe(probe: CapabilityProbe): Promise<{ capability: WorkerCapability; summary: string }> {
  const installationPath = (await executeProbe(probe.executable!, [
    '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'
  ], probe.timeoutMs)).trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!installationPath) throw new Error('Visual Studio with the x64 C++ toolchain was not found by vswhere.');
  const vcvars = windowsPath.join(installationPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'forgemind-msvc-probe-'));
  const source = join(temporaryRoot, 'probe.cpp');
  const object = join(temporaryRoot, 'probe.obj');
  const script = join(temporaryRoot, 'probe.cmd');
  try {
    await writeFile(source, 'int forgemind_probe() { return 0; }\n', 'utf8');
    await writeFile(script, buildMsvcProbeScript(vcvars), 'utf8');
    const output = await executeProbe(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'probe.cmd'], probe.timeoutMs, temporaryRoot);
    const objectStats = await stat(object);
    if (!objectStats.isFile() || objectStats.size === 0) throw new Error('MSVC returned success without creating the x64 object file.');
    const observed = redactProbeOutput(output || 'x64 compile succeeded');
    return {
      capability: { ...probe.capability, version: extractMsvcVersion(output) ?? 'observed', metadata: { ...probe.capability.metadata, executable: 'cl.exe', vswhere: probe.executable!, installationPath, observed } },
      summary: `Local x64 MSVC compile probe succeeded: ${observed}`
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function buildMsvcProbeScript(vcvarsPath: string): string {
  return [
    '@echo off',
    `call "${vcvarsPath}" >nul`,
    'if errorlevel 1 exit /b %errorlevel%',
    'echo FORGEMIND_MSVC_VERSION=%VCToolsVersion%',
    'cl.exe /nologo /c /Foprobe.obj probe.cpp'
  ].join('\r\n');
}

async function runUnrealCapabilityProbe(probe: CapabilityProbe): Promise<{ capability: WorkerCapability; summary: string }> {
  const configuredExecutable = probe.executable!;
  const executableDirectory = windowsPath.dirname(configuredExecutable);
  const commandletExecutable = windowsPath.join(executableDirectory, 'UnrealEditor-Cmd.exe');
  const engineRoot = windowsPath.resolve(executableDirectory, '..', '..');
  const buildVersionPath = windowsPath.join(engineRoot, 'Build', 'Build.version');
  const buildVersion = JSON.parse(await readFile(buildVersionPath, 'utf8')) as Record<string, unknown>;
  const major = numericVersionPart(buildVersion.MajorVersion, 'MajorVersion');
  const minor = numericVersionPart(buildVersion.MinorVersion, 'MinorVersion');
  const patch = numericVersionPart(buildVersion.PatchVersion, 'PatchVersion');
  const observedVersion = `${major}.${minor}.${patch}`;
  if (probe.expectedVersion && !versionMatches(probe.expectedVersion, observedVersion)) {
    throw new Error(`Unreal Build.version reported ${observedVersion}, expected ${probe.expectedVersion}.`);
  }
  const engineAssociation = probe.expectedVersion ?? `${major}.${minor}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'forgemind-unreal-probe-'));
  const projectDirectory = join(temporaryRoot, 'ForgeMindProbe');
  const projectPath = join(projectDirectory, 'ForgeMindProbe.uproject');
  const scriptPath = join(temporaryRoot, 'probe.py');
  const markerPath = join(temporaryRoot, 'probe-succeeded.txt');
  const logPath = join(temporaryRoot, 'unreal-probe.log');
  try {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(projectPath, `${JSON.stringify(buildUnrealProbeProjectDescriptor(engineAssociation), null, 2)}\n`, 'utf8');
    const markerForPython = markerPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    await writeFile(scriptPath, `import unreal\nfrom pathlib import Path\nunreal.log('FORGEMIND_UNREAL_PYTHON_API_OK')\nPath(r'${markerForPython}').write_text('FORGEMIND_UNREAL_PROBE_OK', encoding='utf-8')\n`, 'utf8');
    const output = await executeUnrealProbe(commandletExecutable, [
      projectPath, '-run=pythonscript', `-script=${scriptPath}`, '-unattended', '-nop4', '-nosplash', '-NullRHI', '-NoSound',
      '-NoShaderCompile', '-DDC-ForceMemoryCache', '-RUNNINGUNATTENDEDSCRIPT', '-NoSaveConfig', '-NoEpicPortal',
      `-AbsLog=${logPath}`, '-stdout', '-FullStdOutLogOutput'
    ], probe.timeoutMs, logPath);
    const marker = await readFile(markerPath, 'utf8');
    if (marker.trim() !== 'FORGEMIND_UNREAL_PROBE_OK') throw new Error('Unreal commandlet exited without writing the Python probe marker.');
    return {
      capability: { ...probe.capability, version: observedVersion, metadata: { ...probe.capability.metadata, executable: configuredExecutable, commandletExecutable, engineAssociation, observed: redactProbeOutput(output || marker) } },
      summary: `Unreal ${observedVersion} headless Python commandlet probe succeeded.`
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function buildUnrealProbeProjectDescriptor(engineAssociation: string): Record<string, unknown> {
  return {
    FileVersion: 3,
    EngineAssociation: engineAssociation,
    Category: '',
    Description: 'Ephemeral ForgeMind Unreal capability probe',
    DisableEnginePluginsByDefault: true,
    Plugins: [
      { Name: 'ContentBrowserFileDataSource', Enabled: true },
      { Name: 'PythonScriptPlugin', Enabled: true }
    ]
  };
}

async function executeUnrealProbe(executable: string, args: readonly string[], timeoutMs: number | undefined, logPath: string): Promise<string> {
  const result = await runBoundedProcess(executable, args, { timeoutMs: timeoutMs ?? UNREAL_PROBE_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
  if (result.terminationReason === 'timed-out') throw new Error(`Unreal probe timed out after ${timeoutMs ?? UNREAL_PROBE_TIMEOUT_MS}ms; executable=${executable}`);
  if (result.terminationReason === 'cancelled') throw new Error(`Unreal probe was cancelled; executable=${executable}`);
  if (result.terminationReason === 'missing-capability') throw new Error(`${result.stderr || 'Unreal commandlet was not found'}; executable=${executable}`);
  if (result.exitCode !== 0) {
    const log = await readFile(logPath, 'utf8').catch(() => '');
    throw new Error(`Unreal probe exited with code ${result.exitCode}: ${summarizeUnrealFailure(`${result.stderr}\n${result.stdout}\n${log}`)}`);
  }
  return result.stdout || result.stderr;
}

export function summarizeUnrealFailure(output: string): string {
  const normalized = output.replace(/\r/g, '');
  const fatalIndex = normalized.toLocaleLowerCase('en-US').lastIndexOf('fatal error:');
  if (fatalIndex >= 0) return normalized.slice(fatalIndex, fatalIndex + 2_000).trim();
  const errorLines = normalized.split('\n').filter((line) => /(?:error|assertion failed|ensure condition failed)/i.test(line));
  if (errorLines.length > 0) return errorLines.slice(-8).join('\n').trim();
  return normalized.slice(-2_000).trim() || 'no Unreal diagnostic output';
}

function numericVersionPart(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Unreal Build.version has an invalid ${name}.`);
  return value;
}

function versionMatches(expected: string, observed: string): boolean {
  return observed === expected || observed.startsWith(`${expected}.`);
}

function extractMsvcVersion(output: string): string | undefined {
  return output.match(/FORGEMIND_MSVC_VERSION=([^\s]+)/i)?.[1]
    ?? output.match(/Version\s+(\d+\.\d+(?:\.\d+)?)/i)?.[1];
}

function assertExpectedVersion(probe: CapabilityProbe, output: string): void {
  if (probe.expectedVersion && !new RegExp(`(?:^|\\D)${escapeRegExp(probe.expectedVersion)}(?:\\D|$)`).test(output)) {
    throw new Error(`tool reported a different version than ${probe.expectedVersion}: ${output}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function executeProbe(executable: string, args: readonly string[], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, cwd?: string, input?: string): Promise<string> {
  const result = await runBoundedProcess(executable, args, { timeoutMs, maxOutputBytes: 4096, ...(cwd ? { cwd } : {}), ...(input !== undefined ? { input } : {}) });
  if (result.terminationReason === 'timed-out') throw new Error(`probe timed out after ${timeoutMs}ms; executable=${executable}`);
  if (result.terminationReason === 'cancelled') throw new Error(`probe was cancelled; executable=${executable}`);
  if (result.terminationReason === 'missing-capability') throw new Error(`${result.stderr || 'executable was not found'}; executable=${executable}`);
  if (result.exitCode !== 0) throw new Error(`probe exited with code ${result.exitCode}: ${result.stderr || result.stdout || 'no output'}`);
  return result.stdout || result.stderr;
}

function withEvidenceMetadata(capability: WorkerCapability, executable: string, output: string): WorkerCapability {
  const observed = redactProbeOutput(output);
  return { ...capability, version: capability.version ?? observed.split(/\s+/).find((part) => /\d/.test(part)) ?? 'observed',
    metadata: { executable, ...capability.metadata, observed } };
}

/** Keep diagnostics useful without persisting credentials, home paths, or command output floods. */
export function redactProbeOutput(value: string): string {
  return value.replace(/(?:https?:\/\/)?[^\s:@/]+:[^\s@/]+@/gi, '[redacted]@')
    .replace(/(token|password|secret|authorization)\s*[:=]\s*[^\s;]+/gi, '$1=[redacted]')
    .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%')
    .replace(/[\r\n\t ]+/g, ' ').trim().slice(0, 500) || 'no output';
}
