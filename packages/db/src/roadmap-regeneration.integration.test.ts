import { PrismaClient } from '@prisma/client';
import { applyProjectContractDelta } from '@forgemind/core';
import type { AuditGapProposal, ProjectContract, ProjectContractDelta, RoadmapGenerationCheckpoint } from '@forgemind/core';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForgeMindRepository } from './repository.js';
import { advanceRoadmapAfterTaskCompletion, startNextRoadmapStep } from './roadmap.js';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://forgemind:forgemind@127.0.0.1:5432/forgemind_validation';
const integrationSchema = `roadmap_regeneration_${process.pid}_${Date.now()}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const schemaDatabaseUrl = (() => {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', integrationSchema);
  return url.toString();
})();
interface PostgreSqlClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

let prisma: PrismaClient;
let admin: PostgreSqlClient | undefined;

const initialContract: ProjectContract = {
  version: 1,
  summary: 'A focused ledger.',
  invariants: [],
  prohibitedSubstitutes: [],
  requirements: [{
    id: 'REQ-LEDGER', title: 'Ledger', description: 'Persist ledger entries.',
    acceptanceCriteria: ['Entries persist.'], briefReferences: ['ledger entries']
  }],
  releaseCriteria: ['Ledger is usable.']
};

describe('roadmap regeneration lifecycle', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { Client } = require('pg') as { Client: new (input: { connectionString: string }) => PostgreSqlClient };
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(integrationSchema)}`);
    const migrationsDirectory = path.resolve(process.cwd(), 'prisma/migrations');
    const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    await admin.query(`SET search_path TO ${quoteIdentifier(integrationSchema)}, public`);
    for (const migration of migrations) {
      await admin.query(readFileSync(path.join(migrationsDirectory, migration, 'migration.sql'), 'utf8'));
    }
    prisma = new PrismaClient({ datasourceUrl: schemaDatabaseUrl });
    await prisma.project.create({
      data: { id: 'roadmap_regeneration_project', name: 'Roadmap regeneration', slug: 'roadmap-regeneration', brief: 'Build a focused ledger application.' }
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(integrationSchema)} CASCADE`);
      await admin.end();
    }
  }, 60_000);

  it('cancels unfinished steps from older cycles when their replacement cycle is persisted', async () => {
    const repository = new ForgeMindRepository(prisma);
    const first = await repository.createProjectRoadmapCycle({
      projectId: 'roadmap_regeneration_project', objective: 'Build a ledger.', projectContract: initialContract,
      steps: [{
        title: 'Build ledger', description: 'Implement ledger persistence.', acceptanceCriteria: ['Entries persist.'],
        requirementIds: ['REQ-LEDGER'], deliverables: ['Ledger module'], changeRationale: 'Implements the ledger.',
        dependsOnStepTitles: [], validationFocus: ['implementation']
      }]
    });
    expect(first.steps[0]?.status).toBe('pending');

    const delta: ProjectContractDelta = {
      baseVersion: 1,
      addRequirements: [{
        id: 'REQ-EXPORT', title: 'Export', description: 'Export ledger entries.',
        acceptanceCriteria: ['Entries can be exported.'], briefReferences: ['export']
      }],
      updateRequirements: [], supersedeRequirements: [], removeRequirements: [],
      invariantChanges: { add: [], remove: [] }, prohibitedSubstituteChanges: { add: [], remove: [] },
      releaseCriteriaChanges: { add: [], remove: [] }, migrationImpacts: [], compatibilityImpacts: []
    };
    const nextContract = applyProjectContractDelta(initialContract, delta).contract;
    const second = await repository.createProjectRoadmapCycle({
      projectId: 'roadmap_regeneration_project', objective: 'Add export.', projectContract: nextContract, contractDelta: delta,
      qualityReview: { verdict: 'satisfied', summary: 'Roadmap is focused.' },
      steps: [{
        title: 'Build export', description: 'Implement ledger export.', acceptanceCriteria: ['Entries can be exported.'],
        requirementIds: ['REQ-EXPORT'], deliverables: ['Export module'], changeRationale: 'Implements export.',
        dependsOnStepTitles: [], validationFocus: ['implementation', 'regression']
      }]
    });

    const oldStep = second.steps.find((step) => step.cycleId === first.cycles[0]?.id);
    const newStep = second.steps.find((step) => step.cycleId === second.cycles.at(-1)?.id);
    expect(oldStep?.status).toBe('cancelled');
    expect(newStep?.status).toBe('pending');
    expect(second.cycles[0]?.status).toBe('completed');
    const supersededAudit = await prisma.auditLog.findFirst({ where: { eventType: 'project_roadmap_steps_superseded' } });
    expect(supersededAudit?.payload).toMatchObject({ replacementCycleId: second.cycles.at(-1)?.id });
  }, 30_000);

  it('durably resumes only the latest matching draft and retains redacted review history', async () => {
    const repository = new ForgeMindRepository(prisma);
    const projectId = 'roadmap_regeneration_project';
    const checkpoint: RoadmapGenerationCheckpoint = {
      version: 1, phase: 'repair', revision: 3,
      plan: { summary: 'Export draft', steps: [], acceptanceCriteria: [], implementationSteps: [] },
      validationError: 'Resolve overlapping steps.',
      qualityReview: { verdict: 'not_satisfied', summary: 'Overlap', blockers: ['Resolve overlapping steps.'] }
    };
    await repository.saveRoadmapGenerationCheckpoint(projectId, 'source-a', {
      ...checkpoint,
      plan: { ...checkpoint.plan, providerPrompt: 'not durable', providerResponse: 'not durable' },
      qualityReview: { ...checkpoint.qualityReview!, providerPrompt: 'not durable' }
    } as RoadmapGenerationCheckpoint);
    const afterRestart = new ForgeMindRepository(prisma);
    expect(await afterRestart.getRoadmapGenerationCheckpoint(projectId, 'source-a')).toEqual(checkpoint);
    expect(await afterRestart.getRoadmapGenerationCheckpoint(projectId, 'source-b')).toBeUndefined();
    await afterRestart.saveRoadmapGenerationCheckpoint(projectId, 'source-b', { ...checkpoint, revision: 0, phase: 'validate' });
    expect(await afterRestart.getRoadmapGenerationCheckpoint(projectId, 'source-a')).toBeUndefined();
    expect(await afterRestart.getRoadmapGenerationCheckpoint(projectId, 'source-b')).toMatchObject({ revision: 0, phase: 'validate' });
    const events = await prisma.auditLog.findMany({ where: { projectId, eventType: 'project_roadmap_generation_checkpoint' } });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('not durable');
  });

  it('advances exactly once after an automatic retry without losing completed checkpoints', async () => {
    const repository = new ForgeMindRepository(prisma);
    const project = await prisma.project.create({
      data: { name: 'Retry roadmap', slug: 'retry-roadmap', brief: 'Build a ledger.' }
    });
    const roadmap = await repository.createProjectRoadmapCycle({
      projectId: project.id, objective: 'Build a ledger.', projectContract: initialContract,
      steps: ['First', 'Second'].map((title, index) => ({
        title, description: `Implement ${title}.`, acceptanceCriteria: ['Entries persist.'],
        requirementIds: ['REQ-LEDGER'], deliverables: ['Ledger module'], changeRationale: 'Implements the ledger.',
        dependsOnStepTitles: index === 0 ? [] : ['First'], validationFocus: ['implementation']
      }))
    });
    const cycleId = roadmap.cycles.at(-1)!.id;
    const task = (await startNextRoadmapStep(repository, project.id, cycleId))!;
    const queue = await prisma.taskQueueJob.findFirstOrThrow({ where: { taskId: task.id } });
    await prisma.taskQueueJob.update({ where: { id: queue.id }, data: { status: 'claimed', attemptCount: 1 } });
    const checkpoint = await prisma.taskCheckpoint.create({
      data: { taskId: task.id, key: 'git_push', phase: 'git', status: 'completed', inputHash: 'commit-sha', outputJson: { pushed: true }, completedAt: new Date() }
    });

    await repository.failTask(task.id, 'GitHub rejected the PR description.');
    expect((await repository.getImplementationStepByTaskId(task.id))?.status).toBe('cancelled');
    await repository.finalizeQueueJob(queue.id, 'failed', 'GitHub rejected the PR description.');

    expect((await repository.getImplementationStepByTaskId(task.id))?.status).toBe('running');
    expect((await repository.getTask(task.id))?.status).toBe('submitted');
    expect(await prisma.taskCheckpoint.findUnique({ where: { id: checkpoint.id } })).toEqual(checkpoint);
    expect(await prisma.auditLog.findFirst({
      where: { taskId: task.id, eventType: 'project_implementation_step_status_updated', payload: { path: ['reason'], equals: 'task_queue_retry_scheduled' } }
    })).not.toBeNull();

    // Reproduce the worker's completion path after delivery succeeds on retry.
    await prisma.task.update({ where: { id: task.id }, data: { status: 'ready_for_user_review' } });
    await repository.transitionTask(task.id, 'completed');
    const first = await advanceRoadmapAfterTaskCompletion(repository, task.id);
    const second = await advanceRoadmapAfterTaskCompletion(repository, task.id);
    await repository.finalizeQueueJob(queue.id, 'succeeded');

    expect(first.nextTask?.id).toBeTruthy();
    expect(second.nextTask).toBeUndefined();
    const steps = (await repository.getProjectRoadmap(project.id))!.steps;
    expect(steps.map((step) => step.status)).toEqual(['completed', 'running']);
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(2);
    expect(await prisma.taskQueueJob.count({ where: { taskId: first.nextTask!.id } })).toBe(1);
    expect(await prisma.taskCheckpoint.findUnique({ where: { id: checkpoint.id } })).toEqual(checkpoint);
  }, 30_000);

  it('preserves audit repair history, rejects stale writes and activates only the reviewed revision once', async () => {
    const repository = new ForgeMindRepository(prisma);
    const project = await prisma.project.create({ data: { name: 'Audit repair', slug: 'audit-repair' } });
    const step = { title: 'Ledger', description: 'Persist entries.', acceptanceCriteria: ['Entries persist.'],
      requirementIds: ['REQ-LEDGER'], deliverables: ['Ledger'], changeRationale: 'Ledger is missing.',
      dependsOnStepTitles: [], validationFocus: ['implementation' as const] };
    const roadmap = await repository.createProjectRoadmapCycle({
      projectId: project.id, objective: 'Ledger', projectContract: initialContract, steps: [step]
    });
    const cycleId = roadmap.cycles.at(-1)!.id;
    const job = await prisma.projectAuditJob.create({ data: { projectId: project.id, cycleId, status: 'claimed' } });
    const original: AuditGapProposal = { kind: 'capability', summary: 'Missing durability.', commitSha: 'a'.repeat(40), newRequirements: [], steps: [{ ...step, title: 'Fix durability' }] };
    await repository.saveProjectAuditGapProposal(job.id, original);
    await prisma.projectAuditJob.update({ where: { id: job.id }, data: { status: 'succeeded' } });
    const rejected = { verdict: 'not_satisfied' as const, summary: 'Name exact path.', blockers: ['Name the durability module.'] };
    await repository.saveProjectAuditGapReview({ projectId: project.id, auditJobId: job.id, review: rejected, expectedProposal: original });
    const revision = { ...original, steps: [{ ...original.steps[0]!, description: 'Repair the transaction in src/ledger.ts.' }] };
    const saved = await repository.reviseProjectAuditGapProposal({ projectId: project.id, auditJobId: job.id, proposal: revision, expectedProposal: original });
    expect(saved.gapProposalReview).toBeUndefined();
    expect(saved.gapProposalHistory).toMatchObject([{ proposal: original, review: rejected }]);
    expect(saved.gapProposal).toEqual(revision);
    const satisfied = { verdict: 'satisfied' as const, summary: 'Concrete gap.', blockers: [] };
    await expect(repository.reviseProjectAuditGapProposal({ projectId: project.id, auditJobId: job.id, proposal: original, expectedProposal: original })).rejects.toThrow('changed during repair');
    await expect(repository.saveProjectAuditGapReview({ projectId: project.id, auditJobId: job.id, review: satisfied, expectedProposal: original })).rejects.toThrow('changed during review');
    await expect(repository.decideProjectAuditGapProposal({ projectId: project.id, auditJobId: job.id, accepted: true, review: satisfied, expectedProposal: original })).rejects.toThrow('changed before activation');
    await repository.saveProjectAuditGapReview({ projectId: project.id, auditJobId: job.id, review: satisfied, expectedProposal: revision });
    const accepted = { projectId: project.id, auditJobId: job.id, accepted: true, review: satisfied, expectedProposal: revision };
    await repository.decideProjectAuditGapProposal(accepted);
    await repository.decideProjectAuditGapProposal(accepted);
    const current = (await repository.getProjectRoadmap(project.id))!;
    expect(current.auditJobs[0]?.gapProposalStatus).toBe('activated');
    expect(current.steps.filter(s => s.title === 'Fix durability')).toHaveLength(1);
    expect(current.steps.find(s => s.title === 'Fix durability')?.description).toContain('src/ledger.ts');
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(0);
    await expect(repository.reviseProjectAuditGapProposal({ projectId: project.id, auditJobId: job.id, proposal: original, expectedProposal: revision })).rejects.toThrow('Active audit gap proposal');
  }, 30_000);

  it('does not reopen superseded cycles or explicitly cancelled tasks during automatic retry', async () => {
    const repository = new ForgeMindRepository(prisma);
    for (const scenario of ['superseded', 'cancelled-task'] as const) {
      const project = await prisma.project.create({
        data: { name: scenario, slug: `retry-${scenario}`, brief: 'Build a ledger.' }
      });
      const roadmap = await repository.createProjectRoadmapCycle({
        projectId: project.id, objective: 'Build a ledger.', projectContract: initialContract,
        steps: [{
          title: 'First', description: 'Build the ledger.', acceptanceCriteria: ['Entries persist.'],
          requirementIds: ['REQ-LEDGER'], deliverables: ['Ledger module'], changeRationale: 'Implements the ledger.',
          dependsOnStepTitles: [], validationFocus: ['implementation']
        }]
      });
      const cycleId = roadmap.cycles.at(-1)!.id;
      const task = (await startNextRoadmapStep(repository, project.id, cycleId))!;
      const queue = await prisma.taskQueueJob.findFirstOrThrow({ where: { taskId: task.id } });
      await prisma.taskQueueJob.update({ where: { id: queue.id }, data: { status: 'claimed', attemptCount: 1 } });
      await repository.failTask(task.id, 'temporary error');
      if (scenario === 'superseded') {
        await repository.updateProjectRoadmapCycleStatus(cycleId, 'completed');
      } else {
        // A cancellation raced with finalization; the task must not be revived.
        await prisma.task.update({ where: { id: task.id }, data: { status: 'cancelled' } });
      }

      await repository.finalizeQueueJob(queue.id, 'failed', 'temporary error');

      expect((await repository.getImplementationStepByTaskId(task.id))?.status).toBe('cancelled');
      expect(await prisma.auditLog.findFirst({
        where: { taskId: task.id, eventType: 'project_implementation_step_status_updated', payload: { path: ['reason'], equals: 'task_queue_retry_scheduled' } }
      })).toBeNull();
      if (scenario === 'cancelled-task') {
        expect((await repository.getTask(task.id))?.status).toBe('cancelled');
        expect((await prisma.taskQueueJob.findUniqueOrThrow({ where: { id: queue.id } })).status).toBe('cancelled');
      }
    }
  }, 30_000);
});
