import type {
  Approval as CoreApproval,
  AuditEvent,
  ForgeTask,
  ProjectImplementationStep as CoreProjectImplementationStep,
  ProjectRoadmapCycle as CoreProjectRoadmapCycle,
  Project as CoreProject,
  TaskRun as CoreTaskRun
} from '@forgemind/core';
import type { JsonValue } from '@forgemind/shared';
import type { Approval, AuditLog, Prisma, Project, ProjectImplementationStep, ProjectRoadmapCycle, Task, TaskRun } from '@prisma/client';

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

export function toProjectImplementationStep(step: ProjectImplementationStep): CoreProjectImplementationStep {
  const acceptanceCriteria = Array.isArray(step.acceptanceCriteria)
    ? step.acceptanceCriteria.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    id: step.id,
    projectId: step.projectId,
    cycleId: step.cycleId,
    sequenceNumber: step.sequenceNumber,
    title: step.title,
    description: step.description,
    acceptanceCriteria,
    status: step.status,
    taskId: step.taskId ?? undefined,
    createdAt: step.createdAt.toISOString(),
    updatedAt: step.updatedAt.toISOString(),
    completedAt: step.completedAt?.toISOString()
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
