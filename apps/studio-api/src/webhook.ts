import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '@forgemind/shared';

const SIGNATURE_PREFIX = 'sha256=';

export function signGitHubWebhookPayload(payload: Buffer | string, secret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export function verifyGitHubWebhookSignature(input: {
  payload: Buffer | string;
  signatureHeader: string | string[] | undefined;
  secret: string;
}): boolean {
  const signature = Array.isArray(input.signatureHeader) ? input.signatureHeader[0] : input.signatureHeader;
  if (!signature?.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const expected = signGitHubWebhookPayload(input.payload, input.secret);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(signature, 'utf8');

  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

const repositorySchema = z
  .object({
    id: z.number().optional(),
    full_name: z.string().optional(),
    html_url: z.string().optional()
  })
  .optional();

const issueSchema = z
  .object({
    number: z.number(),
    html_url: z.string().optional(),
    title: z.string().optional()
  })
  .optional();

const pullRequestSchema = z
  .object({
    number: z.number().optional(),
    html_url: z.string().optional(),
    title: z.string().optional(),
    state: z.string().optional()
  })
  .optional();

const checkRunSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().optional()
  })
  .optional();

const checkSuiteSchema = z
  .object({
    id: z.number().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    head_branch: z.string().optional()
  })
  .optional();

const webhookPayloadSchema = z.object({
  action: z.string().optional(),
  repository: repositorySchema,
  issue: issueSchema,
  pull_request: pullRequestSchema,
  check_run: checkRunSchema,
  check_suite: checkSuiteSchema
});

export interface GitHubWebhookProjection {
  eventType: string;
  payload: JsonValue;
}

export function parseGitHubWebhookPayload(rawPayload: Buffer | string): unknown {
  const text = Buffer.isBuffer(rawPayload) ? rawPayload.toString('utf8') : rawPayload;
  return JSON.parse(text);
}

export function projectGitHubWebhookEvent(event: string, payload: unknown, delivery: string): GitHubWebhookProjection {
  const parsed = webhookPayloadSchema.safeParse(payload);
  const normalized = parsed.success ? parsed.data : {};

  const eventType =
    event === 'issues' || event === 'issue_comment' || event === 'pull_request' || event === 'check_run' || event === 'check_suite'
      ? `github_webhook_${event}`
      : 'github_webhook_ignored';

  return {
    eventType,
    payload: {
      event,
      delivery,
      action: normalized.action ?? null,
      repository: normalized.repository
        ? {
            id: normalized.repository.id ?? null,
            fullName: normalized.repository.full_name ?? null,
            url: normalized.repository.html_url ?? null
          }
        : null,
      issue: normalized.issue
        ? {
            number: normalized.issue.number,
            title: normalized.issue.title ?? null,
            url: normalized.issue.html_url ?? null
          }
        : null,
      pullRequest: normalized.pull_request
        ? {
            number: normalized.pull_request.number ?? null,
            title: normalized.pull_request.title ?? null,
            status: normalized.pull_request.state ?? null,
            url: normalized.pull_request.html_url ?? null
          }
        : null,
      checkRun: normalized.check_run
        ? {
            id: normalized.check_run.id ?? null,
            name: normalized.check_run.name ?? null,
            status: normalized.check_run.status ?? null,
            conclusion: normalized.check_run.conclusion ?? null,
            url: normalized.check_run.html_url ?? null
          }
        : null,
      checkSuite: normalized.check_suite
        ? {
            id: normalized.check_suite.id ?? null,
            status: normalized.check_suite.status ?? null,
            conclusion: normalized.check_suite.conclusion ?? null,
            headBranch: normalized.check_suite.head_branch ?? null
          }
        : null
    }
  };
}

