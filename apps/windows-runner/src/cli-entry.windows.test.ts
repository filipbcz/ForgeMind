import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describeWindows('installed Windows runner entry point', () => {
  it('executes the built CLI main function', async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const result = await execute(process.execPath, [resolve(packageRoot, 'dist', 'cli.js')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--api-url is required.');
  });
});

function execute(executable: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    execFile(executable, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolveResult({ code: error?.code ?? 0, stderr });
    });
  });
}
