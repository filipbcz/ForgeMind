import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider } from './codex-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type { CapabilityAuditInput, ReleaseAuditInput } from './provider.js';

const input: CapabilityAuditInput = {
  projectId: 'project_1',
  contractVersion: 1,
  contractSummary: 'Demo',
  invariants: ['Use persisted data.'],
  prohibitedSubstitutes: ['Static fixtures.'],
  requirement: {
    id: 'REQ-DEMO',
    title: 'Demo capability',
    description: 'Provide the capability.',
    acceptanceCriteria: ['The capability integration test passes.']
  },
  completedWorkItems: [],
  evidence: [],
  repositoryPath: '/workspace',
  repositoryContext: 'src/demo.ts implements the capability and tests/demo.test.ts verifies it.'
};

const auditResponse = {
  verdict: 'satisfied',
  summary: 'Implemented.',
  criteria: [{
    criterion: 'The capability integration test passes.',
    status: 'passed',
    evidence: ['src/demo.ts and tests/demo.test.ts'],
    gaps: []
  }],
  gapWorkItems: []
};

const invalidPartialAuditResponse = {
  verdict: 'partial',
  summary: 'A focused implementation gap remains.',
  criteria: [{
    criterion: 'The capability integration test passes.',
    status: 'failed',
    evidence: [],
    gaps: ['The integration path is incomplete.']
  }],
  gapWorkItems: [{
    title: 'Complete demo integration',
    description: 'Implement the missing integration path.',
    acceptanceCriteria: ['The capability integration test passes.'],
    inScope: ['Demo integration'],
    outOfScope: ['Unrelated features'],
    requirementIds: ['REQ-UNKNOWN'],
    deliverables: ['Working demo integration'],
    changeRationale: 'Close the audited gap.',
    dependsOnStepTitles: [],
    validationFocus: ['implementation', 'regression']
  }]
};

const repairedPartialAuditResponse = {
  ...invalidPartialAuditResponse,
  gapWorkItems: [{
    ...invalidPartialAuditResponse.gapWorkItems[0],
    requirementIds: ['REQ-DEMO']
  }]
};

const releaseInput: ReleaseAuditInput = {
  projectId: input.projectId,
  contract: {
    version: 1,
    sourceBriefSnapshot: 'Provide a persisted demo capability.',
    summary: 'Demo',
    invariants: ['Use persisted data.'],
    prohibitedSubstitutes: ['Static fixtures.'],
    requirements: [input.requirement],
    releaseCriteria: ['The production build passes.']
  },
  originalBrief: 'Provide a persisted demo capability.',
  satisfiedCapabilities: [{ requirementId: 'REQ-DEMO', title: 'Demo capability', satisfiedCriteria: 1, totalCriteria: 1 }],
  repositoryPath: input.repositoryPath,
  repositoryContext: input.repositoryContext,
  commitSha: 'abcdef1'
};

const releaseResponse = {
  verdict: 'satisfied',
  summary: 'Release ready.',
  criteria: [
    { criterion: 'Use persisted data.', status: 'passed', evidence: ['src/demo.ts'], gaps: [] },
    { criterion: 'The production build passes.', status: 'passed', evidence: ['package.json'], gaps: [] }
  ],
  briefCoverage: [{
    obligation: 'Provide a persisted demo capability.',
    status: 'passed',
    workflowOnly: false,
    requirementIds: ['REQ-DEMO'],
    evidence: ['src/demo.ts and tests/demo.test.ts'],
    gaps: []
  }],
  contractAmendments: [],
  gapWorkItems: []
};

describe('capability audit providers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the OpenAI audit only with a targeted repository packet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(auditResponse) } }] })
    })) as unknown as typeof fetch);
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await expect(provider.auditCapability(input)).resolves.toMatchObject({ verdict: 'satisfied' });
    await expect(provider.auditCapability({ ...input, repositoryContext: undefined })).rejects.toThrow('targeted repository packet');
  });

  it('runs the Codex API audit with strict result normalization', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(auditResponse) })
    })) as unknown as typeof fetch);
    const provider = new CodexProvider({ apiKey: 'sk-test', authMode: 'api_key' });

    await expect(provider.auditCapability(input)).resolves.toMatchObject({ verdict: 'satisfied' });
  });

  it('runs Codex OAuth audits with read-only access to the complete repository', async () => {
    const provider = new CodexProvider({ authMode: 'codex_oauth', codexHome: '/codex-home' });
    const runCodexExec = vi.spyOn(provider as unknown as {
      runCodexExec: (input: Record<string, unknown>) => Promise<string>;
    }, 'runCodexExec').mockResolvedValue(JSON.stringify(auditResponse));

    await expect(provider.auditCapability(input)).resolves.toMatchObject({ verdict: 'satisfied' });
    expect(runCodexExec).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: 'read-only',
      repositoryPath: '/workspace',
      prompt: expect.stringContaining('checked-out repository is the authoritative inspection surface')
    }));
    expect(runCodexExec.mock.calls[0]?.[0]?.prompt).not.toContain(input.repositoryContext!);
  });

  it('asks Codex to repair invalid audit JSON once without repeating repository inspection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output_text: JSON.stringify(invalidPartialAuditResponse) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ output_text: JSON.stringify(repairedPartialAuditResponse) }) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const provider = new CodexProvider({ apiKey: 'sk-test', authMode: 'api_key' });

    await expect(provider.auditCapability(input)).resolves.toMatchObject({
      verdict: 'partial',
      gapWorkItems: [{ requirementIds: ['REQ-DEMO'] }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetchMock.mock.calls[1])).toContain('Do not inspect the repository, run commands, or repeat the audit.');
    expect(JSON.stringify(fetchMock.mock.calls[1])).toContain('requirementIds contains unknown IDs: REQ-UNKNOWN');
  });

  it('asks OpenAI to repair invalid audit JSON once without repeating repository inspection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(invalidPartialAuditResponse) } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(repairedPartialAuditResponse) } }] }) });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await expect(provider.auditCapability(input)).resolves.toMatchObject({
      verdict: 'partial',
      gapWorkItems: [{ requirementIds: ['REQ-DEMO'] }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetchMock.mock.calls[1])).toContain('Do not inspect the repository, run commands, or repeat the audit.');
  });

  it('runs the OpenAI brief-to-release audit with independent brief coverage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(releaseResponse) } }] })
    })) as unknown as typeof fetch);
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await expect(provider.auditRelease(releaseInput)).resolves.toMatchObject({
      verdict: 'satisfied',
      briefCoverage: [{ requirementIds: ['REQ-DEMO'] }]
    });
  });

  it('runs the Codex API brief-to-release audit with strict result normalization', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(releaseResponse) })
    })) as unknown as typeof fetch);
    const provider = new CodexProvider({ apiKey: 'sk-test', authMode: 'api_key' });

    await expect(provider.auditRelease(releaseInput)).resolves.toMatchObject({
      verdict: 'satisfied',
      contractAmendments: []
    });
  });
});
