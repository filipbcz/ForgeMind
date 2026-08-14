import { execaCommand } from 'execa';
import type { ValidationCheck } from '@forgemind/providers';
import { createWorkspaceEnvironment } from '@forgemind/shared';
import { missingValidationCapabilities, requiredValidationCapabilities, resolveWorkerCapabilities } from './worker-capabilities.js';

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

export interface ValidationActivity {
  state: 'started' | 'output' | 'completed' | 'deferred';
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
}

export type ValidationActivityHandler = (activity: ValidationActivity) => Promise<void> | void;

export function createValidationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return createWorkspaceEnvironment(source);
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
  signal?: AbortSignal
): Promise<ValidationResult> {
  throwIfAborted(signal);
  const effectiveCommand = normalizeValidationCommandForEnvironment(command);
  assertAllowedValidationCommand(effectiveCommand);

  try {
    const subprocess = execaCommand(effectiveCommand, {
      cwd,
      env: createValidationEnvironment(),
      shell: shouldUsePowerShell(effectiveCommand) ? 'powershell.exe' : true,
      timeout: Math.max(1, Math.min(60, timeoutMinutes)) * 60 * 1000,
      cancelSignal: signal,
      reject: false
    });
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
    flushOutput();
    await outputQueue;

    return {
      command: effectiveCommand,
      exitCode: result.exitCode ?? 0,
      stdout: sanitizeValidationOutput(result.stdout),
      stderr: sanitizeValidationOutput(result.stderr),
      passed: result.exitCode === 0
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

export async function runValidationChecks(
  checks: ValidationCheck[],
  cwd: string,
  onActivity?: ValidationActivityHandler,
  passedCheckResults: ReadonlyMap<string, ValidationCheckExecutionResult> = new Map(),
  inputHash?: string,
  signal?: AbortSignal,
  availableCapabilities: ReadonlySet<string> = resolveWorkerCapabilities()
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
    const effectiveCommand = normalizeValidationCommandForEnvironment(check.command);
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
    const result = await runValidationCommand(effectiveCommand, cwd, async (stream, message) => {
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
    }, check.timeoutMinutes, signal);
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
    deferredChecks
  };
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
