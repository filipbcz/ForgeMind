import type { AcceptanceEvidence, ProjectAuditJobStatus } from './model.js';

export const REQUIRED_QUALIFICATION_SCENARIOS = [
  { id: 'success-roadmap-step', area: 'success', definitionHash: 'd4eecd02ea19b55a2da3ad790467d49a054c307c801c713d1c3d0c2baba71a57' },
  { id: 'validation-repair', area: 'repair', definitionHash: 'e497064e2eb92f6e250703ce12be8a78787bbb6e22af083a741eefb5bb54399f' },
  { id: 'worker-restart-resume', area: 'restart', definitionHash: '6d282a27c8c7a64be8c0fb871998e0386d38cd97cd69bff7d9002b45311a44d7' },
  { id: 'provider-and-github-outage', area: 'outage', definitionHash: '3b2896586a466c7fa4367570a3e996000564dbef76a51352f7b9da2c40852737' },
  { id: 'approval-pause-resume', area: 'approval_pause_resume', definitionHash: '4869724d4da8171f7861d7d2100fb46e37137e6e98248e53bf6487eb0612ce6d' },
  { id: 'specification-change-regeneration', area: 'specification_change', definitionHash: 'fd60508164c3ef87a7c5ee6b227bcacbcfeade176cbf3a178955dd85bbdbf845' },
  { id: 'manual-audit-recovery', area: 'audit_recovery', definitionHash: '584589d958564463bc1fd23a0a1d2f2dea044be2c3220b19b925e24b369cfbe6' },
  { id: 'disk-exhaustion-artifact-bounds', area: 'disk_exhaustion', definitionHash: 'af341aa10aa2d039433b6e24f89b712a7100663537ab3ea20bdf9f29f04b62e8' },
  { id: 'windows-validation-fixture-flow', area: 'windows_validation_fixture', definitionHash: 'f13f3fae6497c41fe1ceb0d0085f51d32f2429dc26319838c3cac07ee475a20f' },
  { id: 'database-restore-path', area: 'database_restore', definitionHash: '740dc3c48c5326c2606bbea52d7a93a178c643886e7e9419db0990384048811d' }
] as const;

export const REQUIRED_QUALIFICATION_SCENARIO_AREAS = REQUIRED_QUALIFICATION_SCENARIOS.map((scenario) => scenario.area);

export type QualificationScenarioArea = typeof REQUIRED_QUALIFICATION_SCENARIO_AREAS[number];

export type ManualFinalAuditResultStatus = 'pass' | 'fail' | 'recovery-required';
export const BOREK_FILIP_UNREAL_PROFILE_ID = 'borek-filip';

export function toManualFinalAuditResultStatus(
  status: Extract<ProjectAuditJobStatus, 'succeeded' | 'blocked' | 'failed'>
): ManualFinalAuditResultStatus {
  if (status === 'succeeded') return 'pass';
  if (status === 'blocked') return 'recovery-required';
  return 'fail';
}

export function qualificationScenarioAreas(evidence: AcceptanceEvidence): QualificationScenarioArea[] {
  if (evidence.status !== 'passed' || !evidence.commitSha) return [];
  if (
    evidence.payload.schemaVersion !== 1
    || evidence.payload.generatedFrom !== 'qualification/platform-scenarios/scenarios.mjs'
    || evidence.payload.scenarioCount !== REQUIRED_QUALIFICATION_SCENARIOS.length
    || !Array.isArray(evidence.payload.scenarios)
    || evidence.payload.scenarios.length !== REQUIRED_QUALIFICATION_SCENARIOS.length
  ) return [];
  const candidates = evidence.payload.scenarios.flatMap((scenario) => {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) return [];
    const record = scenario as Record<string, unknown>;
    const canonical = REQUIRED_QUALIFICATION_SCENARIOS.find((candidate) =>
      candidate.id === record.id && candidate.area === record.area && candidate.definitionHash === record.definitionHash
    );
    return canonical ? [canonical.area] : [];
  });
  return Array.from(new Set(candidates.filter(
    (area): area is QualificationScenarioArea =>
      typeof area === 'string' && REQUIRED_QUALIFICATION_SCENARIO_AREAS.includes(area as QualificationScenarioArea)
  )));
}

export function isManualBorekFilipEvidence(evidence: AcceptanceEvidence): boolean {
  return evidence.source === 'artifact'
    && evidence.status === 'passed'
    && evidence.payload.validationKind === 'borek-filip-unreal'
    && evidence.payload.executionAdapterKind === 'unreal'
    && evidence.payload.manuallyApproved === true
    && evidence.payload.fixture === false
    && typeof evidence.payload.windowsExecutionJobId === 'string'
    && evidence.payload.windowsExecutionJobId.length > 0
    && typeof evidence.payload.approvalId === 'string'
    && evidence.payload.approvalId.length > 0;
}

export function listCurrentManualBorekFilipEvidence(
  evidence: AcceptanceEvidence[],
  input: { cycleId: string; contractVersion: number; commitSha: string }
): AcceptanceEvidence[] {
  return evidence.filter((item) =>
    item.cycleId === input.cycleId
    && item.contractVersion === input.contractVersion
    && item.commitSha === input.commitSha
    && isManualBorekFilipEvidence(item)
  );
}

export function hasCompleteCurrentQualificationEvidence(
  evidence: AcceptanceEvidence[],
  input: { cycleId: string; contractVersion: number; commitSha: string }
): boolean {
  const covered = new Set(evidence
    .filter((item) =>
      item.cycleId === input.cycleId
      && item.contractVersion === input.contractVersion
      && item.commitSha === input.commitSha
      && item.source !== 'repository_audit'
    )
    .flatMap(qualificationScenarioAreas));
  return REQUIRED_QUALIFICATION_SCENARIO_AREAS.every((area) => covered.has(area))
    && listCurrentManualBorekFilipEvidence(evidence, input).length > 0;
}
