import { describe, expect, it } from 'vitest';
import { parseGitHubWebhookPayload, projectGitHubWebhookEvent, signGitHubWebhookPayload, verifyGitHubWebhookSignature } from './webhook.js';

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

  it('rejects when signature header is missing', () => {
    expect(
      verifyGitHubWebhookSignature({
        payload: JSON.stringify({ action: 'opened' }),
        secret: 'test-secret',
        signatureHeader: undefined
      })
    ).toBe(false);
  });

  it('projects supported webhook events to structured payload', () => {
    const payload = parseGitHubWebhookPayload(
      JSON.stringify({
        action: 'opened',
        repository: { id: 1, full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' },
        issue: { number: 42, title: 'Demo issue', html_url: 'https://github.com/owner/repo/issues/42' }
      })
    );

    const projection = projectGitHubWebhookEvent('issues', payload, 'delivery_1');
    expect(projection.eventType).toBe('github_webhook_issues');
    expect(projection.payload).toMatchObject({
      event: 'issues',
      delivery: 'delivery_1',
      action: 'opened',
      repository: { fullName: 'owner/repo' },
      issue: { number: 42 }
    });
  });

  it('marks unknown events as ignored', () => {
    const projection = projectGitHubWebhookEvent('deployment', { action: 'created' }, 'delivery_2');
    expect(projection.eventType).toBe('github_webhook_ignored');
    expect(projection.payload).toMatchObject({
      event: 'deployment',
      delivery: 'delivery_2'
    });
  });
});

