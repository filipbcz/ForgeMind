import type { ProjectArchitectureUpdate, ProjectContract, ProjectContractDelta } from './model.js';

export interface ImplementationStepPlan {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  inScope: string[];
  outOfScope: string[];
  requirementIds: string[];
  deliverables: string[];
  changeRationale: string;
  dependsOnStepTitles: string[];
  validationFocus: Array<'implementation' | 'migration' | 'compatibility' | 'regression'>;
}

/** Provider-neutral candidate; raw provider prompts/responses are not checkpoint data. */
export interface RoadmapCandidate {
  summary: string;
  steps: string[];
  acceptanceCriteria: string[];
  implementationSteps?: ImplementationStepPlan[];
  projectContract?: ProjectContract;
  contractDelta?: ProjectContractDelta;
  architectureUpdate?: ProjectArchitectureUpdate;
}

export interface RoadmapQualityReview {
  verdict: 'satisfied' | 'not_satisfied';
  summary: string;
  blockers: string[];
  criterionResults?: Array<{
    criterion: string;
    status: 'satisfied' | 'not_satisfied' | 'insufficient_evidence' | 'deferred';
    evidence: string[];
  }>;
}

export interface RoadmapGenerationCheckpoint {
  version: 1;
  phase: 'validate' | 'repair' | 'review' | 'ready';
  revision: number;
  plan: RoadmapCandidate;
  validationError?: string;
  qualityReview?: RoadmapQualityReview;
}
