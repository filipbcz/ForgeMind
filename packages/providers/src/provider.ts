import type { ApprovalType, ProviderKind } from '@forgemind/core';

export interface PlanInput {
  taskId: string;
  title: string;
  prompt: string;
  repositoryPath?: string;
}

export interface PlanResult {
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
}

export interface ImplementInput {
  taskId: string;
  prompt: string;
  plan: PlanResult;
  repositoryPath: string;
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
}

export interface ReviewInput {
  taskId: string;
  repositoryPath: string;
  changedFiles: string[];
}

export interface ReviewResult {
  summary: string;
  blockers: string[];
  safeImprovements: string[];
  riskyChanges: ApprovalType[];
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
  implement(input: ImplementInput): Promise<ImplementResult>;
  review(input: ReviewInput): Promise<ReviewResult>;
  estimateCost(input: CostEstimateInput): Promise<CostEstimateResult>;
  supportsLocalRepo(): boolean;
  supportsGitHubNativeFlow(): boolean;
}

