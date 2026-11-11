import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createAuthService } from './auth.js';
import type { Project, RoadmapGenerationCheckpoint } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import { createProvider, parseReviewResult } from '@forgemind/providers';
import type { AIProvider } from '@forgemind/providers';
import { generateRoadmapPlan, registerRoutes } from './routes.js';

vi.mock('@forgemind/providers', async (importOriginal) => ({
  ...await importOriginal<object>(), createProvider: vi.fn()
}));

let baselineSha = 'a'.repeat(40);
vi.mock('@forgemind/github', async (importOriginal) => ({
  ...await importOriginal<object>(),
  prepareReadOnlyRepositoryBaseline: vi.fn(async () => ({
    repositoryPath: '/tmp/read-only-baseline', commitSha: baselineSha,
    evidence: `--- src/existing-feature.ts ---\nexport const existingFeature = true; // ${baselineSha}`,
    cleanup: vi.fn(async () => undefined)
  }))
}));

function fixture() {
  const project = {
    id: 'project', name: 'Export', brief: 'Build export support.', aiProviderConnectionId: 'connection',
    githubOwner: 'owner', githubRepo: 'repository', defaultBranch: 'main'
  } as Project;
  const specification = { id: 'spec-1', fullSpecification: project.brief };
  const connection = { id: 'connection', provider: 'openai', model: 'fixture-model', authMode: 'api_key' };
  let stored: { contextKey: string; checkpoint: RoadmapGenerationCheckpoint } | undefined;
  const repository = {
    getProject: vi.fn(async () => project),
    getProjectSpecifications: vi.fn(async () => ({ current: specification })),
    getProjectContracts: vi.fn(async () => ({ versions: [] })),
    getProjectRoadmap: vi.fn(async () => ({ cycles: [], steps: [] })),
    getAIProviderConnectionSecretById: vi.fn(async () => connection),
    getGitHubConnectionSecret: vi.fn(async () => ({ token: 'secret', apiBaseUrl: 'https://api.github.test' })),
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
  it('fails roadmap planning over from an invalid API key to an eligible ChatGPT plan connection', async () => {
    const f = fixture();
    const primary = {
      ...f.connection, provider: 'codex' as const, authMode: 'api_key' as const, apiKey: 'invalid-key',
      name: 'API key', automaticFailover: false, failoverPriority: 0, connectedAt: '2026-01-01T00:00:00.000Z'
    };
    const fallback = {
      ...primary, id: 'chatgpt-plan', name: 'ChatGPT plan', authMode: 'chatgpt_plan_oauth' as const,
      apiKey: undefined, accessToken: 'oauth-access', automaticFailover: true, failoverPriority: 10,
      connectedAt: '2026-01-02T00:00:00.000Z'
    };
    Object.assign(f.connection, primary);
    Object.assign(f.repository, {
      getAIProviderConnectionSecretById: vi.fn(async (id: string) => id === fallback.id ? fallback : primary),
      listAIProviderConnectionSecrets: vi.fn(async () => [primary, fallback])
    });
    const primaryProvider = {
      kind: 'codex',
      plan: vi.fn(async () => { throw Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 }); })
    } as unknown as AIProvider;
    const fallbackProvider = {
      kind: 'codex',
      plan: vi.fn(async (input) => {
        await input.session?.onUpdate?.({ id: 'fallback-thread', provider: 'codex', model: 'gpt-6.1-sol' });
        return { summary: 'Candidate', steps: [], acceptanceCriteria: [], implementationSteps: [] };
      })
    } as unknown as AIProvider;
    vi.mocked(createProvider).mockImplementation((_kind, config) =>
      config?.accessToken ? fallbackProvider : primaryProvider);

    const planning = await f.run();

    expect(primaryProvider.plan).toHaveBeenCalledTimes(1);
    expect(fallbackProvider.plan).toHaveBeenCalledTimes(1);
    expect(planning.plan.summary).toBe('Candidate');
    expect(f.repository.updateProjectPlanningSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: f.project.id, sessionId: 'fallback-thread', connectionId: fallback.id
    }));
    expect(f.repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'provider_fallback_used', projectId: f.project.id,
      payload: expect.objectContaining({ fallbackConnectionId: fallback.id })
    }));
  });

  it('refuses planning when no commit-bound repository can be discovered', async () => {
    const f = fixture();
    f.project.githubOwner = undefined;
    f.project.githubRepo = undefined;
    await expect(f.run()).rejects.toThrow('connected repository is required');
    expect(f.provider.plan).not.toHaveBeenCalled();
  });

  it('loads the latest checkpoint instead of calling plan again', async () => {
    const f = fixture();
    const first = await f.run();
    await first.saveCheckpoint({ ...first.checkpoint, phase: 'repair', validationError: 'Resolve overlap', revision: 4 });
    const resumed = await f.run();
    expect(f.provider.plan).toHaveBeenCalledTimes(1);
    expect(resumed.checkpoint).toMatchObject({ phase: 'repair', revision: 4, validationError: 'Resolve overlap' });
    expect(f.repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'project_roadmap_generation_resumed' }));
  });

  it('revalidates a repair checkpoint when provider vocabulary is normalized on resume', async () => {
    const f = fixture();
    const first = await f.run();
    await first.saveCheckpoint({
      ...first.checkpoint, phase: 'repair', validationError: 'Implementation step 1 execution intent is invalid.', revision: 2,
      plan: {
        ...first.plan,
        implementationSteps: [{
          title: 'Verify Unreal baseline', validationFocus: ['Editor regression evidence'],
          executionIntent: {
            executor: 'windows', networkAccess: 'none', unrealEditorSaveRequired: true,
            requiredCapabilities: ['windows', 'unreal-engine-5.8'], artifactKinds: ['editor-log', 'unreal-assets'],
            persistentOutputPaths: [], minimumFreeSpaceBytes: 0
          }
        }]
      } as never
    });

    const resumed = await f.run();

    expect(resumed.checkpoint).toMatchObject({ phase: 'validate', revision: 2, validationError: undefined });
    expect(resumed.plan.implementationSteps?.[0]?.executionIntent).toMatchObject({
      requiresUnrealAuthoring: true, requiredCapabilities: ['windows', 'unreal'],
      artifactKinds: ['unreal-assets', 'validation-evidence']
    });
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

  it('invalidates a checkpoint when code outside roadmap tasks changes at the tracked branch', async () => {
    const f = fixture();
    baselineSha = 'a'.repeat(40);
    await f.run();
    expect(f.provider.plan).toHaveBeenLastCalledWith(expect.objectContaining({
      repositoryBaseline: expect.objectContaining({ commitSha: baselineSha, evidence: expect.stringContaining('existing-feature.ts') })
    }));
    baselineSha = 'b'.repeat(40);
    await f.run();
    expect(f.provider.plan).toHaveBeenCalledTimes(2);
  });

  it('does not create a cycle on provider failure and resumes the same draft through the authenticated endpoint', async () => {
    const f = fixture();
    const step = {
      title: 'Implement export', description: 'Export records.', acceptanceCriteria: ['Records can be exported.'],
      inScope: ['Export'], outOfScope: [], requirementIds: ['REQ-EXPORT'], deliverables: ['Export module'],
      changeRationale: 'Implement approved export.', dependsOnStepTitles: [], validationFocus: ['implementation'],
      executionIntent: {
        executor: 'linux' as const, requiredCapabilities: [], artifactKinds: ['repository' as const], networkAccess: 'none' as const,
        requiresUnrealAuthoring: false, persistentOutputPaths: [], minimumFreeSpaceBytes: 0
      }
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
        .mockResolvedValue(parseReviewResult(JSON.stringify({
          verdict: 'approved', conclusion: 'Ready', blockers: null,
          criterionResults: { Coverage: { result: 'pass', evidence: 'The export requirement is covered.' } }
        }), 'Roadmap review')),
      repairRoadmap: vi.fn().mockRejectedValueOnce(new Error('Temporary provider outage'))
        .mockResolvedValue({ implementationSteps: [{ ...step, acceptanceCriteria: ['Records can be exported as CSV.'] }] })
    };
    vi.mocked(createProvider).mockReturnValue(provider as unknown as AIProvider);
    const owner = { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'owner' as const };
    let cycleCreated = false;
    const createdRoadmap = {
      cycles: [{ id: 'cycle-1', cycleNumber: 1, status: 'active' }],
      steps: [{
        id: 'step-1', cycleId: 'cycle-1', sequenceNumber: 1, status: 'pending', title: step.title,
        description: step.description, acceptanceCriteria: step.acceptanceCriteria, deliverables: step.deliverables,
        dependsOnStepTitles: [], executionIntent: step.executionIntent
      }]
    };
    const repository = {
      ...f.repository, getCurrentUser: vi.fn(async () => owner), assertProjectRoadmapRegenerationAllowed: vi.fn(),
      getProjectRoadmap: vi.fn(async () => cycleCreated ? createdRoadmap : { cycles: [], steps: [] }),
      createProjectRoadmapCycle: vi.fn(async () => { cycleCreated = true; return createdRoadmap; }),
      createAndStartRoadmapStepTask: vi.fn(async () => ({ id: 'task-1', projectId: f.project.id, status: 'submitted' }))
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
      expect(provider.reviewRoadmap).toHaveBeenCalledWith(expect.objectContaining({
        repositoryPath: '/tmp/read-only-baseline'
      }));
      expect(repository.createProjectRoadmapCycle).toHaveBeenCalledTimes(1);
      expect(repository.createProjectRoadmapCycle).toHaveBeenCalledWith(expect.objectContaining({ qualityReview: expect.objectContaining({ verdict: 'satisfied' }) }));
      expect(repository.createAndStartRoadmapStepTask).toHaveBeenCalledWith('step-1', expect.objectContaining({
        projectId: f.project.id, title: 'Export: Implement export', acceptanceCriteria: ['Records can be exported.']
      }));
    } finally { await app.close(); }
  });
});
