import {
  assertTaskTransition,
  type Approval,
  type ApprovalStatus,
  type AuditEvent,
  type ForgeTask,
  type Project,
  type TaskMode
} from '@forgemind/core';
import { createId, nowIso } from '@forgemind/shared';

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'operator';
}

interface CreateProjectInput {
  name: string;
  slug: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  configYaml?: string;
}

interface CreateTaskInput {
  projectId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  maxIterations: number;
  maxBudgetUsd: number;
}

const seededUser: UserRecord = {
  id: 'user_local_owner',
  email: 'owner@forgemind.local',
  name: 'Local Owner',
  role: 'owner'
};

export function createStore() {
  const users = new Map<string, UserRecord>([[seededUser.id, seededUser]]);
  const projects = new Map<string, Project>();
  const tasks = new Map<string, ForgeTask>();
  const approvals = new Map<string, Approval>();
  const auditLog: AuditEvent[] = [];

  const now = nowIso();
  const demoProject: Project = {
    id: 'project_demo_gallery',
    name: 'Demo Static Gallery',
    slug: 'demo-static-gallery',
    githubOwner: 'demo',
    githubRepo: 'demo-static-gallery',
    defaultBranch: 'main',
    isActive: true,
    createdAt: now,
    updatedAt: now
  };
  projects.set(demoProject.id, demoProject);

  function writeAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent {
    const audit: AuditEvent = {
      ...event,
      id: createId('audit'),
      createdAt: nowIso()
    };
    auditLog.push(audit);
    return audit;
  }

  function createProject(input: CreateProjectInput): Project {
    const timestamp = nowIso();
    const project: Project = {
      id: createId('project'),
      name: input.name,
      slug: input.slug,
      githubOwner: input.githubOwner,
      githubRepo: input.githubRepo,
      defaultBranch: input.defaultBranch,
      configYaml: input.configYaml,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    projects.set(project.id, project);
    writeAudit({
      actorType: 'user',
      actorId: seededUser.id,
      eventType: 'project_created',
      projectId: project.id,
      payload: { slug: project.slug }
    });

    return project;
  }

  function createTask(input: CreateTaskInput): ForgeTask {
    const project = projects.get(input.projectId);
    if (!project) {
      throw new Error(`Project "${input.projectId}" does not exist`);
    }

    const timestamp = nowIso();
    const task: ForgeTask = {
      id: createId('task'),
      projectId: project.id,
      createdByUserId: seededUser.id,
      title: input.title,
      prompt: input.prompt,
      mode: input.mode,
      status: 'draft',
      maxIterations: input.maxIterations,
      maxBudgetUsd: input.maxBudgetUsd,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    tasks.set(task.id, task);
    writeAudit({
      actorType: 'user',
      actorId: seededUser.id,
      eventType: 'task_created',
      projectId: project.id,
      taskId: task.id,
      payload: { title: task.title, mode: task.mode }
    });

    return task;
  }

  function startTask(taskId: string): ForgeTask | undefined {
    const task = tasks.get(taskId);
    if (!task) return undefined;

    assertTaskTransition(task.status, 'submitted');
    const updated: ForgeTask = {
      ...task,
      status: 'submitted',
      startedAt: nowIso(),
      updatedAt: nowIso()
    };
    tasks.set(taskId, updated);
    writeAudit({
      actorType: 'user',
      actorId: seededUser.id,
      eventType: 'task_started',
      projectId: task.projectId,
      taskId: task.id,
      payload: { status: updated.status }
    });

    return updated;
  }

  function cancelTask(taskId: string): ForgeTask | undefined {
    const task = tasks.get(taskId);
    if (!task) return undefined;

    assertTaskTransition(task.status, 'cancelled');
    const updated: ForgeTask = {
      ...task,
      status: 'cancelled',
      finishedAt: nowIso(),
      updatedAt: nowIso()
    };
    tasks.set(taskId, updated);
    writeAudit({
      actorType: 'user',
      actorId: seededUser.id,
      eventType: 'task_cancelled',
      projectId: task.projectId,
      taskId: task.id,
      payload: {}
    });

    return updated;
  }

  function createApproval(input: Omit<Approval, 'id' | 'createdAt' | 'status'>): Approval {
    const approval: Approval = {
      ...input,
      id: createId('approval'),
      status: 'pending',
      createdAt: nowIso()
    };
    approvals.set(approval.id, approval);
    writeAudit({
      actorType: 'agent',
      eventType: 'approval_requested',
      taskId: approval.taskId,
      payload: { type: approval.type, riskLevel: approval.riskLevel }
    });
    return approval;
  }

  function resolveApproval(approvalId: string, status: Extract<ApprovalStatus, 'approved' | 'rejected'>): Approval | undefined {
    const approval = approvals.get(approvalId);
    if (!approval) return undefined;

    if (approval.status !== 'pending') {
      throw new Error(`Approval "${approvalId}" is already ${approval.status}`);
    }

    const updated: Approval = {
      ...approval,
      status,
      approvedByUserId: status === 'approved' ? seededUser.id : undefined,
      resolvedAt: nowIso()
    };
    approvals.set(approvalId, updated);
    writeAudit({
      actorType: 'user',
      actorId: seededUser.id,
      eventType: status === 'approved' ? 'approval_approved' : 'approval_rejected',
      taskId: approval.taskId,
      payload: { approvalId }
    });

    return updated;
  }

  return {
    users,
    projects,
    tasks,
    approvals,
    auditLog,
    currentUser: seededUser,
    createProject,
    createTask,
    startTask,
    cancelTask,
    createApproval,
    resolveApproval,
    writeAudit
  };
}

export type AppStore = ReturnType<typeof createStore>;

