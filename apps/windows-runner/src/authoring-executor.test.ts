import { describe, expect, it, vi } from 'vitest';
import { isProhibitedAuthoringPath, LifecycleNativeImplementationProvider, type NativeAuthoringTools } from './authoring-executor.js';

const implementation = {
  outcome: 'changes_made' as const, summary: 'implemented', changedFiles: ['src/a.ts'], evidenceFiles: [],
  diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, architectureUpdate: undefined,
  validationChecks: [
    { kind: 'command' as const, command: 'npm test -- a', target: 'windows' as const, shell: 'powershell' as const },
    { kind: 'command' as const, command: 'npm test -- b', target: 'windows' as const, shell: 'cmd' as const }
  ]
};

describe('native implementation provider lifecycle', () => {
  it('rejects directory GIS datasets and oversized unclassified data while retaining Unreal payloads', () => {
    const policy = { requiresUnrealAssets: true, prohibitedDatasetExtensions: ['.gdb', '.gpkg'], maxUnclassifiedFileBytes: 1024 };
    expect(isProhibitedAuthoringPath('Source/region.gdb/a00000001.gdbtable', 12, policy)).toBe(true);
    expect(isProhibitedAuthoringPath('Source/survey.custom-grid', 1025, policy)).toBe(true);
    expect(isProhibitedAuthoringPath('Content/World.umap', 1025, policy)).toBe(false);
  });
  it('runs unrestricted AI-selected shells and captures the implementation process', async () => {
    const provider: any = { implement: vi.fn(async (input: any) => {
      await input.onActivity?.({ kind: 'stdout', message: 'Running build', elapsedMs: 1, process: { event: 'started', id: 'tool-1', command: 'cmd /c npm test' } });
      await input.onActivity?.({ kind: 'stdout', message: 'Build done', elapsedMs: 2, process: { event: 'completed', id: 'tool-1', command: 'cmd /c npm test', exitCode: 0, stdout: 'all passed', stderr: 'compiler warning' } });
      return implementation;
    }), review: vi.fn(async () => ({ verdict: 'satisfied', summary: 'ok', blockers: [] })) };
    const seen: Array<{ command: string; shell: string; checkId?: string }> = [];
    const tools = { root: 'C:/exact/job', managedRoots: { inputs: 'C:/inputs', sourceAssets: 'C:/source-assets', cache: 'C:/cache', outputs: 'C:/outputs', diagnostics: 'C:/diagnostics' }, nativeToolChannel: { command: 'node', args: ['server'] }, drainNativeProcesses: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn(), record: vi.fn(), run: vi.fn(async (input) => {
      seen.push(input); return { leaseId: 'lease', sessionId: 'session', ...input, checkId: input.checkId!, exitCode: 0, stdout: 'complete output', stderr: '', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    }) } as NativeAuthoringTools;
    await new LifecycleNativeImplementationProvider(provider).implement({ prompt: 'current step', acceptanceCriteria: ['works'], operations: [{ id: 'op', kind: 'tool', tool: 'project', arguments: {}, rationale: 'build' }], tools });
    expect(seen.slice(0, 2)).toEqual([
      { command: 'npm test -- a', shell: 'powershell', checkId: 'provider-check-1' },
      { command: 'npm test -- b', shell: 'cmd', checkId: 'provider-check-2' }
    ]);
    expect(tools.record).toHaveBeenCalledWith(expect.objectContaining({ command: 'provider.implement', exitCode: 0 }));
    expect(tools.record).toHaveBeenCalledWith(expect.objectContaining({ checkId: 'tool-1', command: 'cmd /c npm test', shell: 'cmd', exitCode: 0, stdout: 'all passed', stderr: 'compiler warning' }));
  });

  it('returns a failed check to repair without discarding an earlier valid result', async () => {
    const provider: any = { implement: vi.fn(async () => implementation), review: vi.fn() }; const completed: string[] = [];
    const tools = { root: 'C:/exact/job', managedRoots: { inputs: 'C:/inputs', sourceAssets: 'C:/source-assets', cache: 'C:/cache', outputs: 'C:/outputs', diagnostics: 'C:/diagnostics' }, nativeToolChannel: { command: 'node', args: ['server'] }, drainNativeProcesses: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn(), record: vi.fn(), run: vi.fn(async ({ checkId, command, shell }) => {
      completed.push(checkId); return { leaseId: 'lease', sessionId: 'session', checkId, command, shell, exitCode: checkId.endsWith('1') ? 0 : 1, stdout: checkId.endsWith('1') ? 'passed' : '', stderr: checkId.endsWith('1') ? '' : 'failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    }) } as NativeAuthoringTools;
    provider.implement.mockResolvedValueOnce(implementation).mockResolvedValueOnce({ ...implementation, validationChecks: [implementation.validationChecks[0]] });
    await new LifecycleNativeImplementationProvider(provider).implement({ prompt: 'repair', acceptanceCriteria: ['works'], operations: [{ id: 'op', kind: 'tool', tool: 'project', arguments: {}, rationale: 'build' }], tools });
    expect(completed).toEqual(['provider-check-1', 'provider-check-2']);
    expect(provider.implement).toHaveBeenCalledTimes(2);
    expect(provider.implement.mock.calls[1][0]).toMatchObject({ previousValidationError: expect.stringContaining('provider-check-2') });
  });

  it('blocks an aggregated-only provider command instead of fabricating empty stderr', async () => {
    const provider: any = { implement: vi.fn(async (input: any) => {
      await input.onActivity({ kind: 'stdout', message: 'combined', elapsedMs: 1,
        process: { event: 'completed', id: 'legacy-command', command: 'build', exitCode: 1 } });
      return { ...implementation, validationChecks: [] };
    }) };
    const tools = { root: 'C:/exact/job', nativeToolChannel: { command: 'node', args: ['server'] }, drainNativeProcesses: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn(), record: vi.fn(), run: vi.fn() } as unknown as NativeAuthoringTools;
    await expect(new LifecycleNativeImplementationProvider(provider).implement({ prompt: 'implement', acceptanceCriteria: [], operations: [], tools }))
      .rejects.toThrow('did not return separate stdout and stderr');
    expect(tools.record).toHaveBeenCalledWith(expect.objectContaining({ command: 'provider.implement', exitCode: 1,
      stderr: expect.stringContaining('did not return separate stdout and stderr') }));
  });
});
