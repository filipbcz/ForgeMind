import { activeProjectContractRequirements } from '@forgemind/core';
import type { RoadmapQualityReviewInput } from './provider.js';

export const ROADMAP_QUALITY_CRITERIA = [
  'The roadmap covers the authoritative objective and relevant active contract requirements without contradicting invariants.',
  'Every step is independently actionable from its own description, deliverables, and acceptance criteria.',
  'Steps are focused, do not overlap, and do not recreate completed work.',
  'Acceptance criteria describe observable outcomes and leave validation command selection to implementation.',
  'Dependencies are complete, ordered, and reference only genuine implementation prerequisites.',
  'Every proposed step identifies a concrete baseline-proven gap and names existing repository components, modules, or interfaces it will reuse.',
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
  if (!input.repositoryBaseline?.commitSha) {
    throw new Error('Commit-bound repository baseline is required for roadmap quality review.');
  }
  if (input.nativeRepositoryAccess && !input.repositoryPath) {
    throw new Error('Native roadmap quality review requires a read-only repository path.');
  }
  if (!input.nativeRepositoryAccess && !input.repositoryBaseline.evidence.trim()) {
    throw new Error('Commit-bound repository baseline is required for roadmap quality review.');
  }
  const relevantRequirementIds = Array.from(new Set([
    ...input.requiredRequirementIds,
    ...input.implementationSteps.flatMap((step) => step.requirementIds)
  ]));
  const contract = compactRoadmapContract(input.projectContract, relevantRequirementIds);

  return [
    'Independently review the candidate implementation roadmap before it is persisted.',
    input.nativeRepositoryAccess
      ? 'Do not design a different product or modify the repository. Inspect the read-only repository in the current working directory and use it as evidence.'
      : 'Do not design a different product or modify the repository. Use the supplied commit-bound repository baseline as evidence.',
    'Reject any step that lacks a concrete gap proven by the baseline. Existing capabilities must not be recreated merely because requirement IDs or completed-step titles differ.',
    'Return verdict "satisfied" only when every quality criterion below is met.',
    'Return verdict "not_satisfied" with concrete blockers when changes are required. Each blocker must name the affected step or missing step and state the exact correction needed.',
    'Do not report stylistic preferences or validation results as blockers.',
    '',
    'Quality criteria:',
    ...ROADMAP_QUALITY_CRITERIA.map((criterion) => `- ${criterion}`),
    '',
    `Authoritative objective:\n${input.objective}`,
    '',
    ...(input.authoritativeSpecification ? [
      `CURRENT SPECIFICATION (authoritative, complete):\n${input.authoritativeSpecification}`,
      'The contract is a derived historical artifact. Report a contract contradiction when it requires behavior removed by the current specification; do not demand that obsolete behavior be added to implementation steps.',
      ''
    ] : []),
    `Relevant contract (compact JSON):\n${JSON.stringify(contract)}`,
    '',
    `Requirements that this roadmap must cover:\n${input.requiredRequirementIds.map((id) => `- ${id}`).join('\n') || '- none'}`,
    '',
    `Completed step titles that must not be recreated:\n${input.completedStepTitles.map((title) => `- ${title}`).join('\n') || '- none'}`,
    '',
    `Repository baseline commit: ${input.repositoryBaseline.commitSha}`,
    input.nativeRepositoryAccess
      ? 'Repository evidence: inspect the complete read-only checkout in the current working directory. Cite concrete files, symbols, tests, or documentation from that checkout.'
      : `Repository evidence:\n${input.repositoryBaseline.evidence}`,
    '',
    `Candidate roadmap JSON:\n${JSON.stringify(input.implementationSteps)}`,
    '',
    'Return JSON with verdict, summary, blockers, and criterionResults. criterionResults must contain one result for each quality criterion in the same order.'
  ].join('\n');
}
