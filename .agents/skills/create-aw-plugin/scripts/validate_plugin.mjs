#!/usr/bin/env node

if (process.env.VITEST_WORKER_ID) {
  await import('../../../../packages/cli/authoring/scripts/validate-plugin.mjs');
} else {
  process.argv.splice(2, 0, 'validate');
  await import('./run-aw-plugin-command.mjs');
}
