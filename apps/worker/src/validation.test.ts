import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAllowedValidationCommand, runValidationCommand, runValidationChecks } from './validation.js';

describe('validation runner', () => {
  it('executes plain command checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-cmd-'));

    const result = await runValidationCommand('node --version', cwd);

    expect(result.passed).toBe(true);
    expect(result.stdout).toContain('v');
  });

  it('executes quoted inline JavaScript containing arrow functions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-inline-js-'));
    const command = `node --input-type=module -e "const items = [{ id: 1 }]; if (!items.some((item) => item.id === 1)) process.exit(1);"`;

    expect(() => assertAllowedValidationCommand(command)).not.toThrow();
    await expect(runValidationCommand(command, cwd)).resolves.toMatchObject({ passed: true, exitCode: 0 });
  });

  it('rejects shell output redirection outside quoted arguments', () => {
    expect(() => assertAllowedValidationCommand('node --version > version.txt')).toThrow(
      'Validation command is not allowed'
    );
  });

  it.runIf(process.platform === 'win32')('executes PowerShell-style command checks on Windows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-ps-'));
    await writeFile(join(cwd, 'SANITY_CHECK.md'), 'ForgeMind validates tasks.\nIt should pass build checks.\n', 'utf8');

    const result = await runValidationCommand(
      "Test-Path .\\SANITY_CHECK.md; $text = (Get-Content -Raw .\\SANITY_CHECK.md).Trim(); (($text -split '(?<=[.!?])\\s+').Where({ $_.Trim().Length -gt 0 })).Count",
      cwd
    );

    expect(result.passed).toBe(true);
    expect(result.stdout).toContain('2');
  });

  it.runIf(process.platform === 'win32')('runs planned PowerShell validation checks without falling back to cmd.exe', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-checks-'));
    await writeFile(join(cwd, 'SANITY_CHECK.md'), 'ForgeMind validates tasks.\nIt should pass build checks.\n', 'utf8');

    const result = await runValidationChecks(
      [
        {
          kind: 'command',
          command: "Test-Path .\\SANITY_CHECK.md; $text = (Get-Content -Raw .\\SANITY_CHECK.md).Trim(); (($text -split '(?<=[.!?])\\s+').Where({ $_.Trim().Length -gt 0 })).Count",
          criterion: 'Soubor existuje a ma dve vety.',
          rationale: 'Regression test for Windows validation shell selection.'
        }
      ],
      cwd
    );

    expect(result.passed).toBe(true);
    expect(result.stdout).toContain('[command]');
    expect(result.stdout).toContain('2');
  });
});
