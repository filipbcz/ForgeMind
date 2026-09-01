import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, statfs } from 'node:fs/promises';
import { win32 as path } from 'node:path';

export interface FixtureCommandProfile {
  kind: 'fixture-validation';
  executablePath: string;
  inputRelativePath: string;
  artifactRelativePath: string;
}

export interface FixtureExecutorPolicy {
  workspaceRoot: string;
  artifactRoot: string;
  allowedExecutablePaths: readonly string[];
  timeoutMs: number;
  minimumFreeSpaceBytes: number;
  maxConcurrentProcesses: number;
}

export interface FixtureExecutionResult {
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  exitCode?: number;
}

interface RunningProcess {
  pid?: number;
  completion: Promise<number | null>;
}

export interface FixtureExecutorDependencies {
  platform: NodeJS.Platform;
  canonicalize(path: string): Promise<string>;
  freeSpaceBytes(path: string): Promise<number>;
  start(executable: string, args: readonly string[], cwd: string): RunningProcess;
  terminateTree(pid: number): Promise<void>;
}

const defaults: FixtureExecutorDependencies = {
  platform: process.platform,
  canonicalize: realpath,
  async freeSpaceBytes(path) {
    const stats = await statfs(path, { bigint: true });
    return Number(stats.bavail * stats.bsize);
  },
  start(executable, args, cwd) {
    const child: ChildProcess = spawn(executable, [...args], {
      cwd, shell: false, windowsHide: true, stdio: 'ignore'
    });
    return {
      pid: child.pid,
      completion: new Promise((resolveCompletion, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolveCompletion(code));
      })
    };
  },
  async terminateTree(pid) {
    await new Promise<void>((resolveCompletion, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore'
      });
      killer.once('error', reject);
      killer.once('close', (code) => code === 0 || code === 128
        ? resolveCompletion()
        : reject(new Error(`process-tree cancellation failed with code ${code}`)));
    });
  }
};

export class SafeFixtureExecutor {
  private active = 0;

  constructor(private readonly dependencies: FixtureExecutorDependencies = defaults) {}

  async execute(profile: FixtureCommandProfile, policy: FixtureExecutorPolicy, signal?: AbortSignal): Promise<FixtureExecutionResult> {
    validatePolicy(policy);
    if (this.dependencies.platform !== 'win32') throw new Error('fixture executor is Windows-only');
    if (profile.kind !== 'fixture-validation') throw new Error('raw shell and unknown command profiles are forbidden');
    if (this.active >= policy.maxConcurrentProcesses) throw new Error('fixture executor concurrency limit reached');

    this.active += 1;
    try {
      const workspaceRoot = await this.dependencies.canonicalize(policy.workspaceRoot);
      const artifactRoot = await this.dependencies.canonicalize(policy.artifactRoot);
      ensureWithin(workspaceRoot, artifactRoot, 'artifact root');
      const executable = await this.dependencies.canonicalize(profile.executablePath);
      const allowedExecutables = await Promise.all(policy.allowedExecutablePaths.map((path) => this.dependencies.canonicalize(path)));
      if (!allowedExecutables.some((allowed) => allowed.toLocaleLowerCase('en-US') === executable.toLocaleLowerCase('en-US'))) {
        throw new Error('fixture executable is not allowed');
      }

      const input = await canonicalWorkspacePath(this.dependencies, workspaceRoot, profile.inputRelativePath, 'input');
      const artifact = await guardedOutputPath(this.dependencies, workspaceRoot, artifactRoot, profile.artifactRelativePath);
      const freeSpace = await this.dependencies.freeSpaceBytes(artifactRoot);
      if (freeSpace < policy.minimumFreeSpaceBytes) throw new Error('insufficient free space for fixture execution');
      if (signal?.aborted) return { status: 'cancelled' };

      const running = this.dependencies.start(executable, ['--input', input, '--artifact', artifact], workspaceRoot);
      if (!running.pid) throw new Error('fixture process did not expose a process id');
      return await awaitCompletion(running, policy.timeoutMs, signal, this.dependencies.terminateTree);
    } finally {
      this.active -= 1;
    }
  }
}

function validatePolicy(policy: FixtureExecutorPolicy): void {
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0) throw new Error('timeout must be a positive integer');
  if (!Number.isSafeInteger(policy.minimumFreeSpaceBytes) || policy.minimumFreeSpaceBytes < 0) throw new Error('minimum free space must be a non-negative integer');
  if (!Number.isSafeInteger(policy.maxConcurrentProcesses) || policy.maxConcurrentProcesses <= 0) throw new Error('concurrency must be a positive integer');
  if (policy.allowedExecutablePaths.length === 0) throw new Error('at least one fixture executable must be allowed');
}

function ensureRelative(relativePath: string, label: string): void {
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || relativePath.includes('\\..\\') || relativePath.endsWith('\\..') || relativePath.startsWith('/') || relativePath.includes('/../') || path.isAbsolute(relativePath)) throw new Error(`${label} path must be relative and cannot traverse`);
}

function ensureWithin(root: string, candidate: string, label: string): void {
  const child = path.relative(root, candidate);
  if (child === '..' || child.startsWith('..\\') || path.isAbsolute(child)) {
    throw new Error(`${label} must remain inside the workspace`);
  }
}

async function canonicalWorkspacePath(dependencies: FixtureExecutorDependencies, root: string, relativePath: string, label: string): Promise<string> {
  ensureRelative(relativePath, label);
  const canonical = await dependencies.canonicalize(path.resolve(root, relativePath));
  ensureWithin(root, canonical, label);
  return canonical;
}

async function guardedOutputPath(dependencies: FixtureExecutorDependencies, workspaceRoot: string, artifactRoot: string, relativePath: string): Promise<string> {
  ensureRelative(relativePath, 'artifact');
  const candidate = path.resolve(artifactRoot, relativePath);
  const parent = await dependencies.canonicalize(path.dirname(candidate));
  ensureWithin(workspaceRoot, parent, 'artifact');
  ensureWithin(artifactRoot, parent, 'artifact');
  const guardedCandidate = path.resolve(parent, path.basename(candidate));
  try {
    const existingCandidate = await dependencies.canonicalize(guardedCandidate);
    ensureWithin(workspaceRoot, existingCandidate, 'artifact');
    ensureWithin(artifactRoot, existingCandidate, 'artifact');
    return existingCandidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return guardedCandidate;
  }
}

async function awaitCompletion(
  running: RunningProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  terminateTree: (pid: number) => Promise<void>
): Promise<FixtureExecutionResult> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const control = new Promise<'cancelled' | 'timed_out'>((resolveControl) => {
    timer = setTimeout(() => resolveControl('timed_out'), timeoutMs);
    if (signal) {
      abortListener = () => resolveControl('cancelled');
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  try {
    const outcome = await Promise.race([running.completion, control]);
    if (outcome === 'cancelled' || outcome === 'timed_out') {
      await terminateTree(running.pid!);
      await running.completion;
      return { status: outcome };
    }
    return { status: outcome === 0 ? 'succeeded' : 'failed', exitCode: outcome ?? undefined };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
