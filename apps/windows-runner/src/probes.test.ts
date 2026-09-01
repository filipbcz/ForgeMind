import { describe, expect, it } from 'vitest';
import { runCapabilityProbes } from './probes.js';

describe('capability probes', () => {
  it('advertises tool capabilities only when local probe evidence succeeds', async () => {
    const result = await runCapabilityProbes([
      { capability: { key: 'baseline' } },
      { capability: { key: 'missing-tool' }, executable: `definitely-missing-${process.pid}.exe` }
    ], new Date('2026-09-01T00:00:00.000Z'));
    expect(result.capabilities.map(({ key }) => key)).toEqual(['baseline']);
    expect(result.evidence).toEqual([
      expect.objectContaining({ capability: { key: 'baseline' }, status: 'supported', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ capability: { key: 'missing-tool' }, status: 'unsupported', evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]);
  });
});
