import type { IsoDateString, JsonValue } from '@forgemind/shared';
import type { ValidationCheckCategory } from './model.js';

export const WINDOWS_WORKER_SCHEMA_VERSION = 1 as const;
export type WindowsWorkerSchemaVersion = typeof WINDOWS_WORKER_SCHEMA_VERSION;
export const WINDOWS_EXECUTION_PACKET_VERSION = 2 as const;
export type WindowsExecutionPacketVersion = typeof WINDOWS_EXECUTION_PACKET_VERSION;
export const WINDOWS_AUTHORING_PROTOCOL_VERSION = 1 as const;
export type WindowsAuthoringProtocolVersion = typeof WINDOWS_AUTHORING_PROTOCOL_VERSION;

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
  provenance: 'local-probe' | 'fixture';
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
    provenance: evidence.provenance,
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
  packet: WindowsJobPacket;
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
  mimeType?: string;
  required: boolean;
}

export interface WindowsExecutionEvidenceContext {
  cycleId: string;
  stepId: string;
  requirementIds: string[];
  contractVersion: number;
}

/** Mutually exclusive real-engine evidence purposes. A consumer must request the
 * exact purpose it needs; successful evidence is never interchangeable. */
export type RealEngineEvidenceClassification =
  | 'automated-scenario' | 'benchmark' | 'soak' | 'build-validation' | 'capture' | 'shipping';
export type RealEngineEvidenceState =
  | 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'missing-capability' | 'incomplete-output';

export interface RealEngineEvidenceIntent {
  classification: RealEngineEvidenceClassification;
  buildId: string;
  scenario: string;
  settings: Record<string, JsonValue>;
  /** Shipping is current only when this immutable executable identity is set by
   * the producer which selected the real Win64 Shipping build. */
  shippingExecutable?: { relativePath: string; sha256: string; platform: 'Win64'; configuration: 'Shipping'; current: boolean };
}

export interface RealEngineEvidence extends RealEngineEvidenceIntent {
  projectId: string;
  taskId: string;
  runId: string;
  inputHash: string;
  resultTreeSha: string;
  toolVersions: ExecutionToolVersionEvidence[];
  startedAt: IsoDateString;
  completedAt: IsoDateString;
  durationMs: number;
  state: RealEngineEvidenceState;
  exitCode?: number;
  artifacts: ExecutionArtifactResult[];
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
  realEngineEvidence?: RealEngineEvidenceIntent;
}

export type AuthoringOperationIntent =
  | { id: string; kind: 'create' | 'modify' | 'delete' | 'move'; path: string; destinationPath?: string; rationale: string }
  | { id: string; kind: 'tool'; tool: string; arguments: JsonValue; rationale: string };

export interface AuthoringCheckpoint {
  id: string;
  label: string;
  afterOperationIds: string[];
  artifactExpectationNames: string[];
}

export interface AuthoringArtifactExpectation extends ExpectedExecutionArtifact {
  delivery: 'inline' | 'artifact-store';
  binary: boolean;
  maxBytes: number;
}

/** An authoring packet conveys declarative intent only. Runners resolve intents
 * through their locally trusted implementation; it never carries shell commands
 * or service credentials. */
export interface WindowsAuthoringPacket {
  kind: 'authoring';
  protocolVersion: WindowsAuthoringProtocolVersion;
  projectId: string;
  taskId: string;
  runId: string;
  jobId: string;
  leaseId: string;
  repository: string;
  sourceUrl: string;
  baseCommitSha: string;
  workspaceRoot: string;
  artifactRoot: string;
  /** The complete, current implementation step. No roadmap or prior task context is
   * available to the native implementation provider. */
  step: { prompt: string; acceptanceCriteria: string[]; previousValidationError?: string; previousReviewBlockers?: string[]; priorPatch?: string;
    previousFailures?: Array<{ checkId: string; command: string; shell: 'powershell' | 'cmd' | 'system'; exitCode?: number; stdout: string; stderr: string }> };
  operations: AuthoringOperationIntent[];
  requiredCapabilities: string[];
  managedRoots: string[];
  checkpoints: AuthoringCheckpoint[];
  artifactExpectations: AuthoringArtifactExpectation[];
  contentPolicy: { requiresUnrealAssets: boolean; prohibitedDatasetExtensions: string[]; maxUnclassifiedFileBytes: number };
  resourcePolicy: ExecutionResourcePolicy;
  nonce: string;
  inputHash: string;
  realEngineEvidence?: RealEngineEvidenceIntent;
  authority: {
    database: 'none';
    productionHosts: 'none';
    globalGitHubCredentials: 'none';
  };
}

export interface AuthoringTreeEntry {
  path: string;
  kind: 'file' | 'symlink';
  sha256: string;
  sizeBytes: number;
  binary: boolean;
  mode: string;
}

export interface WindowsAuthoringResult {
  kind: 'authoring-result';
  protocolVersion: WindowsAuthoringProtocolVersion;
  projectId: string;
  taskId: string;
  runId: string;
  jobId: string;
  leaseId: string;
  deviceId: string;
  sessionId: string;
  nonce: string;
  inputHash: string;
  baseCommitSha: string;
  resultTreeSha: string;
  /** Authenticates the complete binary Git patch transported to the server. */
  resultBundle: { version: 1; format: 'git-binary-patch'; sha256: string; sizeBytes: number;
    lfsObjects: Array<{ oid: string; sha256: string; sizeBytes: number; contentBase64: string }>;
    outputs: Array<{ path: string; sha256: string; sizeBytes: number; contentBase64: string }> };
  tree: AuthoringTreeEntry[];
  /** Binary-safe Git patch used by the server-side review and delivery lifecycle. */
  patch: string;
  completedOperationIds: string[];
  checkpointIds: string[];
  artifacts: ExecutionArtifactResult[];
  processes: WindowsAuthoringProcessResult[];
  contentAssessment: { technicalVerification: 'passed' | 'not-required'; productionReviewRequired: boolean; rationale: string };
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAt: IsoDateString;
  completedAt: IsoDateString;
  summary: string;
  realEngineEvidence?: RealEngineEvidence;
}

export interface WindowsAuthoringProcessResult {
  leaseId: string;
  sessionId: string;
  checkId: string;
  command: string;
  shell: 'powershell' | 'cmd' | 'system';
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: IsoDateString;
  completedAt: IsoDateString;
  terminationReason?: 'timed-out' | 'cancelled' | 'missing-capability';
  /** Present for structured Unreal authoring calls. Unlike legacy validation,
   * these calls deliberately carry the AI-selected argument vector. */
  authoring?: { tool: 'unreal-editor' | 'unreal-python' | 'project-script' | 'cpp-tool'; phase: 'author' | 'verify' | 'build' | 'cook' | 'package';
    projectRelativePath: string; executablePath: string; args: string[]; sourceRelativePaths: string[]; loadedPackages?: string[];
    inspections?: Array<{ path: string; className: string; technicalObservations: string[] }> };
}

export type WindowsJobPacket = WindowsExecutionPacket | WindowsAuthoringPacket;
export type WindowsJobResult = WindowsExecutionResult | WindowsAuthoringResult;

export interface ExecutionArtifactResult {
  name: string;
  relativePath: string;
  mimeType?: string;
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
  realEngineEvidence?: RealEngineEvidence;
}

export type WindowsCapabilityWaitReason = 'unavailable_capability' | 'insufficient_capacity';
export type WindowsPendingPhase = 'probe' | 'author' | 'validate' | 'package';

export interface WindowsWorkerOperationsReadModel {
  schemaVersion: WindowsWorkerSchemaVersion;
  devices: Array<WorkerDevice & { sessions: WorkerManualSession[] }>;
  waitingValidations: Array<{ jobId: string; taskId: string; criterion?: string; requiredCapabilities: string[]; compatibleDeviceIds: string[];
    waitReason: WindowsCapabilityWaitReason; pendingPhase: WindowsPendingPhase }>;
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
  realEngineEvidence?: RealEngineEvidence;
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
  && isNonEmpty(value.relativePath) && (value.mimeType === undefined || isNonEmpty(value.mimeType)) && typeof value.required === 'boolean';
const isArtifactResult = (value: unknown): value is ExecutionArtifactResult => isRecord(value) && isNonEmpty(value.name)
  && isNonEmpty(value.relativePath) && (value.mimeType === undefined || isNonEmpty(value.mimeType))
  && Number.isInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0 && isSha256(value.sha256);
const isToolVersion = (value: unknown): value is ExecutionToolVersionEvidence => isRecord(value) && isNonEmpty(value.tool)
  && isNonEmpty(value.version) && (value.driverVersion === undefined || isNonEmpty(value.driverVersion));
const evidenceClassifications: RealEngineEvidenceClassification[] = ['automated-scenario', 'benchmark', 'soak', 'build-validation', 'capture', 'shipping'];
const evidenceStates: RealEngineEvidenceState[] = ['succeeded', 'failed', 'timed-out', 'cancelled', 'missing-capability', 'incomplete-output'];
const isEvidenceIntent = (value: unknown): value is RealEngineEvidenceIntent => isRecord(value)
  && evidenceClassifications.includes(value.classification as RealEngineEvidenceClassification)
  && isNonEmpty(value.buildId) && isNonEmpty(value.scenario) && isRecord(value.settings) && isJsonValue(value.settings)
  && (value.shippingExecutable === undefined || (isRecord(value.shippingExecutable)
    && isSafeRelativePath(value.shippingExecutable.relativePath) && /\.exe$/i.test(value.shippingExecutable.relativePath as string)
    && isSha256(value.shippingExecutable.sha256) && value.shippingExecutable.platform === 'Win64'
    && value.shippingExecutable.configuration === 'Shipping' && typeof value.shippingExecutable.current === 'boolean'))
  && (value.classification === 'shipping' ? value.shippingExecutable !== undefined : value.shippingExecutable === undefined);
export const isRealEngineEvidence = (value: unknown): value is RealEngineEvidence => isEvidenceIntent(value) && isRecord(value)
  && ['projectId', 'taskId', 'runId'].every((key) => isNonEmpty(value[key])) && isSha256(value.inputHash)
  && isGitCommitSha(value.resultTreeSha) && Array.isArray(value.toolVersions) && value.toolVersions.every(isToolVersion)
  && isIsoDate(value.startedAt) && isIsoDate(value.completedAt) && Number.isSafeInteger(value.durationMs) && (value.durationMs as number) >= 0
  && evidenceStates.includes(value.state as RealEngineEvidenceState) && (value.exitCode === undefined || Number.isInteger(value.exitCode))
  && Array.isArray(value.artifacts) && value.artifacts.every(isArtifactResult);

/** Exact reconciliation shared by native authoring and validation artifact paths. */
export function reconcileRealEngineEvidence(intent: RealEngineEvidenceIntent | undefined, evidence: RealEngineEvidence | undefined,
  identity: { projectId: string; taskId: string; runId: string; inputHash: string; resultTreeSha: string }): boolean {
  if (!intent && !evidence) return true; // legacy evidence compatibility
  if (!intent || !evidence || !isEvidenceIntent(intent) || !isRealEngineEvidence(evidence)) return false;
  if (intent.classification !== evidence.classification || intent.buildId !== evidence.buildId || intent.scenario !== evidence.scenario
    || JSON.stringify(intent.settings) !== JSON.stringify(evidence.settings)
    || evidence.projectId !== identity.projectId || evidence.taskId !== identity.taskId || evidence.runId !== identity.runId
    || evidence.inputHash.toLowerCase() !== identity.inputHash.toLowerCase()
    || evidence.resultTreeSha.toLowerCase() !== identity.resultTreeSha.toLowerCase()) return false;
  if (intent.classification === 'shipping') {
    const executable = evidence.shippingExecutable;
    return executable?.current === true && intent.shippingExecutable?.current === true
      && JSON.stringify(executable) === JSON.stringify(intent.shippingExecutable)
      && evidence.artifacts.some((artifact) => artifact.relativePath === executable.relativePath
        && artifact.sha256.toLowerCase() === executable.sha256.toLowerCase());
  }
  return true;
}
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
  if (value.realEngineEvidence !== undefined && !isEvidenceIntent(value.realEngineEvidence)) return false;
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
    && Array.isArray(value.artifacts) && value.artifacts.every(isArtifactResult)
    && (value.realEngineEvidence === undefined || isRealEngineEvidence(value.realEngineEvidence));
}

const isAuthoringIntent = (value: unknown): value is AuthoringOperationIntent => {
  if (!isRecord(value) || !isNonEmpty(value.id) || !isNonEmpty(value.rationale)) return false;
  if (value.kind === 'tool') return isNonEmpty(value.tool) && isJsonValue(value.arguments);
  return ['create', 'modify', 'delete', 'move'].includes(value.kind as string) && isSafeRelativePath(value.path)
    && (value.destinationPath === undefined || isSafeRelativePath(value.destinationPath))
    && (value.kind === 'move' ? isSafeRelativePath(value.destinationPath) : value.destinationPath === undefined);
};

export function isWindowsAuthoringPacket(value: unknown): value is WindowsAuthoringPacket {
  if (!isRecord(value) || value.kind !== 'authoring' || value.protocolVersion !== WINDOWS_AUTHORING_PROTOCOL_VERSION) return false;
  const identities = ['projectId', 'taskId', 'runId', 'jobId', 'leaseId', 'repository', 'sourceUrl', 'workspaceRoot', 'artifactRoot', 'nonce'];
  if (!identities.every((key) => isNonEmpty(value[key])) || !isGitCommitSha(value.baseCommitSha) || !isSha256(value.inputHash)
    || !areCapabilityKeys(value.requiredCapabilities) || !Array.isArray(value.managedRoots) || value.managedRoots.length === 0
    || !value.managedRoots.every((root) => root === '.' || isSafeRelativePath(root)) || new Set(value.managedRoots).size !== value.managedRoots.length
    || !isRecord(value.contentPolicy) || typeof value.contentPolicy.requiresUnrealAssets !== 'boolean'
    || !areCapabilityKeys(value.contentPolicy.prohibitedDatasetExtensions)
    || !value.contentPolicy.prohibitedDatasetExtensions.every((extension) => /^\.[a-z0-9]+$/i.test(extension))
    || !Number.isSafeInteger(value.contentPolicy.maxUnclassifiedFileBytes) || (value.contentPolicy.maxUnclassifiedFileBytes as number) <= 0
    || !isRecord(value.step) || !isNonEmpty(value.step.prompt) || !Array.isArray(value.step.acceptanceCriteria)
    || !value.step.acceptanceCriteria.every(isNonEmpty)
    || (value.step.previousValidationError !== undefined && typeof value.step.previousValidationError !== 'string')
    || (value.step.previousReviewBlockers !== undefined && (!Array.isArray(value.step.previousReviewBlockers) || !value.step.previousReviewBlockers.every(isNonEmpty)))
    || (value.step.priorPatch !== undefined && typeof value.step.priorPatch !== 'string')
    || !Array.isArray(value.operations) || value.operations.length === 0 || !value.operations.every(isAuthoringIntent)
    || (value.realEngineEvidence !== undefined && !isEvidenceIntent(value.realEngineEvidence))) return false;
  const operationIds = (value.operations as AuthoringOperationIntent[]).map(({ id }) => id);
  const managedRoots = value.managedRoots as string[];
  if (new Set(operationIds).size !== operationIds.length || !Array.isArray(value.checkpoints) || !value.checkpoints.every((checkpoint) => isRecord(checkpoint)
    && isNonEmpty(checkpoint.id) && isNonEmpty(checkpoint.label) && areCapabilityKeys(checkpoint.afterOperationIds)
    && checkpoint.afterOperationIds.every((id) => operationIds.includes(id)) && areCapabilityKeys(checkpoint.artifactExpectationNames))) return false;
  if ((value.operations as AuthoringOperationIntent[]).some((operation) => operation.kind !== 'tool'
    && ![operation.path, operation.destinationPath].filter((path): path is string => path !== undefined)
      .every((path) => managedRoots.some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))))) return false;
  if (!Array.isArray(value.artifactExpectations) || !value.artifactExpectations.every((artifact) => isExpectedArtifact(artifact)
    && ['inline', 'artifact-store'].includes((artifact as unknown as Record<string, unknown>).delivery as string)
    && typeof (artifact as unknown as Record<string, unknown>).binary === 'boolean'
    && Number.isSafeInteger((artifact as unknown as Record<string, unknown>).maxBytes)
    && ((artifact as unknown as Record<string, unknown>).maxBytes as number) >= 0)) return false;
  const checkpointIds = (value.checkpoints as AuthoringCheckpoint[]).map(({ id }) => id);
  const expectationNames = (value.artifactExpectations as AuthoringArtifactExpectation[]).map(({ name }) => name);
  if (new Set(checkpointIds).size !== checkpointIds.length || new Set(expectationNames).size !== expectationNames.length
    || (value.checkpoints as AuthoringCheckpoint[]).some((checkpoint) => checkpoint.artifactExpectationNames.some((name) => !expectationNames.includes(name)))) return false;
  if (!isRecord(value.resourcePolicy) || !Number.isInteger(value.resourcePolicy.timeoutSeconds) || (value.resourcePolicy.timeoutSeconds as number) <= 0
    || !Number.isInteger(value.resourcePolicy.maxLogBytes) || (value.resourcePolicy.maxLogBytes as number) < 0
    || !Number.isInteger(value.resourcePolicy.maxArtifactBytes) || (value.resourcePolicy.maxArtifactBytes as number) < 0) return false;
  return isRecord(value.authority) && value.authority.database === 'none' && value.authority.productionHosts === 'none'
    && value.authority.globalGitHubCredentials === 'none';
}

export function isWindowsAuthoringResult(value: unknown): value is WindowsAuthoringResult {
  if (!isRecord(value) || value.kind !== 'authoring-result' || value.protocolVersion !== WINDOWS_AUTHORING_PROTOCOL_VERSION) return false;
  const identities = ['projectId', 'taskId', 'runId', 'jobId', 'leaseId', 'deviceId', 'sessionId', 'nonce', 'summary'];
  return identities.every((key) => isNonEmpty(value[key])) && isSha256(value.inputHash) && isGitCommitSha(value.baseCommitSha)
    && isGitCommitSha(value.resultTreeSha) && ['succeeded', 'failed', 'cancelled'].includes(value.status as string)
    && isIsoDate(value.startedAt) && isIsoDate(value.completedAt) && areCapabilityKeys(value.completedOperationIds)
    && isRecord(value.contentAssessment) && ['passed', 'not-required'].includes(value.contentAssessment.technicalVerification as string)
    && typeof value.contentAssessment.productionReviewRequired === 'boolean' && isNonEmpty(value.contentAssessment.rationale)
    && areCapabilityKeys(value.checkpointIds) && Array.isArray(value.artifacts) && value.artifacts.every(isArtifactResult)
    && Array.isArray(value.processes) && value.processes.every((process) => isRecord(process) && isNonEmpty(process.checkId)
      && process.leaseId === value.leaseId && process.sessionId === value.sessionId
      && isNonEmpty(process.command) && ['powershell', 'cmd', 'system'].includes(process.shell as string)
      && (process.exitCode === undefined || Number.isInteger(process.exitCode)) && typeof process.stdout === 'string'
      && typeof process.stderr === 'string' && isIsoDate(process.startedAt) && isIsoDate(process.completedAt)
      && (process.terminationReason === undefined || ['timed-out', 'cancelled', 'missing-capability'].includes(process.terminationReason as string))
      && (process.authoring === undefined || (isRecord(process.authoring)
        && ['unreal-editor', 'unreal-python', 'project-script', 'cpp-tool'].includes(process.authoring.tool as string)
        && ['author', 'verify', 'build', 'cook', 'package'].includes(process.authoring.phase as string)
        && isSafeRelativePath(process.authoring.projectRelativePath) && isNonEmpty(process.authoring.executablePath)
        && Array.isArray(process.authoring.args) && process.authoring.args.every((arg) => typeof arg === 'string')
        && Array.isArray(process.authoring.sourceRelativePaths) && process.authoring.sourceRelativePaths.every(isSafeRelativePath)
        && (process.authoring.loadedPackages === undefined || (Array.isArray(process.authoring.loadedPackages)
          && process.authoring.loadedPackages.every(isSafeRelativePath)))
        && (process.authoring.inspections === undefined || (Array.isArray(process.authoring.inspections)
          && process.authoring.inspections.every((inspection) => isRecord(inspection) && isSafeRelativePath(inspection.path)
            && isNonEmpty(inspection.className) && areCapabilityKeys(inspection.technicalObservations)))))))
    && isRecord(value.resultBundle) && value.resultBundle.version === 1 && value.resultBundle.format === 'git-binary-patch'
    && isSha256(value.resultBundle.sha256) && Number.isSafeInteger(value.resultBundle.sizeBytes) && (value.resultBundle.sizeBytes as number) >= 0
    && Array.isArray(value.resultBundle.lfsObjects) && value.resultBundle.lfsObjects.every((object) => isRecord(object)
      && isSha256(object.oid) && object.oid === object.sha256 && Number.isSafeInteger(object.sizeBytes) && (object.sizeBytes as number) >= 0
      && typeof object.contentBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(object.contentBase64))
    && Array.isArray(value.resultBundle.outputs) && value.resultBundle.outputs.every((output) => isRecord(output)
      && isSafeRelativePath(output.path) && isSha256(output.sha256) && Number.isSafeInteger(output.sizeBytes) && (output.sizeBytes as number) >= 0
      && typeof output.contentBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(output.contentBase64))
    && typeof value.patch === 'string' && new TextEncoder().encode(value.patch).byteLength === value.resultBundle.sizeBytes
    && Array.isArray(value.tree) && value.tree.every((entry) => isRecord(entry) && isSafeRelativePath(entry.path)
      && ['file', 'symlink'].includes(entry.kind as string) && isSha256(entry.sha256) && Number.isSafeInteger(entry.sizeBytes)
      && (entry.sizeBytes as number) >= 0 && typeof entry.binary === 'boolean' && /^[0-7]{6}$/.test(String(entry.mode)))
    && new Set((value.tree as AuthoringTreeEntry[]).map(({ path }) => path)).size === value.tree.length
    && (value.realEngineEvidence === undefined || isRealEngineEvidence(value.realEngineEvidence));
}
