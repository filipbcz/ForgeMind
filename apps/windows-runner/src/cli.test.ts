import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli.js';

describe('Windows runner CLI parsing', () => {
  it.each([
    [['enroll', '--api-url', 'https://forgemind.test'], { command: 'enroll', apiUrl: 'https://forgemind.test' }],
    [['probe', '--api-url', 'https://forgemind.test'], { command: 'probe', apiUrl: 'https://forgemind.test' }],
    [['session', 'start', '--api-url', 'https://forgemind.test'], { command: 'session-start', apiUrl: 'https://forgemind.test', minutes: 60 }],
    [['session', 'start', '--minutes', '30', '--api-url', 'https://forgemind.test'], { command: 'session-start', apiUrl: 'https://forgemind.test', minutes: 30 }],
    [['session', 'drain', '--api-url', 'https://forgemind.test', '--session-id', 'session-1'], { command: 'session-drain', apiUrl: 'https://forgemind.test', sessionId: 'session-1' }]
  ])('parses documented command %j', (args, expected) => {
    expect(parseCliArgs(args as string[])).toEqual(expected);
  });
});
