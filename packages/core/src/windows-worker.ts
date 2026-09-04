import type { IsoDateString, JsonValue } from '@forgemind/shared';
import type { ValidationCheckCategory } from './model.js';

export const WINDOWS_WORKER_SCHEMA_VERSION = 1 as const;
export type WindowsWorkerSchemaVersion = typeof WINDOWS_WORKER_SCHEMA_VERSION;
export const WINDOWS_EXECUTION_PACKET_VERSION = 2 as const;
export type WindowsExecutionPacketVersion = typeof WINDOWS_EXECUTION_PACKET_VERSION;

export interface WorkerCapability {
  key: string;
  version?: string;
  metadata?: Record<string, JsonValue>;
}

export interface WorkerProbeEvidence {
  schemaVersion: WindowsWorkerSchemaVersion;
  capability: WorkerCapability;
  status: 'supported' | 'unsupported' | 'error';
  probedAt: IsoDateString;
  probeVersion: string;
  summary: string;
  evidenceHash: string;
  metadata?: Record<string, JsonValue>;
}

export function canonicalizeWorkerProbeEvidence(evidence: Omit<WorkerProbeEvidence, 'schemaVersion' | 'evidenceHash' | 'metadata'>): string {
  return JSON.stringify({
    capability: evidence.capability,
    status: evidence.status,
    probedAt: evidence.probedAt,
    probeVersion: evidence.probeVersion,
    summary: evidence.summary
  });
}

export type WorkerDeviceStatus = 'offline' | 'idle' | 'reserved' | 'running' | 'draining' | 'revoked';

export interface WorkerDevice {
  schemaVersion: WindowsWorkerSchemaVersion;
  id: string;
  platform: 'windows';
  runnerVersion: string;
  displayName: string;
  status: WorkerDeviceStatus;
  capabilities: WorkerCapability[];
  probeEvidence: WorkerProbeEvidence[];
  lastHeartbeatAt?: IsoDateString;
  currentSessionId?: string;
  currentJobId?: string;
  metadata?: Record<string, JsonValue>;
}

export type WorkerSessionStatus = 'active' | 'draining' | 'cancelled' | 'expired' | 'closed';

export interface WorkerManualSession {
  schemaVersion: WindowsWorkerSchemaVersion;
  id: string;
  deviceId: string;
  status: WorkerSessionStatus;
  startedAt: IsoDateString;
  expiresAt: IsoDateString;
  lastHeartbeatAt: IsoDateString;
  endedAt?: IsoDateString;
  currentJobId?: string;
}

export interface WindowsValidationCheck {
  command: string;
  shell?: 'system' | 'powershell' | 'cmd' | 'bash' | 'sh';
  category: ValidationCheckCategory;
  criterion?: string;
  requiredCapabilities: string[];
}

/** A validation intent is executable only after a Windows runner matches it to a
 * locally pinned adapter policy. Command is retained solely for display/evidence. */
export type WindowsExecutionDispatch =
  | {
      kind: 'fixture-validation';
      executablePath: string;
      inputRelativePath: string;
      artifactRelativePath: string;
      minimumFreeSpaceBytes: number;
      maxConcurrentProcesses: number;
    }
  | {
      kind: 'unreal-validation';
      profileId: string;
      tool: 'unreal-editor-cmd' | 'build-bat' | 'automation-tool' | 'project-script';
      executablePath: string;
      workingDirectoryRelativePath: string;
      args: string[];
      size: 'standard' | 'large';
      minimumLargeJobFreeSpaceBytes: number;
    }
  | {
      kind: 'deferred';
      reason: 'unsupported_validation_intent' | 'legacy_unsafe_packet';
      handling: 'manual-local';
    };

export type ExecutionJobStatus = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface WindowsExecutionJob {
  schemaVersion: WindowsWorkerSchemaVersion;
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  status: ExecutionJobStatus;
  requiredCapabilities: string[];
  packet: WindowsExecutionPacket;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export type ExecutionLeaseStatus = 'active' | 'released' | 'expired' | 'cancelled';

export interface WindowsExecutionLease {
  schemaVersion: WindowsWorkerSchemaVersion;
  id: string;
  jobId: string;
  deviceId: string;
  sessionId: string;
  status: ExecutionLeaseStatus;
  claimedAt: IsoDateString;
  expiresAt: IsoDateString;
  nonce: string;
}

export interface ExecutionResourcePolicy {
  timeoutSeconds: number;
  maxLogBytes: number;
  maxArtifactBytes: number;
}

export interface ExpectedExecutionArtifact {
  name: string;
  relativePath: string;
  required: boolean;
}

export interface WindowsExecutionEvidenceContext {
  cycleId: string;
  stepId: string;
  requirementIds: string[];
  contractVersion: number;
}

export interface WindowsExecutionPacket {
  schemaVersion: WindowsExecutionPacketVersion;
  projectId: string;
  taskId: string;
  runId: string;
  checkId: string;
  jobId: string;
  leaseId: string;
  repository: string;
  sourceUrl: string;
  commitSha: string;
  workspaceRoot: string;
  artifactRoot: string;
  check: WindowsValidationCheck;
  dispatch: WindowsExecutionDispatch;
  requiredCapabilities: string[];
  resourcePolicy: ExecutionResourcePolicy;
  expectedArtifacts: ExpectedExecutionArtifact[];
  nonce: string;
  inputHash: string;
  evidenceContext?: WindowsExecutionEvidenceContext;
}

export interface ExecutionArtifactResult {
  name: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export const WINDOWS_EVIDENCE_MAX_LOG_BYTES = 256_000;
export const WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES = 10_000_000;
export const WINDOWS_EVIDENCE_MAX_ARTIFACTS = 16;
export const WINDOWS_DEVICE_OFFLINE_AFTER_MS = 30_000;

export interface WindowsEvidenceUpload {
  schemaVersion: WindowsWorkerSchemaVersion;
  jobId: string;
  leaseId: string;
  inputHash: string;
  commitSha: string;
  log: { text: string; sizeBytes: number; sha256: string };
  artifacts: Array<ExecutionArtifactResult & { contentBase64: string; criterion: string }>;
}

export interface WindowsWorkerOperationsReadModel {
  schemaVersion: WindowsWorkerSchemaVersion;
  devices: Array<WorkerDevice & { sessions: WorkerManualSession[] }>;
  waitingValidations: Array<{ jobId: string; taskId: string; criterion?: string; requiredCapabilities: string[]; compatibleDeviceIds: string[] }>;
  evidence: Array<{ jobId: string; taskId: string; checkId: string; criterion?: string; commitSha: string; log?: WindowsEvidenceUpload['log']; artifacts: Array<ExecutionArtifactResult & { criterion: string }> }>;
}

export interface ExecutionToolVersionEvidence {
  tool: string;
  version: string;
  driverVersion?: string;
}

export interface WindowsExecutionResult {
  schemaVersion: WindowsWorkerSchemaVersion;
  projectId: string;
  taskId: string;
  runId: string;
  checkId: string;
  jobId: string;
  leaseId: string;
  deviceId: string;
  sessionId: string;
  nonce: string;
  inputHash: string;
  commitSha: string;
  observedCapabilities: WorkerCapability[];
  toolVersions: ExecutionToolVersionEvidence[];
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'deferred';
  deferredReason?: 'unsupported_validation_intent' | 'legacy_unsafe_packet' | 'manual_local_required';
  startedAt: IsoDateString;
  completedAt: IsoDateString;
  exitCode?: number;
  summary: string;
  logHash: string;
  artifacts: ExecutionArtifactResult[];
}

const deviceTransitions: Record<WorkerDeviceStatus, readonly WorkerDeviceStatus[]> = {
  offline: ['idle', 'revoked'], idle: ['reserved', 'draining', 'offline', 'revoked'],
  reserved: ['running', 'idle', 'draining', 'offline', 'revoked'],
  running: ['idle', 'draining', 'offline', 'revoked'], draining: ['offline', 'revoked'], revoked: []
};
const sessionTransitions: Record<WorkerSessionStatus, readonly WorkerSessionStatus[]> = {
  active: ['draining', 'cancelled', 'expired', 'closed'], draining: ['cancelled', 'expired', 'closed'],
  cancelled: [], expired: [], closed: []
};
const jobTransitions: Record<ExecutionJobStatus, readonly ExecutionJobStatus[]> = {
  queued: ['leased', 'cancelled'], leased: ['running', 'queued', 'cancelled', 'expired'],
  running: ['succeeded', 'failed', 'cancelled', 'expired'], succeeded: [], failed: [], cancelled: [], expired: []
};
const leaseTransitions: Record<ExecutionLeaseStatus, readonly ExecutionLeaseStatus[]> = {
  active: ['released', 'expired', 'cancelled'], released: [], expired: [], cancelled: []
};

export const canTransitionWorkerDevice = (from: WorkerDeviceStatus, to: WorkerDeviceStatus): boolean => deviceTransitions[from].includes(to);
export const canTransitionWorkerSession = (from: WorkerSessionStatus, to: WorkerSessionStatus): boolean => sessionTransitions[from].includes(to);
export const canTransitionExecutionJob = (from: ExecutionJobStatus, to: ExecutionJobStatus): boolean => jobTransitions[from].includes(to);
export const canTransitionExecutionLease = (from: ExecutionLeaseStatus, to: ExecutionLeaseStatus): boolean => leaseTransitions[from].includes(to);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const isGitCommitSha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const isIsoDate = (value: unknown): value is IsoDateString => isNonEmpty(value) && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
const checkCategories: readonly ValidationCheckCategory[] = ['setup', 'build', 'database', 'api', 'browser', 'smoke'];
const isPlainJsonRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isJsonValue = (value: unknown, ancestors = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value) || (!Array.isArray(value) && !isPlainJsonRecord(value))) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
};
const isCapability = (value: unknown): value is WorkerCapability => isRecord(value) && isNonEmpty(value.key)
  && (value.version === undefined || isNonEmpty(value.version))
  && (value.metadata === undefined || (isRecord(value.metadata) && isJsonValue(value.metadata)));
const areCapabilities = (value: unknown): value is WorkerCapability[] => Array.isArray(value) && value.every(isCapability)
  && new Set(value.map((capability) => capability.key)).size === value.length;
const areCapabilityKeys = (value: unknown): value is string[] => Array.isArray(value) && value.every(isNonEmpty)
  && new Set(value).size === value.length;
const capabilityKeysEqual = (left: string[], right: string[]): boolean => left.length === right.length
  && left.every((capability, index) => capability === right[index]);
const isExpectedArtifact = (value: unknown): value is ExpectedExecutionArtifact => isRecord(value) && isNonEmpty(value.name)
  && isNonEmpty(value.relativePath) && typeof value.required === 'boolean';
const isArtifactResult = (value: unknown): value is ExecutionArtifactResult => isRecord(value) && isNonEmpty(value.name)
  && isNonEmpty(value.relativePath) && Number.isInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0 && isSha256(value.sha256);
const isToolVersion = (value: unknown): value is ExecutionToolVersionEvidence => isRecord(value) && isNonEmpty(value.tool)
  && isNonEmpty(value.version) && (value.driverVersion === undefined || isNonEmpty(value.driverVersion));
export function isWindowsExecutionPacket(value: unknown): value is WindowsExecutionPacket {
  if (!isRecord(value) || value.schemaVersion !== WINDOWS_EXECUTION_PACKET_VERSION) return false;
  const required = ['projectId', 'taskId', 'runId', 'checkId', 'jobId', 'leaseId', 'repository', 'sourceUrl', 'workspaceRoot', 'artifactRoot', 'nonce'];
  if (!required.every((key) => isNonEmpty(value[key])) || !isGitCommitSha(value.commitSha) || !isSha256(value.inputHash)) return false;
  if (!areCapabilityKeys(value.requiredCapabilities)) return false;
  if (!isRecord(value.check) || !isNonEmpty(value.check.command)
    || !checkCategories.includes(value.check.category as ValidationCheckCategory)
    || (value.check.shell !== undefined && !['system', 'powershell', 'cmd', 'bash', 'sh'].includes(value.check.shell as string))
    || !areCapabilityKeys(value.check.requiredCapabilities)
    || !capabilityKeysEqual(value.requiredCapabilities, value.check.requiredCapabilities)
    || (value.check.criterion !== undefined && !isNonEmpty(value.check.criterion))) return false;
  if (!isExecutionDispatch(value.dispatch)) return false;
  if (value.evidenceContext !== undefined && (!isRecord(value.evidenceContext)
    || !isNonEmpty(value.evidenceContext.cycleId)
    || !isNonEmpty(value.evidenceContext.stepId)
    || !areCapabilityKeys(value.evidenceContext.requirementIds)
    || !Number.isInteger(value.evidenceContext.contractVersion)
    || (value.evidenceContext.contractVersion as number) <= 0)) return false;
  if (!isRecord(value.resourcePolicy) || !Number.isInteger(value.resourcePolicy.timeoutSeconds) || (value.resourcePolicy.timeoutSeconds as number) <= 0) return false;
  return Number.isInteger(value.resourcePolicy.maxLogBytes) && (value.resourcePolicy.maxLogBytes as number) >= 0
    && Number.isInteger(value.resourcePolicy.maxArtifactBytes) && (value.resourcePolicy.maxArtifactBytes as number) >= 0
    && Array.isArray(value.expectedArtifacts) && value.expectedArtifacts.every(isExpectedArtifact);
}

export type WindowsPacketDisposition =
  | { status: 'supported'; packet: WindowsExecutionPacket }
  | { status: 'deferred'; reason: 'unsupported_validation_intent' | 'legacy_unsafe_packet'; handling: 'manual-local'; message: string };

/** Compatibility boundary used by transports/runners. Legacy command packets are
 * deliberately described as local manual work instead of being interpreted. */
export function classifyWindowsExecutionPacket(value: unknown): WindowsPacketDisposition {
  if (isWindowsExecutionPacket(value)) {
    if (value.dispatch.kind === 'deferred') return {
      status: 'deferred', reason: value.dispatch.reason, handling: value.dispatch.handling,
      message: 'Validation intent has no supported pinned adapter; handle it manually in the active local session.'
    };
    return { status: 'supported', packet: value };
  }
  const legacy = isRecord(value) && value.schemaVersion === 1 && isRecord(value.check) && isNonEmpty(value.check.command);
  return {
    status: 'deferred', reason: legacy ? 'legacy_unsafe_packet' : 'unsupported_validation_intent', handling: 'manual-local',
    message: legacy
      ? 'Legacy shell-command packet is unsafe and must be handled manually in a local session.'
      : 'Unsupported execution packet must be handled manually in a local session.'
  };
}

/** Converts a structurally valid v1 command packet into a non-executable v2
 * packet so an already persisted lease can be reconciled normally. */
export function deferLegacyWindowsExecutionPacket(value: unknown): WindowsExecutionPacket | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  const candidate = {
    ...value,
    schemaVersion: WINDOWS_EXECUTION_PACKET_VERSION,
    dispatch: { kind: 'deferred', reason: 'legacy_unsafe_packet', handling: 'manual-local' }
  };
  return isWindowsExecutionPacket(candidate) ? candidate : undefined;
}

function isSafeRelativePath(value: unknown): value is string {
  return isNonEmpty(value) && !/^(?:[a-z]:|[\\/])/i.test(value) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value);
}

function isExecutionDispatch(value: unknown): value is WindowsExecutionDispatch {
  if (!isRecord(value) || !isNonEmpty(value.kind)) return false;
  if (value.kind === 'deferred') return ['unsupported_validation_intent', 'legacy_unsafe_packet'].includes(value.reason as string)
    && value.handling === 'manual-local';
  if (value.kind === 'fixture-validation') return isNonEmpty(value.executablePath)
    && isSafeRelativePath(value.inputRelativePath) && isSafeRelativePath(value.artifactRelativePath)
    && Number.isSafeInteger(value.minimumFreeSpaceBytes) && (value.minimumFreeSpaceBytes as number) >= 0
    && Number.isSafeInteger(value.maxConcurrentProcesses) && (value.maxConcurrentProcesses as number) > 0;
  if (value.kind === 'unreal-validation') return isNonEmpty(value.profileId)
    && ['unreal-editor-cmd', 'build-bat', 'automation-tool', 'project-script'].includes(value.tool as string)
    && isNonEmpty(value.executablePath) && isSafeRelativePath(value.workingDirectoryRelativePath)
    && Array.isArray(value.args) && value.args.every((arg) => isNonEmpty(arg) && !/[\r\n\0]/.test(arg as string))
    && ['standard', 'large'].includes(value.size as string)
    && Number.isSafeInteger(value.minimumLargeJobFreeSpaceBytes) && (value.minimumLargeJobFreeSpaceBytes as number) >= 0;
  return false;
}

export function isWindowsExecutionResult(value: unknown): value is WindowsExecutionResult {
  if (!isRecord(value) || value.schemaVersion !== WINDOWS_WORKER_SCHEMA_VERSION) return false;
  const required = ['projectId', 'taskId', 'runId', 'checkId', 'jobId', 'leaseId', 'deviceId', 'sessionId', 'nonce', 'summary'];
  return required.every((key) => isNonEmpty(value[key])) && isSha256(value.inputHash) && isGitCommitSha(value.commitSha) && isSha256(value.logHash)
    && isIsoDate(value.startedAt) && isIsoDate(value.completedAt)
    && ['succeeded', 'failed', 'cancelled', 'timed_out', 'deferred'].includes(value.status as string)
    && (value.deferredReason === undefined || ['unsupported_validation_intent', 'legacy_unsafe_packet', 'manual_local_required'].includes(value.deferredReason as string))
    && (value.status === 'deferred' ? isNonEmpty(value.deferredReason) : value.deferredReason === undefined)
    && (value.exitCode === undefined || Number.isInteger(value.exitCode))
    && areCapabilities(value.observedCapabilities)
    && Array.isArray(value.toolVersions) && value.toolVersions.every(isToolVersion)
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifactResult);
}
