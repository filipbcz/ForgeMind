import type { AcceptanceEvidenceSource, AcceptanceEvidenceStatus, ApprovalType, ProjectArchitectureUpdate, ProjectContract, ProjectContractDelta, ProjectContractRequirement, ProviderKind, ValidationCheckCategory } from '@forgemind/core';

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
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
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
  providerPrompt?: string;
  providerResponse?: string;
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
}

export function normalizeValidationChecks(value: unknown): ValidationCheck[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): ValidationCheck[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const check = item as Record<string, unknown>;
    const criterion = typeof check.criterion === 'string' ? check.criterion.trim() || undefined : undefined;
    const rationale = typeof check.rationale === 'string' ? check.rationale.trim() || undefined : undefined;
    const category = isValidationCheckCategory(check.category) ? check.category : undefined;

    if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
      return [{ kind: 'command', command: check.command.trim(), category, criterion, rationale }];
    }
    return [];
  });
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
}

export interface FileUpdate {
  path: string;
  content: string;
}

export interface ImplementResult {
  summary: string;
  changedFiles: string[];
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
  };
  diff: string;
  architectureContext?: string;
  architectureUpdate?: ProjectArchitectureUpdate;
  onActivity?: ProviderActivityHandler;
  session?: ProviderSessionContext;
}

export interface ReviewResult {
  summary: string;
  blockers: string[];
  safeImprovements: string[];
  riskyChanges: ApprovalType[];
  providerPrompt?: string;
  providerResponse?: string;
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
  plan(input: PlanInput): Promise<PlanResult>;
  repairRoadmap?(input: RoadmapRepairInput): Promise<RoadmapRepairResult>;
  implement(input: ImplementInput): Promise<ImplementResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
  auditCapability?(input: CapabilityAuditInput): Promise<CapabilityAuditResult>;
  auditRelease?(input: ReleaseAuditInput): Promise<ReleaseAuditResult>;
  estimateCost(input: CostEstimateInput): Promise<CostEstimateResult>;
  supportsLocalRepo(): boolean;
  supportsGitHubNativeFlow(): boolean;
}
