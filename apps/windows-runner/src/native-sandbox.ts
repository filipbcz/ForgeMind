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
  return { executable: input.sandboxExecutable, args: ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-C', input.checkoutRoot,
    '--sandbox-state-disable-network', '--', executable, ...commandArgs] };
}
