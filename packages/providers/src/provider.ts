import { redactError } from '@forgemind/core';
import type { AcceptanceEvidenceSource, AcceptanceEvidenceStatus, ApprovalType, NormalizedProviderErrorDetails, NormalizedProviderErrorKind, ProjectArchitectureUpdate, ProjectContract, ProjectContractDelta, ProjectContractRequirement, ProviderKind, ProviderPreflightResult, TaskMode, ValidationCheckCategory } from '@forgemind/core';

export type { NormalizedProviderErrorDetails, NormalizedProviderErrorKind, ProviderPreflightResult } from '@forgemind/core';

export interface ProviderActivity {
  kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace';
  message: string;
  elapsedMs: number;
  usage?: ProviderUsageMeasurement;
}

export type ProviderActivityHandler = (activity: ProviderActivity) => void | Promise<void>;

export interface ProviderSessionUpdate {
  id: string;
  provider: ProviderKind;
  model: string;
}

export interface ProviderSessionContext {
  id?: string;
  provider?: ProviderKind;
  model?: string;
  onUpdate?: (session: ProviderSessionUpdate) => void | Promise<void>;
}

export interface ProviderUsageMeasurement {
  provider: ProviderKind;
  model: string;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  source: 'actual_total' | 'actual_breakdown';
  actualCostUsd?: number;
}

export interface PlanInput {
  taskId: string;
  title: string;
  prompt: string;
  repositoryPath?: string;
  maxRuntimeMs?: number;
  previousValidationError?: string;
  previousValidationChecks?: ValidationCheck[];
  validationFailure?: ValidationFailureDetails;
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
  signal?: AbortSignal;
}

export interface PlanResult {
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
  implementationSteps?: ImplementationStepPlan[];
  projectContract?: ProjectContract;
  contractDelta?: ProjectContractDelta;
  architectureUpdate?: ProjectArchitectureUpdate;
  validationChecks?: ValidationCheck[];
  validationRecovery?: ValidationRecoveryDecision;
  providerPrompt?: string;
  providerResponse?: string;
}

export interface ValidationFailureDetails {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ValidationRecoveryDecision {
  action: 'replace_validation_check' | 'repair_implementation' | 'blocked';
  rationale: string;
}

export interface ImplementationStepPlan {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  inScope: string[];
  outOfScope: string[];
  requirementIds: string[];
  deliverables: string[];
  changeRationale: string;
  dependsOnStepTitles: string[];
  validationFocus: Array<'implementation' | 'migration' | 'compatibility' | 'regression'>;
}

export interface RoadmapRepairInput {
  taskId: string;
  objective: string;
  validationError: string;
  implementationSteps: ImplementationStepPlan[];
  allowedRequirementIds: string[];
  completedStepTitles: string[];
  migrationImpacts: string[];
  compatibilityImpacts: string[];
  repositoryPath?: string;
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
}

export interface RoadmapRepairResult {
  implementationSteps: ImplementationStepPlan[];
  providerPrompt?: string;
  providerResponse?: string;
}

export interface ValidationCheck {
  kind: 'command';
  command: string;
  category?: ValidationCheckCategory;
  timeoutMinutes?: number;
  criterion?: string;
  rationale?: string;
  requiredCapabilities?: string[];
}

export function normalizeValidationChecks(value: unknown): ValidationCheck[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): ValidationCheck[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const check = item as Record<string, unknown>;
    const criterion = typeof check.criterion === 'string' ? check.criterion.trim() || undefined : undefined;
    const rationale = typeof check.rationale === 'string' ? check.rationale.trim() || undefined : undefined;
    const category = isValidationCheckCategory(check.category) ? check.category : undefined;
    const requiredCapabilities = normalizeCapabilities(check.requiredCapabilities);

    if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
      return [{ kind: 'command', command: check.command.trim(), category, criterion, rationale, requiredCapabilities }];
    }
    return [];
  });
}

function normalizeCapabilities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)));
  return normalized.length > 0 ? normalized : undefined;
}

function isValidationCheckCategory(value: unknown): value is ValidationCheckCategory {
  return value === 'setup' || value === 'build' || value === 'database' || value === 'api' || value === 'browser' || value === 'smoke';
}

export interface ImplementInput {
  taskId: string;
  prompt: string;
  plan: PlanResult;
  repositoryPath: string;
  attemptNumber?: number;
  previousValidationError?: string;
  previousReviewBlockers?: string[];
  previousSafeImprovements?: string[];
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
  signal?: AbortSignal;
}

export interface FileUpdate {
  path: string;
  content: string;
}

export interface ChatInput {
  runId: string;
  message: string;
  conversationContext: string;
  repositoryPath?: string;
  repositoryAttached: boolean;
  mode: TaskMode;
  approvedOperations?: ApprovalType[];
  forgeMindContext?: string;
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
  signal?: AbortSignal;
}

export interface ForgeMindApiAction {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  bodyJson: string;
  rationale: string;
}

export interface ChatResult {
  response: string;
  changedFiles: string[];
  requestedApprovals: ApprovalType[];
  validationChecks: ValidationCheck[];
  fileUpdates?: FileUpdate[];
  forgeMindActions?: ForgeMindApiAction[];
  providerPrompt?: string;
  providerResponse?: string;
}

export interface ImplementResult {
  outcome?: 'changes_made' | 'already_satisfied';
  summary: string;
  changedFiles: string[];
  evidenceFiles?: string[];
  diffStat: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  requestedApprovals: ApprovalType[];
  validationChecks?: ValidationCheck[];
  architectureUpdate?: ProjectArchitectureUpdate;
  fileUpdates?: FileUpdate[];
  providerPrompt?: string;
  providerResponse?: string;
}

export interface ReviewInput {
  taskId: string;
  taskTitle: string;
  taskPrompt: string;
  repositoryPath: string;
  changedFiles: string[];
  acceptanceCriteria: string[];
  previousReviewSummary?: string;
  previousReviewBlockers?: string[];
  validation: {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
    deferredChecks?: Array<{
      command: string;
      criterion?: string;
      rationale?: string;
      requiredCapabilities: string[];
      missingCapabilities: string[];
    }>;
  };
  diff: string;
  reviewMode?: 'changes' | 'existing_state';
  repositoryEvidence?: string;
  architectureContext?: string;
  architectureUpdate?: ProjectArchitectureUpdate;
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
  signal?: AbortSignal;
}

export interface ReviewResult {
  summary: string;
  blockers: string[];
  safeImprovements: string[];
  riskyChanges: ApprovalType[];
  validationChecks?: ValidationCheck[];
  criterionResults?: Array<{
    criterion: string;
    status: 'satisfied' | 'not_satisfied' | 'insufficient_evidence' | 'deferred';
    evidence: string[];
  }>;
  providerPrompt?: string;
  providerResponse?: string;
}

export class ProviderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderContractError';
  }
}

export class NormalizedProviderError extends Error implements NormalizedProviderErrorDetails {
  readonly provider: ProviderKind;
  readonly kind: NormalizedProviderErrorKind;
  readonly auditSafeMessage: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(details: NormalizedProviderErrorDetails, options?: { cause?: unknown }) {
    super(details.message, options);
    this.name = 'NormalizedProviderError';
    this.provider = details.provider;
    this.kind = details.kind;
    this.auditSafeMessage = details.auditSafeMessage;
    this.retryable = details.retryable;
    this.statusCode = details.statusCode;
  }

  toJSON(): NormalizedProviderErrorDetails {
    return this.toDetails();
  }

  toDetails(): NormalizedProviderErrorDetails {
    return {
      provider: this.provider,
      kind: this.kind,
      message: this.message,
      auditSafeMessage: this.auditSafeMessage,
      retryable: this.retryable,
      ...(this.statusCode === undefined ? {} : { statusCode: this.statusCode })
    };
  }
}

export function normalizeProviderError(
  provider: ProviderKind,
  error: unknown,
  fallbackMessage = 'Provider request failed.'
): NormalizedProviderError {
  if (error instanceof NormalizedProviderError) return error;

  const statusCode = readStatusCode(error);
  const rawMessage = readErrorMessage(error) ?? fallbackMessage;
  const kind = classifyProviderError(error, rawMessage, statusCode);
  const auditSafeMessage = redactError(rawMessage);
  return new NormalizedProviderError({
    provider,
    kind,
    message: auditSafeMessage || fallbackMessage,
    auditSafeMessage: auditSafeMessage || fallbackMessage,
    retryable: kind === 'timeout' || kind === 'unavailable',
    statusCode
  }, { cause: error });
}

export async function normalizeProviderPreflight(
  provider: ProviderKind,
  check: () => Promise<void>
): Promise<ProviderPreflightResult> {
  const checkedAt = new Date().toISOString();
  try {
    await check();
    return { provider, ok: true, checkedAt };
  } catch (error) {
    const normalized = normalizeProviderError(provider, error, `${provider} provider preflight failed.`);
    return {
      provider,
      ok: false,
      checkedAt,
      error: normalized.toDetails()
    };
  }
}

function classifyProviderError(
  error: unknown,
  message: string,
  statusCode?: number
): NormalizedProviderErrorKind {
  if (error instanceof ProviderContractError) return 'invalid_response';
  if (statusCode === 401 || statusCode === 403) return 'authentication';
  if (statusCode === 429) return 'quota';
  if (statusCode === 408 || statusCode === 504) return 'timeout';
  if (statusCode && statusCode >= 500) return 'unavailable';

  const normalized = message.toLowerCase();
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  if (/\b(?:timeout|timed out|aborted)\b/.test(normalized)) return 'timeout';
  if (/\b(?:unauthorized|forbidden|invalid[\s_-]?api[\s_-]?key|api[\s_-]?key|required|not active|login|auth(?:entication)?)\b/.test(normalized)) {
    return 'authentication';
  }
  if (/\b(?:quota|rate[\s_-]?limit|insufficient[\s_-]?quota|billing)\b/.test(normalized)) return 'quota';
  if (/\b(?:invalid json|invalid response|malformed|must return|empty response)\b/.test(normalized)) {
    return 'invalid_response';
  }
  return 'unknown';
}

function readStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { status?: unknown; statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  const message = String(error || '').trim();
  return message || undefined;
}

export function parseProviderJsonObject(content: string, operation: string): Record<string, unknown> {
  const jsonStart = content.indexOf('{');
  const jsonEnd = content.lastIndexOf('}');
  const candidate = jsonStart >= 0 && jsonEnd > jsonStart
    ? content.slice(jsonStart, jsonEnd + 1)
    : content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new ProviderContractError(`${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderContractError(`${operation} must return a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function parsePlanResult(content: string, operation: string): PlanResult {
  const value = parseProviderJsonObject(content, operation);
  requireString(value, 'summary', operation);
  requireStringArray(value, 'steps', operation);
  requireStringArray(value, 'acceptanceCriteria', operation);
  return value as unknown as PlanResult;
}

export function parseImplementResult(content: string, operation: string, requireFileUpdates = false): ImplementResult {
  const value = parseProviderJsonObject(content, operation);
  requireString(value, 'summary', operation);
  requireStringArray(value, 'changedFiles', operation);
  if (value.evidenceFiles !== undefined) requireStringArray(value, 'evidenceFiles', operation);
  requireStringArray(value, 'requestedApprovals', operation);
  const outcome = value.outcome;
  if (outcome !== 'changes_made' && outcome !== 'already_satisfied') {
    throw new ProviderContractError(`${operation} field "outcome" must be "changes_made" or "already_satisfied".`);
  }
  const diffStat = value.diffStat;
  if (!diffStat || typeof diffStat !== 'object' || Array.isArray(diffStat)) {
    throw new ProviderContractError(`${operation} field "diffStat" must be an object.`);
  }
  for (const field of ['filesChanged', 'insertions', 'deletions']) {
    if (typeof (diffStat as Record<string, unknown>)[field] !== 'number') {
      throw new ProviderContractError(`${operation} field "diffStat.${field}" must be a number.`);
    }
  }
  if (requireFileUpdates && outcome === 'changes_made') {
    const updates = value.fileUpdates;
    if (!Array.isArray(updates) || updates.length === 0 || updates.some((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
      const update = item as Record<string, unknown>;
      return typeof update.path !== 'string' || !update.path.trim() || typeof update.content !== 'string';
    })) {
      throw new ProviderContractError(`${operation} must return non-empty fileUpdates for outcome "changes_made".`);
    }
  }
  if (outcome === 'already_satisfied' && (!Array.isArray(value.evidenceFiles) || value.evidenceFiles.length === 0)) {
    throw new ProviderContractError(`${operation} must return non-empty evidenceFiles for outcome "already_satisfied".`);
  }
  return value as unknown as ImplementResult;
}

export function parseChatResult(content: string, operation: string): ChatResult {
  const value = parseProviderJsonObject(content, operation);
  requireString(value, 'response', operation);
  requireStringArray(value, 'changedFiles', operation);
  requireStringArray(value, 'requestedApprovals', operation);
  if (value.validationChecks !== undefined && !Array.isArray(value.validationChecks)) {
    throw new ProviderContractError(`${operation} field "validationChecks" must be an array.`);
  }
  if (value.fileUpdates !== undefined && (!Array.isArray(value.fileUpdates) || value.fileUpdates.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const update = item as Record<string, unknown>;
    return typeof update.path !== 'string' || !update.path.trim() || typeof update.content !== 'string';
  }))) {
    throw new ProviderContractError(`${operation} field "fileUpdates" must contain path/content objects.`);
  }
  if (value.forgeMindActions !== undefined && (!Array.isArray(value.forgeMindActions) || value.forgeMindActions.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const action = item as Record<string, unknown>;
    return !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(action.method))
      || typeof action.path !== 'string'
      || !action.path.trim()
      || typeof action.bodyJson !== 'string'
      || typeof action.rationale !== 'string'
      || !action.rationale.trim();
  }))) {
    throw new ProviderContractError(`${operation} field "forgeMindActions" must contain method/path/rationale objects.`);
  }
  return {
    ...(value as unknown as ChatResult),
    validationChecks: normalizeValidationChecks(value.validationChecks),
    forgeMindActions: (value.forgeMindActions as ForgeMindApiAction[] | undefined) ?? []
  };
}

export function parseReviewResult(content: string, operation: string): ReviewResult {
  const value = parseProviderJsonObject(content, operation);
  requireString(value, 'summary', operation);
  requireStringArray(value, 'blockers', operation);
  requireStringArray(value, 'safeImprovements', operation);
  requireStringArray(value, 'riskyChanges', operation);
  if (value.validationChecks !== undefined && !Array.isArray(value.validationChecks)) {
    throw new ProviderContractError(`${operation} field "validationChecks" must be an array.`);
  }
  if (value.criterionResults !== undefined) {
    if (!Array.isArray(value.criterionResults) || value.criterionResults.some((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
      const result = item as Record<string, unknown>;
      return typeof result.criterion !== 'string'
        || !['satisfied', 'not_satisfied', 'insufficient_evidence', 'deferred'].includes(String(result.status))
        || !Array.isArray(result.evidence)
        || result.evidence.some((entry) => typeof entry !== 'string');
    })) {
      throw new ProviderContractError(`${operation} field "criterionResults" must contain structured criterion verdicts.`);
    }
  }
  return {
    ...value,
    validationChecks: normalizeValidationChecks(value.validationChecks)
  } as unknown as ReviewResult;
}

function requireString(value: Record<string, unknown>, field: string, operation: string): void {
  if (typeof value[field] !== 'string' || !(value[field] as string).trim()) {
    throw new ProviderContractError(`${operation} field "${field}" must be a non-empty string.`);
  }
}

function requireStringArray(value: Record<string, unknown>, field: string, operation: string): void {
  if (!Array.isArray(value[field]) || (value[field] as unknown[]).some((item) => typeof item !== 'string')) {
    throw new ProviderContractError(`${operation} field "${field}" must be an array of strings.`);
  }
}

export interface CapabilityAuditInput {
  projectId: string;
  contractVersion: number;
  contractSummary: string;
  invariants: string[];
  prohibitedSubstitutes: string[];
  requirement: ProjectContractRequirement;
  completedWorkItems: Array<{
    id: string;
    title: string;
    deliverables: string[];
    acceptanceCriteria: string[];
  }>;
  evidence: Array<{
    criterion: string;
    source: AcceptanceEvidenceSource;
    status: AcceptanceEvidenceStatus;
    command?: string;
    commitSha?: string;
    summary?: string;
  }>;
  repositoryPath: string;
  repositoryContext?: string;
  commitSha?: string;
  onActivity?: ProviderActivityHandler;
}

export interface CapabilityAuditCriterionResult {
  criterion: string;
  status: 'passed' | 'failed' | 'blocked';
  evidence: string[];
  gaps: string[];
}

export interface CapabilityAuditResult {
  verdict: 'satisfied' | 'partial' | 'blocked';
  summary: string;
  criteria: CapabilityAuditCriterionResult[];
  gapWorkItems: ImplementationStepPlan[];
  providerPrompt?: string;
  providerResponse?: string;
}

export interface BriefCoverageResult {
  obligation: string;
  status: 'passed' | 'failed' | 'blocked';
  workflowOnly: boolean;
  requirementIds: string[];
  evidence: string[];
  gaps: string[];
}

export interface ReleaseAuditInput {
  projectId: string;
  contract: ProjectContract;
  originalBrief: string;
  satisfiedCapabilities: Array<{
    requirementId: string;
    title: string;
    satisfiedCriteria: number;
    totalCriteria: number;
  }>;
  implementationSteps?: Array<{
    sequenceNumber: number;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requirementIds: string[];
    deliverables: string[];
    status: string;
    origin: 'initial_roadmap' | 'audit_repair';
    taskId?: string;
  }>;
  executionEvidence?: Array<{
    criterion: string;
    source: AcceptanceEvidenceSource;
    status: AcceptanceEvidenceStatus;
    command?: string;
    commitSha?: string;
    summary?: string;
  }>;
  repositoryPath: string;
  repositoryContext?: string;
  commitSha: string;
  onActivity?: ProviderActivityHandler;
}

export interface ReleaseAuditResult extends CapabilityAuditResult {
  briefCoverage: BriefCoverageResult[];
  contractAmendments: ProjectContractRequirement[];
}

export interface CostEstimateInput {
  prompt: string;
  repositorySizeHint?: 'small' | 'medium' | 'large';
}

export interface CostEstimateResult {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AIProvider {
  kind: ProviderKind;
  preflight(signal?: AbortSignal): Promise<ProviderPreflightResult>;
  plan(input: PlanInput): Promise<PlanResult>;
  repairRoadmap?(input: RoadmapRepairInput): Promise<RoadmapRepairResult>;
  implement(input: ImplementInput): Promise<ImplementResult>;
  chat?(input: ChatInput): Promise<ChatResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
  auditCapability?(input: CapabilityAuditInput): Promise<CapabilityAuditResult>;
  auditRelease?(input: ReleaseAuditInput): Promise<ReleaseAuditResult>;
  estimateCost(input: CostEstimateInput): Promise<CostEstimateResult>;
  supportsLocalRepo(): boolean;
  supportsGitHubNativeFlow(): boolean;
}
