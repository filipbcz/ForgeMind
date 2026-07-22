import { execaCommand } from 'execa';
import type { ValidationCheck } from '@forgemind/providers';

const forbiddenCommandPatterns = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\|\s*sh\b/i,
  /\|\s*bash\b/i,
  /\bchmod\s+777\b/i
];

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
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

export async function runValidationCommand(command: string, cwd: string): Promise<ValidationResult> {
  assertAllowedValidationCommand(command);

  try {
    const result = await execaCommand(command, {
      cwd,
      shell: shouldUsePowerShell(command) ? 'powershell.exe' : true,
      timeout: 10 * 60 * 1000,
      reject: false
    });

    return {
      command,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
      passed: result.exitCode === 0
    };
  } catch (error) {
    return {
      command,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      passed: false
    };
  }
}

export async function runValidationChecks(checks: ValidationCheck[], cwd: string): Promise<ValidationResult> {
  const commandChecks = checks.filter((check): check is Extract<ValidationCheck, { kind: 'command' }> => check.kind === 'command');
  if (commandChecks.length === 0) {
    return {
      command: 'manual-review',
      exitCode: 0,
      stdout: 'No executable validation command was planned.',
      stderr: '',
      passed: true
    };
  }

  const outputs: string[] = [];
  let failingResult: ValidationResult | undefined;

  for (const check of commandChecks) {
    const result = await runValidationCommand(check.command, cwd);
    outputs.push(`[command] ${check.command}`);
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

    if (!result.passed) {
      const normalizedError = result.stderr || result.stdout || `Exit code ${result.exitCode}`;
      failingResult = result;
      failingResult.stderr = normalizedError;
      break;
    }
  }

  return {
    command: commandChecks.map((check) => check.command).join(' && '),
    exitCode: failingResult?.exitCode ?? 0,
    stdout: outputs.join('\n'),
    stderr: failingResult?.stderr ?? '',
    passed: !failingResult
  };
}
