import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const CIPHER = 'aes-256-gcm';
const DEFAULT_CREDENTIAL_KEY_FILE = '.forgemind/credential-key';

export async function encryptSecret(value: string): Promise<string> {
  const key = await resolveCredentialKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export async function decryptSecret(value: string): Promise<string> {
  const [ivValue, authTagValue, encryptedValue] = value.split('.');
  if (!ivValue || !authTagValue || !encryptedValue) {
    throw new Error('Stored credential has an invalid encrypted format.');
  }

  const keys = await resolveCredentialReadKeys();
  for (const key of keys) {
    try {
      const decipher = createDecipheriv(CIPHER, key, Buffer.from(ivValue, 'base64url'));
      decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, 'base64url')),
        decipher.final()
      ]);

      return decrypted.toString('utf8');
    } catch {
      // Try the next development key candidate.
    }
  }

  throw new Error('Stored credential cannot be decrypted with the configured credential key.');
}

export function fingerprintSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function resolveCredentialKey(): Promise<Buffer> {
  const envKey = process.env.FORGEMIND_CREDENTIAL_KEY?.trim();
  if (envKey) {
    return createHash('sha256').update(envKey).digest();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('FORGEMIND_CREDENTIAL_KEY is required to persist encrypted credentials in production.');
  }

  const keyFile = process.env.FORGEMIND_CREDENTIAL_KEY_FILE
    ? resolve(process.env.FORGEMIND_CREDENTIAL_KEY_FILE)
    : join(await resolveWorkspaceRoot(), DEFAULT_CREDENTIAL_KEY_FILE);
  try {
    const existing = (await readFile(keyFile, 'utf8')).trim();
    if (existing) {
      return createHash('sha256').update(existing).digest();
    }
  } catch {
    // Local development bootstrap continues below.
  }

  const generated = randomBytes(32).toString('base64url');
  await mkdir(dirname(keyFile), { recursive: true });
  await writeFile(keyFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  return createHash('sha256').update(generated).digest();
}

async function resolveCredentialReadKeys(): Promise<Buffer[]> {
  const primary = await resolveCredentialKey();
  if (process.env.FORGEMIND_CREDENTIAL_KEY?.trim() || process.env.FORGEMIND_CREDENTIAL_KEY_FILE?.trim() || process.env.NODE_ENV === 'production') {
    return [primary];
  }

  const root = await resolveWorkspaceRoot();
  const candidates = [
    join(root, 'apps/studio-api', DEFAULT_CREDENTIAL_KEY_FILE),
    join(root, 'apps/worker', DEFAULT_CREDENTIAL_KEY_FILE)
  ];
  const keys = [primary];

  for (const candidate of candidates) {
    try {
      const existing = (await readFile(candidate, 'utf8')).trim();
      if (existing) {
        const key = createHash('sha256').update(existing).digest();
        if (!keys.some((item) => item.equals(key))) {
          keys.push(key);
        }
      }
    } catch {
      // Legacy development key does not exist.
    }
  }

  return keys;
}

async function resolveWorkspaceRoot(): Promise<string> {
  let current = resolve(process.cwd());

  while (true) {
    const packageJsonPath = join(current, 'package.json');
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { workspaces?: unknown };
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
