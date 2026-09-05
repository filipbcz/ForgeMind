import { describe, expect, it } from 'vitest';
import { assertEvidenceOutsideCheckout, buildSandboxedProcessInvocation } from './native-sandbox.js';

describe('native process sandbox', () => {
  it('wraps unrestricted PowerShell and cmd text in a checkout-scoped networkless sandbox', () => {
    const powershell = buildSandboxedProcessInvocation({ sandboxExecutable: 'codex.exe', checkoutRoot: 'C:\\leases\\job', shell: 'powershell', command: 'project-build -All' });
    expect(powershell).toEqual({ executable: 'codex.exe', args: ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-C', 'C:\\leases\\job',
      '--sandbox-state-disable-network', '--', 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'project-build -All'] });
    expect(buildSandboxedProcessInvocation({ sandboxExecutable: 'codex.exe', checkoutRoot: 'C:\\leases\\job', shell: 'cmd', command: 'build.cmd /all' }).args)
      .toEqual(expect.arrayContaining(['--', 'cmd.exe', '/d', '/s', '/c', 'build.cmd /all']));
  });

  it('fails closed without the sandbox launcher', () => {
    expect(() => buildSandboxedProcessInvocation({ sandboxExecutable: '', checkoutRoot: 'C:\\leases\\job', shell: 'system', command: 'build' })).toThrow('sandbox executable');
  });
});

describe('native process evidence boundary', () => {
  it('rejects evidence controlled through the leased checkout', () => {
    expect(() => assertEvidenceOutsideCheckout('/leases/job', '/leases/job/.git/evidence.jsonl'))
      .toThrow('outside the AI-accessible checkout');
  });

  it('allows a runner-owned evidence path outside the checkout', () => {
    expect(() => assertEvidenceOutsideCheckout('/leases/job', '/runner-artifacts/job/evidence.jsonl'))
      .not.toThrow();
  });
});
