import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assertNativeCodexCliCompatibility, createWindowsProviderPool, parseCliArgs, requiredProbeFailures, resolveCodexPreflightTimeouts, resolveWindowsCandidateRoute, selectLocalCodexModel, uploadAuthoringResultBlobs } from './cli.js';

describe('Windows runner CLI parsing', () => {
  it.each([
    [['enroll', '--api-url', 'https://forgemind.test'], { command: 'enroll', apiUrl: 'https://forgemind.test' }],
    [['probe', '--api-url', 'https://forgemind.test'], { command: 'probe', apiUrl: 'https://forgemind.test' }],
    [['provider', 'connect-chatgpt', '--api-url', 'https://forgemind.test'], { command: 'provider-connect-chatgpt', apiUrl: 'https://forgemind.test' }],
    [['session', 'start', '--project', '11111111-1111-4111-8111-111111111111', '--api-url', 'https://forgemind.test'], { command: 'session-start', apiUrl: 'https://forgemind.test', projectIds: ['11111111-1111-4111-8111-111111111111'] }],
    [['session', 'drain', '--api-url', 'https://forgemind.test', '--session-id', 'session-1'], { command: 'session-drain', apiUrl: 'https://forgemind.test', sessionId: 'session-1' }],
    [['session', 'stop', '--api-url', 'https://forgemind.test', '--session-id', 'session-1'], { command: 'session-stop', apiUrl: 'https://forgemind.test', sessionId: 'session-1' }]
  ])('parses documented command %j', (args, expected) => {
    expect(parseCliArgs(args as string[])).toMatchObject(expected);
  });
  it('requires explicit project-scoped activation', () => {
    expect(() => parseCliArgs(['session', 'start', '--api-url', 'https://forgemind.test'])).toThrow(/--project/);
  });

  it('enables detailed JSON only when requested for a probe', () => {
    expect(parseCliArgs(['probe', '--api-url', 'https://forgemind.test'])).toMatchObject({ json: false });
    expect(parseCliArgs(['probe', '--json', '--api-url', 'https://forgemind.test'])).toMatchObject({ json: true });
  });

  it('blocks an Unreal session on failed authoring prerequisites', () => {
    const evidence = [
      { schemaVersion: 1 as const, capability: { key: 'npm' }, status: 'unsupported' as const, probedAt: '2026-09-18T00:00:00.000Z', probeVersion: '3', provenance: 'local-probe' as const, summary: 'npm failed', evidenceHash: 'a'.repeat(64) },
      { schemaVersion: 1 as const, capability: { key: 'msvc' }, status: 'unsupported' as const, probedAt: '2026-09-18T00:00:00.000Z', probeVersion: '3', provenance: 'local-probe' as const, summary: 'x64 compile failed', evidenceHash: 'b'.repeat(64) },
      { schemaVersion: 1 as const, capability: { key: 'asset-tool' }, status: 'unsupported' as const, probedAt: '2026-09-18T00:00:00.000Z', probeVersion: '3', provenance: 'local-probe' as const, summary: 'optional', evidenceHash: 'c'.repeat(64) }
    ];
    expect(requiredProbeFailures(evidence, { FORGEMIND_UNREAL_EXECUTABLE: 'UnrealEditor.exe' }).map(({ capability }) => capability.key)).toEqual(['npm', 'msvc']);
    expect(requiredProbeFailures(evidence, {}).map(({ capability }) => capability.key)).toEqual(['npm']);
  });

  it('selects the account default model and rejects an unavailable explicit override before a session starts', () => {
    const models = [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', isDefault: true }
    ];
    expect(selectLocalCodexModel(models)).toBe('gpt-5.6-sol');
    expect(selectLocalCodexModel(models, 'gpt-6-astra')).toBe('gpt-6-astra');
    expect(() => selectLocalCodexModel(models, 'gpt-5.5')).toThrow(/not available.*gpt-6-astra, gpt-5\.6-sol/i);
    expect(() => selectLocalCodexModel([])).toThrow(/no models available/i);
  });
  it('rejects an outdated Codex CLI before it can claim an authoring task', () => {
    expect(() => assertNativeCodexCliCompatibility('--disable --ignore-user-config --ignore-rules --output-schema --permission-profile')).not.toThrow();
    expect(() => assertNativeCodexCliCompatibility('--output-schema')).toThrow(/update @openai\/codex/i);
  });

  it('allows a slow valid Windows sandbox probe without weakening bounded execution', () => {
    expect(resolveCodexPreflightTimeouts({})).toEqual({ inspectionMs: 60_000, sandboxProbeMs: 300_000 });
    expect(resolveCodexPreflightTimeouts({
      FORGEMIND_CODEX_CLI_INSPECTION_TIMEOUT_MS: '90000',
      FORGEMIND_CODEX_SANDBOX_PROBE_TIMEOUT_MS: '420000'
    })).toEqual({ inspectionMs: 90_000, sandboxProbeMs: 420_000 });
  });

  it('rejects invalid or unbounded Codex preflight timeouts', () => {
    expect(() => resolveCodexPreflightTimeouts({ FORGEMIND_CODEX_CLI_INSPECTION_TIMEOUT_MS: 'not-a-number' })).toThrow(/integer from 1000/i);
    expect(() => resolveCodexPreflightTimeouts({ FORGEMIND_CODEX_SANDBOX_PROBE_TIMEOUT_MS: '1800001' })).toThrow(/integer from 1000/i);
  });

  it('continues Windows authoring through ChatGPT after API credits are exhausted without treating its catalogue as entitlement', async () => {
    const reports: string[] = [];
    const primaryImplement = vi.fn(async () => {
      throw new Error('Your workspace is out of credits. Ask your workspace owner to refill.');
    });
    const fallbackImplement = vi.fn(async () => ({ summary: 'done', changedFiles: [], diffStat: { filesChanged: 0, insertions: 0, deletions: 0 } }));
    const fallbackCreate = vi.fn(async () => ({ implement: fallbackImplement }) as never);
    const pool = createWindowsProviderPool([
      { id: 'primary', label: 'API key', allowedModels: ['gpt-6.1-sol'], create: async () => ({ implement: primaryImplement }) as never },
      { id: 'fallback', label: 'ChatGPT plan', allowedModels: ['gpt-5.6-sol'], modelCatalogIsAdvisory: true, create: fallbackCreate }
    ], { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }, (message) => reports.push(message));
    const session = { id: 'provider-session' };

    await expect(pool.implement({ session } as never)).resolves.toMatchObject({ summary: 'done' });
    expect(primaryImplement).toHaveBeenCalledOnce();
    expect(fallbackImplement).toHaveBeenCalledOnce();
    expect(fallbackCreate).toHaveBeenCalledWith({ model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
    expect(session.id).toBeUndefined();
    expect(reports).toEqual([
      expect.stringContaining('credit_exhausted'),
      expect.stringContaining('ChatGPT plan')
    ]);
  });

  it('refreshes an expired remote OAuth credential once without abandoning the connection', async () => {
    const reports: string[] = [];
    const expired = vi.fn(async () => {
      throw Object.assign(new Error('Provided authentication token is expired'), { status: 401, errorCode: 'token_expired' });
    });
    const recovered = vi.fn(async () => ({ summary: 'continued', changedFiles: [], diffStat: { filesChanged: 0, insertions: 0, deletions: 0 } }));
    const create = vi.fn()
      .mockResolvedValueOnce({ implement: expired })
      .mockResolvedValueOnce({ implement: recovered });
    const fallback = vi.fn(async () => ({ implement: vi.fn() }) as never);
    const pool = createWindowsProviderPool([
      { id: 'plan', label: 'ChatGPT plan', allowedModels: ['gpt-6.1-sol'], refreshableCredential: true, create },
      { id: 'fallback', label: 'Fallback', allowedModels: ['gpt-6.1-sol'], create: fallback }
    ], { model: 'gpt-6.1-sol', reasoningEffort: 'medium' }, (message) => reports.push(message));
    const session = { id: 'expired-provider-session' };

    await expect(pool.implement({ session } as never)).resolves.toMatchObject({ summary: 'continued' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(expired).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(session).toEqual({ id: undefined, provider: 'codex', model: 'gpt-6.1-sol' });
    expect(reports).toContainEqual(expect.stringContaining('refreshing the remote credential once'));
  });

  it('uses an equal or stronger fallback tier but never silently lowers model quality', () => {
    const candidate = (allowedModels: string[]) => ({ id: 'fallback', label: 'fallback', allowedModels, create: vi.fn() });
    const route = { model: 'gpt-6.1-sol', reasoningEffort: 'high' as const };

    expect(resolveWindowsCandidateRoute(candidate(['gpt-5.6-sol']), route)).toEqual({ ...route, model: 'gpt-5.6-sol' });
    expect(resolveWindowsCandidateRoute(candidate(['gpt-6-terra', 'gpt-6-astra']), route)).toEqual({ ...route, model: 'gpt-6-astra' });
    expect(resolveWindowsCandidateRoute(candidate(['gpt-6-luna', 'gpt-6-terra']), route)).toBeUndefined();
    expect(resolveWindowsCandidateRoute({ ...candidate(['gpt-5.6-sol']), modelCatalogIsAdvisory: true }, route)).toEqual(route);
  });

  it('uploads binary authoring payloads in bounded chunks and returns a small content-addressed manifest', async () => {
    const content = Buffer.alloc(4 * 1024 * 1024 + 1, 7); const sha256 = createHash('sha256').update(content).digest('hex');
    const uploadAuthoringBlobChunk = vi.fn(async (_auth: unknown, _input: { sizeBytes: number }) => ({ accepted: true, duplicate: false }));
    const completeAuthoringBlob = vi.fn(async (_auth: unknown, _input: unknown) => ({ accepted: true, duplicate: false }));
    const patch = 'diff --git'; const patchSha = createHash('sha256').update(patch).digest('hex');
    const result: any = { jobId: 'job', leaseId: 'lease', sessionId: 'session', nonce: 'nonce-value', inputHash: 'a'.repeat(64), patch,
      resultBundle: { sha256: patchSha, sizeBytes: Buffer.byteLength(patch),
        lfsObjects: [{ oid: sha256, sha256, sizeBytes: content.length, contentBase64: content.toString('base64') }], outputs: [] } };
    const manifest = await uploadAuthoringResultBlobs({ uploadAuthoringBlobChunk, completeAuthoringBlob } as any,
      { deviceId: 'device', credential: 'secret' }, result);
    const payloadChunks = uploadAuthoringBlobChunk.mock.calls.filter((call) => (call[1] as any).sha256 === sha256);
    expect(payloadChunks).toHaveLength(2);
    expect(payloadChunks.map((call) => call[1].sizeBytes)).toEqual([4 * 1024 * 1024, 1]);
    expect(completeAuthoringBlob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sha256, sizeBytes: content.length, totalChunks: 2 }));
    expect(manifest.resultBundle.lfsObjects[0]).toEqual({ oid: sha256, sha256, sizeBytes: content.length, blobSha256: sha256 });
    expect(manifest).toMatchObject({ patch: '', patchBlobSha256: patchSha });
    expect(JSON.stringify(manifest)).not.toContain(content.toString('base64').slice(0, 100));
  });
});
