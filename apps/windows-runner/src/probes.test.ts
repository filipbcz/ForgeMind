import { describe, expect, it } from 'vitest';
import { buildMsvcProbeScript, parseConfiguredToolProbes, redactProbeOutput, runCapabilityProbes, windowsRunnerCapabilityProbes } from './probes.js';

const itWindows = process.platform === 'win32' ? it : it.skip;

describe('capability probes', () => {
  it('advertises tool capabilities only when local probe evidence succeeds', async () => {
    const result = await runCapabilityProbes([
      { capability: { key: 'baseline' }, executable: process.execPath, args: ['--version'] },
      { capability: { key: 'missing-tool' }, executable: `definitely-missing-${process.pid}.exe` }
    ], new Date('2026-09-01T00:00:00.000Z'));
    expect(result.capabilities.map(({ key }) => key)).toEqual(['baseline']);
    expect(result.evidence).toEqual([
      expect.objectContaining({ capability: expect.objectContaining({ key: 'baseline', version: expect.any(String), metadata: expect.objectContaining({ executable: process.execPath }) }), status: 'supported', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ capability: { key: 'missing-tool' }, status: 'unsupported', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]);
  });

  it('builds real executable probes for built-in and configured tool capabilities', () => {
    const probes = windowsRunnerCapabilityProbes('fixture-windows', {
      FORGEMIND_UNREAL_EXECUTABLE: 'C:\\UE\\UnrealEditor-Cmd.exe',
      FORGEMIND_UNREAL_VERSION: '5.8',
      FORGEMIND_WINDOWS_TOOL_PROBES: JSON.stringify([{ key: 'custom-sdk', executable: 'sdk.exe', args: ['version'] }])
    }, 'C:\\node.exe');
    expect(probes.find(({ capability }) => capability.key === 'windows')?.kind).toBe('windows-platform');
    expect(probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: { key: 'npm', metadata: { executable: 'npm.cmd' } }, executable: 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd --version'] }),
      expect.objectContaining({ capability: { key: 'cmake' }, executable: 'cmake.exe' }),
      expect.objectContaining({ capability: { key: 'msvc', metadata: { target: 'x64' } }, kind: 'msvc', executable: expect.stringContaining('vswhere.exe') }),
      expect.objectContaining({ capability: { key: 'git-lfs' }, executable: 'git-lfs.exe' }),
      expect.objectContaining({ capability: { key: 'windows-sdk' }, executable: 'where.exe' }),
      expect.objectContaining({ capability: { key: 'interactive-desktop' }, executable: 'powershell.exe' }),
      expect.objectContaining({ capability: { key: 'gpu' }, executable: 'powershell.exe' }),
      expect.objectContaining({ capability: { key: 'disk-capacity' }, kind: 'disk' }),
      expect.objectContaining({ capability: { key: 'codex' }, executable: expect.any(String), args: ['--version'] }),
      expect.objectContaining({
        capability: { key: 'unreal', version: '5.8', metadata: { executable: 'C:\\UE\\UnrealEditor-Cmd.exe' } },
        executable: 'C:\\UE\\UnrealEditor-Cmd.exe',
        kind: 'unreal',
        timeoutMs: 240_000
      }),
      expect.objectContaining({ capability: { key: 'custom-sdk' }, executable: 'sdk.exe', args: ['version'] })
    ]));
  });

  it('uses a standalone batch script for the quoted Visual Studio environment path', () => {
    expect(buildMsvcProbeScript('C:\\Program Files (x86)\\Microsoft Visual Studio\\vcvars64.bat')).toBe([
      '@echo off',
      'call "C:\\Program Files (x86)\\Microsoft Visual Studio\\vcvars64.bat" >nul',
      'if errorlevel 1 exit /b %errorlevel%',
      'echo FORGEMIND_MSVC_VERSION=%VCToolsVersion%',
      'cl.exe /nologo /c /Foprobe.obj probe.cpp'
    ].join('\r\n'));
  });

  it('does not allow configured capabilities to masquerade as the Windows platform probe', () => {
    expect(() => parseConfiguredToolProbes('[{"key":"windows","executable":"fake.exe"}]')).toThrow(/non-Windows key/);
    expect(() => parseConfiguredToolProbes('[{"key":"unverified"}]')).toThrow(/executable/);
  });

  it('retains useful redacted probe failures without publishing the failed capability', async () => {
    const result = await runCapabilityProbes([{ capability: { key: 'secret-tool' }, executable: `missing-${process.pid}-token=abc123.exe` }]);
    expect(result.capabilities).toEqual([]);
    expect(result.evidence[0]).toMatchObject({ status: 'unsupported', summary: expect.stringContaining('token=[redacted]') });
    expect(result.evidence[0]?.summary).not.toContain('abc123');
    expect(redactProbeOutput('C:\\Users\\alice\\tool.exe password=hunter2')).toBe('%USERPROFILE%\\tool.exe password=[redacted]');
  });

  it('times out a hung probe without blocking the complete capability run', async () => {
    const startedAt = Date.now();
    const result = await runCapabilityProbes([{
      capability: { key: 'hung-tool' },
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50
    }]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.capabilities).toEqual([]);
    expect(result.evidence[0]).toMatchObject({ status: 'unsupported', summary: expect.stringContaining('timed out') });
  });

  it('reports progress when each probe starts and completes', async () => {
    const progress: string[] = [];
    await runCapabilityProbes([{ capability: { key: 'node' }, executable: process.execPath, args: ['--version'] }], new Date(),
      ({ capability, state, status }) => progress.push(`${capability.key}:${state}:${status ?? ''}`));
    expect(progress).toEqual(['node:started:', 'node:completed:supported']);
  });

  it('normalizes capability field order before hashing and publishing evidence', async () => {
    const result = await runCapabilityProbes([{
      capability: { key: 'ordered-tool', metadata: { configured: true } }, executable: process.execPath, args: ['--version']
    }]);
    expect(Object.keys(result.evidence[0]!.capability)).toEqual(['key', 'version', 'metadata']);
    expect(result.capabilities).toEqual([result.evidence[0]!.capability]);
  });

  it('does not advertise a tool whose executable reports a different configured version', async () => {
    const result = await runCapabilityProbes([{
      capability: { key: 'versioned-tool', version: '999.1' }, executable: process.execPath, args: ['--version'], expectedVersion: '999.1'
    }]);
    expect(result.capabilities).toEqual([]);
    expect(result.evidence[0]).toMatchObject({ status: 'unsupported', summary: expect.stringContaining('different version than 999.1') });
  });

  itWindows('executes the real Windows npm wrapper and x64 MSVC compile probes', async () => {
    const probes = windowsRunnerCapabilityProbes('test').filter(({ capability }) => ['npm', 'msvc'].includes(capability.key));
    const result = await runCapabilityProbes(probes);
    expect(result.evidence).toEqual([
      expect.objectContaining({ capability: expect.objectContaining({ key: 'npm' }), status: 'supported' }),
      expect.objectContaining({ capability: expect.objectContaining({ key: 'msvc', metadata: expect.objectContaining({ target: 'x64' }) }), status: 'supported' })
    ]);
  }, 60_000);
});
