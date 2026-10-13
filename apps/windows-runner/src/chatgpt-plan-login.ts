import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { RunnerCredential } from './credential-store.js';
import type { WindowsRunnerTransport } from './transport.js';

const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export async function connectChatGPTPlan(
  transport: WindowsRunnerTransport,
  auth: RunnerCredential,
  enrollmentCode: string,
  report: (message: string) => void
): Promise<{ connectionId: string; name: string }> {
  const enrollment = await transport.exchangeChatGPTPlanEnrollment(auth, enrollmentCode.trim());
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = await createLoopbackCallback(state);
  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'ForgeMind',
    ext_agent_host_id: enrollment.hostId,
    response_type: 'code',
    redirect_uri: callback.redirectUri,
    scope: SCOPES,
    resource: 'https://api.openai.com/v1',
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge
  }).toString();
  report('Opening ChatGPT authorization in the default browser...');
  spawn('cmd.exe', ['/d', '/c', 'start', '', authorize.toString()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  let result: { code: string; clientId: string };
  try {
    result = await callback.result;
  } finally {
    callback.close();
  }
  report('Exchanging the authorization code and validating the account...');
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: result.clientId,
      code: result.code,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
      resource: 'https://api.openai.com/v1'
    })
  });
  const payload = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok) {
    throw new Error(`ChatGPT authorization code exchange failed (HTTP ${tokenResponse.status}, ${String(payload.error ?? 'unknown_error')}).`);
  }
  const completed = await transport.completeChatGPTPlanEnrollment(auth, {
    uploadToken: enrollment.uploadToken,
    nonce,
    clientId: result.clientId,
    accessToken: requiredString(payload, 'access_token'),
    refreshToken: requiredString(payload, 'refresh_token'),
    idToken: requiredString(payload, 'id_token'),
    scope: typeof payload.scope === 'string' ? payload.scope : SCOPES,
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : 3600
  });
  return { connectionId: completed.connection.id, name: completed.connection.name };
}

async function createLoopbackCallback(expectedState: string): Promise<{
  redirectUri: string;
  result: Promise<{ code: string; clientId: string }>;
  close: () => void;
}> {
  let settle: ((value: { code: string; clientId: string }) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const result = new Promise<{ code: string; clientId: string }>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const clientId = url.searchParams.get('client_id');
    if (state !== expectedState) reject?.(new Error('ChatGPT OAuth state validation failed.'));
    else if (error) reject?.(new Error(`ChatGPT authorization failed: ${error}.`));
    else if (!code || !clientId || clientId === 'dynamic_agent_client') reject?.(new Error('ChatGPT authorization callback is incomplete.'));
    else settle?.({ code, clientId });
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>ForgeMind</title><p>ChatGPT účet byl připojen. Toto okno můžete zavřít.</p>');
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate the ChatGPT OAuth callback port.');
  const timeout = setTimeout(() => reject?.(new Error('ChatGPT authorization timed out after 10 minutes.')), 10 * 60_000);
  timeout.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
    result: result.finally(() => clearTimeout(timeout)),
    close: () => server.close()
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !candidate) throw new Error(`ChatGPT token response is missing ${key}.`);
  return candidate;
}
