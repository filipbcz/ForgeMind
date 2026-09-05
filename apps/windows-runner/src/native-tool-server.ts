#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { redactSecrets } from '@forgemind/core';
import { assertEvidenceOutsideCheckout, buildSandboxedProcessInvocation } from './native-sandbox.js';

const root = resolve(process.argv[2] ?? '');
const evidencePath = resolve(process.argv[3] ?? '');
const sandboxExecutable = process.argv[4] ?? '';
if (!root || !evidencePath || !sandboxExecutable) throw new Error('Native tool server requires checkout, evidence, and sandbox executable paths.');
assertEvidenceOutsideCheckout(root, evidencePath);
const canonicalRoot = await realpath(root);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => void handle(line));

async function handle(line: string) {
  let request: any;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  try {
    if (request.method === 'initialize') return send(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'forgemind-native', version: '1' } });
    if (request.method === 'ping') return send(request.id, {});
    if (request.method === 'tools/list') return send(request.id, { tools: toolDefinitions });
    if (request.method === 'tools/call') return send(request.id, await callTool(request.params?.name, request.params?.arguments ?? {}));
    sendError(request.id, -32601, 'Method not found');
  } catch (error) { sendError(request.id, -32000, error instanceof Error ? error.message : String(error)); }
}

const toolDefinitions = [
  { name: 'read_file', description: 'Read a UTF-8 file from the exact leased checkout.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'list_directory', description: 'List entries inside the exact leased checkout.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'write_file', description: 'Create or replace a UTF-8 file inside the exact leased checkout.', inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false } },
  { name: 'remove_path', description: 'Remove a file or directory inside the exact leased checkout.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'run_process', description: 'Run any PowerShell, cmd, or project command in the exact leased checkout without an approval or command profile. Returns separate complete redacted stdout and stderr.', inputSchema: { type: 'object', required: ['checkId', 'command', 'shell'], properties: { checkId: { type: 'string' }, command: { type: 'string' }, shell: { type: 'string', enum: ['powershell', 'cmd', 'system'] } }, additionalProperties: false } }
];

async function callTool(name: string, args: any) {
  if (name === 'read_file') return text(await readFile(await existingContained(args.path), 'utf8'));
  if (name === 'list_directory') return text((await readdir(await existingContained(args.path ?? '.'))).join('\n'));
  if (name === 'write_file') { const path = contained(args.path); await assertNearestExistingParent(dirname(path)); await mkdir(dirname(path), { recursive: true }); await assertCanonicalContained(await realpath(dirname(path))); await assertExistingTargetContained(path); await writeFile(path, String(args.content), 'utf8'); return text('written'); }
  if (name === 'remove_path') { const path = contained(args.path); await assertCanonicalContained(await realpath(dirname(path))); await rm(path, { recursive: true, force: true }); return text('removed'); }
  if (name === 'run_process') {
    if (!['powershell', 'cmd', 'system'].includes(args.shell) || typeof args.command !== 'string' || typeof args.checkId !== 'string') throw new Error('Invalid process request.');
    const result = await runProcess(args.checkId, args.command, args.shell);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.exitCode !== 0 };
  }
  throw new Error(`Unknown native tool: ${name}`);
}

async function runProcess(checkId: string, command: string, shell: 'powershell' | 'cmd' | 'system') {
  const sandboxed = buildSandboxedProcessInvocation({ sandboxExecutable, checkoutRoot: root, command, shell });
  const temporaryDirectory = resolve(root, '.forgemind-tmp'); await mkdir(temporaryDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const child = spawn(sandboxed.executable, sandboxed.args, { cwd: root, shell: false, windowsHide: true,
    env: sandboxEnvironment(temporaryDirectory, dirname(evidencePath)) });
  let stdout = ''; let stderr = ''; child.stdout?.on('data', (chunk) => { stdout += String(chunk); }); child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise<number | undefined>((done) => { child.once('error', (error) => { stderr += error.message; done(undefined); }); child.once('close', (code) => done(code ?? undefined)); });
  const result = { checkId, command, shell, exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr), startedAt, completedAt: new Date().toISOString() };
  await appendFile(evidencePath, `${JSON.stringify(result)}\n`, 'utf8'); return result;
}

function sandboxEnvironment(temporaryDirectory: string, isolatedCodexHome: string): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(key)) continue;
    safe[key] = value;
  }
  safe.CODEX_HOME = isolatedCodexHome; safe.TEMP = temporaryDirectory; safe.TMP = temporaryDirectory;
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
