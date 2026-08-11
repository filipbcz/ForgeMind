import { randomUUID } from 'node:crypto';

export type IsoDateString = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function nowIso(): IsoDateString {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${String(value)}`);
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WORKSPACE_ENV_PREFIX = 'FORGEMIND_WORKSPACE_ENV_';
const blockedWorkspaceEnvironmentNames = new Set([
  'DATABASE_URL',
  'DIRECT_URL',
  'SHADOW_DATABASE_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY'
]);

export function createWorkspaceEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const workspaceOverrides: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalizedName = name.toUpperCase();
    if (normalizedName.startsWith(WORKSPACE_ENV_PREFIX)) {
      const targetName = normalizedName.slice(WORKSPACE_ENV_PREFIX.length);
      if (/^[A-Z_][A-Z0-9_]*$/.test(targetName)) workspaceOverrides[targetName] = value;
      continue;
    }
    if (
      normalizedName.startsWith('FORGEMIND_')
      || blockedWorkspaceEnvironmentNames.has(normalizedName)
      || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE_URL|REDIS_URL|WEBHOOK)(?:_|$)/.test(normalizedName)
    ) {
      continue;
    }
    environment[name] = value;
  }
  return { ...environment, ...workspaceOverrides };
}
