import { describe, expect, it, vi } from 'vitest';
import type { AIProvider } from './provider.js';
import { parseTaskModelRoutingDecision } from './provider.js';
import { hasSubstantiveImplementationFeedback, ModelRoutedProvider, resolveModelRoute, type ModelRoutingState } from './model-router.js';

describe('model routing', () => {
  it('does not escalate merely because orchestration resumed at a later attempt', () => {
    expect(hasSubstantiveImplementationFeedback({})).toBe(false);
    expect(hasSubstantiveImplementationFeedback({ previousValidationError: 'Acceptance validation failed.' })).toBe(true);
    expect(hasSubstantiveImplementationFeedback({ previousReviewBlockers: ['Missing evidence.'] })).toBe(true);
  });
  it('uses Luna, Sol and Astra for balanced economy, standard and critical work', () => {
    expect(resolveModelRoute({ profile: 'balanced', workload: 'economy', environment: {} }).model).toBe('gpt-6-luna');
    expect(resolveModelRoute({ profile: 'balanced', workload: 'standard', environment: {} }).model).toBe('gpt-6.1-sol');
    expect(resolveModelRoute({ profile: 'balanced', workload: 'critical', environment: {} }))
      .toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'high' });
  });

  it('shifts work down in fast mode and up in deep mode', () => {
    expect(resolveModelRoute({ profile: 'fast', workload: 'critical', configuredModel: 'custom-sol', environment: {} }))
      .toMatchObject({ workload: 'standard', model: 'custom-sol', reasoningEffort: 'medium' });
    expect(resolveModelRoute({ profile: 'deep', workload: 'standard', environment: {} }))
      .toMatchObject({ workload: 'critical', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  });

  it('supports centrally configurable model aliases', () => {
    expect(resolveModelRoute({ profile: 'balanced', workload: 'economy', environment: { FORGEMIND_MODEL_ECONOMY: 'economy-alias' } }).model)
      .toBe('economy-alias');
  });

  it('shares one task routing decision between implementation and review wrappers', async () => {
    const routeTask = vi.fn(async () => ({
      version: 1 as const,
      routerModel: 'gpt-6.1-sol',
      implementation: { model: 'gpt-6-luna', reasoningEffort: 'medium' as const },
      review: { model: 'gpt-6-luna', reasoningEffort: 'low' as const },
      escalation: { model: 'gpt-6.1-sol', reasoningEffort: 'high' as const },
      rationale: 'Scoped documentation task.',
      confidence: 0.95,
      decidedAt: new Date().toISOString()
    }));
    const fakeProvider = { kind: 'codex', routeTask } as unknown as AIProvider;
    const state: ModelRoutingState = {};
    const config = {
      modelProfile: 'balanced' as const,
      model: 'gpt-6.1-sol',
      allowedModels: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
      routingState: state
    };
    const implementationProvider = new ModelRoutedProvider('codex', config, () => fakeProvider);
    const reviewProvider = new ModelRoutedProvider('codex', config, () => fakeProvider);
    const input = {
      taskId: 'task-1',
      title: 'Update documentation',
      prompt: 'Add one documented example.',
      acceptanceCriteria: ['The example is linked from README.'],
      availableModels: config.allowedModels,
      routerModel: config.model
    };

    const first = await implementationProvider.routeTask(input);
    const second = await reviewProvider.routeTask(input);

    expect(routeTask).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(state.decision?.implementation.model).toBe('gpt-6-luna');
  });

  it('rejects a router response whose escalation route is weaker than implementation', () => {
    expect(() => parseTaskModelRoutingDecision(JSON.stringify({
      implementation: { model: 'gpt-6-astra', reasoningEffort: 'high' },
      review: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      escalation: { model: 'gpt-6-luna', reasoningEffort: 'max' },
      rationale: 'Invalid downgrade.',
      confidence: 0.9
    }), {
      availableModels: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
      routerModel: 'gpt-6.1-sol'
    })).toThrow('escalation must be at least as capable');
  });
});
