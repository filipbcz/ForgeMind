import { spawn, type ChildProcess } from 'node:child_process';

export interface BoundedProcessResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  terminationReason?: 'cancelled' | 'timed-out' | 'missing-capability';
}

export interface BoundedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const PROCESS_CLOSE_GRACE_MS = 10_000;

/**
 * Runs a native process without a shell and owns its complete lifecycle. On
 * Windows, cancellation and timeout terminate the complete process tree and
 * wait for both taskkill and the original child before returning.
 */
export async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted) return { stdout: '', stderr: '', terminationReason: 'cancelled' };
  const child = spawn(executable, [...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderrBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer) => { stdoutBuffer = appendBounded(stdoutBuffer, chunk, maxOutputBytes); });
  child.stderr?.on('data', (chunk: Buffer) => { stderrBuffer = appendBounded(stderrBuffer, chunk, maxOutputBytes); });
  if (options.input === undefined) child.stdin?.end();
  else child.stdin?.end(options.input);

  let spawnError: NodeJS.ErrnoException | undefined;
  const completion = new Promise<number | undefined>((resolveCompletion) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
      stderrBuffer = appendBounded(stderrBuffer, Buffer.from(error.message), maxOutputBytes);
      resolveCompletion(undefined);
    });
    child.once('close', (code) => resolveCompletion(code ?? undefined));
  });

  let resolveControl!: (reason: 'cancelled' | 'timed-out') => void;
  const control = new Promise<'cancelled' | 'timed-out'>((resolve) => { resolveControl = resolve; });
  const timer = setTimeout(() => resolveControl('timed-out'), options.timeoutMs);
  const abortListener = () => resolveControl('cancelled');
  options.signal?.addEventListener('abort', abortListener, { once: true });

  try {
    const outcome = await Promise.race([completion, control]);
    if (outcome === 'cancelled' || outcome === 'timed-out') {
      await terminateProcessTree(child);
      await awaitChildClose(completion, child);
      return { stdout: stdoutBuffer.toString('utf8'), stderr: stderrBuffer.toString('utf8'), terminationReason: outcome };
    }
    return {
      exitCode: outcome,
      stdout: stdoutBuffer.toString('utf8'),
      stderr: stderrBuffer.toString('utf8'),
      ...(spawnError?.code === 'ENOENT' ? { terminationReason: 'missing-capability' as const } : {})
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortListener);
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  await new Promise<void>((resolveTermination) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveTermination();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish();
    }, PROCESS_CLOSE_GRACE_MS);
    killer.once('error', finish);
    killer.once('close', finish);
  });
}

async function awaitChildClose(completion: Promise<number | undefined>, child: ChildProcess): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<'grace-expired'>((resolveGrace) => {
    timer = setTimeout(() => resolveGrace('grace-expired'), PROCESS_CLOSE_GRACE_MS);
  });
  const outcome = await Promise.race([completion, grace]);
  if (timer) clearTimeout(timer);
  if (outcome !== 'grace-expired') return;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function appendBounded(existing: Buffer<ArrayBufferLike>, chunk: Uint8Array, maximum: number): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([existing, chunk]);
  return combined.length <= maximum ? combined : combined.subarray(combined.length - maximum);
}
