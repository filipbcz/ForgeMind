import { describe, expect, it, vi } from 'vitest';
import { assertReadableAuthoringCheckout, buildUnrealPackageVerificationArgs, buildUnrealPackageVerificationScript, canResumeAuthoringCheckpoint, classifyAuthoringFailure, classifyWindowsAuthoringFailure, collectAuthoringToolVersions, collectCheckpointAuthoringProvenance, hasRestorableAuthoringCheckpoint, isProhibitedAuthoringPath, LifecycleNativeImplementationProvider, materializeOutputs, requiresProductionContent, restoreCheckpointAuthoringProvenance, type NativeAuthoringTools, unrealObjectPath, validateRequiredUnrealAssets } from './authoring-executor.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const implementation = {
  outcome: 'changes_made' as const, summary: 'implemented', changedFiles: ['src/a.ts'], evidenceFiles: [],
  diffStat: { filesChanged: 1, insertions: 1, deletions: 0 }, architectureUpdate: undefined,
  validationChecks: [
    { kind: 'command' as const, command: 'npm test -- a', target: 'windows' as const, shell: 'powershell' as const },
    { kind: 'command' as const, command: 'npm test -- b', target: 'windows' as const, shell: 'cmd' as const }
  ]
};

describe('native implementation provider lifecycle', () => {
  it('records selected Unreal tool versions from native process provenance', () => {
    expect(collectAuthoringToolVersions([{ leaseId: 'l', sessionId: 's', checkId: 'c', command: 'editor', shell: 'system', exitCode: 0,
      stdout: '', stderr: '', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
      authoring: { tool: 'unreal-editor', phase: 'verify', projectRelativePath: 'Game.uproject',
        executablePath: 'C:/Epic/UE_5.8/Engine/Binaries/Win64/UnrealEditor.exe', args: [], sourceRelativePaths: [] } }]))
      .toEqual([{ tool: 'unreal-editor', version: '5.8', driverVersion: 'C:/Epic/UE_5.8/Engine/Binaries/Win64/UnrealEditor.exe' }]);
  });
  it('classifies native timeout, cancellation, and missing-capability failures explicitly', () => {
    expect(classifyAuthoringFailure('provider timeout', false, [])).toBe('timed-out');
    expect(classifyAuthoringFailure('stopped', true, [])).toBe('cancelled');
    expect(classifyAuthoringFailure('executable not found', false, [])).toBe('missing-capability');
    expect(classifyWindowsAuthoringFailure('The model gpt-5.5 does not exist or you do not have access to it.', false, []))
      .toEqual({ kind: 'provider-configuration', retryable: false });
    expect(classifyWindowsAuthoringFailure('provider timeout', false, [])).toEqual({ kind: 'timeout', retryable: true });
  });
  it('surfaces unreadable checkouts and corrupt resumed binary artifacts as explicit blockers', async () => {
    await expect(assertReadableAuthoringCheckout('C:/fixture/Flying', async () => { const error = new Error('denied') as NodeJS.ErrnoException;
      error.code = 'EACCES'; throw error; })).rejects.toThrow('checkout is unreadable or not owned');
    const root = await mkdtemp(join(tmpdir(), 'forgemind-corrupt-output-'));
    try {
      await expect(materializeOutputs(root, [{ path: 'Artifacts/Flying.png', sha256: createHash('sha256').update('expected').digest('hex'),
        sizeBytes: 8, contentBase64: Buffer.from('corrupt').toString('base64') }])).rejects.toThrow('checkpoint output is corrupt');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('resumes a durable task checkpoint across a new run identity on the same base commit', () => {
    const checkpoint = { version: 2 as const, taskId: 'task-1', baseCommitSha: 'a'.repeat(40) };
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-1', baseCommitSha: 'a'.repeat(40) })).toBe(true);
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-2', baseCommitSha: 'a'.repeat(40) })).toBe(false);
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-1', baseCommitSha: 'b'.repeat(40) })).toBe(false);
  });
  it('does not restore an empty checkpoint as a Git patch', () => {
    const empty = { patch: '', resultBundle: { lfsObjects: [], outputs: [] } };
    expect(hasRestorableAuthoringCheckpoint(empty)).toBe(false);
    expect(hasRestorableAuthoringCheckpoint({ ...empty, patch: 'diff --git a/a b/a' })).toBe(true);
    expect(hasRestorableAuthoringCheckpoint({ ...empty,
      resultBundle: { lfsObjects: [], outputs: [{ path: 'preview.png', sha256: 'a', sizeBytes: 1, contentBase64: 'YQ==' }] } })).toBe(true);
  });
  it('carries only successful Unreal authoring provenance across durable retries', () => {
    const base = { leaseId: 'old-lease', sessionId: 'old-session', shell: 'system' as const, stdout: 'large log', stderr: '',
      startedAt: '2026-09-05T00:00:00.000Z', completedAt: '2026-09-05T00:01:00.000Z' };
    const authoring = { tool: 'unreal-python' as const, phase: 'author' as const, projectRelativePath: 'Game.uproject',
      executablePath: 'C:/UE/UnrealEditor.exe', args: ['-ExecutePythonScript=Scripts/create.py'], sourceRelativePaths: ['Scripts/create.py'] };
    const provenance = collectCheckpointAuthoringProvenance([
      { ...base, checkId: 'author', command: 'editor author', exitCode: 0, authoring },
      { ...base, checkId: 'failed-author', command: 'editor author failed', exitCode: 3, authoring },
      { ...base, checkId: 'verify', command: 'editor verify', exitCode: 0, authoring: { ...authoring, phase: 'verify' as const } }
    ]);
    expect(provenance).toEqual([{ checkId: 'author', command: 'editor author', shell: 'system',
      startedAt: base.startedAt, completedAt: base.completedAt, authoring }]);
    expect(restoreCheckpointAuthoringProvenance({ authoringProvenance: provenance }, 'new-lease', 'new-session'))
      .toEqual([{ leaseId: 'new-lease', sessionId: 'new-session', checkId: 'author', command: 'editor author', shell: 'system',
        exitCode: 0, stdout: '', stderr: '', startedAt: base.startedAt, completedAt: base.completedAt, authoring }]);
  });
  it('uses headless memory-backed flags for final saved-package verification', () => {
    expect(buildUnrealPackageVerificationArgs('C:/work/Game.uproject', 'C:/diagnostics/verify.py')).toEqual([
      'C:/work/Game.uproject', '-ExecutePythonScript=C:/diagnostics/verify.py', '-unattended', '-RUNNINGUNATTENDEDSCRIPT', '-nop4',
      '-nosplash', '-DDC-ForceMemoryCache', '-NoSaveConfig', '-NoEpicPortal', '-stdout', '-FullStdOutLogOutput', '-NullRHI'
    ]);
  });
  it('opens map packages without retaining a duplicate Python world reference', () => {
    const script = buildUnrealPackageVerificationScript([
      { path: 'Content/Maps/World.umap', objectPath: '/Game/Maps/World', sourceNames: [] },
      { path: 'Content/Props/Tree.uasset', objectPath: '/Game/Props/Tree', sourceNames: ['tree.fbx'] }
    ], 'INSPECTION:');
    const mapBranch = script.slice(script.indexOf("if package['path'].lower().endswith('.umap')"), script.indexOf('    else:'));
    expect(mapBranch).toContain('LevelEditorSubsystem).load_level');
    expect(mapBranch).toContain('unreal.UnrealEditorSubsystem)');
    expect(mapBranch).toContain('editor_subsystem.get_editor_world()');
    expect(mapBranch).toContain("current_path != package['objectPath']");
    expect(mapBranch).toContain('del loaded');
    expect(mapBranch).not.toContain('unreal.load_asset');
    expect(script.slice(script.indexOf('    else:'))).toContain("unreal.load_asset(package['objectPath'])");
  });
  it('requires editor-authored packages to be loaded after saving and retains source and exact tool provenance', () => {
    const base = { leaseId: 'lease', sessionId: 'session', shell: 'system' as const, exitCode: 0, stdout: '', stderr: '',
      startedAt: '2026-09-05T00:00:00.000Z', completedAt: '2026-09-05T00:01:00.000Z' };
    const authoring = { projectRelativePath: 'Game/Game.uproject', executablePath: 'C:/UE/UnrealEditor-Cmd.exe',
      args: ['-ExecutePythonScript=Scripts/import.py', '-unattended'], sourceRelativePaths: ['SourceAssets/tree.fbx'] };
    const authored = { ...base, checkId: 'author', command: 'editor author', authoring: { ...authoring, tool: 'unreal-python' as const, phase: 'author' as const } };
    const verified = { ...base, checkId: 'verify', command: 'editor verify',
      authoring: { ...authoring, args: ['-ExecutePythonScript=diagnostics/verify.py'], sourceRelativePaths: [], tool: 'unreal-python' as const,
        phase: 'verify' as const, loadedPackages: ['Game/Content/Maps/World.umap', 'Game/Content/Props/Tree.uasset'], inspections: [
          { path: 'Game/Content/Maps/World.umap', className: 'World', technicalObservations: ['non-basic-level-actor-present'] },
          { path: 'Game/Content/Props/Tree.uasset', className: 'StaticMesh', technicalObservations: ['asset-import-data-matches-recorded-source'] }
        ] } };
    expect(validateRequiredUnrealAssets(['Game/Content/Maps/World.umap', 'Game/Content/Props/Tree.uasset'], [authored, verified])).toBe(false);
    expect(() => validateRequiredUnrealAssets(['Game/Content/Maps/World.umap'], [authored])).toThrow('not subsequently loaded');
    expect(() => validateRequiredUnrealAssets(['Game/Content/Maps/World.umap'], [authored, { ...verified,
      authoring: { ...verified.authoring, projectRelativePath: 'Other/Other.uproject' } }])).toThrow('not subsequently loaded');
    expect(() => validateRequiredUnrealAssets(['Game/Content/Maps/World.umap'], [authored, { ...verified, authoring: { ...verified.authoring, loadedPackages: [] } }]))
      .toThrow('not subsequently loaded');
    expect(validateRequiredUnrealAssets(['Game/Content/Maps/World.umap'], [authored, verified], true)).toBe(true);
    expect(() => validateRequiredUnrealAssets(['Game/Content/Maps/World.umap'], [{ ...authored, authoring: { ...authored.authoring, tool: 'project-script' as const } }, verified]))
      .toThrow('not created or imported through a successful editor');
    expect(requiresProductionContent(['Create usable production scene content'])).toBe(true);
    expect(requiresProductionContent(['The package can load'])).toBe(false);
  });
  it('maps packages relative to the selected project Content directory', () => {
    expect(unrealObjectPath('Content/Props/Tree.uasset', 'Game.uproject')).toBe('/Game/Props/Tree');
    expect(unrealObjectPath('Game/Content/Props/Tree.uasset', 'Game/Game.uproject')).toBe('/Game/Props/Tree');
    expect(() => unrealObjectPath('Other/Content/Tree.uasset', 'Game/Game.uproject')).toThrow("outside the selected project's Content");
  });
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

  it('defers direct UnrealEditor validation to the mandatory structured verifier', async () => {
    const provider: any = { implement: vi.fn(async () => ({
      ...implementation,
      validationChecks: [{
        kind: 'command' as const,
        command: '& "C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe" Game.uproject -run=pythonscript',
        target: 'windows' as const,
        shell: 'powershell' as const
      }]
    })) };
    const tools = {
      root: 'C:/exact/job',
      nativeToolChannel: { command: 'node', args: ['server'] },
      drainNativeProcesses: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
      remove: vi.fn(),
      record: vi.fn(),
      run: vi.fn()
    } as unknown as NativeAuthoringTools;

    await new LifecycleNativeImplementationProvider(provider).implement({
      prompt: 'implement Unreal scene',
      acceptanceCriteria: ['saved scene loads'],
      operations: [],
      tools
    });

    expect(tools.run).not.toHaveBeenCalled();
    expect(tools.record).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 'provider-check-1',
      command: expect.stringContaining('deferred Unreal validation:'),
      exitCode: 0,
      stdout: 'Deferred to the mandatory structured final Unreal verification.'
    }));
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

  it('stops when a repair repeats the exact same failing validation instead of spending turns forever', async () => {
    const failing = { ...implementation, validationChecks: [implementation.validationChecks[0]] };
    const provider: any = { implement: vi.fn(async () => failing) };
    const tools = { root: 'C:/exact/job', nativeToolChannel: { command: 'node', args: ['server'] }, drainNativeProcesses: vi.fn(),
      read: vi.fn(), write: vi.fn(), remove: vi.fn(), record: vi.fn(), run: vi.fn(async ({ checkId, command, shell }) => ({
        leaseId: 'lease', sessionId: 'session', checkId, command, shell, exitCode: 1, stdout: '', stderr: 'same failure',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
      })) } as unknown as NativeAuthoringTools;
    await expect(new LifecycleNativeImplementationProvider(provider).implement({ prompt: 'repair', acceptanceCriteria: ['works'], operations: [], tools }))
      .rejects.toThrow(/same Windows validation failed again without progress/i);
    expect(provider.implement).toHaveBeenCalledTimes(2);
    expect(provider.implement.mock.calls[1][0].session).toBe(provider.implement.mock.calls[0][0].session);
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
