import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProviderKind } from '@forgemind/core';
import type {
  AIProvider,
  CostEstimateInput,
  CostEstimateResult,
  ImplementInput,
  ImplementResult,
  PlanInput,
  PlanResult,
  ProviderActivityHandler,
  ReviewInput,
  ReviewResult
} from './provider.js';

const DEFAULT_CODEX_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const execFileAsync = promisify(execFile);
const APPROVAL_TYPES = [
  'budget_increase',
  'continue_after_iteration_limit',
  'new_dependency',
  'risky_refactor',
  'database_migration',
  'config_change',
  'deploy_staging',
  'deploy_production',
  'merge_pr',
  'delete_files',
  'github_workflow_change',
  'systemd_change',
  'nginx_config_change',
  'write_outside_repo'
];

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

export class CodexProvider implements AIProvider {
  readonly kind: ProviderKind = 'codex';

  private readonly apiKey?: string;
  private readonly authMode: 'api_key' | 'oauth';

  constructor() {
    this.authMode = process.env.CODEX_AUTH_MODE === 'oauth' ? 'oauth' : 'api_key';
    const key = process.env.CODEX_API_KEY;
    if (this.authMode === 'api_key' && !key) {
      throw new Error('CODEX_API_KEY is required for Codex provider.');
    }
    this.apiKey = key;
  }

  async plan(input: PlanInput): Promise<PlanResult> {
    if (this.authMode === 'oauth') {
      return this.planWithCli(input);
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are Codex. Return JSON with summary, steps, acceptanceCriteria, validationChecks, and implementationSteps. ' +
          'For ordinary task plans, implementationSteps must be an empty array. When the request asks for a project roadmap, it must contain objects with title, description, acceptanceCriteria, inScope, and outOfScope. ' +
          'validationChecks must contain executable command checks or manual review checks. ' +
          'Use { "kind": "command", "command": "...", "criterion": "...", "rationale": "..." } for commands and ' +
          '{ "kind": "manual", "instructions": "...", "criterion": "...", "rationale": "..." } for non-executable criteria. Reply with JSON only.'
      },
      {
        role: 'user',
        content: [
          `Create a plan for task "${input.title}". Prompt:\n${input.prompt}`,
          input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
          input.previousValidationChecks?.length
            ? `Previous validation checks:\n${input.previousValidationChecks.map((check) => check.kind === 'command' ? check.command : check.instructions).join('\n')}`
            : '',
          input.previousValidationError
            ? 'Replace any broken validation command with a corrected command suitable for the execution environment.'
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ];
    const content = await this.requestResponses(messages);

    return {
      ...parseJsonContent<PlanResult>(content, {
        summary: `Codex plan for ${input.title}`,
        steps: ['Inspect repository context.', 'Implement minimal safe changes.', 'Validate with configured command.'],
        acceptanceCriteria: ['Task remains within policy limits.', 'Validation output is captured.', 'Draft PR is prepared.'],
        validationChecks: []
      }),
      providerPrompt: serializeMessages(messages),
      providerResponse: content
    };
  }

  async implement(input: ImplementInput): Promise<ImplementResult> {
    if (this.authMode === 'oauth') {
      return this.implementWithCli(input);
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are Codex implementation agent. Return JSON with summary, changedFiles, diffStat, requestedApprovals, and optional fileUpdates [{ path, content }]. Reply with JSON only.'
      },
      {
        role: 'user',
        content: [
          'Implement the task.',
          `Attempt: ${input.attemptNumber ?? 1}`,
          `Prompt: ${input.prompt}`,
          `Plan: ${input.plan.steps.join(' | ')}`,
          input.previousValidationError ? `Previous validation error: ${input.previousValidationError}` : '',
          input.previousReviewBlockers?.length ? `Previous review blockers: ${input.previousReviewBlockers.join(' | ')}` : '',
          input.previousSafeImprovements?.length ? `Apply these safe improvements automatically: ${input.previousSafeImprovements.join(' | ')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ];
    const content = await this.requestResponses(messages);

    const fallback: ImplementResult = {
      summary: `Codex implementation summary for task ${input.taskId}.`,
      changedFiles: ['CODEX_IMPLEMENTATION.md'],
      diffStat: summarizeDiffStats(input.prompt),
      requestedApprovals: [],
      fileUpdates: [
        {
          path: 'CODEX_IMPLEMENTATION.md',
          content: [
            `# Codex Implementation for ${input.taskId}`,
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
      result.changedFiles = ['CODEX_IMPLEMENTATION.md'];
    }
    if (!result.diffStat) {
      result.diffStat = summarizeDiffStats(result.summary);
    }
    if (!Array.isArray(result.requestedApprovals)) {
      result.requestedApprovals = [];
    }

    result.fileUpdates = normalizeFileUpdates(result, fallback);
    result.providerPrompt = serializeMessages(messages);
    result.providerResponse = content;
    return result;
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    if (this.authMode === 'oauth') {
      return this.reviewWithCli(input);
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: 'You are Codex reviewer. Return JSON with summary, blockers, safeImprovements, and riskyChanges. Reply with JSON only.'
      },
      {
        role: 'user',
        content: `Review changed files for task ${input.taskId}: ${input.changedFiles.join(', ')}`
      }
    ];
    const content = await this.requestResponses(messages);

    return {
      ...parseJsonContent<ReviewResult>(content, {
        summary: `Codex review of ${input.changedFiles.length} changed file(s).`,
        blockers: [],
        safeImprovements: ['Add targeted tests for changed files.'],
        riskyChanges: []
      }),
      providerPrompt: serializeMessages(messages),
      providerResponse: content
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

  private async planWithCli(input: PlanInput): Promise<PlanResult> {
    const fallback: PlanResult = {
      summary: `Codex plan for ${input.title}`,
      steps: ['Inspect repository context.', 'Implement minimal safe changes.', 'Validate with configured command.'],
      acceptanceCriteria: ['Task remains within configured limits.', 'Validation command is captured.', 'Draft PR is prepared.'],
      validationChecks: []
    };
    const providerPrompt = [
      'Create an implementation plan for this ForgeMind task.',
      'Return only JSON matching the provided schema.',
      'Translate acceptance criteria into concrete validation checks whenever possible.',
      `Task id: ${input.taskId}`,
      `Title: ${input.title}`,
      `Prompt:\n${input.prompt}`,
      input.previousValidationError ? `Previous validation error:\n${input.previousValidationError}` : '',
      input.previousValidationChecks?.length
        ? `Previous validation checks:\n${input.previousValidationChecks.map((check) => check.kind === 'command' ? check.command : check.instructions).join('\n')}`
        : '',
      input.previousValidationError
        ? 'Replace any broken validation command with a corrected command suitable for the execution environment.'
        : ''
    ].join('\n\n');
    const content = await this.runCodexExec({
      repositoryPath: input.repositoryPath,
      sandbox: 'read-only',
      onActivity: input.onActivity,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'steps', 'acceptanceCriteria', 'implementationSteps', 'validationChecks'],
        properties: {
          summary: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          implementationSteps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'description', 'acceptanceCriteria', 'inScope', 'outOfScope'],
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                acceptanceCriteria: { type: 'array', items: { type: 'string' } },
                inScope: { type: 'array', items: { type: 'string' } },
                outOfScope: { type: 'array', items: { type: 'string' } }
              }
            }
          },
          validationChecks: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'command', 'criterion', 'rationale'],
                  properties: {
                    kind: { type: 'string', enum: ['command'] },
                    command: { type: 'string' },
                    criterion: { type: ['string', 'null'] },
                    rationale: { type: ['string', 'null'] }
                  }
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['kind', 'instructions', 'criterion', 'rationale'],
                  properties: {
                    kind: { type: 'string', enum: ['manual'] },
                    instructions: { type: 'string' },
                    criterion: { type: ['string', 'null'] },
                    rationale: { type: ['string', 'null'] }
                  }
                }
              ]
            }
          }
        }
      },
      prompt: providerPrompt
    });

    return {
      ...parseJsonContent<PlanResult>(content, fallback),
      providerPrompt,
      providerResponse: content
    };
  }

  private async implementWithCli(input: ImplementInput): Promise<ImplementResult> {
    const fallback: ImplementResult = {
      summary: `Codex implementation summary for task ${input.taskId}.`,
      changedFiles: [],
      diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
      requestedApprovals: []
    };
    const providerPrompt = [
      'Implement this task directly in the repository workspace.',
      'Do not create commits, branches, issues, or pull requests. ForgeMind handles those steps.',
      'When finished, return only JSON matching the provided schema.',
      `Task id: ${input.taskId}`,
      `Attempt: ${input.attemptNumber ?? 1}`,
      `Prompt:\n${input.prompt}`,
      `Plan:\n${input.plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
      input.previousValidationError ? `Previous validation error:\n${input.previousValidationError}` : '',
      input.previousReviewBlockers?.length ? `Previous review blockers:\n${input.previousReviewBlockers.join('\n')}` : '',
      input.previousSafeImprovements?.length ? `Safe improvements to apply:\n${input.previousSafeImprovements.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n');
    const beforeSnapshot = await collectChangedFileSnapshot(input.repositoryPath);
    let content: string;
    let recoveredFromTimeout = false;
    try {
      content = await this.runCodexExec({
        repositoryPath: input.repositoryPath,
        sandbox: 'workspace-write',
        onActivity: input.onActivity,
        schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'changedFiles', 'diffStat', 'requestedApprovals'],
        properties: {
          summary: { type: 'string' },
          changedFiles: { type: 'array', items: { type: 'string' } },
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
          requestedApprovals: { type: 'array', items: { type: 'string', enum: APPROVAL_TYPES } }
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

    const result = parseJsonContent<ImplementResult>(content, fallback);
    const changedFiles = await collectChangedFiles(input.repositoryPath);
    if (!Array.isArray(result.changedFiles) || result.changedFiles.length === 0) {
      result.changedFiles = changedFiles;
    }
    if (!result.diffStat || result.diffStat.filesChanged === 0) {
      result.diffStat = await collectDiffStat(input.repositoryPath, result.changedFiles);
    }
    if (!Array.isArray(result.requestedApprovals)) {
      result.requestedApprovals = [];
    }
    if (recoveredFromTimeout) {
      result.summary = `Codex stopped after inactivity; preserved ${changedFiles.length} changed file(s) for validation and review.`;
    }
    result.fileUpdates = undefined;
    result.providerPrompt = providerPrompt;
    result.providerResponse = content;
    return result;
  }

  private async reviewWithCli(input: ReviewInput): Promise<ReviewResult> {
    const fallback: ReviewResult = {
      summary: `Codex review of ${input.changedFiles.length} changed file(s).`,
      blockers: [],
      safeImprovements: ['Add targeted tests for changed files.'],
      riskyChanges: []
    };
    const providerPrompt = [
      'Review the current repository changes for this ForgeMind task.',
      'Do not modify files. Return only JSON matching the provided schema.',
      `Task id: ${input.taskId}`,
      `Changed files:\n${input.changedFiles.join('\n')}`
    ].join('\n\n');
    const content = await this.runCodexExec({
      repositoryPath: input.repositoryPath,
      sandbox: 'read-only',
      onActivity: input.onActivity,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'blockers', 'safeImprovements', 'riskyChanges'],
        properties: {
          summary: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
          safeImprovements: { type: 'array', items: { type: 'string' } },
          riskyChanges: { type: 'array', items: { type: 'string', enum: APPROVAL_TYPES } }
        }
      },
      prompt: providerPrompt
    });

    return {
      ...parseJsonContent<ReviewResult>(content, fallback),
      providerPrompt,
      providerResponse: content
    };
  }

  private async runCodexExec(input: {
    prompt: string;
    schema: Record<string, unknown>;
    repositoryPath?: string;
    sandbox: 'read-only' | 'workspace-write';
    onActivity?: ProviderActivityHandler;
  }): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'forgemind-codex-'));
    const schemaPath = join(tempDir, 'schema.json');
    const outputPath = join(tempDir, 'last-message.json');
    await writeFile(schemaPath, JSON.stringify(input.schema), 'utf8');

    const args = buildCodexExecArgs({
      sandbox: input.sandbox,
      bypassSandbox: input.sandbox === 'read-only' && process.env.FORGEMIND_CODEX_BYPASS_READ_ONLY_SANDBOX === 'true',
      model: process.env.CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
      schemaPath,
      outputPath,
      repositoryPath: input.repositoryPath
    });

    try {
      await emitProviderActivityMessage(input.onActivity, {
        kind: 'lifecycle',
        message: `Prompt sent to Codex:\n${input.prompt}`,
        elapsedMs: 0
      });
      await runCodexProcess(args, input.prompt, {
        cwd: input.repositoryPath,
        onActivity: input.onActivity
      });
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

  private async requestResponses(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
    if (!this.apiKey) {
      throw new Error('CODEX_API_KEY is required for Codex API key provider mode.');
    }

    const response = await fetch(process.env.CODEX_API_BASE_URL ?? DEFAULT_CODEX_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? DEFAULT_CODEX_MODEL,
        input: messages.map((message) => ({
          role: message.role,
          content: [{ type: 'input_text', text: message.content }]
        })),
        temperature: 0.2,
        max_output_tokens: 1000
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Codex request failed with ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };

    if (typeof data.output_text === 'string' && data.output_text.trim().length > 0) {
      return data.output_text.trim();
    }

    const text = data.output
      ?.flatMap((item) => item.content ?? [])
      .map((chunk) => chunk.text ?? '')
      .join('\n')
      .trim();

    return text ?? '';
  }
}

function serializeMessages(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): string {
  return messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
}

export function buildCodexExecArgs(input: {
  sandbox: 'read-only' | 'workspace-write';
  bypassSandbox?: boolean;
  model: string;
  schemaPath: string;
  outputPath: string;
  repositoryPath?: string;
}): string[] {
  const args = ['exec', '--color', 'never'];

  if (input.sandbox === 'workspace-write' || input.bypassSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', input.sandbox);
  }

  args.push('--model', input.model, '--output-schema', input.schemaPath, '--output-last-message', input.outputPath, '--skip-git-repo-check');

  if (input.repositoryPath) {
    args.push('--cd', input.repositoryPath);
  }

  args.push('-');
  return args;
}

export interface CodexProcessOptions {
  cwd?: string;
  binary?: string;
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
  onActivity?: ProviderActivityHandler;
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

export async function runCodexProcess(args: string[], stdin: string, options: CodexProcessOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const inactivityTimeoutMs = resolvePositiveTimeout(
    options.inactivityTimeoutMs,
    process.env.CODEX_EXEC_INACTIVITY_TIMEOUT_MS ?? process.env.CODEX_EXEC_TIMEOUT_MS,
    600_000
  );
  const maxRuntimeMs = resolvePositiveTimeout(options.maxRuntimeMs, process.env.CODEX_EXEC_MAX_RUNTIME_MS, 3_600_000);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.binary ?? resolveCodexBinary(), args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutReason: CodexExecutionTimeoutError['reason'] | undefined;
    let inactivityTimer: NodeJS.Timeout;
    let maxRuntimeTimer: NodeJS.Timeout;
    let terminationTimer: NodeJS.Timeout | undefined;
    let workspaceWatcher: FSWatcher | undefined;

    const cleanup = () => {
      clearTimeout(inactivityTimer);
      clearTimeout(maxRuntimeTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      workspaceWatcher?.close();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve();
    };
    const emitActivity = (kind: 'lifecycle' | 'stdout' | 'stderr' | 'workspace', message: string) => {
      void emitProviderActivityMessage(options.onActivity, {
        kind,
        message: stripAnsi(message),
        elapsedMs: Date.now() - startedAt
      });
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
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => stopForTimeout('inactivity'), inactivityTimeoutMs);
    };
    const recordActivity = (kind: 'stdout' | 'stderr' | 'workspace', message: string) => {
      if (settled || timeoutReason) return;
      resetInactivityTimer();
      emitActivity(kind, message);
    };

    inactivityTimer = setTimeout(() => stopForTimeout('inactivity'), inactivityTimeoutMs);
    maxRuntimeTimer = setTimeout(() => stopForTimeout('max_runtime'), maxRuntimeMs);

    if (options.cwd) {
      try {
        workspaceWatcher = watch(options.cwd, { recursive: true }, (_eventType, filename) => {
          const path = String(filename ?? '');
          if (!path || path === '.git' || path.startsWith('.git/') || path.startsWith('.git\\')) return;
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
      recordActivity('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = appendCappedOutput(stderr, text);
      recordActivity('stderr', text);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (timeoutReason) {
        finish(new CodexExecutionTimeoutError(timeoutReason, Date.now() - startedAt, stdout, stderr));
        return;
      }
      if (code === 0) {
        emitActivity('lifecycle', 'Codex process completed.');
        finish();
        return;
      }

      finish(new Error(`Codex OAuth provider execution failed with ${code}: ${stripAnsi(stderr || stdout)}`));
    });
    child.stdin?.end(stdin);
  });
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
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe'));
  }

  candidates.push(...getVsCodeCodexBinaryCandidates(env));
  return candidates;
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

function resolvePositiveTimeout(explicitValue: number | undefined, environmentValue: string | undefined, fallback: number): number {
  const parsed = explicitValue ?? Number(environmentValue ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(10, parsed) : fallback;
}

function appendCappedOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= 200_000 ? combined : combined.slice(-200_000);
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
