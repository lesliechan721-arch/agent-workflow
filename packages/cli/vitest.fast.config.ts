import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/command-options.test.ts',
      'tests/unit/command-receipt.test.ts',
      'tests/unit/console-model.test.ts',
      'tests/unit/hooks-contract.test.ts',
      'tests/unit/platform-support.test.ts',
      'tests/unit/plugin-dependency-graph.test.ts',
      'tests/unit/plugin-dependency-planner.test.ts',
      'tests/unit/release-common-error-classification.test.ts',
      'tests/unit/template-engine.test.ts',
    ],
    setupFiles: ['tests/setup/test-isolation.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
