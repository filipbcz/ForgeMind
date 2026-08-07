import { describe, expect, it } from 'vitest';
import type { AcceptanceEvidence, Project, ProjectImplementationStep, ProjectRoadmapCycle } from '@forgemind/core';
import { acceptanceCriterionKey, deriveProjectCapabilities, shouldInvalidateProjectContract } from './repository.js';

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
    summary: 'Demo project',
    invariants: ['Use production data.'],
    prohibitedSubstitutes: ['Pass-valued fixture.'],
    requirements: [{
      id: 'REQ-API',
      title: 'Working API',
      description: 'Expose the production API.',
      acceptanceCriteria: ['The production API integration test passes.']
    }],
    releaseCriteria: ['Build passes.']
  }
};

const cycle: ProjectRoadmapCycle = {
  id: 'cycle_1',
  projectId: project.id,
  cycleNumber: 1,
  objective: 'Build demo',
  status: 'active',
  createdAt: project.createdAt,
  updatedAt: project.updatedAt
};

const step: ProjectImplementationStep = {
  id: 'step_1',
  projectId: project.id,
  cycleId: cycle.id,
  sequenceNumber: 1,
  title: 'Build API',
  description: 'Build the API.',
  acceptanceCriteria: ['Work item tests pass.'],
  requirementIds: ['REQ-API'],
  deliverables: ['API implementation'],
  status: 'completed',
  taskId: 'task_1',
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  completedAt: project.updatedAt
};

function evidence(source: AcceptanceEvidence['source'], status: AcceptanceEvidence['status'], criterion: string): AcceptanceEvidence {
  return {
    id: `${source}_${status}`,
    projectId: project.id,
    cycleId: cycle.id,
    stepId: step.id,
    taskId: step.taskId,
    requirementId: 'REQ-API',
    criterionKey: acceptanceCriterionKey(criterion),
    criterion,
    source,
    status,
    evidenceKey: `${source}-key`,
    contractVersion: 1,
    payload: {},
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

describe('project capability evidence', () => {
  it('invalidates a generated contract only when the normalized brief changes', () => {
    expect(shouldInvalidateProjectContract('Original brief\r\n', 'Original brief\n')).toBe(false);
    expect(shouldInvalidateProjectContract('Original brief', 'Changed brief')).toBe(true);
    expect(shouldInvalidateProjectContract('Original brief', undefined)).toBe(false);
  });

  it('keeps a completed work item in verifying until an independent audit passes', () => {
    const validationEvidence = evidence('validation_command', 'passed', 'Work item tests pass.');
    const [beforeAudit] = deriveProjectCapabilities(project, [cycle], [step], [validationEvidence]);
    const auditEvidence = evidence('repository_audit', 'passed', 'The production API integration test passes.');
    const [afterAudit] = deriveProjectCapabilities(project, [cycle], [step], [validationEvidence, auditEvidence]);

    expect(beforeAudit?.status).toBe('verifying');
    expect(beforeAudit?.satisfiedCriteria).toBe(0);
    expect(afterAudit?.status).toBe('satisfied');
    expect(afterAudit?.satisfiedCriteria).toBe(1);
  });

  it('maps a failed repository audit to partial capability state', () => {
    const auditEvidence = evidence('repository_audit', 'failed', 'The production API integration test passes.');
    const [capability] = deriveProjectCapabilities(project, [cycle], [step], [auditEvidence]);

    expect(capability?.status).toBe('partial');
  });
});
