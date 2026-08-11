import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { qualificationManifest as manifest } from './manifest.mjs';

const apiUrl = (process.env.FORGEMIND_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const statePath = path.resolve(process.env.FORGEMIND_QUALIFICATION_STATE ?? '.forgemind/qualification/reference-project.json');
const command = process.argv[2] ?? 'status';

async function request(endpoint, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}${endpoint}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...options.headers }
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : undefined;
      if (response.ok) return body;
      const error = new Error(`${options.method ?? 'GET'} ${endpoint} failed with ${response.status}: ${body?.error ?? text}`);
      if (![502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^\w+ \/api\/.+ failed with \d+:/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 500 * (2 ** attempt))));
  }
  throw lastError;
}

async function readState() {
  return JSON.parse(await readFile(statePath, 'utf8'));
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function suffix() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14).toLowerCase();
}

async function provision() {
  const [connections, owners] = await Promise.all([
    request('/api/providers/connections'),
    request('/api/github/repository-owners?limit=100')
  ]);
  const connection = connections.find((item) => item.isDefault && item.provider === 'codex')
    ?? connections.find((item) => item.provider === 'codex');
  if (!connection) throw new Error('A working Codex provider connection is required.');
  const owner = process.env.FORGEMIND_QUALIFICATION_GITHUB_OWNER
    ?? owners.find((item) => item.kind === 'user')?.login
    ?? owners[0]?.login;
  if (!owner) throw new Error('A GitHub repository owner is required.');

  const runSuffix = suffix();
  const repository = `${manifest.repositoryPrefix}-${runSuffix}`;
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: `${manifest.name} ${runSuffix}`,
      slug: `${manifest.slugPrefix}-${runSuffix}`,
      brief: manifest.initialObjective,
      repositoryMode: 'create',
      branchMode: 'existing',
      githubOwner: owner,
      githubRepo: repository,
      defaultBranch: 'main',
      repositoryPrivate: true,
      repositoryDescription: 'ForgeMind autonomous reference-project qualification run.',
      aiProviderConnectionId: connection.id,
      autoCreatePullRequest: true,
      autoMergePullRequest: true,
      autoCompleteTask: true,
      allowSafeOperationsWithoutApproval: true,
      defaultTaskMode: 'full_auto'
    })
  });
  const state = {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    repository: `${owner}/${repository}`,
    repositoryUrl: `https://github.com/${owner}/${repository}.git`,
    startedAt: new Date().toISOString(),
    approvedExtensions: 0,
    workerRestartObserved: false,
    status: 'provisioned',
    events: []
  };
  await saveState(state);
  await request(`/api/projects/${project.id}/implementation-steps/generate`, {
    method: 'POST',
    body: JSON.stringify({ objective: manifest.initialObjective })
  });
  state.status = 'running';
  state.events.push({ at: new Date().toISOString(), event: 'cycle_started', cycle: 1 });
  await saveState(state);
  console.log(JSON.stringify(state, null, 2));
}

async function generate() {
  const state = await readState();
  const roadmap = await request(`/api/projects/${state.projectId}/implementation-steps/generate`, {
    method: 'POST',
    body: JSON.stringify({ objective: manifest.initialObjective })
  });
  state.status = 'running';
  state.events.push({ at: new Date().toISOString(), event: 'cycle_started', cycle: roadmap.cycles.at(-1)?.cycleNumber ?? 1 });
  await saveState(state);
  console.log(JSON.stringify(roadmapSummary(roadmap), null, 2));
}

function roadmapSummary(roadmap) {
  const cycles = [...roadmap.cycles].sort((left, right) => left.cycleNumber - right.cycleNumber);
  const steps = roadmap.steps;
  return {
    cycles: cycles.map((cycle) => ({
      number: cycle.cycleNumber,
      status: cycle.status,
      steps: steps.filter((step) => step.cycleId === cycle.id).map((step) => ({ title: step.title, status: step.status, taskId: step.taskId }))
    })),
    totalSteps: steps.length,
    completedSteps: steps.filter((step) => step.status === 'completed').length
  };
}

async function status() {
  const state = await readState();
  const roadmap = await request(`/api/projects/${state.projectId}/roadmap`);
  console.log(JSON.stringify({ state, roadmap: roadmapSummary(roadmap) }, null, 2));
}

async function monitor() {
  const state = await readState();
  let previous = '';
  let previousPendingApprovals = '';
  const deadline = Date.now() + Number(process.env.FORGEMIND_QUALIFICATION_TIMEOUT_HOURS ?? 10) * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const [roadmap, tasks, approvals] = await Promise.all([
      request(`/api/projects/${state.projectId}/roadmap`),
      request('/api/tasks'),
      request('/api/approvals')
    ]);
    const projectTasks = tasks.filter((task) => task.projectId === state.projectId);
    const projectApprovals = approvals.filter((approval) => projectTasks.some((task) => task.id === approval.taskId) && approval.status === 'pending');
    const terminalFailure = projectTasks.find((task) => task.status === 'failed' || task.status === 'cancelled');
    if (terminalFailure) throw new Error(`Qualification task failed: ${terminalFailure.title}: ${terminalFailure.errorMessage ?? terminalFailure.status}`);
    if (projectApprovals.length > 0) {
      const pendingSignature = projectApprovals.map((approval) => approval.id).sort().join(',');
      if (pendingSignature !== previousPendingApprovals) {
        console.log(`[${new Date().toISOString()}] Qualification is waiting for explicit approval: ${pendingSignature}`);
        previousPendingApprovals = pendingSignature;
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      continue;
    }
    previousPendingApprovals = '';

    const summary = roadmapSummary(roadmap);
    const serialized = JSON.stringify(summary);
    if (serialized !== previous) {
      console.log(`[${new Date().toISOString()}] ${summary.completedSteps}/${summary.totalSteps} steps completed; cycles ${summary.cycles.map((cycle) => `${cycle.number}:${cycle.status}`).join(', ')}`);
      previous = serialized;
    }
    const latest = [...roadmap.cycles].sort((left, right) => right.cycleNumber - left.cycleNumber)[0];
    if (latest?.status === 'awaiting_extension_approval') {
      if (latest.cycleNumber < manifest.expectedCycles) {
        const objective = manifest.extensions[latest.cycleNumber - 1];
        await request(`/api/projects/${state.projectId}/extension/decision`, {
          method: 'POST',
          body: JSON.stringify({ approved: true, cycleId: latest.id, objectiveOverride: objective })
        });
        state.approvedExtensions += 1;
        state.events.push({ at: new Date().toISOString(), event: 'cycle_started', cycle: latest.cycleNumber + 1 });
        await saveState(state);
        continue;
      }
      await request(`/api/projects/${state.projectId}/extension/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: false, cycleId: latest.id })
      });
      if (summary.totalSteps < manifest.minTasks || summary.totalSteps > manifest.maxTasks) {
        throw new Error(`Qualification produced ${summary.totalSteps} tasks; expected ${manifest.minTasks}-${manifest.maxTasks}.`);
      }
      if (!state.workerRestartObserved) {
        throw new Error('Worker restart recovery has not been verified. Run restart-snapshot before and restart-verify after restarting the worker.');
      }
      state.status = 'ready_for_hidden_tests';
      state.completedAt = new Date().toISOString();
      state.totalTasks = summary.totalSteps;
      await saveState(state);
      console.log('Roadmap qualification completed. Run the verify command.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error('Qualification monitor timed out.');
}

async function restartSnapshot() {
  const state = await readState();
  const roadmap = await request(`/api/projects/${state.projectId}/roadmap`);
  const runningStep = roadmap.steps.find((step) => step.status === 'running');
  if (!runningStep?.taskId) throw new Error('Take the restart snapshot while a roadmap task is running.');
  state.restartSnapshot = {
    at: new Date().toISOString(),
    runningStepId: runningStep.id,
    runningTaskId: runningStep.taskId,
    completedSteps: roadmap.steps
      .filter((step) => step.status === 'completed')
      .map((step) => ({ id: step.id, taskId: step.taskId }))
  };
  state.workerRestartObserved = false;
  await saveState(state);
  console.log(JSON.stringify(state.restartSnapshot, null, 2));
}

async function restartVerify() {
  const state = await readState();
  if (!state.restartSnapshot) throw new Error('Run restart-snapshot before restarting the worker.');
  state.workerRestartObserved = false;
  await saveState(state);
  const snapshotAt = new Date(state.restartSnapshot.at).getTime();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const [roadmap, task, taskLogs] = await Promise.all([
      request(`/api/projects/${state.projectId}/roadmap`),
      request(`/api/tasks/${state.restartSnapshot.runningTaskId}`),
      request(`/api/tasks/${state.restartSnapshot.runningTaskId}/logs`)
    ]);
    for (const completed of state.restartSnapshot.completedSteps) {
      const current = roadmap.steps.find((step) => step.id === completed.id);
      if (!current || current.status !== 'completed' || current.taskId !== completed.taskId) {
        throw new Error(`Completed step ${completed.id} was repeated or changed across the worker restart.`);
      }
    }
    const interrupted = roadmap.steps.find((step) => step.id === state.restartSnapshot.runningStepId);
    if (!interrupted || interrupted.taskId !== state.restartSnapshot.runningTaskId) {
      throw new Error('The interrupted roadmap step was replaced instead of resumed.');
    }
    const resumedActivity = taskLogs.find((event) =>
      new Date(event.createdAt).getTime() > snapshotAt
      && ['task_claimed', 'task_queue_job_recovered', 'task_activity', 'task_provider_activity', 'task_iteration_started', 'task_iteration'].includes(event.eventType)
    );
    if (resumedActivity || new Date(task.updatedAt).getTime() > snapshotAt) {
      state.workerRestartObserved = true;
      state.events.push({
        at: new Date().toISOString(),
        event: 'worker_restart_verified',
        taskId: interrupted.taskId,
        taskStatus: task.status,
        evidenceEventId: resumedActivity?.id
      });
      await saveState(state);
      console.log(JSON.stringify({
        workerRestartObserved: true,
        interruptedStepStatus: interrupted.status,
        taskStatus: task.status,
        evidenceEventType: resumedActivity?.eventType ?? 'task_updated'
      }, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error('The restarted worker did not resume or recover the interrupted task within five minutes.');
}

async function verify() {
  const state = await readState();
  const child = spawn(process.execPath, [path.resolve('qualification/reference-project/verify.mjs'), state.repositoryUrl], {
    stdio: 'inherit',
    env: process.env
  });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  if (exitCode !== 0) throw new Error(`Hidden qualification tests failed with exit code ${exitCode}.`);
  state.status = 'qualified';
  state.qualifiedAt = new Date().toISOString();
  await saveState(state);
}

const commands = { provision, generate, monitor, status, verify, 'restart-snapshot': restartSnapshot, 'restart-verify': restartVerify };
if (!commands[command]) throw new Error(`Unknown command "${command}". Use provision, generate, monitor, status, restart-snapshot, restart-verify or verify.`);
await commands[command]();
