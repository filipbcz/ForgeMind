import type { RoadmapGenerationCheckpoint } from '@forgemind/core';
import { redactError } from '@forgemind/core';
import { setImmediate } from 'node:timers/promises';
import type { AIProvider, PlanResult, ProviderSessionContext, ReviewResult, RoadmapQualityReviewInput, RoadmapRepairInput } from '@forgemind/providers';

type RepairContext = Omit<RoadmapRepairInput, 'implementationSteps' | 'session' | 'validationError'>;

export async function repairRoadmapOnce(
  provider: AIProvider,
  session: ProviderSessionContext,
  plan: PlanResult,
  input: RepairContext & { validationError: string }
): Promise<PlanResult> {
  input.signal?.throwIfAborted();
  if (!provider.repairRoadmap) {
    throw new Error(`Roadmap validation failed and provider "${provider.kind}" does not support targeted repair: ${input.validationError}`);
  }
  const repaired = await provider.repairRoadmap({ ...input, implementationSteps: plan.implementationSteps ?? [], session });
  return { ...plan, implementationSteps: repaired.implementationSteps };
}

export async function buildImplementationStepBlueprintsWithRepairs<T>(input: {
  provider: AIProvider;
  session: ProviderSessionContext;
  plan: PlanResult;
  repairInput: RepairContext;
  validate: (plan: PlanResult) => T;
  signal?: AbortSignal;
}): Promise<{ plan: PlanResult; blueprints: T }> {
  let plan = input.plan;
  for (;;) {
    await setImmediate(undefined, { signal: input.signal });
    let validationError: string;
    try {
      return { plan, blueprints: input.validate(plan) };
    } catch (error) {
      validationError = redactError(error);
    }
    plan = await repairRoadmapOnce(input.provider, input.session, plan, {
      ...input.repairInput, validationError, signal: input.signal
    });
  }
}

/** Each provider call is preceded by a durable description of the work to resume. */
export async function buildReviewedImplementationStepBlueprints<T>(input: {
  provider: AIProvider;
  session: ProviderSessionContext;
  plan: PlanResult;
  repairInput: RepairContext;
  reviewInput: Omit<RoadmapQualityReviewInput, 'implementationSteps'>;
  validate: (plan: PlanResult) => T;
  checkpoint?: RoadmapGenerationCheckpoint;
  onCheckpoint?: (checkpoint: RoadmapGenerationCheckpoint) => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ plan: PlanResult; blueprints: T; qualityReview: ReviewResult }> {
  if (!input.provider.reviewRoadmap) {
    throw new Error(`AI provider "${input.provider.kind}" does not support independent roadmap quality review.`);
  }
  let state: RoadmapGenerationCheckpoint = input.checkpoint ?? {
    version: 1, phase: 'validate', revision: 0, plan: input.plan
  };
  const save = async (next: RoadmapGenerationCheckpoint) => {
    await input.onCheckpoint?.(next);
    state = next;
  };
  await save(state);
  for (;;) {
    await setImmediate(undefined, { signal: input.signal });
    switch (state.phase) {
      case 'validate': {
        let validationError: string | undefined;
        try { input.validate(state.plan); } catch (error) { validationError = redactError(error); }
        await save({ ...state, phase: validationError ? 'repair' : 'review', validationError });
        break;
      }
      case 'repair': {
        if (!state.validationError) throw new Error('Roadmap repair checkpoint is missing its blocker.');
        const plan = await repairRoadmapOnce(input.provider, input.session, state.plan, {
          ...input.repairInput, validationError: state.validationError, signal: input.signal
        });
        // Persist the response even if cancellation arrived just as the provider finished.
        await save({ version: 1, phase: 'validate', revision: state.revision + 1, plan });
        break;
      }
      case 'review': {
        const qualityReview = await input.provider.reviewRoadmap({
          ...input.reviewInput, implementationSteps: state.plan.implementationSteps ?? [], signal: input.signal
        });
        await save({
          ...state, qualityReview,
          phase: qualityReview.verdict === 'satisfied' ? 'ready' : 'repair',
          validationError: qualityReview.verdict === 'satisfied' ? undefined : [
            'Independent roadmap quality review rejected the candidate roadmap.',
            qualityReview.summary,
            ...qualityReview.blockers.map((blocker) => `- ${blocker}`)
          ].join('\n')
        });
        break;
      }
      case 'ready': {
        if (state.qualityReview?.verdict !== 'satisfied') throw new Error('Roadmap checkpoint has no satisfied quality review.');
        return { plan: state.plan, blueprints: input.validate(state.plan), qualityReview: state.qualityReview };
      }
      default: throw new Error('Unsupported roadmap checkpoint phase.');
    }
  }
}
