import type { CapabilityAuditInput, CapabilityAuditResult, ImplementationStepPlan, ReleaseAuditInput, ReleaseAuditResult } from './provider.js';

export function buildCapabilityAuditPrompt(input: CapabilityAuditInput): string {
  return [
    'Perform an independent read-only ForgeMind capability audit.',
    '',
    'Purpose:',
    '- Decide whether the current repository state implements the required product capability, not merely its interfaces, documentation, fixtures, or scaffolding.',
    '- Evaluate every supplied acceptance criterion exactly once.',
    '- Return only blocking implementation gaps. Do not propose optional improvements.',
    '',
    'Rules:',
    '- Do not modify repository files.',
    '- Treat pass-valued JSON, declarations, documentation, mocks, placeholders, and synthetic data as claims rather than proof unless the criterion explicitly requires them.',
    '- Supplied task validation and GitHub checks are supporting evidence, not proof that the whole capability is complete.',
    '- A passed criterion needs concrete repository evidence such as implemented code paths, tests, configuration, or artifacts.',
    '- If external access, credentials, licensed data, hardware, or a manual decision is indispensable, return blocked for that criterion.',
    '- Gap work items must be minimal, non-overlapping, linked only to the audited requirement, and suitable for one focused pull request.',
    '- Return only JSON matching the required schema.',
    '',
    `Project: ${input.projectId}`,
    `Contract version: ${input.contractVersion}`,
    `Repository commit: ${input.commitSha ?? '(not supplied)'}`,
    `Contract summary: ${input.contractSummary}`,
    '',
    'Global invariants:',
    renderList(input.invariants),
    '',
    'Prohibited substitutes:',
    renderList(input.prohibitedSubstitutes),
    '',
    `Requirement ${input.requirement.id}: ${input.requirement.title}`,
    input.requirement.description,
    '',
    'Acceptance criteria:',
    renderList(input.requirement.acceptanceCriteria),
    '',
    'Completed work items:',
    input.completedWorkItems.length
      ? input.completedWorkItems.map((item) => [
          `- ${item.id}: ${item.title}`,
          `  Deliverables: ${item.deliverables.join(' | ') || '(none)'}`,
          `  Work-item criteria: ${item.acceptanceCriteria.join(' | ') || '(none)'}`
        ].join('\n')).join('\n')
      : '- (none)',
    '',
    'Trusted execution evidence:',
    input.evidence.length
      ? input.evidence.map((item) => `- [${item.source}/${item.status}] ${item.criterion}${item.command ? ` | ${item.command}` : ''}${item.commitSha ? ` | ${item.commitSha}` : ''}${item.summary ? ` | ${item.summary}` : ''}`).join('\n')
      : '- (none)',
    ...(input.repositoryContext
      ? ['', 'Targeted repository packet:', input.repositoryContext]
      : [])
  ].join('\n');
}

export function normalizeCapabilityAuditResult(
  input: CapabilityAuditInput,
  value: CapabilityAuditResult
): CapabilityAuditResult {
  return normalizeAuditResult(
    input.requirement.acceptanceCriteria,
    new Set([input.requirement.id]),
    value,
    'Capability'
  );
}

export function buildReleaseAuditPrompt(input: ReleaseAuditInput): string {
  return [
    'Perform an independent read-only ForgeMind release audit.',
    '',
    'Purpose:',
    '- Decide whether the current repository is a coherent release candidate for the complete project contract.',
    '- Evaluate every global invariant and release criterion exactly once.',
    '- Check integration between capabilities and real end-to-end behavior.',
    '- Return only blocking implementation gaps. Do not propose optional improvements.',
    '',
    'Rules:',
    '- Do not modify repository files.',
    '- Declarations, docs, mocks, placeholders, synthetic fixtures, and pass-valued reports are not proof of a working release.',
    '- Passed criteria require concrete repository evidence.',
    '- Gap work items must be minimal and reference only existing contract requirement IDs.',
    '- Return only JSON matching the required schema.',
    '',
    `Project: ${input.projectId}`,
    `Contract version: ${input.contract.version}`,
    `Repository commit: ${input.commitSha}`,
    `Contract summary: ${input.contract.summary}`,
    '',
    'Global invariants:',
    renderList(input.contract.invariants),
    '',
    'Release criteria:',
    renderList(input.contract.releaseCriteria),
    '',
    'Satisfied capabilities:',
    input.satisfiedCapabilities.map((item) => `- ${item.requirementId}: ${item.title} (${item.satisfiedCriteria}/${item.totalCriteria})`).join('\n'),
    ...(input.repositoryContext ? ['', 'Targeted repository packet:', input.repositoryContext] : [])
  ].join('\n');
}

export function normalizeReleaseAuditResult(input: ReleaseAuditInput, value: ReleaseAuditResult): ReleaseAuditResult {
  return normalizeAuditResult(
    [...input.contract.invariants, ...input.contract.releaseCriteria],
    new Set(input.contract.requirements.map((requirement) => requirement.id)),
    value,
    'Release'
  );
}

function normalizeAuditResult(
  expectedCriteria: string[],
  allowedRequirementIds: Set<string>,
  value: CapabilityAuditResult,
  label: 'Capability' | 'Release'
): CapabilityAuditResult {
  if (!value || !Array.isArray(value.criteria) || !Array.isArray(value.gapWorkItems)) {
    throw new Error(`AI provider returned an invalid ${label.toLowerCase()} audit result.`);
  }
  const expected = new Map(expectedCriteria.map((criterion) => [normalizeText(criterion), criterion]));
  const seen = new Set<string>();
  const criteria = value.criteria.map((item) => {
    const key = normalizeText(item.criterion);
    const canonicalCriterion = expected.get(key);
    if (!canonicalCriterion || seen.has(key)) {
      throw new Error('Capability audit must evaluate every contract criterion exactly once.');
    }
    if (!['passed', 'failed', 'blocked'].includes(item.status)) {
      throw new Error(`Capability audit returned invalid status for "${canonicalCriterion}".`);
    }
    const evidence = normalizeStrings(item.evidence);
    const gaps = normalizeStrings(item.gaps);
    if (item.status === 'passed' && evidence.length === 0) {
      throw new Error(`Capability audit passed "${canonicalCriterion}" without repository evidence.`);
    }
    if (item.status !== 'passed' && gaps.length === 0) {
      throw new Error(`Capability audit did not explain the gap for "${canonicalCriterion}".`);
    }
    seen.add(key);
    return { criterion: canonicalCriterion, status: item.status, evidence, gaps };
  });
  if (seen.size !== expected.size) {
    throw new Error('Capability audit omitted one or more contract criteria.');
  }

  const expectedVerdict = criteria.every((item) => item.status === 'passed')
    ? 'satisfied'
    : criteria.some((item) => item.status === 'failed')
      ? 'partial'
      : 'blocked';
  if (value.verdict !== expectedVerdict) {
    throw new Error(`Capability audit verdict must be "${expectedVerdict}".`);
  }
  const gapWorkItems = value.gapWorkItems.map((item, index) => normalizeGapWorkItem(item, allowedRequirementIds, index));
  if (expectedVerdict === 'satisfied' && gapWorkItems.length > 0) {
    throw new Error('Satisfied capability audit cannot contain gap work items.');
  }
  if (expectedVerdict === 'partial' && gapWorkItems.length === 0) {
    throw new Error('Partial capability audit must contain at least one gap work item.');
  }

  return {
    verdict: expectedVerdict,
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : `${label} ${expectedVerdict}.`,
    criteria,
    gapWorkItems,
    providerPrompt: value.providerPrompt,
    providerResponse: value.providerResponse
  };
}

export function parseCapabilityAuditContent(content: string): CapabilityAuditResult {
  const trimmed = content.trim();
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  try {
    const parsed = JSON.parse(candidate) as CapabilityAuditResult;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`AI provider returned malformed capability audit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeGapWorkItem(item: ImplementationStepPlan, allowedRequirementIds: Set<string>, index: number): ImplementationStepPlan {
  const normalized = {
    title: item?.title?.trim(),
    description: item?.description?.trim(),
    acceptanceCriteria: normalizeStrings(item?.acceptanceCriteria),
    inScope: normalizeStrings(item?.inScope),
    outOfScope: normalizeStrings(item?.outOfScope),
    requirementIds: normalizeStrings(item?.requirementIds),
    deliverables: normalizeStrings(item?.deliverables)
  };
  if (
    !normalized.title
    || !normalized.description
    || normalized.acceptanceCriteria.length === 0
    || normalized.inScope.length === 0
    || normalized.deliverables.length === 0
    || normalized.requirementIds.length === 0
    || normalized.requirementIds.length > 3
    || normalized.requirementIds.some((id) => !allowedRequirementIds.has(id))
    || normalized.acceptanceCriteria.length > 5
    || normalized.inScope.length > 5
    || normalized.deliverables.length > 3
  ) {
    throw new Error(`Capability audit returned an invalid gap work item at position ${index + 1}.`);
  }
  return normalized as ImplementationStepPlan;
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : [];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function renderList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none)';
}
