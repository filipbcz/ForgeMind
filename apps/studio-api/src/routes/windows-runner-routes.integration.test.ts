import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForgeMindRepository, WindowsRunnerCredentialAdapter, WindowsWorkerRepository } from '@forgemind/db';
import { registerWindowsRunnerRoutes } from './windows-runner-routes.js';

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://forgemind:forgemind@127.0.0.1:5432/forgemind_validation';
const schema = `windows_fake_runner_${process.pid}_${Date.now()}`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const schemaUrl = (() => { const url = new URL(databaseUrl); url.searchParams.set('schema', schema); return url.toString(); })();
interface PgClient { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> }

describe('Windows runner real transport and persistence flow', () => {
  let prisma: PrismaClient;
  let admin: PgClient;
  let adminConnected = false;

  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const { Client } = require('pg') as { Client: new (input: { connectionString: string }) => PgClient };
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    adminConnected = true;
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}, public`);
    const migrations = path.resolve(process.cwd(), '../../packages/db/prisma/migrations');
    for (const entry of readdirSync(migrations, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
      await admin.query(readFileSync(path.join(migrations, entry, 'migration.sql'), 'utf8'));
    }
    prisma = new PrismaClient({ datasourceUrl: schemaUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (adminConnected) { await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); await admin.end(); }
  }, 60_000);

  it('enrolls, requires a manual session, leases, heartbeats, reconciles evidence, and resumes once', async () => {
    const ids = {
      user: '11111111-1111-4111-8111-111111111111', project: '22222222-2222-4222-8222-222222222222',
      task: '33333333-3333-4333-8333-333333333333', run: '44444444-4444-4444-8444-444444444444',
      device: '55555555-5555-4555-8555-555555555555', job: '66666666-6666-4666-8666-666666666666'
    };
    const commitSha = 'a'.repeat(64); const inputHash = 'b'.repeat(64); const checkId = 'validation:windows-fixture';
    await prisma.user.create({ data: { id: ids.user, email: 'fake-runner@invalid.local', name: 'Fake Runner' } });
    await prisma.project.create({ data: { id: ids.project, name: 'Fake Runner', slug: `fake-runner-${process.pid}` } });
    await prisma.task.create({ data: { id: ids.task, projectId: ids.project, createdByUserId: ids.user, title: 'Fixture', prompt: 'Fixture', status: 'waiting_for_capability', waitingForCapabilities: ['windows'] } });
    await prisma.taskRun.create({ data: { id: ids.run, taskId: ids.task, provider: 'codex', model: 'test', status: 'succeeded' } });
    await prisma.taskCheckpoint.create({ data: { taskId: ids.task, taskRunId: ids.run, key: checkId, phase: 'validation', status: 'completed', inputHash,
      outputJson: { evidenceVersion: 1, deferred: true, command: 'fixture.exe --validate', commitSha } } });

    const workers = new WindowsWorkerRepository(prisma);
    await workers.registerDevice({ id: ids.device, runnerVersion: 'fake-1', displayName: 'Fake runner', capabilities: [{ key: 'windows' }], probeEvidence: [{
      schemaVersion: 1, capability: { key: 'windows' }, status: 'supported', probedAt: new Date().toISOString(), probeVersion: 'fixture-1', summary: 'supported', evidenceHash: 'c'.repeat(64)
    }] });
    await workers.enqueue({ id: ids.job, projectId: ids.project, taskId: ids.task, runId: ids.run, requiredCapabilities: ['windows'], packet: {
      schemaVersion: 1, projectId: ids.project, taskId: ids.task, runId: ids.run, checkId, jobId: ids.job, leaseId: 'pending', repository: 'owner/repo',
      sourceUrl: 'https://example.test/owner/repo.git', commitSha, workspaceRoot: 'C:\\fixture', artifactRoot: 'C:\\fixture\\artifacts',
      check: { command: 'fixture.exe --validate', category: 'smoke', requiredCapabilities: ['windows'] }, requiredCapabilities: ['windows'],
      resourcePolicy: { timeoutSeconds: 30, maxLogBytes: 1024, maxArtifactBytes: 1024 }, expectedArtifacts: [], nonce: 'pending', inputHash
    } });

    const app = Fastify();
    registerWindowsRunnerRoutes(app, new ForgeMindRepository(prisma), new WindowsRunnerCredentialAdapter(prisma), workers);
    const enrollment = (await app.inject({ method: 'POST', url: '/api/windows-runner/enrollments', payload: { deviceId: ids.device, expiresInMinutes: 10 } })).json();
    const credential = (await app.inject({ method: 'POST', url: '/api/windows-runner/enroll', payload: { code: enrollment.code } })).json().credential as string;
    const headers = { authorization: `Bearer ${credential}` };
    const absentSession = '77777777-7777-4777-8777-777777777777';
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/lease', headers, payload: { sessionId: absentSession, requestId: 'before-session' } })).json()).toEqual({ job: null, lease: null });

    const sessionId = (await app.inject({ method: 'POST', url: '/api/windows-runner/device/session', headers, payload: { expiresInMinutes: 30 } })).json().sessionId as string;
    const claim = (await app.inject({ method: 'POST', url: '/api/windows-runner/device/lease', headers, payload: { sessionId, requestId: 'fake-runner-request' } })).json();
    expect(claim.job.id).toBe(ids.job);
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/heartbeat', headers, payload: { sessionId, leaseId: claim.lease.id } })).statusCode).toBe(200);
    const logText = 'fixture passed'; const logHash = createHash('sha256').update(logText).digest('hex');
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/evidence', headers, payload: { schemaVersion: 1, jobId: ids.job, leaseId: claim.lease.id,
      inputHash, commitSha, log: { text: logText, sizeBytes: Buffer.byteLength(logText), sha256: logHash }, artifacts: [] } })).statusCode).toBe(200);
    const result = { schemaVersion: 1, projectId: ids.project, taskId: ids.task, runId: ids.run, checkId, jobId: ids.job, leaseId: claim.lease.id, deviceId: ids.device,
      sessionId, nonce: 'fake-runner-request', inputHash, commitSha, observedCapabilities: [{ key: 'windows' }], toolVersions: [], status: 'succeeded',
      startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:01.000Z', summary: 'fixture passed', logHash, artifacts: [] };
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/result', headers, payload: result })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/windows-runner/device/result', headers, payload: result })).statusCode).toBe(409);

    expect(await prisma.windowsExecutionJob.findUniqueOrThrow({ where: { id: ids.job } })).toMatchObject({ status: 'succeeded' });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: ids.task } })).toMatchObject({ status: 'submitted' });
    expect(await prisma.taskQueueJob.count({ where: { taskId: ids.task, reason: 'windows_validation_completed' } })).toBe(1);
    expect((await prisma.taskCheckpoint.findUniqueOrThrow({ where: { taskId_key: { taskId: ids.task, key: checkId } } })).outputJson).toMatchObject({ deferred: false, commitSha, inputHash, passed: true });
  }, 30_000);
});
