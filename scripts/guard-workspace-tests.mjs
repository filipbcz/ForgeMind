import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const rootPackageJson = await readPackageJson(root);
const workspacePatterns = Array.isArray(rootPackageJson.workspaces)
  ? rootPackageJson.workspaces
  : rootPackageJson.workspaces?.packages ?? [];

const workspaces = [];
for (const pattern of workspacePatterns) {
  workspaces.push(...await expandWorkspacePattern(pattern));
}

const failures = [];

for (const workspacePath of workspaces) {
  const packageJson = await readPackageJson(workspacePath);
  const hasTests = await containsTestFiles(workspacePath);
  const testScript = packageJson.scripts?.test;

  if (hasTests && !isExecutableTestScript(testScript)) {
    failures.push(relative(root, workspacePath));
  }
}

if (failures.length > 0) {
  console.error('Workspaces with test files must define an executable test script:');
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

async function containsTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsTestFiles(entryPath)) {
        return true;
      }
      continue;
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      return true;
    }
  }

  return false;
}

function isExecutableTestScript(script) {
  if (typeof script !== 'string' || script.trim().length === 0) {
    return false;
  }

  return !/\bno test specified\b/i.test(script);
}
