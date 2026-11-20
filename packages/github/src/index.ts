import { simpleGit } from 'simple-git';
import { createSign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ForgeTask, Project } from '@forgemind/core';

export const REPOSITORY_BASELINE_EVIDENCE_MAX_CHARS = 220_000;
const REPOSITORY_BASELINE_INVENTORY_MAX_CHARS = 60_000;
const REPOSITORY_BASELINE_FILE_MAX_CHARS = 6_000;

const embeddedTextExtensions = new Set([
  '', '.c', '.cc', '.cmake', '.cpp', '.cs', '.css', '.csv', '.h', '.hpp', '.html', '.ini', '.java', '.js',
  '.json', '.jsx', '.md', '.mjs', '.ps1', '.py', '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt',
  '.uplugin', '.uproject', '.xml', '.yaml', '.yml'
]);
const excludedBasenames = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'
]);

function evidencePathPriority(path: string): number {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.split('/').at(-1) ?? normalized;
  if (basename.startsWith('readme') || basename.startsWith('architecture') || basename.startsWith('specification')) return 0;
  if (['package.json', 'cmakelists.txt', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml'].includes(basename)
    || normalized.endsWith('.uproject') || normalized.endsWith('.uplugin')) return 1;
  if (/(^|\/)(src|source|apps|packages|tools|config|data_pipeline|core_sim)(\/|$)/.test(normalized)) return 2;
  if (/(^|\/)(test|tests|spec|specs)(\/|$)|\.(test|spec)\./.test(normalized)) return 3;
  if (/(^|\/)docs?(\/|$)/.test(normalized)) return 4;
  return 5;
}

function shouldEmbedRepositoryFile(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/');
  const basename = parts.at(-1) ?? normalized;
  if (excludedBasenames.has(basename)) return false;
  if (parts.some((part) => ['node_modules', 'intermediate', 'binaries', 'saved', 'deriveddatacache',
    '__pycache__', 'vendor', 'third_party', '.forgemind-outputs'].includes(part))) return false;
  if (/(^|\/)(reports?|screenshots?|artifacts?|coverage)(\/|$)/.test(normalized)) return false;
  if (/(^|\/)(\.env|credentials?|secrets?)(\.|\/|$)/.test(normalized)
    || /\.(pem|p12|pfx|key)$/.test(normalized)) return false;
  const extensionIndex = basename.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? basename.slice(extensionIndex) : '';
  return embeddedTextExtensions.has(extension);
}

function boundedInventory(paths: string[]): string {
  const heading = `Tracked path inventory (${paths.length} files):\n`;
  const selected: string[] = [];
  let length = heading.length;
  for (const path of fairlyOrderedEvidencePaths(paths)) {
    if (length + path.length + 1 > REPOSITORY_BASELINE_INVENTORY_MAX_CHARS) break;
    selected.push(path);
    length += path.length + 1;
  }
  const omitted = paths.length - selected.length;
  return `${heading}${selected.join('\n')}${omitted > 0 ? `\n[${omitted} additional tracked paths omitted from the prompt inventory]` : ''}`;
}

function boundedFileExcerpt(content: string): string {
  if (content.length <= REPOSITORY_BASELINE_FILE_MAX_CHARS) return content;
  const headLength = Math.ceil(REPOSITORY_BASELINE_FILE_MAX_CHARS * 0.7);
  const tailLength = REPOSITORY_BASELINE_FILE_MAX_CHARS - headLength;
  return `${content.slice(0, headLength)}\n[... file excerpt truncated ...]\n${content.slice(-tailLength)}`;
}

function fairlyOrderedEvidencePaths(paths: string[]): string[] {
  const result: string[] = [];
  const priorities = new Map<number, Map<string, string[]>>();
  for (const path of paths) {
    const priority = evidencePathPriority(path);
    const root = path.replaceAll('\\', '/').split('/')[0]?.toLowerCase() ?? '';
    const roots = priorities.get(priority) ?? new Map<string, string[]>();
    const queue = roots.get(root) ?? [];
    queue.push(path);
    roots.set(root, queue);
    priorities.set(priority, roots);
  }
  for (const priority of [...priorities.keys()].sort((left, right) => left - right)) {
    const roots = priorities.get(priority)!;
    const rootNames = [...roots.keys()].sort();
    for (const queue of roots.values()) queue.sort();
    for (;;) {
      let added = false;
      for (const root of rootNames) {
        const path = roots.get(root)?.shift();
        if (!path) continue;
        result.push(path);
        added = true;
      }
      if (!added) break;
    }
  }
  return result;
}

/** A deterministic, commit-bound prompt view. The checkout itself remains complete for native tools. */
export async function buildBoundedRepositoryEvidence(
  repositoryPath: string,
  commitSha: string,
  paths: string[],
  maxChars = REPOSITORY_BASELINE_EVIDENCE_MAX_CHARS
): Promise<string> {
  const normalizedPaths = [...paths].sort();
  const sections = [
    `Commit-bound repository evidence at ${commitSha}. The read-only checkout contains ${normalizedPaths.length} tracked files.`,
    boundedInventory(normalizedPaths)
  ];
  let currentLength = sections.join('\n\n').length;
  let embedded = 0;
  let eligible = 0;
  const prioritized = fairlyOrderedEvidencePaths(normalizedPaths.filter(shouldEmbedRepositoryFile));

  for (const path of prioritized) {
    const content = await readFile(join(repositoryPath, path));
    if (content.includes(0)) continue;
    eligible += 1;
    const excerpt = boundedFileExcerpt(content.toString('utf8'));
    const section = `--- ${path} (${content.length} bytes, sha256=${createHash('sha256').update(content).digest('hex')}) ---\n${excerpt}`;
    if (currentLength + section.length + 2 > maxChars) continue;
    sections.push(section);
    currentLength += section.length + 2;
    embedded += 1;
  }

  const footer = `Prompt evidence embedded ${embedded} of ${eligible} eligible text files. Omitted files remain bound by commit ${commitSha} and are available in the complete read-only checkout to native providers.`;
  if (currentLength + footer.length + 2 <= maxChars) sections.push(footer);
  return sections.join('\n\n').slice(0, maxChars);
}

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

export interface PullRequestState {
  merged: boolean;
  state: string;
  mergeCommitSha?: string;
}

export interface GitHubCheckFailure {
  name: string;
  detailsUrl?: string;
  output: string;
}

export interface GitHubChecksResult {
  status: 'success' | 'failure' | 'not_configured' | 'timeout';
  summary: string;
  failures: GitHubCheckFailure[];
}

export interface WaitForGitHubChecksOptions {
  timeoutMs?: number;
  discoveryTimeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (message: string) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface GitHubAdapter {
  createIssue(input: CreateIssueInput, signal?: AbortSignal): Promise<CreateIssueResult>;
  getRemoteUrl?(project: Project): string | undefined;
  createBranch(project: Project, branchName: string, fromBranch: string, signal?: AbortSignal): Promise<void>;
  commitAndPush(project: Project, branchName: string, message: string, workspacePath?: string, signal?: AbortSignal): Promise<void>;
  createDraftPullRequest(input: CreateDraftPullRequestInput, signal?: AbortSignal): Promise<CreateDraftPullRequestResult>;
  mergePullRequest?(project: Project, pullRequestNumber: number, signal?: AbortSignal): Promise<MergePullRequestResult>;
  getPullRequestState?(project: Project, pullRequestNumber: number): Promise<PullRequestState>;
  commentOnIssue(project: Project, issueNumber: number, body: string, signal?: AbortSignal): Promise<void>;
  readCheckStatus(project: Project, ref: string): Promise<'pending' | 'success' | 'failure'>;
  waitForChecks?(project: Project, ref: string, options?: WaitForGitHubChecksOptions): Promise<GitHubChecksResult>;
}

/** Immutable, read-only checkout used by planning and audits. */
export async function prepareReadOnlyRepositoryBaseline(
  adapter: GitHubAdapter,
  project: Project,
  signal?: AbortSignal
): Promise<{ repositoryPath: string; commitSha: string; evidence: string; cleanup: () => Promise<void> }> {
  const remoteUrl = adapter.getRemoteUrl?.(project);
  if (!remoteUrl) throw new Error('GitHub remote URL is required for repository baseline discovery.');
  signal?.throwIfAborted();
  const repositoryPath = await mkdtemp(join(tmpdir(), 'forgemind-roadmap-baseline-'));
  try {
    await simpleGit().clone(remoteUrl, repositoryPath, ['--branch', project.defaultBranch, '--single-branch', '--depth', '1']);
    signal?.throwIfAborted();
    const git = simpleGit({ baseDir: repositoryPath });
    const commitSha = (await git.revparse(['HEAD'])).trim();
    const paths = (await git.raw(['ls-files', '-z'])).split('\0').filter(Boolean).sort();
    const evidence = await buildBoundedRepositoryEvidence(repositoryPath, commitSha, paths);
    return { repositoryPath, commitSha, evidence, cleanup: () => rm(repositoryPath, { recursive: true, force: true }) };
  } catch (error) {
    await rm(repositoryPath, { recursive: true, force: true });
    throw error;
  }
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

export interface DeleteGitHubRepositoryInput {
  token: string;
  apiBaseUrl?: string;
  owner: string;
  repo: string;
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
  merged?: boolean;
  merge_commit_sha?: string | null;
  state?: string;
}

interface GitHubMergePullResponse {
  sha: string | null;
  merged: boolean;
  message: string;
}

interface GitHubStatusResponse {
  state: 'error' | 'failure' | 'pending' | 'success';
}

interface GitHubCheckRunsResponse {
  check_runs: GitHubCheckRunResponse[];
}

interface GitHubCheckRunResponse {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: string | null;
  details_url?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  };
}

interface GitHubCheckAnnotationResponse {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  title?: string | null;
  message: string;
  raw_details?: string | null;
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

  async createIssue(input: CreateIssueInput, signal?: AbortSignal): Promise<CreateIssueResult> {
    const repository = requireProjectRepository(input.project);
    const issue = await this.requestWithSignal<GitHubIssueResponse>('POST', `/repos/${repository.owner}/${repository.repo}/issues`, {
      title: `[AI] ${input.task.title}`,
      body: renderIssueBody(input.task),
      labels: input.labels
    }, signal);

    return {
      issueNumber: issue.number,
      issueUrl: issue.html_url
    };
  }

  async createBranch(project: Project, branchName: string, fromBranch: string, signal?: AbortSignal): Promise<void> {
    const repository = requireProjectRepository(project);
    const ref = await this.requestWithSignal<GitHubRefResponse>(
      'GET',
      `/repos/${repository.owner}/${repository.repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
      undefined,
      signal
    );

    try {
      await this.requestWithSignal('POST', `/repos/${repository.owner}/${repository.repo}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha
      }, signal);
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

  async commitAndPush(project: Project, branchName: string, message: string, workspacePath?: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!workspacePath) return;

    const git = simpleGit({ baseDir: workspacePath });
    const remotes = await git.getRemotes(true) as Array<{ name: string }>;
    if (!remotes.some((remote) => remote.name === 'origin')) {
      const remoteUrl = this.getRemoteUrl(project);
      if (!remoteUrl) return;
      await git.addRemote('origin', remoteUrl);
    }

    await git.push(['-u', 'origin', branchName]);
    throwIfAborted(signal);
  }

  async createDraftPullRequest(input: CreateDraftPullRequestInput, signal?: AbortSignal): Promise<CreateDraftPullRequestResult> {
    const repository = requireProjectRepository(input.project);
    const branchName = input.task.branchName;
    if (!branchName) throw new Error('A task branch is required before creating a pull request.');
    const existing = await this.requestWithSignal<GitHubPullResponse[]>(
      'GET',
      `/repos/${repository.owner}/${repository.repo}/pulls?state=open&head=${encodeURIComponent(`${repository.owner}:${branchName}`)}&base=${encodeURIComponent(input.project.defaultBranch)}`,
      undefined,
      signal
    );
    if (existing[0]) {
      return {
        pullRequestNumber: existing[0].number,
        pullRequestUrl: existing[0].html_url
      };
    }
    const pull = await this.requestWithSignal<GitHubPullResponse>('POST', `/repos/${repository.owner}/${repository.repo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.task.branchName,
      base: input.project.defaultBranch,
      draft: input.draft ?? true
    }, signal);

    return {
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url
    };
  }

  async mergePullRequest(project: Project, pullRequestNumber: number, signal?: AbortSignal): Promise<MergePullRequestResult> {
    const repository = requireProjectRepository(project);
    const existing = await this.requestWithSignal<GitHubPullResponse>('GET', `/repos/${repository.owner}/${repository.repo}/pulls/${pullRequestNumber}`, undefined, signal);
    if (existing.merged) {
      return {
        merged: true,
        sha: existing.merge_commit_sha || undefined,
        message: 'Pull request was already merged.'
      };
    }
    const result = await this.requestWithSignal<GitHubMergePullResponse>(
      'PUT',
      `/repos/${repository.owner}/${repository.repo}/pulls/${pullRequestNumber}/merge`,
      { merge_method: 'squash' },
      signal
    );

    return {
      merged: result.merged,
      sha: result.sha || undefined,
      message: result.message
    };
  }

  async getPullRequestState(project: Project, pullRequestNumber: number): Promise<PullRequestState> {
    const repository = requireProjectRepository(project);
    const pull = await this.request<GitHubPullResponse>('GET', `/repos/${repository.owner}/${repository.repo}/pulls/${pullRequestNumber}`);
    return {
      merged: pull.merged === true,
      state: pull.state ?? 'unknown',
      mergeCommitSha: pull.merge_commit_sha || undefined
    };
  }

  async commentOnIssue(project: Project, issueNumber: number, body: string, signal?: AbortSignal): Promise<void> {
    const repository = requireProjectRepository(project);
    await this.requestWithSignal('POST', `/repos/${repository.owner}/${repository.repo}/issues/${issueNumber}/comments`, {
      body
    }, signal);
  }

  async readCheckStatus(project: Project, ref: string): Promise<'pending' | 'success' | 'failure'> {
    const repository = requireProjectRepository(project);
    const status = await this.request<GitHubStatusResponse>('GET', `/repos/${repository.owner}/${repository.repo}/commits/${ref}/status`);
    if (status.state === 'success') return 'success';
    if (status.state === 'pending') return 'pending';
    return 'failure';
  }

  async waitForChecks(project: Project, ref: string, options: WaitForGitHubChecksOptions = {}): Promise<GitHubChecksResult> {
    const repository = requireProjectRepository(project);
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? readPositiveIntegerEnv('FORGEMIND_GITHUB_CHECKS_TIMEOUT_MS', 30 * 60_000);
    const discoveryTimeoutMs = Math.min(
      timeoutMs,
      options.discoveryTimeoutMs ?? readPositiveIntegerEnv('FORGEMIND_GITHUB_CHECKS_DISCOVERY_TIMEOUT_MS', 30_000)
    );
    const pollIntervalMs = options.pollIntervalMs ?? readPositiveIntegerEnv('FORGEMIND_GITHUB_CHECKS_POLL_INTERVAL_MS', 10_000);
    let lastProgress = '';

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(options.signal);
      const checksPath = `/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(ref)}/check-runs?filter=latest&per_page=100`;
      const checks = await this.requestWithSignal<GitHubCheckRunsResponse>('GET', checksPath, undefined, options.signal);
      const runs = checks.check_runs ?? [];

      if (runs.length === 0) {
        if (Date.now() - startedAt >= discoveryTimeoutMs) {
          return { status: 'not_configured', summary: 'No GitHub checks were discovered for the pushed commit.', failures: [] };
        }
        lastProgress = await reportCheckProgress(options, lastProgress, 'Waiting for GitHub checks to start.');
        await delay(pollIntervalMs, options.signal);
        continue;
      }

      const pending = runs.filter((run) => run.status !== 'completed');
      if (pending.length > 0) {
        lastProgress = await reportCheckProgress(
          options,
          lastProgress,
          `GitHub checks are running (${runs.length - pending.length}/${runs.length} completed).`
        );
        await delay(pollIntervalMs, options.signal);
        continue;
      }

      const failedRuns = runs.filter((run) => !isSuccessfulCheckConclusion(run.conclusion));
      if (failedRuns.length === 0) {
        return { status: 'success', summary: `${runs.length} GitHub check(s) passed.`, failures: [] };
      }

      const failures = await Promise.all(failedRuns.map((run) => this.describeCheckFailure(repository, run, options.signal)));
      return {
        status: 'failure',
        summary: compactCheckOutput(failures.map((failure) => `${failure.name}: ${failure.output}`).join('\n\n')),
        failures
      };
    }

    return {
      status: 'timeout',
      summary: `GitHub checks did not finish within ${Math.ceil(timeoutMs / 60_000)} minute(s).`,
      failures: []
    };
  }

  private async describeCheckFailure(
    repository: { owner: string; repo: string },
    run: GitHubCheckRunResponse,
    signal?: AbortSignal
  ): Promise<GitHubCheckFailure> {
    const fallback = compactCheckOutput([
      run.output?.title,
      run.output?.summary,
      run.output?.text,
      run.conclusion ? `Conclusion: ${run.conclusion}` : undefined
    ].filter((value): value is string => Boolean(value)).join('\n'));
    const jobId = parseActionsJobId(run.details_url);
    let output = fallback;

    if (jobId) {
      try {
        output = compactCheckOutput(await this.requestText('GET', `/repos/${repository.owner}/${repository.repo}/actions/jobs/${jobId}/logs`, signal)) || fallback;
      } catch {
        const annotations = await this.readCheckAnnotations(repository, run.id, signal);
        output = compactCheckOutput([fallback, annotations].filter(Boolean).join('\n'));
      }
    }

    return {
      name: run.name,
      detailsUrl: run.details_url ?? undefined,
      output: output || `GitHub check concluded with ${run.conclusion ?? 'an unknown failure'}.`
    };
  }

  private async readCheckAnnotations(
    repository: { owner: string; repo: string },
    checkRunId: number,
    signal?: AbortSignal
  ): Promise<string> {
    try {
      const annotations = await this.requestWithSignal<GitHubCheckAnnotationResponse[]>(
        'GET',
        `/repos/${repository.owner}/${repository.repo}/check-runs/${checkRunId}/annotations?per_page=100`,
        undefined,
        signal
      );
      return annotations.map((annotation) => {
        const line = annotation.start_line === annotation.end_line
          ? `${annotation.start_line}`
          : `${annotation.start_line}-${annotation.end_line}`;
        return [
          `${annotation.path}:${line}: ${annotation.annotation_level}`,
          annotation.title,
          annotation.message,
          annotation.raw_details
        ].filter((value): value is string => Boolean(value)).join('\n');
      }).join('\n\n');
    } catch {
      return '';
    }
  }

  private async requestText(method: string, path: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.options.token}`,
        'User-Agent': 'ForgeMind-GitHubAppAdapter',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${await response.text()}`);
    return response.text();
  }

  private requestWithSignal<T = unknown>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    if (signal) return this.request<T>(method, path, body, signal);
    if (body === undefined) return this.request<T>(method, path);
    return this.request<T>(method, path, body);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      signal,
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('GitHub operation was cancelled.');
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isSuccessfulCheckConclusion(conclusion: string | null): boolean {
  return conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped';
}

function parseActionsJobId(detailsUrl?: string | null): number | undefined {
  const match = detailsUrl?.match(/\/job\/(\d+)(?:[/?#]|$)/);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function compactCheckOutput(value: string, maxChars = 64_000): string {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (normalized.length <= maxChars) return normalized;
  const headLength = Math.floor(maxChars * 0.4);
  const tailLength = maxChars - headLength;
  return `${normalized.slice(0, headLength)}\n[... GitHub check output truncated ...]\n${normalized.slice(-tailLength)}`;
}

async function reportCheckProgress(
  options: WaitForGitHubChecksOptions,
  previous: string,
  message: string
): Promise<string> {
  if (message !== previous) await options.onProgress?.(message);
  return message;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveDelay();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason instanceof Error ? signal.reason : new Error('GitHub operation was cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
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

export async function deleteGitHubRepository(input: DeleteGitHubRepositoryInput): Promise<void> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const token = normalizeGitHubToken(input.token);
  if (!token) {
    throw new Error('GitHub token is empty after removing common prefixes. Paste the raw token value.');
  }

  const repository = normalizeGitHubRepositoryInput(input.owner, input.repo);
  if (!repository) {
    throw new Error('GitHub repository owner and name are required.');
  }

  await githubRequest({
    apiBaseUrl,
    token,
    method: 'DELETE',
    path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
  });
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
  const response = await githubRequest(input);
  return response.json() as Promise<T>;
}

async function githubRequest(input: {
  apiBaseUrl: string;
  token: string;
  method: string;
  path: string;
  body?: unknown;
}): Promise<Response> {
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

  return response;
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
  return [
    '## Cíl',
    task.title,
    '',
    '## Zadání',
    task.prompt.trim(),
    ...(task.acceptanceCriteria.length > 0
      ? ['', '## Akceptační kritéria', ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`)]
      : []),
    '',
    '## Režim',
    task.mode
  ].join('\n');
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
