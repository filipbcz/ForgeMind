import { describe, expect, it, vi } from 'vitest';
import { buildCodexImplementationPrompt, buildCodexReviewSchema, CodexProvider, isNoisyWorkspaceActivityPath, parseCodexCliTotalTokens, runCodexProcess } from './codex-provider.js';

describe('Codex structured output schemas', () => {
  it.each(['implementation', 'chat'] as const)('serializes typed Windows adapters in the actual %s request schema', async (operation) => {
    const provider = new CodexProvider({ authMode: 'codex_oauth' });
    const intercepted = new Error('Stop before invoking Codex.');
    const execute = vi.spyOn(provider as unknown as {
      runCodexExec: (input: { schema: JsonSchema }) => Promise<string>;
    }, 'runCodexExec').mockRejectedValue(intercepted);
    try {
      const result = operation === 'implementation'
        ? provider.implement({
            taskId: 'schema-test', prompt: 'Implement the current task.', repositoryPath: process.cwd(),
            plan: { summary: 'Current task', steps: ['Implement it.'], acceptanceCriteria: ['It works.'] }
          })
        : provider.chat({
            runId: 'schema-test', message: 'Inspect the repository.', conversationContext: '',
            repositoryPath: process.cwd(), repositoryAttached: true, mode: 'safe'
          });
      await expect(result).rejects.toBe(intercepted);
      expect(execute).toHaveBeenCalledTimes(1);
      // Check the JSON sent to the CLI, not just a standalone schema fixture.
      const schema = JSON.parse(JSON.stringify(execute.mock.calls[0]![0].schema)) as JsonSchema;
      expectStrictResponseSchema(schema);
      const adapters = schema.properties!.validationChecks!.items!.properties!.windowsAdapter!.anyOf!;
      expect(adapters).toHaveLength(3);
      expect(adapters[0]).toEqual({ type: 'null' });
      expect(adapters[1]!.properties!.kind).toEqual({ type: 'string', const: 'fixture-validation' });
      expect(adapters[2]!.properties).toMatchObject({
        kind: { type: 'string', const: 'unreal-validation' },
        tool: { type: 'string', enum: ['unreal-editor-cmd', 'build-bat', 'automation-tool', 'project-script'] },
        size: { type: 'string', enum: ['standard', 'large'] }
      });
    } finally {
      execute.mockRestore();
    }
  });

  it('reviews a large repository through the native read-only checkout without embedding it in the prompt', async () => {
    const provider = new CodexProvider({ authMode: 'codex_oauth' });
    const intercepted = new Error('Stop before invoking Codex.');
    const execute = vi.spyOn(provider as unknown as {
      runCodexExec: (input: { repositoryPath?: string; prompt: string }) => Promise<string>;
    }, 'runCodexExec').mockRejectedValue(intercepted);
    try {
      await expect(provider.reviewRoadmap({
        taskId: 'review-test', objective: 'Review the candidate.', repositoryPath: '/tmp/read-only-repository',
        projectContract: {
          version: 1, summary: 'Test project', invariants: [], prohibitedSubstitutes: [], requirements: [], releaseCriteria: []
        },
        implementationSteps: [], requiredRequirementIds: [], completedStepTitles: [],
        repositoryBaseline: { commitSha: 'a'.repeat(40), evidence: 'x'.repeat(2_750_000) }
      })).rejects.toBe(intercepted);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0].repositoryPath).toBe('/tmp/read-only-repository');
      expect(execute.mock.calls[0]![0].prompt).toContain('inspect the complete read-only checkout');
      expect(execute.mock.calls[0]![0].prompt.length).toBeLessThan(10_000);
    } finally {
      execute.mockRestore();
    }
  });
});

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

// Structured Outputs requires every anyOf branch to satisfy the same schema rules.
function expectStrictResponseSchema(schema: JsonSchema, path = '$'): void {
  if (schema.anyOf) {
    schema.anyOf.forEach((branch, index) => expectStrictResponseSchema(branch, `${path}.anyOf[${index}]`));
    return;
  }
  expect(schema.type, `${path} must declare its type`).toBeDefined();
  if (schema.type === 'object') {
    expect(schema.additionalProperties, path).toBe(false);
    expect([...(schema.required ?? [])].sort(), path).toEqual(Object.keys(schema.properties ?? {}).sort());
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      expectStrictResponseSchema(property, `${path}.${name}`);
    }
  }
  if (schema.type === 'array') {
    expect(schema.items, `${path}.items`).toBeDefined();
    expectStrictResponseSchema(schema.items!, `${path}.items`);
  }
}

describe('Codex process activity timeouts', () => {
  it('builds a strict review schema accepted by Codex structured output', () => {
    expectStrictObjectSchemas(buildCodexReviewSchema());
  });

  it('parses the actual total token count emitted by Codex CLI', () => {
    expect(parseCodexCliTotalTokens('codex output\ntokens used\n124,947\n')).toBe(124947);
    expect(parseCodexCliTotalTokens('codex output without usage')).toBeUndefined();
  });

  it('suppresses generated workspace paths from the realtime activity feed', () => {
    expect(isNoisyWorkspaceActivityPath('node_modules/@prisma/client/index.js')).toBe(true);
    expect(isNoisyWorkspaceActivityPath('node_modules\\@prisma\\client\\index.js')).toBe(true);
    expect(isNoisyWorkspaceActivityPath('dist/assets/index.js')).toBe(true);
    expect(isNoisyWorkspaceActivityPath('src/app.js')).toBe(false);
  });

  it('keeps correction prompts focused and leaves broad validation to ForgeMind', () => {
    const prompt = buildCodexImplementationPrompt({
      taskId: 'task-1',
      prompt: 'Current implementation step:\nFix null score fallback.',
      repositoryPath: '/workspace',
      attemptNumber: 2,
      plan: {
        summary: 'Implement leaderboard.',
        steps: ['Fix the comparator.'],
        acceptanceCriteria: ['Null score uses correctCount.']
      },
      previousReviewBlockers: ['score: null is treated as zero.']
    });

    expect(prompt).toContain('Preserve completed work');
    expect(prompt).toContain('score: null is treated as zero.');
    expect(prompt).toContain('ForgeMind still runs the returned authoritative validation checks afterward');
    expect(prompt).toContain('return authoritative validationChecks');
    expect(prompt).toContain('already_satisfied when the repository already meets the task');
    expect(prompt).toContain('continueOnFailure');
    expect(prompt).toContain('including outcome');
    expect(prompt).toContain('Do not use environment-only smoke checks');
    expect(prompt).toContain('Omit criteria that cannot be verified automatically');
    expect(prompt).not.toContain('manual checks');
    expect(prompt).not.toContain('Parent objective');
  });

  it('does not resend task scope and plan when continuing a persisted session', () => {
    const prompt = buildCodexImplementationPrompt({
      taskId: 'task-1',
      prompt: 'A very long task scope that the session already knows.',
      repositoryPath: '/workspace',
      attemptNumber: 2,
      plan: {
        summary: 'Existing plan.',
        steps: ['A very long implementation plan that the session already knows.'],
        acceptanceCriteria: ['Build passes.']
      },
      previousValidationError: 'Expected exit code 0, received 1.'
    }, true);

    expect(prompt).toContain('Continue from the existing task session');
    expect(prompt).toContain('Expected exit code 0, received 1.');
    expect(prompt).not.toContain('A very long task scope');
    expect(prompt).not.toContain('A very long implementation plan');
  });

  it('fails before execution when the configured OAuth session is not active', async () => {
    const previousAuthMode = process.env.CODEX_AUTH_MODE;
    const previousBinary = process.env.FORGEMIND_CODEX_CLI_PATH;
    process.env.CODEX_AUTH_MODE = 'oauth';
    process.env.FORGEMIND_CODEX_CLI_PATH = process.execPath;

    const provider = new CodexProvider();
    await expect(provider.plan({
      taskId: 'task_1',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: process.cwd()
    })).rejects.toThrow('Codex OAuth session is not active. Reconnect Codex in Settings before retrying this task.');

    if (previousAuthMode === undefined) {
      delete process.env.CODEX_AUTH_MODE;
    } else {
      process.env.CODEX_AUTH_MODE = previousAuthMode;
    }
    if (previousBinary === undefined) {
      delete process.env.FORGEMIND_CODEX_CLI_PATH;
    } else {
      process.env.FORGEMIND_CODEX_CLI_PATH = previousBinary;
    }
  });

  it('keeps an active process alive past the inactivity timeout', async () => {
    const onActivity = vi.fn();

    await runCodexProcess(
      [
        '-e',
        "process.stderr.write('started\\n');const timer=setInterval(()=>process.stderr.write('tick\\n'),25);setTimeout(()=>{clearInterval(timer);process.exit(0)},1000)"
      ],
      '',
      {
        binary: process.execPath,
        inactivityTimeoutMs: 1_500,
        maxRuntimeMs: 4_000,
        onActivity
      }
    );

    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stderr' }));
  });

  it('flushes queued activity handlers before resolving the process', async () => {
    const received: string[] = [];

    await runCodexProcess(['-e', "process.stdout.write('live\\n')"], '', {
      binary: process.execPath,
      inactivityTimeoutMs: 1_500,
      maxRuntimeMs: 3_000,
      onActivity: async (activity) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        received.push(activity.message);
      }
    });

    expect(received.some((message) => message.includes('live'))).toBe(true);
    expect(received.at(-1)).toContain('completed');
  });

  it('captures a persisted Codex session from JSONL events', async () => {
    const onSessionId = vi.fn();
    const result = await runCodexProcess(
      ['-e', "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'session-123'})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}})+'\\n')", '--', '--json'],
      '',
      {
        binary: process.execPath,
        inactivityTimeoutMs: 1_500,
        maxRuntimeMs: 3_000,
        onSessionId
      }
    );

    expect(onSessionId).toHaveBeenCalledWith('session-123');
    expect(result).toMatchObject({ sessionId: 'session-123', totalTokens: 15 });
  });

  it('stops a process after sustained inactivity', async () => {
    const execution = runCodexProcess(['-e', 'setTimeout(()=>process.exit(0),2000)'], '', {
      binary: process.execPath,
      inactivityTimeoutMs: 100,
      maxRuntimeMs: 2_000
    });

    await expect(execution).rejects.toMatchObject({
      name: 'CodexExecutionTimeoutError',
      reason: 'inactivity'
    });
  });

  it('enforces a maximum runtime even while activity continues', async () => {
    const execution = runCodexProcess(
      ['-e', "setInterval(()=>process.stdout.write('active\\n'),20)"],
      '',
      {
        binary: process.execPath,
        inactivityTimeoutMs: 500,
        maxRuntimeMs: 150
      }
    );

    await expect(execution).rejects.toMatchObject({
      name: 'CodexExecutionTimeoutError',
      reason: 'max_runtime'
    });
  });

  it('terminates the running Codex process when the task is cancelled', async () => {
    const controller = new AbortController();
    const execution = runCodexProcess(['-e', 'setInterval(()=>{},1000)'], '', {
      binary: process.execPath,
      inactivityTimeoutMs: 5_000,
      maxRuntimeMs: 5_000,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 50);

    await expect(execution).rejects.toThrow('cancelled by test');
  });
});

function expectStrictObjectSchemas(schema: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;

  const value = schema as Record<string, unknown>;
  if (value.type === 'object' && value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
    const propertyNames = Object.keys(value.properties as Record<string, unknown>).sort();
    expect(Array.isArray(value.required) ? [...value.required].sort() : value.required).toEqual(propertyNames);
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      child.forEach(expectStrictObjectSchemas);
    } else {
      expectStrictObjectSchemas(child);
    }
  }
}
