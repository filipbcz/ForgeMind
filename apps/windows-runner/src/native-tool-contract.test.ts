import { describe, expect, it } from 'vitest';
import { nativeToolDefinitions, nativeToolServerInstructions } from './native-tool-contract.js';

describe('native authoring MCP contract', () => {
  it('tells Codex that the leased checkout is writable through scoped tools', () => {
    expect(nativeToolServerInstructions).toContain('writable leased Git checkout');
    expect(nativeToolServerInstructions).toContain('call the relevant write tool');
  });

  it('annotates reads and reversible checkout writes accurately', () => {
    expect(nativeToolDefinitions.find(({ name }) => name === 'read_file')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(nativeToolDefinitions.find(({ name }) => name === 'write_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(nativeToolDefinitions.find(({ name }) => name === 'run_unreal_authoring')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(nativeToolDefinitions.find(({ name }) => name === 'remove_path')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });
});
