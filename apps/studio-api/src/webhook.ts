import { createHmac, timingSafeEqual } from 'node:crypto';

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

