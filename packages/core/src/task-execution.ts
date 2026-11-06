export type TaskExecutionTarget = 'linux' | 'windows';

export type TaskArtifactKind =
  | 'repository'
  | 'persistent-data'
  | 'unreal-assets'
  | 'validation-evidence';

export type TaskNetworkAccess = 'none' | 'https';

/**
 * Declares what a single implementation step needs from its execution
 * environment. This is intentionally task-scoped: a project may contain data
 * acquisition, native build, and editor-authoring steps with different needs.
 */
export interface TaskExecutionIntent {
  executor: TaskExecutionTarget;
  requiredCapabilities: string[];
  artifactKinds: TaskArtifactKind[];
  networkAccess: TaskNetworkAccess;
  requiresUnrealAuthoring: boolean;
  persistentOutputPaths: string[];
  minimumFreeSpaceBytes: number;
}

const CAPABILITY_KEY = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const ARTIFACT_KINDS = new Set<TaskArtifactKind>([
  'repository', 'persistent-data', 'unreal-assets', 'validation-evidence'
]);

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)));
}

function isSafePersistentPath(path: string): boolean {
  return Boolean(path)
    && path !== '.'
    && !path.startsWith('/')
    && !/^[A-Za-z]:/.test(path)
    && path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..');
}

export function normalizeTaskExecutionIntent(value: unknown): TaskExecutionIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.executor !== 'linux' && item.executor !== 'windows') return undefined;
  if (item.networkAccess !== 'none' && item.networkAccess !== 'https') return undefined;
  if (typeof item.requiresUnrealAuthoring !== 'boolean') return undefined;
  if (!Number.isSafeInteger(item.minimumFreeSpaceBytes) || Number(item.minimumFreeSpaceBytes) < 0) return undefined;

  const requiredCapabilities = uniqueStrings(item.requiredCapabilities);
  const artifactKinds = uniqueStrings(item.artifactKinds)
    .filter((kind): kind is TaskArtifactKind => ARTIFACT_KINDS.has(kind as TaskArtifactKind));
  const persistentOutputPaths = uniqueStrings(item.persistentOutputPaths).map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''));
  if (requiredCapabilities.length !== (Array.isArray(item.requiredCapabilities) ? new Set(item.requiredCapabilities).size : -1)
    || requiredCapabilities.some((capability) => !CAPABILITY_KEY.test(capability))
    || artifactKinds.length === 0
    || artifactKinds.length !== (Array.isArray(item.artifactKinds) ? new Set(item.artifactKinds).size : -1)
    || persistentOutputPaths.length !== (Array.isArray(item.persistentOutputPaths) ? new Set(item.persistentOutputPaths).size : -1)
    || persistentOutputPaths.some((path) => !isSafePersistentPath(path))) return undefined;

  const capabilities = new Set(requiredCapabilities);
  const kinds = new Set(artifactKinds);
  if (item.executor === 'windows' && !capabilities.has('windows')) return undefined;
  if (item.executor === 'linux' && capabilities.has('windows')) return undefined;
  if (item.executor !== 'windows' && (item.networkAccess === 'https' || kinds.has('persistent-data'))) return undefined;
  if (item.networkAccess === 'https' && !capabilities.has('https-download')) return undefined;
  if (Number(item.minimumFreeSpaceBytes) > 0 && !capabilities.has('disk-capacity')) return undefined;
  if (item.requiresUnrealAuthoring
    && (item.executor !== 'windows' || !capabilities.has('unreal') || !kinds.has('unreal-assets'))) return undefined;
  if (!item.requiresUnrealAuthoring && kinds.has('unreal-assets')) return undefined;
  if ((persistentOutputPaths.length > 0) !== kinds.has('persistent-data')) return undefined;

  return {
    executor: item.executor,
    requiredCapabilities,
    artifactKinds,
    networkAccess: item.networkAccess,
    requiresUnrealAuthoring: item.requiresUnrealAuthoring,
    persistentOutputPaths,
    minimumFreeSpaceBytes: Number(item.minimumFreeSpaceBytes)
  };
}

export function assertTaskExecutionIntent(value: unknown, label = 'Task execution intent'): TaskExecutionIntent {
  const normalized = normalizeTaskExecutionIntent(value);
  if (!normalized) {
    throw new Error(`${label} is invalid or internally inconsistent.`);
  }
  return normalized;
}

export function legacyTaskExecutionIntent(input: {
  implementationOwner: TaskExecutionTarget;
  requiredCapabilities?: string[];
  requiresUnrealAssets?: boolean;
}): TaskExecutionIntent {
  const windows = input.implementationOwner === 'windows';
  const requiresUnrealAuthoring = windows && input.requiresUnrealAssets === true;
  const requiredCapabilities = Array.from(new Set([
    ...(windows ? ['windows'] : []),
    ...(requiresUnrealAuthoring ? ['unreal', 'git-lfs'] : []),
    ...(input.requiredCapabilities ?? [])
  ].map((item) => item.trim()).filter(Boolean)));
  return {
    executor: input.implementationOwner,
    requiredCapabilities,
    artifactKinds: requiresUnrealAuthoring ? ['repository', 'unreal-assets'] : ['repository'],
    networkAccess: 'none',
    requiresUnrealAuthoring,
    persistentOutputPaths: [],
    minimumFreeSpaceBytes: 0
  };
}
