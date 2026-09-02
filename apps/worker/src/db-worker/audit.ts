import type { AcceptanceEvidence, Project, ProjectContract } from '@forgemind/core';
import type { ForgeMindRepository } from '@forgemind/db';
import { toErrorMessage } from '@forgemind/shared';
import type { WorkerTaskResult } from '../workflow.js';

export function sanitizeAuditErrorMessage(message: string): string {
  return message.replace(/https:\/\/[^@\s]+@/gi, 'https://[credential-redacted]@');
}

export function hasSatisfiedReleaseAudit(evidence: AcceptanceEvidence[], contract: ProjectContract, commitSha: string): boolean {
  const passedCriteria = new Set(evidence
    .filter((item) =>
      item.source === 'repository_audit'
      && item.status === 'passed'
      && item.contractVersion === contract.version
      && item.commitSha === commitSha
      && item.criterion.startsWith('Release: ')
    )
    .map((item) => item.criterion.slice('Release: '.length).replace(/\s+/g, ' ').trim().toLowerCase()));
  return [...contract.invariants, ...contract.releaseCriteria, 'Original brief coverage']
    .every((criterion) => passedCriteria.has(criterion.replace(/\s+/g, ' ').trim().toLowerCase()));
}

export async function recordTaskAcceptanceEvidence(
  repository: ForgeMindRepository,
  input: { project: Project; taskId: string; taskRunId: string; result: WorkerTaskResult }
): Promise<void> {
  const contract = input.project.projectContract;
  if (!contract) return;

  try {
    const step = await repository.getImplementationStepByTaskId(input.taskId);
    if (!step || step.requirementIds.length === 0) return;

    for (const check of input.result.validation.checkResults ?? []) {
      if (!check.criterion?.trim()) continue;
      await repository.recordAcceptanceEvidence({
        projectId: input.project.id,
        cycleId: step.cycleId,
        stepId: step.id,
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        requirementIds: step.requirementIds,
        criterion: check.criterion,
        source: 'validation_command',
        status: check.passed ? 'passed' : 'failed',
        evidenceIdentity: check.command,
        contractVersion: contract.version,
        commitSha: input.result.commitSha,
        command: check.command,
        exitCode: check.exitCode,
        payload: {
          rationale: check.rationale ?? null,
          stdout: limitEvidenceText(check.stdout),
          stderr: limitEvidenceText(check.stderr)
        }
      });
    }

  } catch (error) {
    await repository.writeAudit({
      actorType: 'system',
      eventType: 'acceptance_evidence_record_failed',
      projectId: input.project.id,
      taskId: input.taskId,
      payload: { errorMessage: toErrorMessage(error), taskRunId: input.taskRunId }
    });
  }
}

function limitEvidenceText(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[evidence output truncated]`;
}
