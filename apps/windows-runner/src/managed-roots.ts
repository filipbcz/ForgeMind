import { access, mkdir, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export interface WindowsManagedRoots {
  work: string;
  inputs: string;
  sourceAssets: string;
  cache: string;
  outputs: string;
  diagnostics: string;
}

/** Creates canonical, sibling roots with distinct retention roles. Work and outputs
 * are task scoped; inputs/source assets are persistent; cache is reusable only;
 * diagnostics are retained independently for audit and recovery. */
export async function prepareWindowsManagedRoots(baseRoot: string): Promise<WindowsManagedRoots> {
  const base = resolve(baseRoot);
  const roots = {
    work: join(base, 'work'), inputs: join(base, 'inputs'), sourceAssets: join(base, 'source-assets'),
    cache: join(base, 'cache'), outputs: join(base, 'outputs'), diagnostics: join(base, 'diagnostics')
  };
  await Promise.all(Object.values(roots).map((path) => mkdir(path, { recursive: true })));
  const canonicalBase = await realpath(base);
  const canonical = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([role, path]) => [role, await realpath(path)]))) as unknown as WindowsManagedRoots;
  for (const path of Object.values(canonical)) {
    const rel = relative(canonicalBase, path);
    if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Managed root escapes the Windows runner base.');
  }
  return canonical;
}

/** Never removes work before the server confirms import. Persistent inputs and
 * source assets are never swept; cache and diagnostics use independent ages. */
export async function cleanupAcceptedWindowsAuthoring(roots: WindowsManagedRoots, taskId: string, retentionDays = 14, now = Date.now()): Promise<void> {
  if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId === '..') throw new Error('Invalid managed task id.');
  await Promise.all([rm(join(roots.work, taskId), { recursive: true, force: true }), rm(join(roots.outputs, taskId), { recursive: true, force: true })]);
  const acceptedDiagnostics = join(roots.diagnostics, taskId); await mkdir(acceptedDiagnostics, { recursive: true });
  await writeFile(join(acceptedDiagnostics, 'delivered.json'), JSON.stringify({ taskId, acceptedAt: new Date(now).toISOString() }), 'utf8');
  const cutoff = now - retentionDays * 86_400_000;
  for (const root of [roots.cache, roots.diagnostics]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (root === roots.diagnostics) {
        try { await access(join(path, 'delivered.json')); } catch { continue; }
      }
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    }
  }
}
