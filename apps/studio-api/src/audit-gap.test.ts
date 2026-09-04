import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditGapProposal, Project } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import { prepareReadOnlyRepositoryBaseline } from '@forgemind/github';
import { createProvider } from '@forgemind/providers';
import type { AIProvider } from '@forgemind/providers';
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
  const job = { id: 'audit', cycleId: 'cycle', status: 'succeeded', gapProposalStatus: 'proposed', gapProposal };
  const roadmap = { projectId: project.id, cycles: [{ id: 'cycle', status: 'partial' }], steps: [], auditJobs: [job] };
  const owner = { id: 'owner', name: 'Owner', email: 'owner@example.com', role: 'owner' as const };
  const review = { verdict: 'satisfied' as const, summary: 'Still needed in the current repository.', blockers: [] };
  const provider = { kind: 'codex', reviewRoadmap: vi.fn(async (_input: Parameters<NonNullable<AIProvider['reviewRoadmap']>>[0]) => review) };
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
    saveProjectAuditGapReview: vi.fn(), decideProjectAuditGapProposal: vi.fn(), writeAudit: vi.fn(),
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
      repositoryBaseline: { commitSha: currentSha, evidence: expect.stringContaining('current code') },
      objective: expect.stringContaining(auditSha)
    }));
    expect(f.provider.reviewRoadmap.mock.calls[0]![0].objective).toContain('already implemented');
    expect(f.repository.saveProjectAuditGapReview).toHaveBeenCalledWith({ projectId: 'project', auditJobId: 'audit', review: f.review });
    expect(f.repository.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'project_audit_gap_review_baseline',
      payload: { auditJobId: 'audit', proposalCommitSha: auditSha, reviewCommitSha: currentSha, verdict: 'satisfied' }
    }));
    expect(f.repository.decideProjectAuditGapProposal).toHaveBeenCalledWith({ projectId: 'project', auditJobId: 'audit', accepted: true, review: f.review });
    expect(f.repository.createTask).not.toHaveBeenCalled();
    expect(f.repository.enqueueTask).not.toHaveBeenCalled();
    expect(f.job.gapProposal.commitSha).toBe(auditSha);
    expect(f.cleanup).toHaveBeenCalledOnce();
  });

  it('does not activate a stale or already implemented proposal rejected by fresh review', async () => {
    const f = fixture();
    f.provider.reviewRoadmap.mockResolvedValue({ verdict: 'not_satisfied', summary: 'Already implemented.', blockers: ['Documentation was already repaired.'] } as never);
    const response = await f.request();
    expect(response.statusCode).toBe(409);
    expect(response.json().blockers).toEqual(['Documentation was already repaired.']);
    expect(f.repository.saveProjectAuditGapReview).toHaveBeenCalledOnce();
    expect(f.repository.decideProjectAuditGapProposal).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledOnce();
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
