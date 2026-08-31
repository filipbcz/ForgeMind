import { describe, expect, it } from 'vitest';
import { buildChatInterimResults } from './chat-activity.js';
import type { AuditEventApi } from './types.js';

function event(id: string, eventType: string, payload: unknown): AuditEventApi {
  return {
    id, eventType, payload, actorType: 'agent', chatRunId: 'run_1',
    createdAt: `2026-08-31T06:06:0${id}.000Z`
  };
}

describe('chat interim results', () => {
  it('shows an interim response without exposing the raw provider envelope or prompt', () => {
    const items = buildChatInterimResults([
      event('1', 'chat_provider_activity', { detail: 'Prompt sent to Codex:\nsecret internal prompt', attempt: 1 }),
      event('2', 'chat_provider_activity', {
        title: 'AI pracuje', attempt: 1,
        detail: JSON.stringify({ response: 'Kontroluji logy a historii repozitáře.', changedFiles: [], forgeMindActions: [] })
      })
    ], 'run_1');

    expect(items).toEqual([
      expect.objectContaining({ content: 'Kontroluji logy a historii repozitáře.' })
    ]);
    expect(JSON.stringify(items)).not.toContain('secret internal prompt');
    expect(JSON.stringify(items)).not.toContain('changedFiles');
  });

  it('keeps only unique interim results and supplements them from the persisted run result', () => {
    const response = JSON.stringify({ response: 'Našel jsem problém.' });
    const items = buildChatInterimResults([
      event('1', 'chat_provider_activity', { detail: response, attempt: 1 }),
      event('2', 'chat_provider_activity', { detail: response, attempt: 1 }),
      event('3', 'chat_forgemind_action_started', { method: 'GET', path: '/api/tasks/task_1/diagnostics' }),
      event('4', 'chat_forgemind_action_failed', { method: 'GET', path: '/api/tasks/task_1/diagnostics', status: 404 })
    ], 'run_1', ['Našel jsem problém.', 'Ověřuji přesnou příčinu.']);

    expect(items.map((item) => item.content)).toEqual(['Našel jsem problém.', 'Ověřuji přesnou příčinu.']);
  });
});
