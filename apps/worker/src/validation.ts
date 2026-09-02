import { execaCommand } from 'execa';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ValidationCheck } from '@forgemind/providers';
import { createWorkspaceEnvironment } from '@forgemind/shared';

const VALIDATION_OUTPUT_FLUSH_MS = 350;
const MAX_ACTIVITY_CHUNK_CHARS = 8_000;

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  termination?: ProcessTreeTermination;
  checkResults?: ValidationCheckExecutionResult[];
  executedCheckCount?: number;
  reusedCheckCount?: number;
  failingCommand?: string;
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
  shell?: ValidationCheck['shell'];
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  inputHash?: string;
  criterion?: string;
  rationale?: string;
}

export interface ProcessTreeTermination {
  reason: 'timeout' | 'cancelled';
  pid?: number;
  signal: 'SIGTERM';
  processGroupTerminated: boolean;
  errorMessage?: string;
}

export interface ValidationActivity {
  state: 'started' | 'output' | 'completed' | 'terminated';
  command: string;
  shell?: ValidationCheck['shell'];
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
  termination?: ProcessTreeTermination;
}

export type ValidationActivityHandler = (activity: ValidationActivity) => Promise<void> | void;
type ProcessTreeTerminationHandler = (termination: ProcessTreeTermination) => Promise<void> | void;

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
  return command.trim();
}

export function assertAllowedValidationCommand(command: string): void {
  if (!command.trim()) throw new Error('Validation command must not be empty.');
}

function resolveValidationShell(shell: ValidationCheck['shell'] = 'system'): true | string {
  if (shell === 'powershell') return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  if (shell === 'cmd') return 'cmd.exe';
  if (shell === 'bash') return 'bash';
  if (shell === 'sh') return 'sh';
  return true;
}

export async function runValidationCommand(
  command: string,
  cwd: string,
  onOutput?: (stream: 'stdout' | 'stderr', message: string) => Promise<void> | void,
  timeoutMinutes = 10,
  signal?: AbortSignal,
  onTermination?: ProcessTreeTerminationHandler,
  shell: ValidationCheck['shell'] = 'system'
): Promise<ValidationResult> {
  throwIfAborted(signal);
  const normalizedCommand = normalizeValidationCommandForEnvironment(command);
  let effectiveCommand = normalizedCommand;

  try {
    assertAllowedValidationCommand(normalizedCommand);
    const subprocess = execaCommand(effectiveCommand, {
      cwd,
      env: createValidationEnvironment(process.env, cwd),
      shell: resolveValidationShell(shell),
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
  return Math.max(1_000, Math.min(600 * 60_000, minutes * 60_000));
}

export async function runValidationChecks(
  checks: ValidationCheck[],
  cwd: string,
  onActivity?: ValidationActivityHandler,
  passedCheckResults: ReadonlyMap<string, ValidationCheckExecutionResult> = new Map(),
  inputHash?: string,
  signal?: AbortSignal
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
  for (const [index, check] of checks.entries()) {
    throwIfAborted(signal);
    const effectiveCommand = normalizeValidationCommandForEnvironment(check.command);
    const shell = check.shell ?? 'system';
    const resultKey = validationCheckResultKey(effectiveCommand, inputHash, shell);
    const passedResult = passedCheckResults.get(resultKey);
    if (passedResult?.passed) {
      reusedCheckCount += 1;
      checkResults.push({
        ...passedResult,
        shell,
        criterion: check.criterion,
        rationale: check.rationale,
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
        shell,
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
      assertAllowedValidationCommand(effectiveCommand);
    } catch (error) {
      const result: ValidationResult = {
        command: effectiveCommand,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        passed: false
      };
      await onActivity?.({
        state: 'completed',
        command: effectiveCommand,
        shell,
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
      });
      outputs.push(`[command] ${effectiveCommand}`);
      if (check.criterion) {
        outputs.push(`[criterion] ${check.criterion}`);
      }
      if (check.rationale) {
        outputs.push(`[rationale] ${check.rationale}`);
      }
      outputs.push(result.stderr);
      checkResults.push({
        ...result,
        shell,
        inputHash,
        criterion: check.criterion,
        rationale: check.rationale,
      });
      failingResult ??= result;
      if (!check.continueOnFailure) break;
      continue;
    }
    const startedAt = Date.now();
    await onActivity?.({
      state: 'started',
      command: effectiveCommand,
      shell,
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
        shell,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: Date.now() - startedAt,
        stream,
        message,
        inputHash,
        category: check.category
      });
    }, check.timeoutMinutes, signal, async (termination) => {
      await onActivity?.({
        state: 'terminated',
        command: effectiveCommand,
        shell,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: Date.now() - startedAt,
        inputHash,
        category: check.category,
        termination,
        message: `Validation command process tree terminated after ${termination.reason}.`
      });
    }, shell);
    await onActivity?.({
      state: 'completed',
      command: effectiveCommand,
      shell,
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
      shell,
      inputHash,
      criterion: check.criterion,
      rationale: check.rationale,
    });

    if (!result.passed) {
      failingResult ??= result;
      if (!check.continueOnFailure) break;
    }
  }

  return {
    command: checks.map((check) => normalizeValidationCommandForEnvironment(check.command)).join('\n'),
    exitCode: failingResult?.exitCode ?? 0,
    stdout: outputs.join('\n'),
    stderr: failingResult?.stderr ?? '',
    passed: !failingResult,
    checkResults,
    executedCheckCount,
    reusedCheckCount,
    failingCommand: failingResult?.command
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
      target.set(validationCheckResultKey(checkResult.command, checkResult.inputHash, checkResult.shell), checkResult);
    }
  }
  return target;
}

export function validationCheckResultKey(command: string, inputHash?: string, shell: ValidationCheck['shell'] = 'system'): string {
  const key = `${shell}:${command}`;
  return inputHash ? `${inputHash}:${key}` : key;
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
