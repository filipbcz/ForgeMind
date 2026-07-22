import { simpleGit } from 'simple-git';
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
  draft?: boolean;
}

export interface CreateDraftPullRequestResult {
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface MergePullRequestResult {
  merged: boolean;
  sha?: string;
  message: string;
}

export interface GitHubAdapter {
  createIssue(input: CreateIssueInput): Promise<CreateIssueResult>;
  getRemoteUrl?(project: Project): string | undefined;
  createBranch(project: Project, branchName: string, fromBranch: string): Promise<void>;
  commitAndPush(project: Project, branchName: string, message: string, workspacePath?: string): Promise<void>;
  createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<CreateDraftPullRequestResult>;
  mergePullRequest?(project: Project, pullRequestNumber: number): Promise<MergePullRequestResult>;
  commentOnIssue(project: Project, issueNumber: number, body: string): Promise<void>;
  readCheckStatus(project: Project, ref: string): Promise<'pending' | 'success' | 'failure'>;
}

export interface GitHubAppAdapterOptions {
  token: string;
  apiBaseUrl?: string;
}

export interface GitHubConnectionCheckInput {
  token: string;
  apiBaseUrl?: string;
  owner?: string;
  repo?: string;
}

export interface GitHubConnectionCheckResult {
  ok: true;
  apiBaseUrl: string;
  credentialSource: 'token';
  repository?: GitHubRepositoryInfo;
  rateLimit?: {
    limit: number;
    remaining: number;
  };
}

export interface GitHubRepositoryInfo {
  fullName: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl?: string;
}

export interface GitHubBranchInfo {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GitHubRepositoryOwnerInfo {
  login: string;
  kind: 'user' | 'organization';
  avatarUrl?: string;
  description?: string;
}

export interface CreateGitHubRepositoryInput {
  token: string;
  apiBaseUrl?: string;
  owner?: string;
  repo: string;
  private?: boolean;
  description?: string;
}

export interface ListGitHubRepositoriesInput {
  token: string;
  apiBaseUrl?: string;
  limit?: number;
}

export interface ListGitHubRepositoryOwnersInput {
  token: string;
  apiBaseUrl?: string;
  limit?: number;
}

export interface ListGitHubBranchesInput {
  token: string;
  apiBaseUrl?: string;
  owner: string;
  repo: string;
  limit?: number;
}

export interface CreateGitHubBranchInput {
  token: string;
  apiBaseUrl?: string;
  owner: string;
  repo: string;
  branchName: string;
  fromBranch?: string;
}

export interface GitHubAdapterEnvStatus {
  adapter: 'none' | 'app';
  configured: boolean;
  credentialSource: 'token' | 'github_app' | 'none';
  apiBaseUrl: string;
  missing: string[];
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

interface GitHubMergePullResponse {
  sha: string | null;
  merged: boolean;
  message: string;
}

interface GitHubStatusResponse {
  state: 'error' | 'failure' | 'pending' | 'success';
}

interface GitHubRepositoryResponse {
  full_name: string;
  name?: string;
  default_branch: string;
  private: boolean;
  html_url?: string;
  owner?: {
    login?: string;
  };
}

interface GitHubUserResponse {
  login: string;
  avatar_url?: string;
}

interface GitHubRateLimitResponse {
  rate?: {
    limit?: number;
    remaining?: number;
  };
}

interface GitHubBranchResponse {
  name: string;
  protected: boolean;
  commit: {
    sha: string;
  };
}

interface GitHubOrganizationResponse {
  login: string;
  avatar_url?: string;
  description?: string | null;
}

export class GitHubAppAdapter implements GitHubAdapter {
  private readonly apiBaseUrl: string;
  private readonly options: GitHubAppAdapterOptions;

  constructor(options: GitHubAppAdapterOptions) {
    this.options = {
      ...options,
      token: normalizeGitHubToken(options.token)
    };
    this.apiBaseUrl = options.apiBaseUrl ?? process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';
  }

  async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const repository = requireProjectRepository(input.project);
    const issue = await this.request<GitHubIssueResponse>('POST', `/repos/${repository.owner}/${repository.repo}/issues`, {
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
    const repository = requireProjectRepository(project);
    const ref = await this.request<GitHubRefResponse>(
      'GET',
      `/repos/${repository.owner}/${repository.repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`
    );

    try {
      await this.request('POST', `/repos/${repository.owner}/${repository.repo}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Reference already exists')) {
        return;
      }
      throw error;
    }
  }

  getRemoteUrl(project: Project): string | undefined {
    const repository = getProjectRepository(project);
    if (!repository) {
      return undefined;
    }

    return process.env.FORGEMIND_GITHUB_REMOTE_URL
      ?? `https://x-access-token:${encodeURIComponent(this.options.token)}@github.com/${repository.owner}/${repository.repo}.git`;
  }

  async commitAndPush(project: Project, branchName: string, message: string, workspacePath?: string): Promise<void> {
    if (!workspacePath) return;

    const git = simpleGit({ baseDir: workspacePath });
    const remotes = await git.getRemotes(true) as Array<{ name: string }>;
    if (!remotes.some((remote) => remote.name === 'origin')) {
      const remoteUrl = this.getRemoteUrl(project);
      if (!remoteUrl) return;
      await git.addRemote('origin', remoteUrl);
    }

    await git.push(['-u', 'origin', branchName]);
  }

  async createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<CreateDraftPullRequestResult> {
    const repository = requireProjectRepository(input.project);
    const pull = await this.request<GitHubPullResponse>('POST', `/repos/${repository.owner}/${repository.repo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.task.branchName,
      base: input.project.defaultBranch,
      draft: input.draft ?? true
    });

    return {
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url
    };
  }

  async mergePullRequest(project: Project, pullRequestNumber: number): Promise<MergePullRequestResult> {
    const repository = requireProjectRepository(project);
    const result = await this.request<GitHubMergePullResponse>(
      'PUT',
      `/repos/${repository.owner}/${repository.repo}/pulls/${pullRequestNumber}/merge`,
      { merge_method: 'squash' }
    );

    return {
      merged: result.merged,
      sha: result.sha || undefined,
      message: result.message
    };
  }

  async commentOnIssue(project: Project, issueNumber: number, body: string): Promise<void> {
    const repository = requireProjectRepository(project);
    await this.request('POST', `/repos/${repository.owner}/${repository.repo}/issues/${issueNumber}/comments`, {
      body
    });
  }

  async readCheckStatus(project: Project, ref: string): Promise<'pending' | 'success' | 'failure'> {
    const repository = requireProjectRepository(project);
    const status = await this.request<GitHubStatusResponse>('GET', `/repos/${repository.owner}/${repository.repo}/commits/${ref}/status`);
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
  const apiBaseUrl = process.env.GITHUB_API_BASE_URL;
  if (process.env.GITHUB_TOKEN) {
    return new GitHubAppAdapter({ token: process.env.GITHUB_TOKEN, apiBaseUrl });
  }

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (!appId || !installationId || !privateKeyPath) {
    throw new Error('GitHub adapter is not configured. Provide GITHUB_TOKEN or GitHub App credentials.');
  }

  const privateKey = await readFile(privateKeyPath, 'utf8');
  const jwt = createGitHubAppJwt({ appId, privateKey });
  const token = await createInstallationToken({ jwt, installationId });
  return new GitHubAppAdapter({ token, apiBaseUrl });
}

export function getGitHubAdapterEnvStatus(): GitHubAdapterEnvStatus {
  const apiBaseUrl = process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';

  if (process.env.GITHUB_TOKEN) {
    return {
      adapter: 'app',
      configured: true,
      credentialSource: 'token',
      apiBaseUrl,
      missing: []
    };
  }

  const required = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_PATH'];
  const missing = required.filter((name) => !process.env[name]);
  return {
    adapter: missing.length === required.length ? 'none' : 'app',
    configured: missing.length === 0,
    credentialSource: missing.length === 0 ? 'github_app' : 'none',
    apiBaseUrl,
    missing
  };
}

export async function checkGitHubConnection(input: GitHubConnectionCheckInput): Promise<GitHubConnectionCheckResult> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const repository = normalizeGitHubRepositoryInput(input.owner, input.repo);
  const repositoryPath = repository ? `/repos/${repository.owner}/${repository.repo}` : '/rate_limit';
  const response = await fetch(`${apiBaseUrl}${repositoryPath}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ForgeMind-GitHubAppAdapter',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    const message = parseGitHubErrorMessage(text);
    const hint = getGitHubConnectionFailureHint(response.status, Boolean(repository));
    throw new Error(`GitHub connection check failed with ${response.status}: ${message}.${hint ? ` ${hint}` : ''}`);
  }

  const data = (await response.json()) as GitHubRepositoryResponse | GitHubRateLimitResponse;
  if ('full_name' in data) {
    return {
      ok: true,
      apiBaseUrl,
      credentialSource: 'token',
      repository: toGitHubRepositoryInfo(data)
    };
  }

  return {
    ok: true,
    apiBaseUrl,
    credentialSource: 'token',
    rateLimit: {
      limit: data.rate?.limit ?? 0,
      remaining: data.rate?.remaining ?? 0
    }
  };
}

export async function createGitHubRepository(input: CreateGitHubRepositoryInput): Promise<GitHubRepositoryInfo> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const repo = stripGitSuffix(input.repo.trim());
  if (!repo) {
    throw new Error('GitHub repository name is required.');
  }

  const user = await githubJsonRequest<GitHubUserResponse>({
    apiBaseUrl,
    token,
    method: 'GET',
    path: '/user'
  });
  const owner = input.owner?.trim();
  const createPath = owner && owner.toLowerCase() !== user.login.toLowerCase() ? `/orgs/${owner}/repos` : '/user/repos';
  const created = await githubJsonRequest<GitHubRepositoryResponse>({
    apiBaseUrl,
    token,
    method: 'POST',
    path: createPath,
    body: {
      name: repo,
      private: input.private ?? true,
      description: input.description?.trim() || undefined,
      auto_init: true
    }
  });

  return toGitHubRepositoryInfo(created);
}

export async function listGitHubRepositories(input: ListGitHubRepositoriesInput): Promise<GitHubRepositoryInfo[]> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const repositories: GitHubRepositoryInfo[] = [];

  for (let page = 1; repositories.length < limit; page += 1) {
    const pageRepositories = await githubJsonRequest<GitHubRepositoryResponse[]>({
      apiBaseUrl,
      token,
      method: 'GET',
      path: `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=${Math.min(100, limit - repositories.length)}&page=${page}`
    });

    repositories.push(...pageRepositories.map(toGitHubRepositoryInfo));
    if (pageRepositories.length === 0 || pageRepositories.length < 100) {
      break;
    }
  }

  return repositories;
}

export async function listGitHubRepositoryOwners(input: ListGitHubRepositoryOwnersInput): Promise<GitHubRepositoryOwnerInfo[]> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const user = await githubJsonRequest<GitHubUserResponse>({
    apiBaseUrl,
    token,
    method: 'GET',
    path: '/user'
  });
  const owners: GitHubRepositoryOwnerInfo[] = [
    {
      login: user.login,
      kind: 'user',
      avatarUrl: user.avatar_url
    }
  ];

  for (let page = 1; owners.length < limit; page += 1) {
    const perPage = Math.min(100, limit - owners.length);
    const organizations = await githubJsonRequest<GitHubOrganizationResponse[]>({
      apiBaseUrl,
      token,
      method: 'GET',
      path: `/user/orgs?per_page=${perPage}&page=${page}`
    });

    owners.push(...organizations.map(toGitHubRepositoryOwnerInfo));
    if (organizations.length === 0 || organizations.length < perPage) {
      break;
    }
  }

  return owners;
}

export async function listGitHubBranches(input: ListGitHubBranchesInput): Promise<GitHubBranchInfo[]> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const repository = normalizeGitHubRepositoryInput(input.owner, input.repo);
  if (!repository) {
    throw new Error('GitHub repository owner and name are required.');
  }

  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const branches: GitHubBranchInfo[] = [];

  for (let page = 1; branches.length < limit; page += 1) {
    const pageBranches = await githubJsonRequest<GitHubBranchResponse[]>({
      apiBaseUrl,
      token,
      method: 'GET',
      path: `/repos/${repository.owner}/${repository.repo}/branches?per_page=${Math.min(100, limit - branches.length)}&page=${page}`
    });

    branches.push(...pageBranches.map(toGitHubBranchInfo));
    if (pageBranches.length === 0 || pageBranches.length < 100) {
      break;
    }
  }

  return branches;
}

export async function createGitHubBranch(input: CreateGitHubBranchInput): Promise<GitHubBranchInfo> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const repository = normalizeGitHubRepositoryInput(input.owner, input.repo);
  if (!repository) {
    throw new Error('GitHub repository owner and name are required.');
  }

  const branchName = input.branchName.trim();
  if (!branchName) {
    throw new Error('GitHub branch name is required.');
  }

  const fromBranch = input.fromBranch?.trim();
  const sourceBranch = fromBranch || (await checkGitHubConnection({
    token,
    apiBaseUrl,
    owner: repository.owner,
    repo: repository.repo
  })).repository?.defaultBranch;

  if (!sourceBranch) {
    throw new Error('GitHub source branch is required.');
  }

  const ref = await githubJsonRequest<GitHubRefResponse>({
    apiBaseUrl,
    token,
    method: 'GET',
    path: `/repos/${repository.owner}/${repository.repo}/git/ref/heads/${encodeURIComponent(sourceBranch)}`
  });

  try {
    await githubJsonRequest({
      apiBaseUrl,
      token,
      method: 'POST',
      path: `/repos/${repository.owner}/${repository.repo}/git/refs`,
      body: {
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Reference already exists')) {
      return {
        name: branchName,
        sha: ref.object.sha,
        protected: false
      };
    }
    throw error;
  }

  return {
    name: branchName,
    sha: ref.object.sha,
    protected: false
  };
}

function normalizeApiBaseUrl(value?: string): string {
  return (value?.trim() || 'https://api.github.com').replace(/\/+$/, '');
}

export function normalizeGitHubToken(value: string): string {
  let token = value.replace(/[\r\n]/g, '').trim();
  let previous = '';

  while (token && token !== previous) {
    previous = token;
    token = stripSurroundingQuotes(token.trim());
    token = token.replace(/^authorization\s*:\s*/i, '').trim();
    token = token.replace(/^github_token\s*=\s*/i, '').trim();
    token = stripSurroundingQuotes(token);
    token = token.replace(/^(bearer|token)\s+/i, '').trim();
    token = stripSurroundingQuotes(token);
  }

  return token;
}

export function normalizeGitHubRepositoryInput(
  owner?: string,
  repo?: string
): { owner: string; repo: string } | undefined {
  const ownerValue = owner?.trim() ?? '';
  const repoValue = repo?.trim() ?? '';
  const combinedCandidate = repoValue.includes('/') || /^https?:\/\//i.test(repoValue) ? repoValue : ownerValue;

  const parsedCombined = parseRepositorySlug(combinedCandidate);
  if (parsedCombined) {
    return parsedCombined;
  }

  if (!ownerValue || !repoValue) {
    return undefined;
  }

  return {
    owner: ownerValue,
    repo: stripGitSuffix(repoValue)
  };
}

function parseRepositorySlug(value: string): { owner: string; repo: string } | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^\/+/, '');

  const [owner, repo] = normalized.split('/').filter(Boolean);
  if (!owner || !repo) {
    return undefined;
  }

  return {
    owner,
    repo: stripGitSuffix(repo)
  };
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, '');
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseGitHubErrorMessage(value: string): string {
  try {
    const parsed = JSON.parse(value) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    return value.trim();
  }

  return value.trim();
}

function getGitHubConnectionFailureHint(status: number, hasRepository: boolean): string {
  if (status === 401) {
    return 'Use a raw, unexpired GitHub token that has access to the selected repository.';
  }

  if (status === 404 && hasRepository) {
    return [
      'Check that the repository owner/name is exact and that the token has access to it.',
      'GitHub returns 404 for private repositories when the token is not authorized.',
      'Clear the test repo fields to validate the token only.'
    ].join(' ');
  }

  if (status === 404) {
    return 'Check the GitHub API base URL.';
  }

  return '';
}

async function githubJsonRequest<T>(input: {
  apiBaseUrl: string;
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`${input.apiBaseUrl}${input.path}`, {
    method: input.method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ForgeMind-GitHubAppAdapter',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${input.method} ${input.path} failed with ${response.status}: ${parseGitHubErrorMessage(text)}`);
  }

  return response.json() as Promise<T>;
}

function toGitHubRepositoryInfo(repository: GitHubRepositoryResponse): GitHubRepositoryInfo {
  const [ownerFromFullName, repoFromFullName] = repository.full_name.split('/');
  return {
    fullName: repository.full_name,
    owner: repository.owner?.login ?? ownerFromFullName ?? '',
    repo: repository.name ?? repoFromFullName ?? '',
    defaultBranch: repository.default_branch,
    private: repository.private,
    htmlUrl: repository.html_url
  };
}

function toGitHubBranchInfo(branch: GitHubBranchResponse): GitHubBranchInfo {
  return {
    name: branch.name,
    sha: branch.commit.sha,
    protected: branch.protected
  };
}

function toGitHubRepositoryOwnerInfo(organization: GitHubOrganizationResponse): GitHubRepositoryOwnerInfo {
  return {
    login: organization.login,
    kind: 'organization',
    avatarUrl: organization.avatar_url,
    description: organization.description ?? undefined
  };
}

function getProjectRepository(project: Project): { owner: string; repo: string } | undefined {
  const owner = project.githubOwner?.trim();
  const repo = project.githubRepo?.trim();
  if (!owner || !repo) {
    return undefined;
  }

  return { owner, repo };
}

function requireProjectRepository(project: Project): { owner: string; repo: string } {
  const repository = getProjectRepository(project);
  if (!repository) {
    throw new Error(`Project "${project.slug}" does not have a GitHub repository assigned.`);
  }

  return repository;
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
  const parsed = parseTaskPromptMetadata(task.prompt);
  const constraints = formatConstraints(parsed);
  const acceptanceCriteria =
    parsed.acceptanceCriteria.length > 0
      ? parsed.acceptanceCriteria.map((item) => `- ${item}`)
      : ['- Nebyla dodana explicitni akceptacni kriteria. Pouzit zadani v sekci Kontekst.'];

  return [
    '## Cíl',
    task.title,
    '',
    '## Kontext',
    parsed.context || task.prompt,
    '',
    '## Omezení',
    ...constraints,
    '',
    '## Akceptační kritéria',
    ...acceptanceCriteria,
    '',
    '## Režim',
    task.mode,
    '',
    '## Limity',
    `- max iterací: ${task.maxIterations}`,
    `- max rozpočet: ${task.maxBudgetUsd} USD`
  ].join('\n');
}

function parseTaskPromptMetadata(prompt: string): {
  context: string;
  priority?: string;
  runtimeSummary?: string;
  scopeFiles: string[];
  acceptanceCriteria: string[];
} {
  const lines = prompt.split(/\r?\n/);
  const priorityIndex = lines.findIndex((line) => /^Priority:\s*/i.test(line));
  const runtimeIndex = lines.findIndex((line) => /^Runtime Summary:\s*$/i.test(line.trim()));
  const scopeIndex = lines.findIndex((line) => /^Scope Files:\s*$/i.test(line.trim()));
  const acceptanceIndex = lines.findIndex((line) => /^Acceptance Criteria:\s*$/i.test(line.trim()));

  const markerIndexes = [priorityIndex, runtimeIndex, scopeIndex, acceptanceIndex].filter((index) => index >= 0);
  const firstMarkerIndex = markerIndexes.length > 0 ? Math.min(...markerIndexes) : -1;

  const context = lines
    .slice(0, firstMarkerIndex >= 0 ? firstMarkerIndex : lines.length)
    .join('\n')
    .trim();

  const priority = priorityIndex >= 0 ? (lines[priorityIndex] ?? '').replace(/^Priority:\s*/i, '').trim() : undefined;

  const runtimeSummary = collectSectionParagraph(lines, runtimeIndex, ['Scope Files:', 'Acceptance Criteria:']);
  const scopeFiles = collectSectionBullets(lines, scopeIndex, ['Acceptance Criteria:']);
  const acceptanceCriteria = collectSectionBullets(lines, acceptanceIndex, []);

  return {
    context,
    priority: priority || undefined,
    runtimeSummary: runtimeSummary || undefined,
    scopeFiles,
    acceptanceCriteria
  };
}

function formatConstraints(parsed: {
  priority?: string;
  runtimeSummary?: string;
  scopeFiles: string[];
}): string[] {
  const lines: string[] = [];

  if (parsed.priority) {
    lines.push(`- priorita: ${parsed.priority}`);
  }

  if (parsed.runtimeSummary) {
    lines.push(`- runtime summary: ${parsed.runtimeSummary}`);
  }

  if (parsed.scopeFiles.length > 0) {
    lines.push('- scope files:');
    for (const file of parsed.scopeFiles) {
      lines.push(`  - ${file}`);
    }
  }

  if (lines.length === 0) {
    return ['- Bez explicitnich omezeni v zadani.'];
  }

  return lines;
}

function collectSectionParagraph(lines: string[], headingIndex: number, nextHeadings: string[]): string {
  if (headingIndex < 0) {
    return '';
  }

  const collected: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    const trimmed = line.trim();
    if (nextHeadings.some((heading) => trimmed.toLowerCase() === heading.toLowerCase())) {
      break;
    }

    if (!trimmed) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    collected.push(trimmed);
  }

  return collected.join(' ');
}

function collectSectionBullets(lines: string[], headingIndex: number, nextHeadings: string[]): string[] {
  if (headingIndex < 0) {
    return [];
  }

  const collected: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    const trimmed = line.trim();
    if (nextHeadings.some((heading) => trimmed.toLowerCase() === heading.toLowerCase())) {
      break;
    }

    if (!trimmed) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    if (trimmed.startsWith('- ')) {
      collected.push(trimmed.slice(2).trim());
      continue;
    }

    // Backward-compatible fallback for non-bullet plain lines inside the section.
    collected.push(trimmed);
  }

  return collected;
}

export function renderPullRequestBody(input: {
  summary: string;
  acceptanceCriteria: string[];
  tests: string[];
  risks: string[];
  usage: string;
  executionNotes?: string[];
  validationReport?: string;
  resolvedReviewBlockers?: string[];
  automaticImprovements?: string[];
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
    ...(input.automaticImprovements?.length ? input.automaticImprovements.map((item) => `- ${item}`) : ['- Žádná automatická vylepšení nebyla aplikována.']),
    '',
    '## Co vyžaduje lidské review',
    '- Ověřit skutečný diff po napojení reálného providera.',
    '',
    '## Spotřeba',
    input.usage,
    '',
    '## Poslední validace',
    input.validationReport ?? '- Nezaznamenána.',
    '',
    '## Vyřešené review blokery',
    ...(input.resolvedReviewBlockers?.length ? input.resolvedReviewBlockers.map((item) => `- ${item}`) : ['- Žádné review blokery nebyly potřeba řešit.']),
    '',
    '## Průběh běhu',
    ...(input.executionNotes?.length ? input.executionNotes.map((item) => `- ${item}`) : ['- Proběhl jeden průchod bez retry.']),
    '',
    '## Rollback',
    '- Revert PR branche.'
  ].join('\n');
}
