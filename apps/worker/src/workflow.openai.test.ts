import { describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { runWorkerTask } from './workflow.js';
import type { ForgeTask, Project } from '@forgemind/core';

vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  let content = '{}';
  if (body.includes('Create a plan')) {
    content = JSON.stringify({ summary: 'Plan summary', steps: ['step1'], acceptanceCriteria: ['ac1'] });
  } else if (body.includes('Implement the following task') || body.includes('Implement the following')) {
    content = JSON.stringify({
      outcome: 'changes_made',
      summary: 'Impl summary',
      changedFiles: ['OPENAI_IMPLEMENTATION.md'],
      diffStat: { filesChanged: 1, insertions: 5, deletions: 0 },
      requestedApprovals: [],
      fileUpdates: [{ path: 'OPENAI_IMPLEMENTATION.md', content: '# OpenAI implementation\n' }]
    });
  } else if (body.includes('Review only the supplied ForgeMind review packet')) {
    content = JSON.stringify({ summary: 'Review summary', blockers: [], safeImprovements: [], riskyChanges: [] });
  }

  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  } as unknown as Response;
}) as unknown as typeof fetch);

const demoProject: Project = {
  id: `project_${randomUUID()}`,
  name: 'Demo Static Gallery',
  slug: 'demo-static-gallery',
  githubOwner: 'demo',
  githubRepo: 'demo-static-gallery',
  defaultBranch: 'main',
  autoCreatePullRequest: false,
  autoMergePullRequest: false,
  autoCompleteTask: false,
  configYaml: `project:
  id: demo-static-gallery
  name: Demo Static Gallery
  repo: github.com/demo/demo-static-gallery
workflow:
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
ai: {}
limits: {}
commands: {}
approval: {}
sandbox:
  allow_network: true
github: {}`,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const demoTask: ForgeTask = {
  id: `task_${randomUUID()}`,
  projectId: demoProject.id,
  createdByUserId: 'user_local_owner',
  title: 'OpenAI ForgeMind workflow',
  prompt: 'Simulate an OpenAI implementation and validate the worker lifecycle.',
  mode: 'safe',
  status: 'submitted',
  maxIterations: 10,
  maxBudgetUsd: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe('worker workflow with OpenAI provider', () => {
  it('runs the OpenAI provider workflow end-to-end', async () => {
    process.env.OPENAI_API_KEY = 'test-key';

    const workspaceRoot = join(tmpdir(), `forgemind-worker-openai-test-${randomUUID()}`);

    const result = await runWorkerTask({
      project: demoProject,
      task: demoTask,
      providerKind: 'openai',
      verifyCommand: 'node --version',
      workspaceRoot
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.issueUrl).toBe('');
    expect(result.pullRequestUrl).toBeUndefined();
    expect(result.validation.passed).toBe(true);
    expect(result.summary).toContain('Review');
    expect(result.workspacePath).toContain(workspaceRoot);
    await expect(access(join(workspaceRoot, demoTask.id, 'AGENTS.md'))).rejects.toThrow();
    await expect(access(join(workspaceRoot, demoTask.id, 'OPENAI_IMPLEMENTATION.md'))).resolves.toBeUndefined();
  }, 15000);
});
