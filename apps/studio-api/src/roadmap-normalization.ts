import type { PlanResult } from '@forgemind/providers';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeCollectionDelta(value: unknown): Record<string, unknown> {
  const source = record(value) ?? {};
  return {
    ...source,
    add: array(source.add ?? source.additions),
    remove: array(source.remove ?? source.removals)
  };
}

export function normalizeRoadmapContractDelta(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  return {
    ...source,
    summary: source.summary ?? source.rationale,
    addRequirements: array(source.addRequirements ?? source.requirementAdditions),
    updateRequirements: array(source.updateRequirements ?? source.requirementUpdates),
    supersedeRequirements: array(source.supersedeRequirements ?? source.requirementSupersessions),
    removeRequirements: array(source.removeRequirements ?? source.requirementRemovals),
    invariantChanges: normalizeCollectionDelta(source.invariantChanges),
    prohibitedSubstituteChanges: normalizeCollectionDelta(source.prohibitedSubstituteChanges),
    releaseCriteriaChanges: normalizeCollectionDelta(source.releaseCriteriaChanges),
    migrationImpacts: array(source.migrationImpacts),
    compatibilityImpacts: array(source.compatibilityImpacts)
  };
}

export function normalizeRoadmapArchitectureUpdate(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  return {
    ...source,
    modules: array(source.modules),
    databaseSchemas: array(source.databaseSchemas),
    decisions: array(source.decisions),
    conventions: array(source.conventions),
    dependencyRules: array(source.dependencyRules ?? source.preservedBoundaries),
    knownDebt: array(source.knownDebt),
    resolvedDebt: array(source.resolvedDebt)
  };
}

/** Fill only semantically empty structural fields; never invent required implementation content. */
export function normalizeRoadmapPlan(plan: PlanResult): PlanResult {
  const implementationSteps = Array.isArray(plan.implementationSteps)
    ? plan.implementationSteps.map((step) => {
        const source = record(step) ?? {};
        return {
          ...source,
          outOfScope: array(source.outOfScope),
          dependsOnStepTitles: array(source.dependsOnStepTitles),
          validationFocus: array(source.validationFocus)
        };
      })
    : plan.implementationSteps;
  return {
    ...plan,
    contractDelta: normalizeRoadmapContractDelta(plan.contractDelta) as PlanResult['contractDelta'],
    architectureUpdate: normalizeRoadmapArchitectureUpdate(plan.architectureUpdate) as PlanResult['architectureUpdate'],
    implementationSteps: implementationSteps as PlanResult['implementationSteps']
  };
}
