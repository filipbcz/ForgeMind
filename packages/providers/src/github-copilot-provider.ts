import type { ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CapabilityAuditInput,
  CapabilityAuditResult,
  CostEstimateInput,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  PlanInput,
  PlanResult,
  ReleaseAuditInput,
  ReleaseAuditResult,
  ReviewInput,
  ReviewResult
} from './provider.js';
import type { ProviderRuntimeConfig } from './index.js';
import type { ProviderModelOption } from './openai-provider.js';

export const GITHUB_COPILOT_FROZEN_MESSAGE =
  'GitHub Copilot provider is frozen and cannot execute tasks. Configure a Codex or OpenAI provider.';

/**
 * Retains compatibility with stored provider connections without shipping the
 * large Copilot runtime or allowing new work to depend on the frozen provider.
 */
export class GitHubCopilotProvider implements AIProvider {
  readonly kind: ProviderKind = 'github_copilot';

  constructor(_config?: ProviderRuntimeConfig) {}

  async plan(_input: PlanInput): Promise<PlanResult> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }

  async implement(_input: ImplementInput): Promise<ImplementResult> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }

  async review(_input: ReviewInput): Promise<ReviewResult> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }

  async auditCapability(_input: CapabilityAuditInput): Promise<CapabilityAuditResult> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }

  async auditRelease(_input: ReleaseAuditInput): Promise<ReleaseAuditResult> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }

  async estimateCost(_input: CostEstimateInput): Promise<CostEstimateResult> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }

  supportsLocalRepo(): boolean {
    return false;
  }

  supportsGitHubNativeFlow(): boolean {
    return false;
  }

  async listModels(): Promise<ProviderModelOption[]> {
    throw new Error(GITHUB_COPILOT_FROZEN_MESSAGE);
  }
}
