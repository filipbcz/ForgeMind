import { describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from './openai-provider.js';
import { CodexProvider, buildCodexExecArgs, resolveCodexBinary } from './codex-provider.js';

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
                summary: 'implemented',
                changedFiles: [{ path: 'src/demo.ts', content: 'export const demo = true;\n' }],
                diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
                requestedApprovals: []
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
  });
});

describe('Codex provider', () => {
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

  it('prefers explicit Codex CLI path when configured', () => {
    expect(resolveCodexBinary({ FORGEMIND_CODEX_CLI_PATH: 'C:/tools/codex.exe' })).toBe('C:/tools/codex.exe');
  });

  it('falls back to the command name when no known Codex CLI path exists', () => {
    expect(resolveCodexBinary({ APPDATA: 'C:/missing/appdata', LOCALAPPDATA: 'C:/missing/local', USERPROFILE: 'C:/missing/user' })).toBe('codex');
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
                  summary: 'implemented',
                  changedFiles: [{ path: 'src/codex.ts', content: 'export const codex = true;\n' }],
                  diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
                  requestedApprovals: []
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
