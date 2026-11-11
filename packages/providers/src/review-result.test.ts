import { describe, expect, it } from 'vitest';
import { parseReviewResult } from './provider.js';

describe('review result parsing', () => {
  it('normalizes structured provider blockers without losing their correction details', () => {
    const result = parseReviewResult(JSON.stringify({
      verdict: 'not_satisfied',
      summary: 'The roadmap needs one targeted correction.',
      blockers: [{
        affectedStep: 'Acquire regional data',
        issue: 'The source boundary is implicit.',
        correction: 'Name the configured geometry and its persisted manifest.',
        evidence: ['Tools/acquire.mjs', 'docs/regions.md']
      }],
      criterionResults: []
    }), 'Roadmap review');

    expect(result.blockers).toEqual([
      'affectedStep: Acquire regional data | issue: The source boundary is implicit. | correction: Name the configured geometry and its persisted manifest. | evidence: Tools/acquire.mjs; docs/regions.md'
    ]);
  });

  it('still rejects opaque blocker objects', () => {
    expect(() => parseReviewResult(JSON.stringify({
      verdict: 'not_satisfied',
      summary: 'The roadmap needs correction.',
      blockers: [{ code: 17, metadata: { source: 'unknown' } }],
      criterionResults: []
    }), 'Roadmap review')).toThrow('structured blocker must contain at least one non-empty string field');
  });
});
