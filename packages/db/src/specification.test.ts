import { describe, expect, it } from 'vitest';
import { composeApprovedExtensionSpecification } from './specification.js';

describe('project specification versions', () => {
  it('creates a complete cumulative snapshot from an approved extension', () => {
    expect(composeApprovedExtensionSpecification(
      'Build a focused task ledger with four fixed categories.',
      'Add weekly trend reporting without changing the category invariant.'
    )).toBe([
      'Build a focused task ledger with four fixed categories.',
      '## Approved extension\nAdd weekly trend reporting without changing the category invariant.'
    ].join('\n\n'));
  });

  it('rejects an empty approved extension', () => {
    expect(() => composeApprovedExtensionSpecification('Current specification', '   '))
      .toThrow('Approved project extension must not be empty.');
  });
});
