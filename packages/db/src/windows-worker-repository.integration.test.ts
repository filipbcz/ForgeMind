import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalizeWorkerProbeEvidence } from '@forgemind/core';
import { WindowsWorkerRepository } from './windows-worker-repository.js';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://forgemind:forgemind@127.0.0.1:5432/forgemind_validation';
const describeDatabase = describe;
const integrationHookTimeoutMs = 60_000;
const integrationSchema = `windows_lease_${process.pid}_${Date.now()}`;
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
const ids = { user: 'lease_test_user', project: 'lease_test_project', task: 'lease_test_task', run: 'lease_test_run', device: 'lease_test_device', session: 'lease_test_session', job: 'lease_test_job' };
const digest = 'a'.repeat(64);
const integrationPacket = { schemaVersion: 2 as const, projectId: ids.project, taskId: ids.task, runId: ids.run, checkId: 'lease_test_check', jobId: ids.job,
  leaseId: 'pending', repository: 'owner/repo', sourceUrl: 'https://example.test/repo.git', commitSha: digest, workspaceRoot: 'C:\\work', artifactRoot: 'C:\\artifacts',
  check: { command: 'fixture.exe', category: 'smoke' as const, requiredCapabilities: ['windows'] }, requiredCapabilities: ['windows'],
  dispatch: { kind: 'deferred' as const, reason: 'unsupported_validation_intent' as const, handling: 'manual-local' as const },
  resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 }, expectedArtifacts: [], nonce: 'pending', inputHash: digest };
let first: PrismaClient;
let second: PrismaClient;
let admin: PostgreSqlClient | undefined;

describeDatabase('WindowsWorkerRepository PostgreSQL concurrency', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { Client } = require('pg') as { Client: new (input: { connectionString: string }) => PostgreSqlClient };
    admin = new Client({ connectionString: databaseUrl! });
    await admin!.connect();
    await admin!.query(`CREATE SCHEMA ${quoteIdentifier(integrationSchema)}`);
    const migrationsDirectory = path.resolve(process.cwd(), 'prisma/migrations');
    const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    await admin!.query(`SET search_path TO ${quoteIdentifier(integrationSchema)}, public`);
    for (const migration of migrations) {
      await admin!.query(readFileSync(path.join(migrationsDirectory, migration, 'migration.sql'), 'utf8'));
    }
    first = new PrismaClient({ datasourceUrl: schemaDatabaseUrl });
    second = new PrismaClient({ datasourceUrl: schemaDatabaseUrl });
    await first.$executeRaw`INSERT INTO "users" ("id", "email", "name", "role", "created_at", "updated_at")
      VALUES (${ids.user}, 'lease-test@invalid.local', 'Lease test', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`;
    await first.$executeRaw`INSERT INTO "projects" ("id", "name", "slug", "default_branch", "created_at", "updated_at")
      VALUES (${ids.project}, 'Lease test', 'lease-test-project', 'main', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`;
    await first.$executeRaw`INSERT INTO "tasks" ("id", "project_id", "created_by_user_id", "title", "prompt", "status", "created_at", "updated_at")
      VALUES (${ids.task}, ${ids.project}, ${ids.user}, 'Lease test', 'Lease test', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`;
    await first.$executeRaw`INSERT INTO "task_runs" ("id", "task_id", "provider", "model", "status")
      VALUES (${ids.run}, ${ids.task}, 'codex', 'test', 'queued') ON CONFLICT ("id") DO NOTHING`;
    const probe = { capability: { key: 'windows' }, status: 'supported' as const, provenance: 'local-probe' as const,
      probedAt: new Date().toISOString(), probeVersion: 'test', summary: 'test' };
    const probeEvidence = [{ schemaVersion: 1, ...probe,
      evidenceHash: createHash('sha256').update(canonicalizeWorkerProbeEvidence(probe)).digest('hex') }];
    await first.$executeRaw`INSERT INTO "worker_devices" ("id", "platform", "runner_version", "display_name", "status", "capabilities", "probe_evidence")
      VALUES (${ids.device}, 'windows', 'test', 'Test', 'idle', ${JSON.stringify([{ key: 'windows' }])}::jsonb, ${JSON.stringify(probeEvidence)}::jsonb)
      ON CONFLICT ("id") DO UPDATE SET "status" = 'idle'`;
    await first.$executeRaw`INSERT INTO "worker_sessions" ("id", "device_id", "status", "expires_at", "authorized_project_ids")
      VALUES (${ids.session}, ${ids.device}, 'active', CURRENT_TIMESTAMP + INTERVAL '10 minutes', ${JSON.stringify([ids.project])}::jsonb)
      ON CONFLICT ("id") DO UPDATE SET "status" = 'active', "expires_at" = CURRENT_TIMESTAMP + INTERVAL '10 minutes',
        "authorized_project_ids" = ${JSON.stringify([ids.project])}::jsonb`;
    await first.$executeRaw`INSERT INTO "windows_execution_jobs" ("id", "project_id", "task_id", "run_id", "status", "required_capabilities", "packet")
      VALUES (${ids.job}, ${ids.project}, ${ids.task}, ${ids.run}, 'queued', '["windows"]', '{}')
      ON CONFLICT ("id") DO UPDATE SET "status" = 'queued'`;
    await first.windowsExecutionJob.update({ where: { id: ids.job }, data: { packet: integrationPacket } });
    await first.$executeRaw`DELETE FROM "windows_execution_leases" WHERE "job_id" = ${ids.job}`;
  }, integrationHookTimeoutMs);

  afterAll(async () => {
    await Promise.all([first?.$disconnect(), second?.$disconnect()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(integrationSchema)} CASCADE`);
      await admin.end();
    }
  }, integrationHookTimeoutMs);

  it('allows exactly one of two concurrent claimers to reserve a queued job', async () => {
    const claims = await Promise.all([
      new WindowsWorkerRepository(first).claimCompatible(ids.session, 60, 'lease_test_request_1'),
      new WindowsWorkerRepository(second).claimCompatible(ids.session, 60, 'lease_test_request_2')
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await first.windowsExecutionLease.count({ where: { jobId: ids.job, status: 'active' } })).toBe(1);
  });

  it('keeps heartbeat and timeout recovery outcomes internally consistent under a race', async () => {
    await first.windowsExecutionLease.deleteMany({ where: { jobId: ids.job } });
    await first.windowsExecutionJob.update({ where: { id: ids.job }, data: { status: 'queued' } });
    await first.workerDevice.update({ where: { id: ids.device }, data: { status: 'idle' } });
    const repository = new WindowsWorkerRepository(first);
    const claim = await repository.claimCompatible(ids.session, 10, 'lease_test_heartbeat_race');
    expect(claim).toBeDefined();
    await first.windowsExecutionLease.update({ where: { id: claim!.lease.id }, data: { expiresAt: new Date(Date.now() + 50) } });
    const recoveryNow = new Date(Date.now() + 100);
    const [heartbeat] = await Promise.all([
      repository.heartbeat(ids.session, claim!.lease.id, 60),
      new WindowsWorkerRepository(second).recoverExpired(recoveryNow)
    ]);
    const lease = await first.windowsExecutionLease.findUniqueOrThrow({ where: { id: claim!.lease.id } });
    const job = await first.windowsExecutionJob.findUniqueOrThrow({ where: { id: ids.job } });
    expect(heartbeat
      ? lease.status === 'active' && job.status === 'running'
      : lease.status === 'expired' && job.status === 'queued').toBe(true);
  });

  it('does not claim a queued job after its task is cancelled', async () => {
    await first.windowsExecutionLease.deleteMany({ where: { jobId: ids.job } });
    await first.windowsExecutionJob.update({ where: { id: ids.job }, data: { status: 'queued' } });
    await first.workerDevice.update({ where: { id: ids.device }, data: { status: 'idle' } });
    await first.task.update({ where: { id: ids.task }, data: { status: 'cancelled' } });
    const claim = await new WindowsWorkerRepository(first).claimCompatible(ids.session, 60, 'stale_task_request');
    expect(claim).toBeUndefined();
    expect(await first.windowsExecutionLease.count({ where: { jobId: ids.job } })).toBe(0);
  });

  it('returns deterministically when a session retries a terminal lease nonce', async () => {
    await first.task.update({ where: { id: ids.task }, data: { status: 'completed' } });
    await first.windowsExecutionJob.update({ where: { id: ids.job }, data: { status: 'queued' } });
    await first.workerDevice.update({ where: { id: ids.device }, data: { status: 'idle' } });
    const repository = new WindowsWorkerRepository(first);
    const original = await repository.claimCompatible(ids.session, 60, 'terminal_retry_request');
    expect(original).toBeDefined();
    await first.windowsExecutionLease.update({ where: { id: original!.lease.id }, data: { status: 'expired', releasedAt: new Date() } });
    await first.windowsExecutionJob.update({ where: { id: ids.job }, data: { status: 'queued' } });
    await first.workerDevice.update({ where: { id: ids.device }, data: { status: 'idle' } });
    expect(await repository.claimCompatible(ids.session, 60, 'terminal_retry_request')).toBeUndefined();
    expect(await first.windowsExecutionLease.count({ where: { sessionId: ids.session, nonce: 'terminal_retry_request' } })).toBe(1);
  });

  it('keeps an unexpired draining session and device draining when its lease expires', async () => {
    await first.windowsExecutionLease.deleteMany({ where: { jobId: ids.job } });
    await first.task.update({ where: { id: ids.task }, data: { status: 'completed' } });
    await first.workerSession.update({ where: { id: ids.session }, data: { status: 'active', expiresAt: new Date(Date.now() + 600_000) } });
    await first.windowsExecutionJob.update({ where: { id: ids.job }, data: { status: 'queued' } });
    await first.workerDevice.update({ where: { id: ids.device }, data: { status: 'idle' } });
    const repository = new WindowsWorkerRepository(first);
    const claim = await repository.claimCompatible(ids.session, 60, 'draining_timeout_request');
    expect(claim).toBeDefined();
    await repository.drainSession(ids.session);
    const recoveryNow = new Date(Date.now() + 120_000);
    const recovered = await repository.recoverExpired(recoveryNow);
    const lease = await first.windowsExecutionLease.findUniqueOrThrow({ where: { id: claim!.lease.id } });
    const job = await first.windowsExecutionJob.findUniqueOrThrow({ where: { id: ids.job } });
    const session = await first.workerSession.findUniqueOrThrow({ where: { id: ids.session } });
    const device = await first.workerDevice.findUniqueOrThrow({ where: { id: ids.device } });
    expect(recovered).toEqual({ sessions: 0, leases: 1, jobs: 1 });
    expect({ lease: lease.status, job: job.status, session: session.status, device: device.status })
      .toEqual({ lease: 'expired', job: 'queued', session: 'draining', device: 'draining' });
  });
});
