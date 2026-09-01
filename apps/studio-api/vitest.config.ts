import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test'
    }
  },
  resolve: {
    alias: {
      '@forgemind/config': fileURLToPath(new URL('../../packages/config/src/index.ts', import.meta.url)),
      '@forgemind/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@forgemind/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      '@forgemind/github': fileURLToPath(new URL('../../packages/github/src/index.ts', import.meta.url)),
      '@forgemind/providers': fileURLToPath(new URL('../../packages/providers/src/index.ts', import.meta.url)),
      '@forgemind/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))
    }
  }
});
