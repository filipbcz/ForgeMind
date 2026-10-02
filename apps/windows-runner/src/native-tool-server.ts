#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { access, appendFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { redactSecrets } from '@forgemind/core';
import { assertEvidenceOutsideCheckout, buildSandboxedExecutableInvocation, buildSandboxedProcessInvocation,
  buildUnrealAuthoringArgs, buildUnrealBuildToolArgs, containsUnrealBuildInvocation, containsUnrealEditorInvocation,
  selectUnrealAutomationExecutable } from './native-sandbox.js';
import { nativeToolDefinitions, nativeToolServerInstructions } from './native-tool-contract.js';
import { runBoundedProcess } from './process-runner.js';

const root = resolve(process.argv[2] ?? '');
const evidencePath = resolve(process.argv[3] ?? '');
const sandboxExecutable = process.argv[4] ?? '';
const configuredUnrealExecutable = process.argv[5]?.trim() ?? '';
const configuredUnrealCommandletExecutable = process.argv[6]?.trim() ?? '';
const configuredProcessTimeoutMs = Number(process.argv[7] ?? 36_000_000);
const processTimeoutMs = Number.isFinite(configuredProcessTimeoutMs) && configuredProcessTimeoutMs >= 1_000
  ? configuredProcessTimeoutMs
  : 36_000_000;
const unrealIdleTimeoutMs = Math.min(processTimeoutMs, 5 * 60_000);
if (!root || !evidencePath || !sandboxExecutable) throw new Error('Native tool server requires checkout, evidence, and sandbox executable paths.');
assertEvidenceOutsideCheckout(root, evidencePath);
const canonicalRoot = await realpath(root);
const activeProcesses = new Set<AbortController>();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => void handle(line));
input.on('close', terminateActiveProcesses);
process.once('SIGINT', terminateActiveProcesses);
process.once('SIGTERM', terminateActiveProcesses);

async function handle(line: string) {
  let request: any;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  try {
    if (request.method === 'initialize') return send(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'forgemind-native', version: '2' }, instructions: nativeToolServerInstructions });
    if (request.method === 'ping') return send(request.id, {});
    if (request.method === 'tools/list') return send(request.id, { tools: nativeToolDefinitions });
    if (request.method === 'tools/call') return send(request.id, await callTool(request.params?.name, request.params?.arguments ?? {}));
    sendError(request.id, -32601, 'Method not found');
  } catch (error) { sendError(request.id, -32000, error instanceof Error ? error.message : String(error)); }
}

async function callTool(name: string, args: any) {
  if (name === 'read_file') return text(await readFile(await existingContained(args.path), 'utf8'));
  if (name === 'list_directory') return text((await readdir(await existingContained(args.path ?? '.'))).join('\n'));
  if (name === 'write_file') { const path = contained(args.path); await assertNearestExistingParent(dirname(path)); await mkdir(dirname(path), { recursive: true }); await assertCanonicalContained(await realpath(dirname(path))); await assertExistingTargetContained(path); await writeFile(path, String(args.content), 'utf8'); return text('written'); }
  if (name === 'remove_path') { const path = contained(args.path); await assertCanonicalContained(await realpath(dirname(path))); await rm(path, { recursive: true, force: true }); return text('removed'); }
  if (name === 'run_process') {
    if (!['powershell', 'cmd', 'system'].includes(args.shell) || typeof args.command !== 'string' || typeof args.checkId !== 'string') throw new Error('Invalid process request.');
    if (containsUnrealEditorInvocation(args.command)) throw new Error('UnrealEditor cannot run through run_process. Use run_unreal_authoring so the runner-probed executable and required automation flags are applied.');
    if (containsUnrealBuildInvocation(args.command)) throw new Error('UnrealBuildTool cannot run through run_process. Use run_unreal_authoring with tool=unreal-build so the runner-probed toolchain and writable build environment are applied.');
    const result = await runProcess(args.checkId, args.command, args.shell);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.exitCode !== 0 };
  }
  if (name === 'run_unreal_authoring') {
    if (!['unreal-editor', 'unreal-python', 'unreal-build', 'project-script', 'cpp-tool'].includes(args.tool)
      || !['author', 'verify', 'build', 'cook', 'package'].includes(args.phase)
      || (args.executablePath !== undefined && typeof args.executablePath !== 'string')
      || typeof args.projectRelativePath !== 'string' || args.projectRelativePath.length === 0
      || !Array.isArray(args.args) || !args.args.every((value: unknown) => typeof value === 'string')
      || !Array.isArray(args.sourceRelativePaths) || !args.sourceRelativePaths.every((value: unknown) => typeof value === 'string')) throw new Error('Invalid Unreal authoring request.');
    const usesEditor = ['unreal-editor', 'unreal-python'].includes(args.tool);
    const usesBuildTool = args.tool === 'unreal-build';
    const buildRuntime = usesBuildTool ? await resolveUnrealBuildRuntime(configuredUnrealExecutable || configuredUnrealCommandletExecutable) : undefined;
    const executablePath = usesEditor
      ? selectUnrealAutomationExecutable(args.tool, args.args, configuredUnrealExecutable, configuredUnrealCommandletExecutable)
      : buildRuntime?.dotnetExecutable ?? args.executablePath?.trim();
    if (!executablePath) throw new Error(usesEditor || usesBuildTool
      ? 'No runner-probed UnrealEditor executable is available. Run the Windows probe with FORGEMIND_UNREAL_EXECUTABLE configured.'
      : 'This authoring tool requires an executablePath.');
    if (usesEditor && args.executablePath?.trim() && normalizeExecutable(args.executablePath) !== normalizeExecutable(executablePath)) {
      throw new Error('The requested UnrealEditor does not match the executable verified by the runner probe.');
    }
    if (usesEditor && !/(?:^|[\\/])UnrealEditor(?:-Cmd)?\.exe$/i.test(executablePath))
      throw new Error('Editor authoring and verification require an UnrealEditor executable.');
    const project = await existingContained(args.projectRelativePath);
    if (!String(project).toLowerCase().endsWith('.uproject') || !(await stat(project)).isFile()) throw new Error('The selected project must be an existing .uproject in the leased checkout.');
    for (const source of args.sourceRelativePaths) await existingContained(source);
    if (usesBuildTool && (args.phase !== 'build' || args.args.length > 0 || typeof args.target !== 'string'
      || args.platform !== 'Win64' || !['Development', 'DebugGame'].includes(args.configuration))) {
      throw new Error('unreal-build requires phase=build, an empty args array, target=<Project>Editor, platform=Win64, and configuration=Development or DebugGame.');
    }
    const effectiveArgs = usesEditor
      ? buildUnrealAuthoringArgs(project, args.args, args.phase)
      : usesBuildTool
        ? buildUnrealBuildToolArgs({ unrealBuildToolDll: buildRuntime!.unrealBuildToolDll, projectPath: project,
            target: args.target, platform: args.platform, configuration: args.configuration })
        : [project, ...args.args];
    const command = [executablePath, ...effectiveArgs].map(quoteWindowsArgument).join(' ');
    const authoring = { tool: args.tool, phase: args.phase, projectRelativePath: args.projectRelativePath,
      executablePath, args: effectiveArgs.slice(1), sourceRelativePaths: args.sourceRelativePaths };
    // UBT is a runner-resolved executable with a strictly validated target and argument vector. Running this exact invocation
    // directly avoids denying its unavoidable per-user .NET/UBT state while arbitrary AI commands remain checkout-sandboxed.
    const invocation = usesBuildTool
      ? { executable: executablePath, args: effectiveArgs }
      : buildSandboxedExecutableInvocation({ sandboxExecutable, checkoutRoot: root, executable: executablePath, args: effectiveArgs });
    const result = await runProcess(args.checkId, command, 'system', authoring, invocation, usesEditor ? unrealIdleTimeoutMs : undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.exitCode !== 0 };
  }
  throw new Error(`Unknown native tool: ${name}`);
}

async function runProcess(checkId: string, command: string, shell: 'powershell' | 'cmd' | 'system', authoring?: Record<string, unknown>,
  directInvocation?: { executable: string; args: string[] }, idleTimeoutMs?: number) {
  const sandboxed = directInvocation ?? buildSandboxedProcessInvocation({ sandboxExecutable, checkoutRoot: root, command, shell });
  const temporaryDirectory = resolve(root, '.forgemind-tmp');
  await Promise.all([
    mkdir(temporaryDirectory, { recursive: true }),
    mkdir(resolve(temporaryDirectory, 'profile'), { recursive: true }),
    mkdir(resolve(temporaryDirectory, 'local-app-data'), { recursive: true }),
    mkdir(resolve(temporaryDirectory, 'roaming-app-data'), { recursive: true }),
    mkdir(resolve(temporaryDirectory, 'dotnet-home'), { recursive: true }),
    mkdir(resolve(temporaryDirectory, 'nuget-packages'), { recursive: true })
  ]);
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  activeProcesses.add(controller);
  const executed = await runBoundedProcess(sandboxed.executable, sandboxed.args, { cwd: root, timeoutMs: processTimeoutMs,
    idleTimeoutMs, env: sandboxEnvironment(temporaryDirectory, dirname(evidencePath)), signal: controller.signal, maxOutputBytes: 512_000 })
    .finally(() => activeProcesses.delete(controller));
  const result = { checkId, command, shell, exitCode: executed.exitCode, stdout: redactSecrets(executed.stdout), stderr: redactSecrets(executed.stderr), startedAt, completedAt: new Date().toISOString(),
    ...(executed.terminationReason ? { terminationReason: executed.terminationReason } : {}), ...(authoring ? { authoring } : {}) };
  await appendFile(evidencePath, `${JSON.stringify(result)}\n`, 'utf8'); return result;
}

function terminateActiveProcesses(): void {
  for (const controller of activeProcesses) controller.abort();
}

function quoteWindowsArgument(value: unknown): string {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function normalizeExecutable(value: string): string {
  return resolve(value).replaceAll('/', '\\').toLowerCase();
}

function sandboxEnvironment(temporaryDirectory: string, isolatedCodexHome: string): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(key)) continue;
    safe[key] = value;
  }
  safe.CODEX_HOME = isolatedCodexHome; safe.TEMP = temporaryDirectory; safe.TMP = temporaryDirectory;
  safe.USERPROFILE = resolve(temporaryDirectory, 'profile');
  safe.LOCALAPPDATA = resolve(temporaryDirectory, 'local-app-data');
  safe.APPDATA = resolve(temporaryDirectory, 'roaming-app-data');
  safe.DOTNET_CLI_HOME = resolve(temporaryDirectory, 'dotnet-home');
  safe.NUGET_PACKAGES = resolve(temporaryDirectory, 'nuget-packages');
  safe.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
  return safe;
}

async function resolveUnrealBuildRuntime(editorExecutable: string): Promise<{ dotnetExecutable: string; unrealBuildToolDll: string }> {
  if (!editorExecutable || !/(?:^|[\\/])UnrealEditor(?:-Cmd)?\.exe$/i.test(editorExecutable)) {
    throw new Error('Unreal build requires the runner-probed UnrealEditor executable.');
  }
  const engineRoot = resolve(dirname(editorExecutable), '..', '..');
  const unrealBuildToolDll = resolve(engineRoot, 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll');
  await access(unrealBuildToolDll);
  const dotnetRoot = resolve(engineRoot, 'Binaries', 'ThirdParty', 'DotNet');
  const versions = (await readdir(dotnetRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = resolve(dotnetRoot, version, 'win-x64', 'dotnet.exe');
    try { await access(candidate); return { dotnetExecutable: candidate, unrealBuildToolDll }; } catch { /* continue */ }
  }
  throw new Error(`The runner-probed Unreal installation has no bundled win-x64 dotnet runtime under ${dotnetRoot}.`);
}

function contained(path: string) { const target = resolve(root, String(path)); const rel = relative(root, target); if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Path escapes leased checkout.'); return target; }
async function existingContained(path: string) { const target = await realpath(contained(path)); await assertCanonicalContained(target); return target; }
async function assertExistingTargetContained(path: string) { try { await assertCanonicalContained(await realpath(path)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; } }
async function assertNearestExistingParent(path: string): Promise<void> { try { await assertCanonicalContained(await realpath(path)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; const parent = dirname(path); if (parent === path) throw error; await assertNearestExistingParent(parent); } }
async function assertCanonicalContained(path: string) { const rel = relative(canonicalRoot, path); if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Canonical path escapes leased checkout.'); }
function text(value: string) { return { content: [{ type: 'text', text: value }] }; }
function send(id: unknown, result: unknown) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function sendError(id: unknown, code: number, message: string) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }
