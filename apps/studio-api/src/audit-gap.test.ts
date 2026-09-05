import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditGapProposal, AuditGapProposalHistoryEntry, Project } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import { prepareReadOnlyRepositoryBaseline } from '@forgemind/github';
import { createProvider } from '@forgemind/providers';
import type { AIProvider, ReviewResult } from '@forgemind/providers';
import { createAuthService } from './auth.js';
import { registerRoutes } from './routes.js';

vi.mock('@forgemind/providers', async (original) => ({ ...await original<object>(), createProvider: vi.fn() }));
vi.mock('@forgemind/github', async (original) => ({ ...await original<object>(), prepareReadOnlyRepositoryBaseline: vi.fn() }));

const auditSha = 'a'.repeat(40);
const currentSha = 'b'.repeat(40);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.clearAllMocks(); });

function fixture() {
  const project: Project = {
    id: 'project', name: 'ForgeMind', slug: 'forgemind', isActive: true, createdAt: '', updatedAt: '',
    defaultBranch: 'main', githubOwner: 'owner', githubRepo: 'repo',
    aiProviderConnectionId: 'connection', brief: 'Keep current documentation truthful.',
    projectContract: {
      version: 4, summary: 'Current scope', invariants: ['Preserve history.'], prohibitedSubstitutes: [],
      requirements: [{ id: 'REQ-DOCS', title: 'Documentation', description: 'Accurate docs.', acceptanceCriteria: ['References exist.'], briefReferences: [] }],
      releaseCriteria: ['Accurate documentation.']
    }
  };
  const gapProposal: AuditGapProposal = {
    kind: 'capability', commitSha: auditSha, summary: 'Repair obsolete documentation.', newRequirements: [],
    steps: [{
      title: 'Correct documentation references', description: 'Replace invalid references without runtime changes.',
      acceptanceCriteria: ['References exist.'], requirementIds: ['REQ-DOCS'], deliverables: ['Corrected documentation'],
      changeRationale: 'References are invalid.', dependsOnStepTitles: [], validationFocus: ['regression']
    }]
  };
  const job = { id: 'audit', cycleId: 'cycle', status: 'succeeded', gapProposalStatus: 'proposed', gapProposal,
    gapProposalReview: undefined as ReviewResult | undefined, gapProposalHistory: [] as AuditGapProposalHistoryEntry[] };
  const roadmap = { projectId: project.id, cycles: [{ id: 'cycle', status: 'partial' }], steps: [], auditJobs: [job] };
  const owner = { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'owner' as const };
  const review = { verdict: 'satisfied' as const, summary: 'Still needed in the current repository.', blockers: [] };
  const provider = { kind: 'codex',
    supportsNativeRepositoryReview: () => true,
    reviewRoadmap: vi.fn(async (_input: Parameters<NonNullable<AIProvider['reviewRoadmap']>>[0]): Promise<ReviewResult> => review),
    repairRoadmap: vi.fn(async (_input: Parameters<NonNullable<AIProvider['repairRoadmap']>>[0]) => ({
      implementationSteps: [{ ...gapProposal.steps[0]!, description: 'Correct docs/readme-parity.md:22, using apps/studio-api/src/routes.ts.', inScope: [], outOfScope: [] }]
    }))
  };
  const cleanup = vi.fn(async () => undefined);
  vi.mocked(createProvider).mockReturnValue(provider as unknown as AIProvider);
  vi.mocked(prepareReadOnlyRepositoryBaseline).mockResolvedValue({
    repositoryPath: '/read-only/current', commitSha: currentSha,
    evidence: 'Complete repository snapshot: current code and documentation.', cleanup
  });
  const repository = {
    getCurrentUser: vi.fn(async () => owner), getProject: vi.fn(async () => project),
    getProjectRoadmap: vi.fn(async () => roadmap),
    getProjectSpecifications: vi.fn(async () => ({ current: { fullSpecification: project.brief } })),
    getAIProviderConnectionSecretById: vi.fn(async () => ({ provider: 'codex', authMode: 'codex_oauth', model: 'test-model' })),
    getGitHubConnectionSecret: vi.fn(async () => ({ token: 'test-token', apiBaseUrl: 'https://api.github.test' })),
    saveProjectAuditGapReview: vi.fn(async (input: { review: ReviewResult }) => { job.gapProposalReview = input.review; }),
    reviseProjectAuditGapProposal: vi.fn(async (input: { proposal: AuditGapProposal }) => {
      job.gapProposalHistory.push({ proposal: job.gapProposal, status: 'proposed', reason: 'repair', review: job.gapProposalReview, archivedAt: '' });
      job.gapProposal = input.proposal; job.gapProposalReview = undefined;
    }),
    decideProjectAuditGapProposal: vi.fn(), writeAudit: vi.fn(),
    createTask: vi.fn(), enqueueTask: vi.fn()
  };
  const auth = createAuthService();
  const headers = { authorization: `Bearer ${auth.createTestSession(owner).id}` };
  const app = Fastify();
  apps.push(app);
  registerRoutes(app, repository as unknown as ForgeMindRepository, undefined, auth);
  const request = (accepted = true, authenticated = true) => app.inject({
    method: 'POST', url: '/api/projects/project/audit/gaps/decision',
    headers: authenticated ? headers : {}, payload: { auditJobId: job.id, accepted }
  });
  return { request, repository, provider, review, job, cleanup, project };
}

describe('audit gap activation', () => {
  it('reviews a proposal against current main even when squash merge changed the commit ID', async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.statusCode).toBe(200);
    expect(f.provider.reviewRoadmap).toHaveBeenCalledWith(expect.objectContaining({
      authoritativeSpecification: f.project.brief,
      repositoryPath: '/read-only/current',
      repositoryBaseline: { commitSha: currentSha, evidence: expect.stringContaining('current code') },
      objective: expect.stringContaining(auditSha)
    }));
    expect(f.provider.reviewRoadmap.mock.calls[0]![0].objective).toContain('already implemented');
    expect(f.repository.saveProjectAuditGapReview).toHaveBeenCalledWith({ projectId: 'project', auditJobId: 'audit', review: f.review, expectedProposal: f.job.gapProposal });
    expect(f.repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'project_audit_gap_review_baseline',
      payload: { auditJobId: 'audit', proposalCommitSha: auditSha, reviewCommitSha: currentSha, verdict: 'satisfied' }
    }));
    expect(f.repository.decideProjectAuditGapProposal).toHaveBeenCalledWith({ projectId: 'project', auditJobId: 'audit', accepted: true, review: f.review, expectedProposal: f.job.gapProposal });
    expect(f.repository.createTask).not.toHaveBeenCalled();
    expect(f.repository.enqueueTask).not.toHaveBeenCalled();
    expect(f.job.gapProposal.commitSha).toBe(auditSha);
    expect(f.cleanup).toHaveBeenCalledTimes(2);
  });

  it('does not activate a stale or already implemented proposal rejected by fresh review', async () => {
    const f = fixture();
    f.provider.reviewRoadmap.mockResolvedValue({ verdict: 'not_satisfied', summary: 'Already implemented.', blockers: ['Documentation was already repaired.'] } as never);
    f.provider.repairRoadmap.mockRejectedValue(new Error('Repair provider unavailable.'));
    const response = await f.request();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Repair provider unavailable.');
    expect(f.repository.saveProjectAuditGapReview).toHaveBeenCalledOnce();
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });

  it('repairs concrete review feedback, preserves history and activates only after independent approval', async () => {
    const f = fixture();
    f.provider.reviewRoadmap.mockResolvedValueOnce({ verdict: 'not_satisfied', summary: 'Missing exact references.', blockers: ['Name the broken paths.'] });
    const original = f.job.gapProposal;
    expect((await f.request()).statusCode).toBe(200);
    expect(f.provider.repairRoadmap).toHaveBeenCalledWith(expect.objectContaining({
      validationError: expect.stringContaining('Name the broken paths.'),
      authoritativeSpecification: f.project.brief, repositoryPath: '/read-only/current', signal: expect.any(AbortSignal)
    }));
    expect(f.provider.reviewRoadmap).toHaveBeenCalledTimes(2);
    expect(f.provider.reviewRoadmap.mock.calls[1]![0].implementationSteps[0]!.description).toContain('docs/readme-parity.md:22');
    expect(f.repository.reviseProjectAuditGapProposal).toHaveBeenCalledWith(expect.objectContaining({ expectedProposal: original }));
    expect(f.job.gapProposalHistory).toMatchObject([{ proposal: original, reason: 'repair' }]);
    expect(f.repository.decideProjectAuditGapProposal).toHaveBeenCalledWith(expect.objectContaining({ expectedProposal: f.job.gapProposal, review: f.review }));
    expect(f.repository.createTask).not.toHaveBeenCalled();
    expect(f.repository.enqueueTask).not.toHaveBeenCalled();
  });

  it('resumes at repair after a technical failure without repeating the saved rejected review', async () => {
    const f = fixture();
    f.job.gapProposalReview = { verdict: 'not_satisfied', summary: 'Unclear references.', blockers: ['Name the broken paths.'] };
    f.provider.repairRoadmap.mockRejectedValueOnce(new Error('Temporary outage.'));
    expect((await f.request()).statusCode).toBe(400);
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
    expect((await f.request()).statusCode).toBe(200);
    expect(f.provider.repairRoadmap).toHaveBeenCalledTimes(2);
    expect(f.provider.reviewRoadmap).toHaveBeenCalledTimes(1);
  });

  it('resumes a saved revision at review when its previous review call failed', async () => {
    const f = fixture();
    f.job.gapProposalReview = { verdict: 'not_satisfied', summary: 'Needs correction.', blockers: ['Name paths.'] };
    f.provider.reviewRoadmap.mockRejectedValueOnce(new Error('Review outage.'));
    expect((await f.request()).statusCode).toBe(400);
    expect(f.job.gapProposalReview).toBeUndefined();
    expect((await f.request()).statusCode).toBe(200);
    expect(f.provider.repairRoadmap).toHaveBeenCalledTimes(1);
    expect(f.job.gapProposalHistory).toHaveLength(1);
  });

  it('retains the original gaps in review context after an empty repair and interrupted review', async () => {
    const f = fixture();
    const originalTitle = f.job.gapProposal.steps[0]!.title;
    f.job.gapProposalReview = { verdict: 'not_satisfied', summary: 'Reassess stale gaps.', blockers: ['Verify whether references are still wrong.'] };
    f.provider.repairRoadmap.mockResolvedValueOnce({ implementationSteps: [] });
    f.provider.reviewRoadmap.mockRejectedValueOnce(new Error('Review outage.'));
    expect((await f.request()).statusCode).toBe(400);
    expect(f.job.gapProposal.steps).toEqual([]);
    expect((await f.request()).statusCode).toBe(200);
    expect(f.provider.reviewRoadmap.mock.calls[1]![0].objective).toContain(originalTitle);
    expect(f.provider.reviewRoadmap.mock.calls[1]![0].implementationSteps).toEqual([]);
  });

  it('does not activate when project scope changes during review', async () => {
    const f = fixture();
    f.provider.reviewRoadmap.mockImplementationOnce(async () => { f.project.brief = 'Changed specification.'; return f.review; });
    expect((await f.request()).json().error).toContain('Project scope or roadmap changed');
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
  });

  it('does not activate when main changes during review', async () => {
    const f = fixture();
    f.provider.reviewRoadmap.mockImplementationOnce(async () => {
      vi.mocked(prepareReadOnlyRepositoryBaseline).mockResolvedValueOnce({ repositoryPath: '/other', commitSha: 'c'.repeat(40), evidence: 'changed', cleanup: f.cleanup });
      return f.review;
    });
    expect((await f.request()).json().error).toContain('Repository changed');
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
  });

  it('prevents concurrent activation or dismissal while an AI operation is running', async () => {
    const f = fixture();
    let started!: () => void;
    let finish!: (review: ReviewResult) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.provider.reviewRoadmap.mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve; }); });
    const first = f.request();
    await ready;
    try {
      expect((await f.request()).statusCode).toBe(409);
      expect((await f.request(false)).statusCode).toBe(409);
    } finally { finish(f.review); }
    expect((await first).statusCode).toBe(200);
    expect(f.provider.reviewRoadmap).toHaveBeenCalledOnce();
  });

  it('keeps the proposal available when review fails', async () => {
    const f = fixture();
    f.provider.reviewRoadmap.mockRejectedValue(new Error('Provider unavailable.'));
    const response = await f.request();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('Provider unavailable.');
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
  });

  it.each(['activated', 'dismissed'])('does not repeat a %s decision', async status => {
    const f = fixture(); f.job.gapProposalStatus = status;
    expect((await f.request()).statusCode).toBe(200);
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
  });

  it('dismisses without invoking AI or starting work', async () => {
    const f = fixture();
    expect((await f.request(false)).statusCode).toBe(200);
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
    expect(f.repository.decideProjectAuditGapProposal).toHaveBeenCalledWith({ projectId: 'project', auditJobId: 'audit', accepted: false });
    expect(f.repository.enqueueTask).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const f = fixture();
    expect((await f.request(true, false)).statusCode).toBe(401);
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
  });

  it.each(['pending', 'claimed', 'blocked', 'failed'])('does not activate an old proposal while its audit is %s', async status => {
    const f = fixture(); f.job.status = status;
    expect((await f.request()).statusCode).toBe(409);
    expect(f.provider.reviewRoadmap).not.toHaveBeenCalled();
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
  });
});
