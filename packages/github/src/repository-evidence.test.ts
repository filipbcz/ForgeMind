import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBoundedRepositoryEvidence } from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('bounded repository planning evidence', () => {
  it('prioritizes useful text, inventories artifacts, redacts secrets, and respects the prompt limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgemind-repository-evidence-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'unreal', 'Source'), { recursive: true });
    await mkdir(join(root, 'Content', 'Screenshots'), { recursive: true });
    await writeFile(join(root, 'README.md'), `# Product architecture\n${'important '.repeat(500)}`);
    await writeFile(join(root, 'src', 'flight.cpp'), `class FlightModel {};\n${'source '.repeat(1_500)}`);
    await writeFile(join(root, 'unreal', 'Source', 'presentation.cpp'), 'class PresentationComponent {};');
    await writeFile(join(root, 'Content', 'Screenshots', 'baseline.ppm'), `P3\n${'255 255 255 '.repeat(20_000)}`);
    await writeFile(join(root, '.env'), 'OPENAI_API_KEY=must-not-enter-the-prompt');
    const paths = ['.env', 'Content/Screenshots/baseline.ppm', 'README.md', 'src/flight.cpp', 'unreal/Source/presentation.cpp'];

    const evidence = await buildBoundedRepositoryEvidence(root, 'a'.repeat(40), paths, 13_000);

    expect(evidence.length).toBeLessThanOrEqual(13_000);
    expect(evidence).toContain('Tracked path inventory (5 files)');
    expect(evidence).toContain('Content/Screenshots/baseline.ppm');
    expect(evidence).toContain('--- README.md');
    expect(evidence).toContain('--- src/flight.cpp');
    expect(evidence).toContain('--- unreal/Source/presentation.cpp');
    expect(evidence).not.toContain('must-not-enter-the-prompt');
    expect(evidence).not.toContain('255 255 255');
    expect(evidence).toContain('file excerpt truncated');
  });
});
