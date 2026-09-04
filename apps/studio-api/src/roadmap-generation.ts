import type { RoadmapGenerationCheckpoint } from '@forgemind/core';
import { activeProjectContractRequirements, applyProjectContractDelta, deriveProjectContractDelta, redactError } from '@forgemind/core';
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
  if (!repaired.contractDelta) return { ...plan, implementationSteps: repaired.implementationSteps };
  const correctedCandidate = applyProjectContractDelta(input.projectContract, repaired.contractDelta).contract;
  const composedDelta = input.persistedProjectContract
    ? deriveProjectContractDelta(
        input.persistedProjectContract, correctedCandidate,
        repaired.contractDelta.summary?.trim() || 'Targeted correction against the authoritative current specification.',
        repaired.contractDelta.migrationImpacts, repaired.contractDelta.compatibilityImpacts
      )
    : undefined;
  const corrected = composedDelta
    ? {
        ...applyProjectContractDelta(input.persistedProjectContract!, composedDelta).contract,
        version: input.projectContract.version,
        sourceBriefHash: correctedCandidate.sourceBriefHash,
        sourceBriefSnapshot: correctedCandidate.sourceBriefSnapshot
      }
    : {
        ...correctedCandidate,
        version: 1,
        requirements: correctedCandidate.requirements.map((requirement) => ({
          ...requirement, introducedInVersion: 1, lastChangedInVersion: 1
        }))
      };
  const activeIds = new Set(activeProjectContractRequirements(corrected).map((requirement) => requirement.id));
  return {
    ...plan,
    projectContract: corrected,
    contractDelta: composedDelta,
    implementationSteps: repaired.implementationSteps.map((step) => ({
      ...step, requirementIds: step.requirementIds.filter((id) => activeIds.has(id))
    })).filter((step) => step.requirementIds.length > 0)
  };
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
  validate: (plan: PlanResult, contract?: RoadmapRepairInput['projectContract'], requiredRequirementIds?: string[]) => T;
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
  const effectiveContext = () => {
    const contract = state.plan.projectContract ?? input.repairInput.projectContract;
    const activeIds = new Set(activeProjectContractRequirements(contract).map((item) => item.id));
    return { contract, requiredRequirementIds: input.repairInput.requiredRequirementIds.filter((id) => activeIds.has(id)) };
  };
  await save(state);
  for (;;) {
    await setImmediate(undefined, { signal: input.signal });
    switch (state.phase) {
      case 'validate': {
        let validationError: string | undefined;
        const effective = effectiveContext();
        try { input.validate(state.plan, effective.contract, effective.requiredRequirementIds); } catch (error) { validationError = redactError(error); }
        await save({ ...state, phase: validationError ? 'repair' : 'review', validationError });
        break;
      }
      case 'repair': {
        if (!state.validationError) throw new Error('Roadmap repair checkpoint is missing its blocker.');
        const effective = effectiveContext();
        const plan = await repairRoadmapOnce(input.provider, input.session, state.plan, {
          ...input.repairInput, ...effective, validationError: state.validationError, signal: input.signal
        });
        // Persist the response even if cancellation arrived just as the provider finished.
        await save({ version: 2, phase: 'validate', revision: state.revision + 1, plan });
        break;
      }
      case 'review': {
        const effective = effectiveContext();
        const qualityReview = await input.provider.reviewRoadmap({
          ...input.reviewInput, ...effective, implementationSteps: state.plan.implementationSteps ?? [], signal: input.signal
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
        const effective = effectiveContext();
        return { plan: state.plan, blueprints: input.validate(state.plan, effective.contract, effective.requiredRequirementIds), qualityReview: state.qualityReview };
      }
      default: throw new Error('Unsupported roadmap checkpoint phase.');
    }
  }
}
