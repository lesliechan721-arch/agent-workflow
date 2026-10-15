import { vitestWorkerOptions } from './scripts/test-workers.mjs';

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const pureTests = [
  'tests/unit/command-options.test.ts',
  'tests/unit/command-receipt.test.ts',
  'tests/unit/hooks-contract.test.ts',
  'tests/unit/platform-support.test.ts',
  'tests/unit/template-engine.test.ts',
];
const processTests = [
  'tests/unit/process-tree.test.ts',
  'tests/unit/native-cli.test.ts',
  'tests/unit/plugin-scripts.test.ts',
  'tests/unit/artifact-renderer.test.ts',
  'tests/unit/process-lock.test.ts',
  'tests/integration/aw-home-mutation-command-lock.test.ts',
];
const distContractTests = [
  'tests/integration/authoring-tools.test.ts',
];
const common = {
  environment: 'node' as const,
  testTimeout: 15_000,
  hookTimeout: 15_000,
  coverage: {
    reporter: ['text', 'html'] as const,
  },
};

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
    ...vitestWorkerOptions(),
    projects: [
      {
        extends: true,
        test: {
          ...common,
          name: 'pure',
          include: pureTests,
          setupFiles: ['tests/setup/test-isolation-pure.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: 'filesystem-isolated',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          exclude: [...pureTests, ...processTests],
          setupFiles: ['tests/setup/test-isolation.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: 'integration',
          include: ['tests/integration/**/*.test.{ts,tsx}'],
          exclude: [...processTests, ...distContractTests],
          setupFiles: ['tests/setup/test-isolation.ts'],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          ...common,
          name: 'process-lifecycle',
          include: processTests,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          setupFiles: ['tests/setup/test-isolation.ts'],
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
