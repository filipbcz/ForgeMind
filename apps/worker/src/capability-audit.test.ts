import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectImplementationStep } from '@forgemind/core';
import { runCapabilityAudit, runReleaseAudit } from './capability-audit.js';

const project: Project = {
  id: 'project_1',
  name: 'Demo',
  slug: 'demo',
  defaultBranch: 'main',
  isActive: true,
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  projectContract: {
    version: 1,
    sourceBriefHash: 'brief-hash',
    summary: 'Demo',
    invariants: ['Use persisted data.'],
    prohibitedSubstitutes: ['Static fixtures.'],
    requirements: [{ id: 'REQ-DEMO', title: 'Demo', description: 'Demo works.', acceptanceCriteria: ['The integration test passes.'] }],
    releaseCriteria: ['Build passes.']
  }
};

const workItem: ProjectImplementationStep = {
  id: 'step_1',
  projectId: project.id,
  cycleId: 'cycle_1',
  sequenceNumber: 1,
  title: 'Build demo',
  description: 'Build it.',
  acceptanceCriteria: ['Work-item tests pass.'],
  requirementIds: ['REQ-DEMO'],
  deliverables: ['Demo implementation'],
  status: 'completed',
  taskId: 'task_1',
  createdAt: project.createdAt,
  updatedAt: project.updatedAt
};

describe('worker capability audit', () => {
  it('persists normalized repository audit evidence at the audited commit', async () => {
    const recordAcceptanceEvidence = vi.fn(async () => []);
    const repository = {
      getProjectRoadmap: vi.fn(async () => ({
        projectId: project.id,
        cycles: [{ id: 'cycle_1', projectId: project.id, cycleNumber: 1, objective: 'Demo', status: 'active' }],
        steps: [workItem],
        capabilities: [],
        evidence: [{
          id: 'evidence_1', projectId: project.id, cycleId: 'cycle_1', stepId: workItem.id, taskId: 'task_1', requirementId: 'REQ-DEMO',
          criterionKey: 'key', criterion: 'Work-item tests pass.', source: 'validation_command', status: 'passed', evidenceKey: 'command',
          contractVersion: 1, commitSha: 'abcdef1', command: 'npm test', exitCode: 0, payload: { stdout: 'passed' },
          createdAt: project.createdAt, updatedAt: project.updatedAt
        }]
      })),
      recordAcceptanceEvidence,
      writeAudit: vi.fn()
    };
    const provider = {
      auditCapability: vi.fn(async () => ({
        verdict: 'satisfied' as const,
        summary: 'Implemented.',
        criteria: [{ criterion: 'The integration test passes.', status: 'passed' as const, evidence: ['src/demo.ts'], gaps: [] }],
        gapWorkItems: []
      }))
    };

    const result = await runCapabilityAudit({
      repository: repository as never,
      provider: provider as never,
      project,
      cycleId: 'cycle_1',
      requirement: project.projectContract!.requirements[0]!,
      workItems: [workItem],
      workspacePath: 'C:/workspace',
      commitSha: 'abcdef1'
    });

    expect(result.verdict).toBe('satisfied');
    expect(recordAcceptanceEvidence).toHaveBeenCalledWith(expect.objectContaining({
      source: 'repository_audit',
      status: 'passed',
      evidenceIdentity: 'repository-audit:abcdef1',
      commitSha: 'abcdef1'
    }));
  });

  it('persists release evidence only after every capability is satisfied', async () => {
    const recordAcceptanceEvidence = vi.fn(async () => []);
    const repository = {
      getProjectRoadmap: vi.fn(async () => ({
        projectId: project.id,
        cycles: [{ id: 'cycle_1', projectId: project.id, cycleNumber: 1, objective: 'Demo', status: 'verifying' }],
        steps: [workItem],
        evidence: [],
        capabilities: [{
          requirement: project.projectContract!.requirements[0]!,
          status: 'satisfied',
          workItemIds: [workItem.id],
          evidence: [],
          satisfiedCriteria: 1,
          totalCriteria: 1
        }]
      })),
      recordAcceptanceEvidence,
      writeAudit: vi.fn()
    };
    const provider = {
      auditRelease: vi.fn(async () => ({
        verdict: 'satisfied' as const,
        summary: 'Release ready.',
        criteria: [
          { criterion: 'Use persisted data.', status: 'passed' as const, evidence: ['src/store.ts'], gaps: [] },
          { criterion: 'Build passes.', status: 'passed' as const, evidence: ['package.json build script'], gaps: [] }
        ],
        gapWorkItems: []
      }))
    };

    await expect(runReleaseAudit({
      repository: repository as never,
      provider: provider as never,
      project,
      cycleId: 'cycle_1',
      workspacePath: 'C:/workspace',
      commitSha: 'abcdef1'
    })).resolves.toMatchObject({ verdict: 'satisfied' });
    expect(recordAcceptanceEvidence).toHaveBeenCalledTimes(2);
    expect(recordAcceptanceEvidence).toHaveBeenCalledWith(expect.objectContaining({
      criterion: 'Release: Build passes.',
      requirementIds: ['REQ-DEMO'],
      evidenceIdentity: 'release-audit:abcdef1'
    }));
  });
});
