import type { ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CostEstimateInput,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  PlanInput,
  PlanResult,
  ReviewInput,
  ReviewResult
} from './provider.js';
import { emitCapturedUsage, normalizeTokenBreakdown } from './provider-usage.js';
import { buildReviewPrompt } from './review-prompt.js';

const DEFAULT_OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

function normalizeFileUpdates(result: ImplementResult, fallback: ImplementResult): ImplementResult['fileUpdates'] {
  if (Array.isArray(result.fileUpdates) && result.fileUpdates.length > 0) {
    return result.fileUpdates
      .filter((item): item is { path: string; content: string } => typeof item?.path === 'string' && typeof item?.content === 'string')
      .map((item) => ({ path: item.path, content: item.content }));
  }

  if (Array.isArray(result.changedFiles) && result.changedFiles.length > 0) {
    return (result.changedFiles as unknown[])
      .map((item) => {
        if (typeof item === 'string') {
          return {
            path: item,
            content: fallback.fileUpdates?.find((file) => file.path === item)?.content ?? `# Generated file\n\nPlaceholder content for ${item}.`
          };
        }

        if (
          item &&
          typeof item === 'object' &&
          'path' in item &&
          'content' in item &&
          typeof item.path === 'string' &&
          typeof item.content === 'string'
        ) {
          return {
            path: item.path,
            content: item.content
          };
        }

        return undefined;
      })
      .filter((item): item is { path: string; content: string } => Boolean(item));
  }

  return fallback.fileUpdates;
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

function summarizeDiffStats(summary: string): { filesChanged: number; insertions: number; deletions: number } {
  return {
    filesChanged: 1,
    insertions: Math.min(150, summary.length),
    deletions: 0
  };
}

function serializeMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

export class OpenAIProvider implements AIProvider {
  readonly kind: ProviderKind = 'openai';

  protected readonly apiKey: string;

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY is required for OpenAI provider.');
    }
    this.apiKey = key;
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: input.previousValidationError
          ? 'Revise only the supplied failed validation check. Return JSON with a short summary, empty steps and implementationSteps arrays, the supplied acceptanceCriteria, and replacement validationChecks for that failed check only. Do not repeat successful or unrelated checks and do not propose implementation work. Respond only with JSON.'
          : 'You are an AI project planner. Provide a JSON object with summary, steps, acceptanceCriteria, validationChecks, and implementationSteps. ' +
            'For ordinary task plans, implementationSteps must be an empty array. When the request asks for a project roadmap, it must contain objects with title, description, acceptanceCriteria, inScope, and outOfScope. ' +
            'validationChecks must be an array of executable checks or manual checks. ' +
            'Commands must verify a criterion through their exit code and must not use shell redirection or fallback chains. Use manual checks for git diff/status/log inspection. ' +
            'Use { "kind": "command", "command": "...", "criterion": "...", "rationale": "..." } for commands and ' +
            '{ "kind": "manual", "instructions": "...", "criterion": "...", "rationale": "..." } for non-executable criteria. Respond only with JSON.'
      },
      {
        role: 'user',
        content: [
          `Create a plan for the task titled "${input.title}" with the prompt:\n${input.prompt}`,
          input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
          input.previousValidationChecks?.length
            ? `Previous validation checks:\n${input.previousValidationChecks.map((check) => check.kind === 'command' ? check.command : check.instructions).join('\n')}`
            : '',
          input.previousValidationError
            ? 'Return only corrected replacement check(s) for the supplied failed check. Do not repeat any other validation checks.'
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
    const response = await this.requestChat(messages);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    return {
      ...parseJsonContent<PlanResult>(content, {
        summary: `Plan for ${input.title}`,
        steps: ['Review project context.', 'Create change plan.', 'Validate with configured workflow.'],
        acceptanceCriteria: ['Task stays within configured limits.', 'Validation command is captured.', 'Draft PR is prepared.'],
        validationChecks: []
      }),
      providerPrompt: serializeMessages(messages),
      providerResponse: content
    };
  }

  async implement(input: ImplementInput): Promise<ImplementResult> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an AI implementation assistant. Make only the repository changes required by the supplied task and correction context. Do not perform broad validation that ForgeMind will run after implementation. Provide a JSON object with summary, changedFiles, diffStat, requestedApprovals, and optional fileUpdates [{ path, content }]. Respond only with JSON.'
      },
      {
        role: 'user',
        content: [
          `Implement the following task.`,
          `Attempt: ${input.attemptNumber ?? 1}`,
          `Prompt: ${input.prompt}`,
          `Plan: ${input.plan.steps.join(' | ')}`,
          input.attemptNumber && input.attemptNumber > 1 ? 'Preserve completed work and apply only the supplied correction.' : '',
          input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
          input.previousReviewBlockers?.length ? `Previous review blockers: ${input.previousReviewBlockers.join(' | ')}` : '',
          input.previousSafeImprovements?.length ? `Apply these safe improvements automatically: ${input.previousSafeImprovements.join(' | ')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ];
    const response = await this.requestChat(messages);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    const fallback: ImplementResult = {
      summary: `OpenAI implementation summary for task ${input.taskId}.`,
      changedFiles: ['OPENAI_IMPLEMENTATION.md'],
      diffStat: summarizeDiffStats(input.prompt),
      requestedApprovals: [],
      fileUpdates: [
        {
          path: 'OPENAI_IMPLEMENTATION.md',
          content: [
            `# Implementation for ${input.taskId}`,
            '',
            `## Prompt`,
            input.prompt,
            '',
            '## Plan',
            ...input.plan.steps.map((step, index) => `${index + 1}. ${step}`)
          ].join('\n')
        }
      ]
    };

    const result = parseJsonContent<ImplementResult>(content, fallback);
    if (!result.changedFiles || !Array.isArray(result.changedFiles) || result.changedFiles.length === 0) {
      result.changedFiles = ['OPENAI_IMPLEMENTATION.md'];
    }
    result.fileUpdates = normalizeFileUpdates(result, fallback);
    if (!result.diffStat) {
      result.diffStat = summarizeDiffStats(result.summary);
    }
    if (!Array.isArray(result.requestedApprovals)) {
      result.requestedApprovals = [];
    }
    result.providerPrompt = serializeMessages(messages);
    result.providerResponse = content;

    return result;
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const reviewPrompt = buildReviewPrompt(input);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an AI code reviewer. Follow the review packet constraints and return JSON with summary, blockers, safeImprovements, and riskyChanges.'
      },
      {
        role: 'user',
        content: reviewPrompt
      }
    ];
    const response = await this.requestChat(messages);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    return {
      ...parseJsonContent<ReviewResult>(content, {
        summary: `OpenAI review of ${input.changedFiles.length} changed file(s).`,
        blockers: [],
        safeImprovements: ['Add targeted tests to the changed files.'],
        riskyChanges: []
      }),
      providerPrompt: serializeMessages(messages),
      providerResponse: content
    };
  }

  async estimateCost(input: CostEstimateInput): Promise<CostEstimateResult> {
    const words = input.prompt.trim().split(/\s+/).filter(Boolean).length;
    const multiplier = input.repositorySizeHint === 'large' ? 4 : input.repositorySizeHint === 'medium' ? 2 : 1;
    const inputTokens = Math.max(200, words * 2 * multiplier);
    const outputTokens = 600 * multiplier;
    return {
      inputTokens,
      outputTokens,
      estimatedCostUsd: parseFloat(((inputTokens + outputTokens) / 1000 * 0.002 * multiplier).toFixed(4))
    };
  }

  supportsLocalRepo(): boolean {
    return true;
  }

  supportsGitHubNativeFlow(): boolean {
    return false;
  }

  protected async requestChat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  ): Promise<{ content: string; usage?: import('./provider.js').ProviderUsageMeasurement }> {
    const response = await fetch(process.env.OPENAI_API_BASE_URL ?? DEFAULT_OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed with ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    return {
      content: data.choices?.[0]?.message?.content?.trim() ?? '',
      usage: normalizeTokenBreakdown({
        provider: 'openai',
        model: process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
        totalTokens: data.usage?.total_tokens
      })
    };
  }
}
