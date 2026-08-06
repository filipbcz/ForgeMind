import { createServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const port = Number.parseInt(process.env.CODEX_OAUTH_RELAY_PORT ?? '1455', 10);
const upstreamPort = Number.parseInt(process.env.CODEX_OAUTH_RELAY_UPSTREAM_PORT ?? '1455', 10);
const relayAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === 'IPv4' && !address.internal)?.address;

if (!relayAddress || !Number.isInteger(port) || !Number.isInteger(upstreamPort)) {
  throw new Error('Codex OAuth relay requires a non-loopback IPv4 address and valid port numbers.');
}

const server = createServer((browser) => {
  const codex = connect({ host: '127.0.0.1', port: upstreamPort });
  browser.pipe(codex);
  codex.pipe(browser);
  codex.on('error', () => browser.destroy());
  browser.on('error', () => codex.destroy());
});

server.listen(port, relayAddress, () => {
  console.log(`Codex OAuth callback relay listening on ${relayAddress}:${port}.`);
});

server.on('error', (error) => {
  console.error('Codex OAuth callback relay failed:', error);
  process.exitCode = 1;
});