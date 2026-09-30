import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['apps/studio-api/dist/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: process.env.DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
let settled = false;
const timeout = setTimeout(() => finish(new Error(`Studio API bundle did not start within 15 seconds.\n${output}`)), 15_000);

child.stdout.on('data', consume);
child.stderr.on('data', consume);
child.on('error', finish);
child.on('exit', (code, signal) => {
  if (!settled) finish(new Error(`Studio API bundle exited before startup (code=${code}, signal=${signal}).\n${output}`));
});

function consume(chunk) {
  output = `${output}${chunk.toString('utf8')}`.slice(-32_000);
  if (output.includes('ForgeMind Studio API listening')) finish();
}

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  child.kill();
  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    console.log('Studio API production bundle started successfully.');
  }
}
