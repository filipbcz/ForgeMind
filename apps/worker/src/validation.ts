import { execaCommand } from 'execa';
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ValidationCheck } from '@forgemind/providers';
import { createWorkspaceEnvironment } from '@forgemind/shared';
import { missingValidationCapabilities, requiredValidationCapabilities, resolveWorkerCapabilities } from './worker-capabilities.js';
import { prepareResourcePolicyCommand, type WorkerResourcePolicy } from './resource-policy.js';

const VALIDATION_OUTPUT_FLUSH_MS = 350;
const MAX_ACTIVITY_CHUNK_CHARS = 8_000;

const forbiddenCommandPatterns = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\|\s*sh\b/i,
  /\|\s*bash\b/i,
  /\bchmod\s+777\b/i,
  /\b(?:apt|apt-get|apk|dnf|yum|pacman|brew|choco|winget)\s+(?:add|install)\b/i
];

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  denied?: FilesystemIsolationDenial;
  termination?: ProcessTreeTermination;
  checkResults?: ValidationCheckExecutionResult[];
  executedCheckCount?: number;
  reusedCheckCount?: number;
  failingCommand?: string;
  deferredChecks?: DeferredValidationCheck[];
}

export interface DeferredValidationCheck {
  command: string;
  category?: ValidationCheck['category'];
  criterion?: string;
  rationale?: string;
  requiredCapabilities: string[];
  missingCapabilities: string[];
}

export function formatValidationFailure(
  result: Pick<ValidationResult, 'command' | 'stdout' | 'stderr' | 'exitCode'>
): string {
  return [
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode}`,
    `[stdout]\n${result.stdout}`,
    `[stderr]\n${result.stderr}`
  ].join('\n\n');
}

export interface ValidationCheckExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  inputHash?: string;
  criterion?: string;
  rationale?: string;
  requiredCapabilities?: string[];
}

export interface ProcessTreeTermination {
  reason: 'timeout' | 'cancelled';
  pid?: number;
  signal: 'SIGTERM';
  processGroupTerminated: boolean;
  errorMessage?: string;
}

export interface ValidationActivity {
  state: 'started' | 'output' | 'completed' | 'deferred' | 'denied' | 'terminated';
  command: string;
  checkIndex: number;
  checkCount: number;
  elapsedMs: number;
  stream?: 'stdout' | 'stderr';
  message?: string;
  exitCode?: number;
  reused?: boolean;
  inputHash?: string;
  category?: ValidationCheck['category'];
  stdout?: string;
  stderr?: string;
  criterion?: string;
  rationale?: string;
  requiredCapabilities?: string[];
  denial?: FilesystemIsolationDenial;
  termination?: ProcessTreeTermination;
}

export type ValidationActivityHandler = (activity: ValidationActivity) => Promise<void> | void;
type ProcessTreeTerminationHandler = (termination: ProcessTreeTermination) => Promise<void> | void;

export interface WorkspaceFilesystemPolicy {
  workspacePath: string;
  forbiddenPaths?: string[];
}

export interface FilesystemIsolationDenial {
  policy: 'filesystem_isolation';
  reason: 'outside_workspace' | 'forbidden_path';
  path: string;
  resolvedPath: string;
  workspacePath: string;
  command: string;
}

interface CanonicalForbiddenPath {
  resolvedPath?: string;
  pattern?: RegExp;
}

export function createValidationEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  workspacePath?: string
): NodeJS.ProcessEnv {
  const environment = createWorkspaceEnvironment(source);
  if (!workspacePath) return environment;
  const virtualEnvironmentBin = process.platform === 'win32'
    ? join(workspacePath, '.venv', 'Scripts')
    : join(workspacePath, '.venv', 'bin');
  if (!existsSync(virtualEnvironmentBin)) return environment;
  return {
    ...environment,
    VIRTUAL_ENV: join(workspacePath, '.venv'),
    PATH: [virtualEnvironmentBin, environment.PATH].filter(Boolean).join(delimiter)
  };
}

export function normalizeValidationCommandForEnvironment(command: string): string {
  const trimmed = command.trim();
  const firstSegment = trimmed.split(/&&|\|\||;/, 1)[0] ?? trimmed;
  if (!/^npm(?:\.cmd)?\s+ci\b/i.test(firstSegment)) {
    return trimmed;
  }

  if (
    /--(?:include|omit)(?:=|\s+)dev\b/i.test(firstSegment)
    || /--production\b/i.test(firstSegment)
    || /--only(?:=|\s+)prod(?:uction)?\b/i.test(firstSegment)
  ) {
    return trimmed;
  }

  return trimmed.replace(/^(npm(?:\.cmd)?\s+ci)\b/i, '$1 --include=dev');
}

export function assertAllowedValidationCommand(command: string): void {
  for (const pattern of forbiddenCommandPatterns) {
    if (pattern.test(command)) {
      throw new Error(`Validation command is not allowed: ${command}`);
    }
  }

  if (containsUnquotedOutputRedirection(command)) {
    throw new Error(`Validation command is not allowed: ${command}`);
  }
}

function containsUnquotedOutputRedirection(command: string): boolean {
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }

    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }

    if (!quote && character === '>') {
      return true;
    }
  }

  return false;
}

function shouldUsePowerShell(command: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  return [
    /\bTest-Path\b/i,
    /\bGet-Content\b/i,
    /\bSet-Content\b/i,
    /\bAdd-Content\b/i,
    /\bOut-File\b/i,
    /\bSelect-Object\b/i,
    /\bSelect-String\b/i,
    /\bWhere-Object\b/i,
    /\bForEach-Object\b/i,
    /\bMeasure-Object\b/i,
    /\bGet-ChildItem\b/i,
    /\bNew-Item\b/i,
    /\bRemove-Item\b/i,
    /\bCopy-Item\b/i,
    /\bMove-Item\b/i,
    /\bWrite-Output\b/i,
    /\bWrite-Host\b/i,
    /\bWrite-Error\b/i,
    /\bJoin-Path\b/i,
    /\bSplit-Path\b/i,
    /\$[A-Za-z_][A-Za-z0-9_]*/,
    /\.\s*Where\(\{/,
    /(?:^|[;&(])\s*\$\w+\s*=/,
    /(^|\s)-Raw(\s|$)/
  ].some((pattern) => pattern.test(command));
}

export async function runValidationCommand(
  command: string,
  cwd: string,
  onOutput?: (stream: 'stdout' | 'stderr', message: string) => Promise<void> | void,
  timeoutMinutes = 10,
  signal?: AbortSignal,
  filesystemPolicy?: WorkspaceFilesystemPolicy,
  onTermination?: ProcessTreeTerminationHandler,
  resourcePolicy?: WorkerResourcePolicy
): Promise<ValidationResult> {
  throwIfAborted(signal);
  const normalizedCommand = normalizeValidationCommandForEnvironment(command);
  let effectiveCommand = normalizedCommand;

  try {
    assertAllowedValidationCommand(normalizedCommand);
    const denial = await evaluateCommandFilesystemIsolation(normalizedCommand, cwd, filesystemPolicy);
    if (denial) {
      return {
        command: normalizedCommand,
        exitCode: 1,
        stdout: '',
        stderr: formatFilesystemIsolationDenial(denial),
        passed: false
      };
    }
    effectiveCommand = prepareResourcePolicyCommand(normalizedCommand, resourcePolicy);
    const subprocess = execaCommand(effectiveCommand, {
      cwd,
      env: createValidationEnvironment(process.env, cwd),
      shell: shouldUsePowerShell(effectiveCommand) ? 'powershell.exe' : true,
      detached: process.platform !== 'win32',
      reject: false
    });
    let termination: ProcessTreeTermination | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminateProcessTree = (reason: ProcessTreeTermination['reason']) => {
      if (termination) return;
      const pid = subprocess.pid;
      const processGroupTerminated = Boolean(pid && process.platform !== 'win32');
      let errorMessage: string | undefined;
      try {
        if (processGroupTerminated) {
          process.kill(-pid!, 'SIGTERM');
          forceKillTimer = setTimeout(() => {
            try {
              process.kill(-pid!, 'SIGKILL');
            } catch {
              // The process group already exited.
            }
          }, 5_000);
          forceKillTimer.unref();
        } else {
          subprocess.kill('SIGTERM');
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      termination = {
        reason,
        pid,
        signal: 'SIGTERM',
        processGroupTerminated,
        errorMessage
      };
    };
    const abortListener = () => terminateProcessTree('cancelled');
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) {
      terminateProcessTree('cancelled');
    }
    const timeout = setTimeout(() => terminateProcessTree('timeout'), resolveValidationTimeoutMs(timeoutMinutes));
    const pendingOutput: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let flushTimer: NodeJS.Timeout | undefined;
    let outputQueue = Promise.resolve();

    const enqueueOutput = (stream: 'stdout' | 'stderr', message: string) => {
      const sanitized = sanitizeValidationOutput(message);
      if (!sanitized) return;
      pendingOutput[stream] = `${pendingOutput[stream]}${sanitized}`.slice(-MAX_ACTIVITY_CHUNK_CHARS);
      if (!flushTimer) {
        flushTimer = setTimeout(() => flushOutput(), VALIDATION_OUTPUT_FLUSH_MS);
      }
    };
    const flushOutput = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      for (const stream of ['stdout', 'stderr'] as const) {
        const message = pendingOutput[stream];
        pendingOutput[stream] = '';
        if (!message || !onOutput) continue;
        outputQueue = outputQueue.then(async () => {
          await onOutput(stream, message);
        });
      }
    };

    subprocess.stdout?.on('data', (chunk: Buffer | string) => enqueueOutput('stdout', String(chunk)));
    subprocess.stderr?.on('data', (chunk: Buffer | string) => enqueueOutput('stderr', String(chunk)));

    const result = await subprocess;
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener('abort', abortListener);
    flushOutput();
    await outputQueue;
    if (termination) {
      await onTermination?.(termination);
    }
    if (termination?.reason === 'cancelled') {
      throw signal?.reason instanceof Error ? signal.reason : new Error('Validation was cancelled.');
    }

    return {
      command: effectiveCommand,
      exitCode: termination ? 1 : (result.exitCode ?? 0),
      stdout: sanitizeValidationOutput(result.stdout),
      stderr: sanitizeValidationOutput(termination?.reason === 'timeout'
        ? `${result.stderr ? `${result.stderr}\n` : ''}Validation command timed out; terminated process tree.`
        : result.stderr),
      passed: !termination && result.exitCode === 0,
      termination
    };
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Validation was cancelled.');
    }
    return {
      command: effectiveCommand,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      passed: false
    };
  }
}

function resolveValidationTimeoutMs(timeoutMinutes: number): number {
  const minutes = Number.isFinite(timeoutMinutes) ? timeoutMinutes : 10;
  return Math.max(1_000, Math.min(60 * 60_000, minutes * 60_000));
}

export async function runValidationChecks(
  checks: ValidationCheck[],
  cwd: string,
  onActivity?: ValidationActivityHandler,
  passedCheckResults: ReadonlyMap<string, ValidationCheckExecutionResult> = new Map(),
  inputHash?: string,
  signal?: AbortSignal,
  availableCapabilities: ReadonlySet<string> = resolveWorkerCapabilities(),
  filesystemPolicy?: WorkspaceFilesystemPolicy,
  resourcePolicy?: WorkerResourcePolicy
): Promise<ValidationResult> {
  throwIfAborted(signal);
  if (checks.length === 0) {
    return {
      command: 'no-executable-checks',
      exitCode: 0,
      stdout: 'No acceptance criteria can be verified by an executable command; validation was skipped.',
      stderr: '',
      passed: true,
      checkResults: [],
      executedCheckCount: 0,
      reusedCheckCount: 0
    };
  }

  const outputs: string[] = [];
  const checkResults: ValidationCheckExecutionResult[] = [];
  let executedCheckCount = 0;
  let reusedCheckCount = 0;
  let failingResult: ValidationResult | undefined;
  const deferredChecks: DeferredValidationCheck[] = [];

  for (const [index, check] of checks.entries()) {
    throwIfAborted(signal);
    const normalizedCommand = normalizeValidationCommandForEnvironment(check.command);
    let effectiveCommand = normalizedCommand;
    try {
      effectiveCommand = prepareResourcePolicyCommand(normalizedCommand, resourcePolicy);
    } catch (error) {
      const result: ValidationResult = {
        command: normalizedCommand,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        passed: false
      };
      await onActivity?.({
        state: 'denied',
        command: normalizedCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: 0,
        inputHash,
        category: check.category,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities
      });
      outputs.push(`[command] ${normalizedCommand}`);
      outputs.push(result.stderr);
      checkResults.push({
        ...result,
        inputHash,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities
      });
      failingResult = result;
      break;
    }
    const missingCapabilities = missingValidationCapabilities(check, availableCapabilities);
    if (missingCapabilities.length > 0) {
      const deferredCheck: DeferredValidationCheck = {
        command: effectiveCommand,
        category: check.category,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: requiredValidationCapabilities(check),
        missingCapabilities
      };
      deferredChecks.push(deferredCheck);
      outputs.push(`[deferred] ${effectiveCommand}`);
      outputs.push(`[missing-capabilities] ${missingCapabilities.join(', ')}`);
      if (check.criterion) outputs.push(`[criterion] ${check.criterion}`);
      await onActivity?.({
        state: 'deferred',
        command: effectiveCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: 0,
        inputHash,
        category: check.category,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: deferredCheck.requiredCapabilities,
        message: `Missing worker capabilities: ${missingCapabilities.join(', ')}`
      });
      continue;
    }
    const resultKey = validationCheckResultKey(effectiveCommand, inputHash);
    const passedResult = passedCheckResults.get(resultKey);
    if (passedResult?.passed) {
      reusedCheckCount += 1;
      checkResults.push({
        ...passedResult,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities,
        inputHash
      });
      outputs.push(`[command] ${effectiveCommand}`);
      if (check.criterion) {
        outputs.push(`[criterion] ${check.criterion}`);
      }
      if (check.rationale) {
        outputs.push(`[rationale] ${check.rationale}`);
      }
      outputs.push('[result] Reused successful validation evidence for the unchanged workspace input.');
      if (passedResult.stdout) {
        outputs.push(passedResult.stdout);
      }
      if (passedResult.stderr) {
        outputs.push(passedResult.stderr);
      }
      await onActivity?.({
        state: 'completed',
        command: effectiveCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: 0,
        exitCode: 0,
        reused: true,
        inputHash,
        category: check.category,
        stdout: passedResult.stdout,
        stderr: passedResult.stderr,
        criterion: check.criterion,
        rationale: check.rationale
      });
      continue;
    }

    executedCheckCount += 1;
    try {
      assertAllowedValidationCommand(normalizedCommand);
    } catch (error) {
      const result: ValidationResult = {
        command: normalizedCommand,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        passed: false
      };
      await onActivity?.({
        state: 'completed',
        command: normalizedCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: 0,
        inputHash,
        category: check.category,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities
      });
      outputs.push(`[command] ${normalizedCommand}`);
      if (check.criterion) {
        outputs.push(`[criterion] ${check.criterion}`);
      }
      if (check.rationale) {
        outputs.push(`[rationale] ${check.rationale}`);
      }
      outputs.push(result.stderr);
      checkResults.push({
        ...result,
        inputHash,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities
      });
      failingResult = result;
      break;
    }
    const denial = await evaluateCommandFilesystemIsolation(normalizedCommand, cwd, filesystemPolicy);
    if (denial) {
      const result: ValidationResult = {
        command: normalizedCommand,
        exitCode: 1,
        stdout: '',
        stderr: formatFilesystemIsolationDenial(denial),
        passed: false,
        denied: denial
      };
      await onActivity?.({
        state: 'denied',
        command: normalizedCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: 0,
        inputHash,
        category: check.category,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities,
        denial
      });
      outputs.push(`[command] ${normalizedCommand}`);
      if (check.criterion) {
        outputs.push(`[criterion] ${check.criterion}`);
      }
      if (check.rationale) {
        outputs.push(`[rationale] ${check.rationale}`);
      }
      outputs.push(result.stderr);
      checkResults.push({
        ...result,
        inputHash,
        criterion: check.criterion,
        rationale: check.rationale,
        requiredCapabilities: check.requiredCapabilities
      });
      failingResult = result;
      break;
    }
    const startedAt = Date.now();
    await onActivity?.({
      state: 'started',
      command: effectiveCommand,
      checkIndex: index + 1,
      checkCount: checks.length,
      elapsedMs: 0,
      inputHash,
      category: check.category
    });
    const result = await runValidationCommand(normalizedCommand, cwd, async (stream, message) => {
      await onActivity?.({
        state: 'output',
        command: effectiveCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: Date.now() - startedAt,
        stream,
        message,
        inputHash,
        category: check.category
      });
    }, check.timeoutMinutes, signal, filesystemPolicy, async (termination) => {
      await onActivity?.({
        state: 'terminated',
        command: effectiveCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: Date.now() - startedAt,
        inputHash,
        category: check.category,
        termination,
        message: `Validation command process tree terminated after ${termination.reason}.`
      });
    }, resourcePolicy);
    await onActivity?.({
      state: 'completed',
      command: effectiveCommand,
      checkIndex: index + 1,
      checkCount: checks.length,
      elapsedMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      inputHash,
      category: check.category,
      stdout: result.stdout,
      stderr: result.stderr,
      criterion: check.criterion,
      rationale: check.rationale,
      requiredCapabilities: check.requiredCapabilities
    });
    outputs.push(`[command] ${effectiveCommand}`);
    if (check.criterion) {
      outputs.push(`[criterion] ${check.criterion}`);
    }
    if (check.rationale) {
      outputs.push(`[rationale] ${check.rationale}`);
    }
    if (result.stdout) {
      outputs.push(result.stdout);
    }
    if (result.stderr) {
      outputs.push(result.stderr);
    }
    checkResults.push({
      ...result,
      inputHash,
      criterion: check.criterion,
      rationale: check.rationale,
      requiredCapabilities: check.requiredCapabilities
    });

    if (!result.passed) {
      failingResult = result;
      break;
    }
  }

  return {
    command: checks.map((check) => normalizeValidationCommandForEnvironment(check.command)).join(' && '),
    exitCode: failingResult?.exitCode ?? 0,
    stdout: outputs.join('\n'),
    stderr: failingResult?.stderr ?? '',
    passed: !failingResult,
    checkResults,
    executedCheckCount,
    reusedCheckCount,
    failingCommand: failingResult?.command,
    denied: failingResult?.denied,
    deferredChecks
  };
}

export async function evaluateCommandFilesystemIsolation(
  command: string,
  cwd: string,
  policy?: WorkspaceFilesystemPolicy
): Promise<FilesystemIsolationDenial | undefined> {
  const workspacePath = await canonicalizePath(policy?.workspacePath ?? cwd);
  if (!isPathInside(workspacePath, await canonicalizePath(cwd))) {
    return {
      policy: 'filesystem_isolation',
      reason: 'outside_workspace',
      path: cwd,
      resolvedPath: await canonicalizePath(cwd),
      workspacePath,
      command
    };
  }

  const forbiddenPaths = await Promise.all(
    uniqueStrings(['/var/run/docker.sock', ...(policy?.forbiddenPaths ?? [])])
      .map((item) => canonicalizePolicyPath(item, workspacePath))
  );
  const candidates = extractCommandPathCandidates(command, policy?.forbiddenPaths ?? []);
  for (const candidate of candidates) {
    const resolvedPath = await canonicalizePath(isAbsolute(candidate) ? candidate : resolve(workspacePath, candidate));
    if (forbiddenPaths.some((forbiddenPath) => matchesForbiddenPath(forbiddenPath, resolvedPath))) {
      return {
        policy: 'filesystem_isolation',
        reason: 'forbidden_path',
        path: candidate,
        resolvedPath,
        workspacePath,
        command
      };
    }
    if (!isPathInside(workspacePath, resolvedPath)) {
      return {
        policy: 'filesystem_isolation',
        reason: 'outside_workspace',
        path: candidate,
        resolvedPath,
        workspacePath,
        command
      };
    }
  }

  return undefined;
}

async function canonicalizePolicyPath(path: string, workspacePath: string): Promise<CanonicalForbiddenPath> {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('*')) {
    const absolutePattern = isAbsolute(path) ? normalized : resolve(workspacePath, normalized).replace(/\\/g, '/');
    return { pattern: wildcardPathPattern(absolutePattern) };
  }
  return { resolvedPath: await canonicalizePath(isAbsolute(path) ? path : resolve(workspacePath, path)) };
}

async function canonicalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = await nearestExistingParent(path);
    const relativeTail = relative(parent.originalPath, resolve(path));
    return resolve(parent.realPath, relativeTail);
  }
}

async function nearestExistingParent(path: string): Promise<{ originalPath: string; realPath: string }> {
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      return { originalPath: current, realPath: await realpath(current) };
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return { originalPath: current, realPath: current };
      current = parent;
    }
  }
}

function extractCommandPathCandidates(command: string, forbiddenPaths: string[] = []): string[] {
  const candidates: string[] = [];
  const bareForbiddenPaths = new Set(forbiddenPaths.flatMap((item) => {
    const normalized = item.replace(/\\/g, '/');
    if (isAbsolute(normalized) || normalized.includes('*') || normalized.includes('/')) return [];
    return [normalized];
  }));
  for (const token of command.matchAll(/(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>]+))/g)) {
    const value = (token[1] ?? token[2] ?? token[3] ?? '').trim();
    const cleaned = value.replace(/[,.]+$/g, '');
    if (!cleaned || cleaned.includes('://') || cleaned.startsWith('-')) continue;
    if (
      isAbsolute(cleaned)
      || cleaned.startsWith('./')
      || cleaned.startsWith('../')
      || cleaned.includes('/')
      || cleaned.includes('\\')
      || bareForbiddenPaths.has(cleaned.replace(/\\/g, '/'))
    ) {
      candidates.push(cleaned);
    }
  }
  return uniqueStrings(candidates);
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isSameOrDescendant(parent: string, child: string): boolean {
  return isPathInside(parent, child) || isPathInside(child, parent);
}

function matchesForbiddenPath(forbiddenPath: CanonicalForbiddenPath, resolvedPath: string): boolean {
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  if (forbiddenPath.pattern?.test(normalizedPath)) return true;
  return Boolean(forbiddenPath.resolvedPath && isSameOrDescendant(forbiddenPath.resolvedPath, resolvedPath));
}

function wildcardPathPattern(path: string): RegExp {
  const escaped = path
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}(?:/|$)`);
}

function formatFilesystemIsolationDenial(denial: FilesystemIsolationDenial): string {
  return `Validation command denied by filesystem isolation policy: ${denial.reason} (${denial.path} -> ${denial.resolvedPath})`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Validation was cancelled.');
}

export function collectPassedValidationCheckResults(
  result: ValidationResult,
  target: Map<string, ValidationCheckExecutionResult> = new Map()
): Map<string, ValidationCheckExecutionResult> {
  for (const checkResult of result.checkResults ?? []) {
    if (checkResult.passed) {
      target.set(validationCheckResultKey(checkResult.command, checkResult.inputHash), checkResult);
    }
  }
  return target;
}

export function validationCheckResultKey(command: string, inputHash?: string): string {
  return inputHash ? `${inputHash}:${command}` : command;
}

function sanitizeValidationOutput(value: string): string {
  let sanitized = value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  for (const [name, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 6 || !/(?:TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL|AUTH)/i.test(name)) {
      continue;
    }
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  return sanitized;
}
