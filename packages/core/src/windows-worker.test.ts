import { describe, expect, it } from 'vitest';
import {
  WINDOWS_WORKER_SCHEMA_VERSION, canTransitionExecutionJob, canTransitionWorkerDevice,
  canTransitionWorkerSession, isWindowsExecutionPacket, isWindowsExecutionResult,
  type WindowsExecutionPacket, type WindowsExecutionResult
} from './windows-worker.js';

const hash = 'a'.repeat(64);
const packet: WindowsExecutionPacket = {
  schemaVersion: WINDOWS_WORKER_SCHEMA_VERSION, projectId: 'p', taskId: 't', runId: 'r', checkId: 'c', jobId: 'j', leaseId: 'l',
  repository: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git', commitSha: hash,
  workspaceRoot: 'C:\\ForgeMind\\work', artifactRoot: 'C:\\ForgeMind\\artifacts',
  check: { command: 'fixture validate', category: 'smoke', requiredCapabilities: ['windows'] }, requiredCapabilities: ['windows'],
  resourcePolicy: { timeoutSeconds: 60, maxLogBytes: 1024, maxArtifactBytes: 2048 }, expectedArtifacts: [], nonce: 'nonce', inputHash: hash
};

describe('Windows worker shared contracts', () => {
  it('validates a versioned packet and rejects mutable source identities', () => {
    expect(isWindowsExecutionPacket(packet)).toBe(true);
    expect(isWindowsExecutionPacket({ ...packet, schemaVersion: 2 })).toBe(false);
    expect(isWindowsExecutionPacket({ ...packet, commitSha: 'main' })).toBe(false);
  });

  it('validates correlated results', () => {
    const result: WindowsExecutionResult = {
      schemaVersion: 1, projectId: 'p', taskId: 't', runId: 'r', checkId: 'c', jobId: 'j', leaseId: 'l', deviceId: 'd', sessionId: 's',
      nonce: 'nonce', inputHash: hash, commitSha: hash, observedCapabilities: [{ key: 'windows', version: '11' }],
      toolVersions: [{ tool: 'fixture', version: '1.0.0', driverVersion: '2.0.0' }], status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
      exitCode: 0, summary: 'ok', logHash: hash, artifacts: []
    };
    expect(isWindowsExecutionResult(result)).toBe(true);
    expect(isWindowsExecutionResult({ ...result, inputHash: 'invalid' })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, exitCode: 1.5 })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, status: 'unknown' })).toBe(false);
    expect(isWindowsExecutionResult({ ...result, artifacts: [{ name: 'log', relativePath: 'log.txt', sizeBytes: -1, sha256: hash }] })).toBe(false);
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
  });
});
