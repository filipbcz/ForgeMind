import { activeProjectContractRequirements } from '@forgemind/core';
import type { Project, ProjectContractRequirement, ProjectImplementationStep } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import type { GitHubAdapter } from '@forgemind/github';
import type { AIProvider, CapabilityAuditResult, ProviderActivityHandler, ReleaseAuditResult } from '@forgemind/providers';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  supplementalContext?: string;
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
  const evidenceValidFromVersion = input.requirement.lastChangedInVersion
    ?? input.requirement.introducedInVersion
    ?? contract.version;
  const eligibleEvidence = roadmap.evidence.filter((item) =>
    item.contractVersion >= evidenceValidFromVersion
    && item.contractVersion <= contract.version
    && item.source !== 'repository_audit'
  );
  const normalizedEligibleEvidence = await rebindTreeEquivalentEvidence(
    input.workspacePath,
    eligibleEvidence,
    input.commitSha
  );
  const currentEvidence = selectCapabilityExecutionEvidence(
    normalizedEligibleEvidence,
    input.requirement.id,
    input.commitSha
  );
  const evidenceLineageContext = await buildEvidenceLineageContext(
    input.workspacePath,
    currentEvidence,
    input.commitSha
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
    supplementalContext: [input.supplementalContext, evidenceLineageContext].filter(Boolean).join('\n\n') || undefined,
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
  supplementalContext?: string;
  onActivity?: ProviderActivityHandler;
}): Promise<ReleaseAuditResult> {
  const contract = input.project.projectContract;
  if (!contract) throw new Error('Project contract is required for release audit.');
  if (!input.provider.auditRelease) throw new Error('Configured provider does not support release audits.');
  const roadmap = await input.repository.getProjectRoadmap(input.project.id);
  if (!roadmap) throw new Error('Project roadmap is required for release audit.');
  const capabilities = roadmap.capabilities;
  if (capabilities.length !== activeProjectContractRequirements(contract).length || capabilities.some((item) => item.status !== 'satisfied')) {
    throw new Error('Release audit cannot run before every contract capability is satisfied.');
  }

  const cycleSteps = roadmap.steps
    .filter((step) => step.cycleId === input.cycleId)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  const initialRoadmapCreatedAt = cycleSteps[0]?.createdAt;
  const allExecutionEvidence = roadmap.evidence.filter((item) => item.source !== 'repository_audit');
  const releaseExecutionEvidence = await rebindTreeEquivalentEvidence(
    input.workspacePath,
    selectReleaseExecutionEvidence(allExecutionEvidence, input.commitSha, 24),
    input.commitSha
  );
  const evidenceLineageContext = await buildEvidenceLineageContext(
    input.workspacePath,
    releaseExecutionEvidence,
    input.commitSha
  );
  const result = await input.provider.auditRelease({
    projectId: input.project.id,
    contract,
    originalBrief: contract.sourceBriefSnapshot?.trim() || input.project.brief?.trim() || contract.summary,
    satisfiedCapabilities: capabilities.map((item) => ({
      requirementId: item.requirement.id,
      title: item.requirement.title,
      satisfiedCriteria: item.satisfiedCriteria,
      totalCriteria: item.totalCriteria
    })),
    implementationSteps: cycleSteps
      .map((step) => ({
        sequenceNumber: step.sequenceNumber,
        title: step.title,
        description: step.description,
        acceptanceCriteria: step.acceptanceCriteria,
        requirementIds: step.requirementIds,
        deliverables: step.deliverables,
        status: step.status,
        origin: step.createdAt === initialRoadmapCreatedAt ? 'initial_roadmap' as const : 'audit_repair' as const,
        ...(step.taskId ? { taskId: step.taskId } : {})
      })),
    executionEvidence: releaseExecutionEvidence
      .map((item) => ({
        criterion: item.criterion,
        source: item.source,
        status: item.status,
        command: item.command,
        commitSha: item.commitSha,
        summary: evidenceSummary(item.payload, 600)
      })),
    repositoryPath: input.workspacePath,
    repositoryContext: input.repositoryContext,
    supplementalContext: [input.supplementalContext, evidenceLineageContext].filter(Boolean).join('\n\n') || undefined,
    commitSha: input.commitSha,
    onActivity: input.onActivity
  });

  const requirementIds = activeProjectContractRequirements(contract).map((requirement) => requirement.id);
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
  if (result.verdict === 'satisfied') {
    await input.repository.recordAcceptanceEvidence({
      projectId: input.project.id,
      cycleId: input.cycleId,
      requirementIds,
      criterion: 'Release: Original brief coverage',
      source: 'repository_audit',
      status: 'passed',
      evidenceIdentity: `release-audit:${input.commitSha}`,
      contractVersion: contract.version,
      commitSha: input.commitSha,
      payload: {
        auditKind: 'brief_coverage',
        verdict: result.verdict,
        summary: limitText(result.summary),
        obligations: result.briefCoverage.map((item) => ({
          obligation: limitText(item.obligation),
          requirementIds: item.requirementIds,
          evidence: item.evidence.map((evidence) => limitText(evidence))
        }))
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
      briefObligationCount: result.briefCoverage.length,
      contractAmendmentCount: result.contractAmendments.length,
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
  includeRepositoryContext?: boolean;
}): Promise<{ workspacePath: string; commitSha: string; repositoryContext?: string; cleanup: () => Promise<void> }> {
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
    ...(input.includeRepositoryContext === false
      ? {}
      : { repositoryContext: await buildCompleteRepositoryContext(workspacePath) }),
    cleanup: () => rm(workspacePath, { recursive: true, force: true })
  };
}

export async function buildCompleteRepositoryContext(workspacePath: string): Promise<string> {
  const paths = (await simpleGit({ baseDir: workspacePath }).raw(['ls-files', '-z']))
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const sections: string[] = [`Complete repository snapshot (${paths.length} tracked files):\n${paths.join('\n')}`];

  for (const path of paths) {
    try {
      const content = await readFile(join(workspacePath, path));
      if (content.includes(0)) {
        sections.push(`--- ${path} ---\n[binary file: ${content.length} bytes, sha256=${createHash('sha256').update(content).digest('hex')}]`);
      } else {
        sections.push(`--- ${path} ---\n${content.toString('utf8')}`);
      }
    } catch (error) {
      sections.push(`--- ${path} ---\n[unreadable file: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  return sections.join('\n\n');
}

export async function buildTargetedRepositoryContext(workspacePath: string, _focusTerms: string[] = []): Promise<string> {
  return buildCompleteRepositoryContext(workspacePath);
}

function uniqueLatestEvidence<T extends { criterion: string; command?: string; source: string; status: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return [...items].reverse().filter((item) => {
    const key = [item.source, item.status, item.criterion, item.command ?? ''].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
}

export function selectCapabilityExecutionEvidence<T extends {
  requirementId: string;
  criterion: string;
  command?: string;
  source: string;
  status: string;
  commitSha?: string;
}>(items: T[], requirementId: string, currentCommitSha: string): T[] {
  return uniqueLatestEvidence(items.filter((item) =>
    item.requirementId === requirementId || item.commitSha === currentCommitSha
  ));
}

export function selectReleaseExecutionEvidence<T extends {
  criterion: string;
  command?: string;
  source: string;
  status: string;
  commitSha?: string;
}>(items: T[], currentCommitSha: string, limit: number): T[] {
  const seen = new Set<string>();
  const latestByCommand = [...uniqueLatestEvidence(items)].reverse().filter((item) => {
    const key = item.command?.trim()
      ? `${item.source}\u0000${item.command.trim().toLowerCase()}`
      : `${item.source}\u0000${item.criterion.replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return latestByCommand
    .sort((left, right) => (
      Number(right.status === 'deferred') - Number(left.status === 'deferred')
      || Number(right.commitSha === currentCommitSha) - Number(left.commitSha === currentCommitSha)
    ))
    .slice(0, limit);
}

export async function rebindTreeEquivalentEvidence<T extends {
  commitSha?: string;
}>(workspacePath: string, items: T[], currentCommitSha: string): Promise<T[]> {
  if (items.some((item) => item.commitSha === currentCommitSha)) return items;

  const candidateShas = [...items]
    .reverse()
    .flatMap((item) => item.commitSha && /^[a-f0-9]{7,64}$/i.test(item.commitSha) ? [item.commitSha] : [])
    .filter((sha, index, values) => values.indexOf(sha) === index);
  if (candidateShas.length === 0) return items;

  const git = simpleGit({ baseDir: workspacePath });
  const currentTree = await resolveCommitTree(git, currentCommitSha, false);
  if (!currentTree) return items;

  for (const candidateSha of candidateShas) {
    const candidateTree = await resolveCommitTree(git, candidateSha, true);
    if (candidateTree !== currentTree) continue;
    return items.map((item) => item.commitSha === candidateSha
      ? { ...item, commitSha: currentCommitSha }
      : item);
  }
  return items;
}

export async function buildEvidenceLineageContext<T extends { commitSha?: string }>(
  workspacePath: string,
  items: T[],
  currentCommitSha: string
): Promise<string> {
  const candidateShas = [...items]
    .reverse()
    .flatMap((item) => item.commitSha && item.commitSha !== currentCommitSha && /^[a-f0-9]{7,64}$/i.test(item.commitSha)
      ? [item.commitSha]
      : [])
    .filter((sha, index, values) => values.indexOf(sha) === index)
    .slice(0, 8);
  if (candidateShas.length === 0) return '';

  const git = simpleGit({ baseDir: workspacePath });
  const sections: string[] = ['Trusted evidence lineage to the audited commit:'];
  for (const candidateSha of candidateShas) {
    if (!await ensureCommitAvailable(git, candidateSha)) continue;
    try {
      const changedFiles = (await git.raw(['diff', '--name-only', candidateSha, currentCommitSha, '--']))
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean)
        .slice(0, 120);
      sections.push(
        `- ${candidateSha}: ${changedFiles.length === 0 ? 'identical repository tree' : `files changed afterward: ${changedFiles.join(', ')}`}`
      );
    } catch {
      // Evidence remains usable as historical context even when lineage cannot be inspected.
    }
  }
  return sections.length > 1 ? sections.join('\n').slice(0, 12_000) : '';
}

async function ensureCommitAvailable(git: ReturnType<typeof simpleGit>, commitSha: string): Promise<boolean> {
  try {
    await git.raw(['cat-file', '-e', `${commitSha}^{commit}`]);
    return true;
  } catch {
    try {
      await git.raw(['fetch', '--no-tags', '--depth=1', 'origin', commitSha]);
      await git.raw(['cat-file', '-e', `${commitSha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

async function resolveCommitTree(git: ReturnType<typeof simpleGit>, commitSha: string, fetchIfMissing: boolean): Promise<string | undefined> {
  try {
    return (await git.raw(['rev-parse', `${commitSha}^{tree}`])).trim();
  } catch {
    if (!fetchIfMissing) return undefined;
  }

  try {
    if (!await ensureCommitAvailable(git, commitSha)) return undefined;
    return (await git.raw(['rev-parse', `${commitSha}^{tree}`])).trim();
  } catch {
    return undefined;
  }
}

function evidenceSummary(payload: Record<string, unknown>, maxLength = 2_000): string | undefined {
  for (const key of ['summary', 'stdout', 'stderr']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return limitText(value, maxLength);
  }
  return undefined;
}

function limitText(value: string, maxLength = 2_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[audit text truncated]`;
}
