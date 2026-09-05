import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli.js';

describe('Windows runner CLI parsing', () => {
  it.each([
    [['enroll', '--api-url', 'https://forgemind.test'], { command: 'enroll', apiUrl: 'https://forgemind.test' }],
    [['probe', '--api-url', 'https://forgemind.test'], { command: 'probe', apiUrl: 'https://forgemind.test' }],
    [['session', 'start', '--project', '11111111-1111-4111-8111-111111111111', '--api-url', 'https://forgemind.test'], { command: 'session-start', apiUrl: 'https://forgemind.test', projectIds: ['11111111-1111-4111-8111-111111111111'] }],
    [['session', 'drain', '--api-url', 'https://forgemind.test', '--session-id', 'session-1'], { command: 'session-drain', apiUrl: 'https://forgemind.test', sessionId: 'session-1' }],
    [['session', 'stop', '--api-url', 'https://forgemind.test', '--session-id', 'session-1'], { command: 'session-stop', apiUrl: 'https://forgemind.test', sessionId: 'session-1' }]
  ])('parses documented command %j', (args, expected) => {
    expect(parseCliArgs(args as string[])).toMatchObject(expected);
  });
  it('requires explicit project-scoped activation', () => {
    expect(() => parseCliArgs(['session', 'start', '--api-url', 'https://forgemind.test'])).toThrow(/--project/);
  });
});
