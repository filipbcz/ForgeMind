import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface PendingCodexLogin {
  loginId: string;
  codexHome: string;
  authFlow: 'browser';
  startedAt: string;
  loginUrl?: string;
  output: string;
  errorOutput: string;
  exitCode?: number | null;
  completedAt?: string;
}

export interface CodexOAuthStatus {
  loggedIn: boolean;
  authMode: 'chatgpt' | 'api_key' | 'unknown' | null;
  accountSummary: string | null;
  codexHome: string;
  rawOutput: string;
}

const pendingLogins = new Map<string, PendingCodexLogin>();

export function resolveCodexHome(): string {
  if (process.env.FORGEMIND_CODEX_HOME?.trim()) {
    return resolve(process.env.FORGEMIND_CODEX_HOME);
  }

  return join(findWorkspaceRoot(), '.forgemind', 'codex');
}

export async function startCodexOAuthBrowserLogin(): Promise<PendingCodexLogin> {
  const codexHome = resolveCodexHome();
  await ensureCodexHome(codexHome);

  const loginId = randomUUID();
  const child = spawn(resolveCodexBinary(), ['login'], {
    cwd: codexHome,
    env: {
      ...process.env,
      CODEX_HOME: codexHome
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  return new Promise((resolveStart, rejectStart) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const startedAt = new Date().toISOString();
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolvePending();
      }
    }, 2_000);

    const resolvePending = (exitCode: number | null = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const output = stripAnsi(stdout);
      const errorOutput = stripAnsi(stderr);
      const pending: PendingCodexLogin = {
        loginId,
        codexHome,
        authFlow: 'browser',
        startedAt,
        loginUrl: extractFirstUrl(`${output}\n${errorOutput}`),
        output,
        errorOutput,
        exitCode,
        completedAt: exitCode === null ? undefined : new Date().toISOString()
      };
      pendingLogins.set(loginId, pending);
      resolveStart(pending);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      if (!resolved) {
        rejectStart(error);
        return;
      }

      const pending = pendingLogins.get(loginId);
      if (pending) {
        pending.errorOutput = `${pending.errorOutput}\n${error.message}`.trim();
        pending.exitCode = 1;
        pending.completedAt = new Date().toISOString();
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const pending = pendingLogins.get(loginId);
      if (pending) {
        pending.output = stripAnsi(stdout);
        pending.errorOutput = stripAnsi(stderr);
        pending.exitCode = code;
        pending.completedAt = new Date().toISOString();
      }

      if (!resolved) {
        if (code === 0) {
          resolvePending(code);
          return;
        }

        rejectStart(new Error(stripAnsi(stderr || stdout) || `Codex OAuth login exited with code ${code}.`));
      }
    });
  });
}

export async function readCodexOAuthStatus(codexHome = resolveCodexHome()): Promise<CodexOAuthStatus> {
  await ensureCodexHome(codexHome);
  try {
    const { stdout, stderr } = await execFileAsync(resolveCodexBinary(), ['login', 'status'], {
      cwd: codexHome,
      env: {
        ...process.env,
        CODEX_HOME: codexHome
      },
      timeout: 15_000,
      windowsHide: true
    });
    const rawOutput = stripAnsi(`${stdout}${stderr ? `\n${stderr}` : ''}`).trim();
    return {
      loggedIn: /Logged in using ChatGPT/i.test(rawOutput),
      authMode: /ChatGPT/i.test(rawOutput) ? 'chatgpt' : /API key/i.test(rawOutput) ? 'api_key' : 'unknown',
      accountSummary: rawOutput || null,
      codexHome,
      rawOutput
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      loggedIn: false,
      authMode: null,
      accountSummary: null,
      codexHome,
      rawOutput: stripAnsi(message)
    };
  }
}

export async function completeCodexOAuthBrowserLogin(loginId: string) {
  const pending = pendingLogins.get(loginId);
  if (!pending) {
    throw new Error('Codex OAuth login was not found or has expired.');
  }

  const status = await readCodexOAuthStatus(pending.codexHome);
  const completed = status.loggedIn || (pending.exitCode !== null && pending.exitCode !== undefined);
  if (status.loggedIn) {
    pendingLogins.delete(loginId);
  }

  return {
    ...pending,
    completed,
    success: completed && status.loggedIn,
    status
  };
}

async function ensureCodexHome(codexHome: string) {
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, 'config.toml');
  if (!existsSync(configPath)) {
    await writeFile(configPath, 'cli_auth_credentials_store = "file"\n', 'utf8');
  }
}

function resolveCodexBinary(): string {
  const configured = process.env.FORGEMIND_CODEX_CLI_PATH?.trim();
  if (configured) {
    return configured;
  }

  const discovered = resolveCodexBinaryFromSystem();
  if (discovered) {
    return discovered;
  }

  return 'codex';
}

function findWorkspaceRoot(): string {
  let current = process.cwd();
  while (true) {
    const packageJson = join(current, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string };
        if (parsed.name === 'forgemind') {
          return current;
        }
      } catch {
        // Keep walking; a malformed package.json should not make auth storage ambiguous.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

function extractFirstUrl(value: string): string | undefined {
  return value.match(/https?:\/\/[^\s)]+/)?.[0];
}

function resolveCodexBinaryFromSystem(): string | undefined {
  const fromWhere = resolveCodexBinaryWithWhere();
  if (fromWhere) {
    return fromWhere;
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  const userProfile = process.env.USERPROFILE?.trim();
  const candidates = [
    localAppData
      ? join(localAppData, 'Programs', 'OpenAI', 'Codex', 'codex.exe')
      : undefined,
    userProfile
      ? join(userProfile, '.vscode', 'extensions')
      : undefined
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (candidate.endsWith('extensions')) {
      const resolved = resolveCodexBinaryFromVsCodeExtensions(candidate);
      if (resolved) {
        return resolved;
      }
      continue;
    }

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function resolveCodexBinaryWithWhere(): string | undefined {
  try {
    const stdout = execFileSync('where.exe', ['codex'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const match = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && existsSync(line));
    return match || undefined;
  } catch {
    return undefined;
  }
}

function resolveCodexBinaryFromVsCodeExtensions(extensionsRoot: string): string | undefined {
  try {
    const entries = readdirSync(extensionsRoot, { withFileTypes: true });
    const matches = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => join(extensionsRoot, entry.name, 'bin', 'windows-x86_64', 'codex.exe'))
      .filter((candidate) => existsSync(candidate))
      .sort();
    return matches.at(-1);
  } catch {
    return undefined;
  }
}
