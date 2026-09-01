import type { IsoDateString, JsonValue } from '@forgemind/shared';
import type { ValidationCheckCategory } from './model.js';

export const WINDOWS_WORKER_SCHEMA_VERSION = 1 as const;
export type WindowsWorkerSchemaVersion = typeof WINDOWS_WORKER_SCHEMA_VERSION;

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
  category: ValidationCheckCategory;
  criterion?: string;
  requiredCapabilities: string[];
}

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

export interface WindowsExecutionPacket {
  schemaVersion: WindowsWorkerSchemaVersion;
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
  requiredCapabilities: string[];
  resourcePolicy: ExecutionResourcePolicy;
  expectedArtifacts: ExpectedExecutionArtifact[];
  nonce: string;
  inputHash: string;
}

export interface ExecutionArtifactResult {
  name: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
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
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
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
  if (!isRecord(value) || value.schemaVersion !== WINDOWS_WORKER_SCHEMA_VERSION) return false;
  const required = ['projectId', 'taskId', 'runId', 'checkId', 'jobId', 'leaseId', 'repository', 'sourceUrl', 'workspaceRoot', 'artifactRoot', 'nonce'];
  if (!required.every((key) => isNonEmpty(value[key])) || !isSha256(value.commitSha) || !isSha256(value.inputHash)) return false;
  if (!areCapabilityKeys(value.requiredCapabilities)) return false;
  if (!isRecord(value.check) || !isNonEmpty(value.check.command)
    || !checkCategories.includes(value.check.category as ValidationCheckCategory)
    || !areCapabilityKeys(value.check.requiredCapabilities)
    || !capabilityKeysEqual(value.requiredCapabilities, value.check.requiredCapabilities)
    || (value.check.criterion !== undefined && !isNonEmpty(value.check.criterion))) return false;
  if (!isRecord(value.resourcePolicy) || !Number.isInteger(value.resourcePolicy.timeoutSeconds) || (value.resourcePolicy.timeoutSeconds as number) <= 0) return false;
  return Number.isInteger(value.resourcePolicy.maxLogBytes) && (value.resourcePolicy.maxLogBytes as number) >= 0
    && Number.isInteger(value.resourcePolicy.maxArtifactBytes) && (value.resourcePolicy.maxArtifactBytes as number) >= 0
    && Array.isArray(value.expectedArtifacts) && value.expectedArtifacts.every(isExpectedArtifact);
}

export function isWindowsExecutionResult(value: unknown): value is WindowsExecutionResult {
  if (!isRecord(value) || value.schemaVersion !== WINDOWS_WORKER_SCHEMA_VERSION) return false;
  const required = ['projectId', 'taskId', 'runId', 'checkId', 'jobId', 'leaseId', 'deviceId', 'sessionId', 'nonce', 'summary'];
  return required.every((key) => isNonEmpty(value[key])) && isSha256(value.inputHash) && isSha256(value.commitSha) && isSha256(value.logHash)
    && isIsoDate(value.startedAt) && isIsoDate(value.completedAt)
    && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(value.status as string)
    && (value.exitCode === undefined || Number.isInteger(value.exitCode))
    && areCapabilities(value.observedCapabilities)
    && Array.isArray(value.toolVersions) && value.toolVersions.every(isToolVersion)
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifactResult);
}
