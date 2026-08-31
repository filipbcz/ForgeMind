import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { requiresApproval, redactSecrets, type ApprovalType, type ChatMessage, type ProviderKind } from '@forgemind/core';
import type { AIProviderConnectionSecret, ClaimedChatRun, ForgeMindRepository } from '@forgemind/db';
import { createProvider, normalizeProviderError, type ChatResult, type ForgeMindApiAction, type ProviderSessionContext, type ProviderUsageMeasurement } from '@forgemind/providers';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { JsonValue } from '@forgemind/shared';
import { runValidationChecks } from './validation.js';
import { assertFreeSpaceForWorker, resolveWorkerResourcePolicy } from './resource-policy.js';
import { resolveWorkerWorkspaceRoot } from './db-worker/lifecycle.js';

const APPROVAL_TYPES: ReadonlySet<ApprovalType> = new Set([
  'budget_increase', 'continue_after_iteration_limit', 'new_dependency', 'risky_refactor', 'database_migration',
  'config_change', 'deploy_staging', 'deploy_production', 'merge_pr', 'delete_files', 'github_workflow_change',
  'systemd_change', 'nginx_config_change', 'write_outside_repo'
]);
const MAX_CHAT_PROVIDER_TURNS = 6;
const UNSAFE_INHERITED_GIT_ENVIRONMENT = new Set([
  'editor',
  'git_askpass',
  'git_config',
  'git_config_global',
  'git_config_parameters',
  'git_config_system',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_ssh',
  'git_ssh_command',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass',
  'visual'
]);

export interface ChatWorkerRuntime {
  createProvider?: typeof createProvider;
  workspaceRoot?: string;
}

export async function runNextChatTurn(repository: ForgeMindRepository, runtime: ChatWorkerRuntime = {}): Promise<{
  claimed: true;
  kind: 'chat';
  chatThreadId: string;
  chatRunId: string;
  status: string;
  errorMessage?: string;
} | undefined> {
  const claimed = await repository.claimNextChatRun();
  if (!claimed) return undefined;

  let providerKind = resolveChatProviderKind();
  const abortController = new AbortController();
  let stopRuntimeWatchers: () => void = () => undefined;

  try {
    const connection = claimed.thread.providerConnectionId
      ? await repository.getAIProviderConnectionSecretById(claimed.thread.providerConnectionId)
      : await repository.getAIProviderConnectionSecret();
    providerKind = resolveChatProviderKind(connection);
    const providerModel = resolveChatProviderModel(providerKind, connection);
    const provider = (runtime.createProvider ?? createProvider)(providerKind, connection?.provider === providerKind ? {
      apiKey: connection.apiKey,
      authMode: connection.authMode,
      codexHome: connection.codexHome,
      model: connection.model
    } : undefined);
    if (!provider.chat) throw new Error(`Provider "${providerKind}" does not support repository chat.`);

    const workspace = await prepareChatWorkspace(repository, claimed, runtime.workspaceRoot);
    const resourcePolicy = resolveWorkerResourcePolicy(claimed.project?.configYaml);
    await assertFreeSpaceForWorker(workspace.path, resourcePolicy);
    const compatibleSession = claimed.thread.providerSessionProvider === providerKind
      && claimed.thread.providerSessionModel === providerModel
      && claimed.thread.providerSessionConnectionId === connection?.id;
    const providerSession: ProviderSessionContext = {
      id: compatibleSession ? claimed.thread.providerSessionId : undefined,
      provider: providerKind,
      model: providerModel,
      onUpdate: (session) => repository.updateChatProviderSession({
        threadId: claimed.thread.id,
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        connectionId: connection?.id
      })
    };
    const approvedOperations = claimed.approvals
      .filter((approval) => approval.status === 'approved')
      .map((approval) => approval.type);
    const usage = createUsageAccumulator();
    stopRuntimeWatchers = startChatRuntimeWatchers(repository, claimed.run.id, abortController);
    await provider.preflight(abortController.signal);
    let currentMessage = claimed.run.prompt;
    let finalResult: ChatResult | undefined;
    let primaryResponse: string | undefined;
    const correctionResponses: string[] = [];
    const interimResponses: string[] = [];
    const providerChangedFiles = new Set<string>();
    let validationSummary: JsonValue | undefined;
    const executedActionHashes = new Set<string>();
    let completedProviderTurn = false;

    for (let attempt = 1; attempt <= MAX_CHAT_PROVIDER_TURNS; attempt += 1) {
      const context = await buildConversationContext(repository, claimed, compatibleSession);
      const result = await provider.chat({
        runId: claimed.run.id,
        message: currentMessage,
        conversationContext: context,
        repositoryPath: workspace.path,
        repositoryAttached: workspace.repositoryAttached,
        mode: claimed.thread.mode,
        approvedOperations,
        forgeMindContext: buildForgeMindActionContext(claimed),
        session: providerSession,
        signal: abortController.signal,
        onActivity: async (activity) => {
          if (activity.usage) usage.add(activity.usage);
          const presentation = presentChatProviderActivity(activity.kind, activity.message);
          if (presentation.kind === 'interim_result' && !interimResponses.includes(presentation.detail)) {
            interimResponses.push(presentation.detail);
          }
          const technicalDetail = presentation.detail === activity.message
            ? null
            : String(redactSecrets(activity.message)).slice(0, 8_000);
          await repository.writeAudit({
            actorType: 'agent',
            eventType: 'chat_provider_activity',
            projectId: claimed.thread.projectId,
            chatThreadId: claimed.thread.id,
            chatRunId: claimed.run.id,
            payload: {
              kind: presentation.kind,
              title: presentation.title,
              detail: String(redactSecrets(presentation.detail)).slice(0, 8_000),
              technicalDetail,
              elapsedMs: activity.elapsedMs,
              attempt
            }
          });
        }
      });
      finalResult = result;
      for (const path of result.changedFiles) providerChangedFiles.add(path);
      for (const update of result.fileUpdates ?? []) providerChangedFiles.add(update.path);

      const actionApprovalRequests = (result.forgeMindActions ?? []).flatMap((action) => {
        const type = requiredActionApprovalType(action);
        if (!type || !requiresApproval(type, claimed.thread.mode) || hasApprovedAction(claimed, type, action)) return [];
        return [{ type, action }];
      });
      const actionApprovalTypes = new Set(actionApprovalRequests.map((request) => request.type));
      const requestedApprovals = uniqueApprovalTypes(result.requestedApprovals)
        .filter((type) => requiresApproval(type, claimed.thread.mode))
        .filter((type) => !actionApprovalTypes.has(type))
        .filter((type) => !approvedOperations.includes(type));
      if (requestedApprovals.length > 0 || actionApprovalRequests.length > 0) {
        for (const type of requestedApprovals) {
          await repository.createChatApproval({
            threadId: claimed.thread.id,
            runId: claimed.run.id,
            type,
            title: `Chat requires approval: ${type}`,
            description: result.response,
            riskLevel: approvalRiskLevel(type),
            payload: { response: result.response, changedFiles: result.changedFiles }
          });
        }
        for (const request of actionApprovalRequests) {
          await repository.createChatApproval({
            threadId: claimed.thread.id,
            runId: claimed.run.id,
            type: request.type,
            title: `Chat requires approval: ${request.type}`,
            description: `${request.action.rationale}\n\n${request.action.method} ${request.action.path}`,
            riskLevel: approvalRiskLevel(request.type),
            payload: {
              response: result.response,
              apiMutation: toApiMutationBinding(claimed.thread.userId, request.action)
            }
          });
        }
        return chatResult(claimed, 'waiting_for_approval');
      }

      await applyChatFileUpdates(workspace.path, result);

      if ((result.forgeMindActions?.length ?? 0) > 0) {
        if (attempt === MAX_CHAT_PROVIDER_TURNS) {
          throw new Error('ForgeMind action loop did not produce a final answer.');
        }
        const actionResults = await executeForgeMindActions(
          repository,
          claimed,
          result.forgeMindActions ?? [],
          executedActionHashes,
          abortController.signal
        );
        currentMessage = [
          'ForgeMind executed the requested application actions. Use the exact results below.',
          JSON.stringify(actionResults, null, 2),
          'Return a final user-facing answer with forgeMindActions empty unless another distinct operation is strictly required. Never claim an action succeeded when its result has ok=false.'
        ].join('\n\n');
        continue;
      }

      if (!primaryResponse) primaryResponse = result.response;
      else correctionResponses.push(result.response);

      if (!workspace.repositoryAttached || result.validationChecks.length === 0 || result.changedFiles.length === 0) {
        completedProviderTurn = true;
        break;
      }
      const validation = await runValidationChecks(
        result.validationChecks,
        workspace.path,
        async (activity) => {
          await repository.writeAudit({
            actorType: 'system', eventType: 'chat_validation_activity', projectId: claimed.thread.projectId,
            chatThreadId: claimed.thread.id, chatRunId: claimed.run.id,
            payload: {
              state: activity.state,
              title: validationActivityTitle(activity.state),
              detail: activity.message ? String(redactSecrets(activity.message)).slice(0, 8_000) : null,
              command: activity.command ?? null,
              exitCode: activity.exitCode ?? null,
              attempt
            }
          });
        },
        new Map(),
        undefined,
        abortController.signal,
        undefined,
        undefined,
        resourcePolicy
      );
      validationSummary = {
        passed: validation.passed,
        command: validation.command,
        exitCode: validation.exitCode,
        stdout: validation.stdout.slice(-20_000),
        stderr: validation.stderr.slice(-20_000)
      };
      if (validation.passed) {
        completedProviderTurn = true;
        break;
      }
      if (attempt === MAX_CHAT_PROVIDER_TURNS) {
        throw new Error(`Chat validation failed after ${attempt} attempts.\nCommand: ${validation.command}\nExit code: ${validation.exitCode}\nSTDOUT:\n${validation.stdout}\nSTDERR:\n${validation.stderr}`);
      }
      currentMessage = [
        'Continue the current chat request and repair only the validation failure below.',
        'Do not repeat or replace the original user-facing answer. Return only a concise follow-up describing the validation problem and any correction you made; ForgeMind will append it to the original answer.',
        `Command: ${validation.command}`,
        `Exit code: ${validation.exitCode}`,
        `STDOUT:\n${validation.stdout}`,
        `STDERR:\n${validation.stderr}`
      ].join('\n\n');
    }

    if (await repository.isChatRunStopRequested(claimed.run.id)) {
      await repository.finishCancelledChatRun(claimed.run.id);
      return chatResult(claimed, 'cancelled');
    }
    if (!finalResult) throw new Error('Chat provider returned no result.');
    if (!completedProviderTurn) throw new Error('Chat provider did not complete the requested operation.');
    const repositoryResult = await collectRepositoryResult(workspace.git, workspace.path, [...providerChangedFiles], validationSummary);
    await repository.completeChatRun({
      runId: claimed.run.id,
      response: composeChatResponse(primaryResponse, correctionResponses),
      provider: providerKind,
      model: providerModel,
      ...usage.snapshot(),
      result: { ...repositoryResult, interimResponses }
    });
    await updateConversationSummary(repository, claimed);
    return chatResult(claimed, 'succeeded');
  } catch (error) {
    if (abortController.signal.aborted || await repository.isChatRunStopRequested(claimed.run.id)) {
      await repository.finishCancelledChatRun(claimed.run.id);
      return chatResult(claimed, 'cancelled');
    }
    const normalized = normalizeProviderError(providerKind, error);
    await repository.failChatRun(claimed.run.id, normalized.message, normalized.retryable);
    return chatResult(claimed, normalized.retryable && claimed.run.attemptCount < 3 ? 'retry_scheduled' : 'failed', normalized.message);
  } finally {
    stopRuntimeWatchers();
  }
}

export function composeChatResponse(primaryResponse: string | undefined, correctionResponses: string[]): string {
  const sections = [primaryResponse, ...correctionResponses]
    .map((response) => response?.trim())
    .filter((response): response is string => Boolean(response));
  return Array.from(new Set(sections)).join('\n\n---\n\n');
}

interface ForgeMindActionExecutionResult {
  method: ForgeMindApiAction['method'];
  path: string;
  ok: boolean;
  status: number;
  result: unknown;
  duplicate?: boolean;
}

interface NormalizedForgeMindAction {
  method: ForgeMindApiAction['method'];
  path: string;
  body?: unknown;
  rationale: string;
}

function buildForgeMindActionContext(claimed: ClaimedChatRun): string {
  const projectId = claimed.thread.projectId;
  const projectLine = projectId
    ? `Current attached project id: ${projectId}. Use this id for project-scoped operations.`
    : 'No project is attached. Use GET /api/projects to identify a project before proposing a project-scoped mutation.';
  return [
    projectLine,
    'Available ForgeMind API operations:',
    '- GET /api/projects; POST /api/projects; GET or PATCH /api/projects/:id; DELETE /api/projects/:id.',
    '- GET /api/projects/:id/contracts; POST /api/projects/:id/contracts to persist a complete structured contract version.',
    '- GET /api/projects/:id/roadmap; POST /api/projects/:id/implementation-steps/generate; POST /api/projects/:id/implementation-steps/start-next.',
    '- POST /api/projects/:id/implementation-steps/reconcile repairs roadmap step states strictly from their linked tasks terminal states; use it instead of requesting direct database access.',
    '- POST /api/projects/:id/audit/start; POST /api/projects/:id/audit/retry; POST /api/projects/:id/extension/decision.',
    '- GET /api/tasks; POST /api/tasks; GET /api/tasks/:id; POST /api/tasks/:id/start|cancel|retry|complete.',
    '- For task failure analysis, call GET /api/tasks/:id/diagnostics first. Follow up with GET /api/tasks/:id/logs, /runs, /queue, /diff, or /usage only when needed.',
    '- GET /api/approvals; POST /api/approvals/:id/approve|reject|comment.',
    '- GET /api/worker/status and GET /api/worker/events; PUT /api/worker/queue changes whether new work may start.',
    'Task diagnostics are authoritative. Do not infer that validation details are unavailable from repository files before querying the task diagnostics endpoint.',
    'Contract creation bodyJson must encode: { "contract": { "version": 1, "summary": string, "invariants": string[], "prohibitedSubstitutes": string[], "requirements": [{ "id": "REQ-...", "title": string, "description": string, "acceptanceCriteria": string[], "briefReferences": string[] }], "releaseCriteria": string[] }, "changeSummary": string }.',
    'For an existing contract, send contractDelta instead of contract; ForgeMind derives current version + 1 and preserves history.',
    'Authentication, chat, webhook, provider credential, and GitHub credential endpoints are intentionally unavailable.'
  ].join('\n');
}

async function executeForgeMindActions(
  repository: ForgeMindRepository,
  claimed: ClaimedChatRun,
  actions: ForgeMindApiAction[],
  executedActionHashes: Set<string>,
  signal: AbortSignal
): Promise<ForgeMindActionExecutionResult[]> {
  if (actions.length > 8) throw new Error('A chat provider may request at most 8 ForgeMind actions per turn.');
  const sessionToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  await repository.createAuthSession({
    tokenHash,
    userId: claimed.thread.userId,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
  });
  try {
    const results: ForgeMindActionExecutionResult[] = [];
    for (const action of actions) {
      const normalized = normalizeForgeMindAction(action);
      const actionHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      if (executedActionHashes.has(actionHash)) {
        results.push({ method: normalized.method, path: normalized.path, ok: true, status: 208, result: { message: 'Action already completed in this chat run.' }, duplicate: true });
        continue;
      }

      await repository.writeAudit({
        actorType: 'agent', eventType: 'chat_forgemind_action_started', projectId: claimed.thread.projectId,
        chatThreadId: claimed.thread.id, chatRunId: claimed.run.id,
        payload: { method: normalized.method, path: normalized.path, actionHash, rationale: normalized.rationale }
      });

      const response = await fetch(new URL(normalized.path, resolveForgeMindInternalApiUrl()), {
        method: normalized.method,
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'x-forgemind-chat-run-id': claimed.run.id,
          Accept: 'application/json',
          ...(normalized.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: normalized.body === undefined ? undefined : JSON.stringify(normalized.body),
        signal
      });
      const raw = (await response.text()).slice(0, 100_000);
      const parsed = parseApiResponse(raw);
      const safeResult = redactSecrets(parsed);
      const execution = {
        method: normalized.method,
        path: normalized.path,
        ok: response.ok,
        status: response.status,
        result: safeResult
      } satisfies ForgeMindActionExecutionResult;
      results.push(execution);
      if (response.ok) executedActionHashes.add(actionHash);
      await repository.writeAudit({
        actorType: 'agent', eventType: response.ok ? 'chat_forgemind_action_completed' : 'chat_forgemind_action_failed',
        projectId: claimed.thread.projectId, chatThreadId: claimed.thread.id, chatRunId: claimed.run.id,
        payload: { method: normalized.method, path: normalized.path, actionHash, status: response.status, result: safeResult as JsonValue }
      });
    }
    return results;
  } finally {
    await repository.revokeAuthSession(tokenHash);
  }
}

function normalizeForgeMindAction(action: ForgeMindApiAction): NormalizedForgeMindAction {
  const method = action.method.toUpperCase() as ForgeMindApiAction['method'];
  const path = action.path.trim();
  const body = parseActionBody(action.bodyJson);
  if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('..')) {
    throw new Error(`ForgeMind action path is not allowed: ${path}`);
  }
  const pathname = new URL(path, 'http://forgemind.internal').pathname;
  if (['/api/auth', '/api/chat', '/api/webhooks', '/api/providers', '/api/github/connect'].some((prefix) => pathname.startsWith(prefix))) {
    throw new Error(`ForgeMind action endpoint is not available to AI chat: ${pathname}`);
  }
  if (method === 'GET' && body !== undefined) {
    throw new Error('GET ForgeMind actions cannot contain a request body.');
  }
  return { method, path, body, rationale: action.rationale.trim() };
}

function resolveForgeMindInternalApiUrl(): string {
  const configured = process.env.FORGEMIND_INTERNAL_API_URL?.trim();
  if (configured) return configured.endsWith('/') ? configured : `${configured}/`;
  return `http://127.0.0.1:${process.env.PORT ?? '4000'}/`;
}

function parseApiResponse(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function requiredActionApprovalType(action: ForgeMindApiAction): ApprovalType | undefined {
  const path = new URL(action.path, 'http://forgemind.internal').pathname;
  if (path === '/api/worker/queue' || path.startsWith('/api/github/') || path.startsWith('/api/providers/')) return 'config_change';
  if (path.endsWith('/implementation-steps/reconcile')) return 'risky_refactor';
  if (action.method === 'DELETE' && path.startsWith('/api/projects/')) return 'delete_files';
  return undefined;
}

function hasApprovedAction(claimed: ClaimedChatRun, type: ApprovalType, action: ForgeMindApiAction): boolean {
  const expected = toApiMutationBinding(claimed.thread.userId, action);
  return claimed.approvals.some((approval) => {
    if (approval.status !== 'approved' || approval.type !== type) return false;
    const payload = approval.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const mutation = (payload as { apiMutation?: unknown }).apiMutation;
    if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) return false;
    const actual = mutation as Partial<typeof expected>;
    return actual.method === expected.method
      && actual.path === expected.path
      && actual.actorId === expected.actorId
      && actual.bodyHash === expected.bodyHash;
  });
}

function toApiMutationBinding(actorId: string, action: ForgeMindApiAction) {
  return {
    method: action.method,
    path: new URL(action.path, 'http://forgemind.internal').pathname,
    actorId,
    bodyHash: createHash('sha256').update(stableJson(parseActionBody(action.bodyJson) ?? null)).digest('hex')
  };
}

function parseActionBody(bodyJson: string): unknown {
  const normalized = bodyJson.trim();
  if (!normalized) return undefined;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    throw new Error('ForgeMind action bodyJson is not valid JSON.');
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

async function prepareChatWorkspace(repository: ForgeMindRepository, claimed: ClaimedChatRun, workspaceRoot?: string): Promise<{
  path: string;
  git: SimpleGit;
  repositoryAttached: boolean;
}> {
  const path = join(workspaceRoot ?? resolveWorkerWorkspaceRoot(), 'chat', claimed.thread.id);
  await mkdir(path, { recursive: true });
  const git = simpleGit({ baseDir: path });
  const repositoryAttached = Boolean(claimed.thread.repositoryOwner && claimed.thread.repositoryName);
  let isRepository = true;
  try {
    await git.revparse(['--show-toplevel']);
  } catch {
    isRepository = false;
  }
  if (!isRepository && repositoryAttached) {
    const connection = await repository.getGitHubConnectionSecret();
    if (!connection) throw new Error('Repository chat requires an active GitHub connection.');
    const remoteUrl = `https://github.com/${claimed.thread.repositoryOwner}/${claimed.thread.repositoryName}.git`;
    const basicCredential = Buffer.from(`x-access-token:${connection.token}`, 'utf8').toString('base64');
    const files = await import('node:fs/promises').then(({ readdir }) => readdir(path));
    if (files.length > 0) throw new Error('Chat workspace is not empty and is not a Git repository.');
    await createAuthenticatedCloneGit(`Authorization: Basic ${basicCredential}`)
      .clone(remoteUrl, path, ['--branch', claimed.thread.baseBranch ?? 'main']);
  } else if (!isRepository) {
    await git.init();
  }
  await git.addConfig('user.name', process.env.FORGEMIND_GIT_AUTHOR_NAME?.trim() || 'ForgeMind Chat', false, 'local');
  await git.addConfig('user.email', process.env.FORGEMIND_GIT_AUTHOR_EMAIL?.trim() || 'forgemind-chat@users.noreply.github.com', false, 'local');
  if (repositoryAttached && claimed.thread.branchName) {
    const status = await git.status();
    if (status.current !== claimed.thread.branchName) {
      const local = await git.branchLocal();
      if (local.all.includes(claimed.thread.branchName)) {
        await git.checkout(claimed.thread.branchName);
      } else {
        const all = await git.branch(['-a']);
        const remoteRef = `remotes/origin/${claimed.thread.branchName}`;
        if (all.all.includes(remoteRef)) await git.checkout(['-B', claimed.thread.branchName, `origin/${claimed.thread.branchName}`]);
        else await git.checkoutLocalBranch(claimed.thread.branchName);
      }
    }
  }
  return { path, git, repositoryAttached };
}

export function createAuthenticatedCloneGit(authorizationHeader: string): SimpleGit {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (UNSAFE_INHERITED_GIT_ENVIRONMENT.has(normalized)
      || /^git_config_(count|key_\d+|value_\d+)$/.test(normalized)) {
      delete environment[key];
    }
  }
  return simpleGit({ unsafe: { allowUnsafeConfigEnvCount: true } }).env({
    ...environment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: authorizationHeader,
    GIT_TERMINAL_PROMPT: '0'
  });
}

async function applyChatFileUpdates(workspacePath: string, result: ChatResult) {
  for (const update of result.fileUpdates ?? []) {
    const target = resolve(workspacePath, update.path);
    const relativePath = relative(resolve(workspacePath), target);
    if (!relativePath || relativePath.startsWith('..') || relativePath.includes(`..${process.platform === 'win32' ? '\\' : '/'}`) || relativePath === '.git' || relativePath.startsWith(`.git${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Provider file update escapes the chat workspace: ${update.path}`);
    }
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, update.content, 'utf8');
  }
}

async function buildConversationContext(repository: ForgeMindRepository, claimed: ClaimedChatRun, compatibleSession: boolean): Promise<string> {
  if (compatibleSession) {
    return 'Existing provider session is available. Use the new user message and current repository state.';
  }
  const messages = claimed.messages.slice(-30).map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n');
  const projectContext = claimed.project ? [
    `Project: ${claimed.project.name}`,
    claimed.project.brief ? `Brief:\n${claimed.project.brief}` : '',
    claimed.project.projectContract ? `Contract:\n${JSON.stringify(claimed.project.projectContract)}` : '',
    claimed.project.projectArchitecture ? `Architecture:\n${JSON.stringify(claimed.project.projectArchitecture)}` : ''
  ].filter(Boolean).join('\n\n') : '';
  return [claimed.thread.contextSummary ? `Older context summary:\n${claimed.thread.contextSummary}` : '', projectContext, messages]
    .filter(Boolean).join('\n\n').slice(-80_000);
}

async function updateConversationSummary(repository: ForgeMindRepository, claimed: ClaimedChatRun) {
  if (claimed.messages.length < 30) return;
  const older = claimed.messages.slice(0, -20);
  const summary = older.slice(-20).map((message) => `${message.role}: ${message.content.replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
  await repository.updateChatContextSummary(claimed.thread.id, summary);
}

async function collectRepositoryResult(git: SimpleGit, workspacePath: string, providerChangedFiles: string[], validation?: JsonValue) {
  const status = await git.status();
  const changedFiles = Array.from(new Set([...providerChangedFiles, ...status.files.map((file) => file.path)])).sort();
  const diff = (await git.diff()).slice(0, 200_000);
  const untracked = await Promise.all(status.not_added.slice(0, 30).map(async (path) => ({
    path,
    content: await readFile(join(workspacePath, path), 'utf8').then((value) => value.slice(0, 20_000)).catch(() => '[binary or unreadable]')
  })));
  return {
    branchName: status.current,
    changedFiles,
    diff,
    untracked,
    validation: validation ?? null
  };
}

function validationActivityTitle(state: string): string {
  if (state === 'started') return 'Validace spustena';
  if (state === 'completed') return 'Validace dokoncena';
  if (state === 'denied') return 'Validace zamitnuta bezpecnostni politikou';
  return 'Validace probiha';
}

function startChatRuntimeWatchers(repository: ForgeMindRepository, runId: string, controller: AbortController) {
  const heartbeat = setInterval(() => void repository.refreshChatRunHeartbeat(runId), 15_000);
  const cancellation = setInterval(() => {
    void repository.isChatRunStopRequested(runId).then((stop) => {
      if (stop && !controller.signal.aborted) controller.abort(new Error('Chat run was cancelled.'));
    });
  }, 1_000);
  return () => {
    clearInterval(heartbeat);
    clearInterval(cancellation);
  };
}

function createUsageAccumulator() {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let actualCostUsd = 0;
  let hasCost = false;
  return {
    add(measurement: ProviderUsageMeasurement) {
      inputTokens += measurement.inputTokens ?? 0;
      outputTokens += measurement.outputTokens ?? 0;
      totalTokens += measurement.totalTokens;
      cachedTokens += measurement.cachedTokens ?? 0;
      if (measurement.actualCostUsd !== undefined) {
        actualCostUsd += measurement.actualCostUsd;
        hasCost = true;
      }
    },
    snapshot() {
      return { inputTokens, outputTokens, totalTokens, cachedTokens, actualCostUsd: hasCost ? actualCostUsd : null };
    }
  };
}

function resolveChatProviderKind(connection?: AIProviderConnectionSecret): ProviderKind {
  return (connection?.provider ?? process.env.FORGEMIND_PROVIDER ?? 'codex') as ProviderKind;
}

function resolveChatProviderModel(provider: ProviderKind, connection?: AIProviderConnectionSecret): string {
  if (connection?.model) return connection.model;
  if (provider === 'openai') return process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  if (provider === 'codex') return process.env.CODEX_MODEL ?? 'gpt-5.5';
  return provider;
}

function uniqueApprovalTypes(values: ApprovalType[]): ApprovalType[] {
  return Array.from(new Set(values.filter((value) => APPROVAL_TYPES.has(value))));
}

function approvalRiskLevel(type: ApprovalType): 'medium' | 'high' | 'critical' {
  if (type === 'deploy_production' || type === 'merge_pr' || type === 'write_outside_repo') return 'critical';
  if (type === 'delete_files' || type === 'database_migration' || type === 'github_workflow_change') return 'high';
  return 'medium';
}

export interface ChatProviderActivityPresentation {
  kind: string;
  title: string;
  detail: string;
}

export function presentChatProviderActivity(kind: string, message: string): ChatProviderActivityPresentation {
  const interimResponse = parseInterimChatResponse(message);
  if (interimResponse) {
    return { kind: 'interim_result', title: 'Průběžný výsledek AI', detail: interimResponse };
  }
  if (/^Prompt sent to /i.test(message)) {
    return { kind: 'lifecycle', title: 'AI převzala zadání', detail: 'Zadání bylo předáno provideru.' };
  }
  if (/^Running:/i.test(message)) {
    return { kind: 'command', title: 'AI spouští příkaz', detail: summarizeProviderCommand(message) };
  }
  if (/^Finished/i.test(message)) {
    const exitCode = message.match(/exit\s+(\d+)/i)?.[1];
    return {
      kind: 'command',
      title: exitCode === undefined || exitCode === '0' ? 'Příkaz AI skončil' : 'Příkaz AI selhal',
      detail: `${summarizeProviderCommand(message)}${exitCode === undefined ? '' : ` Návratový kód: ${exitCode}.`}`
    };
  }
  if (/process started/i.test(message)) return { kind: 'lifecycle', title: 'AI provider spuštěn', detail: 'Provider zahájil zpracování.' };
  if (/turn started/i.test(message)) return { kind: 'lifecycle', title: 'AI analyzuje zadání', detail: 'Probíhá další AI tah.' };
  if (/process completed/i.test(message)) return { kind: 'lifecycle', title: 'AI tah dokončen', detail: 'Provider dokončil aktuální tah.' };
  if (/^Codex session:/i.test(message)) return { kind: 'lifecycle', title: 'AI session navázána', detail: 'Kontext vlákna je připraven.' };
  if (/Provider usage captured:/i.test(message)) return { kind: 'lifecycle', title: 'Využití provideru zaznamenáno', detail: message };
  if (kind === 'workspace') return { kind, title: 'Workspace se mění', detail: 'AI upravuje připojený repozitář.' };
  if (kind === 'stderr') return { kind, title: 'Technická informace', detail: message.slice(0, 600) };
  return { kind, title: 'AI pracuje', detail: message.slice(0, 2_000) };
}

function parseInterimChatResponse(message: string): string | undefined {
  if (!message.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(message) as { response?: unknown };
    return typeof parsed.response === 'string' && parsed.response.trim() ? parsed.response.trim() : undefined;
  } catch {
    return undefined;
  }
}

function summarizeProviderCommand(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('git status') || normalized.includes('git log') || normalized.includes('git branch')) {
    return normalized.includes('rg --files')
      ? 'Kontroluje stav, historii a dostupné diagnostické soubory v repozitáři.'
      : 'Kontroluje stav a historii repozitáře.';
  }
  if (normalized.includes('npm test') || normalized.includes('vitest')) return 'Spouští testy projektu.';
  if (normalized.includes('npm run build') || normalized.includes('tsc ')) return 'Ověřuje build a typy projektu.';
  if (normalized.includes('rg ') || normalized.includes('get-childitem')) return 'Prohledává soubory projektu.';
  return 'Provádí kontrolní příkaz v připojeném workspace.';
}

function chatResult(claimed: ClaimedChatRun, status: string, errorMessage?: string) {
  return {
    claimed: true as const,
    kind: 'chat' as const,
    chatThreadId: claimed.thread.id,
    chatRunId: claimed.run.id,
    status,
    errorMessage
  };
}
