import { describe, expect, it } from 'vitest';
import { runBoundedProcess } from './process-runner.js';

const itWindows = process.platform === 'win32' ? it : it.skip;

describe('bounded native process runner', () => {
  it('captures successful output and input', async () => {
    const result = await runBoundedProcess(process.execPath, ['-e', "process.stdin.on('data', value => process.stdout.write(value))"], {
      input: 'probe-input',
      timeoutMs: 2_000
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'probe-input', stderr: '' });
  });

  it('waits for a timed-out process to close before returning', async () => {
    const startedAt = Date.now();
    const result = await runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 });
    expect(result).toMatchObject({ terminationReason: 'timed-out' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('returns missing-capability evidence for a nonexistent executable', async () => {
    const result = await runBoundedProcess(`forgemind-missing-${process.pid}`, [], { timeoutMs: 1_000 });
    expect(result).toMatchObject({ terminationReason: 'missing-capability' });
  });

  itWindows('terminates a complete Windows process tree before returning', async () => {
    const grandchildScript = 'setInterval(() => {}, 1000)';
    const parentScript = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'ignore'});process.stdout.write(String(child.pid));setInterval(()=>{},1000)`;
    const result = await runBoundedProcess(process.execPath, ['-e', parentScript], { timeoutMs: 500 });
    expect(result.terminationReason).toBe('timed-out');
    const grandchildPid = Number(result.stdout);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });
});
