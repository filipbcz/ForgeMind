import { execaCommand } from 'execa';
import type { ValidationCheck } from '@forgemind/providers';

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
}

export interface ValidationCheckExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  criterion?: string;
  rationale?: string;
}

export interface ValidationActivity {
  state: 'started' | 'output' | 'completed';
  command: string;
  checkIndex: number;
  checkCount: number;
  elapsedMs: number;
  stream?: 'stdout' | 'stderr';
  message?: string;
  exitCode?: number;
  reused?: boolean;
}

export type ValidationActivityHandler = (activity: ValidationActivity) => Promise<void> | void;

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
  onOutput?: (stream: 'stdout' | 'stderr', message: string) => Promise<void> | void
): Promise<ValidationResult> {
  const effectiveCommand = normalizeValidationCommandForEnvironment(command);
  assertAllowedValidationCommand(effectiveCommand);

  try {
    const subprocess = execaCommand(effectiveCommand, {
      cwd,
      shell: shouldUsePowerShell(effectiveCommand) ? 'powershell.exe' : true,
      timeout: 10 * 60 * 1000,
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
  passedCheckResults: ReadonlyMap<string, ValidationCheckExecutionResult> = new Map()
): Promise<ValidationResult> {
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
    const effectiveCommand = normalizeValidationCommandForEnvironment(check.command);
    const passedResult = passedCheckResults.get(effectiveCommand);
    if (passedResult?.passed) {
      reusedCheckCount += 1;
      checkResults.push({
        ...passedResult,
        criterion: check.criterion,
        rationale: check.rationale
      });
      outputs.push(`[command] ${effectiveCommand}`);
      outputs.push('[result] Previously passed; not executed again.');
      await onActivity?.({
        state: 'completed',
        command: effectiveCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: 0,
        exitCode: 0,
        reused: true
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
      elapsedMs: 0
    });
    const result = await runValidationCommand(effectiveCommand, cwd, async (stream, message) => {
      await onActivity?.({
        state: 'output',
        command: effectiveCommand,
        checkIndex: index + 1,
        checkCount: checks.length,
        elapsedMs: Date.now() - startedAt,
        stream,
        message
      });
    });
    await onActivity?.({
      state: 'completed',
      command: effectiveCommand,
      checkIndex: index + 1,
      checkCount: checks.length,
      elapsedMs: Date.now() - startedAt,
      exitCode: result.exitCode
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
      criterion: check.criterion,
      rationale: check.rationale
    });

    if (!result.passed) {
      const normalizedError = result.stderr || result.stdout || `Exit code ${result.exitCode}`;
      failingResult = result;
      failingResult.stderr = normalizedError;
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
    failingCommand: failingResult?.command
  };
}

export function collectPassedValidationCheckResults(
  result: ValidationResult,
  target: Map<string, ValidationCheckExecutionResult> = new Map()
): Map<string, ValidationCheckExecutionResult> {
  for (const checkResult of result.checkResults ?? []) {
    if (checkResult.passed) {
      target.set(checkResult.command, checkResult);
    }
  }
  return target;
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
