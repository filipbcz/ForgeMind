import { describe, expect, it } from 'vitest';
import { parseAgentConfigYaml, toCoreLimits } from './index.js';

const configYaml = `
project:
  id: demo
  name: Demo
  repo: github.com/demo/demo
  default_branch: main
workflow:
  default_mode: safe
  create_issue: true
  create_branch: true
  create_draft_pr: true
  auto_push: true
  auto_merge: false
  allow_ai_auto_improvements: true
ai:
  primary_provider: codex
  reviewer_provider: codex
  model_profile: balanced
limits:
  max_iterations: 7
  max_runtime_minutes: 60
  max_changed_files: 12
  max_diff_lines: 500
  max_repeated_error_count: 3
  max_budget_usd: 1.5
  soft_budget_threshold_percent: 75
  hard_budget_threshold_percent: 100
commands:
  verify: npm run build
approval:
  required_for:
    - new_dependency
  auto_allowed:
    - docs_update
sandbox:
  allow_network: false
  allow_sudo: false
  writable_paths:
    - /workspace
  forbidden_paths:
    - /etc
github:
  issue_label: ai-task
  branch_prefix: ai/
  pr_draft: true
  require_ci_green: true
`;

describe('agent config parser', () => {
  it('parses YAML and converts limits to core shape', () => {
    const config = parseAgentConfigYaml(configYaml);
    expect(config.project.id).toBe('demo');
    expect(config.ai.primary_provider).toBe('codex');
    expect(toCoreLimits(config).maxIterations).toBe(7);
  });
});
