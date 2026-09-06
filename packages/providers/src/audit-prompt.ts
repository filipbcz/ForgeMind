import type { BriefCoverageResult, CapabilityAuditInput, CapabilityAuditResult, ImplementationStepPlan, ReleaseAuditInput, ReleaseAuditResult } from './provider.js';
import { activeProjectContractRequirements } from '@forgemind/core';
import type { ProjectContractRequirement } from '@forgemind/core';

export function buildCapabilityAuditPrompt(input: CapabilityAuditInput): string {
  const usesReadOnlyCheckout = usesNativeRepositoryAudit(input);
  return [
    'Perform an independent read-only ForgeMind capability audit.',
    '',
    'Purpose:',
    '- Decide whether the current repository state implements the required product capability, not merely its interfaces, documentation, fixtures, or scaffolding.',
    '- Evaluate every supplied acceptance criterion exactly once.',
    '- Copy each acceptance criterion into criteria[].criterion exactly as supplied, including punctuation and Markdown formatting.',
    '- Return only blocking implementation gaps. Do not propose optional improvements.',
    '',
    'Rules:',
    '- Do not modify repository files.',
    ...(usesReadOnlyCheckout
      ? ['- Inspect the complete current repository using read-only repository and shell tools. The checked-out repository is the authoritative inspection surface.']
      : ['- The complete repository snapshot below is the complete inspection surface for this audit. Do not access repository files outside the supplied snapshot.']),
    '- Treat pass-valued JSON, declarations, documentation, mocks, placeholders, and synthetic data as claims rather than proof unless the criterion explicitly requires them.',
    '- Supplied task validation is supporting evidence, not proof that the whole capability is complete.',
    '- Evidence with status deferred identifies a Windows-specific check intentionally postponed until this project audit. Inspect the implementation and portable evidence for the associated risk. The deferred status alone is not a blocker and is not passed evidence.',
    '- Do not rerun commands that already have passed trusted execution evidence for the audited commit; inspect the implementation and tests instead.',
    '- The repository commit above identifies the state inspected by this audit. It is audit provenance, not a value that source-controlled documentation must claim as its current commit.',
    '- A checked-in file cannot identify the SHA of the commit created by editing that file. A documentation baseline may name a stable reviewed ancestor while Git history and evidence lineage account for later changes.',
    '- Never fail a criterion or create a work item solely because a checked-in baseline names an ancestor instead of the audited commit. Report a gap only when the recorded commit is invalid, is not relevant history, or later material changes are not otherwise traceable.',
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
    ...(input.supplementalContext?.trim()
      ? ['', 'Supplemental audit context (supporting context only, not a repository snapshot):', input.supplementalContext]
      : []),
    ...(!usesReadOnlyCheckout && input.repositoryContext
      ? ['', 'Complete repository snapshot:', input.repositoryContext]
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
  const usesReadOnlyCheckout = usesNativeRepositoryAudit(input);
  return [
    'Perform an independent read-only ForgeMind release audit.',
    '',
    'Purpose:',
    '- Decide whether the current repository is a coherent release candidate for the complete project contract.',
    '- Independently derive the materially distinct product obligations from the original brief and verify that none were lost when the project contract and roadmap were generated.',
    '- Evaluate every global invariant and release criterion exactly once.',
    '- Copy each global invariant and release criterion into criteria[].criterion exactly as supplied, including punctuation and Markdown formatting.',
    '- Check integration between capabilities and real end-to-end behavior.',
    '- Return only blocking implementation gaps. Do not propose optional improvements.',
    '',
    'Rules:',
    '- Do not modify repository files.',
    ...(usesReadOnlyCheckout
      ? ['- Inspect the complete current repository using read-only repository and shell tools. The checked-out repository is the authoritative inspection surface.']
      : ['- The complete repository snapshot below is the complete inspection surface for this audit. Do not access repository files outside the supplied snapshot.']),
    '- Declarations, docs, mocks, placeholders, synthetic fixtures, and pass-valued reports are not proof of a working release.',
    '- Passed criteria require concrete repository evidence.',
    '- briefCoverage must evaluate every materially distinct obligation from the original brief exactly once and collectively reference every existing contract requirement ID.',
    '- The original brief snapshot may contain chronological revisions appended from oldest to newest. A later explicit revision supersedes only the conflicting earlier workflow detail; do not report the two formulations as an unresolved conflict.',
    '- Set briefCoverage[].workflowOnly to true only for delivery-order, planning, or workflow obligations evidenced by ForgeMind implementation-step records; these items must use an empty requirementIds array.',
    '- Product behavior obligations must set workflowOnly to false and reference one or more valid requirementIds.',
    '- Do not turn optional ideas or implementation preferences into brief obligations.',
    '- Use existing requirement IDs whenever the contract already represents an obligation.',
    '- ForgeMind initial_roadmap implementation-step records are authoritative evidence for delivery order and scope-boundary obligations; do not require copies of this workflow metadata in the target repository.',
    '- audit_repair steps are corrective work discovered after the initial roadmap and do not invalidate the original roadmap step count or scope boundaries.',
    '- Contract amendments and gap work items must address missing product behavior, not missing ForgeMind planning or audit metadata.',
    '- If the contract omitted a material brief obligation, add one atomic REQ-* item to contractAmendments and reference it from both briefCoverage and a minimal gap work item.',
    '- contractAmendments must contain only requirements missing from the existing contract. Do not rewrite or duplicate existing requirements.',
    '- Gap work items must be minimal, non-overlapping, and reference existing requirement IDs or IDs introduced by contractAmendments.',
    '- Trusted execution evidence supports a conclusion but does not override contradictory repository code.',
    '- Evidence with status deferred identifies Windows-specific validation intentionally consolidated into this final audit. Assess the affected code paths and portable evidence, mention residual platform risk in the audit evidence, and report a gap only when you find a concrete defect or materially insufficient implementation.',
    '- Trusted evidence from an ancestor commit remains supporting evidence when the current repository packet shows the relevant implementation and tests still present and current regression gates pass. Do not require every specialized suite to be rerun after an unrelated later change.',
    '- When evidence lineage shows that later commits did not change the implementation, tests, or runtime used by a passing specialized check, treat that check as trusted for the audited commit. Never create a work item whose only purpose is to reproduce same-commit evidence.',
    '- Do not rerun commands that already have passed trusted execution evidence for the audited commit; inspect the implementation and tests instead.',
    '- The repository commit above identifies the state inspected by this audit. It is audit provenance, not a value that source-controlled documentation must claim as its current commit.',
    '- A checked-in file cannot identify the SHA of the commit created by editing that file. A documentation baseline may name a stable reviewed ancestor while Git history and evidence lineage account for later changes.',
    '- Never fail a criterion or create a work item solely because a checked-in baseline names an ancestor instead of the audited commit. Report a gap only when the recorded commit is invalid, is not relevant history, or later material changes are not otherwise traceable.',
    '- Return only JSON matching the required schema.',
    '- The JSON fields are verdict, summary, criteria, briefCoverage, contractAmendments, and gapWorkItems.',
    '- criteria items contain criterion, status, evidence, and gaps.',
    '- briefCoverage items contain obligation, status, workflowOnly, requirementIds, evidence, and gaps.',
    '- contractAmendments items contain id, title, description, acceptanceCriteria, and briefReferences.',
    '- gapWorkItems items contain title, description, acceptanceCriteria, inScope, outOfScope, requirementIds, deliverables, changeRationale, dependsOnStepTitles, and validationFocus.',
    '',
    `Project: ${input.projectId}`,
    `Contract version: ${input.contract.version}`,
    `Repository commit: ${input.commitSha}`,
    `Contract summary: ${input.contract.summary}`,
    '',
    'Original immutable project brief:',
    input.originalBrief,
    '',
    'Contract requirement traceability:',
    activeProjectContractRequirements(input.contract).map((requirement) => [
      `- ${requirement.id}: ${requirement.title}`,
      `  ${requirement.description}`,
      `  Brief references: ${requirement.briefReferences?.join(' | ') || '(not recorded)'}`
    ].join('\n')).join('\n'),
    '',
    'Global invariants:',
    renderList(input.contract.invariants),
    '',
    'Release criteria:',
    renderList(input.contract.releaseCriteria),
    '',
    'Satisfied capabilities:',
    input.satisfiedCapabilities.map((item) => `- ${item.requirementId}: ${item.title} (${item.satisfiedCriteria}/${item.totalCriteria})`).join('\n'),
    '',
    'ForgeMind implementation-step evidence:',
    input.implementationSteps?.length
      ? input.implementationSteps.map((item) => [
          `- Step ${item.sequenceNumber}: ${item.title} [${item.status}; ${item.origin}]${item.taskId ? ` task=${item.taskId}` : ''}`,
          `  Scope: ${item.description}`,
          `  Criteria: ${item.acceptanceCriteria.join(' | ') || '(none)'}`,
          `  Requirements: ${item.requirementIds.join(' | ') || '(none)'}`,
          `  Deliverables: ${item.deliverables.join(' | ') || '(none)'}`
        ].join('\n')).join('\n')
      : '- (none supplied)',
    '',
    'Trusted execution evidence:',
    input.executionEvidence?.length
      ? input.executionEvidence.map((item) => `- [${item.source}/${item.status}] ${item.criterion}${item.command ? ` | ${item.command}` : ''}${item.commitSha ? ` | ${item.commitSha}` : ''}${item.summary ? ` | ${item.summary}` : ''}`).join('\n')
      : '- (none)',
    ...(input.supplementalContext?.trim()
      ? ['', 'Supplemental audit context (supporting context only, not a repository snapshot):', input.supplementalContext]
      : []),
    ...(!usesReadOnlyCheckout && input.repositoryContext ? ['', 'Complete repository snapshot:', input.repositoryContext] : [])
  ].join('\n');
}

function usesNativeRepositoryAudit(input: CapabilityAuditInput | ReleaseAuditInput): boolean {
  if (input.repositoryAccess) return input.repositoryAccess === 'read_only_checkout';
  return !input.repositoryContext?.trim();
}

export function normalizeReleaseAuditResult(input: ReleaseAuditInput, value: ReleaseAuditResult): ReleaseAuditResult {
  if (!value || !Array.isArray(value.criteria) || !Array.isArray(value.gapWorkItems)
    || !Array.isArray(value.briefCoverage) || !Array.isArray(value.contractAmendments)) {
    throw new Error('AI provider returned an invalid release audit result.');
  }

  const existingRequirementIds = new Set(input.contract.requirements.map((requirement) => requirement.id));
  const contractAmendments = normalizeContractAmendments(value.contractAmendments, existingRequirementIds);
  const allowedRequirementIds = new Set([
    ...existingRequirementIds,
    ...contractAmendments.map((requirement) => requirement.id)
  ]);
  const releaseCriteria = normalizeAuditCriteria(
    [...input.contract.invariants, ...input.contract.releaseCriteria],
    value.criteria
  );
  const briefCoverage = normalizeBriefCoverage(value.briefCoverage, allowedRequirementIds);
  const coveredRequirementIds = new Set(briefCoverage.flatMap((item) => item.requirementIds));
  const uncoveredContractRequirement = [...existingRequirementIds].find((id) => !coveredRequirementIds.has(id));
  if (uncoveredContractRequirement) {
    throw new Error(`Release audit did not trace contract requirement "${uncoveredContractRequirement}" to the original brief.`);
  }

  const statuses = [...releaseCriteria, ...briefCoverage].map((item) => item.status);
  const expectedVerdict = statuses.every((status) => status === 'passed')
    ? 'satisfied'
    : statuses.some((status) => status === 'failed')
      ? 'partial'
      : 'blocked';
  if (value.verdict !== expectedVerdict) {
    throw new Error(`Release audit verdict must be "${expectedVerdict}".`);
  }

  const gapWorkItems = value.gapWorkItems.map((item, index) => normalizeGapWorkItem(item, allowedRequirementIds, index));
  if (expectedVerdict === 'satisfied' && (gapWorkItems.length > 0 || contractAmendments.length > 0)) {
    throw new Error('Satisfied release audit cannot contain gap work items or contract amendments.');
  }
  if (expectedVerdict === 'partial' && gapWorkItems.length === 0) {
    throw new Error('Partial release audit must contain at least one gap work item.');
  }

  const failedCoverageRequirementIds = new Set(briefCoverage
    .filter((item) => item.status === 'failed')
    .flatMap((item) => item.requirementIds));
  const gapRequirementIds = new Set(gapWorkItems.flatMap((item) => item.requirementIds));
  for (const amendment of contractAmendments) {
    if (!failedCoverageRequirementIds.has(amendment.id) || !gapRequirementIds.has(amendment.id)) {
      throw new Error(`Release audit contract amendment "${amendment.id}" is not linked to a failed brief obligation and repair work item.`);
    }
  }

  return {
    verdict: expectedVerdict,
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : `Release ${expectedVerdict}.`,
    criteria: releaseCriteria,
    briefCoverage,
    contractAmendments,
    gapWorkItems,
    providerPrompt: value.providerPrompt,
    providerResponse: value.providerResponse
  };
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
  const criteria = normalizeAuditCriteria(expectedCriteria, value.criteria);
  const expectedVerdict = auditVerdict(criteria);
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

function normalizeAuditCriteria(
  expectedCriteria: string[],
  value: CapabilityAuditResult['criteria']
): CapabilityAuditResult['criteria'] {
  const expected = new Map(expectedCriteria.map((criterion) => [normalizeText(criterion), criterion]));
  const seen = new Set<string>();
  const criteria = value.map((item) => {
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

  return criteria;
}

function auditVerdict(criteria: CapabilityAuditResult['criteria']): CapabilityAuditResult['verdict'] {
  return criteria.every((item) => item.status === 'passed')
    ? 'satisfied'
    : criteria.some((item) => item.status === 'failed')
      ? 'partial'
      : 'blocked';
}

function normalizeBriefCoverage(
  value: BriefCoverageResult[],
  allowedRequirementIds: Set<string>
): BriefCoverageResult[] {
  if (value.length === 0) throw new Error('Release audit did not derive any obligations from the original brief.');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const obligation = item?.obligation?.trim();
    const key = obligation ? normalizeText(obligation) : '';
    const workflowOnly = item?.workflowOnly === true;
    const requirementIds = normalizeStrings(item?.requirementIds);
    const evidence = normalizeStrings(item?.evidence);
    const gaps = normalizeStrings(item?.gaps);
    if (!obligation || seen.has(key)) {
      throw new Error(`Release audit returned an invalid or duplicate brief obligation at position ${index + 1}.`);
    }
    if (!['passed', 'failed', 'blocked'].includes(item.status)) {
      throw new Error(`Release audit returned an invalid status for brief obligation "${obligation}".`);
    }
    if (
      (workflowOnly && requirementIds.length > 0)
      || (!workflowOnly && requirementIds.length === 0)
      || requirementIds.some((id) => !allowedRequirementIds.has(id))
    ) {
      throw new Error(`Release audit returned invalid requirement traceability for brief obligation "${obligation}".`);
    }
    if (item.status === 'passed' && evidence.length === 0) {
      throw new Error(`Release audit passed brief obligation "${obligation}" without repository evidence.`);
    }
    if (item.status !== 'passed' && gaps.length === 0) {
      throw new Error(`Release audit did not explain the gap for brief obligation "${obligation}".`);
    }
    seen.add(key);
    return { obligation, status: item.status, workflowOnly, requirementIds, evidence, gaps };
  });
}

function normalizeContractAmendments(
  value: ProjectContractRequirement[],
  existingRequirementIds: Set<string>
): ProjectContractRequirement[] {
  const seen = new Set<string>();
  return value.map((item, index) => {
    const id = item?.id?.trim();
    const title = item?.title?.trim();
    const description = item?.description?.trim();
    const acceptanceCriteria = normalizeStrings(item?.acceptanceCriteria);
    const briefReferences = normalizeStrings(item?.briefReferences);
    if (
      !id
      || !/^REQ-[A-Z0-9-]+$/.test(id)
      || existingRequirementIds.has(id)
      || seen.has(id)
      || !title
      || !description
      || acceptanceCriteria.length === 0
      || acceptanceCriteria.length > 5
      || briefReferences.length === 0
    ) {
      throw new Error(`Release audit returned an invalid contract amendment at position ${index + 1}.`);
    }
    seen.add(id);
    return { id, title, description, acceptanceCriteria, briefReferences };
  });
}

export function parseCapabilityAuditContent<T extends CapabilityAuditResult = CapabilityAuditResult>(content: string): T {
  const trimmed = content.trim();
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  try {
    const parsed = JSON.parse(candidate) as T;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`AI provider returned malformed capability audit JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function normalizeAuditContentWithSingleRepair<T extends CapabilityAuditResult>(input: {
  auditKind: 'capability' | 'release';
  content: string;
  expectedCriteria: string[];
  allowedRequirementIds: string[];
  normalize: (value: T) => T;
  repair: (prompt: string) => Promise<string>;
}): Promise<{ result: T; response: string; repairPrompt?: string }> {
  try {
    return {
      result: input.normalize(parseCapabilityAuditContent<T>(input.content)),
      response: input.content
    };
  } catch (error) {
    const repairPrompt = buildAuditResponseRepairPrompt({
      auditKind: input.auditKind,
      validationError: error instanceof Error ? error.message : String(error),
      invalidResponse: input.content,
      expectedCriteria: input.expectedCriteria,
      allowedRequirementIds: input.allowedRequirementIds
    });
    const repairedResponse = await input.repair(repairPrompt);
    try {
      return {
        result: input.normalize(parseCapabilityAuditContent<T>(repairedResponse)),
        response: `[initial invalid response]\n${input.content}\n\n[repaired response]\n${repairedResponse}`,
        repairPrompt
      };
    } catch (repairError) {
      throw new Error(
        `AI provider returned an invalid ${input.auditKind} audit after one JSON repair: ${repairError instanceof Error ? repairError.message : String(repairError)}`
      );
    }
  }
}

export function buildAuditResponseRepairPrompt(input: {
  auditKind: 'capability' | 'release';
  validationError: string;
  invalidResponse: string;
  expectedCriteria: string[];
  allowedRequirementIds: string[];
}): string {
  return [
    `Repair the following ForgeMind ${input.auditKind} audit JSON.`,
    'Do not inspect the repository, run commands, or repeat the audit.',
    'Preserve the audit conclusions, evidence, gaps, and work-item scope. Change only fields needed to satisfy the validation error.',
    'Return the complete corrected JSON object and no other text.',
    '',
    `Validation error: ${input.validationError}`,
    '',
    'Expected criteria (each exactly once):',
    renderList(input.expectedCriteria),
    '',
    'Existing requirement IDs that gap work items may reference:',
    renderList(input.allowedRequirementIds),
    ...(input.auditKind === 'release'
      ? ['', 'A release contractAmendment may introduce a new valid REQ-* ID; its gap item may reference that new ID.']
      : []),
    '',
    'Gap work-item constraints:',
    '- title and description are required.',
    '- acceptanceCriteria and inScope contain 1-5 non-empty strings.',
    '- deliverables contains 1-3 non-empty strings.',
    '- requirementIds contains one or more valid requirement IDs; cross-cutting gaps may reference every requirement they genuinely cover.',
    '- outOfScope, dependsOnStepTitles, and validationFocus are arrays; validationFocus uses implementation, migration, compatibility, or regression.',
    '',
    'Invalid JSON:',
    input.invalidResponse
  ].join('\n');
}

function normalizeGapWorkItem(item: ImplementationStepPlan, allowedRequirementIds: Set<string>, index: number): ImplementationStepPlan {
  const normalized = {
    title: item?.title?.trim(),
    description: item?.description?.trim(),
    acceptanceCriteria: normalizeStrings(item?.acceptanceCriteria),
    inScope: normalizeStrings(item?.inScope),
    outOfScope: normalizeStrings(item?.outOfScope),
    requirementIds: normalizeStrings(item?.requirementIds),
    deliverables: normalizeStrings(item?.deliverables),
    changeRationale: item?.changeRationale?.trim() || 'Repository audit found an unmet contract capability.',
    dependsOnStepTitles: normalizeStrings(item?.dependsOnStepTitles),
    validationFocus: Array.from(new Set(
      (item?.validationFocus ?? []).filter(
        (focus) => focus === 'implementation' || focus === 'migration' || focus === 'compatibility' || focus === 'regression'
      )
    ))
  };
  const issues: string[] = [];
  if (!normalized.title) issues.push('title is required');
  if (!normalized.description) issues.push('description is required');
  if (normalized.acceptanceCriteria.length === 0 || normalized.acceptanceCriteria.length > 5) {
    issues.push('acceptanceCriteria must contain 1-5 non-empty strings');
  }
  if (normalized.inScope.length === 0 || normalized.inScope.length > 5) {
    issues.push('inScope must contain 1-5 non-empty strings');
  }
  if (normalized.deliverables.length === 0 || normalized.deliverables.length > 3) {
    issues.push('deliverables must contain 1-3 non-empty strings');
  }
  if (normalized.requirementIds.length === 0) {
    issues.push('requirementIds must contain at least one requirement ID');
  }
  const unknownRequirementIds = normalized.requirementIds.filter((id) => !allowedRequirementIds.has(id));
  if (unknownRequirementIds.length > 0) {
    issues.push(`requirementIds contains unknown IDs: ${unknownRequirementIds.join(', ')}`);
  }
  if (issues.length > 0) {
    const label = normalized.title ? ` ("${normalized.title}")` : '';
    throw new Error(`Audit gap work item at position ${index + 1}${label} is invalid: ${issues.join('; ')}.`);
  }
  if (!normalized.validationFocus.includes('implementation')) normalized.validationFocus.unshift('implementation');
  if (!normalized.validationFocus.includes('regression')) normalized.validationFocus.push('regression');
  return normalized as ImplementationStepPlan;
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : [];
}

function normalizeText(value: string): string {
  return value.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function renderList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none)';
}
