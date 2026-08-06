import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const relayScript = fileURLToPath(new URL('./codex-oauth-relay.mjs', import.meta.url));
const timeoutMs = 3_000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs))
  ]);
}

test('forwards the callback from a non-loopback address to the Codex loopback listener', async (context) => {
  const relayAddress = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
  assert.ok(relayAddress, 'a non-loopback IPv4 address is required');

  const upstreamPort = 24556;
  const relayPort = 24557;
  const upstream = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.end('callback-forwarded');
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

  const relay = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      CODEX_OAUTH_RELAY_PORT: String(relayPort),
      CODEX_OAUTH_RELAY_UPSTREAM_PORT: String(upstreamPort)
    }
  });
  relay.stdout.on('error', () => undefined);
  relay.stderr.on('error', () => undefined);
  context.after(() => {
    relay.kill();
    upstream.close();
  });
  let relayError = '';
  relay.stderr.setEncoding('utf8');
  relay.stderr.on('data', (chunk) => {
    relayError += chunk;
  });
  await withTimeout(new Promise((resolve, reject) => {
    const onData = (data) => {
      relay.off('exit', onExit);
      resolve(data);
    };
    const onExit = (code) => {
      relay.stdout.off('data', onData);
      reject(new Error(`Relay exited during startup with code ${code}: ${relayError}`));
    };
    relay.stdout.once('data', onData);
    relay.once('exit', onExit);
  }), `Relay startup (${relayError})`);

  const response = await withTimeout(new Promise((resolve, reject) => {
    const socket = connect({ host: relayAddress, port: relayPort }, () => socket.write('callback'));
    socket.setEncoding('utf8');
    socket.once('data', (data) => {
      socket.destroy();
      resolve(data);
    });
    socket.once('error', reject);
  }), 'Callback forwarding');

  assert.equal(response, 'callback-forwarded');
});
