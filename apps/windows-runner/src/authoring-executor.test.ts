import { describe, expect, it, vi } from 'vitest';
import { assertReadableAuthoringCheckout, authoringPatchOutputLimit, authoringSemanticHash, buildUnrealPackageVerificationArgs, buildUnrealPackageVerificationScript, canResumeAuthoringCheckpoint, checkpointRecoveryScore, classifyAuthoringFailure, classifyWindowsAuthoringFailure, cleanupIgnoredUnrealRuntimeState, collectAuthoringToolVersions, collectCheckpointAuthoringProvenance, compactProcessResults, discoverUnrealProjectDirectories, hasRestorableAuthoringCheckpoint, isProhibitedAuthoringPath, LifecycleNativeImplementationProvider, materializeOutputs, nativeImplementationPrompt, requiresProductionContent, retainedCheckpointGenerations, restoreCheckpointAuthoringProvenance, selectRecoveryCheckpoint, type NativeAuthoringTools, unrealObjectPath, validateRequiredUnrealAssets } from './authoring-executor.js';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  it('makes a saved Unreal package an explicit mandatory deliverable', () => {
    const prompt = nativeImplementationPrompt({
      step: { prompt: 'Create the qualification scene' } as any,
      contentPolicy: { requiresUnrealAssets: true } as any
    });
    expect(prompt).toContain('Create the qualification scene');
    expect(prompt).toContain('at least one newly saved or modified .uasset or .umap');
    expect(prompt).toContain('invoke run_unreal_authoring');
    expect(nativeImplementationPrompt({
      step: { prompt: 'Update documentation' } as any,
      contentPolicy: { requiresUnrealAssets: false } as any
    })).toBe('Update documentation');
  });
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
    const checkpoint = { version: 2 as const, taskId: 'task-1', baseCommitSha: 'a'.repeat(40), unrealProbeIdentity: 'probe-5.8.2' };
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-1', baseCommitSha: 'a'.repeat(40) }, 'probe-5.8.2')).toBe(true);
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-2', baseCommitSha: 'a'.repeat(40) })).toBe(false);
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-1', baseCommitSha: 'b'.repeat(40) })).toBe(false);
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-1', baseCommitSha: 'a'.repeat(40) }, 'probe-5.9.0')).toBe(false);
    expect(canResumeAuthoringCheckpoint(checkpoint, { taskId: 'task-1', baseCommitSha: 'a'.repeat(40) }, 'probe-5.9.0', true)).toBe(true);
  });
  it('prefers a materially richer preserved checkpoint over a fresh partial retry', () => {
    const bundle = { version: 1 as const, format: 'git-binary-patch' as const, sha256: 'a', sizeBytes: 1, lfsObjects: [], outputs: [] };
    const partial: any = { version: 2, taskId: 'task-1', baseCommitSha: 'a'.repeat(40), resultTreeSha: '1'.repeat(40),
      updatedAt: '2026-10-11T19:33:08Z', unrealProbeIdentity: 'new-probe', patch: 'small', tree: [{ path: 'one' }], resultBundle: bundle };
    const preserved: any = { ...partial, resultTreeSha: '2'.repeat(40), updatedAt: '2026-10-11T16:33:59Z', unrealProbeIdentity: 'old-probe',
      patch: 'x'.repeat(20_000), tree: Array.from({ length: 49 }, (_, index) => ({ path: String(index) })) };
    expect(checkpointRecoveryScore(preserved)).toBeGreaterThan(checkpointRecoveryScore(partial));
    expect(selectRecoveryCheckpoint([partial, preserved], 'new-probe')).toBe(preserved);
  });
  it('never prunes an Unreal package checkpoint behind newer text-only retries', () => {
    const bundle = { version: 1 as const, format: 'git-binary-patch' as const, sha256: 'a', sizeBytes: 1, lfsObjects: [], outputs: [] };
    const checkpoint = (path: string, patchSize: number): any => ({ version: 2, taskId: 'task-1', baseCommitSha: 'a'.repeat(40),
      resultTreeSha: createHash('sha1').update(path).digest('hex'), updatedAt: '2026-10-11T19:33:08Z', patch: 'x'.repeat(patchSize),
      tree: [{ path, kind: 'file', sha256: 'a', sizeBytes: 64, binary: path.endsWith('.umap'), mode: '100644' }], resultBundle: bundle });
    const generations = [
      { name: 'checkpoint.generation-004.json', checkpoint: checkpoint('Source/Four.cpp', 40_000) },
      { name: 'checkpoint.generation-003.json', checkpoint: checkpoint('Source/Three.cpp', 30_000) },
      { name: 'checkpoint.generation-002.json', checkpoint: checkpoint('Source/Two.cpp', 20_000) },
      { name: 'checkpoint.generation-001.json', checkpoint: checkpoint('Content/Flying.umap', 100) }
    ];
    expect(checkpointRecoveryScore(generations[3]!.checkpoint)).toBeGreaterThan(checkpointRecoveryScore(generations[0]!.checkpoint));
    expect([...retainedCheckpointGenerations(generations)]).toEqual(expect.arrayContaining([
      'checkpoint.generation-004.json', 'checkpoint.generation-003.json', 'checkpoint.generation-002.json', 'checkpoint.generation-001.json'
    ]));
  });
  it('discovers projects and removes staged runtime state without retained process evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgemind-unreal-runtime-'));
    const rootGenerated = join(root, 'Intermediate', 'Build', 'BuildRules', 'FlyingModuleRules.dll');
    const nestedGenerated = join(root, 'unreal', 'Intermediate', 'Build', 'nested.dll');
    try {
      await mkdir(join(root, 'Intermediate', 'Build', 'BuildRules'), { recursive: true });
      await mkdir(join(root, 'unreal', 'Intermediate', 'Build'), { recursive: true });
      await writeFile(join(root, 'Flying.uproject'), '{}');
      await writeFile(join(root, 'unreal', 'Flying.uproject'), '{}');
      await writeFile(rootGenerated, 'generated root cache');
      await writeFile(nestedGenerated, 'generated nested cache');
      expect(await discoverUnrealProjectDirectories(root)).toEqual(['.', 'unreal']);
      await cleanupIgnoredUnrealRuntimeState(root);
      await expect(access(rootGenerated)).rejects.toThrow();
      await expect(access(nestedGenerated)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('retains enough bounded Git output for Unreal binary patches', () => {
    expect(authoringPatchOutputLimit(10_000_000)).toBe(80_000_000);
    expect(authoringPatchOutputLimit(1)).toBe(4 * 1024 * 1024);
    expect(authoringPatchOutputLimit(100_000_000)).toBe(128 * 1024 * 1024);
  });
  it('keeps completed-result reuse stable across delivery retries but not product changes', () => {
    const packet: any = { taskId: 'task', baseCommitSha: 'a'.repeat(40), step: { prompt: 'Build scene', acceptanceCriteria: ['Map exists'],
      previousValidationError: 'network one' }, operations: [{ id: 'implementation' }], requiredCapabilities: ['unreal'],
      contentPolicy: { requiresUnrealAssets: true }, artifactExpectations: [], realEngineEvidence: { classification: 'automated-scenario' } };
    expect(authoringSemanticHash(packet)).toBe(authoringSemanticHash({ ...packet,
      jobId: 'new-job', step: { ...packet.step, previousValidationError: 'network two' } }));
    expect(authoringSemanticHash(packet)).not.toBe(authoringSemanticHash({ ...packet,
      step: { ...packet.step, acceptanceCriteria: ['Different map exists'] } }));
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
    expect(script).toContain('def inspect_package(package):');
    expect(script).toContain('observations = list(dict.fromkeys(observations))[:50]');
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
    expect(requiresProductionContent(['Vytvoř hotovou produkční 3D scénu'])).toBe(true);
    expect(requiresProductionContent(['The package can load'])).toBe(false);
  });
  it('bounds final process evidence while preserving authoring and failure diagnostics', () => {
    const base = { leaseId: 'lease', sessionId: 'session', shell: 'system' as const, exitCode: 0,
      stdout: 'x'.repeat(100), stderr: '', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' };
    const processes = Array.from({ length: 8 }, (_, index) => ({ ...base, checkId: `check-${index}`, command: `command-${index}` }));
    processes[2] = { ...processes[2]!, exitCode: 1 };
    const compact = compactProcessResults(processes, 3, 10);
    expect(compact).toHaveLength(3);
    expect(compact.some(({ checkId }) => checkId === 'check-2')).toBe(true);
    expect(compact.every(({ stdout }) => Buffer.byteLength(stdout) <= 10)).toBe(true);
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

  it('returns mandatory Unreal package verification failure to the same checkout before completing', async () => {
    const provider: any = { implement: vi.fn(async () => ({ ...implementation, validationChecks: [] })) };
    const tools = { root: 'C:/exact/job', managedRoots: { inputs: 'C:/inputs', sourceAssets: 'C:/source-assets', cache: 'C:/cache', outputs: 'C:/outputs', diagnostics: 'C:/diagnostics' },
      nativeToolChannel: { command: 'node', args: ['server'] }, drainNativeProcesses: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn(),
      record: vi.fn(), run: vi.fn() } as unknown as NativeAuthoringTools;
    const verifyCompletion = vi.fn()
      .mockRejectedValueOnce(new Error('Required Unreal authoring did not produce a .uasset or .umap payload.'))
      .mockResolvedValueOnce(undefined);

    await new LifecycleNativeImplementationProvider(provider).implement({
      prompt: 'author scene', acceptanceCriteria: ['saved scene loads'], operations: [], tools, verifyCompletion
    });

    expect(provider.implement).toHaveBeenCalledTimes(2);
    expect(verifyCompletion).toHaveBeenCalledTimes(2);
    expect(provider.implement.mock.calls[1][0]).toMatchObject({
      previousValidationError: expect.stringContaining('Required Unreal authoring did not produce a .uasset or .umap payload.')
    });
    expect(provider.implement.mock.calls[1][0].session).toBe(provider.implement.mock.calls[0][0].session);
    expect(tools.record).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 'mandatory-final-verification', command: 'runner.verify-authored-result', exitCode: 1
    }));
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

  it('tells a repair pass that probed capability cannot be replaced by a waiting marker', async () => {
    const failing = { ...implementation, validationChecks: [implementation.validationChecks[0]] };
    const provider: any = { implement: vi.fn(async () => failing) };
    const tools = { root: 'C:/exact/job', nativeToolChannel: { command: 'node', args: ['server'] }, drainNativeProcesses: vi.fn(),
      read: vi.fn(), write: vi.fn(), remove: vi.fn(), record: vi.fn(), run: vi.fn(async ({ checkId, command, shell }) => ({
        leaseId: 'lease', sessionId: 'session', checkId, command, shell, exitCode: 1, stdout: 'Editor baseline is waiting_for_capability', stderr: '',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
      })) } as unknown as NativeAuthoringTools;
    await expect(new LifecycleNativeImplementationProvider(provider).implement({ prompt: 'repair', acceptanceCriteria: ['works'], operations: [], tools }))
      .rejects.toThrow(/required capabilities passed local probes/i);
    expect(provider.implement.mock.calls[1][0].previousValidationError).toContain('Do not preserve waiting_for_capability');
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
