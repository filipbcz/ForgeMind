import { activeProjectContractRequirements } from '@forgemind/core';
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

export async function advanceRoadmapAfterTaskCapabilityWait(
  repository: ForgeMindRepository,
  taskId: string
): Promise<RoadmapAdvanceResult> {
  const linkedStep = await repository.getImplementationStepByTaskId(taskId);
  if (!linkedStep || (linkedStep.status !== 'running' && linkedStep.status !== 'waiting_for_capability')) {
    return { advanced: false };
  }
  const waitingStep = linkedStep.status === 'waiting_for_capability'
    ? linkedStep
    : await repository.updateImplementationStepStatus(linkedStep.id, 'waiting_for_capability');
  if (!waitingStep) return { advanced: false };
  const nextTask = await startNextRoadmapStep(repository, waitingStep.projectId, waitingStep.cycleId);
  return { advanced: true, completedStep: waitingStep, nextTask };
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
  if (cycleSteps.some((candidate) => candidate.status === 'waiting_for_capability')) {
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
  if (cycle.status === 'completed' || cycle.status === 'awaiting_extension_approval') {
    return { advanced: linkedStep.status !== 'completed', completedStep, completedCycle: cycle, project };
  }
  const audit = await repository.enqueueProjectAudit({
    projectId: project.id,
    cycleId: cycle.id,
    triggerTaskId: taskId,
    requirementIds: activeProjectContractRequirements(project.projectContract).map((requirement) => requirement.id)
  });
  return { advanced: true, completedStep, auditQueued: audit.enqueued, project };
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

  const currentIndex = cycleSteps.findIndex((candidate) => candidate.id === nextStep.id);
  const completedSteps = cycleSteps
    .filter((candidate) => candidate.status === 'completed')
    .map((candidate) => candidate.title);
  const futureSteps = cycleSteps.slice(currentIndex + 1).map((candidate) => candidate.title);
  return repository.createAndStartRoadmapStepTask(nextStep.id, {
      projectId: project.id,
      title: `${project.name}: ${nextStep.title}`,
      prompt: buildRoadmapStepTaskPrompt({
        projectName: project.name,
        objective: cycle.objective,
        stepTitle: nextStep.title,
        stepDescription: nextStep.description,
        acceptanceCriteria: nextStep.acceptanceCriteria,
        requirementIds: nextStep.requirementIds,
        deliverables: nextStep.deliverables,
        changeRationale: nextStep.changeRationale,
        dependsOnStepTitles: nextStep.dependsOnStepTitles,
        validationFocus: nextStep.validationFocus,
        projectContract: project.projectContract,
        completedSteps,
        futureSteps
      }),
      mode: project.defaultTaskMode ?? 'safe',
      maxIterations: 10,
      maxBudgetUsd: 5,
      architectureVersionId: project.currentArchitectureVersionId ?? cycle.architectureVersionId
  });
}

export function buildRoadmapStepTaskPrompt(input: {
  projectName: string;
  objective: string;
  stepTitle: string;
  stepDescription: string;
  acceptanceCriteria: string[];
  requirementIds?: string[];
  deliverables?: string[];
  changeRationale?: string;
  dependsOnStepTitles?: string[];
  validationFocus?: ProjectImplementationStep['validationFocus'];
  projectContract?: Project['projectContract'];
  completedSteps: string[];
  futureSteps: string[];
}): string {
  const lines = [
    `Project: ${input.projectName}`,
    '',
    'Parent objective:',
    input.objective,
  ];

  if (input.projectContract) {
    const requirements = input.projectContract.requirements.filter((requirement) =>
      (input.requirementIds ?? []).includes(requirement.id)
    );
    lines.push(
      '',
      'Project contract:',
      `Summary: ${input.projectContract.summary}`,
      'Global invariants:',
      ...input.projectContract.invariants.map((item) => `- ${item}`),
      ...(input.projectContract.prohibitedSubstitutes.length > 0
        ? ['Prohibited substitutes:', ...input.projectContract.prohibitedSubstitutes.map((item) => `- ${item}`)]
        : []),
      'Requirements covered by this work item:',
      ...requirements.map((requirement) => `- ${requirement.id}: ${requirement.title} - ${requirement.description}`)
    );
  }

  lines.push(
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
  );

  if (input.deliverables?.length) {
    lines.push('', 'Required deliverables:', ...input.deliverables.map((deliverable) => `- ${deliverable}`));
  }
  if (input.changeRationale) {
    lines.push('', 'Reason this step exists in the current change:', input.changeRationale);
  }
  if (input.dependsOnStepTitles?.length) {
    lines.push('', 'Required predecessor steps:', ...input.dependsOnStepTitles.map((title) => `- ${title}`));
  }
  if (input.validationFocus?.length) {
    lines.push('', 'Required validation focus:', ...input.validationFocus.map((focus) => `- ${focus}`));
  }

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
