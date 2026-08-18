import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOpenAIModels, OpenAIProvider } from './openai-provider.js';
import { CodexProvider, buildCodexExecArgs, normalizeCodexModels, resolveCodexBinary } from './codex-provider.js';

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

  it('passes the complete validation failure and preserves the AI recovery decision', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.mocked(fetch).mockResolvedValueOnce(successfulResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Repair repository code.',
            steps: [],
            acceptanceCriteria: [],
            validationChecks: [],
            validationRecovery: {
              action: 'repair_implementation',
              rationale: 'The test correctly detected a broken implementation.'
            }
          })
        }
      }]
    }));

    const result = await new OpenAIProvider().plan({
      taskId: 'validation-recovery',
      title: 'Repair validation failure',
      prompt: 'Diagnose the failed check.',
      validationFailure: {
        command: 'npm test',
        exitCode: 1,
        stdout: 'complete stdout',
        stderr: 'complete stderr'
      },
      previousValidationChecks: [{ kind: 'command', command: 'npm test' }]
    });

    expect(result.validationRecovery).toEqual({
      action: 'repair_implementation',
      rationale: 'The test correctly detected a broken implementation.'
    });
    const request = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    const body = JSON.parse(String(request?.body)) as { messages: Array<{ content: string }> };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('"command": "npm test"');
    expect(prompt).toContain('"exitCode": 1');
    expect(prompt).toContain('complete stdout');
    expect(prompt).toContain('complete stderr');
    expect(prompt).toContain('persistent workspace environment');
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
                requestedApprovals: [],
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
                requestedApprovals: [],
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
                  requestedApprovals: [],
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
                  requestedApprovals: [],
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

  it('should surface Codex API errors with status and body', async () => {
    process.env.CODEX_API_KEY = 'test-key';
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'temporarily unavailable'
    } as Response);

    const codex = new CodexProvider();

    await expect(codex.plan({ taskId: '1', title: 'Test', prompt: 'Plan this.' })).rejects.toThrow(
      'Codex request failed with 503: temporarily unavailable'
    );
  });
});
