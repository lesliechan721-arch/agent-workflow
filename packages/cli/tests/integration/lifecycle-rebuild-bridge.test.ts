import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  runRebuildCommand,
  type RebuildCommandRuntime,
} from '../../src/commands/rebuild-command.js';
import type { RebuildCommand } from '../../src/commands/rebuild-operations.js';
import type { CatalogResolution } from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

type LegacyCommandOptions = Parameters<typeof runRebuildCommand>[0]['commandOptions'];

function runLegacyPipeline(
  command: RebuildCommand,
  pluginNames: string[],
  commandOptions: LegacyCommandOptions,
  runtime: RebuildCommandRuntime,
) {
  return runRebuildCommand({ command, pluginNames, commandOptions, runtime });
}

const installWriteCommand = (plugins: string[], options: LegacyCommandOptions, runtime: RebuildCommandRuntime) =>
  runLegacyPipeline('install', plugins, options, runtime);
const upgradeWriteCommand = (plugins: string[], options: LegacyCommandOptions, runtime: RebuildCommandRuntime) =>
  runLegacyPipeline('upgrade', plugins, options, runtime);
const reinstallWriteCommand = (plugins: string[], options: LegacyCommandOptions, runtime: RebuildCommandRuntime) =>
  runLegacyPipeline('reinstall', plugins, options, runtime);
const uninstallWriteCommand = (plugins: string[], options: LegacyCommandOptions, runtime: RebuildCommandRuntime) =>
  runLegacyPipeline('uninstall', plugins, options, runtime);
const cleanupWriteCommand = (plugins: string[], options: LegacyCommandOptions, runtime: RebuildCommandRuntime) =>
  runLegacyPipeline('cleanup', plugins, options, runtime);

interface LifecycleLogEntry {
  event: 'install' | 'upgrade' | 'uninstall';
  plugin: string;
  sourceId: string;
  sourceIdentity: string;
  pluginId: string;
  version: string;
  rootDir: string;
  artifacts: Array<{
    kind: string;
    platform: string;
    path: string;
  }>;
}

const lifecycleScript = [
  "import path from 'node:path';",
  "import { appendFile, readFile } from 'node:fs/promises';",
  'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, \'utf8\'));',
  'await appendFile(path.join(context.cwd, \'lifecycle-events.jsonl\'), `${JSON.stringify({',
  '  event: context.event,',
  '  plugin: context.plugin.name,',
  '  sourceId: context.plugin.sourceId,',
  '  sourceIdentity: context.plugin.sourceIdentity,',
  '  pluginId: context.plugin.pluginId,',
  '  version: context.plugin.version,',
  '  rootDir: context.plugin.rootDir,',
  '  artifacts: context.artifacts,',
  '})}\\n`);',
  "if (context.plugin.name === 'timeout-plugin') {",
  '  await new Promise((resolve) => setTimeout(resolve, 5_000));',
  '}',
  '',
].join('\n');

async function writePlugin(options: {
  catalogRoot: string;
  name: string;
  version: string;
}): Promise<string> {
  const pluginRoot = path.join(options.catalogRoot, 'plugins', options.name);
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), lifecycleScript);
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    name: options.name,
    version: options.version,
    description: `${options.name} lifecycle bridge fixture`,
    schemaVersion: 2,
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    },
    scripts: {
      timeoutMs: 4_000,
      lifecycle: {
        install: { default: { runner: 'node', path: './scripts/lifecycle.mjs' } },
        upgrade: { default: { runner: 'node', path: './scripts/lifecycle.mjs' } },
        uninstall: { default: { runner: 'node', path: './scripts/lifecycle.mjs' } },
      },
    },
    extensions: {
      instructions: [{
        name: 'bridge-rule',
        title: 'Bridge rule',
        content: `Lifecycle bridge ${options.version}.`,
      }],
    },
  });
  return pluginRoot;
}

async function readLifecycleLog(logPath: string): Promise<LifecycleLogEntry[]> {
  if (!await fs.pathExists(logPath)) return [];
  return (await fs.readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleLogEntry);
}

describe('rebuild lifecycle bridge', () => {
  it('bridges real lifecycle context through active snapshots and command boundaries', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const catalogRoot = path.join(isolation.layout.rootDir, 'lifecycle-bridge-catalog');
    const pluginRoot = await writePlugin({
      catalogRoot,
      name: 'lifecycle-bridge',
      version: '1.0.0',
    });
    const canonicalPluginRoot = await fs.realpath(pluginRoot);
    await writePlugin({
      catalogRoot,
      name: 'timeout-plugin',
      version: '1.0.0',
    });
    const logPath = path.join(cwd, 'lifecycle-events.jsonl');
    await fs.remove(logPath);

    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.command === 'codex' && invocation.args[0] === '--version') {
        return { exitCode: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
      }
      throw new Error(
        `Codex project lifecycle bridge made an unexpected native call: ${invocation.command} ${invocation.args.join(' ')}`,
      );
    };
    const runtime = {
      env: isolation.env,
      nativeCliRunner: runner,
      catalogResolution: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      bypassDependencyPlan: true,
      namespacedSource: {
        sourceId: 'official',
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        marketplaceName: 'aw',
        marketplaceRoot: path.join(isolation.env.AW_HOME!, 'marketplaces', 'official'),
      },
    };
    const options = { cwd, platform: 'codex', scope: 'project' } as const;

    await expect(installWriteCommand(['lifecycle-bridge'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    let events = await readLifecycleLog(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'install',
      plugin: 'lifecycle-bridge',
      sourceId: 'official',
      pluginId: 'official/lifecycle-bridge',
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      version: '1.0.0',
      rootDir: canonicalPluginRoot,
      artifacts: [expect.objectContaining({ kind: 'instruction', platform: 'codex' })],
    });

    await writePlugin({
      catalogRoot,
      name: 'lifecycle-bridge',
      version: '2.0.0',
    });
    await expect(upgradeWriteCommand(['lifecycle-bridge'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    events = await readLifecycleLog(logPath);
    expect(events.at(-1)).toMatchObject({
      event: 'upgrade',
      sourceId: 'official',
      pluginId: 'official/lifecycle-bridge',
      version: '2.0.0',
      rootDir: canonicalPluginRoot,
    });

    const beforeReinstall = events.length;
    await expect(reinstallWriteCommand(['lifecycle-bridge'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    events = await readLifecycleLog(logPath);
    expect(events.slice(beforeReinstall).map((entry) => entry.event)).toEqual(['install']);

    const beforeCleanup = events.length;
    await expect(cleanupWriteCommand(['lifecycle-bridge'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    expect(await readLifecycleLog(logPath)).toHaveLength(beforeCleanup);

    await expect(installWriteCommand(['lifecycle-bridge'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(uninstallWriteCommand(['lifecycle-bridge'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    events = await readLifecycleLog(logPath);
    const uninstall = events.at(-1)!;
    expect(uninstall.event).toBe('uninstall');
    expect(uninstall.pluginId).toBe(`${uninstall.sourceId}/${uninstall.plugin}`);
    expect(uninstall.pluginId).toBe('official/lifecycle-bridge');
    expect(uninstall.version).toBe('2.0.0');
    expect(uninstall.rootDir).not.toBe(canonicalPluginRoot);
    expect(uninstall.rootDir).toMatch(/lifecycle-active.*active[/\\]bundle/u);
    expect(uninstall.artifacts).toEqual([
      expect.objectContaining({ kind: 'instruction', platform: 'codex' }),
    ]);

    const timeout = await installWriteCommand(
      ['timeout-plugin'],
      { ...options, scriptTimeoutMs: 1_000 },
      {
        ...runtime,
        namespacedSource: {
          ...runtime.namespacedSource,
          pluginId: 'official/timeout-plugin',
        },
      },
    );
    expect(timeout).toMatchObject({
      overallState: 'failed',
      rebuildResults: [{
        status: 'failed',
        error: {
          phase: 'lifecycle.install',
          message: expect.stringContaining('timed out after 1000 ms'),
        },
      }],
    });
  });

});
