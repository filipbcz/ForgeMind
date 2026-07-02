import {
  assertTaskTransition,
  type Approval,
  type ApprovalStatus,
  type ApprovalType,
  type AuditEvent,
  type ForgeTask,
  type IterationPhase,
  type Project,
  type ProviderKind,
  type RiskLevel,
  type TaskStatus
} from '@forgemind/core';
import type { JsonValue } from '@forgemind/shared';
import type { Prisma, PrismaClient, TaskMode } from '@prisma/client';
import { toApproval, toAuditEvent, toPrismaJson, toProject, toTask, toTaskRun } from './mappers.js';

export const LOCAL_USER_ID = 'user_local_owner';

export interface UserSnapshot {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'operator';
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  configYaml?: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  maxIterations: number;
  maxBudgetUsd: number;
}

export interface ClaimedTask {
  task: ForgeTask;
  project: Project;
  taskRun: ReturnType<typeof toTaskRun>;
}

export class ForgeMindRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureLocalUser(): Promise<UserSnapshot> {
    const user = await this.prisma.user.upsert({
      where: { id: LOCAL_USER_ID },
      update: {},
      create: {
        id: LOCAL_USER_ID,
        email: 'owner@forgemind.local',
        name: 'Local Owner',
        role: 'owner'
      }
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };
  }

  async getCurrentUser(): Promise<UserSnapshot> {
    return this.ensureLocalUser();
  }

  async listProjects(): Promise<Project[]> {
    const projects = await this.prisma.project.findMany({
      orderBy: { createdAt: 'asc' }
    });
    return projects.map(toProject);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    await this.ensureLocalUser();
    const project = await this.prisma.project.create({
      data: {
        name: input.name,
        slug: input.slug,
        githubOwner: input.githubOwner,
        githubRepo: input.githubRepo,
        defaultBranch: input.defaultBranch,
        configYaml: input.configYaml
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'project_created',
      projectId: project.id,
      payload: { slug: project.slug }
    });

    return toProject(project);
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    return project ? toProject(project) : undefined;
  }

  async listTasks(): Promise<ForgeTask[]> {
    const tasks = await this.prisma.task.findMany({
      orderBy: { updatedAt: 'desc' }
    });
    return tasks.map(toTask);
  }

  async getTask(taskId: string): Promise<ForgeTask | undefined> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    return task ? toTask(task) : undefined;
  }

  async createTask(input: CreateTaskInput): Promise<ForgeTask> {
    await this.ensureLocalUser();
    const project = await this.prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) {
      throw new Error(`Project "${input.projectId}" does not exist`);
    }

    const task = await this.prisma.task.create({
      data: {
        projectId: project.id,
        createdByUserId: LOCAL_USER_ID,
        title: input.title,
        prompt: input.prompt,
        mode: input.mode,
        status: 'draft',
        maxIterations: input.maxIterations,
        maxBudgetUsd: input.maxBudgetUsd
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_created',
      projectId: project.id,
      taskId: task.id,
      payload: { title: task.title, mode: task.mode }
    });

    return toTask(task);
  }

  async startTask(taskId: string): Promise<ForgeTask | undefined> {
    const task = await this.getTask(taskId);
    if (!task) return undefined;
    assertTaskTransition(task.status, 'submitted');

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'submitted',
        startedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_started',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: { status: updated.status }
    });

    return toTask(updated);
  }

  async cancelTask(taskId: string): Promise<ForgeTask | undefined> {
    const task = await this.getTask(taskId);
    if (!task) return undefined;
    assertTaskTransition(task.status, 'cancelled');

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'cancelled',
        finishedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: 'task_cancelled',
      projectId: updated.projectId,
      taskId: updated.id,
      payload: {}
    });

    return toTask(updated);
  }

  async transitionTask(taskId: string, nextStatus: TaskStatus, payload: JsonValue = {}): Promise<ForgeTask> {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`Task "${taskId}" not found`);
    assertTaskTransition(current.status, nextStatus);

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: nextStatus,
        finishedAt: nextStatus === 'completed' ? new Date() : undefined
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: `task_status_${nextStatus}`,
      projectId: updated.projectId,
      taskId: updated.id,
      payload
    });

    return toTask(updated);
  }

  async updateTaskGitHubFields(
    taskId: string,
    fields: {
      githubIssueNumber?: number;
      githubIssueUrl?: string;
      branchName?: string;
      pullRequestNumber?: number;
      pullRequestUrl?: string;
      status?: TaskStatus;
    }
  ): Promise<ForgeTask> {
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: fields
    });
    return toTask(updated);
  }

  async claimNextSubmittedTask(provider: ProviderKind, model = 'mock'): Promise<ClaimedTask | undefined> {
    return this.prisma.$transaction(async (tx) => {
      const queued = await tx.task.findFirst({
        where: { status: 'submitted' },
        include: { project: true },
        orderBy: { createdAt: 'asc' }
      });
      if (!queued) return undefined;

      const updated = await tx.task.update({
        where: { id: queued.id },
        data: { status: 'planning' },
        include: { project: true }
      });

      const taskRun = await tx.taskRun.create({
        data: {
          taskId: updated.id,
          provider,
          model,
          status: 'running',
          startedAt: new Date()
        }
      });

      await tx.auditLog.create({
        data: {
          actorType: 'agent',
          eventType: 'task_claimed',
          projectId: updated.projectId,
          taskId: updated.id,
          payload: { provider }
        }
      });

      return {
        task: toTask(updated),
        project: toProject(updated.project),
        taskRun: toTaskRun(taskRun)
      };
    });
  }

  async createIteration(input: {
    taskRunId: string;
    iterationNumber: number;
    phase: IterationPhase;
    prompt: string;
    resultSummary: string;
    diffStat: JsonValue;
    validationResult: JsonValue;
  }): Promise<void> {
    await this.prisma.taskIteration.create({
      data: {
        taskRunId: input.taskRunId,
        iterationNumber: input.iterationNumber,
        phase: input.phase,
        prompt: input.prompt,
        resultSummary: input.resultSummary,
        diffStatJson: toPrismaJson(input.diffStat),
        validationResultJson: toPrismaJson(input.validationResult)
      }
    });
  }

  async finishTaskRun(input: {
    taskRunId: string;
    status: 'succeeded' | 'failed' | 'cancelled';
    summary?: string;
    errorMessage?: string;
    iterationCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  }): Promise<void> {
    await this.prisma.taskRun.update({
      where: { id: input.taskRunId },
      data: {
        status: input.status,
        summary: input.summary,
        errorMessage: input.errorMessage,
        iterationCount: input.iterationCount,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        estimatedCostUsd: input.estimatedCostUsd,
        finishedAt: new Date()
      }
    });
  }

  async failTask(taskId: string, errorMessage: string, status: TaskStatus = 'failed'): Promise<void> {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status,
        finishedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'system',
      eventType: 'task_failed',
      projectId: task.projectId,
      taskId: task.id,
      payload: { errorMessage, status }
    });
  }

  async listApprovals(): Promise<Approval[]> {
    const approvals = await this.prisma.approval.findMany({
      orderBy: { createdAt: 'desc' }
    });
    return approvals.map(toApproval);
  }

  async getApproval(approvalId: string): Promise<Approval | undefined> {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    return approval ? toApproval(approval) : undefined;
  }

  async createApproval(input: {
    taskId: string;
    type: ApprovalType;
    requestedBy: Approval['requestedBy'];
    title: string;
    description: string;
    riskLevel: RiskLevel;
    payload: JsonValue;
  }): Promise<Approval> {
    const approval = await this.prisma.approval.create({
      data: {
        taskId: input.taskId,
        type: input.type,
        requestedBy: input.requestedBy,
        title: input.title,
        description: input.description,
        riskLevel: input.riskLevel,
        payloadJson: toPrismaJson(input.payload)
      }
    });

    await this.writeAudit({
      actorType: 'agent',
      eventType: 'approval_requested',
      taskId: approval.taskId,
      payload: { type: approval.type, riskLevel: approval.riskLevel }
    });

    return toApproval(approval);
  }

  async resolveApproval(approvalId: string, status: Extract<ApprovalStatus, 'approved' | 'rejected'>): Promise<Approval | undefined> {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) return undefined;
    if (approval.status !== 'pending') {
      throw new Error(`Approval "${approvalId}" is already ${approval.status}`);
    }

    const updated = await this.prisma.approval.update({
      where: { id: approvalId },
      data: {
        status,
        approvedByUserId: status === 'approved' ? LOCAL_USER_ID : null,
        resolvedAt: new Date()
      }
    });

    await this.writeAudit({
      actorType: 'user',
      actorId: LOCAL_USER_ID,
      eventType: status === 'approved' ? 'approval_approved' : 'approval_rejected',
      taskId: updated.taskId,
      payload: { approvalId }
    });

    return toApproval(updated);
  }

  async listTaskAudit(taskId: string): Promise<AuditEvent[]> {
    const events = await this.prisma.auditLog.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' }
    });
    return events.map(toAuditEvent);
  }

  async writeAudit(input: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent> {
    const event = await this.prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId,
        eventType: input.eventType,
        projectId: input.projectId,
        taskId: input.taskId,
        payload: toPrismaJson(input.payload)
      }
    });
    return toAuditEvent(event);
  }

  async recordProviderUsage(input: {
    taskId: string;
    taskRunId: string;
    provider: ProviderKind;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    credits?: number;
    estimatedCostUsd: number;
  }): Promise<void> {
    await this.prisma.providerUsage.create({
      data: {
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedTokens: input.cachedTokens ?? 0,
        credits: input.credits ?? 0,
        estimatedCostUsd: input.estimatedCostUsd
      }
    });
  }
}

export function createRepository(prisma: PrismaClient): ForgeMindRepository {
  return new ForgeMindRepository(prisma);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
}

export type PrismaJsonObject = Prisma.JsonObject;
