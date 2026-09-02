import type { ProjectArchitectureUpdate } from '@forgemind/core';
import type { ReviewResult, ValidationCheck } from '@forgemind/providers';
import type { JsonValue } from '@forgemind/shared';
import { formatValidationFailure } from '../validation.js';
import type { WorkerTaskResume } from '../workflow.js';

export interface TaskResumeContext {
  workflowResume: WorkerTaskResume;
}

export interface TaskDiffIterationSnapshot {
  phase: string;
  prompt: string;
  resultSummary: string;
  diffStat?: unknown;
  validationResult: unknown;
  createdAt?: string;
}

export interface TaskAuditSnapshot {
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface PlannedValidationCheckSnapshot {
  kind?: string;
  command?: string;
  instructions?: string;
  criterion?: string;
  rationale?: string;
  category?: string;
  shell?: string;
  continueOnFailure?: boolean;
  timeoutMinutes?: number;
}

export interface TaskCheckpointSnapshot {
  key: string;
  phase: string;
  status: 'started' | 'completed' | 'failed';
  inputHash: string;
  output?: unknown;
}

export async function resolveTaskResumeContext(
  repository: {
    listTaskAudit: (taskId: string) => Promise<TaskAuditSnapshot[]>;
    getTaskDiff: (taskId: string) => Promise<{
      iterations: TaskDiffIterationSnapshot[];
    }>;
    listTaskCheckpoints?: (taskId: string) => Promise<TaskCheckpointSnapshot[]>;
  },
  taskId: string,
  queueReason?: string,
  currentTaskRunId?: string
): Promise<TaskResumeContext | undefined> {
  const [diff, audit, checkpoints] = await Promise.all([
    repository.getTaskDiff(taskId),
    repository.listTaskAudit(taskId),
    repository.listTaskCheckpoints?.(taskId) ?? Promise.resolve([])
  ]);
  const lastPlanningIteration = findLastIteration(diff.iterations, 'planning');
  const lastImplementationIteration = findLastIteration(diff.iterations, 'implementation');
  const lastValidationIteration = findLastIteration(diff.iterations, 'validation');
  const lastReviewIteration = findLastIteration(diff.iterations, 'review');
  const architectureUpdate = extractArchitectureUpdate(lastImplementationIteration);
  const implementationResume = extractImplementationResume(lastImplementationIteration);

  if (queueReason === 'task_retried' || queueReason === 'worker_interrupted' || queueReason === 'phase_retry') {
    const phaseRetryResume = buildPhaseRetryResume(
      diff.iterations,
      audit,
      currentTaskRunId,
      checkpoints
    );
    if (phaseRetryResume) {
      return {
        workflowResume: phaseRetryResume
      };
    }
  }

  if (queueReason === 'worker_interrupted') {
    return {
      workflowResume: {
        kind: 'worker_interrupted',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary:
          lastImplementationIteration?.resultSummary
          ?? 'Continue the implementation preserved in the workspace after the worker was interrupted.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate
      }
    };
  }

  if (queueReason === 'task_retried' && lastImplementationIteration && isFailedValidationIteration(lastValidationIteration)) {
    return {
      workflowResume: {
        kind: 'validation_retry',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary: lastImplementationIteration.resultSummary || 'Resume the preserved implementation for validation.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate
      }
    };
  }

  return undefined;
}

function buildPhaseRetryResume(
  iterations: TaskDiffIterationSnapshot[],
  audit: TaskAuditSnapshot[],
  currentTaskRunId?: string,
  checkpoints: TaskCheckpointSnapshot[] = []
): WorkerTaskResume | undefined {
  const completedIterations = [...iterations].sort((left, right) => timestampOf(left.createdAt) - timestampOf(right.createdAt));
  const latestIteration = completedIterations.at(-1);
  const latestImplementation = findLastIteration(completedIterations, 'implementation');
  const latestValidation = findLastIteration(completedIterations, 'validation');
  const latestValidationPayload = asRecord(latestValidation?.validationResult);
  const githubInfrastructureFailure = isPersistedGitHubInfrastructureFailure(latestValidationPayload);
  const latestSuccessfulValidation = githubInfrastructureFailure
    ? findLastSuccessfulValidationIteration(completedIterations)
    : undefined;
  const effectiveValidationIteration = latestSuccessfulValidation ?? latestValidation;
  const latestReview = findLastIteration(completedIterations, 'review');
  const latestPlanning = findLastIteration(completedIterations, 'planning');
  const failureAt = findLatestFailureTimestamp(audit);
  const hasDeliveryEvidence = checkpoints.some((checkpoint) => checkpoint.key.startsWith('external:'))
    || audit.some((event) => {
      const payload = asRecord(event.payload);
      return event.eventType === 'task_github_operation_failed'
        || (event.eventType === 'task_activity' && (
          payload?.phase === 'git'
          || payload?.phase === 'github'
        ));
    });
  const canResumeCompletedDelivery = Boolean(
    hasDeliveryEvidence
    &&
    latestImplementation
    && resolveValidationPassed(asRecord(latestValidation?.validationResult)) === true
    && latestReview
    && extractReviewBlockers(latestReview).length === 0
  );
  if (failureAt === undefined && !canResumeCompletedDelivery) {
    return undefined;
  }
  const resumeCutoff = failureAt ?? Number.POSITIVE_INFINITY;
  const relevantAudit = audit.filter((event) => {
    const payload = asRecord(event.payload);
    return !currentTaskRunId || payload?.taskRunId !== currentTaskRunId;
  });
  const latestGitHubFailure = [...relevantAudit]
    .reverse()
    .find((event) => event.eventType === 'task_github_operation_failed' && timestampOf(event.createdAt) <= resumeCutoff);
  const latestIterationStarted = [...relevantAudit]
    .reverse()
    .find((event) => event.eventType === 'task_iteration_started' && timestampOf(event.createdAt) <= resumeCutoff);
  const latestCompletedAt = timestampOf(latestIteration?.createdAt);
  const inFlightPhase = latestIterationStarted && timestampOf(latestIterationStarted.createdAt) > latestCompletedAt
    ? normalizeResumePhase(asRecord(latestIterationStarted.payload)?.phase)
    : undefined;

  let resumeFrom: NonNullable<WorkerTaskResume['resumeFrom']>;
  if (latestGitHubFailure && timestampOf(latestGitHubFailure.createdAt) > latestCompletedAt) {
    const failedOperation = asRecord(latestGitHubFailure.payload)?.operation;
    resumeFrom = failedOperation === 'create_issue' || failedOperation === 'create_branch' ? 'planning' : 'delivery';
  } else if (inFlightPhase === 'planning' && isFailedValidationIteration(latestValidation)) {
    resumeFrom = 'implementation';
  } else if (inFlightPhase) {
    resumeFrom = inFlightPhase;
  } else if (githubInfrastructureFailure) {
    resumeFrom = 'delivery';
  } else if (latestIteration?.phase === 'review') {
    resumeFrom = extractReviewBlockers(latestReview).length > 0 ? 'implementation' : 'delivery';
  } else if (latestIteration?.phase === 'validation') {
    resumeFrom = isFailedValidationIteration(latestValidation) ? 'implementation' : 'review';
  } else if (latestIteration?.phase === 'implementation') {
    resumeFrom = 'validation';
  } else if (latestIteration?.phase === 'planning') {
    resumeFrom = 'implementation';
  } else {
    resumeFrom = 'planning';
  }

  const latestImplementationAt = timestampOf(latestImplementation?.createdAt);
  const validationIsCurrent = Boolean(
    effectiveValidationIteration
    && timestampOf(effectiveValidationIteration.createdAt) >= latestImplementationAt
  );
  const validation = validationIsCurrent
    ? extractValidationResult(effectiveValidationIteration?.validationResult)
    : undefined;
  const reviewBlockers = extractReviewBlockers(latestReview);
  const implementationPayload = asRecord(latestImplementation?.validationResult);
  const changedFiles = Array.isArray(implementationPayload?.changedFiles)
    ? implementationPayload.changedFiles.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const diffStat = normalizeResumeDiffStat(latestImplementation?.diffStat);
  const startedPayload = asRecord(latestIterationStarted?.payload);
  const persistedAttempt = typeof startedPayload?.attempt === 'number' && Number.isFinite(startedPayload.attempt)
    ? Math.max(1, Math.trunc(startedPayload.attempt))
    : extractLatestAttempt(completedIterations);
  const attempt = persistedAttempt;
  const completedOperations = relevantAudit
    .filter((event) => timestampOf(event.createdAt) >= timestampOf(latestImplementation?.createdAt))
    .filter((event) => event.eventType === 'task_activity')
    .map((event) => asRecord(event.payload))
    .filter((payload) => (
      payload?.state === 'completed'
      && typeof payload.operation === 'string'
      && payload.operation !== 'merge_pr'
    ))
    .map((payload) => payload!.operation as string);
  completedOperations.push(...checkpoints
    .filter((checkpoint) => (
      checkpoint.status === 'completed'
      && checkpoint.key.startsWith('external:')
      && checkpoint.key !== 'external:merge_pr'
      && checkpoint.key !== 'external:wait_for_checks'
    ))
    .map((checkpoint) => checkpoint.key.slice('external:'.length)));
  const mergeCheckpoint = checkpoints.find((checkpoint) => checkpoint.key === 'external:merge_pr');
  const mergeCheckpointOutput = asRecord(mergeCheckpoint?.output);
  const mergeConfirmed = mergeCheckpoint?.status === 'completed' && mergeCheckpointOutput?.merged === true;
  const mergeCommitSha = mergeConfirmed
    && typeof mergeCheckpointOutput?.sha === 'string'
    && /^[a-f0-9]{7,64}$/i.test(mergeCheckpointOutput.sha)
      ? mergeCheckpointOutput.sha
      : undefined;
  if (mergeConfirmed) completedOperations.push('merge_pr');
  const persistedValidationChecks = validationIsCurrent
    ? extractPassedValidationChecks(latestValidation?.validationResult)
    : [];
  const passedValidationChecks: NonNullable<WorkerTaskResume['passedValidationChecks']> = [
    ...persistedValidationChecks
  ];
  for (const checkpoint of checkpoints.filter((item) => item.status === 'completed' && item.key.startsWith('validation:'))) {
    const output = asRecord(checkpoint.output);
    if (output?.evidenceVersion !== 1 || output.deferred === true) continue;
    const command = typeof output?.command === 'string' ? output.command : undefined;
    if (!command || passedValidationChecks.some((item) => item.command === command && item.inputHash === checkpoint.inputHash)) continue;
    passedValidationChecks.push({
      command,
      shell: output?.shell === 'powershell' || output?.shell === 'cmd' || output?.shell === 'bash' || output?.shell === 'sh'
        ? output.shell
        : 'system',
      exitCode: typeof output?.exitCode === 'number' ? output.exitCode : 0,
      stdout: typeof output?.stdout === 'string' ? output.stdout : '',
      stderr: typeof output?.stderr === 'string' ? output.stderr : '',
      passed: true,
      inputHash: checkpoint.inputHash,
      criterion: typeof output?.criterion === 'string' ? output.criterion : undefined,
      rationale: typeof output?.rationale === 'string' ? output.rationale : undefined
    });
  }
  const satisfactionReviewCheckpoint = [...checkpoints].reverse().find((checkpoint) => (
    checkpoint.status === 'completed' && checkpoint.key === 'review:already_satisfied'
  ));
  const satisfactionReviewOutput = asRecord(satisfactionReviewCheckpoint?.output);
  const completedSatisfactionReview = satisfactionReviewCheckpoint
    && typeof satisfactionReviewOutput?.summary === 'string'
    ? {
        inputHash: satisfactionReviewCheckpoint.inputHash,
        summary: satisfactionReviewOutput.summary,
        criterionResults: extractCriterionResults(satisfactionReviewOutput.criterionResults)
      }
    : undefined;
  const reviewCheckpoint = [...checkpoints].reverse().find((checkpoint) => (
    checkpoint.status === 'completed' && checkpoint.key === 'review:final'
  ));
  const reviewOutput = asRecord(reviewCheckpoint?.output);
  const completedReview = reviewCheckpoint
    && (reviewOutput?.verdict === 'satisfied' || reviewOutput?.verdict === 'not_satisfied')
    && typeof reviewOutput.summary === 'string'
    && Array.isArray(reviewOutput.blockers)
    && reviewOutput.blockers.every((item) => typeof item === 'string')
    ? {
        inputHash: reviewCheckpoint.inputHash,
        verdict: reviewOutput.verdict as ReviewResult['verdict'],
        summary: reviewOutput.summary,
        blockers: reviewOutput.blockers as string[],
        criterionResults: extractCriterionResults(reviewOutput.criterionResults)
      }
    : completedSatisfactionReview
      ? {
          inputHash: completedSatisfactionReview.inputHash,
          verdict: 'satisfied' as const,
          summary: completedSatisfactionReview.summary,
          blockers: [],
          criterionResults: completedSatisfactionReview.criterionResults
        }
      : undefined;

  return {
    kind: 'phase_retry',
    resumeFrom,
    attempt,
    planSummary: latestPlanning?.resultSummary,
    planSteps: extractStringArray(latestPlanning?.validationResult, 'steps'),
    acceptanceCriteria: extractStringArray(latestPlanning?.validationResult, 'acceptanceCriteria'),
    implementationSummary: latestImplementation?.resultSummary
      ?? 'Continue from the implementation preserved in the workspace.',
    ...extractImplementationResume(latestImplementation),
    changedFiles,
    diffStat,
    architectureUpdate: extractArchitectureUpdate(latestImplementation),
    previousValidationError: resumeFrom === 'implementation' && validation && !validation.passed
      ? formatValidationFailure(validation)
      : undefined,
    previousReviewBlockers: resumeFrom === 'implementation' ? reviewBlockers : undefined,
    validation,
    passedValidationChecks,
    reviewSummary: latestReview?.resultSummary,
    validationChecks: extractLatestValidationChecks(completedIterations),
    completedOperations: Array.from(new Set(completedOperations)),
    mergeCommitSha,
    completedSatisfactionReview,
    completedReview
  };
}

function extractCriterionResults(value: unknown): ReviewResult['criterionResults'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const results = value.flatMap((entry) => {
    const item = asRecord(entry);
    if (
      !item
      || typeof item.criterion !== 'string'
      || (item.status !== 'satisfied' && item.status !== 'not_satisfied' && item.status !== 'insufficient_evidence' && item.status !== 'deferred')
      || !Array.isArray(item.evidence)
      || item.evidence.some((evidence) => typeof evidence !== 'string')
    ) {
      return [];
    }
    const status = item.status as 'satisfied' | 'not_satisfied' | 'insufficient_evidence' | 'deferred';
    return [{
      criterion: item.criterion,
      status,
      evidence: item.evidence as string[]
    }];
  });
  return results.length > 0 ? results : undefined;
}

function extractImplementationResume(
  iteration: TaskDiffIterationSnapshot | undefined
): Pick<WorkerTaskResume, 'implementationOutcome' | 'evidenceFiles'> {
  const payload = asRecord(iteration?.validationResult);
  const implementationOutcome = payload?.outcome === 'already_satisfied' || payload?.alreadySatisfied === true
    ? 'already_satisfied'
    : payload?.outcome === 'changes_made'
      ? 'changes_made'
      : undefined;
  const evidenceFiles = extractStringArray(iteration?.validationResult, 'evidenceFiles');
  return {
    implementationOutcome,
    evidenceFiles: evidenceFiles.length > 0 ? evidenceFiles : undefined
  };
}

function findLatestFailureTimestamp(audit: TaskAuditSnapshot[]): number | undefined {
  const failure = [...audit].reverse().find((event) => (
    event.eventType === 'task_failed'
    || event.eventType === 'task_worker_interrupted'
    || event.eventType === 'task_cancelled'
    || event.eventType === 'task_status_validation_failed'
  ));
  return failure ? timestampOf(failure.createdAt) : undefined;
}

function normalizeResumePhase(value: unknown): WorkerTaskResume['resumeFrom'] | undefined {
  if (value === 'planning' || value === 'implementation' || value === 'validation' || value === 'review') {
    return value;
  }
  if (value === 'git' || value === 'github' || value === 'completion') {
    return 'delivery';
  }
  return undefined;
}

function extractValidationResult(value: unknown): WorkerTaskResume['validation'] {
  const payload = asRecord(value);
  const passed = resolveValidationPassed(payload);
  if (!payload || passed === undefined) return undefined;
  const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : passed ? 0 : 1;
  return {
    command: typeof payload.command === 'string' ? payload.command : 'resumed-validation',
    exitCode,
    stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
    stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
    passed,
    executedCheckCount: typeof payload.executedCheckCount === 'number' ? payload.executedCheckCount : undefined,
    reusedCheckCount: typeof payload.reusedCheckCount === 'number' ? payload.reusedCheckCount : undefined,
    failingCommand: !passed
      ? typeof payload.failingCommand === 'string'
        ? payload.failingCommand
        : typeof payload.command === 'string' ? payload.command : undefined
      : undefined
  };
}

function resolveValidationPassed(payload: Record<string, unknown> | undefined): boolean | undefined {
  if (!payload) return undefined;
  if (typeof payload.exitCode === 'number') return payload.exitCode === 0;
  return typeof payload.passed === 'boolean' ? payload.passed : undefined;
}

function extractReviewBlockers(iteration: TaskDiffIterationSnapshot | undefined): string[] {
  return extractStringArray(iteration?.validationResult, 'blockers');
}

function extractArchitectureUpdate(iteration: TaskDiffIterationSnapshot | undefined): ProjectArchitectureUpdate | undefined {
  const payload = asRecord(iteration?.validationResult);
  const update = asRecord(payload?.architectureUpdate);
  return update ? update as unknown as ProjectArchitectureUpdate : undefined;
}

function extractStringArray(value: unknown, key: string): string[] {
  return extractUnknownArray(value, key).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function extractUnknownArray(value: unknown, key: string): unknown[] {
  const payload = asRecord(value);
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}

function extractLatestValidationChecks(iterations: TaskDiffIterationSnapshot[]): WorkerTaskResume['validationChecks'] {
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    if (iterations[index]?.phase !== 'implementation') continue;
    const checks = extractValidationChecks(iterations[index]?.validationResult);
    if (checks?.length) return checks;
  }
  return undefined;
}

function extractPassedValidationChecks(value: unknown): NonNullable<WorkerTaskResume['passedValidationChecks']> {
  const payload = asRecord(value);
  if (!Array.isArray(payload?.passedValidationChecks)) return [];
  return payload.passedValidationChecks.flatMap((entry) => {
    const check = asRecord(entry);
    if (
      !check
      || typeof check.command !== 'string'
      || typeof check.inputHash !== 'string'
      || check.inputHash.length === 0
      || typeof check.exitCode !== 'number'
      || typeof check.stdout !== 'string'
      || typeof check.stderr !== 'string'
      || typeof check.passed !== 'boolean'
    ) {
      return [];
    }
    return [{
      command: check.command,
      shell: check.shell === 'powershell' || check.shell === 'cmd' || check.shell === 'bash' || check.shell === 'sh'
        ? check.shell
        : 'system',
      exitCode: check.exitCode,
      stdout: check.stdout,
      stderr: check.stderr,
      passed: check.passed,
      inputHash: check.inputHash,
      criterion: typeof check.criterion === 'string' ? check.criterion : undefined,
      rationale: typeof check.rationale === 'string' ? check.rationale : undefined
    }];
  });
}

function normalizeResumeDiffStat(value: unknown): WorkerTaskResume['diffStat'] | undefined {
  const payload = asRecord(value);
  if (!payload) return undefined;
  const filesChanged = typeof payload.filesChanged === 'number' ? payload.filesChanged : 0;
  const insertions = typeof payload.insertions === 'number' ? payload.insertions : 0;
  const deletions = typeof payload.deletions === 'number' ? payload.deletions : 0;
  return { filesChanged, insertions, deletions };
}

function extractLatestAttempt(iterations: TaskDiffIterationSnapshot[]): number {
  return iterations.reduce((latest, iteration) => {
    const payload = asRecord(iteration.validationResult);
    return typeof payload?.attempt === 'number' ? Math.max(latest, Math.trunc(payload.attempt)) : latest;
  }, 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timestampOf(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isFailedValidationIteration(iteration: TaskDiffIterationSnapshot | undefined): boolean {
  return resolveValidationPassed(asRecord(iteration?.validationResult)) === false;
}

function extractValidationChecks(validationResult: unknown): WorkerTaskResume['validationChecks'] {
  if (!validationResult || typeof validationResult !== 'object' || Array.isArray(validationResult)) {
    return undefined;
  }

  const payload = validationResult as Record<string, unknown>;
  if (!Array.isArray(payload.validationChecks)) {
    return undefined;
  }

  const checks = payload.validationChecks
    .map((item) => normalizeValidationCheckSnapshot(item))
    .filter((item): item is NonNullable<ReturnType<typeof normalizeValidationCheckSnapshot>> => Boolean(item));

  return checks.length > 0 ? checks : undefined;
}

function normalizeValidationCheckSnapshot(item: unknown): ValidationCheck | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }

  const check = item as PlannedValidationCheckSnapshot;
  if (check.kind === 'command' && typeof check.command === 'string' && check.command.trim()) {
    return {
      kind: 'command' as const,
      command: check.command.trim(),
      shell: check.shell === 'powershell' || check.shell === 'cmd' || check.shell === 'bash' || check.shell === 'sh'
        ? check.shell
        : 'system',
      continueOnFailure: check.continueOnFailure === true,
      timeoutMinutes: typeof check.timeoutMinutes === 'number' ? check.timeoutMinutes : undefined,
      category: check.category === 'setup' || check.category === 'build' || check.category === 'database' || check.category === 'api' || check.category === 'browser' || check.category === 'smoke'
        ? check.category
        : undefined,
      criterion: typeof check.criterion === 'string' && check.criterion.trim() ? check.criterion.trim() : undefined,
      rationale: typeof check.rationale === 'string' && check.rationale.trim() ? check.rationale.trim() : undefined,
    };
  }

  return undefined;
}

function findLastIteration<T extends { phase: string }>(iterations: T[], phase: string): T | undefined {
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    if (iterations[index]?.phase === phase) {
      return iterations[index];
    }
  }

  return undefined;
}

function findLastSuccessfulValidationIteration<T extends { phase: string; validationResult?: unknown }>(iterations: T[]): T | undefined {
  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = iterations[index];
    if (iteration?.phase === 'validation' && resolveValidationPassed(asRecord(iteration.validationResult)) === true) {
      return iteration;
    }
  }
  return undefined;
}

function isPersistedGitHubInfrastructureFailure(payload: Record<string, unknown> | undefined): boolean {
  if (payload?.failingCommand !== 'github-actions') return false;
  const message = [payload.stderr, payload.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /job was not started|account payments? (?:have )?failed|spending limit|billing (?:issue|problem|limit)|hosted runner.*(?:unavailable|quota)|no hosted compute minutes/i.test(message);
}

export function buildIterationErrorFingerprint(phase: string, validationResult: unknown): string | undefined {
  if (!validationResult || typeof validationResult !== 'object' || Array.isArray(validationResult)) {
    return undefined;
  }

  const payload = validationResult as Record<string, unknown>;
  const normalizedPhase = String(phase);

  if (normalizedPhase === 'validation') {
    const passed = payload.passed === true;
    if (passed) return undefined;

    const exitCode = typeof payload.exitCode === 'number' ? payload.exitCode : 'unknown';
    const command = typeof payload.failingCommand === 'string'
      ? payload.failingCommand
      : (typeof payload.command === 'string' ? payload.command : 'unknown');
    const stderr = typeof payload.stderr === 'string' ? payload.stderr : '';
    const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
    return `validation:${command}:${exitCode}:${stableValidationFailureSignature(stderr || stdout)}`;
  }

  if (normalizedPhase === 'review') {
    const blockers = Array.isArray(payload.blockers) ? payload.blockers.filter((item) => typeof item === 'string' && item.length > 0) : [];
    if (blockers.length === 0) return undefined;
    return `review:${blockers.join('|')}`;
  }

  return undefined;
}

function stableValidationFailureSignature(output: string): string {
  const normalizedLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLines = normalizedLines.filter((line) => /(?:error|failed|failure|exception|not assignable|missing)/i.test(line));
  const selected = (errorLines.length > 0 ? errorLines : normalizedLines.slice(-20))
    .slice(-20)
    .map((line) => line
      .replace(/\b\d+(?:\.\d+)?m?s\b/gi, '<duration>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>'));
  return selected.join('|') || 'no-output';
}
