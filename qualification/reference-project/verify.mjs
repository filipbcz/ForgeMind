import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const repositoryUrl = process.argv[2];
if (!repositoryUrl) throw new Error('Repository URL is required.');
const previewUrl = process.env.FORGEMIND_QUALIFICATION_PREVIEW_URL ?? 'http://localhost:18080';
const tempRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp')
  : os.tmpdir();
const root = await mkdtemp(path.join(tempRoot, 'forgemind-qualification-'));
const repository = path.join(root, 'repository');

function spawnSpec(command, args) {
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args]
    };
  }
  return { command, args };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, args);
    const child = spawn(spec.command, spec.args, { cwd: options.cwd ?? repository, stdio: 'inherit', shell: false, env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} failed with ${code}.`)));
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, args);
    const child = spawn(spec.command, spec.args, { cwd: options.cwd ?? repository, shell: false, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${stderr.trim()}`)));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${previewUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Preview health endpoint did not become ready.');
}

async function json(endpoint, options = {}) {
  const response = await fetch(`${previewUrl}${endpoint}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${endpoint} failed with ${response.status}: ${text}`);
  return body;
}

async function login(email) {
  const result = await json('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'Admin123!' })
  });
  if (typeof result.token !== 'string' || !result.user?.role) throw new Error('Login response is missing token or role.');
  return result;
}

async function verifyApi() {
  const [admin, manager, agent] = await Promise.all([
    login('admin@example.test'),
    login('manager@example.test'),
    login('agent@example.test')
  ]);
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  const created = await json('/api/work-items', {
    method: 'POST',
    headers: auth(agent.token),
    body: JSON.stringify({ title: 'Hidden qualification request', description: 'Created through the public API.' })
  });
  if (!created.id || created.status !== 'OPEN') throw new Error('Created work item does not satisfy the OPEN contract.');
  const assigned = await json(`/api/work-items/${created.id}/assignee`, {
    method: 'PATCH',
    headers: auth(manager.token),
    body: JSON.stringify({ assigneeId: manager.user.id })
  });
  if (assigned.assigneeId !== manager.user.id) throw new Error('Manager assignment was not persisted.');
  await json(`/api/work-items/${created.id}/status`, {
    method: 'PATCH',
    headers: auth(manager.token),
    body: JSON.stringify({ status: 'IN_PROGRESS' })
  });
  await json(`/api/work-items/${created.id}/status`, {
    method: 'PATCH',
    headers: auth(manager.token),
    body: JSON.stringify({ status: 'DONE' })
  });
  const report = await json('/api/reports/summary', { headers: auth(admin.token) });
  for (const key of ['total', 'open', 'inProgress', 'done']) {
    if (!Number.isInteger(report[key])) throw new Error(`Report field ${key} is not numeric.`);
  }
  const forbidden = await fetch(`${previewUrl}/api/reports/summary`, { headers: auth(agent.token) });
  if (forbidden.status !== 403) throw new Error(`Agent report access returned ${forbidden.status}, expected 403.`);
}

async function verifyDatabase() {
  const query = `
    select json_build_object(
      'users', count(*) filter (where regexp_replace(lower(table_name), '[^a-z]', '', 'g') like '%user%'),
      'workItems', count(*) filter (where regexp_replace(lower(table_name), '[^a-z]', '', 'g') like '%workitem%'),
      'auditEvents', count(*) filter (where regexp_replace(lower(table_name), '[^a-z]', '', 'g') like '%auditevent%'),
      'migrations', count(*) filter (where lower(table_name) like '%migration%')
    )
    from information_schema.tables
    where table_schema = 'public';
  `.replace(/\s+/g, ' ').trim();
  const command = `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "${query}"`;
  const result = JSON.parse(await runCapture('docker', ['compose', 'exec', '-T', 'db', 'sh', '-lc', command]));
  for (const key of ['users', 'workItems', 'auditEvents', 'migrations']) {
    if (!Number.isInteger(result[key]) || result[key] < 1) {
      throw new Error(`Database is missing a durable ${key} relation; discovered ${JSON.stringify(result)}.`);
    }
  }
}

async function verifyBrowser() {
  const executablePath = process.env.FORGEMIND_QUALIFICATION_CHROME
    ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(previewUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('login-email').fill('admin@example.test');
    await page.getByTestId('login-password').fill('Admin123!');
    await page.getByTestId('login-submit').click();
    await page.getByTestId('current-user').waitFor();
    await page.goto(`${previewUrl}/reports`, { waitUntil: 'networkidle' });
    for (const testId of ['report-total', 'report-open', 'report-in-progress', 'report-done', 'report-assignees']) {
      await page.getByTestId(testId).waitFor();
    }
  } finally {
    await browser.close();
  }
}

try {
  await run('git', ['clone', '--depth', '1', repositoryUrl, repository], { cwd: root });
  const packageJson = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  for (const script of ['test', 'lint', 'typecheck', 'build']) {
    if (!packageJson.scripts?.[script]) throw new Error(`Root package.json is missing ${script}.`);
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run(npm, ['ci']);
  await run(npm, ['test']);
  await run(npm, ['run', 'lint']);
  await run(npm, ['run', 'typecheck']);
  await run(npm, ['run', 'build']);
  await run('docker', ['compose', 'up', '-d', '--build']);
  await waitForHealth();
  await verifyApi();
  await verifyDatabase();
  await verifyBrowser();
  console.log('Reference project passed regression, API, database, browser and preview qualification.');
} finally {
  try { await run('docker', ['compose', 'down', '-v']); } catch {}
  await rm(root, { recursive: true, force: true });
}
