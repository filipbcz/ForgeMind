import type { JsonValue } from '@forgemind/shared';

export const SECRET_REDACTION = '[secret-redacted]';

const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|secret|token|private[_-]?key)(?:$|[_-])/i;

const SECRET_PATTERNS: RegExp[] = [
  /https?:\/\/([^:@/\s]+):([^@/\s]+)@/gi,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|rk|sess)-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgho_[A-Za-z0-9_]{20,}\b/g,
  /\bghu_[A-Za-z0-9_]{20,}\b/g,
  /\bghs_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\b(?:OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|COPILOT_GITHUB_TOKEN|DATABASE_URL|SHADOW_DATABASE_URL|DIRECT_URL)=([^\s"'`]+)/g,
  /\b([A-Za-z][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token))\s*[:=]\s*(['"]?)([^'",\s}]{8,})\2/gi
];

export function redactSecrets<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

export function redactError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') {
    return key && isSensitiveKey(key) ? SECRET_REDACTION : redactSecretString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, JsonValue> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    redacted[entryKey] = (
      isSensitiveKey(entryKey)
        ? SECRET_REDACTION
        : redactValue(entryValue, entryKey)
    ) as JsonValue;
  }
  return redacted;
}

function redactSecretString(value: string): string {
  return SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, (match, first) => {
    if (match.startsWith('http://') || match.startsWith('https://')) {
      return match.replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/, `://$1:${SECRET_REDACTION}@`);
    }
    if (typeof first === 'string' && /^[A-Za-z][A-Za-z0-9_-]/.test(first) && /[:=]/.test(match)) {
      return match.replace(/([:=]\s*['"]?)([^'",\s}]{8,})/, `$1${SECRET_REDACTION}`);
    }
    if (/=/.test(match) && /^[A-Z_]+=/.test(match)) {
      return match.replace(/=.*/, `=${SECRET_REDACTION}`);
    }
    return SECRET_REDACTION;
  }), value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
