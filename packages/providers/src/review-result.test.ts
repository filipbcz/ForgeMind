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

  it('normalizes the complete set of common review aliases in one pass', () => {
    const result = parseReviewResult(JSON.stringify({
      verdict: 'changes required',
      conclusion: 'Two criteria need correction.',
      blockers: 'Fix the affected roadmap steps.',
      criterionResults: [
        { qualityCriterion: 'Actionable steps', result: 'pass', evidence: 'src/export.ts exists.' },
        { name: 'Dependencies', outcome: 'needs changes', findings: [{ file: 'src/plan.ts', finding: 'A dependency is absent.' }] },
        { criterionText: 'Repository proof', verdict: 'insufficient evidence', reasoning: 'No current test was cited.' },
        { title: 'Manual gate', status: 'blocked', details: ['User approval is intentionally pending.'] }
      ]
    }), 'Roadmap review');

    expect(result).toMatchObject({
      verdict: 'not_satisfied',
      summary: 'Two criteria need correction.',
      blockers: ['Fix the affected roadmap steps.'],
      criterionResults: [
        { criterion: 'Actionable steps', status: 'satisfied', evidence: ['src/export.ts exists.'] },
        { criterion: 'Dependencies', status: 'not_satisfied', evidence: ['file: src/plan.ts | finding: A dependency is absent.'] },
        { criterion: 'Repository proof', status: 'insufficient_evidence', evidence: ['No current test was cited.'] },
        { criterion: 'Manual gate', status: 'deferred', evidence: ['User approval is intentionally pending.'] }
      ]
    });
  });

  it('normalizes criterion maps and ignores unusable optional criterion metadata', () => {
    const mapped = parseReviewResult(JSON.stringify({
      verdict: true,
      summary: 'Ready.',
      blockers: null,
      criterionResults: {
        Coverage: { satisfied: true, evidence: ['Contract and roadmap agree.'] },
        Actionability: 'passed'
      }
    }), 'Roadmap review');
    expect(mapped.criterionResults).toEqual([
      { criterion: 'Coverage', status: 'satisfied', evidence: ['Contract and roadmap agree.'] },
      { criterion: 'Actionability', status: 'satisfied', evidence: [] }
    ]);

    const withoutAuxiliaryMetadata = parseReviewResult(JSON.stringify({
      verdict: 'satisfied', summary: 'Ready.', blockers: [], criterionResults: [{ score: 10 }]
    }), 'Roadmap review');
    expect(withoutAuxiliaryMetadata.criterionResults).toBeUndefined();
  });

  it('rejects a satisfied verdict that contradicts normalized criterion results', () => {
    expect(() => parseReviewResult(JSON.stringify({
      verdict: 'approved', summary: 'Ready.', blockers: [],
      criterionResults: [{ criterion: 'Coverage', status: 'failed', evidence: [] }]
    }), 'Roadmap review')).toThrow('cannot return a non-satisfied criterion');
  });
});
