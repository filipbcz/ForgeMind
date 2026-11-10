import type { ProviderKind } from '@forgemind/core';
import {
  normalizeProviderError,
  type AIProvider
} from '@forgemind/providers';

export interface StudioProviderCandidate {
  id: string;
  label: string;
  kind: ProviderKind;
  capabilities: AIProvider;
  create: () => Promise<AIProvider>;
}

export interface StudioProviderPoolAuditEvent {
  eventType: 'provider_request_failed' | 'provider_request_succeeded' | 'provider_fallback_used';
  payload: Record<string, unknown>;
}

interface StudioProviderPoolInput {
  candidates: StudioProviderCandidate[];
  onConnectionSwitch?: (candidate: StudioProviderCandidate) => void | Promise<void>;
  audit?: (event: StudioProviderPoolAuditEvent) => void | Promise<void>;
}

export function createStudioProviderPool(input: StudioProviderPoolInput): AIProvider {
  const candidates = input.candidates.filter((candidate, index, all) =>
    all.findIndex((item) => item.id === candidate.id) === index);
  const primary = candidates[0];
  if (!primary) throw new Error('No AI provider connection is available.');
  if (candidates.some((candidate) => candidate.kind !== primary.kind)) {
    throw new Error('Studio provider failover requires semantically equivalent provider connections.');
  }

  let activeId = primary.id;
  const unavailable = new Set<string>();
  const audit = async (event: StudioProviderPoolAuditEvent) => {
    try {
      await input.audit?.(event);
    } catch {
      // Provider availability must not depend on observability storage.
    }
  };
  const call = async <T>(
    operation: string,
    action: (provider: AIProvider) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    let lastError: unknown = new Error('No AI provider connection is available.');
    const ordered = [...candidates].sort((left, right) =>
      left.id === activeId ? -1 : right.id === activeId ? 1 : 0);

    for (const candidate of ordered) {
      if (unavailable.has(candidate.id)) continue;
      signal?.throwIfAborted();
      const switching = candidate.id !== activeId;
      if (switching) {
        await input.onConnectionSwitch?.(candidate);
      }

      try {
        const provider = await candidate.create();
        const result = await action(provider);
        if (switching) {
          await audit({
            eventType: 'provider_fallback_used',
            payload: {
              operation,
              previousConnectionId: activeId,
              fallbackConnectionId: candidate.id,
              fallbackProvider: candidate.kind,
              policy: 'ordered_connection_pool_failover'
            }
          });
        }
        activeId = candidate.id;
        await audit({
          eventType: 'provider_request_succeeded',
          payload: { operation, provider: candidate.kind, connectionId: candidate.id }
        });
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        const normalized = normalizeProviderError(candidate.kind, error);
        lastError = error;
        await audit({
          eventType: 'provider_request_failed',
          payload: {
            operation,
            provider: candidate.kind,
            connectionId: candidate.id,
            error: normalized.auditSafeMessage,
            kind: normalized.kind,
            retryable: normalized.retryable,
            failoverEligible: normalized.failoverEligible,
            statusCode: normalized.statusCode ?? null,
            errorCode: normalized.errorCode ?? null
          }
        });
        if (!normalized.failoverEligible) throw error;
        if (!normalized.retryable) unavailable.add(candidate.id);
      }
    }

    throw lastError;
  };
  const unsupported = (provider: AIProvider, operation: string): never => {
    throw new Error(`AI provider "${provider.kind}" does not support ${operation}.`);
  };

  return {
    kind: primary.kind,
    preflight: (signal) => call('preflight', (provider) => provider.preflight(signal), signal),
    routeTask: (routeInput) => call('route_task', (provider) =>
      provider.routeTask ? provider.routeTask(routeInput) : unsupported(provider, 'task model routing'), routeInput.signal),
    plan: (planInput) => call('plan', (provider) => provider.plan(planInput), planInput.signal),
    repairRoadmap: (repairInput) => call('repair_roadmap', (provider) =>
      provider.repairRoadmap ? provider.repairRoadmap(repairInput) : unsupported(provider, 'roadmap repair'), repairInput.signal),
    reviewRoadmap: (reviewInput) => call('review_roadmap', (provider) =>
      provider.reviewRoadmap ? provider.reviewRoadmap(reviewInput) : unsupported(provider, 'roadmap review'), reviewInput.signal),
    implement: (implementInput) => call('implement', (provider) => provider.implement(implementInput), implementInput.signal),
    chat: (chatInput) => call('chat', (provider) =>
      provider.chat ? provider.chat(chatInput) : unsupported(provider, 'chat'), chatInput.signal),
    review: (reviewInput) => call('review', (provider) => provider.review(reviewInput), reviewInput.signal),
    assessValidationImpact: (impactInput) => call('assess_validation_impact', (provider) =>
      provider.assessValidationImpact
        ? provider.assessValidationImpact(impactInput)
        : unsupported(provider, 'validation impact assessment'), impactInput.signal),
    auditCapability: (auditInput) => call('audit_capability', (provider) =>
      provider.auditCapability ? provider.auditCapability(auditInput) : unsupported(provider, 'capability audit')),
    auditRelease: (auditInput) => call('audit_release', (provider) =>
      provider.auditRelease ? provider.auditRelease(auditInput) : unsupported(provider, 'release audit')),
    estimateCost: (costInput) => call('estimate_cost', (provider) => provider.estimateCost(costInput)),
    // Capabilities are conservative because an operation can switch accounts
    // after its input packet has already been prepared.
    supportsLocalRepo: () => candidates.every((candidate) => candidate.capabilities.supportsLocalRepo()),
    supportsGitHubNativeFlow: () => candidates.every((candidate) => candidate.capabilities.supportsGitHubNativeFlow()),
    supportsNativeRepositoryReview: () => candidates.every((candidate) =>
      candidate.capabilities.supportsNativeRepositoryReview?.() === true),
    supportsNativeRepositoryAudit: () => candidates.every((candidate) =>
      candidate.capabilities.supportsNativeRepositoryAudit?.() === true)
  };
}
