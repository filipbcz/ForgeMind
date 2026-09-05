import { access, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAcceptedWindowsAuthoring, prepareWindowsManagedRoots } from './managed-roots.js';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('Windows managed roots', () => {
  it('creates separate canonical roots for every retention role', async () => {
    const base = await mkdtemp(join(tmpdir(), 'forgemind-windows-roots-')); created.push(base);
    const roots = await prepareWindowsManagedRoots(base);
    expect(Object.keys(roots).sort()).toEqual(['cache', 'diagnostics', 'inputs', 'outputs', 'sourceAssets', 'work']);
    expect(new Set(Object.values(roots)).size).toBe(6);
    const canonicalBase = await realpath(base);
    for (const path of Object.values(roots)) expect(relative(canonicalBase, path)).not.toMatch(/^\.\./);
  });
  it('removes accepted task work without sweeping persistent source data', async () => {
    const base = await mkdtemp(join(tmpdir(), 'forgemind-windows-cleanup-')); created.push(base);
    const roots = await prepareWindowsManagedRoots(base);
    await Promise.all([mkdir(join(roots.work, 'task-1')), mkdir(join(roots.outputs, 'task-1'))]);
    await writeFile(join(roots.inputs, 'region.gpkg'), 'persistent'); await writeFile(join(roots.sourceAssets, 'source.uasset'), 'persistent');
    const unfinished = join(roots.diagnostics, 'unfinished'); await mkdir(unfinished); await writeFile(join(unfinished, 'authoring-checkpoint.json'), '{}');
    await utimes(unfinished, new Date(0), new Date(0));
    await cleanupAcceptedWindowsAuthoring(roots, 'task-1');
    await expect(access(join(roots.work, 'task-1'))).rejects.toThrow();
    await expect(access(join(roots.inputs, 'region.gpkg'))).resolves.toBeUndefined();
    await expect(access(join(roots.sourceAssets, 'source.uasset'))).resolves.toBeUndefined();
    await expect(access(join(unfinished, 'authoring-checkpoint.json'))).resolves.toBeUndefined();
  });
});
