import type { ProjectRoadmapApi, TaskSummary } from './types.js';

export type ProjectProgressTone = 'active' | 'attention' | 'completed' | 'idle';
export type ProjectOperationalAction =
  | 'generate_roadmap'
  | 'start_next_step'
  | 'start_audit'
  | 'retry_audit'
  | 'review_extension'
  | 'none';

export interface ProjectProgressSummary {
  tone: ProjectProgressTone;
  headline: string;
  detail: string;
  completedSteps: number;
  totalSteps: number;
  taskPosition?: number;
}

export interface ProjectOperationalOverview {
  tone: ProjectProgressTone;
  state: string;
  activeStep: string;
  blockers: string[];
  primaryAction: ProjectOperationalAction;
  primaryActionLabel?: string;
}

export function summarizeProjectProgress(
  roadmap: ProjectRoadmapApi | undefined,
  taskId: string
): ProjectProgressSummary {
  const latestCycle = [...(roadmap?.cycles ?? [])]
    .sort((left, right) => right.cycleNumber - left.cycleNumber)[0];

  if (!latestCycle) {
    return {
      tone: 'idle',
      headline: 'Bez aktivní roadmapy',
      detail: 'Tento projekt nemá vytvořené implementační kroky.',
      completedSteps: 0,
      totalSteps: 0
    };
  }

  const steps = (roadmap?.steps ?? [])
    .filter((step) => step.cycleId === latestCycle.id)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  const completedSteps = steps.filter((step) => step.status === 'completed').length;
  const taskStep = steps.find((step) => step.taskId === taskId);
  const runningStep = steps.find((step) => step.status === 'running');
  const nextStep = steps.find((step) => step.status === 'pending' && !step.taskId);
  const auditJob = (roadmap?.auditJobs ?? []).find((job) => job.cycleId === latestCycle.id);
  const base = {
    completedSteps,
    totalSteps: steps.length,
    taskPosition: taskStep?.sequenceNumber
  };

  if (auditJob?.status === 'claimed') {
    return {
      ...base,
      tone: 'active',
      headline: 'Probíhá projektový audit',
      detail: 'AI ověřuje, zda výsledek projektu splňuje uložené zadání.'
    };
  }

  if (auditJob?.status === 'pending') {
    return {
      ...base,
      tone: 'active',
      headline: 'Projektový audit čeká ve frontě',
      detail: 'Implementační kroky jsou hotové a čeká se na závěrečné ověření projektu.'
    };
  }

  if (runningStep) {
    return {
      ...base,
      tone: 'active',
      headline: `Probíhá krok ${runningStep.sequenceNumber}: ${runningStep.title}`,
      detail: 'Projekt pokračuje zpracováním dalšího implementačního kroku.'
    };
  }

  if (nextStep && latestCycle.status === 'active') {
    return {
      ...base,
      tone: 'active',
      headline: `Další krok ${nextStep.sequenceNumber}: ${nextStep.title}`,
      detail: 'Předchozí task skončil, ale roadmapa projektu ještě není dokončena.'
    };
  }

  if (auditJob?.status === 'failed' || auditJob?.status === 'blocked') {
    return {
      ...base,
      tone: 'attention',
      headline: 'Projektový audit vyžaduje pozornost',
      detail: auditJob.errorMessage ?? 'Závěrečné ověření projektu nebylo úspěšně dokončeno.'
    };
  }

  if (latestCycle.status === 'verifying') {
    return {
      ...base,
      tone: 'active',
      headline: 'Ověřuje se splnění projektu',
      detail: 'Implementace je hotová a probíhá závěrečné vyhodnocení požadavků.'
    };
  }

  if (latestCycle.status === 'awaiting_extension_decision') {
    return {
      ...base,
      tone: 'attention',
      headline: 'Čeká se na rozhodnutí o rozšíření',
      detail: 'Aktuální cyklus je ověřený a AI navrhla další rozšíření projektu.'
    };
  }

  if (latestCycle.status === 'partial' || latestCycle.status === 'blocked') {
    return {
      ...base,
      tone: 'attention',
      headline: 'Projekt není kompletně splněný',
      detail: 'Některé požadavky zůstávají nesplněné nebo zablokované.'
    };
  }

  if (steps.length > 0 && completedSteps === steps.length && latestCycle.status === 'active') {
    return {
      ...base,
      tone: 'attention',
      headline: 'Implementace je hotová, audit čeká',
      detail: 'Závěrečný projektový audit spusťte ručně v detailu projektu.'
    };
  }

  return {
    ...base,
    tone: 'completed',
    headline: 'Projektový cyklus je dokončen',
    detail: 'V tomto cyklu už neprobíhá žádná další automatická operace.'
  };
}

export function summarizeProjectOperationalOverview(
  roadmap: ProjectRoadmapApi | undefined,
  tasks: TaskSummary[] = []
): ProjectOperationalOverview {
  const latestCycle = [...(roadmap?.cycles ?? [])]
    .sort((left, right) => right.cycleNumber - left.cycleNumber)[0];

  if (!latestCycle) {
    return {
      tone: 'idle',
      state: 'Bez roadmapy',
      activeStep: 'Roadmapa zatím nebyla vytvořena.',
      blockers: [],
      primaryAction: 'generate_roadmap',
      primaryActionLabel: 'Vytvořit implementační kroky'
    };
  }

  const steps = (roadmap?.steps ?? [])
    .filter((step) => step.cycleId === latestCycle.id)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  const auditJob = (roadmap?.auditJobs ?? []).find((job) => job.cycleId === latestCycle.id);
  const runningStep = steps.find((step) => step.status === 'running');
  const nextStep = steps.find((step) => step.status === 'pending' && !step.taskId);
  const completedSteps = steps.filter((step) => step.status === 'completed').length;
  const blockers = [
    ...(auditJob?.status === 'blocked' || auditJob?.status === 'failed'
      ? [auditJob.errorMessage ?? 'Projektový audit je zablokovaný.']
      : []),
    ...(latestCycle.status === 'blocked' ? ['Aktuální cyklus je zablokovaný.'] : []),
    ...(latestCycle.status === 'partial' ? ['Některé požadavky zůstávají nesplněné.'] : [])
  ];

  if (auditJob?.status === 'claimed') {
    return {
      tone: 'active',
      state: 'Probíhá audit',
      activeStep: 'Závěrečný projektový audit ověřuje splnění kontraktu.',
      blockers,
      primaryAction: 'none'
    };
  }

  if (auditJob?.status === 'pending') {
    return {
      tone: 'active',
      state: 'Audit čeká ve frontě',
      activeStep: 'Implementační kroky jsou hotové a čekají na závěrečné ověření.',
      blockers,
      primaryAction: 'none'
    };
  }

  if (runningStep) {
    return {
      tone: 'active',
      state: 'Běží implementace',
      activeStep: `Krok ${runningStep.sequenceNumber}: ${runningStep.title}`,
      blockers,
      primaryAction: 'none'
    };
  }

  if (auditJob?.status === 'blocked' || auditJob?.status === 'failed') {
    return {
      tone: 'attention',
      state: 'Audit vyžaduje pozornost',
      activeStep: 'Závěrečný audit nebyl úspěšně dokončen.',
      blockers,
      primaryAction: 'retry_audit',
      primaryActionLabel: 'Opakovat pouze audit'
    };
  }

  if (latestCycle.status === 'awaiting_extension_decision') {
    return {
      tone: 'attention',
      state: 'Čeká rozhodnutí',
      activeStep: 'AI navrhla rozšíření projektu po dokončeném cyklu.',
      blockers,
      primaryAction: 'review_extension',
      primaryActionLabel: 'Zobrazit rozhodnutí'
    };
  }

  if (
    latestCycle.status === 'active'
    && steps.length > 0
    && steps.every((step) => step.status === 'completed')
    && (!auditJob || auditJob.status === 'succeeded')
  ) {
    return {
      tone: 'attention',
      state: 'Audit čeká na spuštění',
      activeStep: `${completedSteps}/${steps.length} kroků dokončeno.`,
      blockers,
      primaryAction: 'start_audit',
      primaryActionLabel: 'Spustit závěrečný audit'
    };
  }

  if (nextStep && latestCycle.status === 'active') {
    return {
      tone: 'active',
      state: 'Připraven další krok',
      activeStep: `Krok ${nextStep.sequenceNumber}: ${nextStep.title}`,
      blockers,
      primaryAction: 'start_next_step',
      primaryActionLabel: 'Spustit další krok'
    };
  }

  if (latestCycle.status === 'verifying') {
    return {
      tone: 'active',
      state: 'Ověřuje se projekt',
      activeStep: 'Implementace je hotová a probíhá závěrečné vyhodnocení.',
      blockers,
      primaryAction: 'none'
    };
  }

  if (latestCycle.status === 'partial' || latestCycle.status === 'blocked') {
    return {
      tone: 'attention',
      state: latestCycle.status === 'blocked' ? 'Cyklus je zablokovaný' : 'Cyklus je částečný',
      activeStep: `${completedSteps}/${steps.length} kroků dokončeno.`,
      blockers,
      primaryAction: 'none'
    };
  }

  return {
    tone: 'completed',
    state: 'Cyklus dokončen',
    activeStep: `${completedSteps}/${steps.length} kroků dokončeno.`,
    blockers,
    primaryAction: 'none'
  };
}
