import { describe, expect, it } from 'vitest';
import { buildRoadmapQualityReviewPrompt, compactRoadmapContract, ROADMAP_QUALITY_CRITERIA } from './roadmap-review-prompt.js';

const contract = {
  version: 2,
  summary: 'Math practice application',
  invariants: ['Persisted answers remain compatible.'],
  prohibitedSubstitutes: ['Static screenshots.'],
  requirements: [
    {
      id: 'REQ-GENERATOR', title: 'Exercise generator', description: 'Generate grade-specific exercises.',
      acceptanceCriteria: ['Exercises obey grade rules.'], briefReferences: ['grade-specific exercises'], status: 'active' as const
    },
    {
      id: 'REQ-HISTORY', title: 'Exercise history', description: 'Preserve generated exercise history.',
      acceptanceCriteria: ['History remains readable.'], briefReferences: ['exercise history'], status: 'active' as const
    },
    {
      id: 'REQ-OLD', title: 'Old feature', description: 'Superseded behavior.',
      acceptanceCriteria: ['Old behavior.'], briefReferences: ['old'], status: 'superseded' as const
    }
  ],
  releaseCriteria: ['The application is usable.'],
  sourceBriefSnapshot: 'A very long source brief must not be duplicated into compact contract JSON.',
  sourceBriefHash: 'hash'
};

describe('roadmap quality review prompt', () => {
  it('uses only relevant active contract requirements and the candidate roadmap', () => {
    const compact = compactRoadmapContract(contract, ['REQ-GENERATOR']);
    expect(JSON.stringify(compact)).toContain('REQ-GENERATOR');
    expect(JSON.stringify(compact)).not.toContain('REQ-OLD');
    expect(JSON.stringify(compact)).not.toContain('sourceBriefSnapshot');

    const prompt = buildRoadmapQualityReviewPrompt({
      taskId: 'project_1',
      objective: 'Build grade-specific exercises.',
      projectContract: contract,
      requiredRequirementIds: ['REQ-GENERATOR'],
      completedStepTitles: ['Document scope'],
      implementationSteps: [{
        title: 'Build generator', description: 'Implement generation.', acceptanceCriteria: ['Grade rules are enforced.'],
        inScope: ['Generator'], outOfScope: ['UI'], requirementIds: ['REQ-GENERATOR', 'REQ-HISTORY'], deliverables: ['Generator module'],
        changeRationale: 'Implements the active requirement.', dependsOnStepTitles: [], validationFocus: ['implementation']
      }]
    });

    expect(prompt).toContain('Build grade-specific exercises.');
    expect(prompt).toContain('Build generator');
    expect(prompt).toContain('Document scope');
    expect(prompt).toContain('REQ-HISTORY');
    expect(prompt).toContain('Requirements that this roadmap must cover');
    expect(prompt).toContain('observable outcomes');
    expect(prompt).toContain(`one result for each quality criterion`);
    expect(ROADMAP_QUALITY_CRITERIA).toHaveLength(6);
  });
});
