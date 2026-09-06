import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import type { AuditGapProposal, ProjectAuditJob } from '@forgemind/core';
import { activeProjectContractRequirements, redactError } from '@forgemind/core';
import type { AIProvider, ReviewResult, RoadmapQualityReviewInput } from '@forgemind/providers';

const text = z.string().trim().min(1);
const repairedStepsSchema = z.array(z.object({
  title: text, description: text, acceptanceCriteria: z.array(text).min(1),
  requirementIds: z.array(text).min(1), deliverables: z.array(text).min(1), changeRationale: text,
  inScope: z.array(text), outOfScope: z.array(text), dependsOnStepTitles: z.array(text),
  validationFocus: z.array(z.enum(['implementation', 'migration', 'compatibility', 'regression']))
}));

/** Resume rejected proposals at repair; persist each revision before independent review. */
export async function reviewAndRepairAuditGapProposal(input: {
  provider: AIProvider;
  proposal: AuditGapProposal;
  originalProposal?: AuditGapProposal;
  previousReview?: ProjectAuditJob['gapProposalReview'];
  reviewInput: Omit<RoadmapQualityReviewInput, 'implementationSteps' | 'requiredRequirementIds'>;
  assertCurrentSource: () => Promise<void>;
  saveProposal: (proposal: AuditGapProposal, previous: AuditGapProposal) => Promise<void>;
  saveReview: (review: ReviewResult, proposal: AuditGapProposal) => Promise<void>;
}): Promise<{ proposal: AuditGapProposal; review: ReviewResult }> {
  if (!input.provider.reviewRoadmap) throw new Error('The AI provider does not support independent roadmap quality review.');
  const { signal } = input.reviewInput;
  let proposal = input.proposal;
  let feedback = input.previousReview?.verdict === 'not_satisfied'
    ? [input.previousReview.summary, ...input.previousReview.blockers].join('\n') : undefined;
  const knownRequirements = new Set(activeProjectContractRequirements(input.reviewInput.projectContract).map(r => r.id));
  const objective = [
    input.reviewInput.objective,
    'The original audit proposal below defines the scope under consideration. Its historical findings are context, not proof that a gap still exists.',
    'Verify that every original gap is either addressed by a concrete candidate step or no longer requires work in the current repository. An empty candidate is valid only when no original gap remains.',
    'The checkout commit is review provenance, not required checked-in output. A file changed by a task cannot contain the SHA of its own resulting commit.',
    'Reject and remove any self-referential step whose only purpose is to advance a source-controlled current, latest, or audited commit marker to the checkout SHA. A stable reviewed ancestor is valid when later changes remain traceable through Git history or evidence lineage.',
    `Original audit proposal (scope boundary):\n${JSON.stringify(input.originalProposal ?? input.proposal)}`
  ].join('\n\n');
  const repairObjective = [
    objective,
    'Repair only the remaining gaps within that original proposal. Preserve valid work and the current specification.',
    'Inspect the current read-only repository. Identify exact files, symbols, references, or passages proving each gap; use reviewer feedback to correct the candidate, not to edit repository files.',
    'Remove steps that are already implemented or unsupported by current evidence.',
    'Return contractDelta as null. Changing the project contract or adding product scope is a separate operation.'
  ].join('\n\n');

  for (;;) {
    await setImmediate(undefined, { signal });
    await input.assertCurrentSource();
    if (feedback) {
      if (!input.provider.repairRoadmap) throw new Error(`The AI provider cannot repair the rejected audit proposal: ${feedback}`);
      const repaired = await input.provider.repairRoadmap({
        ...input.reviewInput,
        objective: input.provider.supportsNativeRepositoryReview?.()
          ? repairObjective
          : `${repairObjective}\n\nCurrent repository evidence:\n${input.reviewInput.repositoryBaseline?.evidence ?? ''}`,
        validationError: feedback,
        implementationSteps: proposal.steps.map(step => ({ ...step, inScope: [], outOfScope: [] })),
        requiredRequirementIds: [], migrationImpacts: [], compatibilityImpacts: []
      });
      if (repaired.contractDelta) throw new Error('Audit proposal repair requested a contract change. Review the project scope separately before applying that change.');
      let steps: AuditGapProposal['steps'];
      try {
        const parsed = repairedStepsSchema.parse(repaired.implementationSteps);
        const titles = new Set<string>();
        steps = parsed.map(({ inScope, outOfScope, ...step }) => {
          if (step.requirementIds.some(id => !knownRequirements.has(id))) throw new Error(`Step "${step.title}" references an unknown requirement.`);
          if (titles.has(step.title)) throw new Error(`Duplicate step title "${step.title}".`);
          if (step.dependsOnStepTitles.some(title => !titles.has(title))) throw new Error(`Step "${step.title}" depends on an unknown or later step.`);
          titles.add(step.title);
          return { ...step, description: [step.description,
            ...(inScope.length ? ['In scope:', ...inScope.map(item => `- ${item}`)] : []),
            ...(outOfScope.length ? ['Out of scope:', ...outOfScope.map(item => `- ${item}`)] : [])
          ].join('\n\n') };
        });
      } catch (error) {
        feedback = `${feedback}\nRepair output is structurally invalid: ${redactError(error)}`;
        continue;
      }
      const next = { ...proposal, steps };
      // Keep the response even if a disconnect arrives as the provider finishes.
      await input.saveProposal(next, proposal);
      proposal = next;
      feedback = undefined;
      signal?.throwIfAborted();
      await input.assertCurrentSource();
    }
    const review = await input.provider.reviewRoadmap({
      ...input.reviewInput, objective,
      requiredRequirementIds: [...new Set(proposal.steps.flatMap(step => step.requirementIds))],
      implementationSteps: proposal.steps.map(step => ({ ...step, inScope: [], outOfScope: [] }))
    });
    await input.saveReview(review, proposal);
    signal?.throwIfAborted();
    if (review.verdict === 'satisfied') return { proposal, review };
    feedback = [review.summary, ...review.blockers].join('\n');
  }
}
