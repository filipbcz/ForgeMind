import { describe, expect, it } from 'vitest';
import { createId, nowIso, toErrorMessage } from './index.js';

describe('shared helpers', () => {
  it('creates prefixed ids', () => {
    expect(createId('task')).toMatch(/^task_[0-9a-f-]{36}$/);
  });

  it('creates ISO timestamps', () => {
    expect(new Date(nowIso()).toString()).not.toBe('Invalid Date');
  });

  it('normalizes unknown errors', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('plain')).toBe('plain');
  });
});

