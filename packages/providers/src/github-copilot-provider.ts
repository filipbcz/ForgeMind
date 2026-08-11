import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CapabilityAuditInput,
  CapabilityAuditResult,
  CostEstimateInput,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  PlanInput,
  PlanResult,
  ReleaseAuditInput,
  ReleaseAuditResult,
  ReviewInput,
  ReviewResult,
  ProviderUsageMeasurement,
  ProviderActivityHandler
} from './provider.js';
import { normalizeValidationChecks } from './provider.js';
import { emitCapturedUsage } from './provider-usage.js';
import type { ProviderRuntimeConfig } from './index.js';
import type { ProviderModelOption } from './openai-provider.js';

type CopilotClientLike = {
  createSession(options: Record<string, unknown>): Promise<{
    sendAndWait(input: { prompt: string }): Promise<{ data?: { content?: string } } | undefined>;
    on(eventName: string, handler: (event: any) => void): void;
  }>;
  listModels(): Promise<Array<{ id: string; name?: string }>>;
  stop(): Promise<unknown>;
};

type CopilotUsageEvent = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  cost?: number;
};

export class GitHubCopilotProvider implements AIProvider {
  readonly kind: ProviderKind = 'github_copilot';

  private readonly model: string;
  private readonly baseDirectory: string;
  private readonly token?: string;

  constructor(config?: ProviderRuntimeConfig) {
    this.model = config?.model?.trim() || process.env.COPILOT_MODEL?.trim() || 'gpt-5.4';
    this.token = config?.apiKey;
    this.baseDirectory = join(tmpdir(), 'forgemind', 'copilot', randomUUID());
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    const messages = [
      'You are GitHub Copilot acting as a codebase planner inside ForgeMind.',
      'Return only valid JSON with summary, steps, acceptanceCriteria, implementationSteps, projectContract, architectureUpdate, and validationChecks.',
      'For ordinary task plans, implementationSteps must be an empty array and projectContract and architectureUpdate may be omitted.',
      'validationChecks must contain only executable command checks.',
      'Do not add any markdown, code fences, or extra commentary.',
      `Task title: ${input.title}`,
      `Task prompt:\n${input.prompt}`,
      input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
      input.previousValidationChecks?.length
        ? `Previous validation checks:\n${input.previousValidationChecks.map((check) => check.command).join('\n')}`
        : ''
    ].filter(Boolean).join('\n\n');
    const content = await this.requestText(messages, input.onActivity, 'plan');

    return {
      ...parseJsonContent<PlanResult>(content, {
        summary: `Copilot plan for ${input.title}`,
        steps: ['Review project context.', 'Propose a minimal change plan.', 'Validate the result.'],
        acceptanceCriteria: ['Plan is concise and actionable.', 'Validation commands are executable.'],
        validationChecks: []
      }),
      providerPrompt: messages,
      providerResponse: content
    };
  }

  async implement(input: ImplementInput): Promise<ImplementResult> {
    const messages = [
      'You are GitHub Copilot acting as a code editing assistant inside ForgeMind.',
      'Return only valid JSON with summary, changedFiles, diffStat, requestedApprovals, validationChecks, architectureUpdate, and optional fileUpdates.',
      'changedFiles should list files actually changed or created.',
      'fileUpdates should include exact file contents for each changed file when you can provide them.',
      'Do not add any markdown, code fences, or extra commentary.',
      `Attempt: ${input.attemptNumber ?? 1}`,
      `Task prompt:\n${input.prompt}`,
      `Plan:\n${input.plan.steps.join(' | ')}`,
      input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
      input.previousReviewBlockers?.length ? `Previous review blockers: ${input.previousReviewBlockers.join(' | ')}` : '',
      input.previousSafeImprovements?.length ? `Apply these safe improvements automatically: ${input.previousSafeImprovements.join(' | ')}` : ''
    ].filter(Boolean).join('\n\n');
    const content = await this.requestText(messages, input.onActivity, 'implement');

    const fallback: ImplementResult = {
      summary: `Copilot implementation summary for task ${input.taskId}.`,
      changedFiles: ['COPILOT_IMPLEMENTATION.md'],
      diffStat: { filesChanged: 1, insertions: Math.min(150, input.prompt.length), deletions: 0 },
      requestedApprovals: [],
      validationChecks: [],
      fileUpdates: [
        {
          path: 'COPILOT_IMPLEMENTATION.md',
          content: [
            `# Copilot Implementation for ${input.taskId}`,
            '',
            '## Prompt',
            input.prompt,
            '',
            '## Plan',
            ...input.plan.steps.map((step, index) => `${index + 1}. ${step}`)
          ].join('\n')
        }
      ]
    };

    const result = parseJsonContent<ImplementResult>(content, fallback);
    if (!Array.isArray(result.changedFiles) || result.changedFiles.length === 0) {
      result.changedFiles = fallback.changedFiles;
    }
    if (!result.diffStat) {
      result.diffStat = fallback.diffStat;
    }
    if (!Array.isArray(result.requestedApprovals)) {
      result.requestedApprovals = [];
    }
    result.validationChecks = normalizeValidationChecks(result.validationChecks);
    if (!Array.isArray(result.fileUpdates) || result.fileUpdates.length === 0) {
      result.fileUpdates = fallback.fileUpdates;
    }

    result.providerPrompt = messages;
    result.providerResponse = content;
    return result;
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const messages = [
      'You are GitHub Copilot acting as a code reviewer inside ForgeMind.',
      'Return only valid JSON with summary, blockers, safeImprovements, and riskyChanges.',
      'Do not add any markdown, code fences, or extra commentary.',
      `Task title: ${input.taskTitle}`,
      `Changed files: ${input.changedFiles.join(', ')}`,
      `Acceptance criteria:\n${input.acceptanceCriteria.join('\n')}`,
      `Validation command: ${input.validation.command}`,
      `Validation exit code: ${input.validation.exitCode}`,
      `Diff:\n${input.diff}`
    ].join('\n\n');
    const content = await this.requestText(messages, input.onActivity, 'review');

    return {
      ...parseJsonContent<ReviewResult>(content, {
        summary: `Copilot review of ${input.changedFiles.length} changed file(s).`,
        blockers: [],
        safeImprovements: ['Add targeted tests for changed files.'],
        riskyChanges: []
      }),
      providerPrompt: messages,
      providerResponse: content
    };
  }

  async auditCapability(_input: CapabilityAuditInput): Promise<CapabilityAuditResult> {
    throw new Error('GitHub Copilot capability audit is not supported. Configure a Codex or OpenAI provider for roadmap audits.');
  }

  async auditRelease(_input: ReleaseAuditInput): Promise<ReleaseAuditResult> {
    throw new Error('GitHub Copilot release audit is not supported. Configure a Codex or OpenAI provider for roadmap audits.');
  }

  async estimateCost(input: CostEstimateInput): Promise<CostEstimateResult> {
    const words = input.prompt.trim().split(/\s+/).filter(Boolean).length;
    const multiplier = input.repositorySizeHint === 'large' ? 4 : input.repositorySizeHint === 'medium' ? 2 : 1;
    const inputTokens = Math.max(200, words * 2 * multiplier);
    const outputTokens = 650 * multiplier;
    return {
      inputTokens,
      outputTokens,
      estimatedCostUsd: parseFloat((((inputTokens + outputTokens) / 1000) * 0.0025 * multiplier).toFixed(4))
    };
  }

  supportsLocalRepo(): boolean {
    return true;
  }

  supportsGitHubNativeFlow(): boolean {
    return true;
  }

  async listModels(): Promise<ProviderModelOption[]> {
    const client = await this.createClient();
    try {
      const models = await client.listModels();
      return models
        .filter((model) => Boolean(model.id))
        .map((model) => ({ id: model.id, name: model.name?.trim() || model.id }))
        .sort((left, right) => left.id.localeCompare(right.id));
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  private async requestText(prompt: string, onActivity: ProviderActivityHandler | undefined, operation: string): Promise<string> {
    const { client, session } = await this.createSession();
    try {
      let latestUsage: ProviderUsageMeasurement | undefined;
      session.on?.('assistant.usage', (event: CopilotUsageEvent) => {
        latestUsage = {
          provider: 'github_copilot',
          model: event.model ?? this.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedTokens: event.cacheReadTokens,
          totalTokens: event.totalTokens ?? ((event.inputTokens ?? 0) + (event.outputTokens ?? 0)),
          source: 'actual_breakdown',
          actualCostUsd: event.cost
        };
      });

      const response = await session.sendAndWait({ prompt });
      const content = response?.data?.content?.trim() ?? '';
      await emitCapturedUsage(onActivity, latestUsage);
      return content;
    } catch (error) {
      throw new Error(`GitHub Copilot ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  private async createSession(): Promise<{ client: CopilotClientLike; session: { sendAndWait(input: { prompt: string }): Promise<{ data?: { content?: string } } | undefined>; on?(eventName: string, handler: (event: any) => void): void } }> {
    const client = await this.createClient();
    const session = await client.createSession({
      sessionId: `forgemind-${randomUUID()}`,
      model: this.model,
      availableTools: []
    });

    return { client, session };
  }

  private async createClient(): Promise<CopilotClientLike> {
    const sdk = await import('@github/copilot-sdk');
    const CopilotClient = sdk.CopilotClient as unknown as new (options?: Record<string, unknown>) => CopilotClientLike;
    await mkdir(this.baseDirectory, { recursive: true });
    return new CopilotClient({
      mode: 'empty',
      baseDirectory: this.baseDirectory,
      gitHubToken: this.token,
      useLoggedInUser: !this.token,
      sessionIdleTimeoutSeconds: 900
    });
  }
}

function parseJsonContent<T>(content: string, fallback: T): T {
  try {
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(content.slice(jsonStart, jsonEnd + 1)) as T;
    }
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}
