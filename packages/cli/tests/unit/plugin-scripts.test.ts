import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { PluginMeta } from '../../src/types.js';
import {
  runPostApplyScript,
  type PluginProcessRunner,
  type PluginScriptInvocation,
} from '../../src/utils/plugin-scripts.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

async function createPlugin(options: { sensitiveDefault?: string } = {}): Promise<PluginMeta> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-post-apply-'));
  tempDirs.push(rootDir);
  await fs.outputFile(path.join(rootDir, 'scripts', 'postApply.mjs'), 'process.stdin.resume();\n');
  return {
    sourceId: 'local',
    pluginId: 'local/demo',
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      schemaVersion: 3,
      name: 'demo',
      version: '1.0.0',
      description: 'postApply fixture',
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      scripts: { postApply: { path: './scripts/postApply.mjs', timeoutMs: 2_000 } },
      ...(options.sensitiveDefault ? {
        config: { fields: { token: { type: 'string', writableLayers: ['user', 'project'], sensitive: true, default: options.sensitiveDefault } } },
      } : {}),
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('postApply script', () => {
  it('uses only user config for a user target', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'default-value' });
    const sourceIdentity = `sha256:${'4'.repeat(64)}`;
    plugin.sourceIdentity = sourceIdentity;
    const cwd = path.join(plugin.rootDir, 'project');
    const env = { AW_HOME: path.join(plugin.rootDir, 'aw-home') };
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity,
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'user-value' },
    });
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity,
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: { token: 'project-value' },
    });
    let invocation: PluginScriptInvocation | undefined;
    await runPostApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      context: createCommandExecutionContext({ env }),
      artifacts: [],
      runner: { async run(value) {
        invocation = value;
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      } },
    });

    expect(JSON.parse(invocation?.stdin ?? '{}').config.values).toEqual({ token: 'user-value' });
  });

  it('runs fixed Node in the plugin root and sends the minimal v1 context on stdin', async () => {
    const plugin = await createPlugin();
    let invocation: PluginScriptInvocation | undefined;
    const runner: PluginProcessRunner = {
      async run(value) {
        invocation = value;
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      },
    };
    const cwd = path.join(plugin.rootDir, 'project');
    await runPostApplyScript({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home'), PATH: process.env.PATH } }),
      artifacts: [],
      runner,
    });

    expect(invocation?.command).toBe(process.execPath);
    expect(invocation?.cwd).toBe(plugin.rootDir);
    expect(invocation?.env.HOME).not.toBe(process.env.HOME);
    expect(JSON.parse(invocation?.stdin ?? '{}')).toEqual({
      schemaVersion: 1,
      plugin: { pluginId: 'local/demo', name: 'demo', version: '1.0.0', rootDir: plugin.rootDir },
      target: { platform: 'codex', scope: 'project', projectRoot: cwd },
      config: { values: {} },
      components: [{ kind: 'target', key: 'codex:project', outcome: 'unchanged' }],
    });
  });

  it('reports timeout and redacts sensitive stderr', async () => {
    const plugin = await createPlugin({ sensitiveDefault: 'secret-value' });
    const runner: PluginProcessRunner = {
      async run() {
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: 'secret-value', timedOut: true };
      },
    };
    await expect(runPostApplyScript({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: path.join(plugin.rootDir, 'aw-home') } }),
      artifacts: [],
      runner,
    })).rejects.toThrow('postApply timed out. stderr: [REDACTED]');
  });

  it('reports a non-zero exit without persisting failure state', async () => {
    const plugin = await createPlugin();
    const awHome = path.join(plugin.rootDir, 'aw-home');
    const runner: PluginProcessRunner = {
      async run() {
        return { exitCode: 7, signal: null, stdout: '', stderr: 'failed', timedOut: false };
      },
    };
    await expect(runPostApplyScript({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: plugin.rootDir,
      context: createCommandExecutionContext({ env: { AW_HOME: awHome } }),
      artifacts: [],
      runner,
    })).rejects.toThrow('postApply failed with exit code 7');
    expect(await fs.pathExists(path.join(awHome, 'lifecycle'))).toBe(false);
  });
});
