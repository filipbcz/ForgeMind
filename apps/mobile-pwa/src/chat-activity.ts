import type { AuditEventApi } from './types.js';

export interface ChatInterimResult {
  id: string;
  content: string;
}

export function buildChatInterimResults(
  events: AuditEventApi[],
  runId: string,
  persisted: string[] = []
): ChatInterimResult[] {
  const candidates = events
    .filter((event) => event.chatRunId === runId && event.eventType === 'chat_provider_activity')
    .flatMap((event) => {
      const payload = objectPayload(event.payload);
      const detail = stringValue(payload.detail);
      const content = payload.kind === 'interim_result' ? detail : parseStructuredResponse(detail);
      return content ? [{ id: event.id, content }] : [];
    });
  persisted.forEach((content, index) => {
    if (content.trim()) candidates.push({ id: `persisted-${runId}-${index}`, content: content.trim() });
  });

  const unique: ChatInterimResult[] = [];
  const contents = new Set<string>();
  for (const candidate of candidates) {
    if (contents.has(candidate.content)) continue;
    contents.add(candidate.content);
    unique.push(candidate);
  }
  return unique;
}

function parseStructuredResponse(value: string | undefined): string | undefined {
  if (!value?.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(value) as { response?: unknown };
    return typeof parsed.response === 'string' && parsed.response.trim() ? parsed.response.trim() : undefined;
  } catch {
    return undefined;
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
