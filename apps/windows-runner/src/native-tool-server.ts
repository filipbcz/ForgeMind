#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createInterface } from 'node:readline';
import { appendFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { redactSecrets } from '@forgemind/core';
import { assertEvidenceOutsideCheckout, buildSandboxedExecutableInvocation, buildSandboxedProcessInvocation,
  buildUnrealAuthoringArgs, buildUnrealBuildToolArgs, containsUnrealBuildInvocation, containsUnrealEditorInvocation,
  selectUnrealAutomationExecutable } from './native-sandbox.js';
import { nativeToolDefinitions, nativeToolServerInstructions } from './native-tool-contract.js';
import { runBoundedProcess } from './process-runner.js';
import { resolveUnrealBuildRuntime } from './unreal-build-runtime.js';

const root = resolve(process.argv[2] ?? '');
const evidencePath = resolve(process.argv[3] ?? '');
const sandboxExecutable = process.argv[4] ?? '';
const configuredUnrealExecutable = process.argv[5]?.trim() ?? '';
const configuredUnrealCommandletExecutable = process.argv[6]?.trim() ?? '';
const configuredProcessTimeoutMs = Number(process.argv[7] ?? 36_000_000);
const managedRootValues = process.argv.slice(8, 14);
if (managedRootValues.length !== 6 || managedRootValues.some((path) => !path?.trim())) throw new Error('Native tool server requires all managed root paths.');
const managedRootArguments = {
  inputs: resolve(managedRootValues[0]!), sourceAssets: resolve(managedRootValues[1]!), cache: resolve(managedRootValues[2]!),
  outputs: resolve(managedRootValues[3]!), projectData: resolve(managedRootValues[4]!), diagnostics: resolve(managedRootValues[5]!)
};
const observedCapabilities = (() => {
  try {
    const parsed = JSON.parse(Buffer.from(process.argv[14] ?? 'W10=', 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
})();
const executionIntent = (() => {
  try {
    const parsed = JSON.parse(Buffer.from(process.argv[15] ?? 'bnVsbA==', 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
})();
const taskId = process.argv[16]?.trim() ?? '';
const processTimeoutMs = Number.isFinite(configuredProcessTimeoutMs) && configuredProcessTimeoutMs >= 1_000
  ? configuredProcessTimeoutMs
  : 36_000_000;
const unrealIdleTimeoutMs = Math.min(processTimeoutMs, 5 * 60_000);
if (!root || !evidencePath || !sandboxExecutable || !taskId || taskId.includes('/') || taskId.includes('\\')) {
  throw new Error('Native tool server requires checkout, evidence, sandbox executable, and managed root paths.');
}
assertEvidenceOutsideCheckout(root, evidencePath);
const canonicalRoot = await realpath(root);
const canonicalManagedRoots = Object.fromEntries(await Promise.all(Object.entries(managedRootArguments)
  .map(async ([key, path]) => [key, await realpath(path)]))) as typeof managedRootArguments;
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
  if (name === 'list_capabilities') return text(JSON.stringify(observedCapabilities));
  if (name === 'read_file') {
    const path = await existingContained(args.path);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) throw new Error('Checkout text reads require a file no larger than 1 MB. Use a bounded project command for targeted inspection.');
    return text(await readFile(path, 'utf8'));
  }
  if (name === 'list_directory') {
    const entries = await readdir(await existingContained(args.path ?? '.'));
    if (entries.length > 1000) throw new Error('Checkout directory listing exceeds 1000 entries. Narrow the requested path.');
    return text(entries.join('\n'));
  }
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
  if (name === 'list_managed_files') {
    const role = managedRole(args.root);
    const path = await existingManaged(role, args.path ?? '.');
    return text(JSON.stringify(await listManaged(path, args.recursive === true)));
  }
  if (name === 'read_managed_text') {
    const role = managedRole(args.root);
    const path = await existingManaged(role, args.path);
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_000_000) throw new Error('Managed text reads require a file no larger than 1 MB.');
    return text(await readFile(path, 'utf8'));
  }
  if (name === 'fetch_https') return text(JSON.stringify(await auditedManagedOperation('managed-fetch', `fetch_https ${String(args.destinationRelativePath)}`,
    () => fetchHttpsSource(args))));
  if (name === 'materialize_managed_path') {
    return text(JSON.stringify(await auditedManagedOperation('managed-materialize', `materialize_managed_path ${String(args.checkoutRelativePath)}`, async () => {
      const role = managedRole(args.root);
      if (role === 'outputs') throw new Error('Task outputs are not reusable managed inputs.');
      const source = await existingManaged(role, args.sourceRelativePath);
      const checkoutRelativePath = normalizeRelativePath(args.checkoutRelativePath);
      if (checkoutRelativePath !== '.forgemind-tmp/managed' && !checkoutRelativePath.startsWith('.forgemind-tmp/managed/')) {
        throw new Error('Managed inputs may be materialized only below .forgemind-tmp/managed.');
      }
      const target = contained(checkoutRelativePath);
      await assertNearestExistingParent(dirname(target));
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await assertCanonicalContained(await realpath(dirname(target)));
      await assertTreeHasNoLinks(source);
      await cp(source, target, { recursive: true, force: false, errorOnExist: true });
      return { checkoutRelativePath, ...(await treeSummary(target)) };
    })));
  }
  if (name === 'publish_project_output') {
    return text(JSON.stringify(await auditedManagedOperation('managed-publish', `publish_project_output ${String(args.destinationRelativePath)}`, async () => {
      const source = await existingContained(args.checkoutRelativePath);
      await assertTreeHasNoLinks(source);
      const destinationRelativePath = normalizeRelativePath(args.destinationRelativePath);
      const allowed = Array.isArray(executionIntent?.persistentOutputPaths)
        ? executionIntent!.persistentOutputPaths.map((path) => normalizeRelativePath(path))
        : [];
      if (!allowed.includes(destinationRelativePath)) throw new Error('Destination is not declared by this task execution intent.');
      const target = managedContained('projectData', destinationRelativePath);
      await assertNearestManagedParent('projectData', dirname(target));
      const temporary = `${target}.forgemind-${Date.now()}-${process.pid}.tmp`;
      await rm(temporary, { recursive: true, force: true });
      await mkdir(dirname(temporary), { recursive: true });
      await cp(source, temporary, { recursive: true, force: false, errorOnExist: true });
      const summary = await treeSummary(temporary);
      const destinationHash = createHash('sha256').update(destinationRelativePath).digest('hex');
      const publicationPath = managedContained('projectData', `.forgemind-publications/${destinationHash}.json`);
      let existingSummary: Awaited<ReturnType<typeof treeSummary>> | undefined;
      try { existingSummary = await treeSummary(target); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      let existingPublication: { taskId?: string } = {};
      try { existingPublication = JSON.parse(await readFile(publicationPath, 'utf8')) as { taskId?: string }; } catch { /* no owner */ }
      let publicationOwnerTaskId = taskId;
      if (existingSummary && existingSummary.sha256 === summary.sha256) {
        await rm(temporary, { recursive: true, force: true });
        publicationOwnerTaskId = existingPublication.taskId ?? taskId;
      } else if (existingSummary) {
        if (existingPublication.taskId !== taskId) {
          await rm(temporary, { recursive: true, force: true });
          throw new Error('Persistent output already exists with different content. Publish a new versioned destination instead of overwriting another task output.');
        }
        const backup = `${target}.forgemind-${Date.now()}-${process.pid}.previous`;
        await rename(target, backup);
        try {
          await rename(temporary, target);
          await rm(backup, { recursive: true, force: true });
        } catch (error) {
          await rm(target, { recursive: true, force: true });
          await rename(backup, target);
          throw error;
        }
      } else {
        await rename(temporary, target);
      }
      const receipt = {
        schemaVersion: 1,
        root: 'project-data',
        path: destinationRelativePath,
        ...summary,
        publishedAt: new Date().toISOString()
      };
      await mkdir(dirname(publicationPath), { recursive: true });
      await writeFile(publicationPath, `${JSON.stringify({ ...receipt, taskId: publicationOwnerTaskId }, null, 2)}\n`, 'utf8');
      const receiptName = `persistent-output-${destinationHash.slice(0, 16)}.json`;
      await writeFile(managedContained('outputs', receiptName), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      return receipt;
    })));
  }
  throw new Error(`Unknown native tool: ${name}`);
}

type ManagedRole = keyof typeof canonicalManagedRoots;

async function auditedManagedOperation<T>(checkId: string, command: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  try {
    const result = await operation();
    await appendFile(evidencePath, `${JSON.stringify({ checkId, command, shell: 'system', exitCode: 0,
      stdout: redactSecrets(JSON.stringify(result)), stderr: '', startedAt, completedAt: new Date().toISOString() })}\n`, 'utf8');
    return result;
  } catch (error) {
    await appendFile(evidencePath, `${JSON.stringify({ checkId, command, shell: 'system', exitCode: 1,
      stdout: '', stderr: redactSecrets(error instanceof Error ? error.message : String(error)), startedAt, completedAt: new Date().toISOString() })}\n`, 'utf8');
    throw error;
  }
}

function managedRole(value: unknown): ManagedRole {
  const mapped = value === 'source-assets' ? 'sourceAssets' : value === 'project-data' ? 'projectData' : value;
  if (!['inputs', 'sourceAssets', 'cache', 'outputs', 'projectData'].includes(String(mapped))) throw new Error('Unknown managed root.');
  return mapped as ManagedRole;
}

function normalizeRelativePath(value: unknown): string {
  const path = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path === '.' || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('A safe non-root relative path is required.');
  return path;
}

function managedContained(role: ManagedRole, path: unknown): string {
  const base = canonicalManagedRoots[role];
  const candidate = String(path ?? '.') === '.' ? base : resolve(base, normalizeRelativePath(path));
  const rel = relative(base, candidate);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Path escapes its managed root.');
  return candidate;
}

async function existingManaged(role: ManagedRole, path: unknown): Promise<string> {
  const candidate = await realpath(managedContained(role, path));
  const rel = relative(canonicalManagedRoots[role], candidate);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Canonical path escapes its managed root.');
  return candidate;
}

async function assertNearestManagedParent(role: ManagedRole, path: string): Promise<void> {
  try { await existingManaged(role, relative(canonicalManagedRoots[role], path) || '.'); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    await assertNearestManagedParent(role, parent);
  }
}

async function listManaged(path: string, recursive: boolean): Promise<Array<{ path: string; kind: 'file' | 'directory'; sizeBytes: number }>> {
  const base = path;
  const items: Array<{ path: string; kind: 'file' | 'directory'; sizeBytes: number }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (items.length >= 1000) throw new Error('Managed file listing exceeds 1000 entries. Narrow the requested path.');
      const target = resolve(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('Managed roots may not contain symbolic links.');
      const rel = relative(base, target).replaceAll('\\', '/') || entry.name;
      items.push({ path: rel, kind: info.isDirectory() ? 'directory' : 'file', sizeBytes: info.isFile() ? info.size : 0 });
      if (recursive && info.isDirectory()) await visit(target);
    }
  }
  const info = await stat(path);
  if (info.isDirectory()) await visit(path);
  else items.push({ path: relative(dirname(path), path).replaceAll('\\', '/'), kind: 'file', sizeBytes: info.size });
  return items;
}

async function assertTreeHasNoLinks(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Managed copies may not contain symbolic links.');
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) await assertTreeHasNoLinks(resolve(path, entry));
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

async function treeSummary(path: string): Promise<{ sizeBytes: number; sha256: string; fileCount: number }> {
  const rootInfo = await stat(path);
  const files: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  async function visit(target: string): Promise<void> {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Published output may not contain symbolic links.');
    if (info.isDirectory()) {
      for (const name of (await readdir(target)).sort()) await visit(resolve(target, name));
      return;
    }
    if (!info.isFile()) throw new Error('Published output contains an unsupported filesystem entry.');
    if (files.length >= 100_000) throw new Error('Published output exceeds the 100000-file safety limit. Split the project data into smaller declared outputs.');
    files.push({ path: rootInfo.isFile() ? '.' : relative(path, target).replaceAll('\\', '/'), sizeBytes: info.size, sha256: await fileSha256(target) });
  }
  await visit(path);
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), sha256, fileCount: files.length };
}

async function fetchHttpsSource(args: any): Promise<Record<string, unknown>> {
  if (executionIntent?.networkAccess !== 'https') throw new Error('This task execution intent does not authorize HTTPS acquisition.');
  if (!Number.isSafeInteger(args.maxBytes) || args.maxBytes <= 0 || !Number.isSafeInteger(args.minimumFreeSpaceBytes) || args.minimumFreeSpaceBytes < 0) {
    throw new Error('HTTPS fetch requires safe positive maxBytes and non-negative minimumFreeSpaceBytes.');
  }
  if (args.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(args.expectedSha256))) throw new Error('expectedSha256 must be a SHA-256 hex digest.');
  const destinationRelativePath = normalizeRelativePath(args.destinationRelativePath);
  const destination = managedContained('sourceAssets', destinationRelativePath);
  await assertNearestManagedParent('sourceAssets', dirname(destination));
  await mkdir(dirname(destination), { recursive: true });
  const requiredFreeBytes = Math.max(args.minimumFreeSpaceBytes,
    Number.isSafeInteger(executionIntent?.minimumFreeSpaceBytes) ? Number(executionIntent!.minimumFreeSpaceBytes) : 0);
  const free = await statfs(canonicalManagedRoots.sourceAssets);
  const freeBytes = Number(free.bavail) * Number(free.bsize);
  if (!Number.isSafeInteger(freeBytes) || freeBytes < requiredFreeBytes) {
    throw new Error(`Managed source volume has ${freeBytes} bytes free; ${requiredFreeBytes} bytes are required before download.`);
  }

  const reused = await reusableDownloadedSource(destination, String(args.url), args.expectedSha256, args.maxBytes);
  if (reused) return reused;

  const partial = `${destination}.partial`;
  let partialBytes = 0;
  try { partialBytes = (await stat(partial)).size; } catch { /* new download */ }
  if (partialBytes > args.maxBytes) throw new Error('Existing partial download exceeds maxBytes.');
  if (args.maxBytes - partialBytes > freeBytes - requiredFreeBytes) {
    throw new Error(`HTTPS fetch maxBytes would consume the required free-space reserve (${args.maxBytes - partialBytes} > ${freeBytes - requiredFreeBytes}).`);
  }
  let url = await assertPublicHttpsUrl(String(args.url));
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetch(url, { redirect: 'manual', headers: partialBytes > 0 ? { Range: `bytes=${partialBytes}-` } : undefined });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTPS source returned redirect ${response.status} without Location.`);
      url = await assertPublicHttpsUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response || [301, 302, 303, 307, 308].includes(response.status)) throw new Error('HTTPS source exceeded five redirects.');
  if (response.status === 416 && partialBytes > 0) {
    await rm(partial, { force: true });
    return fetchHttpsSource({ ...args, url: url.toString() });
  }
  if (!response.ok) throw new Error(`HTTPS source returned ${response.status} ${response.statusText}.`);
  const append = response.status === 206 && partialBytes > 0;
  if (!append) partialBytes = 0;
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 0 && partialBytes + contentLength > args.maxBytes) {
    throw new Error(`HTTPS source would exceed maxBytes (${partialBytes + contentLength} > ${args.maxBytes}).`);
  }
  if (!response.body) throw new Error('HTTPS source returned no response body.');
  const handle = await open(partial, append ? 'a' : 'w');
  let sizeBytes = partialBytes;
  try {
    for await (const chunk of response.body as any) {
      const bytes = Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > args.maxBytes) throw new Error(`HTTPS source exceeded maxBytes (${args.maxBytes}).`);
      await handle.write(bytes);
    }
  } finally { await handle.close(); }
  const sha256 = await fileSha256(partial);
  if (args.expectedSha256 && sha256 !== String(args.expectedSha256).toLowerCase()) {
    await rm(partial, { force: true });
    throw new Error(`HTTPS source SHA-256 mismatch: expected ${args.expectedSha256}, received ${sha256}.`);
  }
  await rm(destination, { force: true });
  await rename(partial, destination);
  const provenance = {
    schemaVersion: 1, sourceUrl: String(args.url), finalUrl: url.toString(), destinationRelativePath,
    sizeBytes, sha256, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
    downloadedAt: new Date().toISOString()
  };
  await writeFile(`${destination}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  return provenance;
}

async function reusableDownloadedSource(
  destination: string,
  sourceUrl: string,
  expectedSha256: unknown,
  maxBytes: number
): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await stat(destination);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const provenance = JSON.parse(await readFile(`${destination}.provenance.json`, 'utf8')) as Record<string, unknown>;
    if (provenance.sourceUrl !== sourceUrl || provenance.sizeBytes !== info.size || typeof provenance.sha256 !== 'string') return undefined;
    const sha256 = await fileSha256(destination);
    if (sha256 !== provenance.sha256 || (expectedSha256 && sha256 !== String(expectedSha256).toLowerCase())) return undefined;
    return { ...provenance, reused: true };
  } catch {
    return undefined;
  }
}

async function assertPublicHttpsUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only credential-free HTTPS source URLs are allowed.');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('HTTPS source resolves to a local or private address.');
  return url;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (/^\d+\.\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined);
  if (!ipv4) return false;
  const parts = ipv4.split('.').map(Number);
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0]! >= 224
    || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168);
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

function contained(path: string) { const target = resolve(root, String(path)); const rel = relative(root, target); if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Path escapes leased checkout.'); return target; }
async function existingContained(path: string) { const target = await realpath(contained(path)); await assertCanonicalContained(target); return target; }
async function assertExistingTargetContained(path: string) { try { await assertCanonicalContained(await realpath(path)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; } }
async function assertNearestExistingParent(path: string): Promise<void> { try { await assertCanonicalContained(await realpath(path)); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; const parent = dirname(path); if (parent === path) throw error; await assertNearestExistingParent(parent); } }
async function assertCanonicalContained(path: string) { const rel = relative(canonicalRoot, path); if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Canonical path escapes leased checkout.'); }
function text(value: string) { return { content: [{ type: 'text', text: value }] }; }
function send(id: unknown, result: unknown) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function sendError(id: unknown, code: number, message: string) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }
