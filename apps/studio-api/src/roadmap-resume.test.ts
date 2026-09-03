import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createAuthService } from './auth.js';
import type { Project, RoadmapGenerationCheckpoint } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import { createProvider } from '@forgemind/providers';
import type { AIProvider } from '@forgemind/providers';
import { generateRoadmapPlan, registerRoutes } from './routes.js';

vi.mock('@forgemind/providers', async (importOriginal) => ({
  ...await importOriginal<object>(), createProvider: vi.fn()
}));

function fixture() {
  const project = { id: 'project', name: 'Export', brief: 'Build export support.', aiProviderConnectionId: 'connection' } as Project;
  const specification = { id: 'spec-1', fullSpecification: project.brief };
  const connection = { id: 'connection', provider: 'openai', model: 'fixture-model', authMode: 'api_key' };
  let stored: { contextKey: string; checkpoint: RoadmapGenerationCheckpoint } | undefined;
  const repository = {
    getProject: vi.fn(async () => project),
    getProjectSpecifications: vi.fn(async () => ({ current: specification })),
    getProjectContracts: vi.fn(async () => ({ versions: [] })),
    getProjectRoadmap: vi.fn(async () => ({ cycles: [], steps: [] })),
    getAIProviderConnectionSecretById: vi.fn(async () => connection),
    getRoadmapGenerationCheckpoint: vi.fn(async (_id: string, key: string) => stored?.contextKey === key ? structuredClone(stored.checkpoint) : undefined),
    saveRoadmapGenerationCheckpoint: vi.fn(async (_id: string, contextKey: string, checkpoint: RoadmapGenerationCheckpoint) => {
      stored = { contextKey, checkpoint: structuredClone(checkpoint) };
    }),
    writeAudit: vi.fn(), updateProjectPlanningSession: vi.fn()
  };
  const provider = { plan: vi.fn(async () => ({ summary: 'Candidate', steps: [], acceptanceCriteria: [], implementationSteps: [] })) };
  vi.mocked(createProvider).mockReturnValue(provider as unknown as AIProvider);
  const run = () => generateRoadmapPlan(repository as unknown as ForgeMindRepository, project, project.brief!, specification.fullSpecification);
  return { run, repository, project, specification, connection, provider };
}

describe('roadmap draft resume context', () => {
  it('loads the latest checkpoint instead of calling plan again', async () => {
    const f = fixture();
    const first = await f.run();
    await first.saveCheckpoint({ ...first.checkpoint, phase: 'repair', validationError: 'Resolve overlap', revision: 4 });
    const resumed = await f.run();
    expect(f.provider.plan).toHaveBeenCalledTimes(1);
    expect(resumed.checkpoint).toMatchObject({ phase: 'repair', revision: 4, validationError: 'Resolve overlap' });
    expect(f.repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'project_roadmap_generation_resumed' }));
  });

  it.each(['specification', 'model', 'objective', 'roadmap', 'contract', 'architecture'] as const)('does not reuse a draft after %s changes', async (change) => {
    const f = fixture();
    await f.run();
    if (change === 'specification') f.specification.fullSpecification = 'An updated specification.';
    if (change === 'model') f.connection.model = 'different-model';
    if (change === 'objective') f.project.brief = 'A changed objective.';
    if (change === 'roadmap') f.repository.getProjectRoadmap.mockResolvedValue({ cycles: [{ id: 'new-cycle' }], steps: [] } as never);
    if (change === 'contract') f.project.currentContractVersionId = 'new-contract';
    if (change === 'architecture') f.project.currentArchitectureVersionId = 'new-architecture';
    await f.run();
    expect(f.provider.plan).toHaveBeenCalledTimes(2);
  });

  it('rejects publication and checkpoint writes if source inputs change during generation', async () => {
    const f = fixture();
    const planning = await f.run();
    f.specification.fullSpecification = 'Changed during review.';
    await expect(planning.assertCurrentSource()).rejects.toThrow('planning inputs changed');
    await expect(planning.saveCheckpoint(planning.checkpoint)).rejects.toThrow('planning inputs changed');
    expect(f.repository.saveRoadmapGenerationCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('does not create a cycle on provider failure and resumes the same draft through the authenticated endpoint', async () => {
    const f = fixture();
    const step = {
      title: 'Implement export', description: 'Export records.', acceptanceCriteria: ['Records can be exported.'],
      inScope: ['Export'], outOfScope: [], requirementIds: ['REQ-EXPORT'], deliverables: ['Export module'],
      changeRationale: 'Implement approved export.', dependsOnStepTitles: [], validationFocus: ['implementation']
    };
    const candidate = {
      summary: 'Export', steps: [], acceptanceCriteria: [], implementationSteps: [step],
      projectContract: {
        version: 1, summary: 'Export', invariants: ['Preserve records.'], prohibitedSubstitutes: [], releaseCriteria: ['Export works.'],
        requirements: [{ id: 'REQ-EXPORT', title: 'Export', description: 'Export records.', acceptanceCriteria: ['Records can be exported.'], briefReferences: ['export'] }]
      },
      architectureUpdate: {
        summary: 'Export module', modules: [{ name: 'Export', responsibility: 'Export records', paths: ['src/export.ts'], publicInterfaces: ['exportRecords'], dependencies: [] }],
        decisions: [], conventions: [], dependencyRules: [], knownDebt: [], resolvedDebt: []
      }
    };
    const provider = {
      kind: 'openai', plan: vi.fn().mockResolvedValue(candidate),
      reviewRoadmap: vi.fn().mockResolvedValueOnce({ verdict: 'not_satisfied', summary: 'Clarify export', blockers: ['Specify the output format.'] })
        .mockResolvedValue({ verdict: 'satisfied', summary: 'Ready', blockers: [] }),
      repairRoadmap: vi.fn().mockRejectedValueOnce(new Error('Temporary provider outage'))
        .mockResolvedValue({ implementationSteps: [{ ...step, acceptanceCriteria: ['Records can be exported as CSV.'] }] })
    };
    vi.mocked(createProvider).mockReturnValue(provider as unknown as AIProvider);
    const owner = { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'owner' as const };
    const repository = {
      ...f.repository, getCurrentUser: vi.fn(async () => owner), assertProjectRoadmapRegenerationAllowed: vi.fn(),
      createProjectRoadmapCycle: vi.fn(async () => ({ cycles: [], steps: [] }))
    };
    const auth = createAuthService();
    const headers = { authorization: `Bearer ${auth.createTestSession(owner).id}` };
    const app = Fastify();
    registerRoutes(app, repository as unknown as ForgeMindRepository, undefined, auth);
    const request = { method: 'POST' as const, url: '/api/projects/project/implementation-steps/generate', headers, payload: { confirmation: 'GENERATE ROADMAP' } };
    try {
      const failed = await app.inject(request);
      expect(failed.statusCode).toBe(400);
      expect(failed.json().error).toContain('Temporary provider outage');
      expect(repository.createProjectRoadmapCycle).not.toHaveBeenCalled();
      expect(repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'project_roadmap_generation_interrupted' }));
      const resumed = await app.inject(request);
      expect(resumed.json().error).toBeUndefined();
      expect(resumed.statusCode).toBe(201);
      expect(provider.plan).toHaveBeenCalledTimes(1);
      expect(provider.reviewRoadmap).toHaveBeenCalledTimes(2);
      expect(repository.createProjectRoadmapCycle).toHaveBeenCalledTimes(1);
      expect(repository.createProjectRoadmapCycle).toHaveBeenCalledWith(expect.objectContaining({ qualityReview: expect.objectContaining({ verdict: 'satisfied' }) }));
    } finally { await app.close(); }
  });
});
