import { describe, expect, it } from 'vitest';
import { parseAgentConfigYaml } from './index.js';

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
  reviewer_connection_id: reviewer-connection
  model_profile: balanced
limits:
  max_iterations: 7
  max_runtime_minutes: 60
  max_changed_files: 12
  max_diff_lines: 500
  max_repeated_error_count: 3
  max_budget_usd: 4
  soft_budget_threshold_percent: 70
  hard_budget_threshold_percent: 110
github:
  issue_label: ai-task
  branch_prefix: ai/
  pr_draft: true
`;

describe('agent config parser', () => {
  it('parses YAML and ignores legacy runtime limits', () => {
    const config = parseAgentConfigYaml(configYaml);
    expect(config.project.id).toBe('demo');
    expect(config.ai.primary_provider).toBe('codex');
    expect(config.ai.reviewer_connection_id).toBe('reviewer-connection');
    expect(config).not.toHaveProperty('limits');
  });

  it('ignores removed command, approval and sandbox sections from legacy configs', () => {
    const legacyConfig = parseAgentConfigYaml(configYaml.replace(
      'github:',
      `commands:\n  verify: npm run build\napproval:\n  required_for: [new_dependency]\nsandbox:\n  allow_network: false\ngithub:\n  require_ci_green: true`
    ));

    expect(legacyConfig).not.toHaveProperty('commands');
    expect(legacyConfig).not.toHaveProperty('approval');
    expect(legacyConfig).not.toHaveProperty('sandbox');
    expect(legacyConfig).not.toHaveProperty('limits');
    expect(legacyConfig.github).not.toHaveProperty('require_ci_green');
  });
});
