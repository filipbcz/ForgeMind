export const nativeToolServerInstructions = [
  'This server exposes the task-authorized writable leased Git checkout.',
  'The outer Codex shell sandbox does not make these scoped tools read-only.',
  'Use write_file for source files and run_unreal_authoring for Unreal assets.',
  'Use run_unreal_authoring with tool=unreal-build for Unreal Editor target compilation; never invoke Build.bat or UnrealBuildTool through run_process.',
  'A leased task already passed its required capability probes. Do not replace a concrete tool failure with waiting_for_capability.',
  'Before reporting a write-access blocker, call the relevant write tool and report its concrete error.'
].join(' ');

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } as const;
const reversibleWriteAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export const nativeToolDefinitions = [
  { name: 'read_file', title: 'Read checkout file', description: 'Read a UTF-8 file from the exact leased checkout.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'list_directory', title: 'List checkout directory', description: 'List entries inside the exact leased checkout.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'write_file', title: 'Write checkout file', description: 'Create or replace a UTF-8 file inside the writable leased Git checkout. Changes remain local and reviewable.',
    annotations: { ...reversibleWriteAnnotations, idempotentHint: true },
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false } },
  { name: 'remove_path', title: 'Remove checkout path', description: 'Remove a file or directory inside the disposable leased checkout.',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'run_process', title: 'Run checkout process', description: 'Run any non-Unreal PowerShell, cmd, or project command in the writable leased checkout without an approval or command profile. UnrealEditor and UnrealBuildTool must be invoked through run_unreal_authoring so the probed toolchain and reliable arguments are enforced. Returns separate complete redacted stdout and stderr.',
    annotations: reversibleWriteAnnotations,
    inputSchema: { type: 'object', required: ['checkId', 'command', 'shell'], properties: { checkId: { type: 'string' }, command: { type: 'string' }, shell: { type: 'string', enum: ['powershell', 'cmd', 'system'] } }, additionalProperties: false } },
  { name: 'run_unreal_authoring', title: 'Run Unreal authoring', description: 'Use the runner-probed Unreal installation in the writable leased checkout. Reliable editor automation flags are added automatically. Use tool=unreal-build with target=<Project>Editor, platform=Win64, and configuration=Development to compile the Editor target without exposing arbitrary host execution.',
    annotations: reversibleWriteAnnotations,
    inputSchema: { type: 'object', required: ['checkId', 'tool', 'phase', 'projectRelativePath', 'args', 'sourceRelativePaths'], properties: {
      checkId: { type: 'string' }, tool: { type: 'string', enum: ['unreal-editor', 'unreal-python', 'unreal-build', 'project-script', 'cpp-tool'] }, phase: { type: 'string', enum: ['author', 'verify', 'build', 'cook', 'package'] }, executablePath: { type: 'string' }, projectRelativePath: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, sourceRelativePaths: { type: 'array', items: { type: 'string' } }, target: { type: 'string' }, platform: { type: 'string', enum: ['Win64'] }, configuration: { type: 'string', enum: ['Development', 'DebugGame'] }
    }, additionalProperties: false } }
] as const;
