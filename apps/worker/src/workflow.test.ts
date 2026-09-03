import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeTask, Project } from '@forgemind/core';
import type {
  AIProvider,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  PlanResult,
  ReviewInput,
  ReviewResult
} from '@forgemind/providers';
import { buildTaskExecutionPrompt, collectValidationWorkspacePatch, createDirectTaskPlan, runWorkerTask, selectReusableValidationResults, validationCheckFingerprint } from './workflow.js';

const projectConfig = `project:
  id: workflow-test
  name: Workflow Test
  repo: github.com/example/workflow-test
  default_branch: main
workflow:
  create_issue: false
  create_branch: false
  create_draft_pr: false
  auto_push: false
  auto_merge: false
ai: {}
limits: {}
github: {}
`;

const validationCommand = `node -e "const fs=require('node:fs');const value=fs.readFileSync('status.txt','utf8').trim();if(value!=='pass'){console.error('EXACT_VALIDATION_FAILURE');process.exit(7)}"`;
const workflowTestTimeoutMs = 15_000;

function createProject(): Project {
  const now = new Date().toISOString();
  return {
    id: `project_${randomUUID()}`,
    name: 'Workflow Test',
    slug: 'workflow-test',
    githubOwner: 'example',
    githubRepo: 'workflow-test',
    defaultBranch: 'main',
    configYaml: projectConfig,
    autoCreatePullRequest: false,
    autoMergePullRequest: false,
    autoCompleteTask: false,
    isActive: true,
    createdAt: now,
    updatedAt: now
  };
}

function createTask(projectId: string): ForgeTask {
  const now = new Date().toISOString();
  return {
    id: `task_${randomUUID()}`,
    projectId,
    createdByUserId: 'user_local_owner',
    title: 'Implement status contract',
    prompt: 'Create status.txt with the required value.',
    acceptanceCriteria: ['status.txt contains pass'],
    mode: 'safe',
    status: 'submitted',
    createdAt: now,
    updatedAt: now
  };
}

function implementation(content: string): ImplementResult {
  return {
    outcome: 'changes_made',
    summary: `Wrote ${content.trim()}`,
    changedFiles: ['status.txt'],
    diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
    fileUpdates: [{ path: 'status.txt', content }],
    validationChecks: [{
      kind: 'command',
      command: validationCommand,
      criterion: 'status.txt contains pass',
      rationale: 'Read the implemented artifact and fail with a specific exit code.'
    }]
  };
}

function review(verdict: ReviewResult['verdict'], blockers: string[] = []): ReviewResult {
  return {
    verdict,
    summary: verdict === 'satisfied' ? 'Implementation satisfies the task.' : 'Implementation is incomplete.',
    blockers,
    criterionResults: [{
      criterion: 'status.txt contains pass',
      status: verdict === 'satisfied' ? 'satisfied' : 'not_satisfied',
      evidence: ['status.txt']
    }]
  };
}

function createProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    kind: 'codex',
    async preflight() {
      return { provider: 'codex', ok: true, checkedAt: new Date().toISOString() };
    },
    async plan(): Promise<PlanResult> {
      throw new Error('Ordinary task execution must not call provider.plan().');
    },
    async implement(): Promise<ImplementResult> {
      return implementation('pass\n');
    },
    async review(): Promise<ReviewResult> {
      return review('satisfied');
    },
    async estimateCost(): Promise<CostEstimateResult> {
      return { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    },
    supportsLocalRepo() {
      return true;
    },
    supportsGitHubNativeFlow() {
      return false;
    },
    ...overrides
  } as AIProvider;
}

describe('simple autonomous worker workflow', () => {
  it('includes untracked names and contents in the workspace inputs shown to impact AI', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgemind-validation-inputs-'));
    const git = simpleGit(workspace);
    await git.init();
    await writeFile(join(workspace, 'relevant-input.txt'), 'must invalidate\n', 'utf8');

    const representation = await collectValidationWorkspacePatch(git, workspace);

    expect(representation).toContain('untracked validation inputs');
    expect(representation).toContain('relevant-input.txt');
    expect(representation).toContain(Buffer.from('must invalidate\n').toString('base64'));
  });
  it('asks AI with prior evidence and input changes, but invalidates changed check identity', async () => {
    const check = { kind: 'command' as const, command: 'npm test', shell: 'bash' as const };
    const provenance = {
      version: 1 as const,
      checkFingerprint: validationCheckFingerprint(check),
      workspaceInputHash: 'old',
      workspacePatch: 'diff --git a/independent.ts',
      decision: 'executed' as const,
      decisionRationale: 'Executed.',
      decidedAt: new Date().toISOString()
    };
    const prior = new Map([['old:bash:npm test', { command: 'npm test', shell: 'bash' as const, exitCode: 0, stdout: 'ok', stderr: '', passed: true, inputHash: 'old', provenance }]]);
    const assessValidationImpact = vi.fn(async () => ({ reusable: true, rationale: 'Only an unrelated documentation input changed.' }));
    const provider = createProvider({ assessValidationImpact });

    const reused = await selectReusableValidationResults(provider, [check], prior, 'new', 'diff --git a/docs/readme.md');
    expect(reused.get('new:bash:npm test')?.passed).toBe(true);
    expect(assessValidationImpact).toHaveBeenCalledWith(expect.objectContaining({
      check,
      previousResult: expect.objectContaining({ stdout: 'ok', provenance }),
      workspaceChange: expect.stringContaining('current validation inputs')
    }));

    const changedCommand = { ...check, command: 'npm run test:all' };
    const invalidated = await selectReusableValidationResults(provider, [changedCommand], prior, 'newer', 'diff');
    expect(invalidated.size).toBe(0);
    expect(assessValidationImpact).toHaveBeenCalledTimes(1);
  });
  it('passes the complete task prompt through and lets implementation supply all validation commands', async () => {
    const project = createProject();
    const task = createTask(project.id);
    const plan = vi.fn(async () => {
      throw new Error('plan must not run');
    });
    let reviewInput: ReviewInput | undefined;
    const provider = createProvider({
      plan,
      review: vi.fn(async (input) => {
        reviewInput = input;
        return review('satisfied');
      })
    });

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot: join(tmpdir(), `forgemind-simple-${randomUUID()}`)
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation).toMatchObject({ passed: true, exitCode: 0 });
    expect(result.validation.command).toContain(validationCommand);
    expect(plan).not.toHaveBeenCalled();
    expect(reviewInput).toMatchObject({
      taskId: task.id,
      acceptanceCriteria: ['status.txt contains pass'],
      repositoryPath: result.workspacePath
    });
    expect(reviewInput?.diff).toContain('status.txt');
    expect(reviewInput?.repositoryEvidence).toContain('--- status.txt ---');
    expect(reviewInput?.repositoryEvidence).toContain('pass');
    expect(reviewInput).not.toHaveProperty('validation');
  }, workflowTestTimeoutMs);

  it('returns the complete validation failure to AI and lets AI repair implementation or validation', async () => {
    const project = createProject();
    const task = createTask(project.id);
    const implementInputs: ImplementInput[] = [];
    const implement = vi.fn(async (input: ImplementInput) => {
      implementInputs.push(input);
      return implementation(implementInputs.length === 1 ? 'fail\n' : 'pass\n');
    });
    const provider = createProvider({ implement });

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot: join(tmpdir(), `forgemind-feedback-${randomUUID()}`)
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(implement).toHaveBeenCalledTimes(2);
    expect(implementInputs[1]?.previousValidationError).toContain(validationCommand);
    expect(implementInputs[1]?.previousValidationError).toContain('Exit code: 7');
    expect(implementInputs[1]?.previousValidationError).toContain('EXACT_VALIDATION_FAILURE');
  }, workflowTestTimeoutMs);

  it('returns concrete review blockers to implementation and validates the corrected state', async () => {
    const project = createProject();
    const task = createTask(project.id);
    const implementInputs: ImplementInput[] = [];
    const reviewInputs: ReviewInput[] = [];
    const validationAttempts: number[] = [];
    const provider = createProvider({
      implement: vi.fn(async (input) => {
        implementInputs.push(input);
        return implementation('pass\n');
      }),
      review: vi.fn(async (input) => {
        reviewInputs.push(input);
        return reviewInputs.length === 1
          ? review('not_satisfied', ['status.txt must end with a newline.'])
          : review('satisfied');
      })
    });

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot: join(tmpdir(), `forgemind-review-${randomUUID()}`),
      hooks: {
        onIterationStarted(iteration) {
          if (iteration.phase === 'validation') validationAttempts.push(iteration.attempt);
          return Promise.resolve();
        }
      }
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(implementInputs).toHaveLength(2);
    expect(implementInputs[1]?.previousReviewBlockers).toEqual(['status.txt must end with a newline.']);
    expect(reviewInputs).toHaveLength(2);
    expect(validationAttempts).toEqual([1, 2]);
  }, workflowTestTimeoutMs);

  it('lets AI explicitly skip executable validation when it is not applicable', async () => {
    const project = createProject();
    const task = createTask(project.id);
    const provider = createProvider({
      implement: vi.fn(async () => ({
        ...implementation('pass\n'),
        validationChecks: []
      }))
    });

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot: join(tmpdir(), `forgemind-no-validation-${randomUUID()}`)
    });

    expect(result.status).toBe('ready_for_user_review');
    expect(result.validation).toMatchObject({ passed: true, command: 'no-executable-checks' });
  }, workflowTestTimeoutMs);

  it('lets native review inspect the repository without sending a diff and marks Windows checks as deferred', async () => {
    const project = createProject();
    const task = createTask(project.id);
    let reviewInput: ReviewInput | undefined;
    const provider = createProvider({
      supportsNativeRepositoryReview: () => true,
      implement: vi.fn(async () => ({
        ...implementation('pass\n'),
        validationChecks: [{
          kind: 'command' as const,
          command: 'pwsh ./scripts/native-smoke.ps1',
          target: 'windows' as const,
          shell: 'powershell' as const,
          criterion: 'Native Windows smoke passes.'
        }]
      })),
      review: vi.fn(async (input) => {
        reviewInput = input;
        return review('satisfied');
      })
    });

    const result = await runWorkerTask({
      project,
      task,
      provider,
      workspaceRoot: join(tmpdir(), `forgemind-native-review-${randomUUID()}`)
    });

    expect(result.validation).toMatchObject({ passed: true, command: 'no-executable-checks' });
    expect(result.externalValidationChecks).toHaveLength(1);
    expect(reviewInput).toMatchObject({
      nativeRepositoryAccess: true,
      diff: '',
      localValidationCheckCount: 0,
      deferredValidationChecks: [{
        command: 'pwsh ./scripts/native-smoke.ps1',
        criterion: 'Native Windows smoke passes.'
      }]
    });
    expect(reviewInput?.repositoryEvidence).toBeUndefined();
  }, workflowTestTimeoutMs);

  it('builds a direct task plan from structured acceptance criteria', () => {
    expect(createDirectTaskPlan('Task', ['first', 'second'])).toEqual({
      summary: 'Implement task: Task',
      steps: ['Implement the complete supplied task scope.'],
      acceptanceCriteria: ['first', 'second']
    });
  });

  it('passes the task assignment to the provider without extra project context', () => {
    expect(buildTaskExecutionPrompt('  Implement the current step.  ')).toBe('Implement the current step.');
  });
});
