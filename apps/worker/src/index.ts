import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { disconnectPrisma } from '@forgemind/db';
import { runWorkerDaemon } from './daemon.js';
import { runDatabaseWorkerOnce } from './db-worker.js';

await loadLocalEnvironmentDefaults();
await loadLocalDatabaseUrl();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the worker runtime.');
}

try {
  const result = process.env.FORGEMIND_WORKER_MODE === 'daemon'
    ? await runWorkerDaemon({
        pollDelayMs: Number(process.env.FORGEMIND_WORKER_POLL_MS ?? 2500),
        stopWhenIdle: process.env.FORGEMIND_WORKER_STOP_WHEN_IDLE === 'true'
      })
    : await runDatabaseWorkerOnce();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await disconnectPrisma();
}

async function loadLocalDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return;
  }

  const root = await resolveWorkspaceRoot();
  for (const fileName of ['.env', 'infra/deploy/server.env', '.env.example', 'infra/deploy/server.env.example']) {
    const value = await readEnvValue(join(root, fileName), 'DATABASE_URL');
    if (value) {
      process.env.DATABASE_URL = value;
      return;
    }
  }
}

async function loadLocalEnvironmentDefaults() {
  const root = await resolveWorkspaceRoot();
  for (const fileName of ['.env', 'infra/deploy/server.env']) {
    await loadEnvFile(join(root, fileName));
  }
}

async function loadEnvFile(path: string) {
  try {
    const content = await readFile(path, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const separator = line.indexOf('=');
      if (separator <= 0) {
        continue;
      }

      const key = line.slice(0, separator).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = stripEnvQuotes(line.slice(separator + 1).trim());
    }
  } catch {
    // Ignore missing local env files.
  }
}

async function resolveWorkspaceRoot(): Promise<string> {
  let current = resolve(process.cwd());

  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as { workspaces?: unknown };
      if (Array.isArray(packageJson.workspaces) || typeof packageJson.workspaces === 'object') {
        return current;
      }
    } catch {
      // Keep walking up until the filesystem root.
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(process.cwd());
    }
    current = parent;
  }
}

async function readEnvValue(path: string, key: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^${key}=(.*)$`));
      if (!match) {
        continue;
      }
      return stripEnvQuotes(match[1]?.trim() ?? '');
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
