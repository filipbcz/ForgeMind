import { parseAgentConfigYaml, type AgentConfig } from '@forgemind/config';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { activeProjectContractRequirements, createBlockedRunState, createFailedRunState, WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES, WINDOWS_EVIDENCE_MAX_LOG_BYTES, type WindowsAuthoringPacket, type WindowsAuthoringResult } from '@forgemind/core';
import { advanceRoadmapAfterTaskCompletion, createRepository, getPrismaClient, startNextRoadmapStep, WindowsWorkerRepository, type AIProviderConnectionSecret, type ForgeMindRepository } from '@forgemind/db';
import { GitHubAppAdapter, createGitHubAdapterFromEnv } from '@forgemind/github';
import { buildProjectExtensionProposalPrompt, createProvider, formatProjectExtensionProposal, normalizeProviderError, type AIProvider, type CapabilityAuditInput, type ImplementResult, type ProviderSessionContext, type ProviderUsageMeasurement, type ReleaseAuditInput, type ValidationCheck } from '@forgemind/providers';
import type { NormalizedProviderErrorDetails, ProviderCircuitBreakerSnapshot, ProviderKind } from '@forgemind/core';
import { toErrorMessage } from '@forgemind/shared';
import { formatProjectArchitectureContext, runWorkerTask } from './workflow.js';
import { buildCompleteRepositoryContext, prepareCapabilityAuditWorkspace, runCapabilityAudit, runReleaseAudit } from './capability-audit.js';
import { runNextChatTurn } from './chat-worker.js';
import { hasSatisfiedReleaseAudit, recordTaskAcceptanceEvidence, sanitizeAuditErrorMessage } from './db-worker/audit.js';
import { buildIterationErrorFingerprint, resolveTaskResumeContext } from './db-worker/checkpoints.js';
import { cleanupCompletedTaskWorkspace, installWorkerInterruptionRecovery, resolveWorkerWorkspaceRoot, runWorkspaceRetentionCleanup, startProjectAuditHeartbeat, startQueueClaimHeartbeat, startTaskCancellationWatcher, TaskCancellationError, throwIfTaskCancelled } from './db-worker/lifecycle.js';
import { extractAttemptNumber, resolveBlockedRunReason } from './db-worker/limits.js';
import { normalizeProviderUsageMeasurement } from './db-worker/provider-usage.js';
import {
  assertFreeSpaceForWorker,
  resolveWorkerResourcePolicy,
  type WorkerResourcePolicy
} from './resource-policy.js';

export { recordTaskAcceptanceEvidence } from './db-worker/audit.js';
export { resolveWorkerWorkspaceRoot } from './db-worker/lifecycle.js';

async function enqueueExternalWindowsValidations(
  repository: ForgeMindRepository,
  windowsWorkers: WindowsWorkerRepository,
  input: {
    project: import('@forgemind/core').Project;
    taskId: string;
    taskRunId: string;
    commitSha?: string;
    checks: ValidationCheck[];
  }
): Promise<void> {
  if (input.checks.length === 0) return;
  const project = input.project;
  const contract = project.projectContract;
  const step = await repository.getImplementationStepByTaskId(input.taskId);
  if (!input.commitSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.commitSha) || !project.githubOwner || !project.githubRepo) {
    await repository.writeAudit({
      actorType: 'system', eventType: 'windows_validation_not_enqueued', projectId: project.id, taskId: input.taskId,
      payload: { reason: 'Windows validation requires a delivered GitHub commit and repository.', count: input.checks.length }
    });
    return;
  }

  const evidenceContext = contract && step
    ? {
        cycleId: step.cycleId,
        stepId: step.id,
        requirementIds: step.requirementIds,
        contractVersion: contract.version
      }
    : undefined;

  for (const check of input.checks) {
    const jobId = randomUUID();
    const checkId = randomUUID();
    const requestedCapabilities = Array.from(new Set((check.requiredCapabilities ?? []).map((capability) => capability.trim()).filter(Boolean)));
    const requiredCapabilities = Array.from(new Set(['windows', ...requestedCapabilities]));
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ commitSha: input.commitSha, command: check.command, shell: check.shell ?? 'system', requestedCapabilities, windowsAdapter: check.windowsAdapter ?? null }))
      .digest('hex');
    await windowsWorkers.enqueue({
      id: jobId,
      projectId: project.id,
      taskId: input.taskId,
      runId: input.taskRunId,
      requiredCapabilities,
      packet: {
        schemaVersion: 2,
        projectId: project.id,
        taskId: input.taskId,
        runId: input.taskRunId,
        checkId,
        jobId,
        leaseId: 'pending',
        repository: `${project.githubOwner}/${project.githubRepo}`,
        sourceUrl: `https://github.com/${project.githubOwner}/${project.githubRepo}.git`,
        commitSha: input.commitSha,
        workspaceRoot: 'runner-managed',
        artifactRoot: 'runner-managed',
        check: {
          command: check.command,
          shell: check.shell ?? 'system',
          category: check.category ?? 'smoke',
          criterion: check.criterion,
          requiredCapabilities
        },
        dispatch: check.windowsAdapter ?? {
          kind: 'deferred',
          reason: 'unsupported_validation_intent',
          handling: 'manual-local'
        },
        requiredCapabilities,
        resourcePolicy: {
          timeoutSeconds: Math.max(60, Math.min(36_000, Math.round((check.timeoutMinutes ?? 10) * 60))),
          maxLogBytes: WINDOWS_EVIDENCE_MAX_LOG_BYTES,
          maxArtifactBytes: WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES
        },
        expectedArtifacts: [],
        nonce: 'pending',
        inputHash,
        ...(evidenceContext ? { evidenceContext } : {})
      }
    });
    if (!evidenceContext) continue;
    await repository.recordAcceptanceEvidence({
      projectId: project.id,
      cycleId: evidenceContext.cycleId,
      stepId: evidenceContext.stepId,
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      requirementIds: evidenceContext.requirementIds,
      criterion: check.criterion ?? check.command,
      source: 'artifact',
      status: 'deferred',
      evidenceIdentity: `windows:${jobId}`,
      contractVersion: evidenceContext.contractVersion,
      commitSha: input.commitSha,
      command: check.command,
      payload: { platform: 'windows', jobId, requestedCapabilities }
    });
    await repository.writeAudit({
      actorType: 'agent', eventType: 'windows_validation_enqueued', projectId: project.id, taskId: input.taskId,
      payload: { jobId, checkId, command: check.command, requestedCapabilities, commitSha: input.commitSha }
    });
  }
}

async function implementThroughWindowsLease(windowsWorkers: WindowsWorkerRepository, input: {
  project: import('@forgemind/core').Project; taskId: string; taskRunId: string; workspacePath: string;
  prompt: string; acceptanceCriteria: string[]; previousValidationError?: string; previousReviewBlockers?: string[];
  baseCommitSha: string; requiredCapabilities: string[]; requiresUnrealAssets: boolean; signal?: AbortSignal;
}): Promise<ImplementResult> {
  if (!input.project.githubOwner || !input.project.githubRepo) throw new Error('Windows authoring requires a GitHub repository.');
  const jobId = randomUUID();
  const priorPatch = await readGitPatch(input.workspacePath, input.signal);
  const packet: WindowsAuthoringPacket = {
    kind: 'authoring', protocolVersion: 1, projectId: input.project.id, taskId: input.taskId, runId: input.taskRunId,
    jobId, leaseId: 'pending', repository: `${input.project.githubOwner}/${input.project.githubRepo}`,
    sourceUrl: `https://github.com/${input.project.githubOwner}/${input.project.githubRepo}.git`, baseCommitSha: input.baseCommitSha,
    workspaceRoot: 'runner-managed', artifactRoot: 'runner-managed', step: { prompt: input.prompt, acceptanceCriteria: input.acceptanceCriteria,
      previousValidationError: input.previousValidationError, previousReviewBlockers: input.previousReviewBlockers, priorPatch },
    operations: [{ id: 'implementation', kind: 'tool', tool: 'ai-implementation', arguments: { acceptanceCriteria: input.acceptanceCriteria }, rationale: 'Implement the current task step in the exact native checkout.' }],
    requiredCapabilities: input.requiredCapabilities, managedRoots: ['.'], checkpoints: [], artifactExpectations: input.requiresUnrealAssets
      ? [{ name: 'authored-unreal-assets', relativePath: 'Content', required: true, delivery: 'artifact-store', binary: true,
        maxBytes: WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES }]
      : [],
    contentPolicy: { requiresUnrealAssets: input.requiresUnrealAssets,
      prohibitedDatasetExtensions: ['.tif', '.tiff', '.geotiff', '.shp', '.dbf', '.shx', '.prj', '.gpkg', '.geojson', '.kml', '.kmz', '.gdb', '.fgb', '.las', '.laz', '.copc', '.dem', '.dt0', '.dt1', '.dt2', '.asc', '.img', '.jp2', '.ecw', '.mrf', '.mbtiles', '.pmtiles', '.osm', '.pbf', '.grib', '.nc', '.hdf'],
      maxUnclassifiedFileBytes: 50 * 1024 * 1024 },
    resourcePolicy: { timeoutSeconds: 36_000, maxLogBytes: WINDOWS_EVIDENCE_MAX_LOG_BYTES, maxArtifactBytes: WINDOWS_EVIDENCE_MAX_ARTIFACT_BYTES },
    nonce: 'pending', inputHash: createHash('sha256').update(JSON.stringify({ taskId: input.taskId, runId: input.taskRunId, baseCommitSha: input.baseCommitSha,
      prompt: input.prompt, acceptanceCriteria: input.acceptanceCriteria, previousValidationError: input.previousValidationError,
      previousReviewBlockers: input.previousReviewBlockers, priorPatch, requiresUnrealAssets: input.requiresUnrealAssets })).digest('hex'),
    authority: { database: 'none', productionHosts: 'none', globalGitHubCredentials: 'none' }
  };
  await windowsWorkers.enqueueAuthoring({ id: jobId, projectId: input.project.id, taskId: input.taskId, runId: input.taskRunId, requiredCapabilities: input.requiredCapabilities, packet });
  const result = await windowsWorkers.waitForAuthoringResult(jobId, input.signal);
  if (result.status !== 'succeeded') throw new Error(`Windows authoring ${result.status}: ${result.summary}`);
  const patchBytes = Buffer.from(result.patch, 'utf8');
  const patchHash = createHash('sha256').update(patchBytes).digest('hex');
  if (result.resultBundle.version !== 1 || result.resultBundle.format !== 'git-binary-patch'
    || result.resultBundle.sizeBytes !== patchBytes.length || result.resultBundle.sha256.toLowerCase() !== patchHash) {
    throw new Error('Windows result reconciliation failed: result bundle hash or size does not match its binary patch.');
  }
  for (const object of result.resultBundle.lfsObjects) {
    const content = Buffer.from(object.contentBase64, 'base64');
    if (content.length !== object.sizeBytes || createHash('sha256').update(content).digest('hex') !== object.oid.toLowerCase()) {
      throw new Error(`Windows result reconciliation failed: Git LFS object ${object.oid} is corrupt.`);
    }
    const objectPath = resolve(input.workspacePath, '.git', 'lfs', 'objects', object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
    await mkdir(resolve(objectPath, '..'), { recursive: true }); await writeFile(objectPath, content);
  }
  for (const output of result.resultBundle.outputs) {
    const content = Buffer.from(output.contentBase64, 'base64');
    if (content.length !== output.sizeBytes || createHash('sha256').update(content).digest('hex') !== output.sha256.toLowerCase()) {
      throw new Error(`Windows result reconciliation failed: managed output ${output.path} is corrupt.`);
    }
  }
  await replaceGitPatch(input.workspacePath, priorPatch, result.patch, input.signal);
  await verifyWindowsResultTree(input.workspacePath, result, input.signal);
  const outputEvidence = await materializeWindowsOutputs(input.workspacePath, result.resultBundle.outputs);
  const reviewNotice = result.contentAssessment.productionReviewRequired
    ? '\n\nProduction-content review required: technical loadability and provenance passed, but these signals do not approve visual or domain quality.' : '';
  return { outcome: result.patch.trim() ? 'changes_made' : 'already_satisfied',
    summary: `${outputEvidence.length > 0 ? `${result.summary}\n\nManaged output evidence: ${outputEvidence.join(', ')}` : result.summary}${reviewNotice}`,
    changedFiles: result.tree.map(({ path }) => path), evidenceFiles: outputEvidence, diffStat: { filesChanged: result.tree.length, insertions: 0, deletions: 0 },
    validationChecks: [], architectureUpdate: undefined };
}

async function materializeWindowsOutputs(workspacePath: string, outputs: WindowsAuthoringResult['resultBundle']['outputs']): Promise<string[]> {
  if (outputs.length === 0) return [];
  const root = resolve(workspacePath, '.forgemind-outputs'); await mkdir(root, { recursive: true });
  const excludePath = resolve(workspacePath, '.git', 'info', 'exclude');
  let exclude = ''; try { exclude = await readFile(excludePath, 'utf8'); } catch { /* new checkout */ }
  if (!exclude.split(/\r?\n/).includes('.forgemind-outputs/')) await writeFile(excludePath, `${exclude}${exclude.endsWith('\n') || !exclude ? '' : '\n'}.forgemind-outputs/\n`, 'utf8');
  const evidence: string[] = [];
  for (const output of outputs) {
    const target = resolve(root, output.path); const content = Buffer.from(output.contentBase64, 'base64');
    await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, content); evidence.push(`.forgemind-outputs/${output.path}`);
  }
  return evidence;
}

async function verifyWindowsResultTree(workspacePath: string, result: WindowsAuthoringResult, signal?: AbortSignal): Promise<void> {
  const tree = await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['write-tree'], { cwd: workspacePath, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true }); child.once('error', reject);
    child.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolve(stdout.trim()) : reject(new Error(`Windows tree verification failed: ${stderr}`)); });
  });
  if (tree.toLowerCase() !== result.resultTreeSha.toLowerCase()) throw new Error('Windows result reconciliation failed: reconstructed Git tree does not match the runner result tree.');
  const files = await runGitCapture(workspacePath, ['ls-files', '-z'], signal);
  const supplied = new Set(result.resultBundle.lfsObjects.map(({ oid }) => oid.toLowerCase()));
  for (const path of files.split('\0').filter(Boolean)) {
    const indexed = await runGitCapture(workspacePath, ['show', `:${path}`], signal);
    const pointer = indexed.match(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize \d+\r?\n?$/);
    if (pointer && !supplied.has(pointer[1]!.toLowerCase())) throw new Error(`Windows result reconciliation failed: missing Git LFS object ${pointer[1]} for ${path}.`);
  }
}

async function runGitCapture(workspacePath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn('git', args, { cwd: workspacePath, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true }); child.once('error', reject);
    child.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolveOutput(stdout) : reject(new Error(`Git reconciliation failed: ${stderr}`)); });
  });
}

export async function replaceGitPatch(workspacePath: string, previousPatch: string, patch: string, signal?: AbortSignal): Promise<void> {
  if (previousPatch.trim()) await runGitApply(workspacePath, previousPatch, true, signal);
  try {
    if (patch.trim()) await runGitApply(workspacePath, patch, false, signal);
  } catch (error) {
    if (previousPatch.trim()) await runGitApply(workspacePath, previousPatch, false, signal);
    throw error;
  }
}

async function runGitApply(workspacePath: string, patch: string, reverse: boolean, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['apply', ...(reverse ? ['--reverse'] : []), '--binary', '--whitespace=nowarn', '-'], { cwd: workspacePath, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true }); child.stdin.end(patch);
    child.once('error', reject); child.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolve() : reject(new Error(`Windows result reconciliation failed: ${stderr}`)); });
  });
}

async function readGitPatch(workspacePath: string, signal?: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: workspacePath, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += String(chunk); }); child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true }); child.once('error', reject);
    child.once('close', (code) => { signal?.removeEventListener('abort', abort); code === 0 ? resolve(stdout) : reject(new Error(`Could not read current Windows patch: ${stderr}`)); });
  });
}

let preferChatQueue = true;

export async function runDatabaseWorkerOnce(options: { deferInterruptSignals?: boolean } = {}) {
  const prisma = getPrismaClient();
  const repository = createRepository(prisma);
  const windowsWorkers = new WindowsWorkerRepository(prisma);
  const defaultAIProviderConnection = await readAIProviderConnectionSecret(repository);
  const providerOverride = process.env.FORGEMIND_PROVIDER as ProviderKind | undefined;
  const fallbackProviderOverride = process.env.FORGEMIND_FALLBACK_PROVIDER as ProviderKind | undefined;
  const providerConnectionIdOverride = process.env.FORGEMIND_PROVIDER_CONNECTION_ID?.trim() || undefined;
  const fallbackProviderConnectionIdOverride = process.env.FORGEMIND_FALLBACK_PROVIDER_CONNECTION_ID?.trim() || undefined;
  const providerKind = providerOverride ?? defaultAIProviderConnection?.provider ?? 'codex';
  const providerModel = resolveProviderModel(providerKind, defaultAIProviderConnection);
  const claimTimeoutMinutes = Number(process.env.FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES ?? 2);
  const recovery = await repository.recoverStuckQueueJobs(claimTimeoutMinutes);
  const recoveredChatRuns = await repository.recoverStuckChatRuns(claimTimeoutMinutes);
  const recoveredProjectAudits = await repository.recoverStuckProjectAudits(claimTimeoutMinutes);
  if (preferChatQueue) {
    const chatResult = await runNextChatTurn(repository);
    if (chatResult) {
      preferChatQueue = false;
      return chatResult;
    }
  }
  const auditResult = await runNextProjectAudit({
    repository,
    defaultConnection: defaultAIProviderConnection,
    providerOverride,
    fallbackProviderOverride,
    providerConnectionIdOverride,
    fallbackProviderConnectionIdOverride
  });
  if (auditResult) return auditResult;
  const claimed = await repository.claimNextSubmittedTask(providerKind, providerModel);

  if (!claimed) {
    const chatResult = await runNextChatTurn(repository);
    if (chatResult) {
      preferChatQueue = false;
      return chatResult;
    }
    return {
      claimed: false,
      message: 'No submitted task or project audit found.',
      recoveredQueueJobs: recovery.recoveredCount,
      recoveredChatRuns,
      recoveredProjectAudits
    };
  }
  preferChatQueue = true;
  const stopQueueHeartbeat = startQueueClaimHeartbeat(repository, claimed.queueJobId, claimTimeoutMinutes);
  const taskAbortController = new AbortController();
  const stopCancellationWatcher = startTaskCancellationWatcher(repository, claimed.task.id, taskAbortController);
  const stopInterruptionRecovery = installWorkerInterruptionRecovery({
    repository,
    queueJobId: claimed.queueJobId,
    taskId: claimed.task.id,
    taskRunId: claimed.taskRun.id,
    stopQueueHeartbeat,
    deferInterruptSignals: options.deferInterruptSignals ?? false
  });
  const finalizeQueueJob = async (
    status: 'succeeded' | 'failed' | 'cancelled',
    errorMessage?: string,
    retryable = true
  ) => {
    stopQueueHeartbeat();
    stopCancellationWatcher();
    stopInterruptionRecovery();
    if (!retryable) {
      await repository.finalizeQueueJob(claimed.queueJobId, status, errorMessage, false);
    } else if (errorMessage === undefined) {
      await repository.finalizeQueueJob(claimed.queueJobId, status);
    } else {
      await repository.finalizeQueueJob(claimed.queueJobId, status, errorMessage);
    }
  };

  let iterationNumber = 0;
  let attemptCount = 0;
  let changedFiles = 0;
  let diffLines = 0;
  let repeatedErrorCount = 0;
  let lastErrorFingerprint: string | undefined;
  const cumulativeProviderTotals = new Map<string, ProviderUsageMeasurement>();
  let lastProviderActivityAuditAt = 0;
  const measuredUsage = {
    measurements: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    completeBreakdown: true,
    actualCostUsd: 0,
    completeCost: true
  };
  const startedAtMs = Date.now();
  const workspaceRoot = resolveWorkerWorkspaceRoot();
  const projectConfig = parseProjectConfig(claimed.project.configYaml);
  const requiresGitHub = !projectConfig
    || projectConfig.workflow.create_issue
    || projectConfig.workflow.create_branch
    || projectConfig.workflow.create_draft_pr
    || projectConfig.workflow.auto_push;
  const githubConnection = requiresGitHub ? await repository.getGitHubConnectionSecret() : undefined;
  const github = requiresGitHub
    ? (githubConnection
        ? new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl })
        : await createGitHubAdapterFromEnv())
    : undefined;
  let resourcePolicy: WorkerResourcePolicy;
  try {
    resourcePolicy = resolveWorkerResourcePolicy(claimed.project.configYaml);
    await runWorkspaceRetentionCleanup(repository, workspaceRoot, claimed.task.id, resourcePolicy);
    await assertFreeSpaceForWorker(workspaceRoot, resourcePolicy);
  } catch (error) {
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    await repository.failTask(claimed.task.id, message, 'failed');
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      iterationCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageSource: 'unavailable',
      estimatedCostUsd: 0,
      actualCostUsd: null
    });
    await finalizeQueueJob('failed', message, false);
    return {
      claimed: true,
      taskId: claimed.task.id,
      status: 'failed'
    };
  }
  const selection = await resolveProviderSelection({
    repository,
    projectConfig,
    projectProviderConnectionId: claimed.project.aiProviderConnectionId,
    defaultConnection: defaultAIProviderConnection,
    providerOverride,
    fallbackProviderOverride,
    providerConnectionIdOverride,
    fallbackProviderConnectionIdOverride
  });
  const selectedProviderModel = resolveProviderModel(selection.primary.kind, selection.primary.connection);
  if (claimed.taskRun.provider !== selection.primary.kind || claimed.taskRun.model !== selectedProviderModel) {
    await repository.updateTaskRunProvider({
      taskRunId: claimed.taskRun.id,
      provider: selection.primary.kind,
      model: selectedProviderModel
    });
    claimed.taskRun.provider = selection.primary.kind;
    claimed.taskRun.model = selectedProviderModel;
  }
  const primaryRuntimeProvider = buildRuntimeProvider(selection.primary.kind, selection.primary.connection);
  const fallbackRuntimeProvider = selection.fallback
    ? buildRuntimeProvider(selection.fallback.kind, selection.fallback.connection)
    : undefined;
  const { provider, getLastProviderKind } = createPolicyAwareProvider({
    primary: primaryRuntimeProvider,
    fallback: fallbackRuntimeProvider,
    audit: (event) => repository.writeAudit({
      actorType: 'system',
      eventType: event.eventType,
      taskId: claimed.task.id,
      payload: {
        taskRunId: claimed.taskRun.id,
        queueJobId: claimed.queueJobId ?? null,
        ...event.payload
      }
    })
  });
  const reviewerSelection = await resolveReviewerSelection({
    repository,
    projectConfig,
    primary: selection.primary,
    fallback: selection.fallback,
    defaultConnection: defaultAIProviderConnection
  });
  const reviewProvider = buildRuntimeProvider(reviewerSelection.kind, reviewerSelection.connection).provider;
  const reviewProviderModel = resolveProviderModel(reviewerSelection.kind, reviewerSelection.connection);
  const primaryConnectionId = selection.primary.connection?.id;
  const hasCompatibleProviderSession = claimed.task.providerSessionProvider === selection.primary.kind
    && claimed.task.providerSessionModel === selectedProviderModel
    && claimed.task.providerSessionConnectionId === primaryConnectionId;
  const providerSession: ProviderSessionContext = {
    id: hasCompatibleProviderSession ? claimed.task.providerSessionId : undefined,
    provider: hasCompatibleProviderSession ? claimed.task.providerSessionProvider : selection.primary.kind,
    model: hasCompatibleProviderSession ? claimed.task.providerSessionModel : selectedProviderModel,
    onUpdate: async (session) => {
      const connectionId = session.provider === selection.primary.kind
        ? selection.primary.connection?.id
        : selection.fallback?.connection?.id;
      await repository.updateTaskProviderSession({
        taskId: claimed.task.id,
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        connectionId
      });
    }
  };
  const resumeContext = await resolveTaskResumeContext(
    repository,
    claimed.task.id,
    claimed.queueReason,
    claimed.taskRun.id
  );
  if (resumeContext?.workflowResume) {
    const resume = resumeContext.workflowResume;
    await repository.writeAudit({
      actorType: 'system',
      eventType: 'task_retry_resume_decision',
      taskId: claimed.task.id,
      payload: {
        taskRunId: claimed.taskRun.id,
        queueJobId: claimed.queueJobId ?? null,
        queueReason: claimed.queueReason ?? null,
        kind: resume.kind,
        resumeFrom: resume.resumeFrom ?? null,
        attempt: resume.attempt ?? null,
        skippedExternalEffects: resume.completedOperations ?? [],
        reusedValidationChecks: resume.passedValidationChecks?.map((check) => ({
          command: check.command,
          inputHash: check.inputHash ?? null
        })) ?? []
      }
    });
  }
  let costEstimate = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0
  };
  let costEstimateAvailable = true;
  try {
    costEstimate = await primaryRuntimeProvider.provider.estimateCost({
      prompt: claimed.task.prompt,
      repositorySizeHint: 'small'
    });
  } catch (error) {
    costEstimateAvailable = false;
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    await repository.writeAudit({
      actorType: 'system',
      eventType: 'task_cost_estimate_unavailable',
      taskId: claimed.task.id,
      payload: { taskRunId: claimed.taskRun.id, message }
    });
  }
  const getRunUsageFields = () => ({
    inputTokens: measuredUsage.completeBreakdown ? measuredUsage.inputTokens : 0,
    outputTokens: measuredUsage.completeBreakdown ? measuredUsage.outputTokens : 0,
    totalTokens: measuredUsage.totalTokens,
    usageSource:
      measuredUsage.measurements === 0
        ? 'unavailable'
        : (measuredUsage.completeBreakdown ? 'actual_breakdown' : 'actual_total'),
    estimatedCostUsd: costEstimate.estimatedCostUsd,
    actualCostUsd:
      measuredUsage.measurements > 0 && measuredUsage.completeCost
        ? measuredUsage.actualCostUsd
        : null
  });

  try {
    const result = await runWorkerTask({
      project: claimed.project,
      task: claimed.task,
      providerKind: selection.primary.kind,
      provider,
      reviewProvider,
      workspaceRoot,
      implementationOwner: projectConfig?.workflow.implementation_owner ?? 'linux',
      implementOnWindows: projectConfig?.workflow.implementation_owner === 'windows'
        ? async (implementationInput) => implementThroughWindowsLease(windowsWorkers, {
            project: claimed.project, taskId: claimed.task.id, taskRunId: claimed.taskRun.id,
            workspacePath: `${workspaceRoot}/${claimed.task.id}`, prompt: implementationInput.prompt,
            acceptanceCriteria: implementationInput.plan.acceptanceCriteria, baseCommitSha: implementationInput.baseCommitSha,
            previousValidationError: implementationInput.previousValidationError, previousReviewBlockers: implementationInput.previousReviewBlockers,
            requiredCapabilities: projectConfig.workflow.windows_authoring_capabilities,
            requiresUnrealAssets: projectConfig.workflow.windows_authoring_requires_unreal_assets, signal: implementationInput.signal
          })
        : undefined,
      resourcePolicy,
      usageSummary: costEstimateAvailable
        ? `Pre-run estimate: ${costEstimate.inputTokens} input tokens, ${costEstimate.outputTokens} output tokens, ${costEstimate.estimatedCostUsd.toFixed(4)} USD`
        : 'Pre-run cost estimate unavailable; execution continued.',
      resume: resumeContext?.workflowResume,
      providerSession,
      reviewProviderSession: {
        provider: reviewerSelection.kind,
        model: reviewProviderModel
      },
      github,
      signal: taskAbortController.signal,
      hooks: {
        onActivity: async (activity) => {
          await repository.writeAudit({
            actorType: activity.phase === 'github' ? 'github' : 'agent',
            eventType: 'task_activity',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              phase: activity.phase,
              state: activity.state,
              title: activity.title,
              detail: activity.detail ?? null,
              operation: activity.operation ?? null,
              attempt: activity.attempt ?? null,
              elapsedMs: activity.elapsedMs ?? null,
              exitCode: activity.exitCode ?? null,
              metadata: activity.metadata ?? null
            }
          });
        },
        onStatus: async (status, payload = {}) => {
          throwIfTaskCancelled(taskAbortController.signal);
          await repository.transitionTask(claimed.task.id, status, payload);
        },
        onIterationStarted: async (iteration) => {
          await repository.writeAudit({
            actorType: 'agent',
            eventType: 'task_iteration_started',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              phase: iteration.phase,
              prompt: iteration.prompt,
              providerPrompt: iteration.providerPrompt ?? null,
              attempt: iteration.attempt
            }
          });
        },
        onIssue: async (issue) => {
          await repository.updateTaskGitHubFields(claimed.task.id, {
            githubIssueNumber: issue.issueNumber,
            githubIssueUrl: issue.issueUrl
          });
        },
        onBranch: async (branchName) => {
          await repository.updateTaskGitHubFields(claimed.task.id, { branchName });
        },
        onPullRequest: async (pullRequest) => {
          await repository.updateTaskGitHubFields(claimed.task.id, {
            pullRequestNumber: pullRequest.pullRequestNumber,
            pullRequestUrl: pullRequest.pullRequestUrl
          });
        },
        onGitHubOperationFailed: async (failure) => {
          const errorMessage = sanitizeAuditErrorMessage(failure.errorMessage);
          await repository.writeAudit({
            actorType: 'system',
            eventType: 'task_github_operation_failed',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              queueJobId: claimed.queueJobId ?? null,
              operation: failure.operation,
              errorMessage,
              provider: getLastProviderKind(),
              model: getLastProviderKind(),
              context: failure.context ?? null
            }
          });
        },
        onCheckpoint: async (checkpoint) => {
          await repository.recordTaskCheckpoint({
            taskId: claimed.task.id,
            taskRunId: claimed.taskRun.id,
            ...checkpoint
          });
        },
        onProviderActivity: async (activity) => {
          let normalizedUsage: ProviderUsageMeasurement | undefined;
          if (activity.usage) {
            const usage = normalizeProviderUsageMeasurement(activity.phase, activity.usage, cumulativeProviderTotals);
            normalizedUsage = usage;
            measuredUsage.measurements += 1;
            measuredUsage.totalTokens += usage.totalTokens;
            if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
              measuredUsage.completeBreakdown = false;
            } else {
              measuredUsage.inputTokens += usage.inputTokens;
              measuredUsage.outputTokens += usage.outputTokens;
              measuredUsage.cachedTokens += usage.cachedTokens ?? 0;
            }
            if (usage.actualCostUsd === undefined) {
              measuredUsage.completeCost = false;
            } else {
              measuredUsage.actualCostUsd += usage.actualCostUsd;
            }

            await repository.recordProviderUsage({
              taskId: claimed.task.id,
              taskRunId: claimed.taskRun.id,
              provider: usage.provider,
              model: usage.model,
              phase: activity.phase,
              attempt: activity.attempt,
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              cachedTokens: usage.cachedTokens ?? 0,
              totalTokens: usage.totalTokens,
              usageSource: usage.source,
              estimatedCostUsd: 0,
              actualCostUsd: usage.actualCostUsd
            });
          }
          const now = Date.now();
          if (activity.kind === 'workspace' && now - lastProviderActivityAuditAt < 1_500) {
            return;
          }
          if (activity.kind === 'workspace') {
            lastProviderActivityAuditAt = now;
          }
          await repository.writeAudit({
            actorType: 'agent',
            eventType: 'task_provider_activity',
            taskId: claimed.task.id,
            payload: {
              taskRunId: claimed.taskRun.id,
              phase: activity.phase,
              attempt: activity.attempt,
              kind: activity.kind,
              message: activity.message,
              elapsedMs: activity.elapsedMs,
              provider: activity.usage?.provider ?? (activity.phase === 'review' ? reviewerSelection.kind : getLastProviderKind()),
              usage: normalizedUsage
                ? {
                    provider: normalizedUsage.provider,
                    model: normalizedUsage.model,
                    totalTokens: normalizedUsage.totalTokens,
                    inputTokens: normalizedUsage.inputTokens ?? null,
                    outputTokens: normalizedUsage.outputTokens ?? null,
                    cachedTokens: normalizedUsage.cachedTokens ?? null,
                    source: normalizedUsage.source,
                    actualCostUsd: normalizedUsage.actualCostUsd ?? null
                  }
                : null
            }
          });
        },
        onIteration: async (iteration) => {
          iterationNumber += 1;
          const diffStat = iteration.diffStat && typeof iteration.diffStat === 'object' && !Array.isArray(iteration.diffStat) ? iteration.diffStat : {};
          changedFiles = Math.max(changedFiles, typeof diffStat.filesChanged === 'number' ? diffStat.filesChanged : 0);
          const currentDiffLines =
            (typeof diffStat.insertions === 'number' ? diffStat.insertions : 0) + (typeof diffStat.deletions === 'number' ? diffStat.deletions : 0);
          diffLines = Math.max(diffLines, currentDiffLines);

          const errorFingerprint = buildIterationErrorFingerprint(iteration.phase, iteration.validationResult);
          if (errorFingerprint) {
            repeatedErrorCount = errorFingerprint === lastErrorFingerprint ? repeatedErrorCount + 1 : 1;
            lastErrorFingerprint = errorFingerprint;
          } else {
            repeatedErrorCount = 0;
            lastErrorFingerprint = undefined;
          }

          await repository.createIteration({
            taskRunId: claimed.taskRun.id,
            iterationNumber,
            ...iteration
          });

          attemptCount = Math.max(attemptCount, extractAttemptNumber(iteration));

        }
      }
    });
    throwIfTaskCancelled(taskAbortController.signal);

    await recordTaskAcceptanceEvidence(repository, {
      project: claimed.project,
      taskId: claimed.task.id,
      taskRunId: claimed.taskRun.id,
      result
    });
    if (result.status !== 'failed' && result.status !== 'validation_failed') {
      const externalChecks = result.externalValidationChecks ?? [];
      await repository.setTaskDeferredValidationCapabilities(
        claimed.task.id,
        Array.from(new Set(externalChecks.flatMap((check) => ['windows', ...(check.requiredCapabilities ?? [])])))
      );
      try {
        await enqueueExternalWindowsValidations(repository, windowsWorkers, {
          project: claimed.project,
          taskId: claimed.task.id,
          taskRunId: claimed.taskRun.id,
          commitSha: result.commitSha,
          checks: externalChecks
        });
      } catch (error) {
        await repository.writeAudit({
          actorType: 'system', eventType: 'windows_validation_enqueue_failed', projectId: claimed.project.id, taskId: claimed.task.id,
          payload: { errorMessage: toErrorMessage(error), taskRunId: claimed.taskRun.id }
        });
      }
    }

    if (result.status === 'validation_failed') {
      await repository.transitionTask(claimed.task.id, 'validation_failed', {
        validation: {
          command: result.validation.command,
          exitCode: result.validation.exitCode,
          stdout: result.validation.stdout,
          stderr: result.validation.stderr,
          passed: result.validation.passed
        }
      });
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'failed',
        summary: result.summary,
        errorMessage: result.validation.stderr || 'Validation failed.',
        runState: createBlockedRunState('validation_failed', result.validation.stderr || 'Validation failed.'),
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('failed', result.validation.stderr || 'Validation failed.', false);
    } else if (result.status === 'failed') {
      await repository.failTask(claimed.task.id, result.summary, 'failed');
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'failed',
        summary: result.summary,
        errorMessage: result.summary,
        runState: createFailedRunState('unknown', result.summary),
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('failed', result.summary, false);
    } else {
      await repository.transitionTask(claimed.task.id, 'ready_for_user_review', {
        pullRequestUrl: result.pullRequestUrl ?? null,
        branchName: result.branchName,
        implementationResult: result.implementationResult ?? null,
        deliveryResult: result.deliveryResult ?? null
      });
      if (result.status === 'completed') {
        await repository.transitionTask(claimed.task.id, 'completed');
        await repository.recordCompletedTaskProjectMemory({
          taskId: claimed.task.id,
          summary: result.summary,
          commitSha: result.commitSha,
          architectureUpdate: result.architectureUpdate
        });
        await advanceRoadmapAfterTaskCompletion(repository, claimed.task.id);
      }
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'succeeded',
        summary: result.summary,
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('succeeded');
      if (result.status === 'completed') {
        await cleanupCompletedTaskWorkspace(workspaceRoot, claimed.task.id);
      }
    }

    return {
      claimed: true,
      taskId: claimed.task.id,
      result
    };
  } catch (error) {
    if (error instanceof TaskCancellationError || taskAbortController.signal.aborted) {
      await repository.finishTaskRun({
        taskRunId: claimed.taskRun.id,
        status: 'cancelled',
        errorMessage: 'Task cancelled by user.',
        iterationCount: attemptCount,
        ...getRunUsageFields()
      });
      await finalizeQueueJob('cancelled', 'Task cancelled by user.');
      return {
        claimed: true,
        taskId: claimed.task.id,
        status: 'cancelled'
      };
    }
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    const status = error instanceof ProviderExecutionError ? 'provider_failed' : 'failed';
    await repository.failTask(claimed.task.id, message, status);
    await repository.finishTaskRun({
      taskRunId: claimed.taskRun.id,
      status: 'failed',
      errorMessage: message,
      runState: createBlockedRunState(resolveBlockedRunReason(status), message),
      iterationCount: attemptCount,
      ...getRunUsageFields()
    });
    await finalizeQueueJob('failed', message, !(error instanceof ProviderExecutionError) || error.retryable);
    return {
      claimed: true,
      taskId: claimed.task.id,
      status
    };
  }
}

async function runNextProjectAudit(input: {
  repository: ForgeMindRepository;
  defaultConnection?: AIProviderConnectionSecret;
  providerOverride?: ProviderKind;
  fallbackProviderOverride?: ProviderKind;
  providerConnectionIdOverride?: string;
  fallbackProviderConnectionIdOverride?: string;
}) {
  const claimed = await input.repository.claimNextProjectAudit();
  if (!claimed) return undefined;

  const stopAuditHeartbeat = startProjectAuditHeartbeat(
    input.repository,
    claimed.job.id,
    Number(process.env.FORGEMIND_QUEUE_CLAIM_TIMEOUT_MINUTES ?? 2)
  );
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const contract = claimed.project.projectContract;
    if (!contract) throw new Error('Project contract is required before the completion audit can run.');
    const githubConnection = await input.repository.getGitHubConnectionSecret();
    const github = githubConnection
      ? new GitHubAppAdapter({ token: githubConnection.token, apiBaseUrl: githubConnection.apiBaseUrl })
      : await createGitHubAdapterFromEnv();
    const projectConfig = parseProjectConfig(claimed.project.configYaml);
    const selection = await resolveProviderSelection({
      repository: input.repository,
      projectConfig,
      projectProviderConnectionId: claimed.project.aiProviderConnectionId,
      defaultConnection: input.defaultConnection,
      providerOverride: input.providerOverride,
      fallbackProviderOverride: input.fallbackProviderOverride,
      providerConnectionIdOverride: input.providerConnectionIdOverride,
      fallbackProviderConnectionIdOverride: input.fallbackProviderConnectionIdOverride
    });
    const { provider, getLastProviderKind } = createPolicyAwareProvider({
      primary: buildRuntimeProvider(selection.primary.kind, selection.primary.connection),
      fallback: selection.fallback ? buildRuntimeProvider(selection.fallback.kind, selection.fallback.connection) : undefined,
      audit: (event) => input.repository.writeAudit({
        actorType: 'system',
        eventType: event.eventType,
        projectId: claimed.project.id,
        taskId: claimed.job.triggerTaskId,
        payload: {
          auditJobId: claimed.job.id,
          cycleId: claimed.cycle.id,
          ...event.payload
        }
      })
    });
    const nativeRepositoryAudit = provider.supportsNativeRepositoryAudit?.() === true;
    const triggerTask = claimed.job.triggerTaskId
      ? await input.repository.getTask(claimed.job.triggerTaskId)
      : undefined;
    const workspace = await prepareCapabilityAuditWorkspace({
      workspaceRoot: resolveWorkerWorkspaceRoot(),
      project: claimed.project,
      github,
      preferredBranch: triggerTask?.branchName,
      includeRepositoryContext: !nativeRepositoryAudit
    });
    cleanup = workspace.cleanup;

    let lastActivityAt = 0;
    const onActivity = async (activity: { kind: string; message: string; elapsedMs: number }) => {
      const now = Date.now();
      if (activity.kind !== 'lifecycle' && now - lastActivityAt < 2_000) return;
      lastActivityAt = now;
      await input.repository.writeAudit({
        actorType: 'agent',
        eventType: 'project_audit_activity',
        projectId: claimed.project.id,
        taskId: claimed.job.triggerTaskId,
        payload: {
          auditJobId: claimed.job.id,
          cycleId: claimed.cycle.id,
          kind: activity.kind,
          message: activity.message.slice(0, 4_000),
          elapsedMs: activity.elapsedMs
        }
      });
    };

    const targetRequirementIds = new Set(
      claimed.job.requirementIds.length > 0
        ? claimed.job.requirementIds
        : activeProjectContractRequirements(contract).map((requirement) => requirement.id)
    );
    let deferredRequirementCount = 0;
    for (const requirement of contract.requirements.filter((item) => targetRequirementIds.has(item.id))) {
      const roadmap = await input.repository.getProjectRoadmap(claimed.project.id);
      const capability = roadmap?.capabilities.find((item) => item.requirement.id === requirement.id);
      if (capability?.status === 'satisfied') continue;

      const requirementWorkItems = (roadmap?.steps ?? []).filter((step) =>
        step.requirementIds.includes(requirement.id)
      );
      if (requirementWorkItems.some((step) => step.status === 'pending' || step.status === 'running')) {
        deferredRequirementCount += 1;
        continue;
      }
      const workItems = requirementWorkItems.filter((step) => step.status === 'completed');
      const audit = await runCapabilityAudit({
        repository: input.repository,
        provider,
        project: claimed.project,
        cycleId: claimed.cycle.id,
        requirement,
        workItems,
        workspacePath: workspace.workspacePath,
        commitSha: workspace.commitSha,
        repositoryContext: nativeRepositoryAudit ? undefined : workspace.repositoryContext,
        supplementalContext: formatProjectArchitectureContext(
          claimed.project.projectArchitecture,
          `${requirement.title} ${requirement.description}`
        ),
        onActivity
      });

      if (audit.verdict === 'blocked') {
        await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', audit.summary);
        return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
      }
      if (audit.verdict === 'partial') {
        const steps = audit.gapWorkItems.map((step) => ({
          title: step.title,
          description: formatGapStepDescription(step),
          acceptanceCriteria: step.acceptanceCriteria,
          requirementIds: step.requirementIds,
          deliverables: step.deliverables,
          changeRationale: step.changeRationale,
          dependsOnStepTitles: step.dependsOnStepTitles,
          validationFocus: step.validationFocus
        }));
        if (steps.length === 0) {
          const message = 'Capability audit found a gap but did not produce a new, traceable work item.';
          await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', message);
          return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
        }
        await input.repository.saveProjectAuditGapProposal(claimed.job.id, {
          kind: 'capability', summary: audit.summary, commitSha: workspace.commitSha, newRequirements: [],
          steps: audit.gapWorkItems.map((step) => ({
            title: step.title,
            description: formatGapStepDescription(step),
            acceptanceCriteria: step.acceptanceCriteria,
            requirementIds: step.requirementIds,
            deliverables: step.deliverables,
            changeRationale: step.changeRationale,
            dependsOnStepTitles: step.dependsOnStepTitles,
            validationFocus: step.validationFocus
          }))
        });
        await input.repository.updateProjectRoadmapCycleStatus(claimed.cycle.id, 'partial');
        await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
        return {
          claimed: true,
          kind: 'project_audit',
          projectId: claimed.project.id,
          status: 'gaps_proposed',
          gapStepCount: steps.length,
          provider: getLastProviderKind()
        };
      }
    }

    const finalRoadmap = await input.repository.getProjectRoadmap(claimed.project.id);
    const remainingSteps = finalRoadmap?.steps.filter((step) =>
      step.cycleId === claimed.cycle.id && (step.status === 'pending' || step.status === 'running')
    ) ?? [];
    if (remainingSteps.length > 0) {
      await input.repository.updateProjectRoadmapCycleStatus(claimed.cycle.id, 'active');
      await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
      const nextTask = await startNextRoadmapStep(input.repository, claimed.project.id, claimed.cycle.id);
      return {
        claimed: true,
        kind: 'project_audit',
        projectId: claimed.project.id,
        status: deferredRequirementCount > 0 ? 'roadmap_continued' : 'capabilities_satisfied',
        nextTaskId: nextTask?.id,
        provider: getLastProviderKind()
      };
    }
    const allSatisfied = Boolean(finalRoadmap?.capabilities.length)
      && finalRoadmap!.capabilities.every((capability) => capability.status === 'satisfied');
    if (!allSatisfied) throw new Error('Capability audit finished without satisfying every project requirement.');

    if (!hasSatisfiedReleaseAudit(finalRoadmap?.evidence ?? [], contract, workspace.commitSha)) {
      const releaseAudit = await runReleaseAudit({
        repository: input.repository,
        provider,
        project: claimed.project,
        cycleId: claimed.cycle.id,
        workspacePath: workspace.workspacePath,
        commitSha: workspace.commitSha,
        repositoryContext: nativeRepositoryAudit ? undefined : workspace.repositoryContext,
        supplementalContext: formatProjectArchitectureContext(claimed.project.projectArchitecture, contract.summary),
        onActivity
      });
      if (releaseAudit.verdict === 'blocked') {
        await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', releaseAudit.summary);
        return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
      }
      if (releaseAudit.verdict === 'partial') {
        const steps = releaseAudit.gapWorkItems.map((step) => ({
          title: step.title, description: formatGapStepDescription(step), acceptanceCriteria: step.acceptanceCriteria,
          requirementIds: step.requirementIds, deliverables: step.deliverables, changeRationale: step.changeRationale,
          dependsOnStepTitles: step.dependsOnStepTitles, validationFocus: step.validationFocus
        }));
        if (steps.length === 0) {
          const message = 'Release audit found a gap but did not produce a new, traceable work item.';
          await input.repository.finalizeProjectAudit(claimed.job.id, 'blocked', message);
          return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'blocked', provider: getLastProviderKind() };
        }
        await input.repository.saveProjectAuditGapProposal(claimed.job.id, {
          kind: 'release', summary: releaseAudit.summary, commitSha: workspace.commitSha,
          newRequirements: releaseAudit.contractAmendments,
          steps: releaseAudit.gapWorkItems.map((step) => ({
            title: step.title,
            description: formatGapStepDescription(step),
            acceptanceCriteria: step.acceptanceCriteria,
            requirementIds: step.requirementIds,
            deliverables: step.deliverables,
            changeRationale: step.changeRationale,
            dependsOnStepTitles: step.dependsOnStepTitles,
            validationFocus: step.validationFocus
          }))
        });
        await input.repository.updateProjectRoadmapCycleStatus(claimed.cycle.id, 'partial');
        await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
        return {
          claimed: true,
          kind: 'project_audit',
          projectId: claimed.project.id,
          status: 'release_gaps_proposed',
          gapStepCount: steps.length,
          provider: getLastProviderKind()
        };
      }
    }

    const planningProviderModel = resolveProviderModel(selection.primary.kind, selection.primary.connection);
    const planningConnectionId = selection.primary.connection?.id;
    const hasCompatiblePlanningSession = claimed.project.planningSessionProvider === selection.primary.kind
      && claimed.project.planningSessionModel === planningProviderModel
      && claimed.project.planningSessionConnectionId === planningConnectionId;
    const planningSession: ProviderSessionContext = {
      id: hasCompatiblePlanningSession ? claimed.project.planningSessionId : undefined,
      provider: selection.primary.kind,
      model: planningProviderModel,
      onUpdate: async (session) => {
        const connectionId = session.provider === selection.primary.kind
          ? selection.primary.connection?.id
          : selection.fallback?.connection?.id;
        await input.repository.updateProjectPlanningSession({
          projectId: claimed.project.id,
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          connectionId
        });
      }
    };
    const extensionPlan = await provider.plan({
      taskId: `project-extension:${claimed.cycle.id}`,
      title: `Next extension for ${claimed.project.name}`,
      prompt: buildProjectExtensionProposalPrompt({
        projectName: claimed.project.name,
        completedObjective: claimed.cycle.objective,
        contractVersion: contract.version,
        contractSummary: contract.summary,
        completedCapabilities: activeProjectContractRequirements(contract).map((requirement) => requirement.title),
        projectBrief: claimed.project.brief,
        continuation: hasCompatiblePlanningSession
      }),
      repositoryPath: workspace.workspacePath,
      onActivity,
      session: planningSession
    });
    const extensionProposal = formatProjectExtensionProposal(extensionPlan);
    await input.repository.updateProjectRoadmapCycleStatus(claimed.cycle.id, 'completed');
    await input.repository.setProjectRoadmapCycleExtensionProposal(claimed.cycle.id, {
      proposal: extensionProposal,
      status: 'awaiting_extension_decision'
    });
    await input.repository.finalizeProjectAudit(claimed.job.id, 'succeeded');
    return { claimed: true, kind: 'project_audit', projectId: claimed.project.id, status: 'awaiting_extension_decision', provider: getLastProviderKind() };
  } catch (error) {
    const message = sanitizeAuditErrorMessage(toErrorMessage(error));
    const finalized = await input.repository.finalizeProjectAudit(claimed.job.id, 'failed', message);
    return {
      claimed: true,
      kind: 'project_audit',
      projectId: claimed.project.id,
      status: finalized.retryScheduled ? 'retry_scheduled' : 'failed',
      errorMessage: message
    };
  } finally {
    stopAuditHeartbeat();
    await cleanup?.();
  }
}

function formatGapStepDescription(step: {
  description: string;
  inScope: string[];
  outOfScope: string[];
}): string {
  return [
    step.description,
    step.inScope.length > 0 ? `In scope:\n${step.inScope.map((item) => `- ${item}`).join('\n')}` : '',
    step.outOfScope.length > 0 ? `Out of scope:\n${step.outOfScope.map((item) => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
}

interface RuntimeProvider {
  kind: ProviderKind;
  contextId: string;
  connectionId: string | null;
  model: string | null;
  provider: AIProvider;
}

function buildRuntimeProvider(kind: ProviderKind, connection?: AIProviderConnectionSecret): RuntimeProvider {
  const contextId = connection?.id ?? `${kind}:env`;

  return {
    kind,
    contextId,
    connectionId: connection?.id ?? null,
    model: resolveProviderModel(kind, connection),
    provider: createProvider(kind, connection?.provider === kind ? {
      apiKey: connection.apiKey,
      authMode: connection.authMode,
      codexHome: connection.codexHome,
      model: connection.model
    } : undefined)
  };
}

interface ProviderPolicyAuditEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

interface PolicyAwareProviderInput {
  primary: RuntimeProvider;
  fallback?: RuntimeProvider;
  audit?: (event: ProviderPolicyAuditEvent) => Promise<unknown>;
}

function createPolicyAwareProvider(input: PolicyAwareProviderInput): { provider: AIProvider; getLastProviderKind: () => ProviderKind } {
  let lastProviderKind: ProviderKind = input.primary.kind;
  const failureThreshold = clampNumber(Number(process.env.FORGEMIND_PROVIDER_CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? 3), 1, 10);
  const openMs = clampNumber(Number(process.env.FORGEMIND_PROVIDER_CIRCUIT_BREAKER_OPEN_MS ?? 300_000), 1_000, 3_600_000);

  const callWithFallback = async <T>(operation: string, action: (provider: AIProvider) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const primaryBreaker = getProviderCircuitBreaker(input.primary.contextId, failureThreshold);
    const primaryAvailability = resolveCircuitBreakerAvailability(primaryBreaker);
    if (primaryAvailability.state === 'open') {
      await auditProviderCircuitBreaker(input, input.primary, operation, 'primary_skipped', primaryBreaker);
      return callFallbackOrThrow(operation, action, signal, new ProviderExecutionError(operation, 'circuit breaker is open', input.primary.kind, true), true);
    }

    try {
      const result = await action(input.primary.provider);
      lastProviderKind = input.primary.kind;
      await recordProviderSuccess(input, input.primary, operation, primaryBreaker);
      return result;
    } catch (primaryError) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new TaskCancellationError();
      }
      const normalizedPrimaryError = normalizeProviderError(input.primary.kind, primaryError);
      await recordProviderFailure(input, input.primary, operation, primaryBreaker, normalizedPrimaryError.toDetails(), openMs);
      return callFallbackOrThrow(operation, action, signal, primaryError, normalizedPrimaryError.retryable);
    }
  };

  const callFallbackOrThrow = async <T>(
    operation: string,
    action: (provider: AIProvider) => Promise<T>,
    signal: AbortSignal | undefined,
    primaryError: unknown,
    primaryIsRetryable: boolean
  ): Promise<T> => {
    const fallback = input.fallback;
    const shouldUseFallback = Boolean(
      primaryIsRetryable
      && fallback
      && providersAreSemanticallyEquivalent(input.primary, fallback)
      && (fallback.kind !== input.primary.kind || fallback.contextId !== input.primary.contextId)
    );
    if (fallback && shouldUseFallback) {
      const fallbackBreaker = getProviderCircuitBreaker(fallback.contextId, failureThreshold);
      const fallbackAvailability = resolveCircuitBreakerAvailability(fallbackBreaker);
      if (fallbackAvailability.state === 'open') {
        await auditProviderCircuitBreaker(input, fallback, operation, 'primary_skipped', fallbackBreaker);
        throw new ProviderExecutionError(operation, 'primary and fallback circuit breakers are open', input.primary.kind, true);
      }
      await input.audit?.({
        eventType: 'provider_fallback_used',
        payload: {
          operation,
          primaryProvider: input.primary.kind,
          primaryConnectionId: input.primary.connectionId,
          fallbackProvider: fallback.kind,
          fallbackConnectionId: fallback.connectionId,
          fallbackModel: fallback.model,
          policy: 'semantically_equivalent_same_operation_retryable_primary_failure'
        }
      });
      try {
        const result = await action(fallback.provider);
        lastProviderKind = fallback.kind;
        await recordProviderSuccess(input, fallback, operation, fallbackBreaker);
        return result;
      } catch (fallbackError) {
        const normalizedFallbackError = normalizeProviderError(fallback.kind, fallbackError);
        await recordProviderFailure(input, fallback, operation, fallbackBreaker, normalizedFallbackError.toDetails(), openMs);
        throw new ProviderExecutionError(operation, toErrorMessage(fallbackError), fallback.kind, normalizedFallbackError.retryable);
      }
    }

    if (fallback && primaryIsRetryable && !providersAreSemanticallyEquivalent(input.primary, fallback)) {
      await input.audit?.({
        eventType: 'provider_fallback_skipped',
        payload: {
          operation,
          primaryProvider: input.primary.kind,
          primaryConnectionId: input.primary.connectionId,
          primaryModel: input.primary.model,
          fallbackProvider: fallback.kind,
          fallbackConnectionId: fallback.connectionId,
          fallbackModel: fallback.model,
          reason: 'fallback_not_semantically_equivalent'
        }
      });
    }

    throw new ProviderExecutionError(operation, toErrorMessage(primaryError), input.primary.kind, primaryIsRetryable);
  };

  const provider: AIProvider = {
    kind: input.primary.kind,
    async preflight(signal) {
      return callWithFallback('preflight', (provider) => provider.preflight(signal), signal);
    },
    supportsLocalRepo: () => input.primary.provider.supportsLocalRepo(),
    supportsGitHubNativeFlow: () => input.primary.provider.supportsGitHubNativeFlow(),
    supportsNativeRepositoryAudit: () => input.primary.provider.supportsNativeRepositoryAudit?.() === true,
    async plan(planInput) {
      return callWithFallback('plan', (provider) => provider.plan(planInput), planInput.signal);
    },
    async implement(implementInput) {
      return callWithFallback('implement', (provider) => provider.implement(implementInput), implementInput.signal);
    },
    async review(reviewInput) {
      return callWithFallback('review', (provider) => provider.review(reviewInput), reviewInput.signal);
    },
    async auditCapability(auditInput) {
      return callWithFallback('audit_capability', async (provider) => {
        if (!provider.auditCapability) throw new Error('Configured provider does not support capability audits.');
        return provider.auditCapability(await prepareAuditInputForProvider(provider, auditInput));
      });
    },
    async auditRelease(auditInput) {
      return callWithFallback('audit_release', async (provider) => {
        if (!provider.auditRelease) throw new Error('Configured provider does not support release audits.');
        return provider.auditRelease(await prepareAuditInputForProvider(provider, auditInput));
      });
    },
    async estimateCost(costInput) {
      return callWithFallback('estimate_cost', (provider) => provider.estimateCost(costInput));
    }
  };

  return {
    provider,
    getLastProviderKind: () => lastProviderKind
  };
}

async function prepareAuditInputForProvider<T extends CapabilityAuditInput | ReleaseAuditInput>(
  provider: AIProvider,
  input: T
): Promise<T> {
  if (provider.supportsNativeRepositoryAudit?.() === true) {
    return { ...input, repositoryAccess: 'read_only_checkout' };
  }

  const repositoryContext = input.repositoryContext?.trim()
    ? input.repositoryContext
    : await buildCompleteRepositoryContext(input.repositoryPath);
  return {
    ...input,
    repositoryAccess: 'complete_snapshot',
    repositoryContext
  };
}

function providersAreSemanticallyEquivalent(primary: RuntimeProvider, fallback: RuntimeProvider): boolean {
  return primary.kind === fallback.kind && primary.model === fallback.model;
}

interface ProviderCircuitBreakerRuntimeState extends ProviderCircuitBreakerSnapshot {
  halfOpenInFlight?: boolean;
}

const providerCircuitBreakers = new Map<string, ProviderCircuitBreakerRuntimeState>();

export function resetProviderCircuitBreakersForTests(): void {
  if (process.env.NODE_ENV === 'test') providerCircuitBreakers.clear();
}

function getProviderCircuitBreaker(contextId: string, failureThreshold: number): ProviderCircuitBreakerRuntimeState {
  const existing = providerCircuitBreakers.get(contextId);
  if (existing) {
    existing.failureThreshold = failureThreshold;
    return existing;
  }
  const created: ProviderCircuitBreakerRuntimeState = {
    state: 'closed',
    failureCount: 0,
    failureThreshold
  };
  providerCircuitBreakers.set(contextId, created);
  return created;
}

function resolveCircuitBreakerAvailability(state: ProviderCircuitBreakerRuntimeState): { state: 'closed' | 'open' | 'half_open' } {
  if (state.state !== 'open' || !state.openedUntil) return { state: state.state };
  const openedUntilMs = Date.parse(state.openedUntil);
  if (Number.isFinite(openedUntilMs) && openedUntilMs > Date.now()) return { state: 'open' };
  if (state.halfOpenInFlight) return { state: 'open' };
  state.state = 'half_open';
  state.halfOpenInFlight = true;
  return { state: 'half_open' };
}

async function recordProviderSuccess(
  input: PolicyAwareProviderInput,
  runtimeProvider: RuntimeProvider,
  operation: string,
  breaker: ProviderCircuitBreakerRuntimeState
): Promise<void> {
  const wasRecovering = breaker.state !== 'closed' || breaker.failureCount > 0;
  breaker.state = 'closed';
  breaker.failureCount = 0;
  breaker.openedAt = undefined;
  breaker.openedUntil = undefined;
  breaker.lastFailureAt = undefined;
  breaker.lastFailureKind = undefined;
  breaker.lastFailureMessage = undefined;
  breaker.halfOpenInFlight = false;
  await input.audit?.({
    eventType: 'provider_request_succeeded',
    payload: {
      operation,
      provider: runtimeProvider.kind,
      connectionId: runtimeProvider.connectionId,
      model: runtimeProvider.model,
      circuitBreaker: snapshotProviderCircuitBreaker(breaker),
      recoveredCircuitBreaker: wasRecovering
    }
  });
}

async function recordProviderFailure(
  input: PolicyAwareProviderInput,
  runtimeProvider: RuntimeProvider,
  operation: string,
  breaker: ProviderCircuitBreakerRuntimeState,
  error: NormalizedProviderErrorDetails,
  openMs: number
): Promise<void> {
  const now = new Date();
  breaker.failureCount = Math.min(breaker.failureCount + 1, breaker.failureThreshold);
  breaker.lastFailureAt = now.toISOString();
  breaker.lastFailureKind = error.kind;
  breaker.lastFailureMessage = error.auditSafeMessage;
  breaker.halfOpenInFlight = false;
  if (error.retryable && breaker.failureCount >= breaker.failureThreshold) {
    breaker.state = 'open';
    breaker.openedAt = now.toISOString();
    breaker.openedUntil = new Date(now.getTime() + openMs).toISOString();
  } else if (breaker.state === 'half_open') {
    breaker.state = 'open';
    breaker.openedAt = now.toISOString();
    breaker.openedUntil = new Date(now.getTime() + openMs).toISOString();
  }

  await auditProviderCircuitBreaker(input, runtimeProvider, operation, 'failure_recorded', breaker, error);
}

async function auditProviderCircuitBreaker(
  input: PolicyAwareProviderInput,
  runtimeProvider: RuntimeProvider,
  operation: string,
  reason: 'failure_recorded' | 'primary_skipped',
  breaker: ProviderCircuitBreakerRuntimeState,
  error?: NormalizedProviderErrorDetails
): Promise<void> {
  await input.audit?.({
    eventType: 'provider_circuit_breaker_state',
    payload: {
      operation,
      reason,
      provider: runtimeProvider.kind,
      connectionId: runtimeProvider.connectionId,
      model: runtimeProvider.model,
      circuitBreaker: snapshotProviderCircuitBreaker(breaker),
      error: error
        ? {
            kind: error.kind,
            retryable: error.retryable,
            statusCode: error.statusCode ?? null,
            auditSafeMessage: error.auditSafeMessage
          }
        : null
    }
  });
}

function snapshotProviderCircuitBreaker(state: ProviderCircuitBreakerRuntimeState): ProviderCircuitBreakerSnapshot {
  return {
    state: state.state,
    failureCount: state.failureCount,
    failureThreshold: state.failureThreshold,
    openedAt: state.openedAt,
    openedUntil: state.openedUntil,
    lastFailureAt: state.lastFailureAt,
    lastFailureKind: state.lastFailureKind,
    lastFailureMessage: state.lastFailureMessage
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseProjectConfig(configYaml?: string): AgentConfig | undefined {
  if (!configYaml) return undefined;

  try {
    return parseAgentConfigYaml(configYaml);
  } catch {
    return undefined;
  }
}

async function readAIProviderConnectionSecret(repository: {
  getAIProviderConnectionSecret?: () => Promise<AIProviderConnectionSecret | undefined>;
}): Promise<AIProviderConnectionSecret | undefined> {
  return repository.getAIProviderConnectionSecret ? repository.getAIProviderConnectionSecret() : undefined;
}

async function readAIProviderConnectionSecretById(
  repository: {
    getAIProviderConnectionSecretById?: (connectionId: string) => Promise<AIProviderConnectionSecret | undefined>;
  },
  connectionId: string
): Promise<AIProviderConnectionSecret | undefined> {
  return repository.getAIProviderConnectionSecretById ? repository.getAIProviderConnectionSecretById(connectionId) : undefined;
}

async function resolveProviderSelection(input: {
  repository: {
    getAIProviderConnectionSecretById?: (connectionId: string) => Promise<AIProviderConnectionSecret | undefined>;
  };
  projectConfig: AgentConfig | undefined;
  projectProviderConnectionId?: string;
  defaultConnection?: AIProviderConnectionSecret;
  providerOverride?: ProviderKind;
  fallbackProviderOverride?: ProviderKind;
  providerConnectionIdOverride?: string;
  fallbackProviderConnectionIdOverride?: string;
}): Promise<{
  primary: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
  fallback?: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
}> {
  const primaryConnectionId = input.providerConnectionIdOverride
    ?? input.projectConfig?.ai.primary_connection_id?.trim()
    ?? input.projectProviderConnectionId;
  const primaryConnection = primaryConnectionId
    ? await readAIProviderConnectionSecretById(input.repository, primaryConnectionId)
    : input.defaultConnection;

  if (primaryConnectionId && !primaryConnection) {
    throw new Error(`Primary provider connection "${primaryConnectionId}" does not exist.`);
  }

  const primaryKind = input.providerOverride
    ?? primaryConnection?.provider
    ?? input.projectConfig?.ai.primary_provider
    ?? 'codex';
  const normalizedPrimaryConnection = primaryConnection?.provider === primaryKind ? primaryConnection : undefined;

  const fallbackConnectionId = input.fallbackProviderConnectionIdOverride
    ?? input.projectConfig?.ai.fallback_connection_id?.trim();
  const fallbackConnection = fallbackConnectionId
    ? await readAIProviderConnectionSecretById(input.repository, fallbackConnectionId)
    : undefined;

  if (fallbackConnectionId && !fallbackConnection) {
    throw new Error(`Fallback provider connection "${fallbackConnectionId}" does not exist.`);
  }

  const fallbackKind = input.fallbackProviderOverride
    ?? fallbackConnection?.provider
    ?? input.projectConfig?.ai.fallback_provider;

  if (!fallbackKind) {
    return { primary: { kind: primaryKind, connection: normalizedPrimaryConnection } };
  }

  const normalizedFallbackConnection = fallbackConnection?.provider === fallbackKind ? fallbackConnection : undefined;
  const hasDistinctFallback =
    fallbackKind !== primaryKind
    || (normalizedFallbackConnection?.id ?? null) !== (normalizedPrimaryConnection?.id ?? null);

  if (!hasDistinctFallback) {
    return { primary: { kind: primaryKind, connection: normalizedPrimaryConnection } };
  }

  return {
    primary: { kind: primaryKind, connection: normalizedPrimaryConnection },
    fallback: { kind: fallbackKind, connection: normalizedFallbackConnection }
  };
}

async function resolveReviewerSelection(input: {
  repository: {
    getAIProviderConnectionSecretById?: (connectionId: string) => Promise<AIProviderConnectionSecret | undefined>;
  };
  projectConfig: AgentConfig | undefined;
  primary: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
  fallback?: { kind: ProviderKind; connection?: AIProviderConnectionSecret };
  defaultConnection?: AIProviderConnectionSecret;
}): Promise<{ kind: ProviderKind; connection?: AIProviderConnectionSecret }> {
  const kind = input.projectConfig?.ai.reviewer_provider ?? input.primary.kind;
  const connectionId = input.projectConfig?.ai.reviewer_connection_id?.trim();
  if (connectionId) {
    const connection = await readAIProviderConnectionSecretById(input.repository, connectionId);
    if (!connection) throw new Error(`Reviewer provider connection "${connectionId}" does not exist.`);
    if (connection.provider !== kind) {
      throw new Error(`Reviewer provider connection "${connectionId}" is configured for ${connection.provider}, not ${kind}.`);
    }
    return { kind, connection };
  }
  if (input.primary.kind === kind) return { kind, connection: input.primary.connection };
  if (input.fallback?.kind === kind) return { kind, connection: input.fallback.connection };
  if (input.defaultConnection?.provider === kind) return { kind, connection: input.defaultConnection };
  return { kind };
}

function resolveProviderModel(provider: ProviderKind, connection: AIProviderConnectionSecret | undefined): string {
  if (connection?.provider === provider) {
    return connection.model;
  }

  if (provider === 'github_copilot' && process.env.COPILOT_MODEL) {
    return process.env.COPILOT_MODEL;
  }

  if (provider === 'openai' && process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL;
  }

  if (provider === 'codex' && process.env.CODEX_MODEL) {
    return process.env.CODEX_MODEL;
  }

  if (provider === 'github_copilot') {
    return 'gpt-5.4';
  }

  return provider;
}

class ProviderExecutionError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly providerKind: ProviderKind,
    readonly retryable: boolean
  ) {
    super(`Provider ${providerKind} ${operation} failed: ${message}`);
    this.name = 'ProviderExecutionError';
  }
}
