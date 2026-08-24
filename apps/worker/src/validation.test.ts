import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertAllowedValidationCommand,
  collectPassedValidationCheckResults,
  createValidationEnvironment,
  formatValidationFailure,
  normalizeValidationCommandForEnvironment,
  runValidationCommand,
  runValidationChecks
} from './validation.js';

describe('validation runner', () => {
  it('preserves compiler diagnostics from stdout when stderr only contains an npm summary', () => {
    const context = formatValidationFailure({
      command: 'npm run build',
      exitCode: 2,
      stdout: 'build output\nsrc/report.ts(4,2): error TS2345: Invalid aggregate input.',
      stderr: 'npm error Lifecycle script `build` failed'
    });

    expect(context).toContain('error TS2345');
    expect(context).toContain('npm error Lifecycle script');
    expect(context).toContain('Command: npm run build');
    expect(context).toContain('Exit code: 2');
  });

  it('installs development dependencies for npm ci validation', () => {
    expect(normalizeValidationCommandForEnvironment('npm ci')).toBe('npm ci --include=dev');
    expect(normalizeValidationCommandForEnvironment('npm ci && npm test')).toBe('npm ci --include=dev && npm test');
    expect(normalizeValidationCommandForEnvironment('npm ci --include=dev')).toBe('npm ci --include=dev');
    expect(normalizeValidationCommandForEnvironment('npm ci --omit=dev')).toBe('npm ci --omit=dev');
    expect(normalizeValidationCommandForEnvironment('npm ci --production')).toBe('npm ci --production');
    expect(normalizeValidationCommandForEnvironment('node -e "console.log(\'npm ci\')"')).toBe('node -e "console.log(\'npm ci\')"');
  });

  it('executes plain command checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-cmd-'));

    const result = await runValidationCommand('node --version', cwd);

    expect(result.passed).toBe(true);
    expect(result.stdout).toContain('v');
  });

  it('rejects validation command paths that traverse workspace symlinks outside the workspace', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'forgemind-validation-workspace-'));
    const outsidePath = await mkdtemp(join(tmpdir(), 'forgemind-validation-outside-'));
    await writeFile(join(outsidePath, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(outsidePath, join(workspacePath, 'outside-link'), 'dir');

    const result = await runValidationChecks(
      [{ kind: 'command', command: 'cat outside-link/secret.txt' }],
      workspacePath,
      undefined,
      new Map(),
      undefined,
      undefined,
      undefined,
      { workspacePath, forbiddenPaths: [] }
    );

    expect(result.passed).toBe(false);
    expect(result.stderr).toContain('filesystem isolation policy');
    expect(result.stderr).toContain('outside_workspace');
  });

  it('rejects validation command access to the Docker socket', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'forgemind-validation-docker-'));

    const result = await runValidationChecks(
      [{ kind: 'command', command: 'cat /var/run/docker.sock' }],
      workspacePath,
      undefined,
      new Map(),
      undefined,
      undefined,
      undefined,
      { workspacePath, forbiddenPaths: [] }
    );

    expect(result.passed).toBe(false);
    expect(result.stderr).toContain('filesystem isolation policy');
    expect(result.stderr).toContain('/var/run/docker.sock');
  });

  it('rejects validation command access to configured secret paths', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'forgemind-validation-secret-'));
    await mkdir(join(workspacePath, '.secrets'));
    await writeFile(join(workspacePath, '.secrets', 'token'), 'secret\n', 'utf8');
    await writeFile(join(workspacePath, '.env'), 'TOKEN=secret\n', 'utf8');

    const result = await runValidationChecks(
      [
        { kind: 'command', command: 'cat .secrets/token' },
        { kind: 'command', command: 'cat .env' }
      ],
      workspacePath,
      undefined,
      new Map(),
      undefined,
      undefined,
      undefined,
      { workspacePath, forbiddenPaths: ['.secrets'] }
    );

    expect(result.passed).toBe(false);
    expect(result.stderr).toContain('filesystem isolation policy');
    expect(result.stderr).toContain('forbidden_path');

    const bareSecretsResult = await runValidationChecks(
      [{ kind: 'command', command: 'ls .secrets' }],
      workspacePath,
      undefined,
      new Map(),
      undefined,
      undefined,
      undefined,
      { workspacePath, forbiddenPaths: ['.secrets'] }
    );

    expect(bareSecretsResult.passed).toBe(false);
    expect(bareSecretsResult.stderr).toContain('filesystem isolation policy');
    expect(bareSecretsResult.stderr).toContain('forbidden_path');

    const dotEnvResult = await runValidationChecks(
      [{ kind: 'command', command: 'cat .env' }],
      workspacePath,
      undefined,
      new Map(),
      undefined,
      undefined,
      undefined,
      { workspacePath, forbiddenPaths: ['.env'] }
    );

    expect(dotEnvResult.passed).toBe(false);
    expect(dotEnvResult.stderr).toContain('filesystem isolation policy');
    expect(dotEnvResult.stderr).toContain('forbidden_path');
  });

  it('isolates validation from control-plane secrets and permits explicit workspace overrides', async () => {
    const environment = createValidationEnvironment({
      PATH: 'test-path',
      DATABASE_URL: 'postgresql://control-plane',
      GITHUB_TOKEN: 'github-secret',
      FORGEMIND_ENCRYPTION_KEY: 'encryption-secret',
      FORGEMIND_WORKSPACE_ENV_DATABASE_URL: 'postgresql://workspace',
      FORGEMIND_WORKSPACE_ENV_PUBLIC_MODE: 'qualification'
    });

    expect(environment).toEqual({
      PATH: 'test-path',
      DATABASE_URL: 'postgresql://workspace',
      PUBLIC_MODE: 'qualification'
    });
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('FORGEMIND_ENCRYPTION_KEY');
  });

  it('uses a persistent workspace virtual environment for subsequent validation commands', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'forgemind-validation-venv-'));
    const binPath = join(workspacePath, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    await mkdir(binPath, { recursive: true });

    const environment = createValidationEnvironment({ PATH: 'system-path' }, workspacePath);

    expect(environment.VIRTUAL_ENV).toBe(join(workspacePath, '.venv'));
    expect(environment.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(binPath);
  });

  it('treats stderr warnings as diagnostic output when the command exits successfully', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-warning-'));
    const command = `node -e "process.stderr.write('compiler warning\\n')"`;

    const commandResult = await runValidationCommand(command, cwd);
    const suiteResult = await runValidationChecks([{ kind: 'command', command }], cwd);

    expect(commandResult).toMatchObject({ exitCode: 0, passed: true });
    expect(commandResult.stderr).toContain('compiler warning');
    expect(suiteResult).toMatchObject({ exitCode: 0, passed: true, failingCommand: undefined });
    expect(suiteResult.stdout).toContain('compiler warning');
    expect(suiteResult.stderr).toBe('');
  });

  it('skips validation when there are no executable checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-empty-'));

    const result = await runValidationChecks([], cwd);

    expect(result).toMatchObject({
      command: 'no-executable-checks',
      exitCode: 0,
      passed: true,
      executedCheckCount: 0,
      reusedCheckCount: 0
    });
    expect(result.stdout).toContain('validation was skipped');
  });

  it('defers checks that require unavailable worker capabilities while running portable checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-capabilities-'));
    const activities: string[] = [];
    const result = await runValidationChecks([
      {
        kind: 'command',
        command: 'UnrealEditor.exe Flying.uproject -run=Automation',
        criterion: 'Win64 Unreal shell starts.',
        requiredCapabilities: ['windows', 'unreal-engine-5.8']
      },
      { kind: 'command', command: 'node --version', criterion: 'Portable tooling is available.' }
    ], cwd, (activity) => {
      activities.push(activity.state);
    }, new Map(), undefined, undefined, new Set(['linux']));

    expect(result.passed).toBe(true);
    expect(result.executedCheckCount).toBe(1);
    expect(result.deferredChecks).toEqual([
      expect.objectContaining({
        criterion: 'Win64 Unreal shell starts.',
        requiredCapabilities: ['windows', 'unreal-engine-5.8'],
        missingCapabilities: ['windows', 'unreal-engine-5.8']
      })
    ]);
    expect(activities).toContain('deferred');
    expect(result.stdout).toContain('[missing-capabilities] windows, unreal-engine-5.8');
  });

  it('executes quoted inline JavaScript containing arrow functions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-inline-js-'));
    const command = `node --input-type=module -e "const items = [{ id: 1 }]; if (!items.some((item) => item.id === 1)) process.exit(1);"`;

    expect(() => assertAllowedValidationCommand(command)).not.toThrow();
    await expect(runValidationCommand(command, cwd)).resolves.toMatchObject({ passed: true, exitCode: 0 });
  });

  it('streams validation output before reporting command completion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-stream-'));
    const activities: Array<{ state: string; message?: string }> = [];

    const result = await runValidationChecks(
      [{
        kind: 'command',
        command: `node -e "console.log('first'); setTimeout(() => console.log('second'), 500)"`,
        criterion: 'Both progress messages are emitted.',
        rationale: 'Verifies live validation output.'
      }],
      cwd,
      vi.fn(async (activity) => {
        activities.push({ state: activity.state, message: activity.message });
      })
    );

    expect(result.passed).toBe(true);
    expect(activities[0]?.state).toBe('started');
    expect(activities.some((activity) => activity.state === 'output' && activity.message?.includes('first'))).toBe(true);
    expect(activities.at(-1)?.state).toBe('completed');
  });

  it('reuses passed checks and executes only failed or not-yet-run checks after correction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-resume-'));
    const passedCommand = `node -e "const fs=require('node:fs');const p='passed-count.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1))"`;
    const failedCommand = `node -e "process.stderr.write('sh: 1: missing-tool: not found');process.exit(1)"`;
    const correctedCommand = `node -e "require('node:fs').writeFileSync('corrected.txt','ok')"`;
    const laterCommand = `node -e "require('node:fs').writeFileSync('later.txt','ok')"`;

    const firstResult = await runValidationChecks([
      { kind: 'command', command: passedCommand },
      { kind: 'command', command: failedCommand },
      { kind: 'command', command: laterCommand }
    ], cwd);
    const passedResults = collectPassedValidationCheckResults(firstResult);
    const activities: Array<{ command: string; state: string; reused?: boolean }> = [];

    const correctedResult = await runValidationChecks([
      { kind: 'command', command: passedCommand },
      { kind: 'command', command: correctedCommand },
      { kind: 'command', command: laterCommand }
    ], cwd, async (activity) => {
      activities.push({ command: activity.command, state: activity.state, reused: activity.reused });
    }, passedResults);

    expect(firstResult.passed).toBe(false);
    expect(correctedResult.passed).toBe(true);
    expect(correctedResult.executedCheckCount).toBe(2);
    expect(correctedResult.reusedCheckCount).toBe(1);
    expect(correctedResult.stdout).toContain('Reused successful validation evidence for the unchanged workspace input.');
    expect(correctedResult.stdout).toContain('[command]');
    expect(await readFile(join(cwd, 'passed-count.txt'), 'utf8')).toBe('1');
    expect(await readFile(join(cwd, 'corrected.txt'), 'utf8')).toBe('ok');
    expect(await readFile(join(cwd, 'later.txt'), 'utf8')).toBe('ok');
    expect(activities).toContainEqual(expect.objectContaining({
      command: normalizeValidationCommandForEnvironment(passedCommand),
      state: 'completed',
      reused: true
    }));
    expect(activities).not.toContainEqual(expect.objectContaining({
      command: normalizeValidationCommandForEnvironment(passedCommand),
      state: 'started'
    }));
  });

  it('reuses a checkpoint only for the same workspace input hash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-fingerprint-'));
    const command = `node -e "const fs=require('node:fs');const p='count.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1))"`;
    const first = await runValidationChecks([{ kind: 'command', command }], cwd, undefined, new Map(), 'workspace-a');
    const passed = collectPassedValidationCheckResults(first);

    const resumed = await runValidationChecks([{ kind: 'command', command }], cwd, undefined, passed, 'workspace-a');
    const changed = await runValidationChecks([{ kind: 'command', command }], cwd, undefined, passed, 'workspace-b');

    expect(resumed.reusedCheckCount).toBe(1);
    expect(changed.executedCheckCount).toBe(1);
    expect(await readFile(join(cwd, 'count.txt'), 'utf8')).toBe('2');
  });

  it('does not reuse a legacy unscoped validation result for a changed workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-legacy-checkpoint-'));
    const command = `node -e "require('node:fs').writeFileSync('executed.txt','fresh')"`;
    const legacy = new Map([[
      command,
      {
        command,
        exitCode: 0,
        stdout: 'stale output',
        stderr: '',
        passed: true
      }
    ]]);

    const result = await runValidationChecks(
      [{ kind: 'command', command }],
      cwd,
      undefined,
      legacy,
      'current-workspace-hash'
    );

    expect(result.executedCheckCount).toBe(1);
    expect(result.reusedCheckCount).toBe(0);
    expect(await readFile(join(cwd, 'executed.txt'), 'utf8')).toBe('fresh');
  });

  it('rejects shell output redirection outside quoted arguments', () => {
    expect(() => assertAllowedValidationCommand('node --version > version.txt')).toThrow(
      'Validation command is not allowed'
    );
  });

  it('returns a rejected validation command as a recoverable failed check', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgemind-validation-policy-'));
    const command = 'python3 -m json.tool schema.json >/dev/null';

    const result = await runValidationChecks([{ kind: 'command', command }], cwd);

    expect(result.passed).toBe(false);
    expect(result.failingCommand).toBe(command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`Validation command is not allowed: ${command}`);
  });

  it('rejects mutable operating-system package installation during validation', () => {
    expect(() => assertAllowedValidationCommand('apt-get install -y cmake')).toThrow(
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
