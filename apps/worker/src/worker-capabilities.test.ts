import { describe, expect, it } from 'vitest';
import { missingValidationCapabilities, requiredValidationCapabilities, resolveWorkerCapabilities } from './worker-capabilities.js';

describe('worker capabilities', () => {
  it('combines the platform capability with normalized configured capabilities', () => {
    expect(resolveWorkerCapabilities({ FORGEMIND_WORKER_CAPABILITIES: 'Unreal-Engine-5.8, CESIUM-FOR-UNREAL' }, 'linux'))
      .toEqual(new Set(['linux', 'unreal-engine-5.8', 'cesium-for-unreal']));
  });

  it('conservatively infers legacy Win64 Unreal runtime checks', () => {
    const check = { kind: 'command' as const, command: 'python tools/validate_unreal_cesium_shell.py --require-unreal-build-run' };
    expect(requiredValidationCapabilities(check)).toEqual(['windows']);
    expect(missingValidationCapabilities(check, new Set(['linux']))).toEqual(['windows']);
  });
});
