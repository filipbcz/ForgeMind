import { PrismaClient } from '@prisma/client';
import { applyProjectContractDelta } from '@forgemind/core';
import type { ProjectContract, ProjectContractDelta } from '@forgemind/core';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForgeMindRepository } from './repository.js';

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
});
