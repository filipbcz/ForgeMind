import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexProvider } from './codex-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type { CapabilityAuditInput } from './provider.js';

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
});
