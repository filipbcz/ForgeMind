import { describe, expect, it } from 'vitest';
import type { PlanResult } from '@forgemind/providers';
import { buildRoadmapStepTaskPrompt, findFirstPendingStepForLatestCycle, resolveTaskMode, toImplementationStepBlueprints } from './routes.js';

describe('project roadmap generation', () => {
  it('preserves independent scope and acceptance criteria for every step', () => {
    const plan: PlanResult = {
      summary: 'Roadmap',
      steps: ['Document scope', 'Build generator'],
      acceptanceCriteria: ['Project-wide criterion that must not be copied'],
      implementationSteps: [
        {
          title: 'Document MVP scope',
          description: 'Write the product and technical scope before implementation.',
          acceptanceCriteria: ['The MVP scope document defines supported grades and operations.'],
          inScope: ['Documentation'],
          outOfScope: ['Application source code']
        },
        {
          title: 'Build exercise generator',
          description: 'Implement deterministic grade-specific arithmetic generation.',
          acceptanceCriteria: ['Generator tests cover every supported grade and operation.'],
          inScope: ['Generator module', 'Generator tests'],
          outOfScope: ['Practice UI']
        }
      ]
    };

    expect(toImplementationStepBlueprints(plan)).toEqual([
      {
        title: 'Document MVP scope',
        description: 'Write the product and technical scope before implementation.\n\nIn scope:\n- Documentation\n\nOut of scope:\n- Application source code',
        acceptanceCriteria: ['The MVP scope document defines supported grades and operations.']
      },
      {
        title: 'Build exercise generator',
        description: 'Implement deterministic grade-specific arithmetic generation.\n\nIn scope:\n- Generator module\n- Generator tests\n\nOut of scope:\n- Practice UI',
        acceptanceCriteria: ['Generator tests cover every supported grade and operation.']
      }
    ]);
  });

  it('rejects an unstructured provider response instead of duplicating global criteria', () => {
    expect(() => toImplementationStepBlueprints({
      summary: 'Legacy roadmap',
      steps: ['One', 'Two'],
      acceptanceCriteria: ['Everything works']
    })).toThrow('structured implementationSteps');
  });

  it('makes completed and future step boundaries explicit without duplicating the title', () => {
    const prompt = buildRoadmapStepTaskPrompt({
      projectName: 'Mathematica',
      objective: 'Build a math practice app.',
      stepTitle: 'Build exercise generator',
      stepDescription: 'Implement grade-specific generation.\n\nIn scope:\n- Generator\n\nOut of scope:\n- UI',
      acceptanceCriteria: ['Generator tests pass.'],
      completedSteps: ['Document MVP scope'],
      futureSteps: ['Build practice UI']
    });

    expect(prompt.match(/Build exercise generator/g)).toHaveLength(1);
    expect(prompt).toContain('Already completed roadmap steps (existing repository context):\n- Document MVP scope');
    expect(prompt).toContain('Future roadmap steps (explicitly out of scope):\n- Build practice UI');
    expect(prompt).toContain('Do not implement work assigned to future roadmap steps.');
  });

  it('starts only the first pending step from the latest roadmap cycle', () => {
    expect(findFirstPendingStepForLatestCycle({
      cycles: [
        { id: 'old', cycleNumber: 1 },
        { id: 'latest', cycleNumber: 2 }
      ],
      steps: [
        { cycleId: 'old', sequenceNumber: 2, status: 'pending' },
        { cycleId: 'latest', sequenceNumber: 2, status: 'pending' },
        { cycleId: 'latest', sequenceNumber: 1, status: 'pending' }
      ]
    })).toEqual({ cycleId: 'latest', sequenceNumber: 1, status: 'pending' });
  });

  it('uses the project task mode unless a task explicitly overrides it', () => {
    expect(resolveTaskMode(undefined, 'full_auto')).toBe('full_auto');
    expect(resolveTaskMode('safe', 'full_auto')).toBe('safe');
    expect(resolveTaskMode(undefined, undefined)).toBe('safe');
  });
});
