import path from 'node:path';
import fs from 'fs-extra';

import type { CommandExecutionContext } from '../../src/commands/runtime.js';
import type { PluginMeta } from '../../src/types.js';
import { runPreApplyScript, type PluginProcessRunner } from '../../src/utils/plugin-scripts.js';

async function main(): Promise<void> {
  const [pluginRoot, awHome, continuedPath, cleanupFailureReadyPath] = process.argv.slice(2);
  if (!pluginRoot || !awHome || !continuedPath) throw new Error('Missing preApply interrupt fixture arguments.');

  const plugin: PluginMeta = {
    sourceId: 'local',
    pluginId: 'local/demo',
    rootDir: pluginRoot,
    manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest: {
      schemaVersion: 3,
      name: 'demo',
      version: '1.0.0',
      description: 'preApply interrupt fixture',
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      scripts: { preApply: { path: './scripts/preApply.mjs', timeoutMs: 30_000 } },
    },
  };

  const runner: PluginProcessRunner | undefined = cleanupFailureReadyPath ? {
    async run(_invocation, options) {
      await fs.outputFile(cleanupFailureReadyPath, 'ready\n');
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('synthetic cleanup failure')), { once: true });
      });
    },
  } : undefined;
  await runPreApplyScript({
    plugin,
    platform: 'codex',
    scope: 'user',
    cwd: pluginRoot,
    context: {
      env: {
        AW_HOME: awHome,
        CODEX_HOME: path.join(awHome, 'codex-home'),
        CLAUDE_CONFIG_DIR: path.join(awHome, 'claude-home'),
        PATH: process.env.PATH,
      },
    } as CommandExecutionContext,
    runner,
  });
  await fs.outputFile(continuedPath, 'continued\n');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
