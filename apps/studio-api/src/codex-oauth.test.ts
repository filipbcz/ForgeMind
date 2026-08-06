import { describe, expect, it } from 'vitest';
import { extractCodexAuthorizationUrl } from './codex-oauth.js';

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
});
