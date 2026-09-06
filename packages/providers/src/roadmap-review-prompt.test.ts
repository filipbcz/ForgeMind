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
      repositoryBaseline: { commitSha: 'a'.repeat(40), evidence: 'src/generator.ts lacks grade-specific rules and exports createExercise().' },
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
    expect(prompt).toContain('existing repository components');
    expect(prompt).toContain('Reject self-referential commit-chasing steps');
    expect(prompt).toContain('A different HEAD alone is not an implementation gap');
    expect(ROADMAP_QUALITY_CRITERIA).toHaveLength(7);
  });

  it('rejects review without commit-bound repository evidence', () => {
    expect(() => buildRoadmapQualityReviewPrompt({
      taskId: 'project_1', objective: 'Build exercises.', projectContract: contract,
      requiredRequirementIds: ['REQ-GENERATOR'], completedStepTitles: [], implementationSteps: []
    })).toThrow('Commit-bound repository baseline is required');
  });

  it('uses a native read-only checkout without embedding repository contents', () => {
    const completeRepositorySnapshot = `--- package-lock.json ---\n${'x'.repeat(1_100_000)}`;
    const prompt = buildRoadmapQualityReviewPrompt({
      taskId: 'project_1', objective: 'Build exercises.', projectContract: contract,
      requiredRequirementIds: ['REQ-GENERATOR'], completedStepTitles: [], implementationSteps: [],
      repositoryPath: '/tmp/read-only-repository', nativeRepositoryAccess: true,
      repositoryBaseline: { commitSha: 'b'.repeat(40), evidence: completeRepositorySnapshot }
    });

    expect(prompt).toContain('inspect the complete read-only checkout');
    expect(prompt).toContain('current working directory');
    expect(prompt).not.toContain(completeRepositorySnapshot);
    expect(prompt.length).toBeLessThan(10_000);
  });

  it('requires a repository path for native review', () => {
    expect(() => buildRoadmapQualityReviewPrompt({
      taskId: 'project_1', objective: 'Build exercises.', projectContract: contract,
      requiredRequirementIds: ['REQ-GENERATOR'], completedStepTitles: [], implementationSteps: [],
      nativeRepositoryAccess: true,
      repositoryBaseline: { commitSha: 'b'.repeat(40), evidence: 'snapshot' }
    })).toThrow('requires a read-only repository path');
  });
});
