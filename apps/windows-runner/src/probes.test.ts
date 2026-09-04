import { describe, expect, it } from 'vitest';
import { parseConfiguredToolProbes, runCapabilityProbes, windowsRunnerCapabilityProbes } from './probes.js';

describe('capability probes', () => {
  it('advertises tool capabilities only when local probe evidence succeeds', async () => {
    const result = await runCapabilityProbes([
      { capability: { key: 'baseline' } },
      { capability: { key: 'missing-tool' }, executable: `definitely-missing-${process.pid}.exe` }
    ], new Date('2026-09-01T00:00:00.000Z'));
    expect(result.capabilities.map(({ key }) => key)).toEqual(['baseline']);
    expect(result.evidence).toEqual([
      expect.objectContaining({ capability: { key: 'baseline' }, status: 'supported', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ capability: { key: 'missing-tool' }, status: 'unsupported', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]);
  });

  it('builds real executable probes for built-in and configured tool capabilities', () => {
    const probes = windowsRunnerCapabilityProbes('fixture-windows', {
      FORGEMIND_UNREAL_EXECUTABLE: 'C:\\UE\\UnrealEditor-Cmd.exe',
      FORGEMIND_UNREAL_VERSION: '5.8',
      FORGEMIND_WINDOWS_TOOL_PROBES: JSON.stringify([{ key: 'custom-sdk', executable: 'sdk.exe', args: ['version'] }])
    }, 'C:\\node.exe');
    expect(probes.find(({ capability }) => capability.key === 'windows')?.executable).toBeUndefined();
    expect(probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: { key: 'cmake' }, executable: 'cmake.exe' }),
      expect.objectContaining({ capability: { key: 'msvc' }, executable: 'cl.exe' }),
      expect.objectContaining({ capability: { key: 'unreal', version: '5.8', metadata: { executable: 'C:\\UE\\UnrealEditor-Cmd.exe' } }, executable: 'C:\\UE\\UnrealEditor-Cmd.exe' }),
      expect.objectContaining({ capability: { key: 'custom-sdk' }, executable: 'sdk.exe', args: ['version'] })
    ]));
  });

  it('does not allow configured capabilities to masquerade as the Windows platform probe', () => {
    expect(() => parseConfiguredToolProbes('[{"key":"windows","executable":"fake.exe"}]')).toThrow(/non-Windows key/);
    expect(() => parseConfiguredToolProbes('[{"key":"unverified"}]')).toThrow(/executable/);
  });
});
