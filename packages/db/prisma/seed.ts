import { PrismaClient } from '@prisma/client';
import { ensureDatabaseUrl } from '../src/env.js';

ensureDatabaseUrl();
const prisma = new PrismaClient();

const configYaml = `project:
  id: "demo-static-gallery"
  name: "Demo Static Gallery"
  repo: "github.com/demo/demo-static-gallery"
  default_branch: "main"
  type: "frontend-static"
  runtime: "node"
workflow:
  default_mode: "safe"
  create_issue: true
  create_branch: true
  create_draft_pr: true
  auto_push: true
  auto_merge: false
  allow_ai_auto_improvements: true
ai:
  primary_provider: "mock"
  reviewer_provider: "mock"
  model_profile: "balanced"
limits:
  max_iterations: 10
  max_runtime_minutes: 90
  max_changed_files: 20
  max_diff_lines: 2000
  max_repeated_error_count: 3
  max_budget_usd: 2.00
  soft_budget_threshold_percent: 75
  hard_budget_threshold_percent: 100
commands:
  verify: "node --version"
approval:
  required_for:
    - new_dependency
  auto_allowed:
    - docs_update
sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths:
    - "/workspace"
  forbidden_paths:
    - "/etc"
    - "/root"
github:
  issue_label: "ai-task"
  branch_prefix: "ai/"
  pr_draft: true
  require_ci_green: true
`;

async function main() {
  const user = await prisma.user.upsert({
    where: { id: 'user_local_owner' },
    update: {},
    create: {
      id: 'user_local_owner',
      email: 'owner@forgemind.local',
      name: 'Local Owner',
      role: 'owner'
    }
  });

  const project = await prisma.project.upsert({
    where: { slug: 'demo-static-gallery' },
    update: {
      configYaml
    },
    create: {
      id: 'project_demo_gallery',
      name: 'Demo Static Gallery',
      slug: 'demo-static-gallery',
      githubOwner: 'demo',
      githubRepo: 'demo-static-gallery',
      defaultBranch: 'main',
      configYaml
    }
  });

  const existingTask = await prisma.task.findFirst({
    where: {
      projectId: project.id,
      title: 'Galerie podle dne'
    }
  });

  if (!existingTask) {
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        createdByUserId: user.id,
        title: 'Galerie podle dne',
        prompt: 'Seskupit statickou galerii podle dne, pridat fullscreen nahled a sipky.',
        mode: 'safe',
        status: 'draft',
        maxIterations: 10,
        maxBudgetUsd: 2
      }
    });

    await prisma.auditLog.create({
      data: {
        actorType: 'system',
        eventType: 'seed_task_created',
        projectId: project.id,
        taskId: task.id,
        payload: { title: task.title }
      }
    });
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
