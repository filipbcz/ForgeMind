import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_LIMITS } from '@forgemind/core';

export const agentConfigSchema = z.object({
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    repo: z.string().min(1),
    default_branch: z.string().min(1).default('main'),
    type: z.string().default('unknown'),
    runtime: z.string().default('node')
  }),
  workflow: z.object({
    default_mode: z.enum(['safe', 'auto', 'full_auto']).default('safe'),
    create_issue: z.boolean().default(true),
    create_branch: z.boolean().default(true),
    create_draft_pr: z.boolean().default(true),
    auto_push: z.boolean().default(true),
    auto_merge: z.boolean().default(false),
    allow_ai_auto_improvements: z.boolean().default(true)
  }),
  ai: z.object({
    primary_provider: z.enum(['codex', 'github_copilot', 'openai']).default('codex'),
    fallback_provider: z.enum(['codex', 'github_copilot', 'openai']).optional(),
    primary_connection_id: z.string().min(1).optional(),
    fallback_connection_id: z.string().min(1).optional(),
    reviewer_provider: z.enum(['codex', 'github_copilot', 'openai']).default('codex'),
    reviewer_connection_id: z.string().min(1).optional(),
    model_profile: z.enum(['fast', 'balanced', 'deep']).default('balanced')
  }),
  limits: z.object({
    max_iterations: z.number().int().positive().default(DEFAULT_LIMITS.maxIterations),
    max_runtime_minutes: z.number().int().positive().default(DEFAULT_LIMITS.maxRuntimeMinutes),
    max_changed_files: z.number().int().positive().default(DEFAULT_LIMITS.maxChangedFiles),
    max_diff_lines: z.number().int().positive().default(DEFAULT_LIMITS.maxDiffLines),
    max_repeated_error_count: z.number().int().positive().default(DEFAULT_LIMITS.maxRepeatedErrorCount),
    max_budget_usd: z.number().positive().optional(),
    soft_budget_threshold_percent: z.number().positive().max(100).optional(),
    hard_budget_threshold_percent: z.number().positive().optional()
  }).refine(
    (limits) =>
      limits.soft_budget_threshold_percent === undefined
      || limits.hard_budget_threshold_percent === undefined
      || limits.hard_budget_threshold_percent >= limits.soft_budget_threshold_percent,
    {
      message: 'hard_budget_threshold_percent must be greater than or equal to soft_budget_threshold_percent',
      path: ['hard_budget_threshold_percent']
    }
  ),
  commands: z.object({
    install: z.string().optional(),
    lint: z.string().optional(),
    build: z.string().optional(),
    test_unit: z.string().optional(),
    test_e2e: z.string().optional(),
    verify: z.string().optional()
  }),
  approval: z.object({
    required_for: z.array(z.string()).default([]),
    auto_allowed: z.array(z.string()).default([])
  }),
  sandbox: z.object({
    allow_network: z.boolean().default(false),
    allow_sudo: z.boolean().default(false),
    writable_paths: z.array(z.string()).default(['/workspace']),
    forbidden_paths: z.array(z.string()).default(['/etc', '/root', '/home/*/.ssh', '/var/run/docker.sock'])
  }),
  resources: z.object({
    cpu_limit_seconds: z.number().int().positive().optional(),
    memory_limit_mb: z.number().int().positive().optional(),
    disk_limit_mb: z.number().int().positive().optional(),
    min_free_space_mb: z.number().int().nonnegative().default(0),
    retention_days: z.number().int().nonnegative().default(14)
  }).default({}),
  github: z.object({
    issue_label: z.string().default('ai-task'),
    branch_prefix: z.string().default('ai/'),
    pr_draft: z.boolean().default(true),
    require_ci_green: z.boolean().default(true)
  })
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function parseAgentConfigYaml(source: string): AgentConfig {
  return agentConfigSchema.parse(parse(source));
}

export function toCoreLimits(config: AgentConfig) {
  return {
    maxIterations: config.limits.max_iterations,
    maxRuntimeMinutes: config.limits.max_runtime_minutes,
    maxChangedFiles: config.limits.max_changed_files,
    maxDiffLines: config.limits.max_diff_lines,
    maxRepeatedErrorCount: config.limits.max_repeated_error_count,
    maxBudgetUsd: config.limits.max_budget_usd,
    softBudgetThresholdPercent: config.limits.soft_budget_threshold_percent,
    hardBudgetThresholdPercent: config.limits.hard_budget_threshold_percent
  };
}
