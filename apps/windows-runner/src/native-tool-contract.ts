export const nativeToolServerInstructions = [
  'This server exposes the task-authorized writable leased Git checkout.',
  'The outer Codex shell sandbox does not make these scoped tools read-only.',
  'Use write_file for source files and run_unreal_authoring for Unreal assets.',
  'Use run_unreal_authoring with tool=unreal-build for Unreal Editor target compilation; never invoke Build.bat or UnrealBuildTool through run_process.',
  'Use fetch_https for resumable audited public downloads, materialize_managed_path to bring a managed input into the disposable checkout, and publish_project_output for durable project data.',
  'Raw datasets, caches, downloads, and generated regional data do not belong in Git; publish durable results through publish_project_output.',
  'A leased task already passed its required capability probes. Do not replace a concrete tool failure with waiting_for_capability.',
  'Before reporting a write-access blocker, call the relevant write tool and report its concrete error.'
].join(' ');

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } as const;
const reversibleWriteAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export const nativeToolDefinitions = [
  { name: 'list_capabilities', title: 'List probed capabilities', description: 'Return the exact locally probed capabilities, versions, and executable metadata for this leased Windows task.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'read_file', title: 'Read checkout file', description: 'Read a UTF-8 file up to 1 MB from the exact leased checkout. Use a bounded project command for targeted inspection of larger files.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'list_directory', title: 'List checkout directory', description: 'List up to 1000 entries inside the exact leased checkout.',
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
    }, additionalProperties: false } },
  { name: 'list_managed_files', title: 'List managed files', description: 'List bounded metadata from a persistent runner-managed input, source, cache, output, or project-data root.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', required: ['root'], properties: {
      root: { type: 'string', enum: ['inputs', 'source-assets', 'cache', 'outputs', 'project-data'] },
      path: { type: 'string' }, recursive: { type: 'boolean' }
    }, additionalProperties: false } },
  { name: 'read_managed_text', title: 'Read managed text', description: 'Read a bounded UTF-8 manifest or report from a runner-managed root without copying large data into the checkout.',
    annotations: readOnlyAnnotations,
    inputSchema: { type: 'object', required: ['root', 'path'], properties: {
      root: { type: 'string', enum: ['inputs', 'source-assets', 'cache', 'outputs', 'project-data'] }, path: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'fetch_https', title: 'Fetch HTTPS source', description: 'Download a public HTTPS resource into persistent source assets with resume, free-space guard, SHA-256, and provenance. Redirects to local/private addresses and credential-bearing URLs are rejected.',
    annotations: { ...reversibleWriteAnnotations, openWorldHint: true },
    inputSchema: { type: 'object', required: ['url', 'destinationRelativePath', 'maxBytes', 'minimumFreeSpaceBytes'], properties: {
      url: { type: 'string' }, destinationRelativePath: { type: 'string' }, expectedSha256: { type: 'string' },
      maxBytes: { type: 'integer', minimum: 1 }, minimumFreeSpaceBytes: { type: 'integer', minimum: 0 }
    }, additionalProperties: false } },
  { name: 'materialize_managed_path', title: 'Materialize managed input', description: 'Copy a managed input or source into the disposable checkout temporary area so sandboxed project tools can process it. The copy is excluded from Git results.',
    annotations: reversibleWriteAnnotations,
    inputSchema: { type: 'object', required: ['root', 'sourceRelativePath', 'checkoutRelativePath'], properties: {
      root: { type: 'string', enum: ['inputs', 'source-assets', 'cache', 'project-data'] }, sourceRelativePath: { type: 'string' }, checkoutRelativePath: { type: 'string' }
    }, additionalProperties: false } },
  { name: 'publish_project_output', title: 'Publish project output', description: 'Atomically copy a checkout file or directory into durable project data and return a bounded content identity. Existing output from another task is never overwritten; publish a new versioned destination. Use this for large generated data that must survive task cleanup.',
    annotations: reversibleWriteAnnotations,
    inputSchema: { type: 'object', required: ['checkoutRelativePath', 'destinationRelativePath'], properties: {
      checkoutRelativePath: { type: 'string' }, destinationRelativePath: { type: 'string' }
    }, additionalProperties: false } }
] as const;
