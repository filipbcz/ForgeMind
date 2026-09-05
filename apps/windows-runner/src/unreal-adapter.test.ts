import { describe, expect, it, vi } from 'vitest';
import { PinnedUnrealCommandAdapter, type UnrealAdapterDependencies, type UnrealCommandProfile } from './unreal-adapter.js';

const profile: UnrealCommandProfile = { kind: 'unreal-validation', profileId: 'resave-packages', tool: 'unreal-editor-cmd', executablePath: 'C:\\UE\\UnrealEditor-Cmd.exe', workingDirectory: 'C:\\work\\repo', args: ['Project.uproject', '-run=ResavePackages', '-unattended'], size: 'standard' };
const policy = { workspaceRoot: 'C:\\work', pinnedTools: [{ tool: 'unreal-editor-cmd' as const, canonicalPath: 'C:\\UE\\UnrealEditor-Cmd.exe', version: '5.8.1' }], approvedProfiles: [{ id: 'resave-packages', tool: 'unreal-editor-cmd' as const, command: 'ResavePackages', size: 'standard' as const, allowedArguments: profile.args }], minimumLargeJobFreeSpaceBytes: 500 };

function harness(confirm = true, free = 1_000) {
  const dependencies: UnrealAdapterDependencies = { canonicalize: async (value) => value, freeSpaceBytes: async () => free, confirmLargeJob: vi.fn(async () => confirm), showLocally: vi.fn() };
  return { adapter: new PinnedUnrealCommandAdapter(dependencies), dependencies };
}

describe('pinned Unreal command adapter', () => {
  it('prepares only a canonical pinned command and makes it locally visible', async () => {
    const { adapter, dependencies } = harness();
    await expect(adapter.prepare(profile, policy)).resolves.toMatchObject({ status: 'ready', executablePath: profile.executablePath, toolVersion: '5.8.1' });
    expect(dependencies.showLocally).toHaveBeenCalledOnce();
    await expect(adapter.prepare({ ...profile, executablePath: 'C:\\Other\\UnrealEditor-Cmd.exe' }, policy)).resolves.toMatchObject({ status: 'manual_required', reason: 'unknown_profile' });
  });

  it.each([
    [['Project.uproject', '-game'], 'gui_job'],
    [['Project.uproject', '-run=Install'], 'installation'],
    [['Project.uproject', '-run=Build', '-UAC'], 'uac'],
    [['Project.uproject', '-run=Build', '-restart'], 'restart'],
    [['Project.uproject', '-run=Build', '-acceptlicense'], 'license_risk'],
    [['..\\outside.uproject', '-run=Build'], 'unknown_profile']
  ])('returns a structured status for unsafe arguments', async (args, reason) => {
    const { adapter } = harness();
    await expect(adapter.prepare({ ...profile, args }, policy)).resolves.toMatchObject({ reason });
  });

  it('requires free space but no repeated confirmation for an authorized large job', async () => {
    const largePolicy = { ...policy, approvedProfiles: [{ ...policy.approvedProfiles[0]!, size: 'large' as const }] };
    await expect(harness(true, 499).adapter.prepare({ ...profile, size: 'large' }, largePolicy)).resolves.toMatchObject({ status: 'approval_required', reason: 'insufficient_free_space' });
    await expect(harness(false).adapter.prepare({ ...profile, size: 'large' }, largePolicy)).resolves.toMatchObject({ status: 'ready' });
    await expect(harness(true).adapter.prepare({ ...profile, size: 'large' }, largePolicy)).resolves.toMatchObject({ status: 'ready' });
    await expect(harness(true).adapter.prepare(profile, largePolicy)).resolves.toMatchObject({ status: 'manual_required', reason: 'unknown_profile' });
  });

  it.each<[UnrealCommandProfile, string]>([
    [{ ...profile, args: ['Project.uproject', '-run=UnknownCommandlet'] }, 'unknown commandlet'],
    [{ ...profile, size: 'huge' } as unknown as UnrealCommandProfile, 'invalid runtime size'],
    [{ ...profile, args: ['C:\\outside\\Project.uproject', '-run=ResavePackages'] }, 'absolute source path'],
    [{ ...profile, args: ['Project.uproject', '-run=ResavePackages', '-Report=C:\\outside\\report.json'] }, 'absolute output path']
  ])('rejects $1', async (candidate, _label) => {
    await expect(harness().adapter.prepare(candidate, policy)).resolves.toMatchObject({ status: 'manual_required', reason: 'unknown_profile' });
  });

  it('returns manual status for canonicalization and workspace containment failures', async () => {
    const failed = harness();
    failed.dependencies.canonicalize = async () => { throw new Error('missing'); };
    await expect(failed.adapter.prepare(profile, policy)).resolves.toMatchObject({ status: 'manual_required' });
    await expect(harness().adapter.prepare({ ...profile, workingDirectory: 'C:\\outside' }, policy)).resolves.toMatchObject({ status: 'manual_required' });
  });

  it.each([
    ['build-bat', ['MyGame', 'Win64', 'Development'], ['MyGame', 'Win64', 'Shipping']],
    ['automation-tool', ['BuildCookRun', '-project=Project.uproject'], ['BuildGraph', '-target=Unknown']],
    ['project-script', ['validate', 'Project.uproject'], ['publish', 'Project.uproject']]
  ] as const)('rejects argument mismatch for %s profiles', async (tool, allowedArguments, submittedArguments) => {
    const candidate = { ...profile, profileId: `${tool}-profile`, tool, args: submittedArguments };
    const toolPolicy = {
      ...policy,
      pinnedTools: [{ tool, canonicalPath: profile.executablePath, version: '5.8.1' }],
      approvedProfiles: [{ id: candidate.profileId, tool, size: 'standard' as const, allowedArguments }]
    };
    await expect(harness().adapter.prepare(candidate, toolPolicy)).resolves.toMatchObject({ status: 'manual_required', reason: 'unknown_profile' });
  });

  it('rejects an absolute argument that canonicalizes through a junction outside the workspace', async () => {
    const junctionProfile = { ...profile, args: ['C:\\work\\junction\\Project.uproject', '-run=ResavePackages', '-unattended'] };
    const junctionPolicy = { ...policy, approvedProfiles: [{ ...policy.approvedProfiles[0]!, allowedArguments: junctionProfile.args }] };
    const dependencies: UnrealAdapterDependencies = {
      canonicalize: async (value) => value.startsWith('C:\\work\\junction') ? value.replace('C:\\work\\junction', 'C:\\outside') : value,
      freeSpaceBytes: async () => 1_000,
      confirmLargeJob: async () => true,
      showLocally: vi.fn()
    };
    await expect(new PinnedUnrealCommandAdapter(dependencies).prepare(junctionProfile, junctionPolicy)).resolves.toMatchObject({ status: 'manual_required', reason: 'unknown_profile' });
  });

  it('returns a structured status when the large-job resource check is unavailable', async () => {
    const largePolicy = { ...policy, approvedProfiles: [{ ...policy.approvedProfiles[0]!, size: 'large' as const }] };
    const freeSpaceFailure = harness();
    freeSpaceFailure.dependencies.freeSpaceBytes = async () => { throw new Error('unavailable'); };
    await expect(freeSpaceFailure.adapter.prepare({ ...profile, size: 'large' }, largePolicy)).resolves.toMatchObject({ status: 'approval_required', reason: 'resource_check_failed' });
  });
});
