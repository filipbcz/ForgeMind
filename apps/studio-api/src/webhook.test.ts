import { describe, expect, it } from 'vitest';
import { signGitHubWebhookPayload, verifyGitHubWebhookSignature } from './webhook.js';

describe('GitHub webhook signature verification', () => {
  it('accepts a valid sha256 signature', () => {
    const payload = JSON.stringify({ action: 'opened' });
    const secret = 'test-secret';
    const signature = signGitHubWebhookPayload(payload, secret);

    expect(verifyGitHubWebhookSignature({ payload, secret, signatureHeader: signature })).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(
      verifyGitHubWebhookSignature({
        payload: JSON.stringify({ action: 'opened' }),
        secret: 'test-secret',
        signatureHeader: 'sha256=bad'
      })
    ).toBe(false);
  });
});

