import type { ForgeTask, Project } from '@forgemind/core';
import { disconnectPrisma } from '@forgemind/db';
import { createId, nowIso } from '@forgemind/shared';
import { runDatabaseWorkerOnce } from './db-worker.js';
import { runWorkerTask } from './workflow.js';

if (process.env.DATABASE_URL) {
  try {
    const result = await runDatabaseWorkerOnce();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await disconnectPrisma();
  }
  process.exit(0);
}

const demoProject: Project = {
  id: 'project_demo_gallery',
  name: 'Demo Static Gallery',
  slug: 'demo-static-gallery',
  githubOwner: 'demo',
  githubRepo: 'demo-static-gallery',
  defaultBranch: 'main',
  isActive: true,
  createdAt: nowIso(),
  updatedAt: nowIso()
};

const demoTask: ForgeTask = {
  id: createId('task'),
  projectId: demoProject.id,
  createdByUserId: 'user_local_owner',
  title: 'Mock ForgeMind workflow',
  prompt: 'Simulate a safe implementation and validate the worker lifecycle.',
  mode: 'safe',
  status: 'submitted',
  maxIterations: 10,
  maxBudgetUsd: 2,
  createdAt: nowIso(),
  updatedAt: nowIso()
};

const result = await runWorkerTask({
  project: demoProject,
  task: demoTask,
  providerKind: 'mock',
  verifyCommand: process.env.FORGEMIND_VERIFY_COMMAND ?? 'node --version',
  workspaceRoot: process.env.FORGEMIND_WORKSPACE_ROOT
});

console.log(JSON.stringify(result, null, 2));
