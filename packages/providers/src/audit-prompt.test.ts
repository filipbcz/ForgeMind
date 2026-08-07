import { describe, expect, it } from 'vitest';
import type { CapabilityAuditInput, CapabilityAuditResult, ReleaseAuditInput } from './provider.js';
import { buildCapabilityAuditPrompt, buildReleaseAuditPrompt, normalizeCapabilityAuditResult, normalizeReleaseAuditResult } from './audit-prompt.js';

const input: CapabilityAuditInput = {
  projectId: 'project_1',
  contractVersion: 2,
  contractSummary: 'Production leaderboard',
  invariants: ['Use persisted production data.'],
  prohibitedSubstitutes: ['Hard-coded leaderboard rows.'],
  requirement: {
    id: 'REQ-LEADERBOARD',
    title: 'Leaderboard',
    description: 'Expose persisted rankings through API and UI.',
    acceptanceCriteria: ['The leaderboard API returns persisted rankings.', 'The leaderboard screen renders API results.']
  },
  completedWorkItems: [{
    id: 'step_1',
    title: 'Build leaderboard',
    deliverables: ['API route', 'Leaderboard screen'],
    acceptanceCriteria: ['Integration tests pass.']
  }],
  evidence: [{
    criterion: 'Integration tests pass.',
    source: 'validation_command',
    status: 'passed',
    command: 'npm test',
    commitSha: 'abc123'
  }],
  repositoryPath: '/workspace',
  repositoryContext: 'src/leaderboard.ts: reads rankings from the database',
  commitSha: 'abc123'
};

describe('capability audit contract', () => {
  it('builds a focused prompt without the full project brief', () => {
    const prompt = buildCapabilityAuditPrompt(input);

    expect(prompt).toContain('REQ-LEADERBOARD');
    expect(prompt).toContain('Hard-coded leaderboard rows.');
    expect(prompt).toContain('Targeted repository packet:');
    expect(prompt).toContain('task validation and GitHub checks are supporting evidence');
  });

  it('accepts a fully evidenced satisfied verdict', () => {
    const result = normalizeCapabilityAuditResult(input, {
      verdict: 'satisfied',
      summary: 'Capability is implemented.',
      criteria: input.requirement.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: 'passed',
        evidence: [`src/leaderboard.ts implements ${criterion}`],
        gaps: []
      })),
      gapWorkItems: []
    });

    expect(result.verdict).toBe('satisfied');
    expect(result.criteria).toHaveLength(2);
  });

  it('requires a focused work item for a failed criterion', () => {
    const value: CapabilityAuditResult = {
      verdict: 'partial',
      summary: 'UI is missing.',
      criteria: [
        { criterion: input.requirement.acceptanceCriteria[0]!, status: 'passed', evidence: ['src/api.ts'], gaps: [] },
        { criterion: input.requirement.acceptanceCriteria[1]!, status: 'failed', evidence: [], gaps: ['Screen uses static rows.'] }
      ],
      gapWorkItems: [{
        title: 'Connect leaderboard screen',
        description: 'Replace static rows with the API response.',
        acceptanceCriteria: ['Screen integration test passes.'],
        inScope: ['Leaderboard screen'],
        outOfScope: ['API changes'],
        requirementIds: ['REQ-LEADERBOARD'],
        deliverables: ['API-backed leaderboard screen']
      }]
    };

    expect(normalizeCapabilityAuditResult(input, value).verdict).toBe('partial');
  });

  it('rejects pass claims without repository evidence', () => {
    expect(() => normalizeCapabilityAuditResult(input, {
      verdict: 'satisfied',
      summary: 'Claimed complete.',
      criteria: input.requirement.acceptanceCriteria.map((criterion) => ({ criterion, status: 'passed', evidence: [], gaps: [] })),
      gapWorkItems: []
    })).toThrow('without repository evidence');
  });
});

describe('release audit contract', () => {
  const releaseInput: ReleaseAuditInput = {
    projectId: input.projectId,
    contract: {
      version: input.contractVersion,
      summary: input.contractSummary,
      invariants: input.invariants,
      prohibitedSubstitutes: input.prohibitedSubstitutes,
      requirements: [input.requirement],
      releaseCriteria: ['The production build succeeds.']
    },
    satisfiedCapabilities: [{ requirementId: input.requirement.id, title: input.requirement.title, satisfiedCriteria: 2, totalCriteria: 2 }],
    repositoryPath: input.repositoryPath,
    repositoryContext: input.repositoryContext,
    commitSha: 'abc123'
  };

  it('audits global invariants and release criteria after capabilities', () => {
    const prompt = buildReleaseAuditPrompt(releaseInput);
    expect(prompt).toContain('Use persisted production data.');
    expect(prompt).toContain('The production build succeeds.');
    expect(prompt).toContain('Satisfied capabilities:');
  });

  it('allows a focused release gap linked to an existing requirement', () => {
    const result = normalizeReleaseAuditResult(releaseInput, {
      verdict: 'partial',
      summary: 'Build integration is missing.',
      criteria: [
        { criterion: releaseInput.contract.invariants[0]!, status: 'passed', evidence: ['src/api.ts'], gaps: [] },
        { criterion: releaseInput.contract.releaseCriteria[0]!, status: 'failed', evidence: [], gaps: ['Production build fails.'] }
      ],
      gapWorkItems: [{
        title: 'Repair production build',
        description: 'Fix the production build integration.',
        acceptanceCriteria: ['The production build succeeds.'],
        inScope: ['Build configuration'],
        outOfScope: ['New product features'],
        requirementIds: [input.requirement.id],
        deliverables: ['Working production build']
      }]
    });
    expect(result.verdict).toBe('partial');
  });
});
