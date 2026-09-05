import { describe, expect, it, vi } from 'vitest';
import type { AuditGapProposal } from '@forgemind/core';
import type { AIProvider, ReviewResult } from '@forgemind/providers';
import { reviewAndRepairAuditGapProposal } from './audit-gap-review.js';

function fixture() {
  const step = {
    title: 'Repair references', description: 'Repair incorrect documentation references.',
    acceptanceCriteria: ['References resolve.'], requirementIds: ['REQ-DOCS'], deliverables: ['Documentation'],
    changeRationale: 'docs/tracker.md references a missing file.', dependsOnStepTitles: [], validationFocus: ['regression' as const]
  };
  const proposal: AuditGapProposal = { kind: 'capability', summary: 'Documentation gaps.', commitSha: 'a'.repeat(40), newRequirements: [], steps: [step] };
  const satisfied: ReviewResult = { verdict: 'satisfied', summary: 'All remaining gaps are covered.', blockers: [] };
  const rejected: ReviewResult = { verdict: 'not_satisfied', summary: 'Need exact paths.', blockers: ['Name the replacement.'] };
  const provider = {
    kind: 'codex', supportsNativeRepositoryReview: () => true,
    reviewRoadmap: vi.fn<NonNullable<AIProvider['reviewRoadmap']>>().mockResolvedValue(satisfied),
    repairRoadmap: vi.fn<NonNullable<AIProvider['repairRoadmap']>>().mockResolvedValue({ implementationSteps: [{ ...step, inScope: [], outOfScope: [] }] })
  };
  const controller = new AbortController();
  const input: Parameters<typeof reviewAndRepairAuditGapProposal>[0] = {
    provider: provider as unknown as AIProvider, proposal,
    reviewInput: {
      taskId: 'audit', objective: 'Review documentation gaps.', authoritativeSpecification: 'Keep documentation truthful.',
      projectContract: { version: 1, summary: 'Docs', invariants: [], prohibitedSubstitutes: [],
        requirements: [{ id: 'REQ-DOCS', title: 'Docs', description: 'Truthful docs.', acceptanceCriteria: ['Accurate.'] }], releaseCriteria: [] },
      completedStepTitles: [], repositoryPath: '/checkout', repositoryBaseline: { commitSha: 'b'.repeat(40), evidence: 'x'.repeat(2_750_000) },
      signal: controller.signal
    },
    assertCurrentSource: vi.fn(async () => undefined), saveProposal: vi.fn(async () => undefined), saveReview: vi.fn(async () => undefined)
  };
  return { input, provider, controller, satisfied, rejected };
}

describe('audit proposal repair loop', () => {
  it('continues targeted repairs without a fixed retry count and gives each review the new candidate', async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.provider.reviewRoadmap.mockResolvedValueOnce({ ...f.rejected, blockers: [`Correction ${i}`] });
    const result = await reviewAndRepairAuditGapProposal(f.input);
    expect(result.review.verdict).toBe('satisfied');
    expect(f.provider.repairRoadmap).toHaveBeenCalledTimes(4);
    expect(f.provider.reviewRoadmap).toHaveBeenCalledTimes(5);
    expect(f.input.saveProposal).toHaveBeenCalledTimes(4);
    for (const [input] of f.provider.repairRoadmap.mock.calls) {
      expect(input.objective.length).toBeLessThan(10_000);
      expect(input.repositoryPath).toBe('/checkout');
    }
    for (const [input] of f.provider.reviewRoadmap.mock.calls) expect(input).not.toHaveProperty('session');
  });

  it('lets fresh independent review confirm that no original gap remains', async () => {
    const f = fixture(); f.input.previousReview = f.rejected;
    f.provider.repairRoadmap.mockResolvedValue({ implementationSteps: [] });
    expect((await reviewAndRepairAuditGapProposal(f.input)).proposal.steps).toEqual([]);
    expect(f.provider.reviewRoadmap).toHaveBeenCalledWith(expect.objectContaining({ implementationSteps: [], requiredRequirementIds: [] }));
    expect(f.input.saveProposal).toHaveBeenCalledOnce();
  });

  it('returns malformed repair output to AI without saving it as an executable proposal', async () => {
    const f = fixture(); f.input.previousReview = f.rejected;
    f.provider.repairRoadmap.mockResolvedValueOnce({ implementationSteps: [{ title: 'Incomplete' }] } as never);
    await reviewAndRepairAuditGapProposal(f.input);
    expect(f.provider.repairRoadmap).toHaveBeenCalledTimes(2);
    expect(f.provider.repairRoadmap.mock.calls[1]![0].validationError).toContain('structurally invalid');
    expect(f.input.saveProposal).toHaveBeenCalledTimes(1);
  });

  it('checks dropped gaps against the original proposal after resuming an empty revision', async () => {
    const f = fixture();
    f.input.originalProposal = f.input.proposal;
    f.input.proposal = { ...f.input.proposal, steps: [] };
    await reviewAndRepairAuditGapProposal(f.input);
    expect(f.provider.reviewRoadmap.mock.calls[0]![0].objective).toContain('docs/tracker.md references a missing file');
    expect(f.provider.repairRoadmap).not.toHaveBeenCalled();
  });

  it('does not silently apply a contract delta from the repair provider', async () => {
    const f = fixture(); f.input.previousReview = f.rejected;
    f.provider.repairRoadmap.mockResolvedValue({ implementationSteps: [], contractDelta: { baseVersion: 1 } } as never);
    await expect(reviewAndRepairAuditGapProposal(f.input)).rejects.toThrow('contract change');
    expect(f.input.saveProposal).not.toHaveBeenCalled();
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
  });

  it('saves a returned repair before honoring cancellation so a retry can resume at review', async () => {
    const f = fixture(); f.input.previousReview = f.rejected;
    f.provider.repairRoadmap.mockImplementationOnce(async () => {
      f.controller.abort(new Error('Disconnected.'));
      return { implementationSteps: [] };
    });
    await expect(reviewAndRepairAuditGapProposal(f.input)).rejects.toThrow('Disconnected.');
    expect(f.input.saveProposal).toHaveBeenCalledOnce();
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
  });
});
