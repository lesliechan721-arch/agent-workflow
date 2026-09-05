import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@lesliechan721\/aw-plugin-core\/manifest$/u,
        replacement: fileURLToPath(new URL('../plugin-core/src/manifest.ts', import.meta.url)),
      },
      {
        find: /^@lesliechan721\/aw-plugin-core$/u,
        replacement: fileURLToPath(new URL('../plugin-core/src/index.ts', import.meta.url)),
      },
      {
        find: /^@lesliechan721\/agent-skill-eval$/u,
        replacement: fileURLToPath(new URL('../agent-skill-eval/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: [
      'tests/unit/command-options.test.ts',
      'tests/unit/command-receipt.test.ts',
      'tests/unit/hooks-contract.test.ts',
      'tests/unit/platform-support.test.ts',
      'tests/unit/template-engine.test.ts',
    ],
    setupFiles: ['tests/setup/test-isolation-pure.ts'],
    maxWorkers: 4,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
