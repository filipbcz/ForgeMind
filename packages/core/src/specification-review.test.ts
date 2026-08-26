import { describe, expect, it } from 'vitest';
import { buildSpecificationChangeImpactReview } from './specification-review.js';

describe('specification change impact review', () => {
  it('shows a diff and impact for requirements, unfinished steps, and evidence before persistence', () => {
    const review = buildSpecificationChangeImpactReview({
      projectId: 'project_1',
      currentSpecification: {
        id: 'spec_1',
        projectId: 'project_1',
        version: 1,
        fullSpecification: 'Build reporting.\nKeep audit logs.',
        changeSummary: 'Initial brief.',
        source: 'initial_brief',
        createdAt: '2026-08-01T10:00:00.000Z'
      },
      proposedSpecification: 'Build reporting with export.\nKeep audit logs.',
      requirements: [{
        id: 'REQ-REPORTING',
        title: 'Reporting',
        description: 'Build reporting.',
        acceptanceCriteria: ['Reports render.'],
        briefReferences: ['reporting']
      }],
      steps: [{
        id: 'step_1',
        projectId: 'project_1',
        cycleId: 'cycle_1',
        sequenceNumber: 1,
        title: 'Build reports',
        description: 'Implement reports.',
        acceptanceCriteria: ['Reports render.'],
        requirementIds: ['REQ-REPORTING'],
        deliverables: ['Report screen'],
        changeRationale: 'Required by reporting.',
        dependsOnStepTitles: [],
        validationFocus: ['implementation'],
        status: 'pending',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z'
      }],
      evidence: [{
        id: 'evidence_1',
        projectId: 'project_1',
        cycleId: 'cycle_1',
        requirementId: 'REQ-REPORTING',
        criterionKey: 'Reports render.',
        criterion: 'Reports render.',
        source: 'repository_audit',
        status: 'passed',
        evidenceKey: 'audit:reports',
        contractVersion: 1,
        payload: {},
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z'
      }]
    });

    expect(review.changed).toBe(true);
    expect(review.diff.map((line) => line.type)).toContain('removed');
    expect(review.diff.map((line) => line.type)).toContain('added');
    expect(review.impact.requirements).toEqual([expect.objectContaining({ id: 'REQ-REPORTING' })]);
    expect(review.impact.unfinishedSteps).toEqual([expect.objectContaining({ id: 'step_1' })]);
    expect(review.impact.evidence).toEqual([expect.objectContaining({ id: 'evidence_1' })]);
  });
});
