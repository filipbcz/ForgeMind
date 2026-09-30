import { describe, expect, it } from 'vitest';
import { resolveModelRoute } from './model-router.js';

describe('model routing', () => {
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
});
