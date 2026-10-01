import type { ModelReasoningEffort, ProviderKind, TaskModelRoutingDecision, TaskModelSelection } from '@forgemind/core';
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
  TaskRoutingInput,
  ValidationImpactInput
} from './provider.js';
import type { ProviderRuntimeConfig } from './index.js';

export type ModelProfile = 'fast' | 'balanced' | 'deep';
export type ModelWorkload = 'economy' | 'standard' | 'critical';
export type ReasoningEffort = ModelReasoningEffort;

export interface ModelRoutingState {
  decision?: TaskModelRoutingDecision;
}

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

export const DEFAULT_MODEL_POOL = [DEFAULT_MODELS.economy, DEFAULT_MODELS.standard, DEFAULT_MODELS.critical] as const;

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

  private get routingState(): ModelRoutingState {
    return this.config.routingState ?? (this.config.routingState = {});
  }

  private availableModels(): string[] {
    const configured = this.config.allowedModels?.map((model) => model.trim()).filter(Boolean) ?? [];
    const environment = process.env.FORGEMIND_MODEL_POOL?.split(',').map((model) => model.trim()).filter(Boolean) ?? [];
    return Array.from(new Set(configured.length > 0 ? configured : environment.length > 0 ? environment : DEFAULT_MODEL_POOL));
  }

  private routerModel(): string {
    return this.config.model?.trim() || process.env.FORGEMIND_MODEL_ROUTER?.trim() || DEFAULT_MODELS.standard;
  }

  private providerForSelection(selection: TaskModelSelection): AIProvider {
    const key = `${selection.model}:${selection.reasoningEffort}`;
    let provider = this.providers.get(key);
    if (!provider) {
      provider = this.factory(this.kind, {
        ...this.config,
        modelProfile: undefined,
        allowedModels: undefined,
        routingState: undefined,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort
      });
      this.providers.set(key, provider);
    }
    return provider;
  }

  private provider(workload: ModelWorkload): { provider: AIProvider; route: ModelRoute } {
    const route = resolveModelRoute({
      profile: this.config.modelProfile,
      workload,
      configuredModel: this.config.model
    });
    return { provider: this.providerForSelection(route), route };
  }

  async routeTask(input: TaskRoutingInput): Promise<TaskModelRoutingDecision> {
    if (this.routingState.decision) return this.routingState.decision;
    const availableModels = this.availableModels();
    const routerModel = this.routerModel();
    const router = this.providerForSelection({ model: routerModel, reasoningEffort: 'low' });
    let decision: TaskModelRoutingDecision;
    if (router.routeTask) {
      try {
        decision = await router.routeTask({ ...input, availableModels, routerModel });
      } catch (error) {
        const kind = error && typeof error === 'object' && 'kind' in error
          ? (error as { kind?: unknown }).kind
          : undefined;
        if (typeof kind === 'string' && kind !== 'invalid_response') throw error;
        decision = fallbackTaskRoutingDecision(availableModels, routerModel, `Router fallback: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      decision = fallbackTaskRoutingDecision(availableModels, routerModel, `${this.kind} does not expose task routing; using the balanced fallback.`);
    }
    this.routingState.decision = decision;
    await input.onActivity?.({
      kind: 'lifecycle',
      message: `Task model route selected once: implementation ${decision.implementation.model} (${decision.implementation.reasoningEffort}), review ${decision.review.model} (${decision.review.reasoningEffort}), escalation ${decision.escalation.model} (${decision.escalation.reasoningEffort}). ${decision.rationale}`,
      elapsedMs: 0,
      routingDecision: decision
    });
    return decision;
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
    const models = Array.from(new Set([this.routerModel(), ...this.availableModels()]));
    const unique = models.map((model) => this.providerForSelection({ model, reasoningEffort: model === this.routerModel() ? 'low' : 'medium' }));
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
    const decision = await this.routeTask({
      taskId: input.taskId,
      title: input.plan.summary || input.taskId,
      prompt: input.prompt,
      acceptanceCriteria: input.plan.acceptanceCriteria,
      availableModels: this.availableModels(),
      routerModel: this.routerModel(),
      previousFailure: input.previousValidationError ?? input.previousReviewBlockers?.join(' | '),
      onActivity: input.onActivity,
      signal: input.signal
    });
    const escalated = (input.attemptNumber ?? 1) > 1 || Boolean(input.previousReviewBlockers?.length) || Boolean(input.previousValidationError);
    const selection = escalated ? decision.escalation : decision.implementation;
    const provider = this.providerForSelection(selection);
    const route: ModelRoute = { workload: escalated ? 'critical' : 'standard', ...selection,
      rationale: escalated ? `persisted task route escalation: ${decision.rationale}` : `persisted task route: ${decision.rationale}` };
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
    const decision = await this.routeTask({
      taskId: input.taskId,
      title: input.taskTitle,
      prompt: input.taskPrompt,
      acceptanceCriteria: input.acceptanceCriteria,
      availableModels: this.availableModels(),
      routerModel: this.routerModel(),
      previousFailure: input.previousReviewBlockers?.join(' | '),
      onActivity: input.onActivity,
      signal: input.signal
    });
    const escalated = Boolean(input.previousReviewBlockers?.length);
    const selection = escalated ? decision.escalation : decision.review;
    const provider = this.providerForSelection(selection);
    const route: ModelRoute = { workload: escalated ? 'critical' : 'standard', ...selection,
      rationale: escalated ? `persisted task route escalation: ${decision.rationale}` : `persisted task route: ${decision.rationale}` };
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

function fallbackTaskRoutingDecision(availableModels: string[], routerModel: string, rationale: string): TaskModelRoutingDecision {
  const ranked = [...availableModels];
  const standard = ranked.find((model) => /sol/i.test(model)) ?? ranked[Math.min(1, ranked.length - 1)] ?? routerModel;
  const critical = ranked.at(-1) ?? standard;
  return {
    version: 1,
    routerModel,
    implementation: { model: standard, reasoningEffort: 'medium' },
    review: { model: standard, reasoningEffort: 'medium' },
    escalation: { model: critical, reasoningEffort: /astra/i.test(critical) ? 'high' : 'medium' },
    rationale,
    confidence: 0,
    decidedAt: new Date().toISOString()
  };
}
