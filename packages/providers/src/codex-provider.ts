import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { ProviderKind } from '@forgemind/core';
import { createWorkspaceEnvironment } from '@forgemind/shared';
import type {
  AIProvider,
  CapabilityAuditInput,
  CapabilityAuditResult,
  CostEstimateInput,
  CostEstimateResult,
  ChatInput,
  ChatResult,
  ImplementInput,
  ImplementResult,
  PlanInput,
  PlanResult,
  ProviderPreflightResult,
  ReleaseAuditInput,
  ReleaseAuditResult,
  RoadmapQualityReviewInput,
  RoadmapRepairInput,
  RoadmapRepairResult,
  ProviderActivityHandler,
  ProviderSessionContext,
  ProviderUsageMeasurement,
  ReviewInput,
  ReviewResult,
  ValidationImpactInput,
  ValidationImpactResult
} from './provider.js';
import { ProviderContractError, normalizeProviderError, normalizeProviderPreflight, normalizeValidationChecks, parseChatResult, parseImplementResult, parsePlanResult, parseProviderJsonObject, parseReviewResult, parseValidationImpactResult } from './provider.js';
import { emitCapturedUsage, normalizeTokenBreakdown } from './provider-usage.js';
import { buildReviewPrompt } from './review-prompt.js';
import { buildRoadmapQualityReviewPrompt, compactRoadmapContract } from './roadmap-review-prompt.js';
import { buildCapabilityAuditPrompt, buildReleaseAuditPrompt, normalizeAuditContentWithSingleRepair, normalizeCapabilityAuditResult, normalizeReleaseAuditResult } from './audit-prompt.js';
import type { ProviderRuntimeConfig } from './index.js';
import { buildRepositoryChatPrompt } from './chat-prompt.js';
import type { ProviderModelOption } from './openai-provider.js';

const DEFAULT_CODEX_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const execFileAsync = promisify(execFile);
export function buildCodexReviewSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'summary', 'blockers', 'criterionResults'],
    properties: {
      verdict: { type: 'string', enum: ['satisfied', 'not_satisfied'] },
      summary: { type: 'string' },
      blockers: { type: 'array', items: { type: 'string' } },
      criterionResults: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion', 'status', 'evidence'],
          properties: {
            criterion: { type: 'string' },
            status: { type: 'string', enum: ['satisfied', 'not_satisfied', 'insufficient_evidence', 'deferred'] },
            evidence: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  };
}

interface CodexAppServerModel {
  id?: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

export async function listCodexModels(input: {
  codexHome: string;
  binary?: string;
  timeoutMs?: number;
}): Promise<ProviderModelOption[]> {
  const child = spawn(input.binary ?? resolveCodexBinary(), ['app-server'], {
    cwd: input.codexHome,
    env: { ...createWorkspaceEnvironment(), CODEX_HOME: input.codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = createInterface({ input: child.stdout! });
  let stderr = '';
  let settled = false;

  return await new Promise<ProviderModelOption[]>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Codex model listing timed out.')), input.timeoutMs ?? 20_000);

    const finish = (error?: Error, models?: ProviderModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };

    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendCappedOutput(stderr, chunk.toString('utf8'), 8_000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled) {
        finish(new Error(stripAnsi(stderr).trim() || `Codex app-server exited with code ${code}.`));
      }
    });
    lines.on('line', (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(new Error(message.error.message ?? 'Codex app-server initialization failed.'));
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } });
        return;
      }

      if (message.id === 2) {
        if (message.error) {
          finish(new Error(message.error.message ?? 'Codex model listing failed.'));
          return;
        }
        const result = message.result as { data?: CodexAppServerModel[] } | undefined;
        finish(undefined, normalizeCodexModels(result?.data ?? []));
      }
    });

    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'forgemind', title: 'ForgeMind', version: '0.1.0' }
      }
    });
  });
}

export function normalizeCodexModels(models: CodexAppServerModel[]): ProviderModelOption[] {
  return models
    .filter((model) => !model.hidden && Boolean(model.model ?? model.id))
    .map((model) => ({
      id: (model.model ?? model.id)!,
      name: model.displayName?.trim() || (model.model ?? model.id)!,
      isDefault: model.isDefault === true
    }))
    .filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index)
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
}

function validationChecksJsonSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'command', 'shell', 'target', 'requiredCapabilities', 'continueOnFailure', 'category', 'criterion', 'rationale', 'timeoutMinutes', 'windowsAdapter'],
      properties: {
        kind: { type: 'string', enum: ['command'] },
        command: { type: 'string' },
        shell: { type: 'string', enum: ['system', 'powershell', 'cmd', 'bash', 'sh'] },
        target: { type: 'string', enum: ['local', 'windows'] },
        requiredCapabilities: { type: 'array', items: { type: 'string' } },
        continueOnFailure: { type: 'boolean' },
        category: { type: 'string', enum: ['setup', 'build', 'database', 'api', 'browser', 'smoke'] },
        criterion: { type: ['string', 'null'] },
        rationale: { type: ['string', 'null'] },
        timeoutMinutes: { type: 'integer', minimum: 1, maximum: 600 },
        windowsAdapter: {
          anyOf: [
            { type: 'null' },
            { type: 'object', additionalProperties: false,
              required: ['kind', 'executablePath', 'inputRelativePath', 'artifactRelativePath', 'minimumFreeSpaceBytes', 'maxConcurrentProcesses'],
              properties: { kind: { const: 'fixture-validation' }, executablePath: { type: 'string' }, inputRelativePath: { type: 'string' }, artifactRelativePath: { type: 'string' }, minimumFreeSpaceBytes: { type: 'integer', minimum: 0 }, maxConcurrentProcesses: { type: 'integer', minimum: 1 } } },
            { type: 'object', additionalProperties: false,
              required: ['kind', 'profileId', 'tool', 'executablePath', 'workingDirectoryRelativePath', 'args', 'size', 'minimumLargeJobFreeSpaceBytes'],
              properties: { kind: { const: 'unreal-validation' }, profileId: { type: 'string' }, tool: { enum: ['unreal-editor-cmd', 'build-bat', 'automation-tool', 'project-script'] }, executablePath: { type: 'string' }, workingDirectoryRelativePath: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, size: { enum: ['standard', 'large'] }, minimumLargeJobFreeSpaceBytes: { type: 'integer', minimum: 0 } } }
          ]
        }
      }
    }
  };
}

function projectContractJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'summary', 'invariants', 'prohibitedSubstitutes', 'requirements', 'releaseCriteria'],
    properties: {
      version: { type: 'number' },
      summary: { type: 'string' },
      invariants: { type: 'array', items: { type: 'string' } },
      prohibitedSubstitutes: { type: 'array', items: { type: 'string' } },
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'description', 'acceptanceCriteria', 'briefReferences'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            briefReferences: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      releaseCriteria: { type: 'array', items: { type: 'string' } }
    }
  };
}

function projectContractRequirementDraftJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'title', 'description', 'acceptanceCriteria', 'briefReferences'],
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' } },
      briefReferences: { type: 'array', items: { type: 'string' } }
    }
  };
}

function projectContractCollectionDeltaJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['add', 'remove'],
    properties: {
      add: { type: 'array', items: { type: 'string' } },
      remove: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['value', 'rationale'],
          properties: {
            value: { type: 'string' },
            rationale: { type: 'string' }
          }
        }
      }
    }
  };
}

function projectContractDeltaJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'baseVersion',
      'summary',
      'addRequirements',
      'updateRequirements',
      'supersedeRequirements',
      'removeRequirements',
      'invariantChanges',
      'prohibitedSubstituteChanges',
      'releaseCriteriaChanges',
      'migrationImpacts',
      'compatibilityImpacts'
    ],
    properties: {
      baseVersion: { type: 'number' },
      summary: { type: ['string', 'null'] },
      addRequirements: { type: 'array', items: projectContractRequirementDraftJsonSchema() },
      updateRequirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'description', 'acceptanceCriteria', 'briefReferences', 'rationale'],
          properties: {
            id: { type: 'string' },
            title: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            acceptanceCriteria: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
            briefReferences: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
            rationale: { type: 'string' }
          }
        }
      },
      supersedeRequirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'replacement', 'rationale'],
          properties: {
            id: { type: 'string' },
            replacement: projectContractRequirementDraftJsonSchema(),
            rationale: { type: 'string' }
          }
        }
      },
      removeRequirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'rationale'],
          properties: { id: { type: 'string' }, rationale: { type: 'string' } }
        }
      },
      invariantChanges: projectContractCollectionDeltaJsonSchema(),
      prohibitedSubstituteChanges: projectContractCollectionDeltaJsonSchema(),
      releaseCriteriaChanges: projectContractCollectionDeltaJsonSchema(),
      migrationImpacts: { type: 'array', items: { type: 'string' } },
      compatibilityImpacts: { type: 'array', items: { type: 'string' } }
    }
  };
}

function architectureUpdateJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'modules', 'databaseSchemas', 'decisions', 'conventions', 'dependencyRules', 'knownDebt', 'resolvedDebt'],
    properties: {
      summary: { type: ['string', 'null'] },
      modules: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'responsibility', 'paths', 'publicInterfaces', 'dependencies'],
          properties: {
            name: { type: 'string' },
            responsibility: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            publicInterfaces: { type: 'array', items: { type: 'string' } },
            dependencies: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      databaseSchemas: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'technology', 'paths', 'ownedByModule', 'migrationPaths'],
          properties: {
            name: { type: 'string' },
            technology: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            ownedByModule: { type: 'string' },
            migrationPaths: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['summary', 'rationale'],
          properties: { summary: { type: 'string' }, rationale: { type: 'string' } }
        }
      },
      conventions: { type: 'array', items: { type: 'string' } },
      dependencyRules: { type: 'array', items: { type: 'string' } },
      knownDebt: { type: 'array', items: { type: 'string' } },
      resolvedDebt: { type: 'array', items: { type: 'string' } },
    }
  };
}

function implementationStepsJsonSchema(): Record<string, unknown> {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title', 'description', 'acceptanceCriteria', 'inScope', 'outOfScope',
        'requirementIds', 'deliverables', 'changeRationale', 'dependsOnStepTitles', 'validationFocus'
      ],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        inScope: { type: 'array', items: { type: 'string' } },
        outOfScope: { type: 'array', items: { type: 'string' } },
        requirementIds: { type: 'array', items: { type: 'string' } },
        deliverables: { type: 'array', items: { type: 'string' } },
        changeRationale: { type: 'string' },
        dependsOnStepTitles: { type: 'array', items: { type: 'string' } },
        validationFocus: {
          type: 'array',
          items: { type: 'string', enum: ['implementation', 'migration', 'compatibility', 'regression'] }
        }
      }
    }
  };
}

function capabilityAuditJsonSchema(expectedCriteria: string[] = []): Record<string, unknown> {
  const gapWorkItem = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'description', 'acceptanceCriteria', 'inScope', 'outOfScope', 'requirementIds', 'deliverables', 'changeRationale', 'dependsOnStepTitles', 'validationFocus'],
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      acceptanceCriteria: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1 } },
      inScope: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1 } },
      outOfScope: { type: 'array', items: { type: 'string' } },
      requirementIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      deliverables: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1 } },
      changeRationale: { type: 'string' },
      dependsOnStepTitles: { type: 'array', items: { type: 'string' } },
      validationFocus: {
        type: 'array',
        items: { type: 'string', enum: ['implementation', 'migration', 'compatibility', 'regression'] }
      }
    }
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'summary', 'criteria', 'gapWorkItems'],
    properties: {
      verdict: { type: 'string', enum: ['satisfied', 'partial', 'blocked'] },
      summary: { type: 'string' },
      criteria: {
        type: 'array',
        ...(expectedCriteria.length > 0 ? { minItems: expectedCriteria.length, maxItems: expectedCriteria.length } : {}),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion', 'status', 'evidence', 'gaps'],
          properties: {
            criterion: expectedCriteria.length > 0
              ? { type: 'string', enum: expectedCriteria }
              : { type: 'string' },
            status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
            evidence: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      gapWorkItems: { type: 'array', items: gapWorkItem }
    }
  };
}

function releaseAuditJsonSchema(expectedCriteria: string[] = []): Record<string, unknown> {
  const capabilitySchema = capabilityAuditJsonSchema(expectedCriteria) as {
    properties: Record<string, unknown>;
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'summary', 'criteria', 'briefCoverage', 'contractAmendments', 'gapWorkItems'],
    properties: {
      ...capabilitySchema.properties,
      briefCoverage: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['obligation', 'status', 'workflowOnly', 'requirementIds', 'evidence', 'gaps'],
          properties: {
            obligation: { type: 'string' },
            status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
            workflowOnly: { type: 'boolean' },
            requirementIds: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            gaps: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      contractAmendments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'description', 'acceptanceCriteria', 'briefReferences'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            briefReferences: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  };
}

export class CodexProvider implements AIProvider {
  readonly kind: ProviderKind = 'codex';

  private readonly apiKey?: string;
  private readonly apiBaseUrl: string;
  private readonly authMode: 'api_key' | 'oauth';
  private readonly commandEnv: NodeJS.ProcessEnv;
  private readonly model: string;
  private oauthSessionVerified = false;

  constructor(config?: ProviderRuntimeConfig) {
    this.authMode = config?.authMode === 'codex_oauth' || (!config?.authMode && process.env.CODEX_AUTH_MODE === 'oauth')
      ? 'oauth'
      : 'api_key';
    const key = config?.apiKey ?? process.env.CODEX_API_KEY;
    if (this.authMode === 'api_key' && !key) {
      throw new Error('CODEX_API_KEY is required for Codex provider.');
    }
    this.apiKey = key;
    this.apiBaseUrl = process.env.CODEX_API_BASE_URL ?? DEFAULT_CODEX_API_URL;
    this.commandEnv = {
      ...createWorkspaceEnvironment(),
      ...(config?.codexHome ? { CODEX_HOME: config.codexHome } : {})
    };
    this.model = config?.model?.trim() || (process.env.CODEX_MODEL ?? DEFAULT_CODEX_MODEL);
  }

  async preflight(signal?: AbortSignal): Promise<ProviderPreflightResult> {
    return normalizeProviderPreflight(this.kind, async () => {
      if (this.authMode === 'oauth') {
        await this.verifyOAuthSession();
        return;
      }
      const response = await fetch(buildCodexModelsUrl(this.apiBaseUrl), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal
      });
      if (!response.ok) {
        throw normalizeCodexHttpError(response, 'Codex preflight failed.');
      }
      await readProviderJson(response, 'Codex preflight');
    });
  }

  async assessValidationImpact(input: ValidationImpactInput): Promise<ValidationImpactResult> {
    const response = await this.requestResponses([
      { role: 'system', content: 'You are a conservative read-only validation impact assessor. Return JSON only with reusable boolean and rationale string. Reuse only when the supplied evidence proves the workspace change cannot affect the successful check.' },
      { role: 'user', content: JSON.stringify(input, (key, value) => key === 'signal' ? undefined : value) }
    ], undefined, input.signal);
    return parseValidationImpactResult(response.content);
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    if (this.authMode === 'oauth') {
      return this.planWithCli(input);
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are Codex. Return JSON with summary, steps, acceptanceCriteria, implementationSteps, projectContract, contractDelta, and architectureUpdate. ' +
            'For ordinary task plans, implementationSteps must be an empty array and projectContract, contractDelta, and architectureUpdate must be null. For an initial project roadmap, include a full projectContract, set contractDelta to null, and include implementationSteps and architectureUpdate. For an approved project extension, set projectContract to null and return contractDelta against the supplied base contract, plus only implementationSteps required by that delta and a compact architectureUpdate. Never silently omit an existing requirement: update, supersede, or remove it with an explicit rationale. Every new or replacement requirement must include briefReferences with short source phrases or section names from the brief. ' +
            'Every implementation step must include changeRationale, dependsOnStepTitles referencing only earlier steps, and validationFocus. Include regression validation for extensions and migration or compatibility validation when the delta declares those impacts. Architecture updates must include databaseSchemas. ' +
            'Do not propose executable validation commands during planning; the implementation provider will derive them from the resulting repository. Reply with JSON only.'
      },
      {
        role: 'user',
        content: [
          `Create a plan for task "${input.title}". Prompt:\n${input.prompt}`,
          input.repositoryBaseline ? `Read-only repository baseline at commit ${input.repositoryBaseline.commitSha}:\n${input.repositoryBaseline.evidence}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
    const response = await this.requestResponses(messages, input.session, input.signal);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    try {
      return {
        ...parsePlanResult(content, 'Codex plan'),
        providerPrompt: serializeMessages(messages),
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async repairRoadmap(input: RoadmapRepairInput): Promise<RoadmapRepairResult> {
    const providerPrompt = [
      'Repair only the supplied invalid implementation roadmap, except when the blocker proves the derived contract contradicts the complete current specification. Return implementationSteps and contractDelta (null unless that targeted contract correction is necessary).',
      'The CURRENT SPECIFICATION is authoritative. The existing contract is historical derived context, not a current normative instruction. Preserve valid steps and untouched requirement IDs and semantics. Never turn an obsolete contract obligation into roadmap work.',
      'For a contract contradiction, return the smallest explicit delta against the supplied contract version, with a non-empty rationale on every update, supersession, or removal. Do not broadly regenerate the contract.',
      'Each step may contain at most 3 requirementIds, 3 deliverables, 5 acceptanceCriteria, and 5 inScope items. Split an oversized step into ordered focused steps while preserving complete requirement coverage.',
      `Objective: ${input.objective}`,
      `CURRENT SPECIFICATION (authoritative, complete):\n${input.authoritativeSpecification ?? input.objective}`,
      `Validation error: ${input.validationError}`,
      `Requirement ids that must remain covered: ${input.requiredRequirementIds.join(', ')}`,
      `Completed step titles that must not be recreated: ${input.completedStepTitles.join(' | ') || 'none'}`,
      `Migration impacts: ${input.migrationImpacts.join(' | ') || 'none'}`,
      `Compatibility impacts: ${input.compatibilityImpacts.join(' | ') || 'none'}`,
      `Relevant project contract (compact JSON):\n${JSON.stringify(compactRoadmapContract(input.projectContract, Array.from(new Set([
        ...input.requiredRequirementIds,
        ...input.implementationSteps.flatMap((step) => step.requirementIds)
      ]))))}`,
      `Invalid roadmap JSON:\n${JSON.stringify(input.implementationSteps)}`
    ].join('\n\n');
    let content: string;
    if (this.authMode === 'oauth') {
      content = await this.runCodexExec({
        repositoryPath: input.repositoryPath,
        sandbox: 'read-only',
        onActivity: input.onActivity,
        session: input.session,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['implementationSteps', 'contractDelta'],
          properties: {
            implementationSteps: implementationStepsJsonSchema(),
            contractDelta: { anyOf: [projectContractDeltaJsonSchema(), { type: 'null' }] }
          }
        },
        signal: input.signal,
        prompt: providerPrompt
      });
    } else {
      const response = await this.requestResponses([
        { role: 'system', content: 'You perform targeted roadmap repair and, only for a proven specification contradiction, a minimal explicit contract-delta repair. Return JSON only.' },
        { role: 'user', content: providerPrompt }
      ], input.session, input.signal);
      content = response.content;
      await emitCapturedUsage(input.onActivity, response.usage);
    }
    try {
      return {
        ...parseProviderJsonObject(content, 'Codex roadmap repair') as unknown as RoadmapRepairResult,
        providerPrompt,
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async reviewRoadmap(input: RoadmapQualityReviewInput): Promise<ReviewResult> {
    const providerPrompt = buildRoadmapQualityReviewPrompt(input);
    let content: string;
    if (this.authMode === 'oauth') {
      content = await this.runCodexExec({
        repositoryPath: input.repositoryPath,
        sandbox: 'read-only',
        onActivity: input.onActivity,
        signal: input.signal,
        schema: buildCodexReviewSchema(),
        prompt: providerPrompt
      });
    } else {
      const response = await this.requestResponses([
        {
          role: 'system',
          content: 'You are an independent roadmap quality reviewer. Assess only roadmap quality against the supplied objective and contract. Return JSON only.'
        },
        { role: 'user', content: providerPrompt }
      ], undefined, input.signal);
      content = response.content;
      await emitCapturedUsage(input.onActivity, response.usage);
    }
    try {
      return {
        ...parseReviewResult(content, 'Codex roadmap quality review'),
        providerPrompt,
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async implement(input: ImplementInput): Promise<ImplementResult> {
    if (this.authMode === 'oauth') {
      return this.implementWithCli(input);
    }

    const continueSession = Boolean(resolveCompatibleSessionId(input.session, 'codex', this.model));
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are Codex implementation agent. Make only the repository changes required by the supplied task and correction context. ' +
          'Use any repository, shell, network, installation, build, test, or formatting command needed to implement the task correctly. ForgeMind still runs the returned authoritative validation checks afterward. ' +
          'Set outcome to changes_made when repository changes are required, already_satisfied when the repository already meets the task, or blocked only for a concrete external blocker that prevents further progress. ' +
          'After editing, propose authoritative validationChecks. An empty array explicitly means no executable validation is applicable. For every command select shell, target (local or windows), requiredCapabilities, continueOnFailure, and timeoutMinutes. Use target windows only when the check genuinely requires Windows or Windows-only tooling. For Windows checks provide windowsAdapter only for a complete fixture or Unreal profile; otherwise use null for manual-local deferral. ForgeMind executes local commands exactly as returned; Windows checks execute only through the typed adapter. ' +
          'Return JSON with outcome, summary, changedFiles, evidenceFiles, diffStat, validationChecks, architectureUpdate, and optional fileUpdates [{ path, content }]. architectureUpdate must contain only architectural facts introduced or changed by this attempt, including databaseSchemas; use empty arrays when nothing changed. Reply with JSON only.'
      },
      {
        role: 'user',
        content: [
          'Implement the task.',
          `Attempt: ${input.attemptNumber ?? 1}`,
          continueSession ? 'Continue the task from this provider session. The repository is authoritative.' : `Prompt: ${input.prompt}`,
          continueSession ? '' : `Plan: ${input.plan.steps.join(' | ')}`,
          input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
          input.previousReviewBlockers?.length ? `Previous review blockers: ${input.previousReviewBlockers.join(' | ')}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      }
    ];
    const response = await this.requestResponses(messages, input.session, input.signal);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    try {
      const result = parseImplementResult(content, 'Codex implementation', true);
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

  async chat(input: ChatInput): Promise<ChatResult> {
    const continueSession = Boolean(resolveCompatibleSessionId(input.session, 'codex', this.model));
    const providerPrompt = buildRepositoryChatPrompt(input, continueSession);
    let content: string;
    if (this.authMode === 'oauth') {
      content = await this.runCodexExec({
        repositoryPath: input.repositoryPath,
        packetOnly: !input.repositoryAttached,
        sandbox: input.repositoryAttached ? 'workspace-write' : 'read-only',
        onActivity: input.onActivity,
        session: input.session,
        signal: input.signal,
        schema: repositoryChatJsonSchema(),
        prompt: providerPrompt
      });
    } else {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        {
          role: 'system',
          content: 'You are ForgeMind Repository Chat. Answer the user directly and return only JSON matching the requested chat schema. Use fileUpdates for repository changes and forgeMindActions for ForgeMind application operations.'
        },
        { role: 'user', content: providerPrompt }
      ];
      const response = await this.requestResponses(messages, input.session, input.signal);
      content = response.content;
      await emitCapturedUsage(input.onActivity, response.usage);
    }
    try {
      return {
        ...parseChatResult(content, 'Codex chat'),
        providerPrompt,
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    const reviewPrompt = buildReviewPrompt(input);
    if (this.authMode === 'oauth') {
      return this.reviewWithCli(input, reviewPrompt);
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are a read-only repository reviewer. Decide only whether the current implementation satisfies the task. Return verdict satisfied or not_satisfied and concrete implementation blockers.'
      },
      {
        role: 'user',
        content: reviewPrompt
      }
    ];
    const response = await this.requestResponses(messages, input.session, input.signal);
    const content = response.content;
    await emitCapturedUsage(input.onActivity, response.usage);

    try {
      return {
        ...parseReviewResult(content, 'Codex review'),
        providerPrompt: serializeMessages(messages),
        providerResponse: content
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }

  async auditCapability(input: CapabilityAuditInput): Promise<CapabilityAuditResult> {
    const auditInput: CapabilityAuditInput = {
      ...input,
      repositoryAccess: this.authMode === 'oauth' ? 'read_only_checkout' : 'complete_snapshot'
    };
    const providerPrompt = buildCapabilityAuditPrompt(auditInput);
    if (this.authMode === 'oauth') {
      return this.auditCapabilityWithCli(auditInput, providerPrompt);
    }
    if (!auditInput.repositoryContext?.trim()) {
      throw new Error('Codex API capability audit requires a targeted repository packet.');
    }
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are an independent read-only capability auditor. Inspect only for contract satisfaction and return strict JSON.'
      },
      { role: 'user', content: providerPrompt }
    ];
    const response = await this.requestResponses(messages);
    await emitCapturedUsage(input.onActivity, response.usage);
    const normalized = await normalizeAuditContentWithSingleRepair<CapabilityAuditResult>({
      auditKind: 'capability',
      content: response.content,
      expectedCriteria: auditInput.requirement.acceptanceCriteria,
      allowedRequirementIds: [auditInput.requirement.id],
      normalize: (value) => normalizeCapabilityAuditResult(auditInput, value),
      repair: async (repairPrompt) => {
        const repairResponse = await this.requestResponses([
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
    const auditInput: ReleaseAuditInput = {
      ...input,
      repositoryAccess: this.authMode === 'oauth' ? 'read_only_checkout' : 'complete_snapshot'
    };
    const providerPrompt = buildReleaseAuditPrompt(auditInput);
    if (this.authMode === 'oauth') {
      const schema = releaseAuditJsonSchema([...auditInput.contract.invariants, ...auditInput.contract.releaseCriteria]);
      const content = await this.runCodexExec({
        repositoryPath: input.repositoryPath,
        sandbox: 'read-only',
        onActivity: input.onActivity,
        schema,
        prompt: providerPrompt
      });
      const normalized = await normalizeAuditContentWithSingleRepair<ReleaseAuditResult>({
        auditKind: 'release',
        content,
        expectedCriteria: [...auditInput.contract.invariants, ...auditInput.contract.releaseCriteria],
        allowedRequirementIds: auditInput.contract.requirements.map((requirement) => requirement.id),
        normalize: (value) => normalizeReleaseAuditResult(auditInput, value),
        repair: (repairPrompt) => this.runCodexExec({
          repositoryPath: input.repositoryPath,
          sandbox: 'read-only',
          onActivity: input.onActivity,
          schema,
          prompt: repairPrompt
        })
      });
      return {
        ...normalized.result,
        providerPrompt: normalized.repairPrompt ? `${providerPrompt}\n\n[repair]\n${normalized.repairPrompt}` : providerPrompt,
        providerResponse: normalized.response
      };
    }
    if (!auditInput.repositoryContext?.trim()) throw new Error('Codex API release audit requires a targeted repository packet.');
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: 'You are an independent read-only release auditor. Inspect integration and contract satisfaction, then return strict JSON.' },
      { role: 'user', content: providerPrompt }
    ];
    const response = await this.requestResponses(messages);
    await emitCapturedUsage(input.onActivity, response.usage);
    const normalized = await normalizeAuditContentWithSingleRepair<ReleaseAuditResult>({
      auditKind: 'release',
      content: response.content,
      expectedCriteria: [...auditInput.contract.invariants, ...auditInput.contract.releaseCriteria],
      allowedRequirementIds: auditInput.contract.requirements.map((requirement) => requirement.id),
      normalize: (value) => normalizeReleaseAuditResult(auditInput, value),
      repair: async (repairPrompt) => {
        const repairResponse = await this.requestResponses([
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
    const inputTokens = Math.max(220, words * 2 * multiplier);
    const outputTokens = 700 * multiplier;

    return {
      inputTokens,
      outputTokens,
      estimatedCostUsd: parseFloat((((inputTokens + outputTokens) / 1000) * 0.003 * multiplier).toFixed(4))
    };
  }

  supportsLocalRepo(): boolean {
    return true;
  }

  supportsGitHubNativeFlow(): boolean {
    return false;
  }

  supportsNativeRepositoryReview(): boolean {
    return this.authMode === 'oauth';
  }

  supportsNativeRepositoryAudit(): boolean {
    return this.authMode === 'oauth';
  }

  private async planWithCli(input: PlanInput): Promise<PlanResult> {
    const providerPrompt = [
      'Create an implementation plan for this ForgeMind task.',
      'Return only JSON matching the provided schema.',
      'For roadmap plans, every implementation step must include changeRationale, dependsOnStepTitles referencing only earlier steps, and validationFocus. Architecture updates must include databaseSchemas.',
      'Do not propose executable validation commands during planning; the implementation provider will derive them from the resulting repository.',
      `Task id: ${input.taskId}`,
      `Title: ${input.title}`,
      `Prompt:\n${input.prompt}`
    ].join('\n\n');
    const content = await this.runCodexExec({
      sandbox: 'read-only',
      onActivity: input.onActivity,
      session: input.session,
      maxRuntimeMs: input.maxRuntimeMs,
      signal: input.signal,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'steps', 'acceptanceCriteria', 'implementationSteps', 'projectContract', 'contractDelta', 'architectureUpdate'],
        properties: {
          summary: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          implementationSteps: implementationStepsJsonSchema(),
          projectContract: {
            anyOf: [projectContractJsonSchema(), { type: 'null' }]
          },
          contractDelta: {
            anyOf: [projectContractDeltaJsonSchema(), { type: 'null' }]
          },
          architectureUpdate: {
            anyOf: [architectureUpdateJsonSchema(), { type: 'null' }]
          }
        }
      },
      prompt: providerPrompt
    });

    return {
      ...parsePlanResult(content, 'Codex CLI plan'),
      providerPrompt,
      providerResponse: content
    };
  }

  private async implementWithCli(input: ImplementInput): Promise<ImplementResult> {
    const providerPrompt = buildCodexImplementationPrompt(
      input,
      Boolean(resolveCompatibleSessionId(input.session, 'codex', this.model))
    );
    const beforeSnapshot = await collectChangedFileSnapshot(input.repositoryPath);
    let content: string;
    let recoveredFromTimeout = false;
    try {
      content = await this.runCodexExec({
        repositoryPath: input.repositoryPath,
        sandbox: 'workspace-write',
        onActivity: input.onActivity,
        session: input.session,
        signal: input.signal,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['outcome', 'summary', 'changedFiles', 'evidenceFiles', 'diffStat', 'validationChecks', 'architectureUpdate'],
          properties: {
            outcome: { type: 'string', enum: ['changes_made', 'already_satisfied', 'blocked'] },
            summary: { type: 'string' },
            changedFiles: { type: 'array', items: { type: 'string' } },
            evidenceFiles: { type: 'array', items: { type: 'string' } },
            diffStat: {
              type: 'object',
              additionalProperties: false,
              required: ['filesChanged', 'insertions', 'deletions'],
              properties: {
                filesChanged: { type: 'number' },
                insertions: { type: 'number' },
                deletions: { type: 'number' }
              }
            },
            validationChecks: validationChecksJsonSchema(),
            architectureUpdate: architectureUpdateJsonSchema()
          }
        },
        prompt: providerPrompt
      });
    } catch (error) {
      if (!(error instanceof CodexExecutionTimeoutError)) {
        throw error;
      }

      const afterSnapshot = await collectChangedFileSnapshot(input.repositoryPath);
      if (!hasChangedSnapshot(beforeSnapshot, afterSnapshot) && !hasRecoverableWorkspaceChanges(afterSnapshot)) {
        throw error;
      }

      recoveredFromTimeout = true;
      content = error.lastMessage || error.stderr || error.stdout;
      await emitProviderActivity(input.onActivity, {
        kind: 'lifecycle',
        message: 'Codex timed out after inactivity, but workspace changes were preserved for validation.',
        elapsedMs: error.elapsedMs
      });
    }

    const changedFiles = await collectChangedFiles(input.repositoryPath);
    const result: ImplementResult = recoveredFromTimeout
      ? {
          outcome: 'changes_made',
          summary: `Codex stopped after inactivity; preserved ${changedFiles.length} changed file(s) for validation and review.`,
          changedFiles,
          diffStat: await collectDiffStat(input.repositoryPath, changedFiles),
          validationChecks: []
        }
      : parseImplementResult(content, 'Codex CLI implementation');
    if (!Array.isArray(result.changedFiles) || result.changedFiles.length === 0) {
      result.changedFiles = changedFiles;
    }
    if (!result.diffStat || result.diffStat.filesChanged === 0) {
      result.diffStat = await collectDiffStat(input.repositoryPath, result.changedFiles);
    }
    result.validationChecks = normalizeValidationChecks(result.validationChecks);
    result.fileUpdates = undefined;
    result.providerPrompt = providerPrompt;
    result.providerResponse = content;
    return result;
  }

  private async reviewWithCli(input: ReviewInput, providerPrompt: string): Promise<ReviewResult> {
    const content = await this.runCodexExec({
      repositoryPath: input.repositoryPath,
      sandbox: 'read-only',
      onActivity: input.onActivity,
      session: input.session,
      signal: input.signal,
      schema: buildCodexReviewSchema(),
      prompt: providerPrompt
    });

    return {
      ...parseReviewResult(content, 'Codex CLI review'),
      providerPrompt,
      providerResponse: content
    };
  }

  private async auditCapabilityWithCli(input: CapabilityAuditInput, providerPrompt: string): Promise<CapabilityAuditResult> {
    const schema = capabilityAuditJsonSchema(input.requirement.acceptanceCriteria);
    const content = await this.runCodexExec({
      repositoryPath: input.repositoryPath,
      sandbox: 'read-only',
      onActivity: input.onActivity,
      schema,
      prompt: providerPrompt
    });
    const normalized = await normalizeAuditContentWithSingleRepair<CapabilityAuditResult>({
      auditKind: 'capability',
      content,
      expectedCriteria: input.requirement.acceptanceCriteria,
      allowedRequirementIds: [input.requirement.id],
      normalize: (value) => normalizeCapabilityAuditResult(input, value),
      repair: (repairPrompt) => this.runCodexExec({
        repositoryPath: input.repositoryPath,
        sandbox: 'read-only',
        onActivity: input.onActivity,
        schema,
        prompt: repairPrompt
      })
    });
    return {
      ...normalized.result,
      providerPrompt: normalized.repairPrompt ? `${providerPrompt}\n\n[repair]\n${normalized.repairPrompt}` : providerPrompt,
      providerResponse: normalized.response
    };
  }

  private async runCodexExec(input: {
    prompt: string;
    schema: Record<string, unknown>;
    repositoryPath?: string;
    packetOnly?: boolean;
    sandbox: 'read-only' | 'workspace-write';
    onActivity?: ProviderActivityHandler;
    session?: ProviderSessionContext;
    maxRuntimeMs?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    await this.verifyOAuthSession();

    const tempDir = await mkdtemp(join(tmpdir(), 'forgemind-codex-'));
    const schemaPath = join(tempDir, 'schema.json');
    const outputPath = join(tempDir, 'last-message.json');
    const executionDirectory = input.packetOnly ? tempDir : input.repositoryPath;
    await writeFile(schemaPath, JSON.stringify(input.schema), 'utf8');

    const args = buildCodexExecArgs({
      sandbox: input.sandbox,
      bypassSandbox: input.sandbox === 'read-only' && process.env.FORGEMIND_CODEX_BYPASS_READ_ONLY_SANDBOX === 'true',
      model: this.model,
      schemaPath,
      outputPath,
      repositoryPath: executionDirectory,
      sessionId: resolveCompatibleSessionId(input.session, 'codex', this.model)
    });

    try {
      await emitProviderActivityMessage(input.onActivity, {
        kind: 'lifecycle',
        message: `Prompt sent to Codex:\n${input.prompt}`,
        elapsedMs: 0
      });
      const execution = await runCodexProcess(args, input.prompt, {
        cwd: executionDirectory,
        env: this.commandEnv,
        maxRuntimeMs: input.maxRuntimeMs,
        signal: input.signal,
        onActivity: input.onActivity,
        onSessionId: async (id) => {
          if (!input.session) return;
          input.session.id = id;
          input.session.provider = 'codex';
          input.session.model = this.model;
          await input.session?.onUpdate?.({ id, provider: 'codex', model: this.model });
        }
      });
      if (execution.totalTokens !== undefined) {
        await emitCapturedUsage(input.onActivity, {
          provider: 'codex',
          model: this.model,
          totalTokens: execution.totalTokens,
          source: 'actual_total'
        });
      }
      return await readFile(outputPath, 'utf8');
    } catch (error) {
      if (error instanceof CodexExecutionTimeoutError) {
        error.lastMessage = await readFile(outputPath, 'utf8').catch(() => '');
      }
      throw error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async verifyOAuthSession(): Promise<void> {
    if (this.authMode !== 'oauth' || this.oauthSessionVerified) {
      return;
    }

    try {
      const { stdout, stderr } = await execFileAsync(resolveCodexBinary(), ['login', 'status'], {
        env: this.commandEnv,
        timeout: 15_000,
        windowsHide: true
      });
      if (!/Logged in using ChatGPT/i.test(`${stdout}\n${stderr}`)) {
        throw new Error('Codex CLI reported no active ChatGPT login.');
      }
      this.oauthSessionVerified = true;
    } catch {
      throw normalizeProviderError('codex', 'Codex OAuth session is not active. Reconnect Codex in Settings before retrying this task.');
    }
  }

  private async requestResponses(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    session?: ProviderSessionContext,
    signal?: AbortSignal
  ): Promise<{ content: string; usage?: ProviderUsageMeasurement }> {
    try {
      if (!this.apiKey) {
        throw normalizeProviderError('codex', 'CODEX_API_KEY is required for Codex API key provider mode.');
      }

      const response = await fetch(this.apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        signal,
        body: JSON.stringify({
          model: this.model,
          previous_response_id: resolveCompatibleSessionId(session, 'codex', this.model),
          input: messages.map((message) => ({
            role: message.role,
            content: [{ type: 'input_text', text: message.content }]
          })),
          temperature: 0.2,
          max_output_tokens: 1000
        })
      });

      if (!response.ok) {
        throw normalizeCodexHttpError(response, 'Codex request failed.');
      }

      const data = await readProviderJson<{
        id?: string;
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      }>(response, 'Codex request');

      if (data.id && session) {
        session.id = data.id;
        session.provider = 'codex';
        session.model = this.model;
        await session?.onUpdate?.({ id: data.id, provider: 'codex', model: this.model });
      }

      let content = '';
      if (typeof data.output_text === 'string' && data.output_text.trim().length > 0) {
        content = data.output_text.trim();
      } else {
        content = data.output
          ?.flatMap((item) => item.content ?? [])
          .map((chunk) => chunk.text ?? '')
          .join('\n')
          .trim() ?? '';
      }
      if (!content) {
        throw new ProviderContractError('Codex request returned an empty response.');
      }

      return {
        content,
        usage: normalizeTokenBreakdown({
          provider: 'codex',
          model: this.model,
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
          cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
          totalTokens: data.usage?.total_tokens
        })
      };
    } catch (error) {
      throw normalizeProviderError(this.kind, error);
    }
  }
}

function buildCodexModelsUrl(apiBaseUrl: string): URL {
  const url = new URL(apiBaseUrl);
  if (/\/responses\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/responses\/?$/, '/models');
  } else if (!/\/models\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  }
  return url;
}

function normalizeCodexHttpError(response: Response, message: string) {
  return normalizeProviderError('codex', {
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

function serializeMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

function resolveCompatibleSessionId(
  session: ProviderSessionContext | undefined,
  provider: ProviderKind,
  model: string
): string | undefined {
  if (!session?.id) return undefined;
  if (session.provider && session.provider !== provider) return undefined;
  if (session.model && session.model !== model) return undefined;
  return session.id;
}

export function buildCodexExecArgs(input: {
  sandbox: 'read-only' | 'workspace-write';
  bypassSandbox?: boolean;
  model: string;
  schemaPath: string;
  outputPath: string;
  repositoryPath?: string;
  sessionId?: string;
}): string[] {
  const args = input.sessionId ? ['exec', 'resume'] : ['exec', '--color', 'never'];

  if (input.sandbox === 'workspace-write' || input.bypassSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (input.sessionId) {
    args.push('-c', `sandbox_mode="${input.sandbox}"`);
  } else {
    args.push('--sandbox', input.sandbox);
  }

  args.push('--model', input.model);
  args.push('--output-schema', input.schemaPath);
  args.push('--output-last-message', input.outputPath, '--skip-git-repo-check', '--json');

  if (input.repositoryPath && !input.sessionId) {
    args.push('--cd', input.repositoryPath);
  }

  if (input.sessionId) {
    args.push(input.sessionId);
  }
  args.push('-');
  return args;
}

export interface CodexProcessOptions {
  cwd?: string;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
  onActivity?: ProviderActivityHandler;
  onSessionId?: (sessionId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CodexProcessResult {
  totalTokens?: number;
  sessionId?: string;
}

export class CodexExecutionTimeoutError extends Error {
  lastMessage = '';

  constructor(
    readonly reason: 'inactivity' | 'max_runtime',
    readonly elapsedMs: number,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(
      reason === 'inactivity'
        ? `Codex OAuth provider execution stopped after ${elapsedMs} ms without activity.`
        : `Codex OAuth provider execution exceeded the maximum runtime of ${elapsedMs} ms.`
    );
    this.name = 'CodexExecutionTimeoutError';
  }
}

export async function runCodexProcess(
  args: string[],
  stdin: string,
  options: CodexProcessOptions = {}
): Promise<CodexProcessResult> {
  const startedAt = Date.now();
  const inactivityTimeoutMs = resolvePositiveTimeout(
    options.inactivityTimeoutMs,
    process.env.CODEX_EXEC_INACTIVITY_TIMEOUT_MS ?? process.env.CODEX_EXEC_TIMEOUT_MS,
    600_000
  );
  const maxRuntimeMs = resolvePositiveTimeout(options.maxRuntimeMs, process.env.CODEX_EXEC_MAX_RUNTIME_MS, 36_000_000);

  return await new Promise<CodexProcessResult>((resolve, reject) => {
    const child = spawn(options.binary ?? resolveCodexBinary(), args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutReason: CodexExecutionTimeoutError['reason'] | undefined;
    let abortError: Error | undefined;
    let inactivityTimer: NodeJS.Timeout;
    let maxRuntimeTimer: NodeJS.Timeout;
    let terminationTimer: NodeJS.Timeout | undefined;
    let workspaceWatcher: FSWatcher | undefined;
    let sessionId: string | undefined;
    let jsonLineBuffer = '';
    let jsonTotalTokens: number | undefined;
    const expectsJsonEvents = args.includes('--json');
    let activityQueue = Promise.resolve();
    let activityFlushTimer: NodeJS.Timeout | undefined;
    const bufferedActivity: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

    const cleanup = () => {
      clearTimeout(inactivityTimer);
      clearTimeout(maxRuntimeTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (activityFlushTimer) clearTimeout(activityFlushTimer);
      workspaceWatcher?.close();
      options.signal?.removeEventListener('abort', stopForAbort);
    };
    const enqueueActivity = (kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace', message: string) => {
      activityQueue = activityQueue
        .then(async () => {
          await emitProviderActivityMessage(options.onActivity, {
            kind,
            message: stripAnsi(message),
            elapsedMs: Date.now() - startedAt
          });
        })
        .catch(() => undefined);
    };
    const flushBufferedActivity = () => {
      if (activityFlushTimer) {
        clearTimeout(activityFlushTimer);
        activityFlushTimer = undefined;
      }
      for (const kind of ['stdout', 'stderr'] as const) {
        const message = bufferedActivity[kind];
        bufferedActivity[kind] = '';
        if (message) enqueueActivity(kind, message);
      }
    };
    const finish = (error?: Error, result: CodexProcessResult = {}) => {
      if (settled) return;
      flushBufferedActivity();
      settled = true;
      cleanup();
      void activityQueue.then(
        () => error ? reject(error) : resolve(result),
        () => error ? reject(error) : resolve(result)
      );
    };
    const emitActivity = (kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace', message: string) => {
      if (kind === 'stdout' || kind === 'stderr') {
        bufferedActivity[kind] = appendCappedOutput(bufferedActivity[kind], message, 8_000);
        if (!activityFlushTimer) {
          activityFlushTimer = setTimeout(flushBufferedActivity, 350);
        }
        return;
      }
      flushBufferedActivity();
      enqueueActivity(kind, message);
    };
    const stopForTimeout = (reason: CodexExecutionTimeoutError['reason']) => {
      if (settled || timeoutReason) return;
      timeoutReason = reason;
      emitActivity('lifecycle', reason === 'inactivity' ? 'Stopping Codex after inactivity timeout.' : 'Stopping Codex after maximum runtime.');
      child.kill();
      terminationTimer = setTimeout(() => {
        finish(new CodexExecutionTimeoutError(reason, Date.now() - startedAt, stdout, stderr));
      }, 5_000);
    };
    const stopForAbort = () => {
      if (settled || abortError) return;
      abortError = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('Codex provider execution was cancelled.');
      emitActivity('lifecycle', 'Stopping Codex because the task was cancelled.');
      child.kill();
      terminationTimer = setTimeout(() => finish(abortError), 5_000);
    };
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => stopForTimeout('inactivity'), inactivityTimeoutMs);
    };
    const recordActivity = (kind: 'stdout' | 'stderr' | 'workspace', message: string) => {
      if (settled || timeoutReason) return;
      resetInactivityTimer();
      emitActivity(kind, message);
    };
    const consumeJsonEvents = (chunk: string, flush = false): string[] => {
      jsonLineBuffer += chunk;
      const lines = jsonLineBuffer.split(/\r?\n/);
      jsonLineBuffer = flush ? '' : (lines.pop() ?? '');
      const messages: string[] = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          if (event.type === 'thread.started' && event.thread_id && event.thread_id !== sessionId) {
            sessionId = event.thread_id;
            activityQueue = activityQueue.then(() => options.onSessionId?.(event.thread_id!)).then(() => undefined);
          }
          const usage = event.usage;
          if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
            jsonTotalTokens = usage.input_tokens + usage.output_tokens;
          }
          const message = formatCodexJsonEvent(event);
          if (message) messages.push(message);
        } catch {
          if (line.trim()) messages.push(line);
        }
      }
      return messages;
    };

    inactivityTimer = setTimeout(() => stopForTimeout('inactivity'), inactivityTimeoutMs);
    maxRuntimeTimer = setTimeout(() => stopForTimeout('max_runtime'), maxRuntimeMs);
    options.signal?.addEventListener('abort', stopForAbort, { once: true });
    if (options.signal?.aborted) stopForAbort();

    if (options.cwd) {
      try {
        workspaceWatcher = watch(options.cwd, { recursive: true }, (_eventType, filename) => {
          const path = String(filename ?? '');
          if (!path) return;
          if (isNoisyWorkspaceActivityPath(path)) {
            resetInactivityTimer();
            return;
          }
          recordActivity('workspace', `Workspace changed: ${path}`);
        });
      } catch {
        workspaceWatcher = undefined;
      }
    }

    emitActivity('lifecycle', 'Codex process started.');
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout = appendCappedOutput(stdout, text);
      if (expectsJsonEvents) {
        for (const message of consumeJsonEvents(text)) recordActivity('stdout', message);
      } else {
        recordActivity('stdout', text);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = appendCappedOutput(stderr, text);
      recordActivity('stderr', text);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (expectsJsonEvents) {
        for (const message of consumeJsonEvents('', true)) recordActivity('stdout', message);
      }
      if (timeoutReason) {
        finish(new CodexExecutionTimeoutError(timeoutReason, Date.now() - startedAt, stdout, stderr));
        return;
      }
      if (abortError) {
        finish(abortError);
        return;
      }
      if (code === 0) {
        emitActivity('lifecycle', 'Codex process completed.');
        finish(undefined, { totalTokens: jsonTotalTokens ?? parseCodexCliTotalTokens(stderr), sessionId });
        return;
      }

      finish(new Error(`Codex OAuth provider execution failed with ${code}: ${stripAnsi(stderr || stdout)}`));
    });
    child.stdin?.end(stdin);
  });
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string;
  usage?: { input_tokens?: number; output_tokens?: number };
  item?: {
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    status?: string;
    exit_code?: number;
  };
}

export function formatCodexJsonEvent(event: CodexJsonEvent): string | undefined {
  if (event.type === 'thread.started') return event.thread_id ? `Codex session: ${event.thread_id}` : undefined;
  if (event.type === 'turn.started') return 'Codex turn started.';
  if (event.type === 'turn.completed') return 'Codex turn completed.';
  if (event.type === 'turn.failed' || event.type === 'error') {
    return typeof event.error === 'string' ? event.error : event.error?.message ?? event.message ?? 'Codex turn failed.';
  }
  if (!event.type?.startsWith('item.') || !event.item) return undefined;
  if (event.item.type === 'agent_message' || event.item.type === 'reasoning') return event.item.text?.trim() || undefined;
  if (event.item.type === 'command_execution') {
    if (event.type === 'item.started') return event.item.command ? `Running: ${event.item.command}` : undefined;
    const output = event.item.aggregated_output?.trim();
    const status = event.item.exit_code === undefined ? event.item.status : `exit ${event.item.exit_code}`;
    return [event.item.command ? `Finished (${status}): ${event.item.command}` : `Command finished (${status}).`, output].filter(Boolean).join('\n');
  }
  return event.item.text?.trim() || undefined;
}

export function isNoisyWorkspaceActivityPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  const firstSegment = normalized.split('/', 1)[0]?.toLowerCase();
  return firstSegment === '.git'
    || firstSegment === 'node_modules'
    || firstSegment === 'dist'
    || firstSegment === 'build'
    || firstSegment === 'coverage'
    || firstSegment === '.cache'
    || firstSegment === '.next';
}

export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = env.FORGEMIND_CODEX_CLI_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }

  for (const candidate of getCodexBinaryCandidates(env)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'codex';
}

function getCodexBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];

  if (env.APPDATA) {
    candidates.push(join(env.APPDATA, 'npm', 'codex.cmd'), join(env.APPDATA, 'npm', 'codex.exe'));
  }

  if (env.LOCALAPPDATA) {
    candidates.push(
      ...getDesktopCodexBinaryCandidates(join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')),
      join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'codex.exe'),
      join(env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe')
    );
  }

  candidates.push(...getVsCodeCodexBinaryCandidates(env));
  return candidates;
}

function getDesktopCodexBinaryCandidates(binRoot: string): string[] {
  if (!existsSync(binRoot)) {
    return [];
  }

  try {
    return readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(binRoot, entry.name, 'codex.exe'))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  } catch {
    return [];
  }
}

function getVsCodeCodexBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const userProfile = env.USERPROFILE?.trim();
  if (!userProfile) {
    return [];
  }

  const extensionsPath = join(userProfile, '.vscode', 'extensions');
  if (!existsSync(extensionsPath)) {
    return [];
  }

  try {
    return readdirSync(extensionsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^openai\.chatgpt-.*-win32-x64$/i.test(entry.name))
      .map((entry) => join(extensionsPath, entry.name, 'bin', 'windows-x86_64', 'codex.exe'))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  } catch {
    return [];
  }
}

async function collectChangedFiles(repositoryPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'status', '--short', '--untracked-files=all'], {
      timeout: 10_000,
      windowsHide: true
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function collectChangedFileSnapshot(repositoryPath: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const path of await collectChangedFiles(repositoryPath)) {
    try {
      const stat = statSync(join(repositoryPath, path));
      snapshot.set(path, `${stat.size}:${stat.mtimeMs}`);
    } catch {
      snapshot.set(path, 'missing');
    }
  }
  return snapshot;
}

function hasChangedSnapshot(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.size !== after.size) return true;
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) return true;
  }
  return false;
}

function hasRecoverableWorkspaceChanges(snapshot: Map<string, string>): boolean {
  return [...snapshot.keys()].some((path) => {
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return normalized !== 'agents.md' && !normalized.startsWith('.forgemind/');
  });
}

async function collectDiffStat(
  repositoryPath: string,
  changedFiles: string[]
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'diff', '--numstat', 'HEAD'], {
      timeout: 10_000,
      windowsHide: true
    });
    let insertions = 0;
    let deletions = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const [added, removed] = line.split(/\s+/);
      insertions += Number.parseInt(added ?? '0', 10) || 0;
      deletions += Number.parseInt(removed ?? '0', 10) || 0;
    }

    return {
      filesChanged: changedFiles.length,
      insertions,
      deletions
    };
  } catch {
    return {
      filesChanged: changedFiles.length,
      insertions: 0,
      deletions: 0
    };
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

export function buildCodexImplementationPrompt(input: ImplementInput, continueSession = false): string {
  return [
    'Implement this task directly in the repository workspace.',
    'Do not create commits, branches, issues, or pull requests. ForgeMind handles those steps.',
    'Use any repository, shell, network, installation, build, or test command needed to implement the task correctly. ForgeMind still runs the returned authoritative validation checks afterward.',
    'Set outcome to changes_made when repository changes are required, already_satisfied when the repository already meets the task, or blocked only for a concrete external blocker that prevents further progress.',
    'After editing, return authoritative validationChecks. An empty array explicitly means no executable validation is applicable. For every command select shell (system, powershell, cmd, bash, or sh), target (local or windows), requiredCapabilities, continueOnFailure, and a realistic timeoutMinutes from 1 to 600. Use target windows only when the check genuinely requires Windows or Windows-only tooling. For each Windows check set windowsAdapter to a complete fixture-validation or unreal-validation profile only when applicable; otherwise set it to null for manual-local deferral. ForgeMind executes local commands exactly as returned; Windows checks execute only through the typed adapter. Do not use environment-only smoke checks such as node --version unless the task explicitly requires them.',
    'Return architectureUpdate as a compact delta containing only modules, databaseSchemas, interfaces, dependencies, decisions, conventions, or debt introduced or changed by this attempt. Use empty arrays when architecture did not change.',
    'Validation checks must be executable commands that prove a criterion through their exit code. Omit criteria that cannot be verified automatically.',
    input.attemptNumber && input.attemptNumber > 1
      ? 'This is a correction pass. Preserve completed work and change only what is required by the supplied validation error or review blocker.'
      : '',
    'When finished, return only JSON matching the provided schema, including outcome.',
    `Task id: ${input.taskId}`,
    `Attempt: ${input.attemptNumber ?? 1}`,
    continueSession ? 'Continue from the existing task session. Inspect the current repository state and preserve completed work.' : `Task scope:\n${input.prompt}`,
    continueSession ? '' : `Plan:\n${input.plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
    input.previousValidationError ? `Previous validation error:\n${input.previousValidationError}` : '',
    input.previousReviewBlockers?.length ? `Previous review blockers:\n${input.previousReviewBlockers.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function repositoryChatJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['response', 'changedFiles', 'validationChecks', 'fileUpdates', 'forgeMindActions'],
    properties: {
      response: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' } },
      validationChecks: validationChecksJsonSchema(),
      fileUpdates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'content'],
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          }
        }
      },
      forgeMindActions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['method', 'path', 'bodyJson', 'rationale'],
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string' },
            bodyJson: { type: 'string' },
            rationale: { type: 'string' }
          }
        }
      }
    }
  };
}

export function parseCodexCliTotalTokens(stderr: string): number | undefined {
  const matches = [...stripAnsi(stderr).matchAll(/tokens used\s+([0-9][0-9,]*)/gi)];
  const rawValue = matches.at(-1)?.[1]?.replace(/,/g, '');
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function resolvePositiveTimeout(explicitValue: number | undefined, environmentValue: string | undefined, fallback: number): number {
  const parsed = explicitValue ?? Number(environmentValue ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(10, parsed) : fallback;
}

function appendCappedOutput(current: string, chunk: string, maxChars = 200_000): string {
  const combined = current + chunk;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function splitActivityMessage(message: string): string[] {
  const normalized = message.trim();
  if (!normalized) return ['Provider emitted activity.'];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += 8_000) {
    chunks.push(normalized.slice(offset, offset + 8_000));
  }
  return chunks;
}

async function emitProviderActivity(handler: ProviderActivityHandler | undefined, activity: Parameters<ProviderActivityHandler>[0]) {
  if (!handler) return;
  try {
    await handler(activity);
  } catch {
    // Observability must never fail provider execution.
  }
}

async function emitProviderActivityMessage(handler: ProviderActivityHandler | undefined, activity: Parameters<ProviderActivityHandler>[0]) {
  for (const message of splitActivityMessage(activity.message)) {
    await emitProviderActivity(handler, { ...activity, message });
  }
}
