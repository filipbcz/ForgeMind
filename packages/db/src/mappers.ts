import type {
  AcceptanceEvidence as CoreAcceptanceEvidence,
  Approval as CoreApproval,
  AuditEvent,
  ForgeTask,
  ProjectAuditJob as CoreProjectAuditJob,
  ProjectImplementationStep as CoreProjectImplementationStep,
  ProjectContract,
  ProjectRoadmapCycle as CoreProjectRoadmapCycle,
  Project as CoreProject,
  TaskRun as CoreTaskRun
} from '@forgemind/core';
import type { JsonValue } from '@forgemind/shared';
import type { AcceptanceEvidence, Approval, AuditLog, Prisma, Project, ProjectAuditJob, ProjectImplementationStep, ProjectRoadmapCycle, Task, TaskRun } from '@prisma/client';

export function toProject(project: Project): CoreProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    githubOwner: project.githubOwner ?? undefined,
    githubRepo: project.githubRepo ?? undefined,
    defaultBranch: project.defaultBranch,
    configYaml: project.configYaml ?? undefined,
    brief: project.brief ?? undefined,
    projectContract: toProjectContract(project.projectContract),
    autoCreatePullRequest: project.autoCreatePullRequest,
    autoMergePullRequest: project.autoMergePullRequest,
    autoCompleteTask: project.autoCompleteTask,
    allowSafeOperationsWithoutApproval: project.allowSafeOperationsWithoutApproval,
    defaultTaskMode: project.defaultTaskMode,
    aiProviderConnectionId: project.aiProviderConnectionId ?? undefined,
    isActive: project.isActive,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

export function toProjectRoadmapCycle(cycle: ProjectRoadmapCycle): CoreProjectRoadmapCycle {
  return {
    id: cycle.id,
    projectId: cycle.projectId,
    cycleNumber: cycle.cycleNumber,
    objective: cycle.objective,
    extensionProposal: cycle.extensionProposal ?? undefined,
    status: cycle.status,
    createdAt: cycle.createdAt.toISOString(),
    updatedAt: cycle.updatedAt.toISOString(),
    completedAt: cycle.completedAt?.toISOString()
  };
}

export function toProjectAuditJob(job: ProjectAuditJob): CoreProjectAuditJob {
  return {
    id: job.id,
    projectId: job.projectId,
    cycleId: job.cycleId,
    triggerTaskId: job.triggerTaskId ?? undefined,
    requirementIds: Array.isArray(job.requirementIds)
      ? job.requirementIds.filter((item): item is string => typeof item === 'string')
      : [],
    status: job.status,
    attemptCount: job.attemptCount,
    nextAttemptAt: job.nextAttemptAt?.toISOString(),
    errorMessage: job.errorMessage ?? undefined,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    claimedAt: job.claimedAt?.toISOString(),
    finishedAt: job.finishedAt?.toISOString()
  };
}

export function toProjectImplementationStep(step: ProjectImplementationStep): CoreProjectImplementationStep {
  const acceptanceCriteria = Array.isArray(step.acceptanceCriteria)
    ? step.acceptanceCriteria.filter((item): item is string => typeof item === 'string')
    : [];
  const requirementIds = Array.isArray(step.requirementIds)
    ? step.requirementIds.filter((item): item is string => typeof item === 'string')
    : [];
  const deliverables = Array.isArray(step.deliverables)
    ? step.deliverables.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    id: step.id,
    projectId: step.projectId,
    cycleId: step.cycleId,
    sequenceNumber: step.sequenceNumber,
    title: step.title,
    description: step.description,
    acceptanceCriteria,
    requirementIds,
    deliverables,
    status: step.status,
    taskId: step.taskId ?? undefined,
    createdAt: step.createdAt.toISOString(),
    updatedAt: step.updatedAt.toISOString(),
    completedAt: step.completedAt?.toISOString()
  };
}

export function toAcceptanceEvidence(evidence: AcceptanceEvidence): CoreAcceptanceEvidence {
  const payload = evidence.payloadJson && typeof evidence.payloadJson === 'object' && !Array.isArray(evidence.payloadJson)
    ? evidence.payloadJson as Record<string, unknown>
    : {};
  return {
    id: evidence.id,
    projectId: evidence.projectId,
    cycleId: evidence.cycleId,
    stepId: evidence.stepId ?? undefined,
    taskId: evidence.taskId ?? undefined,
    taskRunId: evidence.taskRunId ?? undefined,
    requirementId: evidence.requirementId,
    criterionKey: evidence.criterionKey,
    criterion: evidence.criterion,
    source: evidence.source,
    status: evidence.status,
    evidenceKey: evidence.evidenceKey,
    contractVersion: evidence.contractVersion,
    commitSha: evidence.commitSha ?? undefined,
    command: evidence.command ?? undefined,
    exitCode: evidence.exitCode ?? undefined,
    detailsUrl: evidence.detailsUrl ?? undefined,
    payload,
    createdAt: evidence.createdAt.toISOString(),
    updatedAt: evidence.updatedAt.toISOString()
  };
}

function toProjectContract(value: Prisma.JsonValue | null): ProjectContract | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contract = value as Record<string, Prisma.JsonValue>;
  if (
    typeof contract.version !== 'number'
    || typeof contract.summary !== 'string'
    || !Array.isArray(contract.invariants)
    || !Array.isArray(contract.prohibitedSubstitutes)
    || !Array.isArray(contract.requirements)
    || !Array.isArray(contract.releaseCriteria)
  ) return undefined;

  const requirements = contract.requirements.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const requirement = item as Record<string, Prisma.JsonValue>;
    if (
      typeof requirement.id !== 'string'
      || typeof requirement.title !== 'string'
      || typeof requirement.description !== 'string'
      || !Array.isArray(requirement.acceptanceCriteria)
    ) return [];
    return [{
      id: requirement.id,
      title: requirement.title,
      description: requirement.description,
      acceptanceCriteria: requirement.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === 'string')
    }];
  });

  if (requirements.length !== contract.requirements.length) return undefined;
  return {
    version: contract.version,
    sourceBriefHash: typeof contract.sourceBriefHash === 'string' ? contract.sourceBriefHash : undefined,
    summary: contract.summary,
    invariants: contract.invariants.filter((item): item is string => typeof item === 'string'),
    prohibitedSubstitutes: contract.prohibitedSubstitutes.filter((item): item is string => typeof item === 'string'),
    requirements,
    releaseCriteria: contract.releaseCriteria.filter((item): item is string => typeof item === 'string')
  };
}

export function toTask(task: Task): ForgeTask {
  return {
    id: task.id,
    projectId: task.projectId,
    createdByUserId: task.createdByUserId,
    title: task.title,
    prompt: task.prompt,
    mode: task.mode,
    status: task.status,
    githubIssueNumber: task.githubIssueNumber ?? undefined,
    githubIssueUrl: task.githubIssueUrl ?? undefined,
    branchName: task.branchName ?? undefined,
    pullRequestNumber: task.pullRequestNumber ?? undefined,
    pullRequestUrl: task.pullRequestUrl ?? undefined,
    maxIterations: task.maxIterations,
    maxBudgetUsd: Number(task.maxBudgetUsd),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    startedAt: task.startedAt?.toISOString(),
    finishedAt: task.finishedAt?.toISOString()
  };
}

export function toTaskRun(run: TaskRun): CoreTaskRun {
  return {
    id: run.id,
    taskId: run.taskId,
    provider: run.provider,
    model: run.model,
    status: run.status,
    iterationCount: run.iterationCount,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    totalTokens: run.totalTokens,
    usageSource: run.usageSource,
    estimatedCostUsd: Number(run.estimatedCostUsd),
    actualCostUsd: run.actualCostUsd === null ? undefined : Number(run.actualCostUsd),
    startedAt: run.startedAt?.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    summary: run.summary ?? undefined,
    errorMessage: run.errorMessage ?? undefined
  };
}

export function toApproval(approval: Approval): CoreApproval {
  return {
    id: approval.id,
    taskId: approval.taskId,
    type: approval.type,
    status: approval.status,
    requestedBy: approval.requestedBy as CoreApproval['requestedBy'],
    approvedByUserId: approval.approvedByUserId ?? undefined,
    title: approval.title,
    description: approval.description,
    riskLevel: approval.riskLevel,
    payload: approval.payloadJson as JsonValue,
    createdAt: approval.createdAt.toISOString(),
    resolvedAt: approval.resolvedAt?.toISOString()
  };
}

export function toAuditEvent(event: AuditLog): AuditEvent {
  return {
    id: event.id,
    actorType: event.actorType,
    actorId: event.actorId ?? undefined,
    eventType: event.eventType,
    projectId: event.projectId ?? undefined,
    taskId: event.taskId ?? undefined,
    payload: event.payload as JsonValue,
    createdAt: event.createdAt.toISOString()
  };
}

export function toPrismaJson(value: JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
