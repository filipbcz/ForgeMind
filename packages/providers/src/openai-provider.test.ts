import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOpenAIModels, OpenAIProvider } from './openai-provider.js';
import { CodexProvider, buildCodexExecArgs, normalizeCodexModels, resolveCodexBinary } from './codex-provider.js';
import { ProviderContractError, normalizeProviderError } from './provider.js';

function successfulResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body
  } as Response;
}

vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => ({
    choices: [
      { message: { content: JSON.stringify({ summary: 'ok', steps: ['one'], acceptanceCriteria: ['done'] }) } }
    ]
  })
})) as unknown as typeof fetch);

describe('OpenAI provider', () => {
  it('lists the models returned by the configured OpenAI account', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({
      data: [
        { id: 'gpt-5-mini', owned_by: 'openai' },
        { id: 'gpt-5' }
      ]
    }));

    await expect(listOpenAIModels('sk-test', 'https://api.openai.com/v1/chat/completions')).resolves.toEqual([
      { id: 'gpt-5', name: 'gpt-5' },
      { id: 'gpt-5-mini', name: 'gpt-5-mini (openai)' }
    ]);
    expect(fetch).toHaveBeenLastCalledWith(new URL('https://api.openai.com/v1/models'), {
      headers: { Authorization: 'Bearer sk-test' }
    });
  });

  it('appends the models path to an OpenAI-compatible API base URL', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({ data: [] }));

    await listOpenAIModels('sk-test', 'https://provider.example/v1');

    expect(fetch).toHaveBeenLastCalledWith(new URL('https://provider.example/v1/models'), {
      headers: { Authorization: 'Bearer sk-test' }
    });
  });

  it('should construct openai provider instance', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const openai = new OpenAIProvider();
    expect(openai.kind).toBe('openai');
  });

  it('exposes a preflight check through the adapter contract', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({ data: [] }));

    const result = await new OpenAIProvider().preflight();

    expect(result).toMatchObject({ provider: 'openai', ok: true });
    expect(new Date(result.checkedAt).toString()).not.toBe('Invalid Date');
    expect(fetch).toHaveBeenLastCalledWith(new URL('https://api.openai.com/v1/models'), {
      headers: { Authorization: 'Bearer test-key' },
      signal: undefined
    });
  });

  it('normalizes provider authentication, quota, timeout, and invalid-response errors', async () => {
    expect(normalizeProviderError('openai', { status: 401, message: 'Unauthorized: Bearer sk-test_1234567890abcdef' }))
      .toMatchObject({ provider: 'openai', kind: 'authentication', retryable: false, statusCode: 401 });
    expect(normalizeProviderError('openai', { status: 429, message: 'quota exceeded' }))
      .toMatchObject({ provider: 'openai', kind: 'quota', retryable: false, statusCode: 429 });
    expect(normalizeProviderError('openai', Object.assign(new Error('request timed out'), { status: 504 })))
      .toMatchObject({ provider: 'openai', kind: 'timeout', retryable: true, statusCode: 504 });
    expect(normalizeProviderError('openai', new ProviderContractError('OpenAI request returned invalid JSON')))
      .toMatchObject({ provider: 'openai', kind: 'invalid_response', retryable: false });
  });

  it('keeps normalized provider errors audit safe', () => {
    const error = normalizeProviderError(
      'openai',
      new Error('Provider failed with Authorization: Bearer sk-test_1234567890abcdef')
    );

    expect(error.auditSafeMessage).toContain('[secret-redacted]');
    expect(error.auditSafeMessage).not.toContain('sk-test_1234567890abcdef');
    expect(error.message).toBe(error.auditSafeMessage);
  });

  it('returns normalized preflight failures without exposing response bodies', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);

    const result = await new OpenAIProvider().preflight();

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ provider: 'openai', kind: 'authentication', retryable: false, statusCode: 401 });
  });

  it('raises normalized invalid-response errors from malformed transport responses', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({ choices: [] }));

    await expect(new OpenAIProvider().plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' }))
      .rejects.toMatchObject({ name: 'NormalizedProviderError', kind: 'invalid_response' });
  });

  it('does not expose OpenAI invalid JSON parser details in normalized errors', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token p in JSON at position 1: prompt=ship-secret-feature');
      }
    } as unknown as Response);

    await expect(new OpenAIProvider().plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' }))
      .rejects.toMatchObject({
        name: 'NormalizedProviderError',
        kind: 'invalid_response',
        auditSafeMessage: 'OpenAI request returned invalid JSON.'
      });
  });

  it('should call OpenAI API for planning', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const openai = new OpenAIProvider();
    const result = await openai.plan({ taskId: '1', title: 'Test', prompt: 'Say hello.' });
    expect(result.summary).toBe('ok');
    expect(result.steps).toEqual(['one']);
  });

  it('rejects malformed provider output instead of fabricating a successful plan', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not-json' } }] })
    } as Response);

    await expect(new OpenAIProvider().plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' }))
      .rejects.toThrow('OpenAI plan returned invalid JSON');
  });

  it('keeps planning separate from implementation validation', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Plan repository code.',
            steps: ['Implement the requested behavior.'],
            acceptanceCriteria: ['Behavior is complete.']
          })
        }
      }]
    }));

    await new OpenAIProvider().plan({ taskId: 'plan', title: 'Plan work', prompt: 'Create the roadmap.' });

    const request = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    const body = JSON.parse(String(request?.body)) as { messages: Array<{ content: string }> };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('Do not propose executable validation commands during planning');
    expect(prompt).not.toContain('validationRecovery');
  });

  it('emits the actual token breakdown returned by the API', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const onActivity = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ summary: 'ok', steps: [], acceptanceCriteria: [] }) } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 40 }
        }
      })
    } as Response);

    const openai = new OpenAIProvider();
    await openai.plan({ taskId: 'usage', title: 'Usage', prompt: 'Measure usage', onActivity });

    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        provider: 'openai',
        totalTokens: 150,
        inputTokens: 120,
        outputTokens: 30,
        cachedTokens: 40,
        source: 'actual_breakdown'
      })
    }));
  });

  it('should preserve concrete file updates returned by the implementation response', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                outcome: 'changes_made',
                summary: 'implemented',
                changedFiles: ['src/demo.ts'],
                diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
                fileUpdates: [{ path: 'src/demo.ts', content: 'export const demo = true;\n' }],
                validationChecks: [
                  {
                    kind: 'command',
                    command: 'npm test -- demo',
                    criterion: 'The changed module passes its focused tests.',
                    rationale: 'This is the narrowest authoritative check.'
                  }
                ]
              })
            }
          }
        ]
      })
    } as Response);

    const openai = new OpenAIProvider();
    const result = await openai.implement({
      taskId: '1',
      prompt: 'Create src/demo.ts',
      plan: { summary: 'plan', steps: ['write file'], acceptanceCriteria: ['file exists'] },
      repositoryPath: 'C:/tmp/repo'
    });

    expect(result.fileUpdates).toEqual([{ path: 'src/demo.ts', content: 'export const demo = true;\n' }]);
    expect(result.validationChecks).toEqual([
      expect.objectContaining({ kind: 'command', command: 'npm test -- demo' })
    ]);
  });

  it('preserves an explicit already-satisfied result without generating placeholder changes', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                outcome: 'already_satisfied',
                summary: 'The focused test already proves the requested behavior.',
                changedFiles: [],
                evidenceFiles: ['src/existing-behavior.test.ts'],
                diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
                validationChecks: [
                  {
                    kind: 'command',
                    command: 'npm test -- existing-behavior',
                    criterion: 'The existing behavior remains covered.',
                    rationale: 'The repository already contains the implementation and focused test.'
                  }
                ]
              })
            }
          }
        ]
      })
    } as Response);

    const openai = new OpenAIProvider();
    const result = await openai.implement({
      taskId: 'already-done',
      prompt: 'Implement behavior that is already present.',
      plan: { summary: 'verify', steps: ['verify existing behavior'], acceptanceCriteria: ['focused test passes'] },
      repositoryPath: 'C:/tmp/repo'
    });

    expect(result.outcome).toBe('already_satisfied');
    expect(result.changedFiles).toEqual([]);
    expect(result.evidenceFiles).toEqual(['src/existing-behavior.test.ts']);
    expect(result.fileUpdates).toEqual([]);
    expect(result.diffStat).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe('Codex provider', () => {
  it('normalizes visible Codex app-server models and keeps the default first', () => {
    expect(normalizeCodexModels([
      { id: 'hidden', displayName: 'Hidden', hidden: true },
      { id: 'gpt-fast', displayName: 'GPT Fast' },
      { id: 'gpt-default', model: 'gpt-default', displayName: 'GPT Default', isDefault: true }
    ])).toEqual([
      { id: 'gpt-default', name: 'GPT Default', isDefault: true },
      { id: 'gpt-fast', name: 'GPT Fast', isDefault: false }
    ]);
  });

  it('should construct codex provider instance', () => {
    process.env.CODEX_API_KEY = 'test-key';
    const codex = new CodexProvider();
    expect(codex.kind).toBe('codex');
  });

  it('exposes Codex API-key preflight through the adapter contract', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({ data: [] }));

    const result = await new CodexProvider({ authMode: 'api_key' }).preflight();

    expect(result).toMatchObject({ provider: 'codex', ok: true });
    expect(fetch).toHaveBeenLastCalledWith(new URL('https://api.openai.com/v1/models'), {
      headers: { Authorization: 'Bearer test-key' },
      signal: undefined
    });
  });

  it('uses bypass mode for Codex CLI workspace writes', () => {
    const args = buildCodexExecArgs({
      sandbox: 'workspace-write',
      model: 'gpt-5.5',
      schemaPath: 'schema.json',
      outputPath: 'last-message.json',
      repositoryPath: 'C:/tmp/repo'
    });

    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('--cd');
    expect(args).toContain('C:/tmp/repo');
  });

  it('keeps Codex CLI planning and review read-only', () => {
    const args = buildCodexExecArgs({
      sandbox: 'read-only',
      model: 'gpt-5.5',
      schemaPath: 'schema.json',
      outputPath: 'last-message.json'
    });

    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('can bypass the read-only sandbox inside an isolated worker container', () => {
    const args = buildCodexExecArgs({
      sandbox: 'read-only',
      bypassSandbox: true,
      model: 'gpt-5.5',
      schemaPath: 'schema.json',
      outputPath: 'last-message.json'
    });

    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
  });

  it('resumes a persisted Codex task session with the current phase output schema', () => {
    const args = buildCodexExecArgs({
      sandbox: 'workspace-write',
      model: 'gpt-5.5',
      schemaPath: 'schema.json',
      outputPath: 'last-message.json',
      repositoryPath: 'C:/tmp/repo',
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53'
    });

    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).toContain('0199a213-81c0-7800-8aa1-bbab2a035a53');
    expect(args).toContain('--json');
    expect(args).toContain('--output-schema');
    expect(args).toContain('schema.json');
    expect(args).not.toContain('--cd');
  });

  it('configures a read-only sandbox through resume-compatible Codex CLI arguments', () => {
    const args = buildCodexExecArgs({
      sandbox: 'read-only',
      model: 'gpt-5.5',
      schemaPath: 'schema.json',
      outputPath: 'last-message.json',
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53'
    });

    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).not.toContain('--sandbox');
    expect(args).toContain('-c');
    expect(args).toContain('sandbox_mode="read-only"');
  });

  it('prefers explicit Codex CLI path when configured', () => {
    expect(resolveCodexBinary({ FORGEMIND_CODEX_CLI_PATH: 'C:/tools/codex.exe' })).toBe('C:/tools/codex.exe');
  });

  it('falls back to the command name when no known Codex CLI path exists', () => {
    expect(resolveCodexBinary({ APPDATA: 'C:/missing/appdata', LOCALAPPDATA: 'C:/missing/local', USERPROFILE: 'C:/missing/user' })).toBe('codex');
  });

  it('uses the newest versioned Codex desktop binary', () => {
    const localAppData = mkdtempSync(join(tmpdir(), 'forgemind-codex-desktop-'));
    const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
    const older = join(binRoot, 'older', 'codex.exe');
    const newer = join(binRoot, 'newer', 'codex.exe');
    mkdirSync(join(binRoot, 'older'), { recursive: true });
    mkdirSync(join(binRoot, 'newer'), { recursive: true });
    writeFileSync(older, '');
    writeFileSync(newer, '');
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newer, new Date(2_000), new Date(2_000));

    try {
      expect(resolveCodexBinary({ LOCALAPPDATA: localAppData })).toBe(newer);
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it('should call Codex responses API for planning', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      successfulResponse({
        output_text: JSON.stringify({
          summary: 'codex plan',
          steps: ['inspect'],
          acceptanceCriteria: ['done']
        })
      })
    );

    const codex = new CodexProvider();
    const result = await codex.plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' });

    expect(result.summary).toBe('codex plan');
    expect(result.steps).toEqual(['inspect']);
  });

  it('should preserve concrete file updates returned by Codex implementation response', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      successfulResponse({
        output: [
          {
            content: [
              {
                text: JSON.stringify({
                  outcome: 'changes_made',
                  summary: 'implemented',
                  changedFiles: ['src/codex.ts'],
                  diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
                  fileUpdates: [{ path: 'src/codex.ts', content: 'export const codex = true;\n' }]
                })
              }
            ]
          }
        ]
      })
    );

    const codex = new CodexProvider();
    const result = await codex.implement({
      taskId: '1',
      prompt: 'Create src/codex.ts',
      plan: { summary: 'plan', steps: ['write file'], acceptanceCriteria: ['file exists'] },
      repositoryPath: 'C:/tmp/repo'
    });

    expect(result.fileUpdates).toEqual([{ path: 'src/codex.ts', content: 'export const codex = true;\n' }]);
  });

  it('preserves an explicit already-satisfied Codex result without generating placeholder changes', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce(
      successfulResponse({
        output: [
          {
            content: [
              {
                text: JSON.stringify({
                  outcome: 'already_satisfied',
                  summary: 'The requested behavior is already implemented.',
                  changedFiles: [],
                  evidenceFiles: ['src/existing-behavior.test.ts'],
                  diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
                  validationChecks: [
                    {
                      kind: 'command',
                      command: 'npm test -- existing-behavior',
                      criterion: 'The existing behavior remains covered.',
                      rationale: 'The focused test proves the acceptance criterion.'
                    }
                  ]
                })
              }
            ]
          }
        ]
      })
    );

    const codex = new CodexProvider();
    const result = await codex.implement({
      taskId: 'already-done',
      prompt: 'Implement behavior that is already present.',
      plan: { summary: 'verify', steps: ['verify existing behavior'], acceptanceCriteria: ['focused test passes'] },
      repositoryPath: 'C:/tmp/repo'
    });

    expect(result.outcome).toBe('already_satisfied');
    expect(result.changedFiles).toEqual([]);
    expect(result.evidenceFiles).toEqual(['src/existing-behavior.test.ts']);
    expect(result.fileUpdates).toEqual([]);
    expect(result.diffStat).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it('normalizes Codex API errors without exposing response bodies', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable'
    } as Response);

    const codex = new CodexProvider();

    let error: unknown;
    try {
      await codex.plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: 'NormalizedProviderError',
      provider: 'codex',
      kind: 'unavailable',
      statusCode: 503,
      retryable: true,
      auditSafeMessage: 'Codex request failed. HTTP 503.'
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('temporarily unavailable');
  });

  it('does not expose Codex invalid JSON parser details in normalized errors', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token p in JSON at position 1: prompt=ship-secret-feature');
      }
    } as unknown as Response);

    await expect(new CodexProvider().plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' }))
      .rejects.toMatchObject({
        name: 'NormalizedProviderError',
        kind: 'invalid_response',
        auditSafeMessage: 'Codex request returned invalid JSON.'
      });
  });
});
