import type { RoadmapGenerationCheckpoint } from '@forgemind/core';
import { activeProjectContractRequirements, applyProjectContractDelta, deriveProjectContractDelta, redactError } from '@forgemind/core';
import { setImmediate } from 'node:timers/promises';
import type { AIProvider, PlanResult, ProviderSessionContext, ReviewResult, RoadmapQualityReviewInput, RoadmapRepairInput } from '@forgemind/providers';
import { normalizeRoadmapPlan } from './roadmap-normalization.js';

type RepairContext = Omit<RoadmapRepairInput, 'implementationSteps' | 'session' | 'validationError'>;
const ROADMAP_NO_PROGRESS = '[FORGEMIND_ROADMAP_NO_PROGRESS]';
const MAX_REPAIR_CONSTRAINTS = 30;
const MAX_REPAIR_CONSTRAINT_CHARS = 4_000;

function appendRepairConstraints(existing: string[] | undefined, additions: Array<string | undefined>): string[] {
  const constraints = new Map<string, string>();
  for (const raw of [...(existing ?? []), ...additions]) {
    const value = raw?.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const bounded = value.slice(0, MAX_REPAIR_CONSTRAINT_CHARS);
    constraints.set(bounded.toLowerCase(), bounded);
  }
  return [...constraints.values()].slice(-MAX_REPAIR_CONSTRAINTS);
}

function repairInstruction(current: string, constraints: string[] | undefined): string {
  const prior = (constraints ?? []).filter((constraint) => !current.includes(constraint));
  if (prior.length === 0) return current;
  return [
    current,
    'NON-REGRESSION CONSTRAINTS FROM EARLIER VALIDATION AND REVIEW (all remain mandatory):',
    ...prior.map((constraint) => `- ${constraint}`)
  ].join('\n');
}

function reviewBlockerIdentity(review: Pick<ReviewResult, 'summary' | 'blockers'>): string {
  const blockers = review.blockers.map((item) => item.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean).sort();
  return (blockers.length > 0 ? blockers : [review.summary.replace(/\s+/g, ' ').trim().toLowerCase()]).join('\n');
}

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
  if (!repaired.contractDelta) return normalizeRoadmapPlan({ ...plan, implementationSteps: repaired.implementationSteps });
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
  return normalizeRoadmapPlan({
    ...plan,
    projectContract: corrected,
    contractDelta: composedDelta,
    implementationSteps: repaired.implementationSteps.map((step) => ({
      ...step, requirementIds: step.requirementIds.filter((id) => activeIds.has(id))
    })).filter((step) => step.requirementIds.length > 0)
  });
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
  const failedStates = new Set<string>();
  for (;;) {
    await setImmediate(undefined, { signal: input.signal });
    let validationError: string;
    try {
      return { plan, blueprints: input.validate(plan) };
    } catch (error) {
      validationError = redactError(error);
    }
    const failedState = JSON.stringify({ validationError, implementationSteps: plan.implementationSteps, contractDelta: plan.contractDelta });
    if (failedStates.has(failedState)) {
      throw new Error(`${ROADMAP_NO_PROGRESS} Targeted roadmap repair returned to the same structurally invalid candidate: ${validationError}`);
    }
    failedStates.add(failedState);
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
  state = {
    ...state,
    repairConstraints: appendRepairConstraints(state.repairConstraints, [
      state.validationError,
      ...(state.qualityReview?.verdict === 'not_satisfied' ? state.qualityReview.blockers : [])
    ])
  };
  const failedValidationStates = new Set<string>();
  const reviewBlockerOccurrences = new Map<string, number>();
  if (state.phase === 'repair' && state.validationError && !state.validationError.includes(ROADMAP_NO_PROGRESS)) {
    failedValidationStates.add(JSON.stringify({ validationError: state.validationError, implementationSteps: state.plan.implementationSteps,
      contractDelta: state.plan.contractDelta }));
  }
  if (state.qualityReview?.verdict === 'not_satisfied') {
    const identity = reviewBlockerIdentity(state.qualityReview);
    reviewBlockerOccurrences.set(identity, 1);
  }
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
        if (validationError) {
          const identity = JSON.stringify({ validationError, implementationSteps: state.plan.implementationSteps, contractDelta: state.plan.contractDelta });
          if (failedValidationStates.has(identity)) {
            const noProgress = `${ROADMAP_NO_PROGRESS} Targeted roadmap repair returned to the same structurally invalid candidate: ${validationError}`;
            await save({ ...state, phase: 'repair', validationError: noProgress });
            throw new Error(noProgress);
          }
          failedValidationStates.add(identity);
        }
        await save({
          ...state,
          phase: validationError ? 'repair' : 'review',
          validationError,
          repairConstraints: validationError
            ? appendRepairConstraints(state.repairConstraints, [validationError])
            : state.repairConstraints
        });
        break;
      }
      case 'repair': {
        if (!state.validationError) throw new Error('Roadmap repair checkpoint is missing its blocker.');
        if (state.validationError.includes(ROADMAP_NO_PROGRESS)) throw new Error(state.validationError);
        const effective = effectiveContext();
        const plan = await repairRoadmapOnce(input.provider, input.session, state.plan, {
          ...input.repairInput,
          ...effective,
          validationError: repairInstruction(state.validationError, state.repairConstraints),
          signal: input.signal
        });
        // Persist the response even if cancellation arrived just as the provider finished.
        await save({
          version: 2,
          phase: 'validate',
          revision: state.revision + 1,
          plan,
          repairConstraints: state.repairConstraints
        });
        break;
      }
      case 'review': {
        const effective = effectiveContext();
        const qualityReview = await input.provider.reviewRoadmap({
          ...input.reviewInput, ...effective, implementationSteps: state.plan.implementationSteps ?? [], signal: input.signal
        });
        let validationError = qualityReview.verdict === 'satisfied' ? undefined : [
            'Independent roadmap quality review rejected the candidate roadmap.',
            qualityReview.summary,
            ...qualityReview.blockers.map((blocker) => `- ${blocker}`)
          ].join('\n');
        if (qualityReview.verdict === 'not_satisfied') {
          const identity = reviewBlockerIdentity(qualityReview);
          const occurrences = (reviewBlockerOccurrences.get(identity) ?? 0) + 1;
          reviewBlockerOccurrences.set(identity, occurrences);
          if (occurrences >= 2) validationError = `${ROADMAP_NO_PROGRESS} Independent review repeated the same blocker after a targeted repair: ${validationError}`;
        }
        await save({
          ...state,
          qualityReview,
          phase: qualityReview.verdict === 'satisfied' ? 'ready' : 'repair',
          validationError,
          repairConstraints: qualityReview.verdict === 'not_satisfied'
            ? appendRepairConstraints(state.repairConstraints, qualityReview.blockers)
            : state.repairConstraints
        });
        if (validationError?.includes(ROADMAP_NO_PROGRESS)) throw new Error(validationError);
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
