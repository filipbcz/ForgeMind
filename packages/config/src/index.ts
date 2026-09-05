import { parse } from 'yaml';
import { z } from 'zod';

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
    allow_ai_auto_improvements: z.boolean().default(true),
    implementation_owner: z.enum(['linux', 'windows']).default('linux'),
    windows_authoring_capabilities: z.array(z.string().min(1)).default(['windows', 'windows-authoring']),
    windows_authoring_requires_unreal_assets: z.boolean().default(true)
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
  resources: z.object({
    min_free_space_mb: z.number().int().nonnegative().default(0),
    retention_days: z.number().int().nonnegative().default(14)
  }).default({}),
  github: z.object({
    issue_label: z.string().default('ai-task'),
    branch_prefix: z.string().default('ai/'),
    pr_draft: z.boolean().default(true)
  })
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export function parseAgentConfigYaml(source: string): AgentConfig {
  return agentConfigSchema.parse(parse(source));
}
