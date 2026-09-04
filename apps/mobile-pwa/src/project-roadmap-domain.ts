import type {
  AcceptanceEvidenceApi,
  ProjectAuditJobApi,
  ProjectImplementationStepApi,
  ProjectRoadmapCycleApi
} from './types.js';

export type ProjectRoadmapView = 'roadmap' | 'history' | 'contract' | 'evidence' | 'audit';
export type ProjectItemStatusFilter = 'active' | 'waiting' | 'failed' | 'completed';

export const projectRoadmapViews: Array<{ id: ProjectRoadmapView; label: string }> = [
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'history', label: 'Historie cyklů' },
  { id: 'contract', label: 'Kontrakt' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'audit', label: 'Audity' }
];

export const projectItemStatusFilters: Array<{ id: ProjectItemStatusFilter; label: string }> = [
  { id: 'active', label: 'Aktivní' },
  { id: 'waiting', label: 'Čekající' },
  { id: 'failed', label: 'Selhané' },
  { id: 'completed', label: 'Dokončené' }
];

export function projectStepMatchesStatusFilter(
  step: ProjectImplementationStepApi,
  filter: ProjectItemStatusFilter
): boolean {
  if (filter === 'active') return step.status === 'pending' || step.status === 'running';
  if (filter === 'waiting') return false;
  if (filter === 'failed') return step.status === 'cancelled';
  return step.status === 'completed';
}

export function projectCycleMatchesStatusFilter(
  cycle: ProjectRoadmapCycleApi,
  filter: ProjectItemStatusFilter
): boolean {
  if (filter === 'active') return cycle.status === 'active' || cycle.status === 'verifying' || cycle.status === 'partial';
  if (filter === 'waiting') return cycle.status === 'awaiting_extension_decision';
  if (filter === 'failed') return cycle.status === 'blocked';
  return cycle.status === 'completed';
}

export function projectAuditMatchesStatusFilter(
  job: ProjectAuditJobApi,
  filter: ProjectItemStatusFilter
): boolean {
  if (filter === 'active') return job.status === 'claimed' || hasPendingAuditGapProposal(job);
  if (filter === 'waiting') return job.status === 'pending' || (hasPendingAuditGapProposal(job) && job.gapProposalStatus === 'proposed');
  if (filter === 'failed') return job.status === 'failed' || job.status === 'blocked';
  return job.status === 'succeeded' && !hasPendingAuditGapProposal(job);
}

export function hasPendingAuditGapProposal(job: ProjectAuditJobApi | undefined): boolean {
  return Boolean(job?.status === 'succeeded' && job.gapProposal
    && (job.gapProposalStatus === 'proposed' || job.gapProposalStatus === 'activating'));
}

export function projectEvidenceMatchesStatusFilter(
  evidence: AcceptanceEvidenceApi,
  filter: ProjectItemStatusFilter
): boolean {
  if (filter === 'active') return false;
  if (filter === 'waiting') return evidence.status === 'deferred';
  if (filter === 'failed') return evidence.status === 'failed' || evidence.status === 'blocked';
  return evidence.status === 'passed';
}

export function canStartProjectAudit(
  cycle: ProjectRoadmapCycleApi | undefined,
  steps: ProjectImplementationStepApi[],
  auditJob: ProjectAuditJobApi | undefined
): boolean {
  return Boolean(
    cycle?.status === 'active'
    && steps.length > 0
    && steps.every((step) => step.status === 'completed')
    && (!auditJob || auditJob.status === 'succeeded')
  );
}
