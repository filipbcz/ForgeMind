import type { ValidationCheck } from '@forgemind/providers';

const PLATFORM_CAPABILITIES: Record<NodeJS.Platform, string | undefined> = {
  aix: undefined,
  android: undefined,
  darwin: 'macos',
  freebsd: undefined,
  haiku: undefined,
  linux: 'linux',
  openbsd: undefined,
  sunos: undefined,
  win32: 'windows',
  cygwin: 'windows',
  netbsd: undefined
};

export function resolveWorkerCapabilities(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ReadonlySet<string> {
  const capabilities = new Set<string>();
  const platformCapability = PLATFORM_CAPABILITIES[platform];
  if (platformCapability) capabilities.add(platformCapability);
  for (const capability of (source.FORGEMIND_WORKER_CAPABILITIES ?? '').split(',')) {
    const normalized = normalizeCapability(capability);
    if (normalized) capabilities.add(normalized);
  }
  return capabilities;
}

export function requiredValidationCapabilities(check: ValidationCheck): string[] {
  const declared = check.requiredCapabilities ?? [];
  const inferred = inferLegacyCommandCapabilities(check.command);
  return Array.from(new Set([...declared, ...inferred].map(normalizeCapability).filter(Boolean)));
}

export function missingValidationCapabilities(
  check: ValidationCheck,
  availableCapabilities: ReadonlySet<string>
): string[] {
  return requiredValidationCapabilities(check).filter((capability) => !availableCapabilities.has(capability));
}

export function normalizeCapability(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'win32' || normalized === 'win64') return 'windows';
  if (normalized === 'darwin' || normalized === 'osx') return 'macos';
  return normalized;
}

function inferLegacyCommandCapabilities(command: string): string[] {
  if (/\b(?:UnrealEditor(?:-Cmd)?\.exe|Build\.bat)\b/i.test(command)) return ['windows'];
  if (
    /--require-unreal-build-run\b/i.test(command)
    && (/\bwin64\b/i.test(command) || /validate_unreal_cesium_shell/i.test(command))
  ) return ['windows'];
  return [];
}
