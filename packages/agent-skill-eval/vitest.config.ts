import { defineConfig } from 'vitest/config'

const pureTests = [
  'tests/unit/codex-trigger-eval.test.ts',
  'tests/unit/eval-process-management.test.ts',
]
const processTests = [
  'tests/unit/codex-eval-app-server.test.ts',
  'tests/unit/codex-eval-isolation.test.ts',
  'tests/unit/codex-workflow.test.ts',
  'tests/unit/core.test.ts',
  'tests/unit/phase3-run.test.ts',
  'tests/unit/process.test.ts',
  'tests/unit/stage2-providers.test.ts',
]
const common = {
  environment: 'node' as const,
  testTimeout: 15_000,
  hookTimeout: 15_000,
}

export default defineConfig({
  test: {
    maxWorkers: 2,
    minWorkers: 1,
    projects: [
      {
        test: {
          ...common,
          name: 'pure',
          include: pureTests,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...common,
          name: 'filesystem-isolated',
          include: ['tests/unit/**/*.test.ts'],
          exclude: [...pureTests, ...processTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...common,
          name: 'process-lifecycle',
          include: processTests,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
