import type { ForgeTask, Project, ProjectImplementationStep, ProjectRoadmapCycle } from '@forgemind/core';
import type { ForgeMindRepository } from './repository.js';

export interface RoadmapAdvanceResult {
  advanced: boolean;
  completedStep?: ProjectImplementationStep;
  nextTask?: ForgeTask;
  auditQueued?: boolean;
  completedCycle?: ProjectRoadmapCycle;
  project?: Project;
}

export async function advanceRoadmapAfterTaskCompletion(
  repository: ForgeMindRepository,
  taskId: string
): Promise<RoadmapAdvanceResult> {
  const linkedStep = await repository.getImplementationStepByTaskId(taskId);
  if (!linkedStep || !['running', 'completed'].includes(linkedStep.status)) {
    return { advanced: false };
  }

  const completedStep = linkedStep.status === 'completed'
    ? linkedStep
    : await repository.updateImplementationStepStatus(linkedStep.id, 'completed');
  if (!completedStep) return { advanced: false };

  const roadmap = await repository.getProjectRoadmap(completedStep.projectId);
  const cycle = roadmap?.cycles.find((candidate) => candidate.id === completedStep.cycleId);
  const project = await repository.getProject(completedStep.projectId);
  if (!roadmap || !cycle || !project) return { advanced: true, completedStep };

  const cycleSteps = roadmap.steps
    .filter((candidate) => candidate.cycleId === cycle.id)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  if (cycleSteps.some((candidate) => candidate.status === 'running')) {
    return { advanced: linkedStep.status !== 'completed', completedStep, project };
  }
  const nextStep = cycleSteps.find((candidate) => candidate.status === 'pending');
  if (nextStep) {
    const nextTask = await startNextRoadmapStep(repository, project.id, cycle.id);
    return { advanced: Boolean(nextTask), completedStep, nextTask, project };
  }

  if (!project.projectContract) {
    const completedCycle = cycle.status === 'completed'
      ? cycle
      : await repository.updateProjectRoadmapCycleStatus(cycle.id, 'completed');
    return { advanced: true, completedStep, completedCycle, project };
  }
  if (cycle.status === 'completed' || cycle.status === 'awaiting_extension_decision') {
    return { advanced: linkedStep.status !== 'completed', completedStep, completedCycle: cycle, project };
  }
  // Contract-backed cycles stay active after their final implementation step.
  // A user explicitly starts the completion audit from the project UI.
  return { advanced: true, completedStep, auditQueued: false, project };
}

export async function startNextRoadmapStep(
  repository: ForgeMindRepository,
  projectId: string,
  cycleId: string
): Promise<ForgeTask | undefined> {
  const [roadmap, project] = await Promise.all([
    repository.getProjectRoadmap(projectId),
    repository.getProject(projectId)
  ]);
  const cycle = roadmap?.cycles.find((candidate) => candidate.id === cycleId);
  if (!roadmap || !project || !cycle) return undefined;
  const cycleSteps = roadmap.steps
    .filter((candidate) => candidate.cycleId === cycleId)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  const completedTitles = new Set(cycleSteps
    .filter((candidate) => candidate.status === 'completed')
    .map((candidate) => candidate.title));
  const nextStep = cycleSteps.find((candidate) => (
    candidate.status === 'pending'
    && !candidate.taskId
    && (candidate.dependsOnStepTitles ?? []).every((title) => completedTitles.has(title))
  ));
  if (!nextStep) return undefined;

  return repository.createAndStartRoadmapStepTask(nextStep.id, {
      projectId: project.id,
      title: `${project.name}: ${nextStep.title}`,
      prompt: buildRoadmapStepTaskPrompt({
        stepTitle: nextStep.title,
        stepDescription: nextStep.description,
        acceptanceCriteria: nextStep.acceptanceCriteria,
        deliverables: nextStep.deliverables
      }),
      acceptanceCriteria: nextStep.acceptanceCriteria,
      mode: project.defaultTaskMode ?? 'safe',
      architectureVersionId: project.currentArchitectureVersionId ?? cycle.architectureVersionId
  });
}

export function buildRoadmapStepTaskPrompt(input: {
  stepTitle: string;
  stepDescription: string;
  acceptanceCriteria: string[];
  deliverables?: string[];
}): string {
  const lines = [
    'Implementation step:',
    input.stepTitle,
    '',
    input.stepDescription.trim()
  ];

  if (input.deliverables?.length) {
    lines.push('', 'Required deliverables:', ...input.deliverables.map((deliverable) => `- ${deliverable}`));
  }
  if (input.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance Criteria:');
    for (const criterion of input.acceptanceCriteria) lines.push(`- ${criterion}`);
  }

  return lines.join('\n');
}
