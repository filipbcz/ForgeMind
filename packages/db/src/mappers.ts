import type {
  AcceptanceEvidence as CoreAcceptanceEvidence,
  AuditEvent,
  ChatMessage as CoreChatMessage,
  ChatRun as CoreChatRun,
  ChatThread as CoreChatThread,
  ForgeTask,
  ProjectAuditJob as CoreProjectAuditJob,
  ProjectImplementationStep as CoreProjectImplementationStep,
  ProjectArchitecture,
  ProjectArchitectureVersion as CoreProjectArchitectureVersion,
  ProjectContract,
  ProjectContractDelta,
  ProjectContractRequirementStatus,
  ProjectContractVersion as CoreProjectContractVersion,
  ProjectMemory,
  ProjectRoadmapCycle as CoreProjectRoadmapCycle,
  ProjectSpecificationVersion as CoreProjectSpecificationVersion,
  Project as CoreProject,
  TaskRun as CoreTaskRun
} from '@forgemind/core';
import { normalizeRunState, parseTaskRunState } from '@forgemind/core';
import type { JsonValue } from '@forgemind/shared';
import type { AcceptanceEvidence, AuditLog, ChatMessage, ChatRun, ChatThread, Prisma, Project, ProjectArchitectureVersion, ProjectAuditJob, ProjectContractVersion, ProjectImplementationStep, ProjectRoadmapCycle, ProjectSpecificationVersion, Task, TaskRun } from '@prisma/client';

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
    currentContractVersionId: project.currentContractVersionId ?? undefined,
    projectMemory: toProjectMemory(project.projectMemory),
    projectArchitecture: toProjectArchitecture(project.projectArchitecture),
    currentArchitectureVersionId: project.currentArchitectureVersionId ?? undefined,
    planningSessionId: project.planningSessionId ?? undefined,
    planningSessionProvider: project.planningSessionProvider ?? undefined,
    planningSessionModel: project.planningSessionModel ?? undefined,
    planningSessionConnectionId: project.planningSessionConnectionId ?? undefined,
    planningSessionUpdatedAt: project.planningSessionUpdatedAt?.toISOString(),
    autoCreatePullRequest: project.autoCreatePullRequest,
    autoMergePullRequest: project.autoMergePullRequest,
    autoCompleteTask: project.autoCompleteTask,
    defaultTaskMode: project.defaultTaskMode,
    aiProviderConnectionId: project.aiProviderConnectionId ?? undefined,
    isActive: project.isActive,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

function toProjectArchitecture(value: Prisma.JsonValue | null): ProjectArchitecture | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const architecture = value as Record<string, Prisma.JsonValue>;
  if (
    architecture.version !== 1
    || typeof architecture.summary !== 'string'
    || !Array.isArray(architecture.modules)
    || !Array.isArray(architecture.decisions)
    || typeof architecture.updatedAt !== 'string'
  ) return undefined;

  const modules = architecture.modules.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const module = value as Record<string, Prisma.JsonValue>;
    if (typeof module.name !== 'string' || typeof module.responsibility !== 'string') return [];
    return [{
      name: module.name,
      responsibility: module.responsibility,
      paths: jsonStringArray(module.paths),
      publicInterfaces: jsonStringArray(module.publicInterfaces),
      dependencies: jsonStringArray(module.dependencies)
    }];
  });
  const decisions = architecture.decisions.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const decision = value as Record<string, Prisma.JsonValue>;
    if (
      typeof decision.id !== 'string'
      || typeof decision.summary !== 'string'
      || typeof decision.rationale !== 'string'
      || typeof decision.createdAt !== 'string'
    ) return [];
    return [{
      id: decision.id,
      summary: decision.summary,
      rationale: decision.rationale,
      taskId: typeof decision.taskId === 'string' ? decision.taskId : undefined,
      createdAt: decision.createdAt
    }];
  });

  return {
    version: 1,
    summary: architecture.summary,
    modules,
    databaseSchemas: Array.isArray(architecture.databaseSchemas)
      ? architecture.databaseSchemas.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const schema = value as Record<string, Prisma.JsonValue>;
          if (
            typeof schema.name !== 'string'
            || typeof schema.technology !== 'string'
            || typeof schema.ownedByModule !== 'string'
          ) return [];
          return [{
            name: schema.name,
            technology: schema.technology,
            paths: jsonStringArray(schema.paths),
            ownedByModule: schema.ownedByModule,
            migrationPaths: jsonStringArray(schema.migrationPaths)
          }];
        })
      : [],
    decisions,
    conventions: jsonStringArray(architecture.conventions),
    dependencyRules: jsonStringArray(architecture.dependencyRules),
    knownDebt: jsonStringArray(architecture.knownDebt),
    updatedAt: architecture.updatedAt
  };
}

function jsonStringArray(value: Prisma.JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toProjectMemory(value: Prisma.JsonValue | null): ProjectMemory | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const memory = value as Record<string, Prisma.JsonValue>;
  if (memory.version !== 1 || !Array.isArray(memory.recentWork) || typeof memory.updatedAt !== 'string') return undefined;

  const recentWork = memory.recentWork.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const entry = item as Record<string, Prisma.JsonValue>;
    if (
      typeof entry.taskId !== 'string'
      || typeof entry.title !== 'string'
      || typeof entry.summary !== 'string'
      || !Array.isArray(entry.changedFiles)
      || typeof entry.completedAt !== 'string'
    ) return [];
    return [{
      taskId: entry.taskId,
      title: entry.title,
      summary: entry.summary,
      changedFiles: entry.changedFiles.filter((path): path is string => typeof path === 'string'),
      commitSha: typeof entry.commitSha === 'string' ? entry.commitSha : undefined,
      completedAt: entry.completedAt
    }];
  });

  return {
    version: 1,
    contractVersion: typeof memory.contractVersion === 'number' ? memory.contractVersion : undefined,
    baseCommitSha: typeof memory.baseCommitSha === 'string' ? memory.baseCommitSha : undefined,
    recentWork,
    updatedAt: memory.updatedAt
  };
}

export function toProjectRoadmapCycle(cycle: ProjectRoadmapCycle): CoreProjectRoadmapCycle {
  return {
    id: cycle.id,
    projectId: cycle.projectId,
    cycleNumber: cycle.cycleNumber,
    objective: cycle.objective,
    specificationVersionId: cycle.specificationVersionId ?? undefined,
    contractVersionId: cycle.contractVersionId ?? undefined,
    architectureVersionId: cycle.architectureVersionId ?? undefined,
    extensionProposal: cycle.extensionProposal ?? undefined,
    status: cycle.status,
    createdAt: cycle.createdAt.toISOString(),
    updatedAt: cycle.updatedAt.toISOString(),
    completedAt: cycle.completedAt?.toISOString()
  };
}

export function toProjectSpecificationVersion(
  specification: ProjectSpecificationVersion
): CoreProjectSpecificationVersion {
  return {
    id: specification.id,
    projectId: specification.projectId,
    version: specification.version,
    fullSpecification: specification.fullSpecification,
    changeSummary: specification.changeSummary,
    source: specification.source,
    parentVersionId: specification.parentVersionId ?? undefined,
    sourceCycleId: specification.sourceCycleId ?? undefined,
    approvedAt: specification.approvedAt?.toISOString(),
    createdAt: specification.createdAt.toISOString()
  };
}

export function toProjectContractVersion(version: ProjectContractVersion): CoreProjectContractVersion {
  const contract = toProjectContract(version.contractJson);
  if (!contract) {
    throw new Error(`Stored project contract version "${version.id}" is invalid.`);
  }
  return {
    id: version.id,
    projectId: version.projectId,
    specificationVersionId: version.specificationVersionId ?? undefined,
    version: version.version,
    contract,
    contractDelta: toProjectContractDelta(version.contractDelta),
    changeSummary: version.changeSummary,
    source: version.source,
    parentVersionId: version.parentVersionId ?? undefined,
    createdAt: version.createdAt.toISOString()
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
    changeRationale: step.changeRationale,
    dependsOnStepTitles: jsonStringArray(step.dependsOnStepTitles),
    validationFocus: jsonStringArray(step.validationFocus).filter(
      (item): item is CoreProjectImplementationStep['validationFocus'][number] =>
        item === 'implementation' || item === 'migration' || item === 'compatibility' || item === 'regression'
    ),
    status: step.status,
    taskId: step.taskId ?? undefined,
    createdAt: step.createdAt.toISOString(),
    updatedAt: step.updatedAt.toISOString(),
    completedAt: step.completedAt?.toISOString()
  };
}

export function toProjectArchitectureVersion(version: ProjectArchitectureVersion): CoreProjectArchitectureVersion {
  const architecture = toProjectArchitecture(version.architectureJson);
  if (!architecture) {
    throw new Error(`Stored project architecture version "${version.id}" is invalid.`);
  }
  return {
    id: version.id,
    projectId: version.projectId,
    version: version.version,
    architecture,
    architectureUpdate: version.architectureUpdate
      ? JSON.parse(JSON.stringify(version.architectureUpdate)) as CoreProjectArchitectureVersion['architectureUpdate']
      : undefined,
    changeSummary: version.changeSummary,
    source: version.source,
    parentVersionId: version.parentVersionId ?? undefined,
    contractVersionId: version.contractVersionId ?? undefined,
    sourceTaskId: version.sourceTaskId ?? undefined,
    createdAt: version.createdAt.toISOString()
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

export function toProjectContract(value: Prisma.JsonValue | null): ProjectContract | undefined {
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
      acceptanceCriteria: requirement.acceptanceCriteria.filter((criterion): criterion is string => typeof criterion === 'string'),
      briefReferences: Array.isArray(requirement.briefReferences)
        ? requirement.briefReferences.filter((reference): reference is string => typeof reference === 'string')
        : undefined,
      status: requirement.status === 'active' || requirement.status === 'superseded' || requirement.status === 'removed'
        ? requirement.status as ProjectContractRequirementStatus
        : undefined,
      introducedInVersion: typeof requirement.introducedInVersion === 'number'
        ? requirement.introducedInVersion
        : undefined,
      lastChangedInVersion: typeof requirement.lastChangedInVersion === 'number'
        ? requirement.lastChangedInVersion
        : undefined,
      supersededByRequirementId: typeof requirement.supersededByRequirementId === 'string'
        ? requirement.supersededByRequirementId
        : undefined,
      lifecycleReason: typeof requirement.lifecycleReason === 'string'
        ? requirement.lifecycleReason
        : undefined
    }];
  });

  if (requirements.length !== contract.requirements.length) return undefined;
  return {
    version: contract.version,
    sourceBriefHash: typeof contract.sourceBriefHash === 'string' ? contract.sourceBriefHash : undefined,
    sourceBriefSnapshot: typeof contract.sourceBriefSnapshot === 'string' ? contract.sourceBriefSnapshot : undefined,
    summary: contract.summary,
    invariants: contract.invariants.filter((item): item is string => typeof item === 'string'),
    prohibitedSubstitutes: contract.prohibitedSubstitutes.filter((item): item is string => typeof item === 'string'),
    requirements,
    releaseCriteria: contract.releaseCriteria.filter((item): item is string => typeof item === 'string')
  };
}

function toProjectContractDelta(value: Prisma.JsonValue | null): ProjectContractDelta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const delta = value as Record<string, Prisma.JsonValue>;
  if (
    typeof delta.baseVersion !== 'number'
    || !Array.isArray(delta.addRequirements)
    || !Array.isArray(delta.updateRequirements)
    || !Array.isArray(delta.supersedeRequirements)
    || !Array.isArray(delta.removeRequirements)
    || !delta.invariantChanges || typeof delta.invariantChanges !== 'object' || Array.isArray(delta.invariantChanges)
    || !delta.prohibitedSubstituteChanges || typeof delta.prohibitedSubstituteChanges !== 'object' || Array.isArray(delta.prohibitedSubstituteChanges)
    || !delta.releaseCriteriaChanges || typeof delta.releaseCriteriaChanges !== 'object' || Array.isArray(delta.releaseCriteriaChanges)
    || !Array.isArray(delta.migrationImpacts)
    || !Array.isArray(delta.compatibilityImpacts)
  ) return undefined;

  return JSON.parse(JSON.stringify(value)) as ProjectContractDelta;
}

export function toTask(task: Task): ForgeTask {
  return {
    id: task.id,
    projectId: task.projectId,
    createdByUserId: task.createdByUserId,
    title: task.title,
    prompt: task.prompt,
    acceptanceCriteria: jsonStringArray(task.acceptanceCriteria),
    mode: task.mode,
    status: task.status,
    deferredValidationCapabilities: jsonStringArray(task.deferredValidationCapabilities),
    githubIssueNumber: task.githubIssueNumber ?? undefined,
    githubIssueUrl: task.githubIssueUrl ?? undefined,
    branchName: task.branchName ?? undefined,
    architectureVersionId: task.architectureVersionId ?? undefined,
    pullRequestNumber: task.pullRequestNumber ?? undefined,
    pullRequestUrl: task.pullRequestUrl ?? undefined,
    providerSessionId: task.providerSessionId ?? undefined,
    providerSessionProvider: task.providerSessionProvider ?? undefined,
    providerSessionModel: task.providerSessionModel ?? undefined,
    providerSessionConnectionId: task.providerSessionConnectionId ?? undefined,
    providerSessionUpdatedAt: task.providerSessionUpdatedAt?.toISOString(),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    startedAt: task.startedAt?.toISOString(),
    finishedAt: task.finishedAt?.toISOString()
  };
}

export function toTaskRun(run: TaskRun): CoreTaskRun {
  const detail = run.errorMessage ?? run.summary ?? undefined;
  const fallbackState = normalizeRunState(run.status, { detail });
  return {
    id: run.id,
    taskId: run.taskId,
    provider: run.provider,
    model: run.model,
    status: run.status,
    state: parseTaskRunState(run.runStateJson as JsonValue, fallbackState),
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

export function toAuditEvent(event: AuditLog): AuditEvent {
  return {
    id: event.id,
    actorType: event.actorType,
    actorId: event.actorId ?? undefined,
    eventType: event.eventType,
    projectId: event.projectId ?? undefined,
    taskId: event.taskId ?? undefined,
    chatThreadId: event.chatThreadId ?? undefined,
    chatRunId: event.chatRunId ?? undefined,
    payload: event.payload as JsonValue,
    createdAt: event.createdAt.toISOString()
  };
}

export function toChatThread(thread: ChatThread): CoreChatThread {
  return {
    id: thread.id,
    userId: thread.userId,
    projectId: thread.projectId ?? undefined,
    providerConnectionId: thread.providerConnectionId ?? undefined,
    title: thread.title,
    status: thread.status,
    mode: thread.mode,
    repositoryOwner: thread.repositoryOwner ?? undefined,
    repositoryName: thread.repositoryName ?? undefined,
    baseBranch: thread.baseBranch ?? undefined,
    branchName: thread.branchName ?? undefined,
    contextSummary: thread.contextSummary ?? undefined,
    providerSessionId: thread.providerSessionId ?? undefined,
    providerSessionProvider: thread.providerSessionProvider ?? undefined,
    providerSessionModel: thread.providerSessionModel ?? undefined,
    providerSessionConnectionId: thread.providerSessionConnectionId ?? undefined,
    providerSessionUpdatedAt: thread.providerSessionUpdatedAt?.toISOString(),
    lastMessageAt: thread.lastMessageAt?.toISOString(),
    archivedAt: thread.archivedAt?.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString()
  };
}

export function toChatMessage(message: ChatMessage): CoreChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    runId: message.runId ?? undefined,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    metadata: message.metadataJson === null ? undefined : message.metadataJson as JsonValue,
    createdAt: message.createdAt.toISOString()
  };
}

export function toChatRun(run: ChatRun): CoreChatRun {
  return {
    id: run.id,
    threadId: run.threadId,
    status: run.status,
    prompt: run.prompt,
    provider: run.provider ?? undefined,
    model: run.model ?? undefined,
    attemptCount: run.attemptCount,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    totalTokens: run.totalTokens,
    cachedTokens: run.cachedTokens,
    actualCostUsd: run.actualCostUsd === null ? undefined : Number(run.actualCostUsd),
    errorMessage: run.errorMessage ?? undefined,
    responseSummary: run.responseSummary ?? undefined,
    result: run.resultJson === null ? undefined : run.resultJson as JsonValue,
    stopRequested: run.stopRequested,
    nextAttemptAt: run.nextAttemptAt?.toISOString(),
    claimedAt: run.claimedAt?.toISOString(),
    heartbeatAt: run.heartbeatAt?.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString()
  };
}

export function toPrismaJson(value: JsonValue): Prisma.InputJsonValue {
  return sanitizePostgresJson(value) as Prisma.InputJsonValue;
}

export function sanitizePostgresText(value: string): string {
  return value.replace(/\u0000/g, '\\u0000');
}

function sanitizePostgresJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return sanitizePostgresText(value);
  if (Array.isArray(value)) return value.map(sanitizePostgresJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizePostgresJson(item)])
    );
  }
  return value;
}
