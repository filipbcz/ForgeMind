import type { ProjectRoadmapApi } from './types.js';

export type ProjectProgressTone = 'active' | 'attention' | 'completed' | 'idle';

export interface ProjectProgressSummary {
  tone: ProjectProgressTone;
  headline: string;
  detail: string;
  completedSteps: number;
  totalSteps: number;
  taskPosition?: number;
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
  const nextStep = steps.find((step) => step.status === 'pending');
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

  if (latestCycle.status === 'awaiting_extension_approval') {
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

  return {
    ...base,
    tone: 'completed',
    headline: 'Projektový cyklus je dokončen',
    detail: 'V tomto cyklu už neprobíhá žádná další automatická operace.'
  };
}
