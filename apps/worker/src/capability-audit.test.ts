import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import {
  buildTargetedRepositoryContext,
  buildEvidenceLineageContext,
  rebindTreeEquivalentEvidence,
  selectCapabilityExecutionEvidence,
  selectReleaseExecutionEvidence
} from './capability-audit.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('buildTargetedRepositoryContext', () => {
  it('includes every tracked source and test file in the complete snapshot', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-audit-context-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'apps', 'web', 'src'), { recursive: true });
    await mkdir(join(workspace, 'apps', 'web', 'test'), { recursive: true });
    await writeFile(join(workspace, 'apps', 'web', 'src', 'App.tsx'), 'export const auditSourceMarker = "current-user-restoration";\n');
    for (let index = 0; index < 20; index += 1) {
      await writeFile(
        join(workspace, 'apps', 'web', 'test', `auth-${index}.test.ts`),
        `export const fixture${index} = ${JSON.stringify('test-content-'.repeat(700))};\n`
      );
    }
    const git = simpleGit({ baseDir: workspace });
    await git.init();
    await git.add('.');

    const packet = await buildTargetedRepositoryContext(workspace, ['authenticated shell restores current user']);

    expect(packet).toContain('--- apps/web/src/App.tsx ---');
    expect(packet).toContain('current-user-restoration');
    expect(packet).toContain('--- apps/web/test/auth-19.test.ts ---');
  });

  it('keeps root manifest and lockfile content alongside source and tests', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-audit-context-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(join(workspace, 'tests'), { recursive: true });
    await writeFile(join(workspace, 'package.json'), '{"name":"audit-manifest-marker"}\n');
    await writeFile(join(workspace, 'package-lock.json'), '{"lockfileVersion":3,"auditLockMarker":true}\n');
    await writeFile(join(workspace, 'src', 'index.ts'), 'export const sourceMarker = true;\n');
    await writeFile(join(workspace, 'tests', 'index.test.ts'), 'export const testMarker = true;\n');
    const git = simpleGit({ baseDir: workspace });
    await git.init();
    await git.add('.');

    const packet = await buildTargetedRepositoryContext(workspace);

    expect(packet).toContain('audit-manifest-marker');
    expect(packet).toContain('auditLockMarker');
    expect(packet).toContain('sourceMarker');
    expect(packet).toContain('testMarker');
  });

  it('includes complete content from a large test file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-audit-context-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'packages', 'db', 'test', 'integration'), { recursive: true });
    const filler = Array.from({ length: 180 }, (_, index) => `const fixture${index} = ${JSON.stringify('x'.repeat(70))};`);
    filler.splice(90, 0, 'test("WorkItem repository round trip preserves every field", async () => { /* workitem-round-trip-marker */ });');
    await writeFile(join(workspace, 'packages', 'db', 'test', 'integration', 'identity.test.mjs'), `${filler.join('\n')}\n`);
    const git = simpleGit({ baseDir: workspace });
    await git.init();
    await git.add('.');

    const packet = await buildTargetedRepositoryContext(workspace, ['WorkItem repository round trip']);

    expect(packet).toContain('workitem-round-trip-marker');
    expect(packet).toContain('const fixture0');
    expect(packet).toContain('const fixture179');
  });

  it('does not discard files when one criterion points at a focused test', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-audit-context-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'tests'), { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      await writeFile(
        join(workspace, 'tests', `a-irrelevant-${index}.test.cpp`),
        `const char* fixture${index} = ${JSON.stringify('irrelevant-content-'.repeat(500))};\n`
      );
    }
    const focusedLines = Array.from({ length: 180 }, (_, index) => `const auto filler${index} = ${JSON.stringify('x'.repeat(70))};`);
    focusedLines.splice(90, 0, 'expect(showMissing.error == "exact missing show diagnostic"); // focused-show-marker');
    await writeFile(join(workspace, 'tests', 'z-cli-runner.test.cpp'), `${focusedLines.join('\n')}\n`);
    const git = simpleGit({ baseDir: workspace });
    await git.init();
    await git.add('.');

    const packet = await buildTargetedRepositoryContext(workspace, ['exact missing show diagnostic']);

    expect(packet).toContain('--- tests/z-cli-runner.test.cpp ---');
    expect(packet).toContain('focused-show-marker');
    expect(packet).toContain('--- tests/a-irrelevant-0.test.cpp ---');
  });
});

describe('selectReleaseExecutionEvidence', () => {
  it('adds current cross-cutting validation without leaking unrelated ancestor evidence', () => {
    const selected = selectCapabilityExecutionEvidence([
      { requirementId: 'build', source: 'validation_command', status: 'passed', criterion: 'Build', command: 'npm run build', commitSha: 'ancestor' },
      { requirementId: 'docs', source: 'validation_command', status: 'passed', criterion: 'Regression', command: 'npm test', commitSha: 'current' },
      { requirementId: 'docs', source: 'validation_command', status: 'passed', criterion: 'Docs only', command: 'npm run test:docs', commitSha: 'ancestor' }
    ], 'build', 'current');

    expect(selected.map((item) => item.command)).toEqual(['npm run build', 'npm test']);
  });

  it('keeps specialized ancestor checks while preferring the latest result for repeated commands', () => {
    const selected = selectReleaseExecutionEvidence([
      { source: 'validation_command', status: 'passed', criterion: 'Browser works', command: 'npm run test:browser', commitSha: 'ancestor' },
      { source: 'validation_command', status: 'passed', criterion: 'Build works', command: 'npm run build', commitSha: 'ancestor' },
      { source: 'validation_command', status: 'passed', criterion: 'Build still works', command: 'npm run build', commitSha: 'current' },
      { source: 'validation_command', status: 'passed', criterion: 'Compose works', command: 'npm run test:compose', commitSha: 'ancestor' }
    ], 'current', 3);

    expect(selected.map((item) => item.command)).toEqual([
      'npm run build',
      'npm run test:compose',
      'npm run test:browser'
    ]);
    expect(selected[0]?.commitSha).toBe('current');
  });

  it('keeps deferred Windows checks visible within the bounded release evidence', () => {
    const selected = selectReleaseExecutionEvidence([
      { source: 'validation_command', status: 'passed', criterion: 'Portable check', command: 'npm test', commitSha: 'current' },
      { source: 'validation_command', status: 'deferred', criterion: 'Win64 starts', command: 'Flying.exe --smoke', commitSha: 'ancestor' },
      { source: 'validation_command', status: 'passed', criterion: 'Build', command: 'npm run build', commitSha: 'current' }
    ], 'current', 2);

    expect(selected.map((item) => item.command)).toEqual(['Flying.exe --smoke', 'npm run build']);
  });

  it('rebinds trusted evidence when squash merge metadata changed but the Git tree is identical', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-audit-tree-'));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, 'result.txt'), 'validated content\n');
    const git = simpleGit({ baseDir: workspace });
    await git.init();
    await git.addConfig('user.name', 'ForgeMind Test');
    await git.addConfig('user.email', 'forgemind@example.test');
    await git.add('.');
    await git.commit('validated branch commit');
    const validatedCommit = (await git.revparse(['HEAD'])).trim();
    await git.raw(['commit', '--allow-empty', '-m', 'squash merge metadata']);
    const mergedCommit = (await git.revparse(['HEAD'])).trim();

    const rebound = await rebindTreeEquivalentEvidence(workspace, [
      { criterion: 'Release validation', commitSha: validatedCommit }
    ], mergedCommit);

    expect(rebound[0]?.commitSha).toBe(mergedCommit);
  });

  it('shows exactly which files changed after trusted ancestor validation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-audit-lineage-'));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, 'tests', 'e2e'), { recursive: true });
    await writeFile(join(workspace, 'tests', 'e2e', 'release.spec.mjs'), 'export const validated = true;\n');
    const git = simpleGit({ baseDir: workspace });
    await git.init();
    await git.addConfig('user.name', 'ForgeMind Test');
    await git.addConfig('user.email', 'forgemind@example.test');
    await git.add('.');
    await git.commit('validated e2e');
    const validatedCommit = (await git.revparse(['HEAD'])).trim();
    await writeFile(join(workspace, 'README.md'), '# Operations\n');
    await git.add('.');
    await git.commit('document operations');
    const currentCommit = (await git.revparse(['HEAD'])).trim();

    const context = await buildEvidenceLineageContext(workspace, [{ commitSha: validatedCommit }], currentCommit);

    expect(context).toContain('files changed afterward: README.md');
    expect(context).not.toContain('tests/e2e/release.spec.mjs');
  });
});
