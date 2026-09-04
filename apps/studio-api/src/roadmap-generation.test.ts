import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { RoadmapGenerationCheckpoint } from '@forgemind/core';
import type { AIProvider, ImplementationStepPlan, PlanResult } from '@forgemind/providers';
import { buildReviewedImplementationStepBlueprints, buildImplementationStepBlueprintsWithRepairs, repairRoadmapOnce } from './roadmap-generation.js';
import { beginRoadmapRequest } from './routes.js';

const step: ImplementationStepPlan = {
  title: 'Implement export', description: 'Export records.', acceptanceCriteria: ['Records can be exported.'],
  inScope: ['Export'], outOfScope: [], requirementIds: ['REQ-EXPORT'], deliverables: ['Export module'],
  changeRationale: 'Add the approved export capability.', dependsOnStepTitles: [], validationFocus: ['implementation']
};
const plan: PlanResult = { summary: 'Export', steps: [], acceptanceCriteria: [], implementationSteps: [step] };
const projectContract = { version: 1, summary: 'Export', invariants: [], prohibitedSubstitutes: [], requirements: [], releaseCriteria: [] };
const satisfied = { verdict: 'satisfied' as const, summary: 'Ready.', blockers: [] };
const rejected = { verdict: 'not_satisfied' as const, summary: 'Fix export.', blockers: ['Add an observable export outcome.'] };

function fixture() {
  const repairRoadmap = vi.fn().mockResolvedValue({ implementationSteps: [step] });
  const reviewRoadmap = vi.fn().mockResolvedValue(satisfied);
  const history: RoadmapGenerationCheckpoint[] = [];
  const input = {
    provider: { kind: 'codex', repairRoadmap, reviewRoadmap } as unknown as AIProvider,
    session: { id: 'planning-session' }, plan,
    repairInput: { taskId: 'project', objective: 'Export', projectContract, requiredRequirementIds: ['REQ-EXPORT'], completedStepTitles: [], migrationImpacts: [], compatibilityImpacts: [] },
    reviewInput: { taskId: 'project', objective: 'Export', projectContract, requiredRequirementIds: ['REQ-EXPORT'], completedStepTitles: [] },
    validate: vi.fn((candidate: PlanResult) => candidate.implementationSteps!),
    onCheckpoint: vi.fn(async (checkpoint: RoadmapGenerationCheckpoint) => { history.push(structuredClone(checkpoint)); })
  };
  return { input, repairRoadmap, reviewRoadmap, history };
}

describe('resumable roadmap correction', () => {
  it('applies an explicit contract removal instead of adding obsolete approval work', async () => {
    const staleContract = {
      version: 1, summary: 'Export', invariants: [], prohibitedSubstitutes: [], releaseCriteria: [],
      requirements: [{
        id: 'REQ-APPROVAL', title: 'Approval', description: 'Require approval before export.',
        acceptanceCriteria: ['An approval is recorded.'], status: 'active' as const,
        introducedInVersion: 1, lastChangedInVersion: 1
      }]
    };
    const provider = {
      kind: 'codex', repairRoadmap: vi.fn().mockResolvedValue({
        implementationSteps: [],
        contractDelta: {
          baseVersion: 1, addRequirements: [], updateRequirements: [], supersedeRequirements: [],
          removeRequirements: [{ id: 'REQ-APPROVAL', rationale: 'The complete current specification explicitly removed approval.' }],
          invariantChanges: { add: [], remove: [] },
          prohibitedSubstituteChanges: { add: [], remove: [] },
          releaseCriteriaChanges: { add: [], remove: [] },
          migrationImpacts: [], compatibilityImpacts: []
        }
      })
    } as unknown as AIProvider;
    const repaired = await repairRoadmapOnce(provider, {}, {
      ...plan, implementationSteps: [{ ...step, requirementIds: ['REQ-APPROVAL'] }]
    }, {
      taskId: 'project', objective: 'Export immediately', authoritativeSpecification: 'Export has no approval gate.',
      validationError: 'Contract contradicts the current specification.', projectContract: staleContract,
      requiredRequirementIds: ['REQ-APPROVAL'], completedStepTitles: [], migrationImpacts: [], compatibilityImpacts: []
    });

    expect(repaired.projectContract?.version).toBe(1);
    expect(repaired.projectContract?.requirements[0]).toMatchObject({
      id: 'REQ-APPROVAL', status: 'removed', introducedInVersion: 1, lastChangedInVersion: 1
    });
    expect(repaired.contractDelta).toBeUndefined();
    expect(repaired.implementationSteps).toEqual([]);
  });

  it('preserves the latest-plus-one output version when repairing from a historical recovery base', async () => {
    const historical = {
      version: 1, summary: 'Export', invariants: [], prohibitedSubstitutes: [], releaseCriteria: [],
      requirements: [{
        id: 'REQ-APPROVAL', title: 'Approval', description: 'Require approval.',
        acceptanceCriteria: ['Approval is recorded.'], status: 'active' as const,
        introducedInVersion: 1, lastChangedInVersion: 1
      }]
    };
    const candidate = { ...historical, version: 4, sourceBriefHash: 'current-hash', sourceBriefSnapshot: 'No approval.' };
    const repairDelta = {
      baseVersion: 4, addRequirements: [], updateRequirements: [], supersedeRequirements: [],
      removeRequirements: [{ id: 'REQ-APPROVAL', rationale: 'Current specification removed approval.' }],
      invariantChanges: { add: [], remove: [] }, prohibitedSubstituteChanges: { add: [], remove: [] },
      releaseCriteriaChanges: { add: [], remove: [] }, migrationImpacts: [], compatibilityImpacts: []
    };
    const provider = {
      kind: 'codex', repairRoadmap: vi.fn().mockResolvedValue({ implementationSteps: [], contractDelta: repairDelta })
    } as unknown as AIProvider;

    const repaired = await repairRoadmapOnce(provider, {}, plan, {
      taskId: 'project', objective: 'Recover export', authoritativeSpecification: 'No approval.',
      validationError: 'Stale approval.', projectContract: candidate, persistedProjectContract: historical,
      requiredRequirementIds: ['REQ-APPROVAL'], completedStepTitles: [], migrationImpacts: [], compatibilityImpacts: []
    });

    expect(repaired.projectContract).toMatchObject({
      version: 4, sourceBriefHash: 'current-hash', sourceBriefSnapshot: 'No approval.'
    });
    expect(repaired.contractDelta).toMatchObject({ baseVersion: 1, removeRequirements: [{ id: 'REQ-APPROVAL' }] });
  });

  it('continues beyond two quality repairs and keeps every independent review outcome', async () => {
    const f = fixture();
    f.reviewRoadmap.mockResolvedValueOnce(rejected).mockResolvedValueOnce(rejected).mockResolvedValueOnce(rejected);
    const result = await buildReviewedImplementationStepBlueprints(f.input);
    expect(result.qualityReview.verdict).toBe('satisfied');
    expect(f.repairRoadmap).toHaveBeenCalledTimes(3);
    expect(f.reviewRoadmap).toHaveBeenCalledTimes(4);
    expect(f.history.filter(s => s.qualityReview?.verdict === 'not_satisfied')).toHaveLength(3);
    expect(f.history.at(-1)).toMatchObject({ phase: 'ready', revision: 3 });
    for (const [reviewInput] of f.reviewRoadmap.mock.calls) expect(reviewInput).not.toHaveProperty('session');
  });

  it('continues beyond two structural repairs', async () => {
    const f = fixture();
    f.input.validate.mockImplementationOnce(() => { throw new Error('First'); })
      .mockImplementationOnce(() => { throw new Error('Second'); })
      .mockImplementationOnce(() => { throw new Error('Third'); });
    await buildImplementationStepBlueprintsWithRepairs(f.input);
    expect(f.repairRoadmap).toHaveBeenCalledTimes(3);
  });

  it('resumes a failed repair with the saved candidate and blocker, without repeating its review', async () => {
    const f = fixture();
    f.reviewRoadmap.mockResolvedValueOnce(rejected);
    f.repairRoadmap.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(buildReviewedImplementationStepBlueprints(f.input)).rejects.toThrow('Provider unavailable');
    const checkpoint = f.history.at(-1)!;
    expect(checkpoint).toMatchObject({ phase: 'repair', qualityReview: rejected });
    f.repairRoadmap.mockClear();
    f.reviewRoadmap.mockClear();
    await buildReviewedImplementationStepBlueprints({ ...f.input, plan: { ...plan, implementationSteps: [] }, checkpoint });
    expect(f.repairRoadmap).toHaveBeenCalledTimes(1);
    expect(f.repairRoadmap.mock.calls[0]![0]).toMatchObject({ implementationSteps: [step], validationError: expect.stringContaining(rejected.blockers[0]!) });
    expect(f.reviewRoadmap).toHaveBeenCalledTimes(1);
  });

  it('resumes review of a persisted repair without redoing the successful repair', async () => {
    const f = fixture();
    f.reviewRoadmap.mockResolvedValueOnce(rejected).mockRejectedValueOnce(new Error('Review timeout'));
    await expect(buildReviewedImplementationStepBlueprints(f.input)).rejects.toThrow('Review timeout');
    const checkpoint = f.history.at(-1)!;
    expect(checkpoint).toMatchObject({ phase: 'review', revision: 1 });
    f.repairRoadmap.mockClear();
    await buildReviewedImplementationStepBlueprints({ ...f.input, checkpoint });
    expect(f.repairRoadmap).not.toHaveBeenCalled();
  });

  it('reuses an already satisfied checkpoint after a persistence interruption', async () => {
    const f = fixture();
    const checkpoint: RoadmapGenerationCheckpoint = { version: 1, phase: 'ready', revision: 4, plan, qualityReview: satisfied };
    const result = await buildReviewedImplementationStepBlueprints({ ...f.input, checkpoint });
    expect(result.blueprints).toEqual([step]);
    expect(f.reviewRoadmap).not.toHaveBeenCalled();
    expect(f.repairRoadmap).not.toHaveBeenCalled();
  });

  it('stops before calling the provider if the next checkpoint cannot be persisted', async () => {
    const f = fixture();
    f.input.onCheckpoint.mockRejectedValue(new Error('Database unavailable'));
    await expect(buildReviewedImplementationStepBlueprints(f.input)).rejects.toThrow('Database unavailable');
    expect(f.reviewRoadmap).not.toHaveBeenCalled();
    expect(f.repairRoadmap).not.toHaveBeenCalled();
  });

  it('propagates cancellation into repair and retains the resumable checkpoint', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.reviewRoadmap.mockResolvedValueOnce(rejected);
    f.repairRoadmap.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('User disconnected'));
      signal.throwIfAborted();
    });
    await expect(buildReviewedImplementationStepBlueprints({ ...f.input, signal: controller.signal })).rejects.toThrow('User disconnected');
    expect(f.history.at(-1)?.phase).toBe('repair');
    expect(f.repairRoadmap).toHaveBeenCalledTimes(1);
  });

  it('allows cancellation even when the provider keeps returning immediate unsuccessful results', async () => {
    const f = fixture();
    f.reviewRoadmap.mockResolvedValue(rejected);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    await expect(buildReviewedImplementationStepBlueprints({ ...f.input, signal: controller.signal })).rejects.toThrow();
    clearTimeout(timer);
    expect(f.history.at(-1)?.phase).not.toBe('ready');
  });
});

describe('roadmap request lifecycle', () => {
  it('rejects a second request, aborts on disconnect and releases listeners for retry', () => {
    const active = new Map<string, AbortController>();
    const request = { raw: new EventEmitter() } as unknown as FastifyRequest;
    const reply = { raw: Object.assign(new EventEmitter(), { writableEnded: false }) } as unknown as FastifyReply;
    const first = beginRoadmapRequest(active, 'project', request, reply)!;
    expect(beginRoadmapRequest(active, 'project', request, reply)).toBeUndefined();
    reply.raw.emit('close');
    expect(first.signal.aborted).toBe(true);
    first.release();
    expect(active.size).toBe(0);
    expect(reply.raw.listenerCount('close')).toBe(0);
    expect(request.raw.listenerCount('aborted')).toBe(0);
    beginRoadmapRequest(active, 'project', request, reply)!.release();
  });
});
