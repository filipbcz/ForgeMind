import { describe, expect, it } from 'vitest';
import { assertEvidenceOutsideCheckout, buildSandboxedExecutableInvocation, buildSandboxedProcessInvocation,
  buildUnrealAuthoringArgs, containsUnrealEditorInvocation } from './native-sandbox.js';

describe('native process sandbox', () => {
  it('wraps unrestricted PowerShell and cmd text in a checkout-scoped networkless sandbox', () => {
    const powershell = buildSandboxedProcessInvocation({ sandboxExecutable: 'codex.exe', checkoutRoot: 'C:\\leases\\job', shell: 'powershell', command: 'project-build -All' });
    expect(powershell).toEqual({ executable: 'codex.exe', args: ['sandbox', '--permission-profile', ':workspace', '-C', 'C:\\leases\\job',
      '--', 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'project-build -All'] });
    expect(buildSandboxedProcessInvocation({ sandboxExecutable: 'codex.exe', checkoutRoot: 'C:\\leases\\job', shell: 'cmd', command: 'build.cmd /all' }).args)
      .toEqual(expect.arrayContaining(['--', 'cmd.exe', '/d', '/s', '/c', 'build.cmd /all']));
  });

  it('fails closed without the sandbox launcher', () => {
    expect(() => buildSandboxedProcessInvocation({ sandboxExecutable: '', checkoutRoot: 'C:\\leases\\job', shell: 'system', command: 'build' })).toThrow('sandbox executable');
  });

  it('passes native executables and arguments directly without PowerShell reparsing quoted paths', () => {
    expect(buildSandboxedExecutableInvocation({ sandboxExecutable: 'codex.exe', checkoutRoot: 'C:\\leases\\job',
      executable: 'C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
      args: ['C:\\leases\\job\\Game.uproject', '-unattended'] })).toEqual({
      executable: 'codex.exe',
      args: ['sandbox', '--permission-profile', ':workspace', '-C', 'C:\\leases\\job', '--',
        'C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
        'C:\\leases\\job\\Game.uproject', '-unattended']
    });
  });

  it('adds reliable Unreal automation flags once and reserves NullRHI for load verification', () => {
    const authored = buildUnrealAuthoringArgs('C:\\work\\Game.uproject', ['-NoSplash', '-ExecutePythonScript=author.py'], 'author');
    expect(authored).toEqual(expect.arrayContaining(['C:\\work\\Game.uproject', '-unattended', '-RUNNINGUNATTENDEDSCRIPT',
      '-nop4', '-NoSplash', '-DDC-ForceMemoryCache', '-NoSaveConfig', '-NoEpicPortal', '-stdout', '-FullStdOutLogOutput']));
    expect(authored.filter((arg) => arg.toLowerCase() === '-nosplash')).toHaveLength(1);
    expect(authored).not.toContain('-NullRHI');
    expect(buildUnrealAuthoringArgs('C:\\work\\Game.uproject', [], 'verify')).toContain('-NullRHI');
  });

  it('recognizes direct and wrapped UnrealEditor commands that must use the structured tool', () => {
    expect(containsUnrealEditorInvocation("& 'C:\\Program Files\\Epic Games\\UE_5.8\\UnrealEditor-Cmd.exe' Game.uproject")).toBe(true);
    expect(containsUnrealEditorInvocation('npm test')).toBe(false);
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
