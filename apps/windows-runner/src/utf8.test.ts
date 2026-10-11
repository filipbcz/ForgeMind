import { describe, expect, it } from 'vitest';
import { truncateUtf8Tail } from './utf8.js';

describe('truncateUtf8Tail', () => {
  it('bounds Czech compiler output by UTF-8 bytes without corrupting a character', () => {
    const output = `prefix-${'Příliš žluťoučký kůň '.repeat(20)}-latest`;
    const truncated = truncateUtf8Tail(output, 64);

    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(64);
    expect(truncated).toMatch(/-latest$/);
    expect(truncated).not.toContain('\ufffd');
  });

  it('returns only complete code points when the byte limit is smaller than the final character', () => {
    expect(truncateUtf8Tail('abcž', 1)).toBe('');
    expect(truncateUtf8Tail('abcž', 2)).toBe('ž');
    expect(truncateUtf8Tail('abcž', 3)).toBe('cž');
  });

  it('handles empty limits and already bounded text', () => {
    expect(truncateUtf8Tail('text', 0)).toBe('');
    expect(truncateUtf8Tail('text', 4)).toBe('text');
  });
});
