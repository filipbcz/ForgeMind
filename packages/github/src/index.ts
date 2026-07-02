import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

export interface GitHubAppAdapterOptions {
  token: string;
  apiBaseUrl?: string;
}

interface GitHubRefResponse {
  object: {
    sha: string;
  };
}

interface GitHubIssueResponse {
  number: number;
  html_url: string;
}

interface GitHubPullResponse {
  number: number;
  html_url: string;
}

interface GitHubStatusResponse {
  state: 'error' | 'failure' | 'pending' | 'success';
}

export class GitHubAppAdapter implements GitHubAdapter {
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GitHubAppAdapterOptions) {
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  }

  async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const issue = await this.request<GitHubIssueResponse>('POST', `/repos/${input.project.githubOwner}/${input.project.githubRepo}/issues`, {
      title: `[AI] ${input.task.title}`,
      body: renderIssueBody(input.task),
      labels: input.labels
    });

    return {
      issueNumber: issue.number,
      issueUrl: issue.html_url
    };
  }

  async createBranch(project: Project, branchName: string, fromBranch: string): Promise<void> {
    const encodedBase = encodeURIComponent(`heads/${fromBranch}`);
    const ref = await this.request<GitHubRefResponse>('GET', `/repos/${project.githubOwner}/${project.githubRepo}/git/ref/${encodedBase}`);
    await this.request('POST', `/repos/${project.githubOwner}/${project.githubRepo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha
    });
  }

  async commitAndPush(): Promise<void> {
    // The GitHub App adapter owns GitHub API calls. Local git commit/push belongs to
    // the future workspace transport because it needs a concrete worktree and diff.
    return undefined;
  }

  async createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<CreateDraftPullRequestResult> {
    const pull = await this.request<GitHubPullResponse>('POST', `/repos/${input.project.githubOwner}/${input.project.githubRepo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.task.branchName,
      base: input.project.defaultBranch,
      draft: true
    });

    return {
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url
    };
  }

  async commentOnIssue(project: Project, issueNumber: number, body: string): Promise<void> {
    await this.request('POST', `/repos/${project.githubOwner}/${project.githubRepo}/issues/${issueNumber}/comments`, {
      body
    });
  }

  async readCheckStatus(project: Project, ref: string): Promise<'pending' | 'success' | 'failure'> {
    const status = await this.request<GitHubStatusResponse>('GET', `/repos/${project.githubOwner}/${project.githubRepo}/commits/${ref}/status`);
    if (status.state === 'success') return 'success';
    if (status.state === 'pending') return 'pending';
    return 'failure';
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ForgeMind-GitHubAppAdapter',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

export async function createGitHubAdapterFromEnv(): Promise<GitHubAdapter> {
  if (process.env.FORGEMIND_GITHUB_ADAPTER !== 'app') {
    return new MockGitHubAdapter();
  }

  if (process.env.GITHUB_TOKEN) {
    return new GitHubAppAdapter({ token: process.env.GITHUB_TOKEN });
  }

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (!appId || !installationId || !privateKeyPath) {
    throw new Error('GitHub App adapter requires GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY_PATH.');
  }

  const privateKey = await readFile(privateKeyPath, 'utf8');
  const jwt = createGitHubAppJwt({ appId, privateKey });
  const token = await createInstallationToken({ jwt, installationId });
  return new GitHubAppAdapter({ token });
}

function createGitHubAppJwt(input: { appId: string; privateKey: string }): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: input.appId
    })
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(input.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

async function createInstallationToken(input: { jwt: string; installationId: string }): Promise<string> {
  const response = await fetch(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.jwt}`,
      'User-Agent': 'ForgeMind-GitHubAppAdapter',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub App installation token request failed with ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

function base64Url(value: string | Buffer): string {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  return buffer.toString('base64url');
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
