import type { ApprovalType, ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CostEstimateInput,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  PlanInput,
  PlanResult,
  ReviewInput,
  ReviewResult
} from './provider.js';

export class MockProvider implements AIProvider {
  readonly kind: ProviderKind = 'mock';

  async plan(input: PlanInput): Promise<PlanResult> {
    return {
      summary: `Mock plan for "${input.title}"`,
      steps: [
        'Load project configuration and limits.',
        'Create an isolated workspace and branch.',
        'Apply a minimal simulated change.',
        'Run configured validation command.',
        'Create a draft pull request summary.'
      ],
      acceptanceCriteria: ['Task keeps within limits.', 'Validation result is captured.', 'Audit log receives every phase.']
    };
  }

  async implement(input: ImplementInput): Promise<ImplementResult> {
    const requestedApprovals: ApprovalType[] = [];
    if (/dependency|package|npm install/i.test(input.prompt)) {
      requestedApprovals.push('new_dependency');
    }

    return {
      summary: `MockProvider simulated implementation in ${input.repositoryPath}`,
      changedFiles: ['MOCK_IMPLEMENTATION.md'],
      diffStat: {
        filesChanged: 1,
        insertions: input.plan.steps.length + 4,
        deletions: 0
      },
      requestedApprovals
    };
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    return {
      summary: `Mock review checked ${input.changedFiles.length} changed file(s).`,
      blockers: [],
      safeImprovements: ['Add concrete tests when the real provider modifies source files.'],
      riskyChanges: []
    };
  }

  async estimateCost(input: CostEstimateInput): Promise<CostEstimateResult> {
    const words = input.prompt.trim().split(/\s+/).filter(Boolean).length;
    const sizeMultiplier = input.repositorySizeHint === 'large' ? 4 : input.repositorySizeHint === 'medium' ? 2 : 1;
    const inputTokens = Math.max(128, words * 2 * sizeMultiplier);
    const outputTokens = 512 * sizeMultiplier;

    return {
      inputTokens,
      outputTokens,
      estimatedCostUsd: 0
    };
  }

  supportsLocalRepo(): boolean {
    return true;
  }

  supportsGitHubNativeFlow(): boolean {
    return false;
  }
}

export function createProvider(kind: ProviderKind): AIProvider {
  if (kind === 'mock') {
    return new MockProvider();
  }

  throw new Error(`Provider "${kind}" is not implemented yet`);
}

