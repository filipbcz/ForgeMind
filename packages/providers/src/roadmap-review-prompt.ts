import { activeProjectContractRequirements } from '@forgemind/core';
import type { RoadmapQualityReviewInput } from './provider.js';

export const ROADMAP_QUALITY_CRITERIA = [
  'The roadmap covers the authoritative objective and relevant active contract requirements without contradicting invariants.',
  'Every step is independently actionable from its own description, deliverables, and acceptance criteria.',
  'Steps are focused, do not overlap, and do not recreate completed work.',
  'Acceptance criteria describe observable outcomes and leave validation command selection to implementation.',
  'Dependencies are complete, ordered, and reference only genuine implementation prerequisites.',
  'Manual verification, release decisions, and audits are represented as evidence or gates rather than implementation tasks.'
] as const;

export function compactRoadmapContract(
  contract: RoadmapQualityReviewInput['projectContract'],
  relevantRequirementIds: string[]
): Record<string, unknown> {
  const relevant = new Set(relevantRequirementIds);
  return {
    summary: contract.summary,
    invariants: contract.invariants,
    prohibitedSubstitutes: contract.prohibitedSubstitutes,
    requirements: activeProjectContractRequirements(contract)
    .filter((requirement) => relevant.has(requirement.id))
    .map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      acceptanceCriteria: requirement.acceptanceCriteria
    })),
    releaseCriteria: contract.releaseCriteria
  };
}

export function buildRoadmapQualityReviewPrompt(input: RoadmapQualityReviewInput): string {
  const relevantRequirementIds = Array.from(new Set([
    ...input.requiredRequirementIds,
    ...input.implementationSteps.flatMap((step) => step.requirementIds)
  ]));
  const contract = compactRoadmapContract(input.projectContract, relevantRequirementIds);

  return [
    'Independently review the candidate implementation roadmap before it is persisted.',
    'Do not design a different product and do not inspect or modify a repository.',
    'Return verdict "satisfied" only when every quality criterion below is met.',
    'Return verdict "not_satisfied" with concrete blockers when changes are required. Each blocker must name the affected step or missing step and state the exact correction needed.',
    'Do not report stylistic preferences or validation results as blockers.',
    '',
    'Quality criteria:',
    ...ROADMAP_QUALITY_CRITERIA.map((criterion) => `- ${criterion}`),
    '',
    `Authoritative objective:\n${input.objective}`,
    '',
    `Relevant contract (compact JSON):\n${JSON.stringify(contract)}`,
    '',
    `Requirements that this roadmap must cover:\n${input.requiredRequirementIds.map((id) => `- ${id}`).join('\n') || '- none'}`,
    '',
    `Completed step titles that must not be recreated:\n${input.completedStepTitles.map((title) => `- ${title}`).join('\n') || '- none'}`,
    '',
    `Candidate roadmap JSON:\n${JSON.stringify(input.implementationSteps)}`,
    '',
    'Return JSON with verdict, summary, blockers, and criterionResults. criterionResults must contain one result for each quality criterion in the same order.'
  ].join('\n');
}
