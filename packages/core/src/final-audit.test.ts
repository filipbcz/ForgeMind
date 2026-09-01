import { describe, expect, it } from 'vitest';
import type { AcceptanceEvidence } from './model.js';
import { hasCompleteCurrentQualificationEvidence, listCurrentManualBorekFilipEvidence, REQUIRED_QUALIFICATION_SCENARIOS, toManualFinalAuditResultStatus } from './final-audit.js';

describe('manual final audit result status', () => {
  it.each([
    ['succeeded', 'pass'],
    ['failed', 'fail'],
    ['blocked', 'recovery-required']
  ] as const)('maps terminal job status %s to %s', (jobStatus, resultStatus) => {
    expect(toManualFinalAuditResultStatus(jobStatus)).toBe(resultStatus);
  });
});

const evidence = (overrides: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence => ({
  id: 'evidence_1', projectId: 'project_1', cycleId: 'cycle_1', requirementId: 'REQ-QUALIFICATION',
  criterionKey: 'platform-qualification', criterion: 'Platform qualification', source: 'artifact' as const,
  status: 'passed' as const, evidenceKey: 'qualification:abc1234', contractVersion: 1, commitSha: 'abc1234',
  payload: {
    schemaVersion: 1, generatedFrom: 'qualification/platform-scenarios/scenarios.mjs',
    scenarioCount: REQUIRED_QUALIFICATION_SCENARIOS.length,
    scenarios: REQUIRED_QUALIFICATION_SCENARIOS.map((scenario) => ({ ...scenario }))
  }, createdAt: '', updatedAt: '', ...overrides
});

const borekEvidence = (overrides: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence => ({
  ...evidence(), id: 'evidence_borek', criterionKey: 'borek-filip-unreal', criterion: 'Manual BOREK-FILIP Unreal validation',
  evidenceKey: 'borek-filip:job_1', payload: {
    validationKind: 'borek-filip-unreal', executionAdapterKind: 'unreal', manuallyApproved: true,
    fixture: false, windowsExecutionJobId: 'job_1', approvalId: 'approval_1'
  }, ...overrides
});

describe('manual final audit qualification gate', () => {
  it('requires successful coverage of every required scenario on the exact revision', () => {
    expect(hasCompleteCurrentQualificationEvidence([evidence(), borekEvidence()], {
      cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234'
    })).toBe(true);
    expect(hasCompleteCurrentQualificationEvidence([evidence({ status: 'failed' }), borekEvidence()], {
      cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234'
    })).toBe(false);
    expect(hasCompleteCurrentQualificationEvidence([evidence({ commitSha: 'def5678' }), borekEvidence()], {
      cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234'
    })).toBe(false);
  });

  it('rejects partial scenario coverage', () => {
    expect(hasCompleteCurrentQualificationEvidence([
      evidence({ payload: {
        schemaVersion: 1, generatedFrom: 'qualification/platform-scenarios/scenarios.mjs',
        scenarioCount: REQUIRED_QUALIFICATION_SCENARIOS.length,
        scenarios: REQUIRED_QUALIFICATION_SCENARIOS.slice(0, -1).map((scenario) => ({ ...scenario }))
      } }), borekEvidence()
    ], { cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234' })).toBe(false);
  });

  it('rejects placeholder hashes even when every area is named', () => {
    expect(hasCompleteCurrentQualificationEvidence([evidence({ payload: {
      schemaVersion: 1, generatedFrom: 'qualification/platform-scenarios/scenarios.mjs',
      scenarioCount: REQUIRED_QUALIFICATION_SCENARIOS.length,
      scenarios: REQUIRED_QUALIFICATION_SCENARIOS.map((scenario) => ({ ...scenario, definitionHash: 'a'.repeat(64) }))
    } }), borekEvidence()], { cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234' })).toBe(false);
  });

  it('rejects fixture-only qualification and unapproved BOREK-FILIP markers', () => {
    const current = { cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234' };
    expect(hasCompleteCurrentQualificationEvidence([evidence()], current)).toBe(false);
    expect(hasCompleteCurrentQualificationEvidence([
      evidence(), borekEvidence({ payload: { ...borekEvidence().payload, manuallyApproved: false } })
    ], current)).toBe(false);
  });

  it('returns every current BOREK-FILIP marker independent of storage order', () => {
    const current = { cycleId: 'cycle_1', contractVersion: 1, commitSha: 'abc1234' };
    expect(listCurrentManualBorekFilipEvidence([
      borekEvidence({ id: 'invalid_provenance', payload: { ...borekEvidence().payload, windowsExecutionJobId: 'job_invalid' } }),
      borekEvidence({ id: 'valid_provenance' })
    ], current).map((item) => item.id)).toEqual(['invalid_provenance', 'valid_provenance']);
  });
});
