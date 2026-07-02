import { describe, expect, it } from 'vitest';
import { createAiBranchName } from './index.js';

describe('GitHub helpers', () => {
  it('creates stable AI branch names', () => {
    expect(createAiBranchName(123, 'Přidat galerii fotek podle dne')).toBe('ai/123-pridat-galerii-fotek-podle-dne');
  });
});

