import { describe, expect, it } from 'vitest';
import { SECRET_REDACTION, redactError, redactSecrets } from './redaction.js';

describe('secret redaction', () => {
  it('redacts representative credential patterns in strings', () => {
    const redacted = redactSecrets([
      'Authorization: Bearer sk-test_1234567890abcdef',
      'OPENAI_API_KEY=sk-live_1234567890abcdef',
      'https://x-access-token:ghp_1234567890abcdefghijklmnop@github.com/acme/repo.git',
      'github_pat_1234567890abcdefghijklmnopqr'
    ]);

    expect(JSON.stringify(redacted)).not.toContain('sk-test_1234567890abcdef');
    expect(JSON.stringify(redacted)).not.toContain('sk-live_1234567890abcdef');
    expect(JSON.stringify(redacted)).not.toContain('ghp_1234567890abcdefghijklmnop');
    expect(JSON.stringify(redacted)).not.toContain('github_pat_1234567890abcdefghijklmnopqr');
    expect(JSON.stringify(redacted)).toContain(SECRET_REDACTION);
  });

  it('redacts sensitive object values recursively', () => {
    const redacted = redactSecrets({
      provider: 'openai',
      apiKey: 'sk-recursive_1234567890abcdef',
      nested: {
        access_token: 'github_pat_1234567890abcdefghijklmnopqr'
      }
    });

    expect(redacted).toEqual({
      provider: 'openai',
      apiKey: SECRET_REDACTION,
      nested: {
        access_token: SECRET_REDACTION
      }
    });
  });

  it('redacts application error messages', () => {
    const message = redactError(new Error('Provider failed with Authorization: Bearer sk-error_1234567890abcdef'));

    expect(message).toContain(SECRET_REDACTION);
    expect(message).not.toContain('sk-error_1234567890abcdef');
  });

  it('preserves non-plain objects when redacting JSON-like payloads', () => {
    const value = new Date('2026-08-23T00:00:00.000Z');

    expect(redactSecrets(value)).toBe(value);
  });
});
