import type { PlanResult } from '@forgemind/providers';

const CANONICAL_ARTIFACT_KINDS = new Set([
  'repository', 'persistent-data', 'unreal-assets', 'validation-evidence'
]);
const CANONICAL_VALIDATION_FOCUS = ['implementation', 'migration', 'compatibility', 'regression'] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.from(new Set(array(value)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)));
}

function normalizeProviderCapability(value: string): string[] {
  if (/^unreal-engine(?:-|$)/i.test(value)) return ['unreal'];
  if (/^cesium-for-unreal(?:-|$)/i.test(value)) return ['cesium'];
  if (value === 'cpp-toolchain') return ['msvc', 'windows-sdk'];
  if (value === 'visual-runtime-capture') return ['interactive-desktop', 'gpu'];
  if (value === 'image-generation') return ['asset-tool'];
  // The qualification profile is checked independently and is not a locally
  // probed executable capability.
  if (value === 'borek-filip') return [];
  return [value];
}

function normalizeProviderPersistentPath(value: string): string | undefined {
  const path = value.trim().replaceAll('\\', '/').replace(/\/$/, '');
  if (!path) return undefined;
  if (!/^(?:[A-Za-z]:\/|\/)/.test(path)) return path.replace(/^\.\//, '');

  // A provider may describe the canonical checkout using its machine path.
  // Checkout content is delivered as repository/Unreal artifacts, not as a
  // separately published persistent-data directory.
  if (/\/workspaces\/current\//i.test(path)) return undefined;

  // Known project-data roots are safe to make project-relative. Unknown
  // absolute paths remain untouched so the strict core validator rejects them.
  const marker = path.match(/\/(data|artifacts|installations)\/(.+)$/i);
  return marker ? `${marker[1]!.toLowerCase()}/${marker[2]}` : path;
}

function normalizeValidationFocus(value: unknown): Array<typeof CANONICAL_VALIDATION_FOCUS[number]> {
  const normalized = new Set<typeof CANONICAL_VALIDATION_FOCUS[number]>();
  for (const item of stringArray(value)) {
    const lower = item.toLowerCase();
    for (const focus of CANONICAL_VALIDATION_FOCUS) {
      if (lower === focus || lower.includes(focus)) normalized.add(focus);
    }
  }
  return Array.from(normalized);
}

/**
 * Translate only well-known provider vocabulary into the strict runtime
 * execution-intent contract. The core validator remains the security boundary.
 */
export function normalizeRoadmapExecutionIntent(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  const rawCapabilities = stringArray(source.requiredCapabilities);
  const requiredCapabilities = Array.from(new Set(rawCapabilities.flatMap(normalizeProviderCapability)));
  const rawArtifactKinds = stringArray(source.artifactKinds);
  const persistentOutputPaths = Array.from(new Set(stringArray(source.persistentOutputPaths)
    .map(normalizeProviderPersistentPath)
    .filter((item): item is string => Boolean(item))));
  const requiresUnrealAuthoring = typeof source.requiresUnrealAuthoring === 'boolean'
    ? source.requiresUnrealAuthoring
    : source.unrealEditorSaveRequired;

  if (requiresUnrealAuthoring === true && !requiredCapabilities.includes('unreal')) requiredCapabilities.push('unreal');

  const artifactKinds = new Set(rawArtifactKinds.filter((kind) => CANONICAL_ARTIFACT_KINDS.has(kind)));
  if (rawCapabilities.includes('git')) artifactKinds.add('repository');
  if (persistentOutputPaths.length > 0) artifactKinds.add('persistent-data');
  if (requiresUnrealAuthoring === true) artifactKinds.add('unreal-assets');
  if (rawArtifactKinds.some((kind) => !CANONICAL_ARTIFACT_KINDS.has(kind))) artifactKinds.add('validation-evidence');

  return {
    ...source,
    requiredCapabilities,
    artifactKinds: Array.from(artifactKinds),
    requiresUnrealAuthoring,
    persistentOutputPaths
  };
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
          validationFocus: normalizeValidationFocus(source.validationFocus),
          executionIntent: normalizeRoadmapExecutionIntent(source.executionIntent)
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
