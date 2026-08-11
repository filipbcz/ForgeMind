import { describe, expect, it } from 'vitest';
import type { ProjectContract, ProjectContractDelta } from './model.js';
import { activeProjectContractRequirements, applyProjectContractDelta } from './project-contract.js';

const current: ProjectContract = {
  version: 2,
  summary: 'Task ledger',
  invariants: ['Task ids are never reused.'],
  prohibitedSubstitutes: ['No in-memory-only persistence.'],
  requirements: [
    {
      id: 'REQ-TASKS',
      title: 'Persist tasks',
      description: 'Tasks survive restarts.',
      acceptanceCriteria: ['A restarted process reads prior tasks.'],
      status: 'active',
      introducedInVersion: 1,
      lastChangedInVersion: 1
    },
    {
      id: 'REQ-SEARCH',
      title: 'Search tasks',
      description: 'Users can search task text.',
      acceptanceCriteria: ['Search is case insensitive.'],
      status: 'active',
      introducedInVersion: 2,
      lastChangedInVersion: 2
    }
  ],
  releaseCriteria: ['All tests pass.']
};

function delta(overrides: Partial<ProjectContractDelta> = {}): ProjectContractDelta {
  return {
    baseVersion: 2,
    addRequirements: [],
    updateRequirements: [],
    supersedeRequirements: [],
    removeRequirements: [],
    invariantChanges: { add: [], remove: [] },
    prohibitedSubstituteChanges: { add: [], remove: [] },
    releaseCriteriaChanges: { add: [], remove: [] },
    migrationImpacts: [],
    compatibilityImpacts: [],
    ...overrides
  };
}

describe('project contract delta', () => {
  it('applies additions, updates and supersessions deterministically while preserving history', () => {
    const input = delta({
      summary: 'Task ledger with scheduling',
      updateRequirements: [{
        id: 'REQ-TASKS',
        description: 'Tasks and optional due dates survive restarts.',
        rationale: 'Scheduling extends the persisted task shape.'
      }],
      supersedeRequirements: [{
        id: 'REQ-SEARCH',
        replacement: {
          id: 'REQ-FILTER',
          title: 'Filter tasks',
          description: 'Users can filter task text and due date.',
          acceptanceCriteria: ['Filtering remains case insensitive.']
        },
        rationale: 'The broader filter contract replaces text-only search.'
      }],
      addRequirements: [{
        id: 'REQ-DUE-DATE',
        title: 'Schedule tasks',
        description: 'A task can have an optional due date.',
        acceptanceCriteria: ['Due dates persist across restarts.']
      }],
      invariantChanges: { add: ['Older files remain readable.'], remove: [] },
      migrationImpacts: ['Read missing dueDate as null.'],
      compatibilityImpacts: ['Existing commands retain their output.']
    });

    const first = applyProjectContractDelta(current, input);
    const second = applyProjectContractDelta(current, input);

    expect(first).toEqual(second);
    expect(first.contract.version).toBe(3);
    expect(first.touchedRequirementIds).toEqual(['REQ-DUE-DATE', 'REQ-TASKS', 'REQ-SEARCH', 'REQ-FILTER']);
    expect(first.contract.requirements.find((item) => item.id === 'REQ-SEARCH')).toMatchObject({
      status: 'superseded', supersededByRequirementId: 'REQ-FILTER', lastChangedInVersion: 3
    });
    expect(activeProjectContractRequirements(first.contract).map((item) => item.id)).toEqual([
      'REQ-TASKS', 'REQ-DUE-DATE', 'REQ-FILTER'
    ]);
  });

  it('rejects unknown ids, conflicting operations and unjustified removals', () => {
    expect(() => applyProjectContractDelta(current, delta({
      updateRequirements: [{ id: 'REQ-UNKNOWN', title: 'Unknown', rationale: 'Change it.' }]
    }))).toThrow('unknown requirement');

    expect(() => applyProjectContractDelta(current, delta({
      updateRequirements: [{ id: 'REQ-SEARCH', title: 'Updated', rationale: 'Change it.' }],
      removeRequirements: [{ id: 'REQ-SEARCH', rationale: 'Remove it.' }]
    }))).toThrow('conflicting operations');

    expect(() => applyProjectContractDelta(current, delta({
      removeRequirements: [{ id: 'REQ-SEARCH', rationale: ' ' }]
    }))).toThrow('requires a rationale');
  });

  it('rejects a stale or empty delta', () => {
    expect(() => applyProjectContractDelta(current, delta({ baseVersion: 1 }))).toThrow('current version is 2');
    expect(() => applyProjectContractDelta(current, delta())).toThrow('does not contain any contract change');
  });
});
