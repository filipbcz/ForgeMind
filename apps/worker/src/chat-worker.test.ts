import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeChatResponse, createAuthenticatedCloneGit, presentChatProviderActivity, runNextChatTurn } from './chat-worker.js';

const createdRoots: string[] = [];

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), 'forgemind-chat-test-'));
  createdRoots.push(root);
  return root;
}

function createClaimedRun(mode: 'safe' | 'auto' | 'full_auto' = 'safe') {
  const now = new Date().toISOString();
  return {
    thread: {
      id: 'thread_1', userId: 'user_1', title: 'Chat', status: 'active', mode,
      createdAt: now, updatedAt: now
    },
    run: {
      id: 'run_1', threadId: 'thread_1', status: 'running', prompt: 'Answer the user.',
      attemptCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0,
      stopRequested: false, createdAt: now, updatedAt: now
    },
    messages: [{
      id: 'message_1', threadId: 'thread_1', runId: 'run_1', sequence: 1,
      role: 'user', content: 'Answer the user.', createdAt: now
    }]
  };
}

function createRepository(claimed = createClaimedRun()) {
  return {
    claimNextChatRun: vi.fn(async () => claimed),
    getAIProviderConnectionSecret: vi.fn(async () => ({
      id: 'connection_1', provider: 'codex', authMode: 'codex_oauth', model: 'gpt-5.5'
    })),
    getAIProviderConnectionSecretById: vi.fn(),
    getGitHubConnectionSecret: vi.fn(),
    createAuthSession: vi.fn(async () => ({ tokenHash: 'hash', user: { id: 'user_1' } })),
    revokeAuthSession: vi.fn(async () => true),
    updateChatProviderSession: vi.fn(async () => undefined),
    refreshChatRunHeartbeat: vi.fn(async () => true),
    isChatRunStopRequested: vi.fn(async () => false),
    writeAudit: vi.fn(async () => ({ id: 'audit_1' })),
    completeChatRun: vi.fn(async () => undefined),
    failChatRun: vi.fn(async () => undefined),
    finishCancelledChatRun: vi.fn(async () => undefined),
    updateChatContextSummary: vi.fn(async () => undefined)
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('chat worker', () => {
  it('turns streamed provider envelopes into concise interim activity', () => {
    expect(presentChatProviderActivity('stdout', JSON.stringify({
      response: 'Kontroluji diagnostiku tasku.',
      changedFiles: ['src/example.ts']
    }))).toEqual({
      kind: 'interim_result',
      title: 'Průběžný výsledek AI',
      detail: 'Kontroluji diagnostiku tasku.'
    });
    expect(presentChatProviderActivity('lifecycle', 'Prompt sent to Codex:\ninternal prompt')).toEqual({
      kind: 'lifecycle', title: 'AI převzala zadání', detail: 'Zadání bylo předáno provideru.'
    });
  });

  it('preserves the original answer when validation adds a correction response', () => {
    expect(composeChatResponse(
      'Created the requested contract.',
      ['Validation used an unsupported isolation mode; the contract itself required no correction.']
    )).toBe([
      'Created the requested contract.',
      '---',
      'Validation used an unsupported isolation mode; the contract itself required no correction.'
    ].join('\n\n'));
  });

  it('does not duplicate an unchanged response from a correction attempt', () => {
    expect(composeChatResponse('Complete answer.', ['Complete answer.'])).toBe('Complete answer.');
  });

  it('does not pass inherited editor hooks into authenticated Git operations', async () => {
    const previousEditor = process.env.EDITOR;
    const previousGitEditor = process.env.GIT_EDITOR;
    process.env.EDITOR = 'unsafe-editor';
    process.env.GIT_EDITOR = 'unsafe-git-editor';
    try {
      await expect(createAuthenticatedCloneGit('Authorization: Basic test').raw(['--version']))
        .resolves.toContain('git version');
    } finally {
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousGitEditor === undefined) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = previousGitEditor;
    }
  });

  it('completes a conversation without repository changes', async () => {
    const repository = createRepository();
    const workspaceRoot = await createWorkspaceRoot();
    const chat = vi.fn(async (input: { onActivity?: (activity: { kind: string; message: string }) => Promise<void> }) => {
      await input.onActivity?.({
        kind: 'stdout',
        message: JSON.stringify({ response: 'Ověřuji dostupné podklady.', changedFiles: [] })
      });
      return { response: 'Direct answer.', changedFiles: [], validationChecks: [] };
    });

    const result = await runNextChatTurn(repository as never, {
      workspaceRoot,
      createProvider: () => ({
        kind: 'codex',
        preflight: vi.fn(async () => ({ provider: 'codex', ok: true, checkedAt: new Date().toISOString() })),
        chat
      }) as never
    });

    expect(result).toMatchObject({ status: 'succeeded', chatRunId: 'run_1' });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Answer the user.', repositoryAttached: false,
      forgeMindContext: expect.stringContaining('GET /api/tasks/:id/diagnostics first')
    }));
    expect(repository.completeChatRun).toHaveBeenCalledWith(expect.objectContaining({
      response: 'Direct answer.',
      result: expect.objectContaining({ interimResponses: ['Ověřuji dostupné podklady.'] })
    }));
  });

  it('executes a ForgeMind API action and gives its result back to the provider', async () => {
    const claimed = createClaimedRun('full_auto');
    (claimed.thread as typeof claimed.thread & { projectId?: string }).projectId = 'project_1';
    const repository = createRepository(claimed);
    const workspaceRoot = await createWorkspaceRoot();
    const chat = vi.fn()
      .mockResolvedValueOnce({
        response: 'I will create the contract.', changedFiles: [], validationChecks: [],
        forgeMindActions: [{
          method: 'POST', path: '/api/projects/project_1/contracts',
          bodyJson: JSON.stringify({ contract: { version: 1 }, changeSummary: 'Initial contract.' }), rationale: 'Persist the requested contract.'
        }]
      })
      .mockResolvedValueOnce({
        response: 'The contract was created in ForgeMind.', changedFiles: [], validationChecks: [], forgeMindActions: []
      });
    const apiFetch = vi.fn(async () => new Response(JSON.stringify({ projectId: 'project_1', current: { version: 1 } }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', apiFetch);

    const result = await runNextChatTurn(repository as never, {
      workspaceRoot,
      createProvider: () => ({
        kind: 'codex',
        preflight: vi.fn(async () => ({ provider: 'codex', ok: true, checkedAt: new Date().toISOString() })),
        chat
      }) as never
    });

    expect(result).toMatchObject({ status: 'succeeded' });
    expect(apiFetch).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/projects/project_1/contracts' }), expect.objectContaining({ method: 'POST' }));
    expect(chat).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.stringContaining('"status": 201')
    }));
    expect(repository.completeChatRun).toHaveBeenCalledWith(expect.objectContaining({ response: 'The contract was created in ForgeMind.' }));
    expect(repository.revokeAuthSession).toHaveBeenCalledTimes(1);
  });

  it('executes ForgeMind mutations in safe mode without an approval pause', async () => {
    const claimed = createClaimedRun('safe');
    (claimed.thread as typeof claimed.thread & { projectId?: string }).projectId = 'project_1';
    const repository = createRepository(claimed);
    const workspaceRoot = await createWorkspaceRoot();

    const chat = vi.fn()
      .mockResolvedValueOnce({
        response: 'Reconciling roadmap state.', changedFiles: [], validationChecks: [],
        forgeMindActions: [{
          method: 'POST', path: '/api/projects/project_1/implementation-steps/reconcile', bodyJson: '',
          rationale: 'Synchronize inconsistent steps from linked terminal task states.'
        }]
      })
      .mockResolvedValueOnce({ response: 'Roadmap state reconciled.', changedFiles: [], validationChecks: [], forgeMindActions: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })));

    const result = await runNextChatTurn(repository as never, {
      workspaceRoot,
      createProvider: () => ({
        kind: 'codex',
        preflight: vi.fn(async () => ({ provider: 'codex', ok: true, checkedAt: new Date().toISOString() })),
        chat
      }) as never
    });

    expect(result).toMatchObject({ status: 'succeeded' });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('records setup failures instead of leaving the run claimed', async () => {
    const repository = createRepository();
    repository.getAIProviderConnectionSecret.mockRejectedValueOnce(new Error('Provider storage unavailable.'));

    const result = await runNextChatTurn(repository as never, { workspaceRoot: await createWorkspaceRoot() });

    expect(result).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('Provider storage unavailable') });
    expect(repository.failChatRun).toHaveBeenCalledWith('run_1', expect.stringContaining('Provider storage unavailable'), expect.any(Boolean));
  });
});
