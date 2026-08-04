import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createApp } from './server.js';

await loadLocalEnvironmentDefaults();

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';

const app = await createApp();

try {
  await app.listen({ port, host });
  app.log.info({ port, host }, 'ForgeMind Studio API listening');
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

async function loadLocalEnvironmentDefaults() {
  const root = await resolveWorkspaceRoot();
  const configuredEnvFile = process.env.FORGEMIND_ENV_FILE?.trim();
  const files = [
    configuredEnvFile,
    join(root, '.env'),
    join(root, 'infra', 'deploy', 'server.env')
  ].filter((value): value is string => Boolean(value));

  for (const filePath of files) {
    await loadEnvFile(filePath);
  }
}

async function loadEnvFile(path: string) {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return;
  }

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

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

