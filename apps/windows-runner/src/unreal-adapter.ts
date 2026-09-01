import { realpath, statfs } from 'node:fs/promises';
import { win32 as path } from 'node:path';

export type UnrealTool = 'unreal-editor-cmd' | 'build-bat' | 'automation-tool' | 'project-script';

export interface UnrealCommandProfile {
  kind: 'unreal-validation';
  profileId: string;
  tool: UnrealTool;
  executablePath: string;
  workingDirectory: string;
  args: readonly string[];
  size: 'standard' | 'large';
}

export interface PinnedUnrealTool { tool: UnrealTool; canonicalPath: string; version: string }
export interface ApprovedUnrealProfile { id: string; tool: UnrealTool; command?: string; size: 'standard' | 'large'; allowedArguments: readonly string[] }

export interface UnrealExecutorPolicy {
  workspaceRoot: string;
  pinnedTools: readonly PinnedUnrealTool[];
  approvedProfiles: readonly ApprovedUnrealProfile[];
  minimumLargeJobFreeSpaceBytes: number;
}

export type UnrealManualReason = 'unknown_profile' | 'gui_job';
export type UnrealApprovalReason = 'installation' | 'uac' | 'restart' | 'license_risk' | 'large_job_confirmation' | 'insufficient_free_space' | 'resource_check_failed' | 'local_confirmation_unavailable';

export type UnrealPreparationResult =
  | { status: 'ready'; executablePath: string; workingDirectory: string; args: readonly string[]; toolVersion: string }
  | { status: 'manual_required'; reason: UnrealManualReason; message: string }
  | { status: 'approval_required'; reason: UnrealApprovalReason; message: string };

export interface UnrealAdapterDependencies {
  canonicalize(value: string): Promise<string>;
  freeSpaceBytes(value: string): Promise<number>;
  confirmLargeJob(summary: string): Promise<boolean>;
  showLocally(summary: string): void;
}

const defaults: UnrealAdapterDependencies = {
  canonicalize: realpath,
  async freeSpaceBytes(value) { const stats = await statfs(value, { bigint: true }); return Number(stats.bavail * stats.bsize); },
  async confirmLargeJob() { return false; },
  showLocally(summary) { process.stdout.write(`${summary}\n`); }
};

const forbiddenArguments: ReadonlyArray<[RegExp, UnrealApprovalReason]> = [
  [/(?:^|[=:/\\-])(install|setup)(?:$|[=:/\\-])/i, 'installation'],
  [/(?:^|[=:/\\-])(uac|runas|elevat(?:e|ed|ion))(?:$|[=:/\\-])/i, 'uac'],
  [/(?:^|[=:/\\-])(restart|reboot)(?:$|[=:/\\-])/i, 'restart'],
  [/(?:^|[=:/\\-])(acceptlicense|license|activate)(?:$|[=:/\\-])/i, 'license_risk']
];

export class PinnedUnrealCommandAdapter {
  constructor(private readonly dependencies: UnrealAdapterDependencies = defaults) {}

  async prepare(profile: UnrealCommandProfile, policy: UnrealExecutorPolicy): Promise<UnrealPreparationResult> {
    if (profile.kind !== 'unreal-validation' || !['unreal-editor-cmd', 'build-bat', 'automation-tool', 'project-script'].includes(profile.tool)) return manual('unknown_profile', 'Unknown Unreal command profile requires manual review.');
    if (!Number.isSafeInteger(policy.minimumLargeJobFreeSpaceBytes) || policy.minimumLargeJobFreeSpaceBytes < 0) throw new Error('large-job free-space policy must be a non-negative integer');
    if (profile.size !== 'standard' && profile.size !== 'large') return manual('unknown_profile', 'Unreal job size is invalid.');
    const approvedProfile = policy.approvedProfiles.find((item) => item.id === profile.profileId && item.tool === profile.tool);
    if (!approvedProfile || approvedProfile.size !== profile.size) return manual('unknown_profile', 'The Unreal command profile or its policy-owned size classification is not approved.');
    let workspace: string;
    let workingDirectory: string;
    let executablePath: string;
    let canonicalPins: Array<PinnedUnrealTool & { canonicalPath: string }>;
    try {
      workspace = await this.dependencies.canonicalize(policy.workspaceRoot);
      workingDirectory = await this.dependencies.canonicalize(profile.workingDirectory);
      ensureWithin(workspace, workingDirectory);
      executablePath = await this.dependencies.canonicalize(profile.executablePath);
      canonicalPins = await Promise.all(policy.pinnedTools.map(async (item) => ({ ...item, canonicalPath: await this.dependencies.canonicalize(item.canonicalPath) })));
    } catch {
      return manual('unknown_profile', 'Unreal paths could not be canonicalized inside the approved workspace.');
    }
    const pin = canonicalPins.find((item) => item.tool === profile.tool && equalPath(item.canonicalPath, executablePath));
    if (!pin) return manual('unknown_profile', 'The locally probed executable does not match the pinned Unreal tool path.');
    const unsafe = await validateArguments(profile, approvedProfile, workspace, this.dependencies);
    if (unsafe) return unsafe;
    const summary = `Unreal validation visible locally: ${profile.tool} ${profile.args.join(' ')}`;
    this.dependencies.showLocally(summary);
    if (approvedProfile.size === 'large') {
      let freeSpace: number;
      try { freeSpace = await this.dependencies.freeSpaceBytes(workspace); } catch { return approval('resource_check_failed', 'Large Unreal validation is blocked because free space could not be verified.'); }
      if (freeSpace < policy.minimumLargeJobFreeSpaceBytes) return approval('insufficient_free_space', 'Large Unreal validation is blocked by the free-space policy.');
      let confirmed: boolean;
      try { confirmed = await this.dependencies.confirmLargeJob(summary); } catch { return approval('local_confirmation_unavailable', 'Large Unreal validation is blocked because local confirmation is unavailable.'); }
      if (!confirmed) return approval('large_job_confirmation', 'Large Unreal validation requires separate local confirmation.');
    }
    return { status: 'ready', executablePath, workingDirectory, args: [...profile.args], toolVersion: pin.version };
  }
}

async function validateArguments(profile: UnrealCommandProfile, approvedProfile: ApprovedUnrealProfile, workspace: string, dependencies: UnrealAdapterDependencies): Promise<UnrealPreparationResult | undefined> {
  if (profile.args.length === 0 || profile.args.length > 64 || profile.args.some((arg) => !arg || arg.length > 1024 || /[\r\n\0]/.test(arg))) return manual('unknown_profile', 'Unreal arguments are missing or malformed.');
  if (profile.args.some((arg) => /(^|[=:/\\])UnrealEditor\.exe$/i.test(arg) || /(^|[=:/\\])-?game$/i.test(arg))) return manual('gui_job', 'GUI Unreal jobs require manual handling and are not executable by the runner.');
  for (const arg of profile.args) for (const [pattern, reason] of forbiddenArguments) if (pattern.test(arg)) return approval(reason, `Unreal argument requires explicit manual approval: ${reason}.`);
  if (profile.args.some((arg) => /(^|[\\/])\.\.([\\/]|$)/.test(arg))) return manual('unknown_profile', 'Traversal is forbidden in Unreal arguments.');
  if (!sameArguments(profile.args, approvedProfile.allowedArguments)) return manual('unknown_profile', 'Unreal arguments do not match the pinned command profile.');
  for (const arg of profile.args) if (await containsPathOutsideWorkspace(arg, workspace, dependencies)) return manual('unknown_profile', 'Absolute Unreal argument paths must resolve inside the workspace.');
  if (profile.tool === 'unreal-editor-cmd') {
    const commandlet = profile.args.find((arg) => /^-run=/i.test(arg))?.slice(5);
    if (!commandlet || commandlet.toLocaleLowerCase('en-US') !== approvedProfile.command?.toLocaleLowerCase('en-US')) return manual('unknown_profile', 'UnrealEditor-Cmd requires the commandlet pinned by its approved profile.');
  }
  return undefined;
}

async function containsPathOutsideWorkspace(argument: string, workspace: string, dependencies: UnrealAdapterDependencies): Promise<boolean> {
  const value = (argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argument).replace(/^['"]|['"]$/g, '');
  if (!path.isAbsolute(value)) return false;
  try { ensureWithin(workspace, await dependencies.canonicalize(value)); return false; } catch { return true; }
}

const sameArguments = (actual: readonly string[], allowed: readonly string[]): boolean => actual.length === allowed.length && actual.every((argument, index) => argument === allowed[index]);

function ensureWithin(root: string, candidate: string): void { const relative = path.relative(root, candidate); if (relative === '..' || relative.startsWith('..\\') || path.isAbsolute(relative)) throw new Error('Unreal working directory must remain inside the workspace'); }
const equalPath = (left: string, right: string): boolean => path.normalize(left).toLocaleLowerCase('en-US') === path.normalize(right).toLocaleLowerCase('en-US');
const manual = (reason: Extract<UnrealPreparationResult, { status: 'manual_required' }>['reason'], message: string): UnrealPreparationResult => ({ status: 'manual_required', reason, message });
const approval = (reason: Extract<UnrealPreparationResult, { status: 'approval_required' }>['reason'], message: string): UnrealPreparationResult => ({ status: 'approval_required', reason, message });
