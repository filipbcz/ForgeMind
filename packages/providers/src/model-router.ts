import type { ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CapabilityAuditInput,
  ChatInput,
  CostEstimateInput,
  ImplementInput,
  PlanInput,
  ReleaseAuditInput,
  ReviewInput,
  RoadmapQualityReviewInput,
  RoadmapRepairInput,
  ValidationImpactInput
} from './provider.js';
import type { ProviderRuntimeConfig } from './index.js';

export type ModelProfile = 'fast' | 'balanced' | 'deep';
export type ModelWorkload = 'economy' | 'standard' | 'critical';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelRoute {
  workload: ModelWorkload;
  model: string;
  reasoningEffort: ReasoningEffort;
  rationale: string;
}

const DEFAULT_MODELS = {
  economy: 'gpt-6-luna',
  standard: 'gpt-6.1-sol',
  critical: 'gpt-6-astra'
} as const;

/** Resolve the effective model without embedding provider policy in orchestration. */
export function resolveModelRoute(input: {
  profile: ModelProfile;
  workload: ModelWorkload;
  configuredModel?: string;
  environment?: NodeJS.ProcessEnv;
}): ModelRoute {
  const environment = input.environment ?? process.env;
  const shifted = shiftWorkload(input.profile, input.workload);
  const configured = input.configuredModel?.trim();
  const model = shifted === 'economy'
    ? environment.FORGEMIND_MODEL_ECONOMY?.trim() || DEFAULT_MODELS.economy
    : shifted === 'critical'
      ? environment.FORGEMIND_MODEL_CRITICAL?.trim() || DEFAULT_MODELS.critical
      : environment.FORGEMIND_MODEL_STANDARD?.trim() || configured || DEFAULT_MODELS.standard;
  const reasoningEffort: ReasoningEffort = shifted === 'economy'
    ? 'low'
    : shifted === 'standard'
      ? 'medium'
      : input.profile === 'deep' ? 'xhigh' : 'high';
  return {
    workload: shifted,
    model,
    reasoningEffort,
    rationale: `${input.profile} policy maps ${input.workload} work to ${shifted}`
  };
}

function shiftWorkload(profile: ModelProfile, workload: ModelWorkload): ModelWorkload {
  if (profile === 'fast') {
    if (workload === 'critical') return 'standard';
    if (workload === 'standard') return 'economy';
  }
  if (profile === 'deep') {
    if (workload === 'economy') return 'standard';
    if (workload === 'standard') return 'critical';
  }
  return workload;
}

type ProviderFactory = (kind: ProviderKind, config?: ProviderRuntimeConfig) => AIProvider;

export class ModelRoutedProvider implements AIProvider {
  readonly kind: ProviderKind;
  private readonly providers = new Map<string, AIProvider>();

  constructor(
    kind: ProviderKind,
    private readonly config: ProviderRuntimeConfig & { modelProfile: ModelProfile },
    private readonly factory: ProviderFactory
  ) {
    this.kind = kind;
  }

  private provider(workload: ModelWorkload): { provider: AIProvider; route: ModelRoute } {
    const route = resolveModelRoute({
      profile: this.config.modelProfile,
      workload,
      configuredModel: this.config.model
    });
    const key = `${route.model}:${route.reasoningEffort}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = this.factory(this.kind, {
        ...this.config,
        modelProfile: undefined,
        model: route.model,
        reasoningEffort: route.reasoningEffort
      });
      this.providers.set(key, provider);
    }
    return { provider, route };
  }

  private async announce(input: unknown, operation: string, route: ModelRoute) {
    const handler = (input as { onActivity?: (activity: import('./provider.js').ProviderActivity) => void | Promise<void> }).onActivity;
    await handler?.({
      kind: 'lifecycle',
      message: `Model route: ${operation} -> ${route.model} (${route.reasoningEffort}; ${route.rationale}).`,
      elapsedMs: 0
    });
  }

  async preflight(signal?: AbortSignal) {
    const routes = (['economy', 'standard', 'critical'] as const).map((workload) => this.provider(workload));
    const unique = Array.from(new Map(routes.map((entry) => [entry.route.model, entry.provider])).values());
    for (const provider of unique) {
      const result = await provider.preflight(signal);
      if (!result.ok) return result;
    }
    return { provider: this.kind, ok: true as const, checkedAt: new Date().toISOString() };
  }

  async assessValidationImpact(input: ValidationImpactInput) {
    const { provider, route } = this.provider('economy');
    await this.announce(input, 'validation-impact', route);
    if (!provider.assessValidationImpact) throw new Error(`${this.kind} does not support validation impact assessment.`);
    return provider.assessValidationImpact(input);
  }

  async plan(input: PlanInput) {
    const { provider, route } = this.provider('standard');
    await this.announce(input, 'planning', route);
    return provider.plan(input);
  }

  async repairRoadmap(input: RoadmapRepairInput) {
    const { provider, route } = this.provider('standard');
    await this.announce(input, 'roadmap-repair', route);
    if (!provider.repairRoadmap) throw new Error(`${this.kind} does not support roadmap repair.`);
    return provider.repairRoadmap(input);
  }

  async reviewRoadmap(input: RoadmapQualityReviewInput) {
    const { provider, route } = this.provider('critical');
    await this.announce(input, 'roadmap-review', route);
    if (!provider.reviewRoadmap) throw new Error(`${this.kind} does not support roadmap review.`);
    return provider.reviewRoadmap(input);
  }

  async implement(input: ImplementInput) {
    const requested: ModelWorkload = (input.attemptNumber ?? 1) > 1 || Boolean(input.previousReviewBlockers?.length) ? 'critical' : 'standard';
    const { provider, route } = this.provider(requested);
    await this.announce(input, 'implementation', route);
    return provider.implement(input);
  }

  async chat(input: ChatInput) {
    const { provider, route } = this.provider('standard');
    await this.announce(input, 'repository-chat', route);
    if (!provider.chat) throw new Error(`${this.kind} does not support repository chat.`);
    return provider.chat(input);
  }

  async review(input: ReviewInput) {
    const { provider, route } = this.provider(input.previousReviewBlockers?.length ? 'critical' : 'standard');
    await this.announce(input, 'implementation-review', route);
    return provider.review(input);
  }

  async auditCapability(input: CapabilityAuditInput) {
    const { provider, route } = this.provider('critical');
    await this.announce(input, 'capability-audit', route);
    if (!provider.auditCapability) throw new Error(`${this.kind} does not support capability audits.`);
    return provider.auditCapability(input);
  }

  async auditRelease(input: ReleaseAuditInput) {
    const { provider, route } = this.provider('critical');
    await this.announce(input, 'release-audit', route);
    if (!provider.auditRelease) throw new Error(`${this.kind} does not support release audits.`);
    return provider.auditRelease(input);
  }

  estimateCost(input: CostEstimateInput) { return this.provider('standard').provider.estimateCost(input); }
  supportsLocalRepo() { return this.provider('standard').provider.supportsLocalRepo(); }
  supportsGitHubNativeFlow() { return this.provider('standard').provider.supportsGitHubNativeFlow(); }
  supportsNativeRepositoryReview() { return this.provider('critical').provider.supportsNativeRepositoryReview?.() ?? false; }
  supportsNativeRepositoryAudit() { return this.provider('critical').provider.supportsNativeRepositoryAudit?.() ?? false; }
}
