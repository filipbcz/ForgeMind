import { PrismaClient } from '@prisma/client';
import { ensureDatabaseUrl } from '../src/env.js';

ensureDatabaseUrl();
const prisma = new PrismaClient();

const configYaml = `project:
  id: "forgemind-default"
  name: "ForgeMind Default"
  repo: "github.com/owner/repository"
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
  primary_provider: "codex"
  reviewer_provider: "codex"
  model_profile: "balanced"
limits:
  max_iterations: 10
  max_runtime_minutes: 600
  max_changed_files: 20
  max_diff_lines: 2000
  max_repeated_error_count: 3
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
  await prisma.user.upsert({
    where: { id: 'user_local_owner' },
    update: {},
    create: {
      id: 'user_local_owner',
      email: 'owner@forgemind.local',
      name: 'Local Owner',
      role: 'owner'
    }
  });
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
