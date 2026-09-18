import { describe, expect, it } from 'vitest';
import { assertNativeCodexCliCompatibility, parseCliArgs, requiredProbeFailures, selectLocalCodexModel } from './cli.js';

describe('Windows runner CLI parsing', () => {
  it.each([
    [['enroll', '--api-url', 'https://forgemind.test'], { command: 'enroll', apiUrl: 'https://forgemind.test' }],
    [['probe', '--api-url', 'https://forgemind.test'], { command: 'probe', apiUrl: 'https://forgemind.test' }],
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
});
