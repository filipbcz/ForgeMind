import { describe, expect, it } from 'vitest';
import { windowsBrowserLaunch } from './chatgpt-plan-login.js';

describe('ChatGPT plan browser launch', () => {
  it('passes the complete OAuth URL directly to the Windows URL handler', () => {
    const url = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&agent_name_hint=ForgeMind&scope=openid+profile';

    const launch = windowsBrowserLaunch(url);

    expect(launch.command).toBe('rundll32.exe');
    expect(launch.args).toEqual(['url.dll,FileProtocolHandler', url]);
    expect(launch.args[1]).toContain('&agent_name_hint=ForgeMind&scope=openid+profile');
  });

  it('rejects a non-HTTPS authorization URL', () => {
    expect(() => windowsBrowserLaunch('http://auth.openai.com/api/accounts/authorize')).toThrow(
      'ChatGPT authorization URL must use HTTPS.'
    );
  });
});
