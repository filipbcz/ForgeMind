import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@forgemind/config': fileURLToPath(new URL('../config/src/index.ts', import.meta.url)),
      '@forgemind/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url))
    }
  }
});
