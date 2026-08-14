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
    expect(prompt).toContain('Copy each acceptance criterion');
    expect(prompt).toContain('Do not rerun commands that already have passed trusted execution evidence');
    expect(prompt).toContain('status deferred identifies a Windows-specific check');
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

  it('matches criteria when the provider omits inline code formatting', () => {
    const formattedInput: CapabilityAuditInput = {
      ...input,
      requirement: {
        ...input.requirement,
        acceptanceCriteria: ['`npm test` exits zero.']
      }
    };

    const result = normalizeCapabilityAuditResult(formattedInput, {
      verdict: 'satisfied',
      summary: 'Validation is evidenced.',
      criteria: [{
        criterion: 'npm test exits zero.',
        status: 'passed',
        evidence: ['Trusted validation passed for the audited commit.'],
        gaps: []
      }],
      gapWorkItems: []
    });

    expect(result.criteria[0]?.criterion).toBe('`npm test` exits zero.');
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
        deliverables: ['API-backed leaderboard screen'],
        changeRationale: 'Close the audited capability gap.',
        dependsOnStepTitles: [],
        validationFocus: ['implementation', 'regression']
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
    originalBrief: 'Build a production leaderboard backed by persisted rankings.',
    satisfiedCapabilities: [{ requirementId: input.requirement.id, title: input.requirement.title, satisfiedCriteria: 2, totalCriteria: 2 }],
    implementationSteps: [{
      sequenceNumber: 1,
      title: 'Build leaderboard',
      description: 'Implement the persisted leaderboard capability.',
      acceptanceCriteria: ['Integration tests pass.'],
      requirementIds: [input.requirement.id],
      deliverables: ['Leaderboard capability'],
      status: 'completed',
      origin: 'initial_roadmap',
      taskId: 'task_1'
    }],
    repositoryPath: input.repositoryPath,
    repositoryContext: input.repositoryContext,
    commitSha: 'abc123'
  };

  it('audits global invariants and release criteria after capabilities', () => {
    const prompt = buildReleaseAuditPrompt(releaseInput);
    expect(prompt).toContain('Use persisted production data.');
    expect(prompt).toContain('The production build succeeds.');
    expect(prompt).toContain('Satisfied capabilities:');
    expect(prompt).toContain('Original immutable project brief:');
    expect(prompt).toContain('chronological revisions appended from oldest to newest');
    expect(prompt).toContain('Trusted evidence from an ancestor commit remains supporting evidence');
    expect(prompt).toContain('Never create a work item whose only purpose is to reproduce same-commit evidence');
    expect(prompt).toContain('Copy each global invariant and release criterion');
    expect(prompt).toContain('Do not rerun commands that already have passed trusted execution evidence');
    expect(prompt).toContain('ForgeMind implementation-step evidence:');
    expect(prompt).toContain('Step 1: Build leaderboard [completed; initial_roadmap] task=task_1');
    expect(prompt).toContain('must address missing product behavior');
    expect(prompt).toContain('status deferred identifies Windows-specific validation');
  });

  it('allows a focused release gap linked to an existing requirement', () => {
    const result = normalizeReleaseAuditResult(releaseInput, {
      verdict: 'partial',
      summary: 'Build integration is missing.',
      criteria: [
        { criterion: releaseInput.contract.invariants[0]!, status: 'passed', evidence: ['src/api.ts'], gaps: [] },
        { criterion: releaseInput.contract.releaseCriteria[0]!, status: 'failed', evidence: [], gaps: ['Production build fails.'] }
      ],
      briefCoverage: [{
        obligation: 'Provide a production leaderboard backed by persisted rankings.',
        status: 'passed',
        workflowOnly: false,
        requirementIds: [input.requirement.id],
        evidence: ['src/api.ts reads persisted rankings and the UI renders the response.'],
        gaps: []
      }],
      contractAmendments: [],
      gapWorkItems: [{
        title: 'Repair production build',
        description: 'Fix the production build integration.',
        acceptanceCriteria: ['The production build succeeds.'],
        inScope: ['Build configuration'],
        outOfScope: ['New product features'],
        requirementIds: [input.requirement.id],
        deliverables: ['Working production build'],
        changeRationale: 'Restore the failed release criterion.',
        dependsOnStepTitles: [],
        validationFocus: ['implementation', 'regression']
      }]
    });
    expect(result.verdict).toBe('partial');
  });

  it('allows one cross-cutting release gap to reference every requirement it genuinely covers', () => {
    const requirements = ['CLASSIFICATION', 'ORDERING', 'COMMAND', 'READONLY'].map((suffix) => ({
      ...input.requirement,
      id: `REQ-AGENDA-${suffix}`,
      title: `Agenda ${suffix.toLowerCase()}`
    }));
    const crossCuttingInput: ReleaseAuditInput = {
      ...releaseInput,
      contract: {
        ...releaseInput.contract,
        requirements
      }
    };

    const result = normalizeReleaseAuditResult(crossCuttingInput, {
      verdict: 'partial',
      summary: 'The full agenda E2E scenario is missing.',
      criteria: [
        { criterion: releaseInput.contract.invariants[0]!, status: 'passed', evidence: ['src/agenda.js'], gaps: [] },
        { criterion: releaseInput.contract.releaseCriteria[0]!, status: 'failed', evidence: [], gaps: ['Cross-cutting E2E coverage is incomplete.'] }
      ],
      briefCoverage: [{
        obligation: 'Provide a classified, ordered, read-only agenda command.',
        status: 'passed',
        workflowOnly: false,
        requirementIds: requirements.map((requirement) => requirement.id),
        evidence: ['src/agenda.js implements the integrated behavior.'],
        gaps: []
      }],
      contractAmendments: [],
      gapWorkItems: [{
        title: 'Add a full real-process agenda E2E scenario',
        description: 'Verify all agenda groups, ordering, command output, and unchanged storage in one process-level scenario.',
        acceptanceCriteria: ['The complete agenda E2E scenario passes.'],
        inScope: ['Agenda process-level test'],
        outOfScope: ['New agenda behavior'],
        requirementIds: requirements.map((requirement) => requirement.id),
        deliverables: ['Real-process full-agenda E2E test'],
        changeRationale: 'Close the integrated release-evidence gap.',
        dependsOnStepTitles: [],
        validationFocus: ['implementation', 'regression']
      }]
    });

    expect(result.gapWorkItems[0]?.requirementIds).toHaveLength(4);
  });

  it('reports the exact invalid gap field and item title', () => {
    expect(() => normalizeReleaseAuditResult(releaseInput, {
      verdict: 'partial',
      summary: 'Build integration is missing.',
      criteria: [
        { criterion: releaseInput.contract.invariants[0]!, status: 'passed', evidence: ['src/api.ts'], gaps: [] },
        { criterion: releaseInput.contract.releaseCriteria[0]!, status: 'failed', evidence: [], gaps: ['Production build fails.'] }
      ],
      briefCoverage: [{
        obligation: 'Provide a production leaderboard backed by persisted rankings.',
        status: 'passed',
        workflowOnly: false,
        requirementIds: [input.requirement.id],
        evidence: ['src/api.ts'],
        gaps: []
      }],
      contractAmendments: [],
      gapWorkItems: [{
        title: 'Repair production build',
        description: 'Fix the production build integration.',
        acceptanceCriteria: ['The production build succeeds.'],
        inScope: ['Build configuration'],
        outOfScope: [],
        requirementIds: ['REQ-UNKNOWN'],
        deliverables: [],
        changeRationale: 'Restore the build.',
        dependsOnStepTitles: [],
        validationFocus: ['implementation']
      }]
    })).toThrow('Audit gap work item at position 1 ("Repair production build") is invalid: deliverables must contain 1-3 non-empty strings; requirementIds contains unknown IDs: REQ-UNKNOWN.');
  });

  it('accepts workflow-only brief coverage without a product requirement id', () => {
    const result = normalizeReleaseAuditResult(releaseInput, {
      verdict: 'satisfied',
      summary: 'Product and delivery workflow are complete.',
      criteria: [
        { criterion: releaseInput.contract.invariants[0]!, status: 'passed', evidence: ['src/api.ts'], gaps: [] },
        { criterion: releaseInput.contract.releaseCriteria[0]!, status: 'passed', evidence: ['npm run build'], gaps: [] }
      ],
      briefCoverage: [
        {
          obligation: 'Provide a production leaderboard backed by persisted rankings.',
          status: 'passed',
          workflowOnly: false,
          requirementIds: [input.requirement.id],
          evidence: ['src/api.ts reads persisted rankings.'],
          gaps: []
        },
        {
          obligation: 'Deliver the work in the planned sequence.',
          status: 'passed',
          workflowOnly: true,
          requirementIds: [],
          evidence: ['ForgeMind initial_roadmap steps completed in order.'],
          gaps: []
        }
      ],
      contractAmendments: [],
      gapWorkItems: []
    });

    expect(result.briefCoverage[1]).toMatchObject({ workflowOnly: true, requirementIds: [] });
  });

  it('accepts a traceable repair for a material brief obligation omitted from the contract', () => {
    const result = normalizeReleaseAuditResult(releaseInput, {
      verdict: 'partial',
      summary: 'The brief also requires CSV export, which the contract omitted.',
      criteria: [
        { criterion: releaseInput.contract.invariants[0]!, status: 'passed', evidence: ['src/api.ts'], gaps: [] },
        { criterion: releaseInput.contract.releaseCriteria[0]!, status: 'passed', evidence: ['npm run build'], gaps: [] }
      ],
      briefCoverage: [
        {
          obligation: 'Provide a production leaderboard backed by persisted rankings.',
          status: 'passed',
          workflowOnly: false,
          requirementIds: [input.requirement.id],
          evidence: ['src/api.ts and src/leaderboard.ts'],
          gaps: []
        },
        {
          obligation: 'Allow the leaderboard to be exported as CSV.',
          status: 'failed',
          workflowOnly: false,
          requirementIds: ['REQ-LEADERBOARD-EXPORT'],
          evidence: [],
          gaps: ['No export route or UI action exists.']
        }
      ],
      contractAmendments: [{
        id: 'REQ-LEADERBOARD-EXPORT',
        title: 'Leaderboard CSV export',
        description: 'Allow users to export persisted leaderboard results as CSV.',
        acceptanceCriteria: ['The current persisted leaderboard can be downloaded as CSV.'],
        briefReferences: ['export as CSV']
      }],
      gapWorkItems: [{
        title: 'Implement leaderboard CSV export',
        description: 'Add the missing export capability.',
        acceptanceCriteria: ['The current persisted leaderboard can be downloaded as CSV.'],
        inScope: ['Export route and UI action'],
        outOfScope: ['Other export formats'],
        requirementIds: ['REQ-LEADERBOARD-EXPORT'],
        deliverables: ['CSV export capability'],
        changeRationale: 'Implement the requirement discovered by the audit.',
        dependsOnStepTitles: [],
        validationFocus: ['implementation', 'regression']
      }]
    });

    expect(result.contractAmendments).toHaveLength(1);
    expect(result.gapWorkItems[0]?.requirementIds).toEqual(['REQ-LEADERBOARD-EXPORT']);
  });
});
