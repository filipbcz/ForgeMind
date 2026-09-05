import { describe, expect, it } from 'vitest';
import {
  WINDOWS_WORKER_SCHEMA_VERSION, canTransitionExecutionJob, canTransitionWorkerDevice, classifyWindowsExecutionPacket,
  canTransitionWorkerSession, isWindowsAuthoringPacket, isWindowsAuthoringResult, isWindowsExecutionPacket, isWindowsExecutionResult,
  type WindowsAuthoringPacket, type WindowsExecutionPacket, type WindowsExecutionResult
} from './windows-worker.js';

const hash = 'a'.repeat(64);
const commitSha = 'b'.repeat(40);
const packet: WindowsExecutionPacket = {
  schemaVersion: 2, projectId: 'p', taskId: 't', runId: 'r', checkId: 'c', jobId: 'j', leaseId: 'l',
  repository: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git', commitSha,
  workspaceRoot: 'C:\\ForgeMind\\work', artifactRoot: 'C:\\ForgeMind\\artifacts',
  check: { command: 'fixture validate', category: 'smoke', requiredCapabilities: ['windows'] }, requiredCapabilities: ['windows'],
  dispatch: { kind: 'deferred', reason: 'unsupported_validation_intent', handling: 'manual-local' },
  resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 2048 }, expectedArtifacts: [], nonce: 'nonce', inputHash: hash
};

describe('Windows worker shared contracts', () => {
  it('validates a versioned packet and rejects mutable source identities', () => {
    expect(isWindowsExecutionPacket(packet)).toBe(true);
    expect(isWindowsExecutionPacket({ ...packet, expectedArtifacts: [{ name: 'legacy', relativePath: 'result.txt', required: true }] })).toBe(true);
    expect(isWindowsExecutionPacket({ ...packet, schemaVersion: 1 })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, commitSha: 'main' })).toBe(false);
    expect(classifyWindowsExecutionPacket({ ...packet, schemaVersion: 1, dispatch: undefined })).toMatchObject({
      status: 'deferred', reason: 'legacy_unsafe_packet', handling: 'manual-local'
    });
    expect(classifyWindowsExecutionPacket(packet)).toMatchObject({
      status: 'deferred', reason: 'unsupported_validation_intent', handling: 'manual-local'
    });
  });

  it('validates correlated results', () => {
    const result: WindowsExecutionResult = {
      schemaVersion: 1, projectId: 'p', taskId: 't', runId: 'r', checkId: 'c', jobId: 'j', leaseId: 'l', deviceId: 'd', sessionId: 's',
      nonce: 'nonce', inputHash: hash, commitSha: hash, observedCapabilities: [{ key: 'windows', version: '11' }],
      toolVersions: [{ tool: 'fixture', version: '1.0.0', driverVersion: '2.0.0' }], status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
      exitCode: 0, summary: 'ok', logHash: hash, artifacts: []
    };
    expect(isWindowsExecutionResult(result)).toBe(true);
    expect(isWindowsExecutionResult({ ...result, artifacts: [{ name: 'legacy', relativePath: 'legacy.txt', sizeBytes: 1, sha256: hash }] })).toBe(true);
    expect(isWindowsExecutionResult({ ...result, inputHash: 'invalid' })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, exitCode: 1.5 })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, status: 'unknown' })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, artifacts: [{ name: 'log', relativePath: 'log.txt', mimeType: 'text/plain', sizeBytes: -1, sha256: hash }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, observedCapabilities: [{ key: '' }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, observedCapabilities: [{ key: 'windows', metadata: { probe: () => true } }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, observedCapabilities: [{ key: 'windows', metadata: new Map([['version', '11']]) }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, observedCapabilities: [{ key: 'windows', metadata: new Set(['11']) }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, observedCapabilities: [{ key: 'windows', metadata: new Date() }] })).toBe(false);
    class CapabilityMetadata { version = '11'; }
    expect(isWindowsExecutionResult({ ...result, observedCapabilities: [{ key: 'windows', metadata: new CapabilityMetadata() }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, toolVersions: [{ tool: 'ue', version: '' }] })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, startedAt: 'yesterday' })).toBe(false);
  });

  it('enforces terminal and drain lifecycle transitions', () => {
    expect(canTransitionWorkerDevice('idle', 'reserved')).toBe(true);
    expect(canTransitionWorkerDevice('reserved', 'running')).toBe(true);
    expect(canTransitionWorkerDevice('revoked', 'idle')).toBe(false);
    expect(canTransitionWorkerSession('active', 'draining')).toBe(true);
    expect(canTransitionWorkerSession('draining', 'active')).toBe(false);
    expect(canTransitionExecutionJob('running', 'succeeded')).toBe(true);
    expect(canTransitionExecutionJob('succeeded', 'queued')).toBe(false);
  });

  it('rejects malformed nested packet fields', () => {
    expect(isWindowsExecutionPacket({ ...packet, check: { ...packet.check, category: 'unknown' } })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, check: { ...packet.check, requiredCapabilities: [''] } })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, requiredCapabilities: ['windows', 'windows'] })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, check: { ...packet.check, requiredCapabilities: ['unreal-engine-5.8'] } })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, expectedArtifacts: [{ name: 'log', relativePath: '', required: true }] })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, resourcePolicy: { ...packet.resourcePolicy, maxLogBytes: -1 } })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, check: { ...packet.check, shell: 'unknown' } })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, dispatch: { kind: 'raw-shell', command: 'whoami' } })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, evidenceContext: { cycleId: 'cycle', stepId: 'step', requirementIds: [], contractVersion: 0 } })).toBe(false);
  });

  it('validates declarative authoring packets and complete binary-aware result trees', () => {
    const authoring: WindowsAuthoringPacket = {
      kind: 'authoring', protocolVersion: 1, projectId: 'p', taskId: 't', runId: 'r', jobId: 'j', leaseId: 'pending',
      repository: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git', baseCommitSha: commitSha,
      workspaceRoot: 'runner-managed', artifactRoot: 'runner-managed', requiredCapabilities: ['windows', 'asset-authoring'],
      step: { prompt: 'Update the generated map.', acceptanceCriteria: ['The map is updated.'] },
      managedRoots: ['Content/Generated'], operations: [{ id: 'op-1', kind: 'modify', path: 'Content/Generated/map.bin', rationale: 'Update map' }],
      checkpoints: [{ id: 'cp-1', label: 'Map saved', afterOperationIds: ['op-1'], artifactExpectationNames: ['map'] }],
      artifactExpectations: [{ name: 'map', relativePath: 'Content/Generated/map.bin', required: true, delivery: 'artifact-store', binary: true, maxBytes: 4096 }],
      contentPolicy: { requiresUnrealAssets: true, prohibitedDatasetExtensions: ['.gpkg'], maxUnclassifiedFileBytes: 1024 },
      resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 4096 }, nonce: 'pending', inputHash: hash,
      authority: { database: 'none', productionHosts: 'none', globalGitHubCredentials: 'none' }
    };
    expect(isWindowsAuthoringPacket(authoring)).toBe(true);
    expect(isWindowsAuthoringPacket({ ...authoring, protocolVersion: 2 })).toBe(false);
    expect(isWindowsAuthoringPacket({ ...authoring, baseCommitSha: 'main' })).toBe(false);
    expect(isWindowsAuthoringPacket({ ...authoring, authority: { ...authoring.authority, database: 'direct' } })).toBe(false);
    const result = { kind: 'authoring-result', protocolVersion: 1, projectId: 'p', taskId: 't', runId: 'r', jobId: 'j', leaseId: 'l',
      deviceId: 'd', sessionId: 's', nonce: 'n', inputHash: hash, baseCommitSha: commitSha, resultTreeSha: commitSha,
      tree: [{ path: 'Content/Generated/map.bin', kind: 'file', sha256: hash, sizeBytes: 42, binary: true, mode: '100644' }], patch: 'diff --git',
      resultBundle: { version: 1, format: 'git-binary-patch', sha256: '35ab12569421d1cd6fa0a9a3deb5b40126a1a8272702923dc722409bdaf5801d', sizeBytes: 10, lfsObjects: [], outputs: [] },
      completedOperationIds: ['op-1'], checkpointIds: ['cp-1'], artifacts: [], processes: [{ leaseId: 'l', sessionId: 's', checkId: 'provider', command: 'provider.implement', shell: 'system', exitCode: 0, stdout: 'done', stderr: '', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:30Z' }], status: 'succeeded',
      contentAssessment: { technicalVerification: 'passed', productionReviewRequired: true, rationale: 'Requires visual review.' },
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', summary: 'authored' };
    expect(isWindowsAuthoringResult(result)).toBe(true);
    expect(isWindowsAuthoringResult({ ...result, contentAssessment: undefined })).toBe(false);
    expect(isWindowsAuthoringResult({ ...result, processes: [{ ...result.processes[0], leaseId: 'other' }] })).toBe(false);
    expect(isWindowsAuthoringResult({ ...result, resultTreeSha: 'working-tree' })).toBe(false);
    expect(isWindowsAuthoringResult({ ...result, tree: [{ ...result.tree[0], binary: undefined }] })).toBe(false);
    expect(isWindowsAuthoringResult({ ...result, resultBundle: { ...result.resultBundle,
      outputs: [{ path: '../escape.bin', sha256: hash, sizeBytes: 1, contentBase64: 'YQ==' }] } })).toBe(false);
  });
});
