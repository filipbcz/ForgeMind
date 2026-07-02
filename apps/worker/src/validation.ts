import { execaCommand } from 'execa';

const forbiddenCommandPatterns = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  />/,
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
}

export async function runValidationCommand(command: string, cwd: string): Promise<ValidationResult> {
  assertAllowedValidationCommand(command);

  try {
    const result = await execaCommand(command, {
      cwd,
      shell: true,
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

