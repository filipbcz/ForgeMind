import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, PlanResult, ProviderSessionContext, ReviewResult } from '@forgemind/providers';
import { createStudioProviderPool, type StudioProviderCandidate } from './provider-pool.js';

const planResult: PlanResult = { summary: 'Roadmap', steps: [], acceptanceCriteria: [], implementationSteps: [] };
const reviewResult: ReviewResult = { verdict: 'satisfied', summary: 'Ready', blockers: [] };

function candidate(id: string, provider: Partial<AIProvider>, create = vi.fn(async () => provider as AIProvider)): StudioProviderCandidate {
  return { id, label: id, kind: 'codex', capabilities: provider as AIProvider, create };
}

describe('Studio provider connection pool', () => {
  it('moves auth failures to the next connection and keeps later roadmap phases there', async () => {
    const primaryPlan = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
    });
    const fallbackPlan = vi.fn(async () => planResult);
    const fallbackReview = vi.fn(async () => reviewResult);
    const primaryCreate = vi.fn(async () => ({ kind: 'codex', plan: primaryPlan } as unknown as AIProvider));
    const fallbackCreate = vi.fn(async () => ({
      kind: 'codex', plan: fallbackPlan, reviewRoadmap: fallbackReview
    } as unknown as AIProvider));
    const session: ProviderSessionContext = { id: 'primary-thread', provider: 'codex', model: 'gpt-6.1-sol' };
    const audit = vi.fn(async () => undefined);
    const pool = createStudioProviderPool({
      candidates: [
        candidate('api-key', { kind: 'codex' }, primaryCreate),
        candidate('chatgpt-plan', { kind: 'codex' }, fallbackCreate)
      ],
      onConnectionSwitch: () => { session.id = undefined; },
      audit
    });

    await expect(pool.plan({ taskId: 'project', title: 'Roadmap', prompt: 'Generate it.', session }))
      .resolves.toEqual(planResult);
    await expect(pool.reviewRoadmap?.({
      taskId: 'project', objective: 'Ship it.', projectContract: {
        version: 1, summary: 'Contract', invariants: ['Keep it correct.'], prohibitedSubstitutes: [],
        requirements: [], releaseCriteria: ['Release works.']
      }, implementationSteps: [], requiredRequirementIds: [], completedStepTitles: []
    })).resolves.toEqual(reviewResult);

    expect(primaryCreate).toHaveBeenCalledTimes(1);
    expect(fallbackCreate).toHaveBeenCalledTimes(2);
    expect(session.id).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'provider_request_failed', payload: expect.objectContaining({ kind: 'authentication', connectionId: 'api-key' })
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'provider_fallback_used', payload: expect.objectContaining({ fallbackConnectionId: 'chatgpt-plan' })
    }));
  });

  it('does not hide semantic or provider-contract failures behind another account', async () => {
    const primaryCreate = vi.fn(async () => ({
      kind: 'codex', plan: vi.fn(async () => { throw new Error('Roadmap JSON is structurally invalid.'); })
    } as unknown as AIProvider));
    const fallbackCreate = vi.fn(async () => ({ kind: 'codex', plan: vi.fn(async () => planResult) } as unknown as AIProvider));
    const pool = createStudioProviderPool({
      candidates: [
        candidate('primary', { kind: 'codex' }, primaryCreate),
        candidate('fallback', { kind: 'codex' }, fallbackCreate)
      ]
    });

    await expect(pool.plan({ taskId: 'project', title: 'Roadmap', prompt: 'Generate it.' }))
      .rejects.toThrow('structurally invalid');
    expect(fallbackCreate).not.toHaveBeenCalled();
  });
});
