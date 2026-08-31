import { describe, expect, it } from 'vitest';
import { buildRepositoryChatPrompt } from './chat-prompt.js';
import { parseChatResult } from './provider.js';

describe('repository chat contract', () => {
  it('keeps the current user message when a provider session is resumed', () => {
    const prompt = buildRepositoryChatPrompt({
      runId: 'run-1',
      message: 'Oprav chybu v nacitani profilu.',
      conversationContext: 'Older context that should not be resent.',
      repositoryPath: '/workspace',
      repositoryAttached: true,
      mode: 'safe',
      approvedOperations: ['new_dependency'],
      forgeMindContext: 'Current project id: project-1\nPOST /api/projects/project-1/contracts'
    }, true);

    expect(prompt).toContain('Current user message:\nOprav chybu v nacitani profilu.');
    expect(prompt).toContain('Continue the existing chat session');
    expect(prompt).toContain('new_dependency');
    expect(prompt).toContain('forgeMindActions');
    expect(prompt).toContain('/api/projects/project-1/contracts');
    expect(prompt).not.toContain('Older context that should not be resent.');
  });

  it('prevents file and command work without an attached repository', () => {
    const prompt = buildRepositoryChatPrompt({
      runId: 'run-2',
      message: 'Vysvetli navrh.',
      conversationContext: 'No project context.',
      repositoryAttached: false,
      mode: 'full_auto'
    });

    expect(prompt).toContain('No repository is attached');
    expect(prompt).toContain('Do not create or modify files');
  });

  it('normalizes validation checks and rejects malformed file updates', () => {
    const result = parseChatResult(JSON.stringify({
      response: 'Hotovo.',
      changedFiles: ['src/index.ts'],
      requestedApprovals: [],
      validationChecks: [{ kind: 'command', command: 'npm test', category: 'build' }],
      fileUpdates: [{ path: 'src/index.ts', content: 'export {};' }],
      forgeMindActions: [{ method: 'POST', path: '/api/projects/project-1/contracts', bodyJson: '{}', rationale: 'Persist contract.' }]
    }), 'chat test');

    expect(result.validationChecks).toEqual([
      expect.objectContaining({ kind: 'command', command: 'npm test', category: 'build' })
    ]);
    expect(result.forgeMindActions).toHaveLength(1);
    expect(() => parseChatResult(JSON.stringify({
      response: 'Bad update.',
      changedFiles: [],
      requestedApprovals: [],
      validationChecks: [],
      fileUpdates: [{ path: '../outside.ts' }]
    }), 'chat test')).toThrow('fileUpdates');
  });
});
