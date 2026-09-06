import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { reconcileRealEngineEvidence } from '@forgemind/core';
import { WindowsWorkerRepository } from './windows-worker-repository.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const now = new Date('2026-09-06T12:00:00.000Z');

function probe(capability: Record<string, unknown>, status: 'supported' | 'failed' = 'supported', ageMs = 0) {
  return { capability, status, provenance: 'local-probe', probedAt: new Date(now.getTime() - ageMs).toISOString() };
}

function device(capabilities: Array<Record<string, unknown>>, probes = capabilities.map((item) => probe(item))) {
  return { id: 'fixture-device', runnerVersion: 'fixture-1', displayName: 'Flying fixture', status: 'idle', capabilities, probeEvidence: probes,
    lastHeartbeatAt: now, sessions: [{ id: 'fixture-session', deviceId: 'fixture-device', status: 'active', startedAt: now,
      expiresAt: new Date(now.getTime() + 60_000), lastHeartbeatAt: now, endedAt: null, authorizedProjectIds: ['fixture-project'], leases: [] }] };
}

function operationsPrisma(devices: unknown[], jobs: unknown[]) {
  return { workerDevice: { findMany: vi.fn(async () => devices) }, windowsExecutionJob: { findMany: vi.fn(async () => jobs) } } as any;
}

describe('non-physical Flying authoring qualification fixture', () => {
  it('submits a binary result through the production authoring protocol only for its exact checkout identity', async () => {
    const inputHash = sha('fixture-input'); const resultTreeSha = 'c'.repeat(40);
    const intent = { classification: 'capture' as const, buildId: 'fixture-build', scenario: 'FlyingSyntheticMap',
      settings: { fixture: true, quality: 'Epic' } };
    const evidence = { ...intent, projectId: 'fixture-project', taskId: 'fixture-task', runId: 'fixture-run', inputHash, resultTreeSha,
      toolVersions: [{ tool: 'fixture-unreal', version: '0' }], startedAt: now.toISOString(), completedAt: now.toISOString(),
      durationMs: 0, state: 'succeeded' as const, exitCode: 0, artifacts: [{ name: 'capture', relativePath: 'Artifacts/Flying.png',
        mimeType: 'image/png', sizeBytes: 7, sha256: sha('capture') }] };
    const identity = { projectId: 'fixture-project', taskId: 'fixture-task', runId: 'fixture-run', inputHash, resultTreeSha };

    expect(reconcileRealEngineEvidence(intent, evidence, identity)).toBe(true);
    expect(reconcileRealEngineEvidence(intent, { ...evidence, resultTreeSha: 'd'.repeat(40) }, identity)).toBe(false);
    expect(reconcileRealEngineEvidence(intent, { ...evidence, settings: { ...evidence.settings, fixture: false } }, identity)).toBe(false);
    const patch = 'diff --git'; const packet = { kind: 'authoring', protocolVersion: 1, projectId: identity.projectId, taskId: identity.taskId,
      runId: identity.runId, jobId: 'fixture-job', leaseId: 'fixture-lease', repository: 'fixture/synthetic-flying',
      sourceUrl: 'https://invalid.test/fixture/synthetic-flying.git', baseCommitSha: 'b'.repeat(40), workspaceRoot: 'runner-managed', artifactRoot: 'runner-managed',
      step: { prompt: 'Author synthetic Flying content', acceptanceCriteria: ['fixture binary exists'] },
      operations: [{ id: 'author', kind: 'modify', path: 'Content/SyntheticFlying.uasset', rationale: 'Author fixture' }],
      requiredCapabilities: ['windows-authoring'], managedRoots: ['Content'], checkpoints: [{ id: 'binary-saved', label: 'Binary saved',
        afterOperationIds: ['author'], artifactExpectationNames: ['asset'] }], artifactExpectations: [{ name: 'asset',
        relativePath: 'Content/SyntheticFlying.uasset', required: true, delivery: 'inline', binary: true, maxBytes: 1024 }],
      contentPolicy: { requiresUnrealAssets: false, prohibitedDatasetExtensions: ['.gpkg'], maxUnclassifiedFileBytes: 1024 },
      resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 1024 }, nonce: 'fixture-nonce', inputHash,
      realEngineEvidence: intent, authority: { database: 'none', productionHosts: 'none', globalGitHubCredentials: 'none' } } as const;
    const result = { kind: 'authoring-result', protocolVersion: 1, projectId: identity.projectId, taskId: identity.taskId, runId: identity.runId,
      jobId: packet.jobId, leaseId: packet.leaseId, deviceId: 'fixture-device', sessionId: 'fixture-session', nonce: packet.nonce,
      inputHash, baseCommitSha: packet.baseCommitSha, resultTreeSha, patch, resultBundle: { version: 1, format: 'git-binary-patch',
        sha256: sha(patch), sizeBytes: Buffer.byteLength(patch), lfsObjects: [], outputs: [] }, tree: [{ path: 'Content/SyntheticFlying.uasset',
        kind: 'file', sha256: sha('asset'), sizeBytes: 5, binary: true, mode: '100644' }], completedOperationIds: ['author'], checkpointIds: ['binary-saved'],
      artifacts: [], processes: [], contentAssessment: { technicalVerification: 'not-required', productionReviewRequired: true,
        rationale: 'Independent fixture review is still required.' }, status: 'succeeded', startedAt: now.toISOString(), completedAt: now.toISOString(),
      summary: 'Synthetic authoring completed.', realEngineEvidence: evidence } as const;
    const updateMany = vi.fn(async () => ({ count: 1 })); const tx: any = { $queryRaw: vi.fn(async () => [{ jobId: packet.jobId,
      projectId: packet.projectId, taskId: packet.taskId, runId: packet.runId, packet, sessionStatus: 'active' }]),
      windowsExecutionJob: { updateMany }, windowsExecutionLease: { update: vi.fn() }, workerDevice: { update: vi.fn() } };
    const repository = new WindowsWorkerRepository({ $transaction: vi.fn(async (work: any) => work(tx)) } as any);
    await expect(repository.submitResult('fixture-device', result as any)).resolves.toMatchObject({ accepted: true, packet });
    await expect(repository.submitResult('fixture-device', { ...result, baseCommitSha: '0'.repeat(40) } as any)).resolves.toEqual({ accepted: false });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'succeeded' }) }));
  });

  it.each([
    ['failed probes', ['interactive-desktop', 'gpu'], [probe({ key: 'interactive-desktop' }, 'failed'), probe({ key: 'gpu' })]],
    ['missing interactive GPU', ['windows-authoring'], [probe({ key: 'windows-authoring' })]],
    ['insufficient disk', ['interactive-desktop', 'gpu', 'disk-capacity'], [probe({ key: 'interactive-desktop' }), probe({ key: 'gpu' }), probe({ key: 'disk-capacity', metadata: { freeBytes: 99 } })]],
    ['stale provenance', ['interactive-desktop', 'gpu'], [probe({ key: 'interactive-desktop' }, 'supported', 6 * 60_000), probe({ key: 'gpu' }, 'supported', 6 * 60_000)]]
  ])('keeps %s as an explicit capability blocker', async (_label, keys, probes) => {
    const capabilities = probes.map(({ capability }) => capability);
    const requiredCapabilities = keys.includes('disk-capacity') ? ['interactive-desktop', 'gpu', 'disk-free-100gb'] : ['interactive-desktop', 'gpu'];
    const job = { id: 'fixture-job', taskId: 'fixture-task', status: 'queued', waitReason: keys.includes('disk-capacity') ? 'insufficient_capacity' : 'unavailable_capability',
      pendingPhase: 'author', requiredCapabilities, packet: { kind: 'authoring' }, leases: [], createdAt: now };
    const model = await new WindowsWorkerRepository(operationsPrisma([device(capabilities, probes)], [job])).readOperations('fixture-project', now);
    expect(model.waitingValidations[0]).toMatchObject({ compatibleDeviceIds: [], waitReason: job.waitReason, pendingPhase: 'author' });
  });

  it('preserves binary and text checkpoints while readable fixture evidence remains non-qualifying', async () => {
    const binary = Buffer.from('synthetic-uasset'); const binarySha = sha(binary.toString()); const textTree = 'e'.repeat(40);
    const real = { classification: 'capture', buildId: 'fixture-build', scenario: 'borek-filip', settings: {
      qualificationProfile: 'borek-filip', contentProvenance: 'flying-repository', flyingCommitSha: 'f'.repeat(40),
      requiredToolVersions: { UnrealEditor: '5.8' }, fixture: true }, projectId: 'fixture-project', taskId: 'fixture-task', runId: 'fixture-run',
      inputHash: sha('input'), resultTreeSha: textTree, toolVersions: [{ tool: 'UnrealEditor', version: '5.8' }], startedAt: now.toISOString(),
      completedAt: now.toISOString(), durationMs: 0, state: 'succeeded', exitCode: 0,
      artifacts: [{ name: 'capture', relativePath: 'Artifacts/Flying.png', sizeBytes: binary.length, sha256: binarySha }] };
    const authoringResult = { status: 'succeeded', resultBundle: { outputs: [{ path: 'Artifacts/Flying.png', sha256: binarySha,
      sizeBytes: binary.length, contentBase64: binary.toString('base64') }] }, realEngineEvidence: real };
    const job = { id: 'fixture-job', projectId: 'fixture-project', taskId: 'fixture-task', status: 'succeeded', requiredCapabilities: [], leases: [],
      authoringProgress: { checkpoint: { resultTreeSha: textTree, resumedFromCheckpoint: true } },
      packet: { kind: 'authoring', authoringResult }, createdAt: now };
    const model = await new WindowsWorkerRepository(operationsPrisma([], [job])).readOperations('fixture-project', now);

    expect(job.authoringProgress.checkpoint).toEqual({ resultTreeSha: textTree, resumedFromCheckpoint: true });
    expect(authoringResult.resultBundle.outputs[0]?.contentBase64).toBeTruthy();
    expect(model.qualificationReadiness.state).toBe('unverified');
    expect(model.qualificationReadiness.reason).toContain('Fixtures never satisfy qualification readiness');
    expect(model.devices).toEqual([]); // The fixture never activates or mutates a real runner session.

    const unreadableJob = { ...job, id: 'unreadable-job', packet: { ...job.packet, authoringResult: { ...authoringResult,
      realEngineEvidence: { ...real, settings: { ...real.settings, fixture: false } }, resultBundle: { outputs: [{
        ...authoringResult.resultBundle.outputs[0]!, contentBase64: Buffer.from('corrupt').toString('base64') }] } } } };
    const unreadable = await new WindowsWorkerRepository(operationsPrisma([], [unreadableJob])).readOperations('fixture-project', now);
    expect(unreadable.qualificationReadiness.state).toBe('unverified');
  });
});
