import { describe, expect, it } from 'vitest';
import { legacyTaskExecutionIntent, normalizeTaskExecutionIntent } from './task-execution.js';

describe('task execution intent', () => {
  it('keeps acquisition and persistent data requirements task-scoped', () => {
    const intent = normalizeTaskExecutionIntent({
      executor: 'windows',
      requiredCapabilities: ['windows', 'https-download', 'disk-capacity', 'pdal'],
      artifactKinds: ['persistent-data', 'validation-evidence'],
      networkAccess: 'https',
      requiresUnrealAuthoring: false,
      persistentOutputPaths: ['flying/regions/prague-v1'],
      minimumFreeSpaceBytes: 10_000_000_000
    });
    expect(intent).toMatchObject({
      executor: 'windows', networkAccess: 'https', requiresUnrealAuthoring: false,
      persistentOutputPaths: ['flying/regions/prague-v1']
    });
    expect(intent?.artifactKinds).not.toContain('unreal-assets');
  });

  it('rejects contradictory authoring, network, and persistence declarations', () => {
    const base = {
      executor: 'windows', requiredCapabilities: ['windows'], artifactKinds: ['repository'], networkAccess: 'none',
      requiresUnrealAuthoring: false, persistentOutputPaths: [], minimumFreeSpaceBytes: 0
    };
    expect(normalizeTaskExecutionIntent({ ...base, requiresUnrealAuthoring: true })).toBeUndefined();
    expect(normalizeTaskExecutionIntent({ ...base, networkAccess: 'https' })).toBeUndefined();
    expect(normalizeTaskExecutionIntent({ ...base, artifactKinds: ['repository', 'persistent-data'] })).toBeUndefined();
    expect(normalizeTaskExecutionIntent({ ...base, persistentOutputPaths: ['../escape'] })).toBeUndefined();
    expect(normalizeTaskExecutionIntent({ ...base, persistentOutputPaths: ['.'] })).toBeUndefined();
    expect(normalizeTaskExecutionIntent({ ...base, persistentOutputPaths: ['bad//path'] })).toBeUndefined();
    expect(normalizeTaskExecutionIntent({ ...base, minimumFreeSpaceBytes: 1 })).toBeUndefined();
  });

  it('preserves legacy project defaults only for tasks created before task-scoped intent', () => {
    expect(legacyTaskExecutionIntent({ implementationOwner: 'windows', requiredCapabilities: ['gpu'], requiresUnrealAssets: true }))
      .toMatchObject({
        executor: 'windows', requiredCapabilities: ['windows', 'unreal', 'git-lfs', 'gpu'],
        artifactKinds: ['repository', 'unreal-assets'], requiresUnrealAuthoring: true
      });
    expect(legacyTaskExecutionIntent({ implementationOwner: 'linux', requiresUnrealAssets: true }))
      .toMatchObject({ executor: 'linux', artifactKinds: ['repository'], requiresUnrealAuthoring: false });
  });
});
