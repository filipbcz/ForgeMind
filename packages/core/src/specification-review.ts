import type {
  AcceptanceEvidence,
  ProjectContractRequirement,
  ProjectImplementationStep,
  ProjectSpecificationVersion
} from './model.js';

export interface SpecificationDiffLine {
  type: 'unchanged' | 'added' | 'removed';
  oldLineNumber?: number;
  newLineNumber?: number;
  text: string;
}

export interface SpecificationImpactRequirement {
  id: string;
  title: string;
  reason: string;
}

export interface SpecificationImpactStep {
  id: string;
  title: string;
  status: ProjectImplementationStep['status'];
  requirementIds: string[];
}

export interface SpecificationImpactEvidence {
  id: string;
  requirementId: string;
  criterion: string;
  status: AcceptanceEvidence['status'];
  contractVersion: number;
  source: AcceptanceEvidence['source'];
}

export interface SpecificationChangeImpactReview {
  projectId: string;
  baseSpecificationVersion?: number;
  baseSpecificationHash?: string;
  changed: boolean;
  diff: SpecificationDiffLine[];
  impact: {
    requirements: SpecificationImpactRequirement[];
    unfinishedSteps: SpecificationImpactStep[];
    evidence: SpecificationImpactEvidence[];
  };
}

export function buildSpecificationChangeImpactReview(input: {
  projectId: string;
  currentSpecification?: ProjectSpecificationVersion;
  baseSpecificationHash?: string;
  proposedSpecification: string;
  requirements: ProjectContractRequirement[];
  steps: ProjectImplementationStep[];
  evidence: AcceptanceEvidence[];
}): SpecificationChangeImpactReview {
  const currentText = input.currentSpecification?.fullSpecification ?? '';
  const proposedText = input.proposedSpecification.trim();
  const diff = buildLineDiff(currentText, proposedText);
  const changed = diff.some((line) => line.type !== 'unchanged');
  const changedText = diff
    .filter((line) => line.type !== 'unchanged')
    .map((line) => line.text.toLowerCase())
    .join('\n');

  const activeRequirements = input.requirements.filter((requirement) => (
    requirement.status !== 'superseded' && requirement.status !== 'removed'
  ));
  const directlyAffected = changed
    ? activeRequirements.filter((requirement) => requirementMatchesChangedText(requirement, changedText))
    : [];
  const affectedRequirements = directlyAffected.length > 0
    ? directlyAffected
    : changed ? activeRequirements : [];
  const affectedRequirementIds = new Set(affectedRequirements.map((requirement) => requirement.id));

  return {
    projectId: input.projectId,
    baseSpecificationVersion: input.currentSpecification?.version,
    baseSpecificationHash: input.baseSpecificationHash,
    changed,
    diff,
    impact: {
      requirements: affectedRequirements.map((requirement) => ({
        id: requirement.id,
        title: requirement.title,
        reason: directlyAffected.includes(requirement)
          ? 'Changed specification text references this requirement.'
          : 'Specification changed without a narrower requirement match.'
      })),
      unfinishedSteps: input.steps
        .filter((step) => step.status !== 'completed' && step.status !== 'cancelled')
        .filter((step) => affectedRequirementIds.size === 0 || step.requirementIds.some((id) => affectedRequirementIds.has(id)))
        .map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
          requirementIds: step.requirementIds
        })),
      evidence: input.evidence
        .filter((item) => affectedRequirementIds.size === 0 || affectedRequirementIds.has(item.requirementId))
        .map((item) => ({
          id: item.id,
          requirementId: item.requirementId,
          criterion: item.criterion,
          status: item.status,
          contractVersion: item.contractVersion,
          source: item.source
        }))
    }
  };
}

function requirementMatchesChangedText(requirement: ProjectContractRequirement, changedText: string): boolean {
  const candidates = [
    requirement.id,
    requirement.title,
    requirement.description,
    ...requirement.acceptanceCriteria,
    ...(requirement.briefReferences ?? [])
  ];
  return candidates
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 4)
    .some((value) => changedText.includes(value));
}

function buildLineDiff(oldText: string, newText: string): SpecificationDiffLine[] {
  const oldLines = splitSpecificationLines(oldText);
  const newLines = splitSpecificationLines(newText);
  const lengths = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex]![newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[oldIndex + 1]![newIndex + 1]! + 1
        : Math.max(lengths[oldIndex + 1]![newIndex]!, lengths[oldIndex]![newIndex + 1]!);
    }
  }

  const diff: SpecificationDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      diff.push({
        type: 'unchanged',
        oldLineNumber: oldIndex + 1,
        newLineNumber: newIndex + 1,
        text: oldLines[oldIndex]!
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (lengths[oldIndex + 1]![newIndex]! >= lengths[oldIndex]![newIndex + 1]!) {
      diff.push({ type: 'removed', oldLineNumber: oldIndex + 1, text: oldLines[oldIndex]! });
      oldIndex += 1;
    } else {
      diff.push({ type: 'added', newLineNumber: newIndex + 1, text: newLines[newIndex]! });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    diff.push({ type: 'removed', oldLineNumber: oldIndex + 1, text: oldLines[oldIndex]! });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    diff.push({ type: 'added', newLineNumber: newIndex + 1, text: newLines[newIndex]! });
    newIndex += 1;
  }

  return diff;
}

function splitSpecificationLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r?\n/);
}
