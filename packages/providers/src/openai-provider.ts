import type { ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CapabilityAuditInput,
  CapabilityAuditResult,
  CostEstimateInput,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  NormalizedProviderError,
  PlanInput,
  PlanResult,
  ProviderPreflightResult,
  ReleaseAuditInput,
  ReleaseAuditResult,
  RoadmapRepairInput,
  RoadmapRepairResult,
  ReviewInput,
  ReviewResult
} from './provider.js';
import { ProviderContractError, normalizeProviderError, normalizeProviderPreflight, normalizeValidationChecks, parseImplementResult, parsePlanResult, parseProviderJsonObject, parseReviewResult } from './provider.js';
import { emitCapturedUsage, normalizeTokenBreakdown } from './provider-usage.js';
import { buildReviewPrompt } from './review-prompt.js';
import { buildCapabilityAuditPrompt, buildReleaseAuditPrompt, normalizeAuditContentWithSingleRepair, normalizeCapabilityAuditResult, normalizeReleaseAuditResult } from './audit-prompt.js';
import type { ProviderRuntimeConfig } from './index.js';

const DEFAULT_OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export interface ProviderModelOption {
  id: string;
  name: string;
  isDefault?: boolean;
}

export async function listOpenAIModels(apiKey: string, apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? DEFAULT_OPENAI_API_URL): Promise<ProviderModelOption[]> {
  const url = buildOpenAIModelsUrl(apiBaseUrl);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw normalizeOpenAIHttpError(response, 'OpenAI model listing failed.');
  }

  const payload = await readProviderJson<{ data?: Array<{ id?: string; owned_by?: string }> }>(response, 'OpenAI model listing');
  return (payload.data ?? [])
    .filter((model): model is { id: string; owned_by?: string } => Boolean(model.id))
    .map((model) => ({ id: model.id, name: model.owned_by ? `${model.id} (${model.owned_by})` : model.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function serializeMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

export class OpenAIProvider implements AIProvider {
  readonly kind: ProviderKind = 'openai';

  protected readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly model: string;

  constructor(config?: ProviderRuntimeConfig) {
    const key = config?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY is required for OpenAI provider.');
    }
    this.apiKey = key;
    this.apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? DEFAULT_OPENAI_API_URL;
    this.model = config?.model?.trim() || (process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
  }

  async preflight(signal?: AbortSignal): Promise<ProviderPreflightResult> {
    return normalizeProviderPreflight(this.kind, async () => {
      const response = await fetch(buildOpenAIModelsUrl(this.apiBaseUrl), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal
      });
      if (!response.ok) {
        throw normalizeOpenAIHttpError(response, 'OpenAI preflight failed.');
      }
      await readProviderJson(response, 'OpenAI preflight');
    });
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    const isValidationRecovery = Boolean(input.validationFailure);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: isValidationRecovery
          ? 'Diagnose the supplied validation failure. Decide whether to replace only the invalid validation check, repair the implementation, or report a genuine blocker. A missing portable installable project tool or language package is not by itself a reason to weaken or replace an otherwise authoritative check: choose repair_implementation so the repository can declare the dependency and ForgeMind can install it in the persistent workspace environment. Replace a check only when the command or criterion itself is invalid. Return JSON with summary, empty steps, empty acceptanceCriteria, empty implementationSteps, validationChecks containing replacements only when action is replace_validation_check, and validationRecovery with action and rationale. Do not modify repository files. Respond only with JSON.'
          : 'You are an AI project planner. Provide a JSON object with summary, steps, acceptanceCriteria, validationChecks, implementationSteps, projectContract, contractDelta, and architectureUpdate. ' +
            'For ordinary task plans, implementationSteps must be an empty array and projectContract, contractDelta, and architectureUpdate must be omitted. For an initial project roadmap, include a full projectContract and set contractDelta to null. For an approved project extension, set projectContract to null and return a contractDelta against the supplied base contract, plus only implementationSteps required by that delta. Never silently omit an existing requirement: update, supersede, or remove it with an explicit rationale. Every new or replacement requirement must include briefReferences with short source phrases or section names from the brief. Include a compact architectureUpdate describing intended modules, boundaries, conventions, decisions, debt, and architecture validation commands. ' +
            'Every implementation step must include changeRationale, dependsOnStepTitles referencing only earlier steps, and validationFocus. Include regression validation for extensions and migration or compatibility validation when the delta declares those impacts. Architecture updates must include databaseSchemas. ' +
            'validationChecks must contain only executable command checks and classify each command as setup, build, database, api, browser, or smoke. Omit criteria that cannot be verified automatically. ' +
            'Commands must verify a criterion through their exit code and must not use shell redirection, fallback chains, or inspection-only git diff/status/log commands. ' +
            'Declare non-installable platform or licensed-runtime requirements in requiredCapabilities, for example ["windows", "unreal-engine-5.8"]. A check that consumes an artifact produced by a platform-specific check must repeat the producer requiredCapabilities so both checks are deferred together. Use an empty array for portable checks and never replace an authoritative platform check with weaker static inspection. ' +
            'Use { "kind": "command", "command": "...", "category": "build", "criterion": "...", "rationale": "...", "requiredCapabilities": [] }. Respond only with JSON.'
      },
      {
        role: 'user',
        content: [
          `Create a plan for the task titled "${input.title}" with the prompt:\n${input.prompt}`,
          input.validationFailure
            ? `Complete validation failure:\n${JSON.stringify(input.validationFailure, null, 2)}`
            : input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
          input.previousValidationChecks?.length
            ? `Previous validation checks:\n${input.previousValidationChecks.map((check) => check.command).join('\n')}`
            : '',
          isValidationRecovery
            ? 'Inspect the repository before deciding. Return replacement checks only for replace_validation_check; use repair_implementation when repository changes are required; use blocked only when no autonomous correction is possible.'
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
    const response = await this.requestChat(messages, input.signal);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    try {
      return {
        ...parsePlanResult(content, 'OpenAI plan'),
        providerPrompt: serializeMessages(messages),
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async repairRoadmap(input: RoadmapRepairInput): Promise<RoadmapRepairResult> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'Repair only the supplied invalid implementation roadmap. Return JSON containing implementationSteps only. Preserve valid steps and do not regenerate the brief, contract, architecture, or objective. Each step may contain at most 3 requirementIds, 3 deliverables, 5 acceptanceCriteria, and 5 inScope items; split oversized work while preserving complete requirement coverage.'
      },
      {
        role: 'user',
        content: [
          `Objective: ${input.objective}`,
          `Validation error: ${input.validationError}`,
          `Allowed requirement ids: ${input.allowedRequirementIds.join(', ')}`,
          `Completed step titles that must not be recreated: ${input.completedStepTitles.join(' | ') || 'none'}`,
          `Migration impacts: ${input.migrationImpacts.join(' | ') || 'none'}`,
          `Compatibility impacts: ${input.compatibilityImpacts.join(' | ') || 'none'}`,
          `Invalid roadmap JSON:\n${JSON.stringify(input.implementationSteps)}`
        ].join('\n\n')
      }
    ];
    const response = await this.requestChat(messages);
    await emitCapturedUsage(input.onActivity, response.usage);
    try {
      return {
        ...parseProviderJsonObject(response.content, 'OpenAI roadmap repair') as unknown as RoadmapRepairResult,
        providerPrompt: serializeMessages(messages),
        providerResponse: response.content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async implement(input: ImplementInput): Promise<ImplementResult> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an AI implementation assistant. Make only the repository changes required by the supplied task and correction context. Do not perform broad validation that ForgeMind will run after implementation. Set outcome to changes_made when repository changes are required. If the repository already satisfies every acceptance criterion, do not modify files: set outcome to already_satisfied, return empty changedFiles, a zero diffStat, non-empty evidenceFiles naming repository files that prove the criteria, and executable validationChecks that prove the criteria. After editing, propose the smallest authoritative validationChecks set that verifies the acceptance criteria against the resulting repository and classify every check as setup, build, database, api, browser, or smoke. Every check must declare requiredCapabilities; use an empty array unless it requires a non-installable platform or licensed runtime such as windows or unreal-engine-5.8. A check that consumes an artifact produced by a platform-specific check must repeat the producer requiredCapabilities so both checks are deferred together. Never replace an authoritative platform check with weaker static inspection. Provide a JSON object with outcome, summary, changedFiles, evidenceFiles, diffStat, requestedApprovals, validationChecks, architectureUpdate, and optional fileUpdates [{ path, content }]. architectureUpdate must be a compact delta containing only architectural facts introduced or changed by this attempt, including databaseSchemas; use empty arrays when nothing changed. Respond only with JSON.'
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
    const response = await this.requestChat(messages, input.signal);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    try {
      const result = parseImplementResult(content, 'OpenAI implementation', true);
      if (result.outcome === 'already_satisfied') {
        result.changedFiles = [];
        result.diffStat = { filesChanged: 0, insertions: 0, deletions: 0 };
        result.fileUpdates = [];
      }
      result.validationChecks = normalizeValidationChecks(result.validationChecks);
      result.providerPrompt = serializeMessages(messages);
      result.providerResponse = content;

      return result;
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const reviewPrompt = buildReviewPrompt(input);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an AI code reviewer. Follow the review packet constraints and return JSON with summary, blockers, safeImprovements, riskyChanges, and criterionResults when requested.'
      },
      {
        role: 'user',
        content: reviewPrompt
      }
    ];
    const response = await this.requestChat(messages, input.signal);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    try {
      return {
        ...parseReviewResult(content, 'OpenAI review'),
        providerPrompt: serializeMessages(messages),
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async auditCapability(input: CapabilityAuditInput): Promise<CapabilityAuditResult> {
    if (!input.repositoryContext?.trim()) {
      throw new Error('OpenAI capability audit requires a targeted repository packet.');
    }
    const providerPrompt = buildCapabilityAuditPrompt(input);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an independent capability auditor. Use only the supplied contract, execution evidence, and targeted repository packet. Return strict JSON.'
      },
      { role: 'user', content: providerPrompt }
    ];
    const response = await this.requestChat(messages);
    await emitCapturedUsage(input.onActivity, response.usage);
    const normalized = await normalizeAuditContentWithSingleRepair<CapabilityAuditResult>({
      auditKind: 'capability',
      content: response.content,
      expectedCriteria: input.requirement.acceptanceCriteria,
      allowedRequirementIds: [input.requirement.id],
      normalize: (value) => normalizeCapabilityAuditResult(input, value),
      repair: async (repairPrompt) => {
        const repairResponse = await this.requestChat([
          { role: 'system', content: 'Repair only the supplied audit JSON. Do not inspect or reassess the repository. Return strict JSON.' },
          { role: 'user', content: repairPrompt }
        ]);
        await emitCapturedUsage(input.onActivity, repairResponse.usage);
        return repairResponse.content;
      }
    });
    return {
      ...normalized.result,
      providerPrompt: normalized.repairPrompt
        ? `${serializeMessages(messages)}\n\n[repair]\n${normalized.repairPrompt}`
        : serializeMessages(messages),
      providerResponse: normalized.response
    };
  }

  async auditRelease(input: ReleaseAuditInput): Promise<ReleaseAuditResult> {
    if (!input.repositoryContext?.trim()) throw new Error('OpenAI release audit requires a targeted repository packet.');
    const providerPrompt = buildReleaseAuditPrompt(input);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: 'You are an independent release auditor. Use the contract and targeted repository packet. Return strict JSON.' },
      { role: 'user', content: providerPrompt }
    ];
    const response = await this.requestChat(messages);
    await emitCapturedUsage(input.onActivity, response.usage);
    const normalized = await normalizeAuditContentWithSingleRepair<ReleaseAuditResult>({
      auditKind: 'release',
      content: response.content,
      expectedCriteria: [...input.contract.invariants, ...input.contract.releaseCriteria],
      allowedRequirementIds: input.contract.requirements.map((requirement) => requirement.id),
      normalize: (value) => normalizeReleaseAuditResult(input, value),
      repair: async (repairPrompt) => {
        const repairResponse = await this.requestChat([
          { role: 'system', content: 'Repair only the supplied release-audit JSON. Do not inspect or reassess the repository. Return strict JSON.' },
          { role: 'user', content: repairPrompt }
        ]);
        await emitCapturedUsage(input.onActivity, repairResponse.usage);
        return repairResponse.content;
      }
    });
    return {
      ...normalized.result,
      providerPrompt: normalized.repairPrompt
        ? `${serializeMessages(messages)}\n\n[repair]\n${normalized.repairPrompt}`
        : serializeMessages(messages),
      providerResponse: normalized.response
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
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    signal?: AbortSignal
  ): Promise<{ content: string; usage?: import('./provider.js').ProviderUsageMeasurement }> {
    try {
      const response = await fetch(this.apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.2,
          max_tokens: 800
        })
      });

      if (!response.ok) {
        throw normalizeOpenAIHttpError(response, 'OpenAI request failed.');
      }

      const data = await readProviderJson<{
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      }>(response, 'OpenAI request');
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (!content) {
        throw new ProviderContractError('OpenAI request returned an empty response.');
      }
      return {
        content,
        usage: normalizeTokenBreakdown({
          provider: 'openai',
          model: this.model,
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
          totalTokens: data.usage?.total_tokens
        })
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }
}

function buildOpenAIModelsUrl(apiBaseUrl: string): URL {
  const url = new URL(apiBaseUrl);
  if (/\/(?:chat\/completions|responses)\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses)\/?$/, '/models');
  } else if (!/\/models\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  }
  return url;
}

function normalizeOpenAIHttpError(response: Response, message: string): NormalizedProviderError {
  return normalizeProviderError('openai', {
    status: response.status,
    message: `${message} HTTP ${response.status}.`
  });
}

async function readProviderJson<T>(response: Response, operation: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new ProviderContractError(`${operation} returned invalid JSON.`);
  }
}
