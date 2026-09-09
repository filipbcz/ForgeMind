import { isAbsolute, relative, resolve } from 'node:path';

export function assertEvidenceOutsideCheckout(checkoutRoot: string, evidencePath: string): void {
  const fromRoot = relative(resolve(checkoutRoot), resolve(evidencePath));
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
    throw new Error('Native process evidence must be outside the AI-accessible checkout.');
  }
}

export function buildSandboxedProcessInvocation(input: {
  sandboxExecutable: string;
  checkoutRoot: string;
  command: string;
  shell: 'powershell' | 'cmd' | 'system';
}): { executable: string; args: string[] } {
  if (!input.sandboxExecutable.trim()) throw new Error('A Windows sandbox executable is required.');
  const executable = input.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe';
  const commandArgs = input.shell === 'cmd'
    ? ['/d', '/s', '/c', input.command]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', input.command];
  return { executable: input.sandboxExecutable, args: ['sandbox', '--permission-profile', ':workspace', '-C', input.checkoutRoot,
    '--', executable, ...commandArgs] };
}

export function buildSandboxedExecutableInvocation(input: {
  sandboxExecutable: string;
  checkoutRoot: string;
  executable: string;
  args: string[];
}): { executable: string; args: string[] } {
  if (!input.sandboxExecutable.trim()) throw new Error('A Windows sandbox executable is required.');
  if (!input.executable.trim()) throw new Error('A native executable is required.');
  return { executable: input.sandboxExecutable, args: ['sandbox', '--permission-profile', ':workspace', '-C', input.checkoutRoot,
    '--', input.executable, ...input.args] };
}

const REQUIRED_UNREAL_FLAGS = [
  '-unattended',
  '-RUNNINGUNATTENDEDSCRIPT',
  '-nop4',
  '-nosplash',
  '-DDC-ForceMemoryCache',
  '-NoSaveConfig',
  '-NoEpicPortal',
  '-stdout',
  '-FullStdOutLogOutput'
] as const;

export function buildUnrealAuthoringArgs(projectPath: string, args: string[], phase: 'author' | 'verify' | 'build' | 'cook' | 'package'): string[] {
  const effective = [projectPath, ...args];
  for (const flag of REQUIRED_UNREAL_FLAGS) {
    if (!hasCommandLineFlag(effective, flag)) effective.push(flag);
  }
  if (phase === 'verify' && !hasCommandLineFlag(effective, '-NullRHI')) effective.push('-NullRHI');
  return effective;
}

export function containsUnrealEditorInvocation(command: string): boolean {
  return /\bunrealeditor(?:-cmd)?\.exe\b/i.test(command);
}

function hasCommandLineFlag(args: string[], expected: string): boolean {
  const name = expected.slice(1).toLowerCase();
  return args.some((arg) => {
    const normalized = arg.trim().replace(/^[-/]/, '').split('=', 1)[0]?.toLowerCase();
    return normalized === name;
  });
}
