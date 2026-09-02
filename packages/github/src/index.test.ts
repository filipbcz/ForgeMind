import { describe, expect, it, vi } from 'vitest';
import {
  GitHubAppAdapter,
  checkGitHubConnection,
  createAiBranchName,
  createGitHubBranch,
  createGitHubRepository,
  deleteGitHubRepository,
  getGitHubAdapterEnvStatus,
  listGitHubBranches,
  listGitHubRepositoryOwners,
  listGitHubRepositories,
  normalizeGitHubToken,
  normalizeGitHubRepositoryInput,
  renderIssueBody,
  renderPullRequestBody
} from './index.js';

const projectFixture = {
  id: 'project1',
  name: 'Demo',
  slug: 'demo',
  githubOwner: 'demo',
  githubRepo: 'demo-repo',
  defaultBranch: 'main',
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

const taskFixture = {
  id: 'task_1',
  projectId: 'project1',
  createdByUserId: 'user_1',
  title: 'Implement feature X',
  prompt: 'Add feature X with tests.',
  mode: 'safe' as const,
  status: 'draft' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function restoreEnv(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = previous;
}

describe('GitHub helpers', () => {
  it('creates stable AI branch names', () => {
    expect(createAiBranchName(123, 'Přidat galerii fotek podle dne')).toBe('ai/123-pridat-galerii-fotek-podle-dne');
  });

  it('returns a remote URL from GitHub App adapter token', () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const remote = adapter.getRemoteUrl(projectFixture);

    expect(remote).toBe('https://x-access-token:test-token@github.com/demo/demo-repo.git');
  });

  it('reports GitHub adapter env status for token mode', () => {
    const previousAdapter = process.env.FORGEMIND_GITHUB_ADAPTER;
    const previousToken = process.env.GITHUB_TOKEN;
    const previousApiBaseUrl = process.env.GITHUB_API_BASE_URL;

    process.env.FORGEMIND_GITHUB_ADAPTER = 'app';
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GITHUB_API_BASE_URL;

    expect(getGitHubAdapterEnvStatus()).toEqual({
      adapter: 'app',
      configured: true,
      credentialSource: 'token',
      apiBaseUrl: 'https://api.github.com',
      missing: []
    });

    restoreEnv('FORGEMIND_GITHUB_ADAPTER', previousAdapter);
    restoreEnv('GITHUB_TOKEN', previousToken);
    restoreEnv('GITHUB_API_BASE_URL', previousApiBaseUrl);
  });

  it('normalizes pasted GitHub token formats', () => {
    expect(normalizeGitHubToken('Bearer github_pat_123')).toBe('github_pat_123');
    expect(normalizeGitHubToken('Authorization: Bearer github_pat_123')).toBe('github_pat_123');
    expect(normalizeGitHubToken('GITHUB_TOKEN="github_pat_123"')).toBe('github_pat_123');
    expect(normalizeGitHubToken(" token 'github_pat_123'\r\n")).toBe('github_pat_123');
  });

  it('normalizes GitHub App adapter tokens before using remotes and API requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({})
    } as Response);
    const adapter = new GitHubAppAdapter({ token: 'Authorization: Bearer "test-token"' });

    expect(adapter.getRemoteUrl(projectFixture)).toBe('https://x-access-token:test-token@github.com/demo/demo-repo.git');
    await adapter.commentOnIssue(projectFixture, 123, 'Looks good.');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/demo/demo-repo/issues/123/comments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );

    fetchSpy.mockRestore();
  });

  it('checks GitHub token access against a repository', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        full_name: 'demo/demo-repo',
        default_branch: 'main',
        private: true
      })
    } as Response);

    const result = await checkGitHubConnection({
      token: 'Bearer test-token',
      owner: 'demo',
      repo: 'demo-repo'
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/demo/demo-repo',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(result.repository).toMatchObject({
      fullName: 'demo/demo-repo',
      owner: 'demo',
      repo: 'demo-repo',
      defaultBranch: 'main',
      private: true
    });

    fetchSpy.mockRestore();
  });

  it('normalizes GitHub repository input from owner/repo and URLs', () => {
    expect(normalizeGitHubRepositoryInput('demo', 'demo-repo')).toEqual({
      owner: 'demo',
      repo: 'demo-repo'
    });
    expect(normalizeGitHubRepositoryInput(undefined, 'demo/demo-repo')).toEqual({
      owner: 'demo',
      repo: 'demo-repo'
    });
    expect(normalizeGitHubRepositoryInput(undefined, 'https://github.com/demo/demo-repo.git')).toEqual({
      owner: 'demo',
      repo: 'demo-repo'
    });
  });

  it('creates a repository for the authenticated GitHub user', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'demo' })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          full_name: 'demo/new-repo',
          name: 'new-repo',
          default_branch: 'main',
          private: true,
          html_url: 'https://github.com/demo/new-repo',
          owner: { login: 'demo' }
        })
      } as Response);

    const result = await createGitHubRepository({
      token: 'Bearer test-token',
      owner: 'demo',
      repo: 'new-repo',
      private: true,
      description: 'Demo repo'
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/repos',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'new-repo',
          private: true,
          description: 'Demo repo',
          auto_init: true
        })
      })
    );
    expect(result).toEqual({
      fullName: 'demo/new-repo',
      owner: 'demo',
      repo: 'new-repo',
      defaultBranch: 'main',
      private: true,
      htmlUrl: 'https://github.com/demo/new-repo'
    });

    fetchSpy.mockRestore();
  });

  it('deletes a repository and accepts GitHub 204 response without a JSON body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 204
    } as Response);

    await expect(deleteGitHubRepository({
      token: 'Bearer test-token',
      owner: 'demo',
      repo: 'obsolete-repo'
    })).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/demo/obsolete-repo',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );

    fetchSpy.mockRestore();
  });

  it('lists repositories available to the authenticated GitHub token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          full_name: 'demo/repo-one',
          name: 'repo-one',
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/demo/repo-one',
          owner: { login: 'demo' }
        }
      ]
    } as Response);

    const repositories = await listGitHubRepositories({
      token: 'Bearer test-token',
      limit: 20
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=20&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(repositories).toEqual([
      {
        fullName: 'demo/repo-one',
        owner: 'demo',
        repo: 'repo-one',
        defaultBranch: 'main',
        private: false,
        htmlUrl: 'https://github.com/demo/repo-one'
      }
    ]);

    fetchSpy.mockRestore();
  });

  it('lists repository owners available to the authenticated GitHub token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          login: 'demo',
          avatar_url: 'https://avatars.githubusercontent.com/u/1'
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            login: 'demo-org',
            avatar_url: 'https://avatars.githubusercontent.com/u/2',
            description: 'Demo org'
          }
        ]
      } as Response);

    const owners = await listGitHubRepositoryOwners({
      token: 'Bearer test-token',
      limit: 20
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/orgs?per_page=19&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(owners).toEqual([
      {
        login: 'demo',
        kind: 'user',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1'
      },
      {
        login: 'demo-org',
        kind: 'organization',
        avatarUrl: 'https://avatars.githubusercontent.com/u/2',
        description: 'Demo org'
      }
    ]);

    fetchSpy.mockRestore();
  });

  it('lists branches for a selected repository', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          name: 'main',
          protected: true,
          commit: { sha: 'main-sha' }
        },
        {
          name: 'feature/demo',
          protected: false,
          commit: { sha: 'feature-sha' }
        }
      ]
    } as Response);

    const branches = await listGitHubBranches({
      token: 'Bearer test-token',
      owner: 'demo',
      repo: 'repo-one',
      limit: 20
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/repos/demo/repo-one/branches?per_page=20&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(branches).toEqual([
      { name: 'main', sha: 'main-sha', protected: true },
      { name: 'feature/demo', sha: 'feature-sha', protected: false }
    ]);

    fetchSpy.mockRestore();
  });

  it('creates a branch from a source branch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ object: { sha: 'source-sha' } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      } as Response);

    const branch = await createGitHubBranch({
      token: 'Bearer test-token',
      owner: 'demo',
      repo: 'repo-one',
      branchName: 'ai/demo',
      fromBranch: 'main'
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/demo/repo-one/git/ref/heads/main',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        })
      })
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/demo/repo-one/git/refs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ref: 'refs/heads/ai/demo',
          sha: 'source-sha'
        })
      })
    );
    expect(branch).toEqual({ name: 'ai/demo', sha: 'source-sha', protected: false });

    fetchSpy.mockRestore();
  });

  it('surfaces GitHub connection check failures without exposing token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Bad credentials', status: '401' })
    } as Response);

    await expect(checkGitHubConnection({ token: 'secret-token' })).rejects.toThrow(
      'GitHub connection check failed with 401: Bad credentials. Use a raw, unexpired GitHub token that has access to the selected repository.'
    );

    fetchSpy.mockRestore();
  });

  it('explains repository 404 failures as missing repo access or wrong owner/name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: 'Not Found', status: '404' })
    } as Response);

    await expect(
      checkGitHubConnection({
        token: 'secret-token',
        owner: 'demo',
        repo: 'private-repo'
      })
    ).rejects.toThrow(
      'GitHub connection check failed with 404: Not Found. Check that the repository owner/name is exact and that the token has access to it. GitHub returns 404 for private repositories when the token is not authorized. Clear the test repo fields to validate the token only.'
    );

    fetchSpy.mockRestore();
  });

  it('builds a create issue request and maps response fields', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');

    requestSpy.mockResolvedValueOnce({
      number: 123,
      html_url: 'https://github.com/demo/demo-repo/issues/123'
    });

    const result = await adapter.createIssue({
      project: projectFixture,
      task: taskFixture,
      labels: ['ai', 'feature']
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'POST',
      '/repos/demo/demo-repo/issues',
      expect.objectContaining({
        title: '[AI] Implement feature X',
        labels: ['ai', 'feature']
      })
    );
    expect(result).toEqual({
      issueNumber: 123,
      issueUrl: 'https://github.com/demo/demo-repo/issues/123'
    });

    requestSpy.mockRestore();
  });

  it('creates a ready pull request and merges it with squash when requested', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');
    requestSpy.mockResolvedValueOnce([]);
    requestSpy.mockResolvedValueOnce({
      number: 42,
      html_url: 'https://github.com/demo/demo-repo/pull/42'
    });
    requestSpy.mockResolvedValueOnce({ number: 42, html_url: 'https://github.com/demo/demo-repo/pull/42', merged: false });
    requestSpy.mockResolvedValueOnce({
      sha: 'merge-sha',
      merged: true,
      message: 'Pull Request successfully merged'
    });

    const pullRequest = await adapter.createDraftPullRequest({
      project: projectFixture,
      task: { ...taskFixture, branchName: 'ai/42-feature-x' },
      title: '[AI] Feature X',
      body: 'Ready to merge.',
      draft: false
    });
    const merge = await adapter.mergePullRequest(projectFixture, pullRequest.pullRequestNumber);

    expect(requestSpy).toHaveBeenNthCalledWith(2, 'POST', '/repos/demo/demo-repo/pulls', expect.objectContaining({ draft: false }));
    expect(requestSpy).toHaveBeenNthCalledWith(4, 'PUT', '/repos/demo/demo-repo/pulls/42/merge', { merge_method: 'squash' });
    expect(merge).toEqual({ merged: true, sha: 'merge-sha', message: 'Pull Request successfully merged' });

    requestSpy.mockRestore();
  });

  it('builds a create branch request path correctly', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');

    requestSpy.mockResolvedValueOnce({ object: { sha: 'base-sha' } });
    requestSpy.mockResolvedValueOnce({});

    await adapter.createBranch(projectFixture, 'ai/123-demo', 'main');

    expect(requestSpy).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/repos/demo/demo-repo/git/ref/heads/main'
    );
    expect(requestSpy).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/repos/demo/demo-repo/git/refs',
      {
        ref: 'refs/heads/ai/123-demo',
        sha: 'base-sha'
      }
    );

    requestSpy.mockRestore();
  });

  it('ignores an existing branch error when creating a branch', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');

    requestSpy.mockResolvedValueOnce({ object: { sha: 'base-sha' } });
    requestSpy.mockRejectedValueOnce(new Error('GitHub API POST /repos/demo/demo-repo/git/refs failed with 422: Reference already exists'));

    await expect(
      adapter.createBranch(projectFixture, 'ai/123-demo', 'main')
    ).resolves.toBeUndefined();

    requestSpy.mockRestore();
  });

  it('rethrows non-existing-branch errors from createBranch', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');

    requestSpy.mockResolvedValueOnce({ object: { sha: 'base-sha' } });
    requestSpy.mockRejectedValueOnce(new Error('GitHub API POST /repos/demo/demo-repo/git/refs failed with 403: Forbidden'));

    await expect(adapter.createBranch(projectFixture, 'ai/123-demo', 'main')).rejects.toThrow('403: Forbidden');

    requestSpy.mockRestore();
  });

  it('builds a draft pull request request and maps response fields', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');

    requestSpy.mockResolvedValueOnce([]);
    requestSpy.mockResolvedValueOnce({
      number: 456,
      html_url: 'https://github.com/demo/demo-repo/pull/456'
    });

    const result = await adapter.createDraftPullRequest({
      project: projectFixture,
      task: {
        ...taskFixture,
        branchName: 'ai/123-demo'
      },
      title: '[AI] Implement feature X',
      body: 'PR body'
    });

    expect(requestSpy).toHaveBeenCalledWith('POST', '/repos/demo/demo-repo/pulls', {
      title: '[AI] Implement feature X',
      body: 'PR body',
      head: 'ai/123-demo',
      base: 'main',
      draft: true
    });
    expect(result).toEqual({
      pullRequestNumber: 456,
      pullRequestUrl: 'https://github.com/demo/demo-repo/pull/456'
    });

    requestSpy.mockRestore();
  });

  it('reuses an existing pull request for the task branch', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');
    requestSpy.mockResolvedValueOnce([{ number: 456, html_url: 'https://github.com/demo/demo-repo/pull/456' }]);

    const result = await adapter.createDraftPullRequest({
      project: projectFixture,
      task: { ...taskFixture, branchName: 'ai/123-demo' },
      title: '[AI] Implement feature X',
      body: 'PR body'
    });

    expect(result.pullRequestNumber).toBe(456);
    expect(requestSpy).toHaveBeenCalledOnce();
    expect(requestSpy).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    requestSpy.mockRestore();
  });

  it('treats an already merged pull request as a successful idempotent merge', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');
    requestSpy.mockResolvedValueOnce({
      number: 42,
      html_url: 'https://github.com/demo/demo-repo/pull/42',
      merged: true,
      merge_commit_sha: 'existing-merge-sha'
    });

    await expect(adapter.mergePullRequest(projectFixture, 42)).resolves.toEqual({
      merged: true,
      sha: 'existing-merge-sha',
      message: 'Pull request was already merged.'
    });
    expect(requestSpy).toHaveBeenCalledOnce();
    requestSpy.mockRestore();
  });

  it('maps commit status states to pending/success/failure', async () => {
    const adapter = new GitHubAppAdapter({ token: 'test-token' });
    const requestSpy = vi.spyOn(adapter as any, 'request');

    requestSpy.mockResolvedValueOnce({ state: 'pending' });
    await expect(adapter.readCheckStatus(projectFixture, 'abc123')).resolves.toBe('pending');

    requestSpy.mockResolvedValueOnce({ state: 'success' });
    await expect(adapter.readCheckStatus(projectFixture, 'abc123')).resolves.toBe('success');

    requestSpy.mockResolvedValueOnce({ state: 'failure' });
    await expect(adapter.readCheckStatus(projectFixture, 'abc123')).resolves.toBe('failure');

    requestSpy.mockRestore();
  });

  it('renders pull request body with execution details', () => {
    const body = renderPullRequestBody({
      summary: 'Summary',
      acceptanceCriteria: ['Criterion'],
      tests: ['npm test: exit 0'],
      risks: ['Low risk'],
      usage: '0 USD',
      validationReport: 'node --version: exit 0',
      resolvedReviewBlockers: ['Add missing guard clause'],
      automaticImprovements: ['Apply suggested null guard'],
      executionNotes: ['Total implementation attempts: 2', 'Validation retry before attempt 2: Exit code 1']
    });

    expect(body).toContain('## Poslední validace');
    expect(body).toContain('node --version: exit 0');
    expect(body).toContain('## Vyřešené review blokery');
    expect(body).toContain('Add missing guard clause');
    expect(body).toContain('## Co agent automaticky vylepšil');
    expect(body).toContain('Apply suggested null guard');
  });

  it('renders the complete task prompt without parsing optional headings', () => {
    const body = renderIssueBody({
      ...taskFixture,
      prompt: [
        'Implement gallery grouping by day and fullscreen navigation.',
        '',
        'Priority: high',
        '',
        'Runtime Summary:',
        'No backend changes, keep nginx-only runtime.',
        '',
        'Scope Files:',
        '- apps/mobile-pwa/src/App.tsx',
        '- apps/mobile-pwa/src/styles.css',
        '',
        'Acceptance Criteria:',
        '- Build passes without warnings',
        '- No console errors during gallery navigation'
      ].join('\n')
    });

    expect(body).toContain('## Zadání');
    expect(body).toContain('Implement gallery grouping by day and fullscreen navigation.');
    expect(body).toContain('Priority: high');
    expect(body).toContain('Runtime Summary:\nNo backend changes, keep nginx-only runtime.');
    expect(body).toContain('Scope Files:\n- apps/mobile-pwa/src/App.tsx');
    expect(body).toContain('Acceptance Criteria:\n- Build passes without warnings');
  });

  it('renders a plain task prompt without synthetic fallback sections', () => {
    const body = renderIssueBody({
      ...taskFixture,
      prompt: 'Implement minimal static page update.'
    });

    expect(body).toBe([
      '## Cíl',
      'Implement feature X',
      '',
      '## Zadání',
      'Implement minimal static page update.',
      '',
      '## Režim',
      'safe'
    ].join('\n'));
  });
});
