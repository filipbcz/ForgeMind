import type { AcceptanceEvidenceSource, AcceptanceEvidenceStatus, ApprovalType, ProjectContract, ProjectContractRequirement, ProviderKind } from '@forgemind/core';

export interface ProviderActivity {
  kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace';
  message: string;
  elapsedMs: number;
  usage?: ProviderUsageMeasurement;
}

export type ProviderActivityHandler = (activity: ProviderActivity) => void | Promise<void>;

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
  previousValidationError?: string;
  previousValidationChecks?: ValidationCheck[];
  onActivity?: ProviderActivityHandler;
}

export interface PlanResult {
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
  implementationSteps?: ImplementationStepPlan[];
  projectContract?: ProjectContract;
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
}

export interface ValidationCheck {
  kind: 'command';
  command: string;
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

    if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
      return [{ kind: 'command', command: check.command.trim(), criterion, rationale }];
    }
    return [];
  });
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
  onActivity?: ProviderActivityHandler;
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

export interface ReleaseAuditInput {
  projectId: string;
  contract: ProjectContract;
  satisfiedCapabilities: Array<{
    requirementId: string;
    title: string;
    satisfiedCriteria: number;
    totalCriteria: number;
  }>;
  repositoryPath: string;
  repositoryContext?: string;
  commitSha: string;
  onActivity?: ProviderActivityHandler;
}

export type ReleaseAuditResult = CapabilityAuditResult;

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
  implement(input: ImplementInput): Promise<ImplementResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
  auditCapability?(input: CapabilityAuditInput): Promise<CapabilityAuditResult>;
  auditRelease?(input: ReleaseAuditInput): Promise<ReleaseAuditResult>;
  estimateCost(input: CostEstimateInput): Promise<CostEstimateResult>;
  supportsLocalRepo(): boolean;
  supportsGitHubNativeFlow(): boolean;
}
