import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCodexAuthorizationUrl, selectCodexBinaryFromWhereOutput } from './codex-oauth.js';

describe('Codex OAuth', () => {
  it('ignores the local callback listener and returns the external authorization URL', () => {
    expect(extractCodexAuthorizationUrl([
      'Listening on http://localhost:1455/auth/callback',
      'Open https://auth.openai.com/oauth/authorize?state=test in your browser'
    ].join('\n'))).toBe('https://auth.openai.com/oauth/authorize?state=test');
  });

  it('waits when only the callback URL has been printed', () => {
    expect(extractCodexAuthorizationUrl('Listening on http://127.0.0.1:1455/auth/callback')).toBeUndefined();
  });

  it('prefers the executable when where.exe also returns an extensionless launcher', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgemind-codex-'));
    const launcher = join(directory, 'codex');
    const executable = join(directory, 'codex.exe');
    await Promise.all([writeFile(launcher, ''), writeFile(executable, '')]);

    expect(selectCodexBinaryFromWhereOutput(`${launcher}\r\n${executable}\r\n`)).toBe(executable);
  });
});
