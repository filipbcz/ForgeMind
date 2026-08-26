import type { ApprovalType, ProjectArchitectureUpdate } from '@forgemind/core';
import type { GitHubChecksResult } from '@forgemind/github';
import type { ReviewResult, ValidationCheck } from '@forgemind/providers';
import type { JsonValue } from '@forgemind/shared';
import { formatValidationFailure } from '../validation.js';
import type { WorkerTaskResume } from '../workflow.js';
import { normalizeRuntimeApprovals, type ApprovedLimitSignal } from './limits.js';

export interface TaskResumeContext {
  workflowResume: WorkerTaskResume;
  ignoredLimitSignals: ApprovedLimitSignal[];
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
  requiredCapabilities?: unknown;
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
    listApprovals: () => Promise<Array<{ taskId: string; type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; payload: unknown; createdAt: string }>>;
    listTaskAudit: (taskId: string) => Promise<TaskAuditSnapshot[]>;
    getTaskDiff: (taskId: string) => Promise<{
      iterations: TaskDiffIterationSnapshot[];
    }>;
    listTaskCheckpoints?: (taskId: string) => Promise<TaskCheckpointSnapshot[]>;
  },
  taskId: string,
  queueReason?: string,
  currentTaskRunId?: string,
  maxIterations?: number
): Promise<TaskResumeContext | undefined> {
  const [approvals, diff, audit, checkpoints] = await Promise.all([
    repository.listApprovals(),
    repository.getTaskDiff(taskId),
    repository.listTaskAudit(taskId),
    repository.listTaskCheckpoints?.(taskId) ?? Promise.resolve([])
  ]);
  const taskApprovals = approvals.filter((approval) => approval.taskId === taskId);
  const approvedTypes = new Set(taskApprovals.filter((approval) => approval.status === 'approved').map((approval) => approval.type));
  const lastPlanningIteration = findLastIteration(diff.iterations, 'planning');
  const lastImplementationIteration = findLastIteration(diff.iterations, 'implementation');
  const lastValidationIteration = findLastIteration(diff.iterations, 'validation');
  const lastReviewIteration = findLastIteration(diff.iterations, 'review');
  const architectureUpdate = extractArchitectureUpdate(lastImplementationIteration);
  const implementationResume = extractImplementationResume(lastImplementationIteration);
  const approvedReviewResume = buildApprovedReviewResume(lastPlanningIteration, lastImplementationIteration, lastReviewIteration, approvedTypes);
  if (approvedReviewResume) approvedReviewResume.architectureUpdate = architectureUpdate;
  const latestApprovedLargeDiffAt = getLatestApprovedLargeDiffAt(taskApprovals);
  const latestApprovedReviewAt = approvedReviewResume
    ? getLatestApprovedReviewAt(taskApprovals, approvedReviewResume.riskyChanges ?? [])
    : undefined;

  if (queueReason === 'capability_available' && lastImplementationIteration) {
    const checkpointResume = buildPhaseRetryResume(
      diff.iterations,
      audit,
      approvedTypes,
      currentTaskRunId,
      checkpoints,
      false,
      maxIterations
    );
    return {
      workflowResume: {
        ...checkpointResume,
        kind: 'capability_available',
        resumeFrom: 'validation',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary: lastImplementationIteration.resultSummary || 'Resume authoritative validation on a capable worker.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        validation: undefined,
        passedValidationChecks: checkpointResume?.passedValidationChecks
          ?? extractPassedValidationChecks(lastValidationIteration?.validationResult),
        resumeValidationPlanRevision: false,
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  if (queueReason === 'task_retried' || queueReason === 'worker_interrupted' || queueReason === 'phase_retry') {
    const phaseRetryResume = buildPhaseRetryResume(
      diff.iterations,
      audit,
      approvedTypes,
      currentTaskRunId,
      checkpoints,
      queueReason === 'task_retried',
      maxIterations
    );
    if (phaseRetryResume) {
      return {
        workflowResume: phaseRetryResume,
        ignoredLimitSignals: [],
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
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
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
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  if (latestApprovedLargeDiffAt && (!latestApprovedReviewAt || latestApprovedLargeDiffAt >= latestApprovedReviewAt)) {
    if (!lastImplementationIteration) {
      return undefined;
    }

    return {
      workflowResume: {
        kind: 'approved_large_diff',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary: lastImplementationIteration.resultSummary || 'Resuming previously approved implementation.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: ['diff_lines_limit_reached', 'changed_files_limit_reached']
    };
  }

  if (approvedReviewResume) {
    return {
      workflowResume: {
        ...approvedReviewResume,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  if (approvedTypes.size > 0 && (lastPlanningIteration || lastImplementationIteration)) {
    return {
      workflowResume: {
        kind: 'approved_operation',
        planSummary: lastPlanningIteration?.resultSummary,
        planSteps: extractStringArray(lastPlanningIteration?.validationResult, 'steps'),
        acceptanceCriteria: extractStringArray(lastPlanningIteration?.validationResult, 'acceptanceCriteria'),
        implementationSummary:
          lastImplementationIteration?.resultSummary
          ?? 'Resume workspace changes after the requested operation was approved.',
        ...implementationResume,
        validationChecks: extractLatestValidationChecks(diff.iterations),
        architectureUpdate,
        approvedApprovals: Array.from(approvedTypes)
      },
      ignoredLimitSignals: []
    };
  }

  return undefined;
}

function buildPhaseRetryResume(
  iterations: TaskDiffIterationSnapshot[],
  audit: TaskAuditSnapshot[],
  approvedTypes: ReadonlySet<ApprovalType>,
  currentTaskRunId?: string,
  checkpoints: TaskCheckpointSnapshot[] = [],
  resetExhaustedAttempt = false,
  maxIterations?: number
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
    resumeFrom = 'validation';
  } else if (inFlightPhase) {
    resumeFrom = inFlightPhase;
  } else if (githubInfrastructureFailure) {
    resumeFrom = 'delivery';
  } else if (latestIteration?.phase === 'review') {
    resumeFrom = extractReviewBlockers(latestReview).length > 0 ? 'implementation' : 'delivery';
  } else if (latestIteration?.phase === 'validation') {
    resumeFrom = isFailedValidationIteration(latestValidation) ? 'validation' : 'review';
  } else if (latestIteration?.phase === 'implementation') {
    resumeFrom = 'validation';
  } else if (latestIteration?.phase === 'planning') {
    const planningResult = asRecord(latestIteration.validationResult);
    const recoveryDecision = asRecord(planningResult?.validationRecovery);
    resumeFrom = planningResult?.revisedValidationChecksOnly === true || recoveryDecision?.action === 'blocked'
      ? 'validation'
      : 'implementation';
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
  const reviewSafeImprovements = extractStringArray(latestReview?.validationResult, 'safeImprovements');
  const reviewRisks = normalizeRuntimeApprovals(extractUnknownArray(latestReview?.validationResult, 'riskyChanges'));
  const implementationPayload = asRecord(latestImplementation?.validationResult);
  const changedFiles = Array.isArray(implementationPayload?.changedFiles)
    ? implementationPayload.changedFiles.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const diffStat = normalizeResumeDiffStat(latestImplementation?.diffStat);
  const startedPayload = asRecord(latestIterationStarted?.payload);
  const persistedAttempt = typeof startedPayload?.attempt === 'number' && Number.isFinite(startedPayload.attempt)
    ? Math.max(1, Math.trunc(startedPayload.attempt))
    : extractLatestAttempt(completedIterations);
  const attempt = resetExhaustedAttempt
    && typeof maxIterations === 'number'
    && persistedAttempt >= maxIterations
      ? 1
      : persistedAttempt;
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
      exitCode: typeof output?.exitCode === 'number' ? output.exitCode : 0,
      stdout: typeof output?.stdout === 'string' ? output.stdout : '',
      stderr: typeof output?.stderr === 'string' ? output.stderr : '',
      passed: true,
      inputHash: checkpoint.inputHash,
      criterion: typeof output?.criterion === 'string' ? output.criterion : undefined,
      rationale: typeof output?.rationale === 'string' ? output.rationale : undefined
    });
  }
  const latestPlanningResult = latestIteration?.phase === 'planning'
    ? asRecord(latestIteration.validationResult)
    : undefined;
  const completedValidationReplacement = latestPlanningResult?.revisedValidationChecksOnly === true;
  const resumeValidationPlanRevision = (
    resumeFrom === 'validation'
    && !completedValidationReplacement
    && Boolean(validation && !validation.passed && validation.failingCommand)
  );
  const githubChecksCheckpoint = [...checkpoints].reverse().find((checkpoint) => (
    checkpoint.status === 'completed' && checkpoint.key === 'external:wait_for_checks'
  ));
  const githubChecksOutput = asRecord(githubChecksCheckpoint?.output);
  const githubChecks: GitHubChecksResult | undefined = githubChecksOutput
    && (githubChecksOutput.status === 'success' || githubChecksOutput.status === 'not_configured')
    && typeof githubChecksOutput.summary === 'string'
    ? {
        status: githubChecksOutput.status as 'success' | 'not_configured',
        summary: githubChecksOutput.summary,
        failures: Array.isArray(githubChecksOutput.failures)
          ? githubChecksOutput.failures.flatMap((failure) => {
              const item = asRecord(failure);
              return item && typeof item.name === 'string' && typeof item.output === 'string'
                ? [{
                    name: item.name,
                    output: item.output,
                    detailsUrl: typeof item.detailsUrl === 'string' ? item.detailsUrl : undefined
                  }]
                : [];
            })
          : []
      }
    : undefined;
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
    previousSafeImprovements: resumeFrom === 'implementation' ? reviewSafeImprovements : undefined,
    validation,
    passedValidationChecks,
    resumeValidationPlanRevision,
    reviewSummary: latestReview?.resultSummary,
    riskyChanges: reviewRisks,
    validationChecks: extractLatestValidationChecks(completedIterations),
    approvedApprovals: Array.from(approvedTypes),
    completedOperations: Array.from(new Set(completedOperations)),
    githubChecks,
    githubChecksInputHash: githubChecksCheckpoint?.inputHash,
    mergeCommitSha,
    completedSatisfactionReview
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
    || event.eventType === 'task_status_iteration_limit_reached'
    || event.eventType === 'task_status_repeated_error_detected'
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
      : undefined,
    deferredChecks: extractDeferredValidationChecks(payload.deferredChecks)
  };
}

function extractDeferredValidationChecks(value: unknown): NonNullable<WorkerTaskResume['validation']>['deferredChecks'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    if (!item || typeof item.command !== 'string') return [];
    const requiredCapabilities = Array.isArray(item.requiredCapabilities)
      ? item.requiredCapabilities.filter((capability): capability is string => typeof capability === 'string')
      : [];
    const missingCapabilities = Array.isArray(item.missingCapabilities)
      ? item.missingCapabilities.filter((capability): capability is string => typeof capability === 'string')
      : [];
    return [{
      command: item.command,
      category: item.category === 'setup' || item.category === 'build' || item.category === 'database' || item.category === 'api' || item.category === 'browser' || item.category === 'smoke' ? item.category : undefined,
      criterion: typeof item.criterion === 'string' ? item.criterion : undefined,
      rationale: typeof item.rationale === 'string' ? item.rationale : undefined,
      requiredCapabilities,
      missingCapabilities
    }];
  });
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

function buildApprovedReviewResume(
  planningIteration:
    | {
        resultSummary: string;
        validationResult?: unknown;
      }
    | undefined,
  implementationIteration: { resultSummary: string } | undefined,
  reviewIteration:
    | {
        resultSummary: string;
        validationResult?: unknown;
      }
    | undefined,
  approvedTypes: ReadonlySet<ApprovalType>
): WorkerTaskResume | undefined {
  if (!implementationIteration || !reviewIteration) {
    return undefined;
  }

  const validationResult =
    reviewIteration.validationResult && typeof reviewIteration.validationResult === 'object' && !Array.isArray(reviewIteration.validationResult)
      ? (reviewIteration.validationResult as Record<string, JsonValue>)
      : undefined;
  const blockers = Array.isArray(validationResult?.blockers)
    ? validationResult.blockers.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const riskyChanges = Array.isArray(validationResult?.riskyChanges)
    ? normalizeRuntimeApprovals(validationResult.riskyChanges)
    : [];

  if (blockers.length > 0 || riskyChanges.length === 0 || !riskyChanges.every((item) => approvedTypes.has(item))) {
    return undefined;
  }

  return {
    kind: 'approved_review',
    planSummary: planningIteration?.resultSummary,
    planSteps: extractStringArray(planningIteration?.validationResult, 'steps'),
    acceptanceCriteria: extractStringArray(planningIteration?.validationResult, 'acceptanceCriteria'),
    implementationSummary: implementationIteration.resultSummary || 'Resuming previously reviewed implementation.',
    reviewSummary: reviewIteration.resultSummary || 'Previously reviewed implementation resumed.',
    riskyChanges,
    validationChecks: extractValidationChecks(planningIteration?.validationResult)
  };
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

function getLatestApprovedLargeDiffAt(
  approvals: Array<{ type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; payload: unknown; createdAt: string }>
): number | undefined {
  const timestamps = approvals
    .filter((approval) => approval.status === 'approved' && approval.type === 'risky_refactor')
    .filter((approval) => {
      const payload = approval.payload && typeof approval.payload === 'object' && !Array.isArray(approval.payload)
        ? (approval.payload as Record<string, JsonValue>)
        : undefined;
      const limitSignal = typeof payload?.limitSignal === 'string' ? payload.limitSignal : undefined;
      return limitSignal === 'diff_lines_limit_reached' || limitSignal === 'changed_files_limit_reached';
    })
    .map((approval) => Date.parse(approval.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (timestamps.length === 0) {
    return undefined;
  }

  return Math.max(...timestamps);
}

function getLatestApprovedReviewAt(
  approvals: Array<{ type: ApprovalType; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; createdAt: string }>,
  riskyChanges: ApprovalType[]
): number | undefined {
  const relevant = new Set(riskyChanges);
  const timestamps = approvals
    .filter((approval) => approval.status === 'approved' && relevant.has(approval.type))
    .map((approval) => Date.parse(approval.createdAt))
    .filter((timestamp) => Number.isFinite(timestamp));

  if (timestamps.length === 0) {
    return undefined;
  }

  return Math.max(...timestamps);
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
      category: check.category === 'setup' || check.category === 'build' || check.category === 'database' || check.category === 'api' || check.category === 'browser' || check.category === 'smoke'
        ? check.category
        : undefined,
      criterion: typeof check.criterion === 'string' && check.criterion.trim() ? check.criterion.trim() : undefined,
      rationale: typeof check.rationale === 'string' && check.rationale.trim() ? check.rationale.trim() : undefined,
      requiredCapabilities: Array.isArray(check.requiredCapabilities)
        ? check.requiredCapabilities.filter((value): value is string => typeof value === 'string')
        : undefined
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
