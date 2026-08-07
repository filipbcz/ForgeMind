import type { Project, ProjectContractRequirement, ProjectImplementationStep } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import type { GitHubAdapter } from '@forgemind/github';
import type { AIProvider, CapabilityAuditResult, ProviderActivityHandler, ReleaseAuditResult } from '@forgemind/providers';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';

export async function runCapabilityAudit(input: {
  repository: ForgeMindRepository;
  provider: AIProvider;
  project: Project;
  cycleId: string;
  requirement: ProjectContractRequirement;
  workItems: ProjectImplementationStep[];
  workspacePath: string;
  commitSha: string;
  repositoryContext?: string;
  onActivity?: ProviderActivityHandler;
}): Promise<CapabilityAuditResult> {
  const contract = input.project.projectContract;
  if (!contract) throw new Error('Project contract is required for capability audit.');
  if (!input.provider.auditCapability) throw new Error('Configured provider does not support capability audits.');
  if (!/^[a-f0-9]{7,64}$/i.test(input.commitSha)) throw new Error('Current repository commit SHA is required for capability audit.');
  const roadmap = await input.repository.getProjectRoadmap(input.project.id);
  if (!roadmap || !roadmap.cycles.some((cycle) => cycle.id === input.cycleId)) {
    throw new Error('Capability audit references an unknown roadmap cycle.');
  }
  const currentEvidence = roadmap.evidence.filter((item) =>
    item.cycleId === input.cycleId
    && item.requirementId === input.requirement.id
    && item.contractVersion === contract.version
    && item.source !== 'repository_audit'
  );
  const result = await input.provider.auditCapability({
    projectId: input.project.id,
    contractVersion: contract.version,
    contractSummary: contract.summary,
    invariants: contract.invariants,
    prohibitedSubstitutes: contract.prohibitedSubstitutes,
    requirement: input.requirement,
    completedWorkItems: input.workItems.map((item) => ({
      id: item.id,
      title: item.title,
      deliverables: item.deliverables,
      acceptanceCriteria: item.acceptanceCriteria
    })),
    evidence: currentEvidence.map((item) => ({
      criterion: item.criterion,
      source: item.source,
      status: item.status,
      command: item.command,
      commitSha: item.commitSha,
      summary: evidenceSummary(item.payload)
    })),
    repositoryPath: input.workspacePath,
    repositoryContext: input.repositoryContext,
    commitSha: input.commitSha,
    onActivity: input.onActivity
  });

  for (const criterion of result.criteria) {
    await input.repository.recordAcceptanceEvidence({
      projectId: input.project.id,
      cycleId: input.cycleId,
      requirementIds: [input.requirement.id],
      criterion: criterion.criterion,
      source: 'repository_audit',
      status: criterion.status,
      evidenceIdentity: `repository-audit:${input.commitSha}`,
      contractVersion: contract.version,
      commitSha: input.commitSha,
      payload: {
        verdict: result.verdict,
        summary: limitText(result.summary),
        evidence: criterion.evidence.map((item) => limitText(item)),
        gaps: criterion.gaps.map((item) => limitText(item))
      }
    });
  }

  await input.repository.writeAudit({
    actorType: 'agent',
    eventType: 'project_capability_audited',
    projectId: input.project.id,
    payload: {
      cycleId: input.cycleId,
      requirementId: input.requirement.id,
      contractVersion: contract.version,
      commitSha: input.commitSha,
      verdict: result.verdict,
      gapWorkItemCount: result.gapWorkItems.length
    }
  });
  return result;
}

export async function runReleaseAudit(input: {
  repository: ForgeMindRepository;
  provider: AIProvider;
  project: Project;
  cycleId: string;
  workspacePath: string;
  commitSha: string;
  repositoryContext?: string;
  onActivity?: ProviderActivityHandler;
}): Promise<ReleaseAuditResult> {
  const contract = input.project.projectContract;
  if (!contract) throw new Error('Project contract is required for release audit.');
  if (!input.provider.auditRelease) throw new Error('Configured provider does not support release audits.');
  const roadmap = await input.repository.getProjectRoadmap(input.project.id);
  if (!roadmap) throw new Error('Project roadmap is required for release audit.');
  const capabilities = roadmap.capabilities;
  if (capabilities.length !== contract.requirements.length || capabilities.some((item) => item.status !== 'satisfied')) {
    throw new Error('Release audit cannot run before every contract capability is satisfied.');
  }

  const result = await input.provider.auditRelease({
    projectId: input.project.id,
    contract,
    satisfiedCapabilities: capabilities.map((item) => ({
      requirementId: item.requirement.id,
      title: item.requirement.title,
      satisfiedCriteria: item.satisfiedCriteria,
      totalCriteria: item.totalCriteria
    })),
    repositoryPath: input.workspacePath,
    repositoryContext: input.repositoryContext,
    commitSha: input.commitSha,
    onActivity: input.onActivity
  });

  const requirementIds = contract.requirements.map((requirement) => requirement.id);
  for (const criterion of result.criteria) {
    await input.repository.recordAcceptanceEvidence({
      projectId: input.project.id,
      cycleId: input.cycleId,
      requirementIds,
      criterion: `Release: ${criterion.criterion}`,
      source: 'repository_audit',
      status: criterion.status,
      evidenceIdentity: `release-audit:${input.commitSha}`,
      contractVersion: contract.version,
      commitSha: input.commitSha,
      payload: {
        auditKind: 'release',
        verdict: result.verdict,
        summary: limitText(result.summary),
        evidence: criterion.evidence.map((item) => limitText(item)),
        gaps: criterion.gaps.map((item) => limitText(item))
      }
    });
  }
  await input.repository.writeAudit({
    actorType: 'agent',
    eventType: 'project_release_audited',
    projectId: input.project.id,
    payload: {
      cycleId: input.cycleId,
      contractVersion: contract.version,
      commitSha: input.commitSha,
      verdict: result.verdict,
      gapWorkItemCount: result.gapWorkItems.length
    }
  });
  return result;
}

export async function prepareCapabilityAuditWorkspace(input: {
  workspaceRoot: string;
  project: Project;
  github: GitHubAdapter;
  preferredBranch?: string;
}): Promise<{ workspacePath: string; commitSha: string; repositoryContext: string; cleanup: () => Promise<void> }> {
  const auditRoot = resolve(input.workspaceRoot, 'project-audits');
  await mkdir(auditRoot, { recursive: true });
  const workspacePath = await mkdtemp(join(auditRoot, 'audit-'));
  const remoteUrl = input.github.getRemoteUrl?.(input.project);
  if (!remoteUrl) throw new Error('GitHub remote URL is required for capability audit.');

  const branches = Array.from(new Set([input.preferredBranch, input.project.defaultBranch].filter((value): value is string => Boolean(value?.trim()))));
  let lastError: unknown;
  for (const branch of branches) {
    try {
      await simpleGit().clone(remoteUrl, workspacePath, ['--branch', branch, '--single-branch', '--depth', '1']);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await rm(workspacePath, { recursive: true, force: true });
      await mkdir(workspacePath, { recursive: true });
    }
  }
  if (lastError) {
    await rm(workspacePath, { recursive: true, force: true });
    throw lastError;
  }

  const git = simpleGit({ baseDir: workspacePath });
  const commitSha = (await git.revparse(['HEAD'])).trim();
  return {
    workspacePath,
    commitSha,
    repositoryContext: await buildTargetedRepositoryContext(workspacePath),
    cleanup: () => rm(workspacePath, { recursive: true, force: true })
  };
}

export async function buildTargetedRepositoryContext(workspacePath: string, focusTerms: string[] = []): Promise<string> {
  const paths = (await simpleGit({ baseDir: workspacePath }).raw(['ls-files']))
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path) => !/(^|\/)(dist|build|coverage|vendor|node_modules)\//.test(path));
  const terms = focusTerms
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
    .filter((value) => value.length >= 4);
  const prioritized = paths
    .sort((left, right) => repositoryContextPriority(left, terms) - repositoryContextPriority(right, terms) || left.localeCompare(right))
    .slice(0, 40);
  const manifest = paths.slice(0, 300).join('\n').slice(0, 12_000);
  const sections: string[] = [`Repository manifest (${paths.length} tracked files):\n${manifest}`];
  let usedCharacters = 0;
  for (const path of prioritized) {
    if (usedCharacters >= 30_000) break;
    try {
      const content = await readFile(join(workspacePath, path), 'utf8');
      if (content.includes('\0')) continue;
      const remaining = 30_000 - usedCharacters;
      const bounded = content.length <= remaining ? content : `${content.slice(0, remaining)}\n[file truncated]`;
      sections.push(`--- ${path} ---\n${bounded}`);
      usedCharacters += bounded.length;
    } catch {
      // Binary or transient files are not useful in the audit packet.
    }
  }
  return sections.join('\n\n');
}

function repositoryContextPriority(path: string, focusTerms: string[]): number {
  const normalizedPath = path.toLowerCase();
  const focusBoost = focusTerms.some((term) => normalizedPath.includes(term)) ? -10 : 0;
  const name = basename(path).toLowerCase();
  if (['package.json', 'readme.md', 'agents.md', 'vite.config.ts', 'vite.config.js', 'tsconfig.json'].includes(name)) return focusBoost;
  if (/(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return 1 + focusBoost;
  if (/(^|\/)src\//.test(path)) return 2 + focusBoost;
  return 3 + focusBoost;
}

function evidenceSummary(payload: Record<string, unknown>): string | undefined {
  for (const key of ['summary', 'stdout', 'stderr']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return limitText(value);
  }
  return undefined;
}

function limitText(value: string, maxLength = 2_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[audit text truncated]`;
}
