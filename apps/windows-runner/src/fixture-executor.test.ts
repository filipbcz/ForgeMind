import { describe, expect, it, vi } from 'vitest';
import { SafeFixtureExecutor, type FixtureExecutorDependencies, type FixtureExecutorPolicy } from './fixture-executor.js';

const policy: FixtureExecutorPolicy = {
  workspaceRoot: 'C:\\work', artifactRoot: 'C:\\work\\artifacts',
  allowedExecutablePaths: ['C:\\tools\\fixture.exe'], timeoutMs: 50,
  minimumFreeSpaceBytes: 100, maxConcurrentProcesses: 1
};
const profile = {
  kind: 'fixture-validation' as const, executablePath: 'C:\\tools\\fixture.exe',
  inputRelativePath: 'input.json', artifactRelativePath: 'result.json'
};

function harness(completion: Promise<number | null> = Promise.resolve(0), freeSpace = 1_000) {
  const terminateTree = vi.fn(async () => {});
  const dependencies: FixtureExecutorDependencies = {
    platform: 'win32', canonicalize: async (path) => path,
    freeSpaceBytes: async () => freeSpace,
    start: vi.fn(() => ({ pid: 42, completion })), terminateTree
  };
  return { executor: new SafeFixtureExecutor(dependencies), dependencies, terminateTree };
}

describe('SafeFixtureExecutor', () => {
  it('runs only the typed fixture profile without a shell', async () => {
    const { executor, dependencies } = harness();
    await expect(executor.execute(profile, policy)).resolves.toEqual({ status: 'succeeded', exitCode: 0 });
    expect(dependencies.start).toHaveBeenCalledWith('C:\\tools\\fixture.exe', [
      '--input', 'C:\\work\\input.json', '--artifact', 'C:\\work\\artifacts\\result.json'
    ], 'C:\\work');
    await expect(executor.execute({ ...profile, kind: 'raw-shell' } as never, policy)).rejects.toThrow(/raw shell/);
    await expect(executor.execute({ ...profile, executablePath: 'C:\\tools\\cmd.exe' }, policy)).rejects.toThrow(/not allowed/);
  });

  it.each([
    [{ ...profile, inputRelativePath: '..\\secret.txt' }, /traverse/],
    [{ ...profile, artifactRelativePath: '..\\outside.txt' }, /traverse/],
    [{ ...profile, artifactRelativePath: 'C:\\outside.txt' }, /relative/]
  ])('denies traversal and paths outside the workspace', async (unsafeProfile, message) => {
    const { executor } = harness();
    await expect(executor.execute(unsafeProfile, policy)).rejects.toThrow(message);
  });

  it('denies an existing artifact symlink that resolves outside the workspace', async () => {
    const { executor, dependencies } = harness();
    dependencies.canonicalize = async (candidate) => candidate === 'C:\\work\\artifacts\\result.json'
      ? 'C:\\outside\\redirected.json'
      : candidate;
    await expect(executor.execute(profile, policy)).rejects.toThrow(/inside the workspace/);
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it('blocks execution when the artifact volume has insufficient free space', async () => {
    const { executor, dependencies } = harness(Promise.resolve(0), 99);
    await expect(executor.execute(profile, policy)).rejects.toThrow(/insufficient free space/);
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'timed_out'] as const)('terminates the process tree when %s', async (reason) => {
    let finish!: (code: number) => void;
    const completion = new Promise<number>((resolve) => { finish = resolve; });
    const { executor, dependencies, terminateTree } = harness(completion);
    terminateTree.mockImplementation(async () => finish(1));
    const controller = new AbortController();
    const execution = executor.execute(profile, { ...policy, timeoutMs: reason === 'cancelled' ? 1_000 : 5 }, controller.signal);
    if (reason === 'cancelled') {
      await vi.waitFor(() => expect(dependencies.start).toHaveBeenCalledOnce());
      controller.abort();
    }
    await expect(execution).resolves.toEqual({ status: reason });
    expect(terminateTree).toHaveBeenCalledWith(42);
  });

  it('enforces its configured concurrency limit', async () => {
    let finish!: (code: number) => void;
    const pending = new Promise<number>((resolve) => { finish = resolve; });
    const { executor } = harness(pending);
    const first = executor.execute(profile, { ...policy, timeoutMs: 10_000 });
    await vi.waitFor(async () => expect(executor.execute(profile, policy)).rejects.toThrow(/concurrency/));
    finish(0);
    await first;
  });
});
