import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@forgemind/core';
import { recordTaskAcceptanceEvidence } from './db-worker.js';
import type { WorkerTaskResult } from './workflow.js';

describe('worker acceptance evidence', () => {
  it('records worker validation and successful GitHub checks for linked requirements', async () => {
    const project: Project = {
      id: 'project_1',
      name: 'Demo',
      slug: 'demo',
      defaultBranch: 'main',
      isActive: true,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
      projectContract: {
        version: 2,
        sourceBriefHash: 'brief-hash',
        summary: 'Demo',
        invariants: ['Use production data.'],
        prohibitedSubstitutes: [],
        requirements: [
          { id: 'REQ-API', title: 'API', description: 'API works.', acceptanceCriteria: ['API audit passes.'] },
          { id: 'REQ-UI', title: 'UI', description: 'UI works.', acceptanceCriteria: ['UI audit passes.'] }
        ],
        releaseCriteria: ['Build passes.']
      }
    };
    const recordAcceptanceEvidence = vi.fn(async () => []);
    const repository = {
      getImplementationStepByTaskId: vi.fn(async () => ({
        id: 'step_1',
        projectId: project.id,
        cycleId: 'cycle_1',
        sequenceNumber: 1,
        title: 'Build feature',
        description: 'Build it.',
        acceptanceCriteria: ['Work item tests pass.'],
        requirementIds: ['REQ-API', 'REQ-UI'],
        deliverables: ['Feature'],
        status: 'running',
        taskId: 'task_1',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      })),
      recordAcceptanceEvidence,
      writeAudit: vi.fn()
    };
    const result: WorkerTaskResult = {
      taskId: 'task_1',
      status: 'ready_for_user_review',
      issueUrl: 'https://example.test/issues/1',
      branchName: 'ai/demo',
      workspacePath: 'C:/tmp/demo',
      validation: {
        command: 'npm test',
        exitCode: 0,
        stdout: 'passed',
        stderr: '',
        passed: true,
        checkResults: [{
          command: 'npm test',
          exitCode: 0,
          stdout: 'passed',
          stderr: '',
          passed: true,
          criterion: 'Work item tests pass.'
        }],
        deferredChecks: [{
          command: 'cmake --build --preset windows-release',
          criterion: 'Windows build passes.',
          rationale: 'Authoritative Windows compiler check.',
          requiredCapabilities: ['windows'],
          missingCapabilities: ['windows']
        }, {
          command: 'docker compose up --wait',
          criterion: 'Container stack starts.',
          rationale: 'Requires a Docker daemon.',
          requiredCapabilities: ['docker'],
          missingCapabilities: ['docker']
        }]
      },
      commitSha: 'abc123',
      githubChecks: { status: 'success', summary: 'All checks passed.', failures: [] },
      summary: 'Ready',
      approvals: [],
      completedAt: '2026-08-07T00:01:00.000Z'
    };

    await recordTaskAcceptanceEvidence(repository as never, { project, taskId: 'task_1', taskRunId: 'run_1', result });

    expect(recordAcceptanceEvidence).toHaveBeenCalledTimes(4);
    expect(recordAcceptanceEvidence).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requirementIds: ['REQ-API', 'REQ-UI'],
      source: 'validation_command',
      status: 'passed',
      contractVersion: 2,
      commitSha: 'abc123'
    }));
    expect(recordAcceptanceEvidence).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: 'validation_command',
      status: 'deferred',
      command: 'cmake --build --preset windows-release',
      payload: expect.objectContaining({ missingCapabilities: ['windows'] })
    }));
    expect(recordAcceptanceEvidence).toHaveBeenNthCalledWith(3, expect.objectContaining({
      source: 'validation_command',
      status: 'blocked',
      command: 'docker compose up --wait',
      payload: expect.objectContaining({ missingCapabilities: ['docker'] })
    }));
    expect(recordAcceptanceEvidence).toHaveBeenNthCalledWith(4, expect.objectContaining({
      source: 'github_check',
      status: 'passed',
      evidenceIdentity: 'github-checks:abc123'
    }));
  });
});
