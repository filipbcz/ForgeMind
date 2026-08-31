import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();

const rootPackageJson = await readPackageJson(root);
const workspacePatterns = Array.isArray(rootPackageJson.workspaces)
  ? rootPackageJson.workspaces
  : rootPackageJson.workspaces?.packages ?? [];

const workspaces = [];
for (const pattern of workspacePatterns) {
  workspaces.push(...await expandWorkspacePattern(pattern));
}

const failures = [];
const npmExecutable = process.env.npm_execpath;

for (const workspacePath of workspaces) {
  const packageJson = await readPackageJson(workspacePath);
  const testScript = packageJson.scripts?.test;

  if (!isExecutableTestScript(testScript)) {
    continue;
  }

  const workspace = packageJson.name ?? relative(root, workspacePath);
  const result = spawnSync(
    npmExecutable ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npmExecutable ? [npmExecutable, 'run', 'test', '-w', workspace] : ['run', 'test', '-w', workspace],
    {
    cwd: root,
    stdio: 'inherit',
    shell: false
    }
  );

  if (result.error) {
    console.error(`Workspace test command failed to start for ${workspace}: ${result.error.message}`);
    failures.push(workspace);
    continue;
  }

  if (result.status !== 0) {
    failures.push(workspace);
  }
}

if (failures.length > 0) {
  console.error('Workspace tests failed:');
  for (const workspace of failures) {
    console.error(`- ${workspace}`);
  }
  process.exit(1);
}

async function readPackageJson(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
}

async function expandWorkspacePattern(pattern) {
  if (!pattern.endsWith('/*')) {
    return [join(root, pattern)];
  }

  const base = join(root, pattern.slice(0, -2));
  const entries = await readdir(base, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(base, entry.name));
}

function isExecutableTestScript(script) {
  if (typeof script !== 'string' || script.trim().length === 0) {
    return false;
  }

  return !/\bno test specified\b/i.test(script);
}
