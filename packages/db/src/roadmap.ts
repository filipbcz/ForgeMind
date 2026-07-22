import type { ForgeTask, Project, ProjectImplementationStep, ProjectRoadmapCycle } from '@forgemind/core';
import type { ForgeMindRepository } from './repository.js';

export interface RoadmapAdvanceResult {
  advanced: boolean;
  completedStep?: ProjectImplementationStep;
  nextTask?: ForgeTask;
  completedCycle?: ProjectRoadmapCycle;
  project?: Project;
}

export async function advanceRoadmapAfterTaskCompletion(
  repository: ForgeMindRepository,
  taskId: string
): Promise<RoadmapAdvanceResult> {
  const linkedStep = await repository.getImplementationStepByTaskId(taskId);
  if (!linkedStep || (linkedStep.status !== 'running' && linkedStep.status !== 'completed')) {
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
  if (!nextStep) {
    const completedCycle = cycle.status === 'completed'
      ? cycle
      : await repository.updateProjectRoadmapCycleStatus(cycle.id, 'completed');
    return { advanced: true, completedStep, completedCycle, project };
  }

  const currentIndex = cycleSteps.findIndex((candidate) => candidate.id === nextStep.id);
  const completedSteps = cycleSteps
    .slice(0, Math.max(0, currentIndex))
    .filter((candidate) => candidate.status === 'completed')
    .map((candidate) => candidate.title);
  const futureSteps = cycleSteps.slice(currentIndex + 1).map((candidate) => candidate.title);
  const task = await repository.createTask({
    projectId: project.id,
    title: `${project.name}: ${nextStep.title}`,
    prompt: buildRoadmapStepTaskPrompt({
      projectName: project.name,
      objective: cycle.objective,
      stepTitle: nextStep.title,
      stepDescription: nextStep.description,
      acceptanceCriteria: nextStep.acceptanceCriteria,
      completedSteps,
      futureSteps
    }),
    mode: project.defaultTaskMode ?? 'safe',
    maxIterations: 10,
    maxBudgetUsd: 5
  });

  await repository.assignTaskToImplementationStep(nextStep.id, task.id, 'running');
  const startedTask = await repository.startTask(task.id);
  if (!startedTask) {
    await repository.updateImplementationStepStatus(nextStep.id, 'pending');
    throw new Error(`Roadmap task "${task.id}" could not be started.`);
  }

  await repository.enqueueTask(startedTask.id, 'roadmap_step_started');
  await repository.writeAudit({
    actorType: 'system',
    eventType: 'task_enqueued',
    projectId: project.id,
    taskId: startedTask.id,
    payload: { reason: 'roadmap_step_started' }
  });

  return { advanced: true, completedStep, nextTask: startedTask, project };
}

export function buildRoadmapStepTaskPrompt(input: {
  projectName: string;
  objective: string;
  stepTitle: string;
  stepDescription: string;
  acceptanceCriteria: string[];
  completedSteps: string[];
  futureSteps: string[];
}): string {
  const lines = [
    `Project: ${input.projectName}`,
    '',
    'Parent objective:',
    input.objective,
    '',
    'Current implementation step:',
    input.stepTitle,
    '',
    'Step description and scope:',
    input.stepDescription,
    '',
    'Execution boundary:',
    '- Implement only the current step and its acceptance criteria.',
    '- Do not implement work assigned to future roadmap steps.',
    '- Reuse existing functionality. If part of this step is already satisfied, verify it instead of rewriting it.',
    '- Keep unrelated repository files unchanged.'
  ];

  if (input.completedSteps.length > 0) {
    lines.push('', 'Already completed roadmap steps (existing repository context):');
    for (const completedStep of input.completedSteps) lines.push(`- ${completedStep}`);
  }
  if (input.futureSteps.length > 0) {
    lines.push('', 'Future roadmap steps (explicitly out of scope):');
    for (const futureStep of input.futureSteps) lines.push(`- ${futureStep}`);
  }
  if (input.acceptanceCriteria.length > 0) {
    lines.push('', 'Acceptance Criteria:');
    for (const criterion of input.acceptanceCriteria) lines.push(`- ${criterion}`);
  }

  return lines.join('\n');
}
