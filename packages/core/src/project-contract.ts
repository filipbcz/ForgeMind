import type {
  ProjectContract,
  ProjectContractCollectionDelta,
  ProjectContractDelta,
  ProjectContractRequirement,
  ProjectContractRequirementDraft
} from './model.js';

export interface AppliedProjectContractDelta {
  contract: ProjectContract;
  touchedRequirementIds: string[];
}

export function isActiveProjectContractRequirement(requirement: ProjectContractRequirement): boolean {
  return (requirement.status ?? 'active') === 'active';
}

export function activeProjectContractRequirements(contract: ProjectContract): ProjectContractRequirement[] {
  return contract.requirements.filter(isActiveProjectContractRequirement);
}

export function applyProjectContractDelta(
  current: ProjectContract,
  delta: ProjectContractDelta
): AppliedProjectContractDelta {
  if (delta.baseVersion !== current.version) {
    throw new Error(`Contract delta targets version ${delta.baseVersion}, but current version is ${current.version}.`);
  }

  const nextVersion = current.version + 1;
  const requirements = current.requirements.map((requirement) => normalizeExistingRequirement(requirement, current.version));
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const touched = new Set<string>();
  const operatedExistingIds = new Set<string>();
  const claimedNewIds = new Set<string>();

  const claimExisting = (id: string, operation: string): ProjectContractRequirement => {
    const requirement = byId.get(id);
    if (!requirement) {
      throw new Error(`Contract delta ${operation} references unknown requirement "${id}".`);
    }
    if (!isActiveProjectContractRequirement(requirement)) {
      throw new Error(`Contract delta ${operation} references non-active requirement "${id}".`);
    }
    if (operatedExistingIds.has(id)) {
      throw new Error(`Contract delta contains conflicting operations for requirement "${id}".`);
    }
    operatedExistingIds.add(id);
    touched.add(id);
    return requirement;
  };

  const claimNew = (draft: ProjectContractRequirementDraft, operation: string): ProjectContractRequirement => {
    validateRequirementDraft(draft, operation);
    if (byId.has(draft.id) || claimedNewIds.has(draft.id)) {
      throw new Error(`Contract delta ${operation} uses existing or duplicate requirement id "${draft.id}".`);
    }
    claimedNewIds.add(draft.id);
    touched.add(draft.id);
    return {
      ...copyRequirementDraft(draft),
      status: 'active',
      introducedInVersion: nextVersion,
      lastChangedInVersion: nextVersion
    };
  };

  for (const draft of delta.addRequirements) {
    const added = claimNew(draft, 'addition');
    requirements.push(added);
    byId.set(added.id, added);
  }

  for (const update of delta.updateRequirements) {
    requireRationale(update.rationale, `update of requirement "${update.id}"`);
    const existing = claimExisting(update.id, 'update');
    const updated: ProjectContractRequirement = {
      ...existing,
      title: cleanOptionalText(update.title, existing.title, `title for requirement "${update.id}"`),
      description: cleanOptionalText(update.description, existing.description, `description for requirement "${update.id}"`),
      acceptanceCriteria: update.acceptanceCriteria
        ? cleanStringList(update.acceptanceCriteria, `acceptance criteria for requirement "${update.id}"`, true)
        : existing.acceptanceCriteria,
      briefReferences: update.briefReferences
        ? cleanStringList(update.briefReferences, `brief references for requirement "${update.id}"`, false)
        : existing.briefReferences,
      lastChangedInVersion: nextVersion,
      lifecycleReason: update.rationale.trim()
    };
    replaceRequirement(requirements, byId, updated);
  }

  for (const supersession of delta.supersedeRequirements) {
    requireRationale(supersession.rationale, `supersession of requirement "${supersession.id}"`);
    const existing = claimExisting(supersession.id, 'supersession');
    const replacement = claimNew(supersession.replacement, 'supersession replacement');
    replaceRequirement(requirements, byId, {
      ...existing,
      status: 'superseded',
      supersededByRequirementId: replacement.id,
      lifecycleReason: supersession.rationale.trim(),
      lastChangedInVersion: nextVersion
    });
    requirements.push(replacement);
    byId.set(replacement.id, replacement);
  }

  for (const removal of delta.removeRequirements) {
    requireRationale(removal.rationale, `removal of requirement "${removal.id}"`);
    const existing = claimExisting(removal.id, 'removal');
    replaceRequirement(requirements, byId, {
      ...existing,
      status: 'removed',
      lifecycleReason: removal.rationale.trim(),
      lastChangedInVersion: nextVersion
    });
  }

  const invariants = applyCollectionDelta(current.invariants, delta.invariantChanges, 'invariant');
  const prohibitedSubstitutes = applyCollectionDelta(
    current.prohibitedSubstitutes,
    delta.prohibitedSubstituteChanges,
    'prohibited substitute'
  );
  const releaseCriteria = applyCollectionDelta(current.releaseCriteria, delta.releaseCriteriaChanges, 'release criterion');

  const hasContractChange = touched.size > 0
    || !sameStringList(invariants, current.invariants)
    || !sameStringList(prohibitedSubstitutes, current.prohibitedSubstitutes)
    || !sameStringList(releaseCriteria, current.releaseCriteria)
    || Boolean(delta.summary?.trim() && delta.summary.trim() !== current.summary.trim());
  if (!hasContractChange) {
    throw new Error('Contract delta does not contain any contract change.');
  }

  return {
    contract: {
      ...current,
      version: nextVersion,
      summary: delta.summary?.trim() || current.summary,
      invariants,
      prohibitedSubstitutes,
      requirements,
      releaseCriteria
    },
    touchedRequirementIds: [...touched]
  };
}

function normalizeExistingRequirement(
  requirement: ProjectContractRequirement,
  currentVersion: number
): ProjectContractRequirement {
  return {
    ...requirement,
    acceptanceCriteria: [...requirement.acceptanceCriteria],
    briefReferences: requirement.briefReferences ? [...requirement.briefReferences] : undefined,
    status: requirement.status ?? 'active',
    introducedInVersion: requirement.introducedInVersion ?? Math.min(1, currentVersion),
    lastChangedInVersion: requirement.lastChangedInVersion ?? currentVersion
  };
}

function validateRequirementDraft(draft: ProjectContractRequirementDraft, operation: string): void {
  if (!/^REQ-[A-Z0-9-]+$/.test(draft.id)) {
    throw new Error(`Contract delta ${operation} has invalid requirement id "${draft.id}".`);
  }
  if (!draft.title.trim() || !draft.description.trim()) {
    throw new Error(`Contract delta ${operation} has an incomplete requirement "${draft.id}".`);
  }
  cleanStringList(draft.acceptanceCriteria, `acceptance criteria for requirement "${draft.id}"`, true);
}

function copyRequirementDraft(draft: ProjectContractRequirementDraft): ProjectContractRequirementDraft {
  return {
    id: draft.id.trim(),
    title: draft.title.trim(),
    description: draft.description.trim(),
    acceptanceCriteria: cleanStringList(draft.acceptanceCriteria, `acceptance criteria for requirement "${draft.id}"`, true),
    briefReferences: draft.briefReferences
      ? cleanStringList(draft.briefReferences, `brief references for requirement "${draft.id}"`, false)
      : undefined
  };
}

function replaceRequirement(
  requirements: ProjectContractRequirement[],
  byId: Map<string, ProjectContractRequirement>,
  replacement: ProjectContractRequirement
): void {
  const index = requirements.findIndex((requirement) => requirement.id === replacement.id);
  requirements[index] = replacement;
  byId.set(replacement.id, replacement);
}

function applyCollectionDelta(current: string[], delta: ProjectContractCollectionDelta, label: string): string[] {
  const result = [...current];
  const removals = new Set<string>();
  for (const removal of delta.remove) {
    requireRationale(removal.rationale, `removal of ${label} "${removal.value}"`);
    const value = removal.value.trim();
    if (!result.includes(value)) {
      throw new Error(`Contract delta removal references unknown ${label} "${value}".`);
    }
    if (removals.has(value)) {
      throw new Error(`Contract delta removes ${label} "${value}" more than once.`);
    }
    removals.add(value);
  }

  const kept = result.filter((value) => !removals.has(value));
  for (const addition of cleanStringList(delta.add, `${label} additions`, false)) {
    if (!kept.includes(addition)) kept.push(addition);
  }
  return kept;
}

function cleanOptionalText(value: string | undefined, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`Contract delta has an empty ${label}.`);
  return cleaned;
}

function cleanStringList(values: string[], label: string, requireItem: boolean): string[] {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (requireItem && cleaned.length === 0) {
    throw new Error(`Contract delta must provide ${label}.`);
  }
  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error(`Contract delta contains duplicate ${label}.`);
  }
  return cleaned;
}

function requireRationale(value: string, label: string): void {
  if (!value.trim()) throw new Error(`Contract delta requires a rationale for ${label}.`);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
