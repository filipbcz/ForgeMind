import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function resolveRuntimeEnvVar(key: string): string | undefined {
  const current = process.env[key];
  if (current && current.trim() !== '') {
    return current;
  }

  for (const path of listCandidateEnvFiles()) {
    const value = readEnvValue(path, key);
    if (value && value.trim() !== '') {
      process.env[key] = value;
      return value;
    }
  }

  return undefined;
}

function listCandidateEnvFiles(): string[] {
  const configured = process.env.FORGEMIND_ENV_FILE?.trim();
  const cwd = resolve(process.cwd());
  const root = resolveWorkspaceRoot(cwd);

  const candidates = [
    configured,
    join(cwd, '.env'),
    join(cwd, 'infra', 'deploy', 'server.env'),
    join(root, '.env'),
    join(root, 'infra', 'deploy', 'server.env'),
    '/opt/forgemind/shared/server.env'
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

function resolveWorkspaceRoot(start: string): string {
  let current = start;

  while (true) {
    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const content = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(content.workspaces) || typeof content.workspaces === 'object') {
          return current;
        }
      } catch {
        // Continue walking up to filesystem root.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
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

    const candidateKey = line.slice(0, separator).trim();
    if (candidateKey !== key) {
      continue;
    }

    const value = stripEnvQuotes(line.slice(separator + 1).trim());
    return value;
  }

  return undefined;
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
