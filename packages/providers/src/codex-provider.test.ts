import { describe, expect, it, vi } from 'vitest';
import { runCodexProcess } from './codex-provider.js';

describe('Codex process activity timeouts', () => {
  it('keeps an active process alive past the inactivity timeout', async () => {
    const onActivity = vi.fn();

    await runCodexProcess(
      [
        '-e',
        "process.stderr.write('started\\n');const timer=setInterval(()=>process.stderr.write('tick\\n'),25);setTimeout(()=>{clearInterval(timer);process.exit(0)},1000)"
      ],
      '',
      {
        binary: process.execPath,
        inactivityTimeoutMs: 500,
        maxRuntimeMs: 3_000,
        onActivity
      }
    );

    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stderr' }));
  });

  it('stops a process after sustained inactivity', async () => {
    const execution = runCodexProcess(['-e', 'setTimeout(()=>process.exit(0),2000)'], '', {
      binary: process.execPath,
      inactivityTimeoutMs: 100,
      maxRuntimeMs: 2_000
    });

    await expect(execution).rejects.toMatchObject({
      name: 'CodexExecutionTimeoutError',
      reason: 'inactivity'
    });
  });

  it('enforces a maximum runtime even while activity continues', async () => {
    const execution = runCodexProcess(
      ['-e', "setInterval(()=>process.stdout.write('active\\n'),20)"],
      '',
      {
        binary: process.execPath,
        inactivityTimeoutMs: 500,
        maxRuntimeMs: 150
      }
    );

    await expect(execution).rejects.toMatchObject({
      name: 'CodexExecutionTimeoutError',
      reason: 'max_runtime'
    });
  });
});
