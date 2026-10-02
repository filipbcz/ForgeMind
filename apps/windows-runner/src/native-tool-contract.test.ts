import { describe, expect, it } from 'vitest';
import { nativeToolDefinitions, nativeToolServerInstructions } from './native-tool-contract.js';

describe('native authoring MCP contract', () => {
  it('tells Codex that the leased checkout is writable through scoped tools', () => {
    expect(nativeToolServerInstructions).toContain('writable leased Git checkout');
    expect(nativeToolServerInstructions).toContain('call the relevant write tool');
    expect(nativeToolServerInstructions).toContain('tool=unreal-build');
    expect(nativeToolServerInstructions).toContain('Do not replace a concrete tool failure with waiting_for_capability');
  });

  it('annotates reads and reversible checkout writes accurately', () => {
    expect(nativeToolDefinitions.find(({ name }) => name === 'read_file')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(nativeToolDefinitions.find(({ name }) => name === 'write_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(nativeToolDefinitions.find(({ name }) => name === 'run_unreal_authoring')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(nativeToolDefinitions.find(({ name }) => name === 'remove_path')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });

  it('offers a constrained Unreal build operation', () => {
    const definition = nativeToolDefinitions.find(({ name }) => name === 'run_unreal_authoring');
    const properties = definition?.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(properties.tool?.enum).toContain('unreal-build');
    expect(properties.platform?.enum).toEqual(['Win64']);
  });
});
