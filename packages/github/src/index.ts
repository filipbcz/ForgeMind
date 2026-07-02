import type { ForgeTask, Project } from '@forgemind/core';

export interface CreateIssueInput {
  project: Project;
  task: ForgeTask;
  labels: string[];
}

export interface CreateIssueResult {
  issueNumber: number;
  issueUrl: string;
}

export interface CreateDraftPullRequestInput {
  project: Project;
  task: ForgeTask;
  title: string;
  body: string;
}

export interface CreateDraftPullRequestResult {
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface GitHubAdapter {
  createIssue(input: CreateIssueInput): Promise<CreateIssueResult>;
  createBranch(project: Project, branchName: string, fromBranch: string): Promise<void>;
  commitAndPush(project: Project, branchName: string, message: string): Promise<void>;
  createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<CreateDraftPullRequestResult>;
  commentOnIssue(project: Project, issueNumber: number, body: string): Promise<void>;
  readCheckStatus(project: Project, ref: string): Promise<'pending' | 'success' | 'failure'>;
}

export function slugifyBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function createAiBranchName(issueNumber: number, title: string, prefix = 'ai/'): string {
  const slug = slugifyBranchSegment(title) || 'task';
  return `${prefix}${issueNumber}-${slug}`;
}

export function renderIssueBody(task: ForgeTask): string {
  return [
    '## Cil',
    task.title,
    '',
    '## Kontext',
    task.prompt,
    '',
    '## Rezim',
    task.mode,
    '',
    '## Limity',
    `- max iteraci: ${task.maxIterations}`,
    `- max rozpocet: ${task.maxBudgetUsd} USD`
  ].join('\n');
}

export function renderPullRequestBody(input: {
  summary: string;
  acceptanceCriteria: string[];
  tests: string[];
  risks: string[];
  usage: string;
}): string {
  return [
    '## Shrnutí změn',
    input.summary,
    '',
    '## Splněná akceptační kritéria',
    ...input.acceptanceCriteria.map((item) => `- ${item}`),
    '',
    '## Testy',
    ...input.tests.map((item) => `- ${item}`),
    '',
    '## Rizika',
    ...input.risks.map((item) => `- ${item}`),
    '',
    '## Co agent automaticky vylepšil',
    '- Zatím pouze MockProvider simulace.',
    '',
    '## Co vyžaduje lidské review',
    '- Ověřit skutečný diff po napojení reálného providera.',
    '',
    '## Spotřeba',
    input.usage,
    '',
    '## Rollback',
    '- Revert PR branche.'
  ].join('\n');
}

export class MockGitHubAdapter implements GitHubAdapter {
  async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const issueNumber = Math.floor(Math.random() * 9000) + 1000;
    return {
      issueNumber,
      issueUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/issues/${issueNumber}`
    };
  }

  async createBranch(): Promise<void> {
    return undefined;
  }

  async commitAndPush(): Promise<void> {
    return undefined;
  }

  async createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<CreateDraftPullRequestResult> {
    const pullRequestNumber = Math.floor(Math.random() * 9000) + 1000;
    return {
      pullRequestNumber,
      pullRequestUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}/pull/${pullRequestNumber}`
    };
  }

  async commentOnIssue(): Promise<void> {
    return undefined;
  }

  async readCheckStatus(): Promise<'pending' | 'success' | 'failure'> {
    return 'success';
  }
}

