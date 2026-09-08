import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  projectStatusSharedNativeReasons,
  statusRecovery,
  statusCommandV8,
  statusTargetActivation,
  statusTargetExtensions,
  statusTargetIntent,
  statusTargetSharedNative,
} from '../../src/commands/status-v6.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createSharedOwnerToken, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { type NativeCliRunner, setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';
import { applyCodexConfigTransactionFile } from '../../src/utils/codex-config.js';
import {
  createEmptyPluginIntentState,
  resolvePluginIntentStatePath,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { resolveAwHome, resolveClaudePaths, resolveCodexPaths } from '../../src/utils/paths.js';
import { getCodexHome } from '../../src/utils/state-paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePathSource(
  sourceRoot: string,
  sourceId = 'local',
): Promise<{ env: NodeJS.ProcessEnv; sourceIdentity: string; logicalIdentity: string }> {
  const isolation = getCurrentSourceTestIsolation();
  const source = { id: sourceId, type: 'path', primary: true, path: sourceRoot } as const;
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [source] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({
    sourceId,
    cliVersion: '1.0.0',
    env: isolation.env,
  });
  const active = (await readCatalogGenerationState(isolation.env)).sources[sourceId]?.active;
  if (!active) throw new Error(`Missing Active Catalog generation for ${sourceId}.`);
  return {
    env: { ...isolation.env, PATH: '' },
    sourceIdentity: await calculateCatalogSourceIdentity(source),
    logicalIdentity: active.logicalIdentity,
  };
}

async function filesystemSnapshot(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file';
  content?: string;
}>> {
  if (!await fs.pathExists(root)) return [];
  const output: Array<{ path: string; type: 'directory' | 'file'; content?: string }> = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        output.push({ path: relative, type: 'directory' });
        pending.push(entryPath);
      } else if (entry.isFile()) {
        output.push({ path: relative, type: 'file', content: await fs.readFile(entryPath, 'utf8') });
      }
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeCodexNativeResidue(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  userEnabled: boolean;
  sourceIdentity: string;
  pluginName?: string;
}): Promise<void> {
  const marketplaceRoot = path.join(resolveAwHome(options.env), 'marketplaces', 'local');
  const marketplaceName = 'aw-local';
  const pluginName = options.pluginName ?? 'demo';
  await fs.ensureDir(marketplaceRoot);
  await Promise.all([
    fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'local',
      sourceIdentity: options.sourceIdentity,
      marketplaceName,
    }),
    fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: marketplaceName, owner: {}, interface: {}, plugins: [],
    }),
  ]);
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  await fs.outputFile(configPath, [
    `[marketplaces.${marketplaceName}]`,
    `source = ${JSON.stringify(marketplaceRoot)}`,
    'source_type = "local"',
    `[plugins."${pluginName}@${marketplaceName}"]`,
    `enabled = ${String(options.userEnabled)}`,
    '',
  ].join('\n'));
  await fs.outputJson(path.join(
    getCodexHome(options.env),
    'plugins', 'cache', marketplaceName, pluginName, options.version, 'plugin.json',
  ), { name: pluginName, version: options.version });
}

function withCodexVersion(runner: NativeCliRunner, version = '0.151.0'): NativeCliRunner {
  return async (invocation) => invocation.args.at(-1) === '--version'
    ? { exitCode: 0, stdout: `codex-cli ${version}`, stderr: '' }
    : runner(invocation);
}

async function writeSystemCodexPackage(options: {
  root: string;
  version: string;
  packageName?: string;
}): Promise<string> {
  const binRoot = process.platform === 'win32'
    ? options.root
    : path.join(options.root, 'bin');
  const packageRoot = process.platform === 'win32'
    ? path.join(binRoot, 'node_modules', '@openai', 'codex')
    : path.join(options.root, 'lib', 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await Promise.all([
    fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: options.packageName ?? '@openai/codex',
      version: options.version,
      bin: { codex: 'bin/codex.js' },
    }),
    fs.outputFile(launcher, [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'status-executed'), 'executed');",
      '',
    ].join('\n')),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform === 'win32') {
    await fs.outputFile(path.join(binRoot, 'codex.CMD'), '@echo off\r\n');
  } else {
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
  }
  return binRoot;
}

describe('status v8 current behavior', () => {
  it('publishes a non-blocking warning for an ignored native project config override', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-config-warning-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'),
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.config = { fields: { mode: { type: 'string', title: '模式', default: 'default' } } };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'native-skill',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'native-skill',
        }],
      };
    });
    const { env, sourceIdentity, logicalIdentity } = await configurePathSource(sourceRoot);
    await writePluginConfigStore({
      sourceId: 'local', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env, values: { mode: 'user' },
    });
    await writePluginConfigStore({
      sourceId: 'local', sourceIdentity, logicalIdentity, pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env, values: { mode: 42 },
    });

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env, json: true,
    });
    const output = JSON.parse(result.output);

    expect(result.hasErrors).toBe(false);
    expect(result.payload.targets.every((target) => target.state !== 'blocked')).toBe(true);
    expect(output.configIssues).toEqual([{
      pluginId: 'local/demo',
      pluginName: 'demo',
      scope: 'project',
      type: 'configLayerUnsupported',
      key: 'mode',
      title: '模式',
      source: 'project',
    }]);
  });

  it.each([
    { label: 'an empty product list on Codex', products: [] as string[], platform: 'codex' as const },
    { label: 'an empty product list on Claude', products: [] as string[], platform: 'claude' as const },
    { label: 'a lowercase Codex token', products: ['codex'], platform: 'codex' as const },
    { label: 'a lowercase Claude token', products: ['claude'], platform: 'claude' as const },
  ])(
    'keeps desired dependency placement and capability blockers visible for $label',
    async ({ products, platform }) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `product-support-${platform}-${products.join('-') || 'empty'}`,
      );
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        {
          name: 'leaf',
          requiredCapabilities: ['aw.future-status-capability.v1'],
          configureManifest: (manifest) => {
            manifest.marketplace.policy.products = products;
          },
        },
        {
          name: 'root',
          dependencies: ['leaf'],
          configureManifest: (manifest) => {
            manifest.marketplace.policy.products = products;
          },
        },
      ]);
      const { env } = await configurePathSource(sourceRoot);
      await writePluginIntentState({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env,
      }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/root', platforms: [platform] }],
      });

      const result = await statusCommandV8({
        plugins: ['local/leaf'], cwd: isolation.layout.fixtureCwd, env,
        platform, scope: 'project', json: true,
      });

      expect(result.payload.targets).toEqual([expect.objectContaining({
        pluginId: 'local/leaf',
        platform,
        state: 'blocked',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'awCapabilityUnsupported' }),
        ]),
      })]);
      const target = result.payload.targets[0]!;
      const placement = target.platform === 'codex' ? target.placements[0]! : target;
      expect(statusTargetIntent(placement)).toEqual({
        enabled: true, scopes: ['project'], relation: 'dependency',
      });
      expect(result.pluginSummaries.find((plugin) => plugin.pluginId === 'local/leaf')?.supportedTargets)
        .toMatchObject({ [platform]: ['user', 'project'] });
    },
  );

  it('preserves render drift as a recoverable shared-native status reason', () => {
    const target = {
      components: [{
        kind: 'sharedNative',
        key: 'demo@aw-local',
        state: 'replaceable',
        metadata: { reason: 'renderDrift', diagnostic: 'projectionRenderDrift' },
      }],
    } as Parameters<typeof statusTargetSharedNative>[0];
    expect(statusTargetSharedNative(target)).toEqual({
      pluginId: 'demo@aw-local',
      state: 'replaceable',
      reason: 'renderDrift',
      diagnostic: 'projectionRenderDrift',
    });
    expect(projectStatusSharedNativeReasons({
      pluginId: 'demo@aw-local',
      state: 'replaceable',
      reason: 'renderDrift',
      diagnostic: 'projectionRenderDrift',
    })).toEqual([{
      code: 'codexSharedNativeRenderDrift',
      message: 'codexSharedNativeRenderDrift: demo@aw-local shared generated content does not match the current render inputs and can be replaced.',
      severity: 'warning',
    }]);
  });

  it('reports damaged shared generated content separately from render drift', () => {
    expect(projectStatusSharedNativeReasons({
      pluginId: 'demo@aw-local',
      state: 'replaceable',
      reason: 'damaged',
      diagnostic: 'projectionReceiptMissing',
    })).toEqual([{
      code: 'codexSharedNativeCorrupt',
      message: 'codexSharedNativeCorrupt: demo@aw-local shared generated content is missing or damaged and can be replaced.',
      severity: 'warning',
    }]);
  });

  it('uses explicit manual recovery for undesired damaged shared content', () => {
    const base = {
      state: 'needsSync' as const,
      desired: { scopes: [], relation: 'none' as const },
      platform: 'codex' as const,
      pluginId: 'local/demo',
      scope: 'project' as const,
      sharedNative: {
        pluginId: 'demo@aw-local',
        state: 'replaceable' as const,
        reason: 'damaged' as const,
      },
    };
    expect(statusRecovery(base)).toEqual([{
      command: 'manual',
      description: '共享内容已损坏。先明确选择 user 或 project 使用范围，再运行 aw install local/demo --platform codex --scope <user|project> 重建。',
    }]);
    expect(statusRecovery({ ...base, actualEnabled: true })).toEqual([
      {
        command: 'cleanup',
        scope: 'project',
        description: '仅清理 project scope 的激活；不会修复或删除损坏的共享内容。',
      },
      {
        command: 'manual',
        description: '共享内容已损坏。先明确选择 user 或 project 使用范围，再运行 aw install local/demo --platform codex --scope <user|project> 重建。',
      },
    ]);
  });

  it('reports a qualified pure-native Codex project target without scoped materialization', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'capability-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env: { ...env, PATH: '' },
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.schemaVersion).toBe(8);
    const target = result.payload.targets[0]!;
    expect(target).toMatchObject({ pluginId: 'local/demo', state: 'absent' });
    expect(target.platform).toBe('codex');
    expect(target.placements).toEqual([expect.objectContaining({
      scope: 'project',
      components: expect.arrayContaining([expect.objectContaining({
      kind: 'ownership', key: 'native', state: 'absent',
      })]),
    })]);
    expect(statusTargetIntent(target.placements[0]!)).toEqual({ enabled: false, scopes: [], relation: 'none' });
    expect(statusTargetSharedNative(target)).toMatchObject({ state: 'unobserved' });
    expect(statusTargetActivation(target)).toEqual({
      evidence: 'assumed',
      systemConsumer: { state: 'missing', requiredMinVersion: '0.151.0' },
    });
    for (const removed of ['desired', 'actual', 'errors', 'recovery', 'sharedNative', 'activation', 'extensions']) {
      expect(target).not.toHaveProperty(removed);
    }
  });

  it('aggregates user and project pure-native intent into one missing shared target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'pure-native-intent-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    for (const scope of ['user', 'project'] as const) {
      await writePluginIntentState({ scope, cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
    }

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toHaveLength(1);
    const target = result.payload.targets[0]!;
    expect(target).toMatchObject({
      state: 'needsSync',
      recoveryActions: expect.arrayContaining([expect.objectContaining({ command: 'sync' })]),
    });
    expect(target.platform).toBe('codex');
    expect(target.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'project' }),
      expect.objectContaining({ scope: 'user' }),
    ]));
    for (const placement of target.placements) {
      expect(statusTargetIntent(placement)).toEqual({
        enabled: true, scopes: [placement.scope], relation: 'root',
      });
    }
    expect(statusTargetSharedNative(target)).toMatchObject({ state: 'unobserved' });
    expect(target.components).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'systemConsumer', key: 'codex:user', state: 'missing',
        metadata: { evidence: 'assumed', requiredMinVersion: '0.145.0' },
      }),
      expect.objectContaining({
        kind: 'systemConsumer', key: 'codex:project', state: 'missing',
        metadata: { evidence: 'assumed', requiredMinVersion: '0.151.0' },
      }),
    ]));
  });

  it('keeps each ready pure-native Codex placement scoped to its own activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'pure-native-ready-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    for (const scope of ['user', 'project'] as const) {
      await writePluginIntentState({ scope, cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
    }
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd, env, version: '1.0.0', userEnabled: true, sourceIdentity,
    });
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      { upsertPluginActivations: { 'demo@aw-local': true } },
    );
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'pure-native-ready-system-prefix'),
      version: '0.151.0',
    });

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...env, PATH: binRoot }, platform: 'codex', json: true,
      nativeCliRunner: withCodexVersion(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [{ pluginId: 'demo@aw-local', installed: true, enabled: true, version: '1.0.0' }],
          available: [],
        }),
        stderr: '',
      })),
    });

    expect(result.payload.targets).toHaveLength(1);
    const target = result.payload.targets[0]!;
    expect(target).toMatchObject({ platform: 'codex', state: 'ready' });
    expect(target).not.toHaveProperty('scope');
    expect(statusTargetSharedNative(target)).toMatchObject({ state: 'usable', version: '1.0.0' });
    expect(target.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'systemConsumer', key: 'codex:user', state: 'compatible' }),
      expect.objectContaining({ kind: 'systemConsumer', key: 'codex:project', state: 'compatible' }),
    ]));

    const placements = new Map(target.placements.map((placement) => [placement.scope, placement]));
    expect([...placements.keys()]).toEqual(['project', 'user']);
    for (const scope of ['user', 'project'] as const) {
      const placement = placements.get(scope)!;
      expect(placement).toMatchObject({ scope, state: 'ready' });
      expect(statusTargetActivation(placement)).toMatchObject({
        [scope]: true,
        effective: true,
        evidence: 'observed',
      });
      expect(placement.components).toContainEqual(expect.objectContaining({
        kind: 'activation', key: scope, state: 'enabled',
      }));
    }
  });

  it.each(['user', 'project'] as const)(
    'keeps an undesired Claude native %s placement orphaned and cleanable',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `claude-orphan-${scope}-source`);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = ['CLAUDE'];
      });
      const { env } = await configurePathSource(sourceRoot);
      const marketplaceRoot = path.join(resolveAwHome(env), 'marketplaces', 'local');
      const marketplaceName = 'aw-local';
      const paths = resolveClaudePaths(isolation.layout.fixtureCwd, scope, env);
      const sourceDescriptor = { source: 'directory', path: marketplaceRoot };
      await Promise.all([
        fs.outputJson(paths.settingsPath, {
          extraKnownMarketplaces: { [marketplaceName]: { source: sourceDescriptor } },
          enabledPlugins: { [`demo@${marketplaceName}`]: true },
        }),
        fs.outputJson(paths.knownMarketplacesPath, {
          [marketplaceName]: { source: sourceDescriptor, installLocation: marketplaceRoot },
        }),
        fs.outputJson(paths.installedPluginsPath, {
          plugins: {
            [`demo@${marketplaceName}`]: [{
              name: 'demo',
              marketplace: marketplaceName,
              scope,
              version: '1.0.0',
              ...(scope === 'project'
                ? { projectPath: await fs.realpath(isolation.layout.fixtureCwd) }
                : {}),
            }],
          },
        }),
      ]);

      const result = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
        platform: 'claude', scope, json: true,
      });

      expect(result.payload.targets).toEqual([expect.objectContaining({
        platform: 'claude',
        scope,
        state: 'orphaned',
        recoveryActions: [{
          command: 'cleanup',
          scope,
          description: '清理可证明属于 AW 的遗留输出。',
        }],
      })]);
    },
  );

  it('separates retained shared native content from actual scope use and dependency checks', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'inactive-shared-native-source');
    await Promise.all(['leaf', 'root'].map((name) =>
      fs.outputJson(path.join(sourceRoot, 'plugins', name, '.app.json'), { apps: {} })));
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.marketplace.policy.products = ['CODEX'];
          manifest.apps = './.app.json';
          delete manifest.extensions;
        },
      },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest) => {
          manifest.marketplace.policy.products = ['CODEX'];
          manifest.apps = './.app.json';
          delete manifest.extensions;
        },
      },
    ]);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd,
      env,
      version: '1.0.0',
      userEnabled: false,
      sourceIdentity,
      pluginName: 'root',
    });
    await fs.outputJson(path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw-local', 'leaf', '1.0.0', 'plugin.json',
    ), { name: 'leaf', version: '1.0.0' });
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'user', env).configTomlPath,
      { upsertPluginActivations: { 'leaf@aw-local': false } },
    );
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      { upsertPluginActivations: { 'root@aw-local': false, 'leaf@aw-local': true } },
    );
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'inactive-shared-native-prefix'),
      version: '0.151.0',
    });
    const nativeRunner = withCodexVersion(vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        installed: ['leaf', 'root'].map((name) => ({
          pluginId: `${name}@aw-local`, installed: true, enabled: true, version: '1.0.0',
        })),
        available: [],
      }),
      stderr: '',
    })));
    const read = () => statusCommandV8({
      plugins: ['local/root'],
      cwd: isolation.layout.fixtureCwd,
      env: { ...env, PATH: binRoot },
      platform: 'codex',
      json: false,
      nativeCliRunner: nativeRunner,
    });

    const inactive = await read();
    expect(inactive.payload.targets).toEqual([expect.objectContaining({
      state: 'absent',
      reasons: [],
      recoveryActions: [],
      placements: [
        expect.objectContaining({ scope: 'project', state: 'absent', recoveryActions: [] }),
        expect.objectContaining({ scope: 'user', state: 'absent', recoveryActions: [] }),
      ],
    })]);
    expect(inactive.payload.targets[0]!.placements.every((placement) =>
      placement.components.every((component) => component.kind !== 'dependency')),
    JSON.stringify(inactive.payload.targets[0], null, 2)).toBe(true);
    expect(statusTargetSharedNative(inactive.payload.targets[0]!)).toMatchObject({
      state: 'usable', version: '1.0.0',
    });
    expect(inactive.output).toContain('desired use: disabled');
    expect(inactive.output).toContain('actual use: disabled');
    expect(inactive.output).toContain('shared content: usable (root@aw-local)');

    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      { upsertPluginActivations: { 'root@aw-local': true } },
    );
    const projectOnly = await read();
    const projectPlacement = projectOnly.payload.targets[0]!.placements.find((placement) =>
      placement.scope === 'project')!;
    expect(projectOnly.payload.targets[0]).toMatchObject({ state: 'orphaned' });
    expect(projectPlacement).toMatchObject({
      state: 'orphaned',
      components: expect.arrayContaining([expect.objectContaining({
        kind: 'dependency', key: 'local/leaf', state: 'ready',
        metadata: expect.objectContaining({ scope: 'project' }),
      })]),
    });
    expect(projectOnly.output).toContain('actual use: project');

    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'user', env).configTomlPath,
      { upsertPluginActivations: { 'root@aw-local': true } },
    );
    const both = await read();
    const userPlacement = both.payload.targets[0]!.placements.find((placement) =>
      placement.scope === 'user')!;
    expect(userPlacement).toMatchObject({
      state: 'orphaned',
      components: expect.arrayContaining([expect.objectContaining({
        kind: 'dependency', key: 'local/leaf', state: 'incomplete',
        metadata: expect.objectContaining({ scope: 'user' }),
      })]),
    });
    expect(both.output).toContain('actual use: user+project');
  });

  it('propagates transitive dependency readiness through a filtered root query', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'transitive-native-status-source');
    await Promise.all(['leaf', 'middle', 'root'].map((name) =>
      fs.outputJson(path.join(sourceRoot, 'plugins', name, '.app.json'), { apps: {} })));
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ].map((definition) => ({
      ...definition,
      configureManifest: (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.apps = './.app.json';
        delete manifest.extensions;
      },
    })));
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd,
      env,
      version: '1.0.0',
      userEnabled: false,
      sourceIdentity,
      pluginName: 'root',
    });
    await Promise.all(['leaf', 'middle'].map((name) => fs.outputJson(path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw-local', name, '1.0.0', 'plugin.json',
    ), { name, version: '1.0.0' })));
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'user', env).configTomlPath,
      { upsertPluginActivations: {
        'root@aw-local': false, 'middle@aw-local': false, 'leaf@aw-local': false,
      } },
    );
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      { upsertPluginActivations: {
        'root@aw-local': true, 'middle@aw-local': true, 'leaf@aw-local': false,
      } },
    );
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/root', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'transitive-native-status-prefix'),
      version: '0.151.0',
    });
    const listRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        installed: ['leaf', 'middle', 'root'].map((name) => ({
          pluginId: `${name}@aw-local`, installed: true, enabled: true, version: '1.0.0',
        })),
        available: [],
      }),
      stderr: '',
    }));
    const read = () => statusCommandV8({
      plugins: ['local/root'], cwd: isolation.layout.fixtureCwd,
      env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      nativeCliRunner: withCodexVersion(listRunner),
    });

    const desired = await read();
    expect(desired.payload.targets).toHaveLength(1);
    expect(desired.payload.targets[0]).toMatchObject({
      pluginId: 'local/root',
      state: 'needsSync',
      placements: [expect.objectContaining({
        state: 'needsSync',
        components: expect.arrayContaining([expect.objectContaining({
          kind: 'dependency',
          key: 'local/middle',
          state: 'incomplete',
          metadata: expect.objectContaining({
            rootIssueId: 'incompleteInstallation:local/leaf:codex:project',
            rootIssueCode: 'incompleteInstallation',
          }),
        })]),
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'dependencyNotReady',
          dependencyPluginId: 'local/leaf',
          dependencyScope: 'project',
          rootIssueId: 'incompleteInstallation:local/leaf:codex:project',
        })]),
      })],
    });
    expect(listRunner).toHaveBeenCalledTimes(2);

    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env },
      createEmptyPluginIntentState());
    listRunner.mockClear();
    const manual = await read();
    expect(manual.payload.targets[0]).toMatchObject({
      state: 'orphaned',
      placements: [expect.objectContaining({
        state: 'orphaned',
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'dependencyNotReady',
          dependencyPluginId: 'local/leaf',
          rootIssueId: 'incompleteInstallation:local/leaf:codex:project',
        })]),
      })],
    });
    expect(listRunner).toHaveBeenCalledTimes(2);
  });

  it('propagates a transitive unsupported capability as a blocking leaf issue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'transitive-capability-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', requiredCapabilities: ['aw.future-status-capability.v1'] },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/root', platforms: ['codex'] }],
    });
    for (const pluginName of ['root', 'middle']) {
      await applyCodexConfigTransactionFile(
        resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
        {
          upsertManagedInstructionBlock: {
            pluginName: createSharedOwnerToken({
              owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
              pluginId: `local/${pluginName}`, plugin: pluginName,
              artifactKey: 'developer-instructions', platform: 'codex', scope: 'project',
            }),
            value: `${pluginName} live fixture.`,
          },
        },
      );
    }

    const result = await statusCommandV8({
      plugins: ['local/root'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      recoveryActions: [{
        command: 'manual',
        description: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
      }],
      placements: [expect.objectContaining({
        components: expect.arrayContaining([expect.objectContaining({
          kind: 'dependency', key: 'local/middle', state: 'error',
          metadata: expect.objectContaining({
            rootIssueId: 'awCapabilityUnsupported:local/leaf',
            rootIssueCode: 'awCapabilityUnsupported',
          }),
        })]),
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'awCapabilityUnsupported',
          dependencyPluginId: 'local/leaf',
          rootIssueId: 'awCapabilityUnsupported:local/leaf',
          message: expect.stringContaining('aw.future-status-capability.v1'),
        })]),
      })],
    })]);
    expect(result.payload.targets[0]!.recoveryActions)
      .not.toContainEqual(expect.objectContaining({ command: 'sync' }));
  });

  it('returns a structured blocker for a cyclic dependency catalog without waiting on its cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cyclic-status-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'middle', dependencies: ['root'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      {
        upsertManagedInstructionBlock: {
          pluginName: createSharedOwnerToken({
            owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
            pluginId: 'local/root', plugin: 'root', artifactKey: 'developer-instructions',
            platform: 'codex', scope: 'project',
          }),
          value: 'root live fixture.',
        },
      },
    );

    const result = await statusCommandV8({
      plugins: ['local/root'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      recoveryActions: [{
        command: 'manual',
        description: '修复 Catalog 中的插件依赖循环后重试。',
      }],
      placements: [expect.objectContaining({
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'dependencyGraphInvalid',
          severity: 'blocking',
          dependencyPluginId: 'local/middle',
          rootIssueId: 'dependencyGraphInvalid:local/middle',
        })]),
      })],
    })]);
  });

  it('does not treat mixed-scope config inputs as a Codex extension conflict', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-conflict-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const { env } = await configurePathSource(sourceRoot);
    for (const scope of ['user', 'project'] as const) {
      await writePluginIntentState({ scope, cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
    }

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
      recoveryActions: expect.arrayContaining([expect.objectContaining({ command: 'sync' })]),
    })]);
    expect(result.payload.targets[0]!.reasons)
      .not.toContainEqual(expect.objectContaining({ code: 'codexExtensionScopeConflict' }));
    expect(statusTargetExtensions(result.payload.targets[0]!)).toBeUndefined();
    expect(result.hasErrors, JSON.stringify(result.payload, null, 2)).toBe(false);
  });

  it('recovers a dependency scope conflict through its desired roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-conflict-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
    ]);
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/user-root', platforms: ['codex'] }],
    });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/project-root', platforms: ['codex'] }],
    });

    const result = await statusCommandV8({
      plugins: ['local/leaf'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'local/leaf',
      state: 'blocked',
      recoveryActions: expect.arrayContaining([
        {
          command: 'uninstall',
          scope: 'user',
          description: '运行 aw uninstall local/user-root --platform codex --scope user，再运行 aw sync local/project-root --platform codex --scope project。',
        },
        {
          command: 'uninstall',
          scope: 'project',
          description: '运行 aw uninstall local/project-root --platform codex --scope project，再运行 aw sync local/user-root --platform codex --scope user。',
        },
      ]),
    })]);
  });

  it('keeps the default-scope Codex dependency component aligned with its project reason', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/root', platforms: ['codex'] }],
    });
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      {
        upsertManagedInstructionBlock: {
          pluginName: createSharedOwnerToken({
            owner: 'agent-workflows',
            sourceId: 'local',
            sourceIdentity,
            pluginId: 'local/root',
            plugin: 'root',
            artifactKey: 'developer-instructions',
            platform: 'codex',
            scope: 'project',
          }),
          value: 'Root live fixture.',
        },
      },
    );

    const result = await statusCommandV8({
      plugins: ['local/root'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    const placement = target.placements.find((entry) => entry.scope === 'project')!;
    const reason = placement.reasons.find((entry) => entry.code === 'dependencyMissing');
    const component = placement.components.find((entry) =>
      entry.kind === 'dependency' && entry.key === 'local/leaf');
    expect(placement.scope).toBe('project');
    expect(reason).toMatchObject({
      dependencyPluginId: 'local/leaf',
      dependencyPlatform: 'codex',
      dependencyScope: 'project',
      dependencyProject: 'current',
      rootIssueId: 'dependencyMissing:local/leaf:codex:project',
      rootIssueCode: 'dependencyMissing',
    });
    expect(component).toMatchObject({
      state: 'absent',
      metadata: {
        platform: 'codex',
        scope: 'project',
        project: 'current',
        rootIssueId: reason?.rootIssueId,
        rootIssueCode: reason?.rootIssueCode,
      },
    });
    expect(target.state).toBe('needsSync');
  });

  it('checks dependencies for a desired Codex root whose own output is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-desired-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/root', platforms: ['codex'] }],
    });

    const result = await statusCommandV8({
      plugins: ['local/root'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
      placements: [expect.objectContaining({
        state: 'needsSync',
        components: expect.arrayContaining([expect.objectContaining({
          kind: 'dependency', key: 'local/leaf', state: 'absent',
        })]),
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'dependencyMissing', dependencyPluginId: 'local/leaf',
        })]),
      })],
    })]);
  });

  it.each([
    { observation: 'unobserved', expectedReadiness: 'incomplete' },
    { observation: 'failed', expectedReadiness: 'error' },
    { observation: 'installed-disabled', expectedReadiness: 'incomplete' },
  ] as const)(
    'does not report a $observation native dependency as missing',
    async ({ observation, expectedReadiness }) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `native-dependency-${observation}`);
      await fs.outputJson(path.join(sourceRoot, 'plugins', 'leaf', '.app.json'), { apps: {} });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        {
          name: 'leaf',
          configureManifest: (manifest) => {
            manifest.marketplace.policy.products = ['CODEX'];
            manifest.apps = './.app.json';
          },
        },
        {
          name: 'root',
          dependencies: ['leaf'],
          configureManifest: (manifest) => {
            manifest.marketplace.policy.products = ['CODEX'];
            manifest.extensions = {
              instructions: [{ name: 'root', title: 'Root', content: 'Root.' }],
            };
          },
        },
      ]);
      const { env, sourceIdentity } = await configurePathSource(sourceRoot);
      await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/root', platforms: ['codex'] }],
      });
      await applyCodexConfigTransactionFile(
        resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
        {
          upsertManagedInstructionBlock: {
            pluginName: createSharedOwnerToken({
              owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
              pluginId: 'local/root', plugin: 'root', artifactKey: 'developer-instructions',
              platform: 'codex', scope: 'project',
            }),
            value: 'Root live fixture.',
          },
        },
      );
      const binRoot = observation === 'unobserved'
        ? ''
        : await writeSystemCodexPackage({
            root: path.join(isolation.layout.fixtureCwd, `native-dependency-bin-${observation}`),
            version: '0.151.0',
          });
      const nativeRunner = observation === 'failed'
        ? vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'list failed' }))
        : observation === 'installed-disabled'
          ? vi.fn(async () => ({
              exitCode: 0,
              stdout: JSON.stringify({
                installed: [{
                  pluginId: 'leaf@aw', installed: true, enabled: false, version: '1.0.0',
                }],
                available: [],
              }),
              stderr: '',
            }))
          : null;
      setNativeCliRunnerOverrideForTests(nativeRunner ? withCodexVersion(nativeRunner) : null);

      try {
        const result = await statusCommandV8({
          plugins: ['local/root'], cwd: isolation.layout.fixtureCwd,
          env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
        });
        const target = result.payload.targets[0]!;
        expect(target.platform).toBe('codex');
        const placement = target.placements[0]!;
        const dependency = placement.components.find((component) =>
          component.kind === 'dependency' && component.key === 'local/leaf');
        expect(dependency).toMatchObject({ state: expectedReadiness });
        expect(placement.reasons).toContainEqual(expect.objectContaining({
          code: 'dependencyNotReady',
        }));
        expect(placement.reasons).not.toContainEqual(expect.objectContaining({
          code: 'dependencyMissing',
        }));

        const leaf = await statusCommandV8({
          plugins: ['local/leaf'], cwd: isolation.layout.fixtureCwd,
          env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
        });
        expect(leaf.payload.targets[0]!.state).not.toBe('absent');
        const leafTarget = leaf.payload.targets[0]!;
        expect(leafTarget.platform).toBe('codex');
        expect(leafTarget.placements[0]!.components).toContainEqual(expect.objectContaining({
          kind: 'ownership', key: 'native',
          state: observation === 'failed' ? 'error' : 'partial',
        }));
      } finally {
        setNativeCliRunnerOverrideForTests(null);
      }
    },
  );

  it('keeps unavailable desired intent visible as unresolved', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unresolved-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'gone/demo', platforms: ['codex'] }],
    });

    const result = await statusCommandV8({
      plugins: ['gone/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'codexIntentSourceUnavailable' })]),
    })]);
    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    expect(statusTargetIntent(target.placements[0]!)).toEqual({
      enabled: true, scopes: ['project'], relation: 'root',
    });
  });

  it('does not apply managed intent from another same-name Codex marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'source-qualified-managed-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      managed: { codexPluginIds: ['demo@aw-second'] },
    });

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'local/demo',
      state: 'absent',
    })]);
    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    expect(statusTargetIntent(target.placements[0]!)).toEqual({
      enabled: false, scopes: [], relation: 'none',
    });
  });

  it('reports a current-target owned component without desired intent as orphaned', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphaned-owned-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'),
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'orphaned-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'orphaned-skill',
        }],
      };
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'orphaned-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), [
      '---', 'name: orphaned-skill', 'description: Orphaned fixture.', '---', '',
    ].join('\n'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
        pluginId: 'local/demo', plugin: 'demo', artifactKey: 'orphaned-skill',
        platform: 'codex', scope: 'project',
      },
    });

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets[0]).toMatchObject({ state: 'orphaned' });
    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    expect(statusTargetIntent(target.placements[0]!)).toEqual({
      enabled: false, scopes: [], relation: 'none',
    });
    expect(result.payload.targets[0]!.recoveryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'cleanup' }),
    ]));
  });

  it('keeps desired intent structured when the Catalog has no active generation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'official/demo', platforms: ['codex'] }],
    });

    const result = await statusCommandV8({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.catalog.sources).toEqual([
      expect.objectContaining({ id: 'official', error: expect.any(String) }),
    ]);
    expect(result.payload.catalog.sources[0]).not.toHaveProperty('freshness');
    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'official/demo',
      state: 'blocked',
      recoveryActions: [
        expect.objectContaining({ command: 'sync' }),
        expect.objectContaining({ command: 'cleanup' }),
      ],
    })]);
    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    expect(statusTargetIntent(target.placements[0]!)).toEqual({
      enabled: true, scopes: ['project'], relation: 'root',
    });
  });

  it('does not report private Codex cache as status residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-drift-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
      manifest.version = '2.0.0';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      managed: { codexPluginIds: ['demo@aw-local'] },
    });
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd, env, version: '1.0.0', userEnabled: false,
      sourceIdentity,
    });

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexSharedNativeUnobserved', severity: 'warning' }),
      ]),
    })]);
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toEqual({
      pluginId: 'demo@aw-local', state: 'unobserved',
    });
    expect(result.payload.targets[0]!.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'staleCacheObserved' }),
    ]));
    expect(JSON.stringify(result.payload)).not.toContain('staleCacheObserved');
    expect(result.payload.targets[0]!.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'codexSharedNativeUpdateRequired' }),
      expect.objectContaining({ code: 'codexSharedNativeForeign' }),
      expect.objectContaining({ severity: 'blocking' }),
    ]));
    expect(result.hasErrors, JSON.stringify(result.payload, null, 2)).toBe(false);
  });

  it('keeps an undesired cache-only Codex plugin absent when registration is unobserved', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await fs.outputJson(path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw', 'demo', '1.0.0', 'plugin.json',
    ), { name: 'demo', version: '1.0.0' });

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(
      result.payload.targets,
      JSON.stringify(result.payload.targets, null, 2),
    ).toEqual([expect.objectContaining({ state: 'absent' })]);
    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    expect(target.placements[0]!.components).toContainEqual(expect.objectContaining({
      kind: 'ownership', key: 'native', state: 'absent',
    }));
    expect(statusTargetIntent(target.placements[0]!)).toEqual({
      enabled: false, scopes: [], relation: 'none',
    });
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toEqual({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    expect(JSON.stringify(result.payload)).not.toContain('staleCacheObserved');
  });

  it('uses pluginIntentStateInvalid for an unreadable desired-state file', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-intent-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    await fs.outputFile(resolvePluginIntentStatePath({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }), '{ invalid intent');

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env, json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload.errors).toContainEqual({
      code: 'pluginIntentStateInvalid',
      message: 'pluginIntentStateInvalid: user plugin intent state is invalid.',
    });
  });

  it('ignores a legacy project Skill marker when another Catalog source fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = path.join(isolation.layout.fixtureCwd, 'partial-good');
    const bad = path.join(isolation.layout.fixtureCwd, 'partial-bad');
    await fs.outputFile(
      path.join(good, 'plugins', 'demo', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review fixture.\n---\n',
    );
    await fs.outputFile(
      path.join(good, 'plugins', 'demo', 'skills', 'review', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(good, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    await fs.ensureDir(bad);
    const goodSource = { id: 'good', type: 'path', primary: true, path: good } as const;
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [goodSource, { id: 'bad', type: 'path', primary: false, path: bad }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'good',
      cliVersion: '1.0.0',
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.copy(path.join(good, 'plugins', 'demo', 'skills', 'review'), skillRoot);
    await fs.remove(path.join(skillRoot, 'agents', 'openai.yaml'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'good',
        sourceIdentity: await calculateCatalogSourceIdentity(goodSource),
        pluginId: 'good/demo',
        plugin: 'demo',
        artifactKey: 'review',
        platform: 'codex',
        scope: 'project',
      },
    });

    setNativeCliRunnerOverrideForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    let result;
    try {
      result = await statusCommandV8({
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
        platform: 'codex', scope: 'project', verbose: true, json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.hasErrors).toBe(true);
    expect(result.payload.catalog.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bad', error: expect.any(String) }),
      expect.objectContaining({ id: 'good', freshness: 'active' }),
    ]));
    expect(result.payload.catalog.sources.find((source) => source.id === 'bad'))
      .not.toHaveProperty('freshness');
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'good/demo',
        state: 'absent',
      }),
    ]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('treats a disabled-capable dynamic component as optional without running its renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'optional-dynamic-source');
    const sentinel = path.join(isolation.layout.fixtureCwd, 'renderer-ran');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.AW_RENDER_SENTINEL, "renderer ran\\n");',
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present', 'disabled'],
          refreshKeys: [],
          skillKey: 'dynamic-skill',
        }],
      };
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...env, AW_RENDER_SENTINEL: sentinel },
      platform: 'codex', scope: 'project', verbose: true,
    });

    expect(result.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', state: 'absent' }),
    ]);
    expect(await fs.pathExists(sentinel)).toBe(false);
  });

  it('does not report marker-only legacy project Skill residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'residue-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'removed-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), [
      '---', 'name: removed-skill', 'description: Removed fixture.', '---', '',
    ].join('\n'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
        pluginId: 'local/removed', plugin: 'removed', artifactKey: 'removed-skill',
        platform: 'codex', scope: 'project',
      },
    });

    const result = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('does not create or change files during a real status inspection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'read-only-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    const nativeRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setNativeCliRunnerOverrideForTests(nativeRunner);
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    let result;
    try {
      result = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
        platform: 'claude', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', state: 'absent' }),
    ]);
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(nativeRunner).not.toHaveBeenCalled();
  });

  it('uses the official system Codex list without changing isolation state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'read-only-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'system-prefix'),
      version: '0.151.0',
    });
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'sentinel'), 'unchanged\n');
    const nativeRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    setNativeCliRunnerOverrideForTests(withCodexVersion(nativeRunner));
    const before = await filesystemSnapshot(isolation.layout.rootDir);
    const codexHomeBefore = await filesystemSnapshot(isolation.layout.codexHomeDir);

    let result;
    try {
      result = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'observed',
      systemConsumer: {
        state: 'compatible', detectedVersion: '0.151.0', requiredMinVersion: '0.151.0',
      },
    });
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toMatchObject({
      state: 'missing',
    });
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(await filesystemSnapshot(isolation.layout.codexHomeDir)).toEqual(codexHomeBefore);
    expect(nativeRunner).toHaveBeenCalledTimes(2);
    expect(nativeRunner.mock.calls.every(([invocation]) =>
      invocation.command === 'codex'
      && invocation.args.slice(0, 3).join(' ') === 'plugin list --marketplace'
      && invocation.args[4] === '--json')).toBe(true);
  });

  it('uses one marketplace snapshot for twenty Codex native status targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'bulk-codex-source');
    const pluginNames = Array.from({ length: 20 }, (_, index) => `native-${index}`);
    await Promise.all(pluginNames.map((name) =>
      fs.outputJson(path.join(sourceRoot, 'plugins', name, '.app.json'), { apps: {} })));
    await createDependencyCatalogSnapshotFixture(sourceRoot, pluginNames.map((name) => ({
      name,
      configureManifest: (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.apps = './.app.json';
      },
    })));
    const { env } = await configurePathSource(sourceRoot);
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'bulk-system-prefix'),
      version: '0.151.0',
    });
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const nativeRunner = vi.fn(async (invocation) => {
      calls.push(invocation);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ installed: [], available: [] }),
        stderr: '',
      };
    });

    await statusCommandV8({
      plugins: pluginNames.map((name) => `local/${name}`),
      cwd: isolation.layout.fixtureCwd,
      env: { ...env, PATH: binRoot },
      platform: 'codex',
      json: true,
      nativeCliRunner: withCodexVersion(nativeRunner),
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) =>
      call.args.slice(0, 3).join(' ') === 'plugin list --marketplace'
      && call.args[4] === '--json')).toBe(true);
    const neutralCwd = calls.find((call) => call.cwd !== isolation.layout.fixtureCwd)!.cwd!;
    await expect(fs.pathExists(neutralCwd)).resolves.toBe(false);
  });

  it('merges exact installed with neutral absent and blocks duplicate official IDs', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'merged-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd,
      env,
      version: '1.0.0',
      userEnabled: true,
      sourceIdentity,
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'merged-system-prefix'),
      version: '0.151.0',
    });
    let duplicate = false;
    const nativeRunner = vi.fn(async (invocation) => {
      const installed = invocation.cwd === isolation.layout.fixtureCwd
        ? [{ pluginId: 'demo@aw-local', installed: true, enabled: true, version: '1.0.0' }]
        : [];
      if (duplicate && installed.length > 0) installed.push({ ...installed[0]! });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ installed, available: [] }),
        stderr: '',
      };
    });
    setNativeCliRunnerOverrideForTests(withCodexVersion(nativeRunner));

    try {
      const merged = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
      expect(statusTargetSharedNative(merged.payload.targets[0]!)).toMatchObject({
        state: 'usable', version: '1.0.0',
      });

      duplicate = true;
      const blocked = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
      expect(blocked.payload.targets[0]).toMatchObject({ state: 'blocked' });
      expect(statusTargetSharedNative(blocked.payload.targets[0]!)).toMatchObject({
        state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListDuplicate',
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
  });

  it('shows scope and activation differences without leaking Codex components into Claude status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-diagnostic-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.apps = './.app.json';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd, env, version: '1.0.0', userEnabled: true, sourceIdentity,
    });
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      { upsertPluginActivations: { 'demo@aw-local': true } },
    );
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'activation-diagnostic-prefix'),
      version: '0.151.0',
    });
    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env: { ...env, PATH: binRoot },
      nativeCliRunner: withCodexVersion(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [{ pluginId: 'demo@aw-local', installed: true, enabled: true, version: '1.0.0' }],
          available: [],
        }),
        stderr: '',
      })),
    });

    expect(result.output).toContain('local/demo claude (project): absent');
    expect(result.output).toContain('local/demo claude (user): absent');
    expect(result.output).toContain('local/demo codex: orphaned');
    expect(result.output).toContain('project expected=false, actual=true');
    expect(result.output).not.toContain('codexActivationDrift: codexActivationDrift:');
    const codex = result.payload.targets.find((target) => target.platform === 'codex')!;
    expect(codex.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user', state: 'ready' }),
      expect.objectContaining({ scope: 'project', state: 'orphaned' }),
    ]));
    for (const target of result.payload.targets.filter((candidate) => candidate.platform === 'claude')) {
      expect(target.components).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'sharedNative' }),
        expect.objectContaining({ kind: 'activation' }),
      ]));
    }
  });

  it('keeps official Codex installs usable without reading private cache payload', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'registered-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd,
      env,
      version: '1.0.0',
      userEnabled: true,
      sourceIdentity,
    });
    const cacheRoot = path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw-local', 'demo', '1.0.0',
    );
    await fs.remove(cacheRoot);
    await fs.copy(path.join(sourceRoot, 'plugins', 'demo'), cacheRoot);
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'registered-system-prefix'),
      version: '0.151.0',
    });
    let listedVersion = '1.0.0';
    let listedEnabled = false;
    const nativeRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        installed: [{
          pluginId: 'demo@aw-local',
          installed: true,
          enabled: listedEnabled,
          version: listedVersion,
        }],
        available: [],
      }),
      stderr: '',
    }));
    setNativeCliRunnerOverrideForTests(withCodexVersion(nativeRunner));

    try {
      await fs.remove(cacheRoot);
      const damaged = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(damaged.payload.targets[0]).toMatchObject({ state: 'ready' });
      expect(statusTargetSharedNative(damaged.payload.targets[0]!)).toMatchObject({
        state: 'usable', version: '1.0.0',
      });

      await fs.copy(path.join(sourceRoot, 'plugins', 'demo'), cacheRoot);
      if (process.platform !== 'win32') {
        await fs.symlink(
          path.join(isolation.layout.fixtureCwd, 'outside-payload'),
          path.join(cacheRoot, 'nested-payload-link'),
        );
      }
      const present = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(present.payload.targets[0]).toMatchObject({ state: 'ready' });
      expect(statusTargetSharedNative(present.payload.targets[0]!)).toEqual({
        pluginId: 'demo@aw-local', state: 'usable', version: '1.0.0',
      });
      expect(present.payload.targets[0]!.components.find((component) =>
        component.kind === 'sharedNative')).toEqual({
        kind: 'sharedNative',
        key: 'demo@aw-local',
        state: 'usable',
        metadata: { shared: true, version: '1.0.0' },
      });
      const presentTarget = present.payload.targets[0]!;
      expect(presentTarget.platform).toBe('codex');
      expect(statusTargetActivation(presentTarget.placements[0]!)).toMatchObject({
        user: true, evidence: 'observed',
      });

      listedEnabled = true;
      await applyCodexConfigTransactionFile(
        resolveCodexPaths(isolation.layout.fixtureCwd, 'user', env).configTomlPath,
        { upsertPluginActivations: { 'demo@aw-local': false } },
      );
      const disabled = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(disabled.payload.targets[0]).toMatchObject({ state: 'needsSync' });
      const disabledTarget = disabled.payload.targets[0]!;
      expect(disabledTarget.platform).toBe('codex');
      expect(statusTargetActivation(disabledTarget.placements.find((entry) => entry.scope === 'user')!)).toMatchObject({
        user: false, effective: false, evidence: 'observed',
      });

      await applyCodexConfigTransactionFile(
        resolveCodexPaths(isolation.layout.fixtureCwd, 'user', env).configTomlPath,
        { upsertPluginActivations: { 'demo@aw-local': true } },
      );
      listedVersion = '0.9.0';
      const outdated = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(outdated.payload.targets[0]).toMatchObject({ state: 'needsSync' });
      expect(statusTargetSharedNative(outdated.payload.targets[0]!)).toMatchObject({
        state: 'replaceable', reason: 'outdated', version: '0.9.0',
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(nativeRunner.mock.calls.every(([invocation]) =>
      invocation.command === 'codex'
      && invocation.args.join(' ') === 'plugin list --marketplace aw-local --json')).toBe(true);
  });

  it('reports a probed Codex 0.150 project consumer as incompatible', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'low-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'low-system-prefix'),
      version: '0.150.0',
    });
    const nativeRunner = vi.fn(async () => {
      throw new Error('status must not execute Codex');
    });
    setNativeCliRunnerOverrideForTests(withCodexVersion(nativeRunner, '0.150.0'));

    let result;
    try {
      result = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexProjectPluginVersionTooLow' }),
      ]),
      recoveryActions: [{
        command: 'manual',
        description: '升级或修复官方 system Codex CLI 后重试原操作。',
      }],
    })]);
    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'unobserved',
      systemConsumer: {
        state: 'incompatible', code: 'codexProjectPluginVersionTooLow',
        detectedVersion: '0.150.0',
      },
    });
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toMatchObject({
      state: 'unobserved',
    });
    expect(nativeRunner).not.toHaveBeenCalled();
  });

  it('uses the user requirement for default-scope status with only user desired intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-low-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'user-low-system-prefix'),
      version: '0.150.0',
    });
    const nativeRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    setNativeCliRunnerOverrideForTests(withCodexVersion(nativeRunner, '0.150.0'));

    let result;
    try {
      result = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets[0]).toMatchObject({ state: 'needsSync' });
    const target = result.payload.targets[0]!;
    expect(target.platform).toBe('codex');
    expect(statusTargetIntent(target.placements.find((entry) => entry.scope === 'user')!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'root',
    });
    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'observed',
      systemConsumer: {
        state: 'compatible', detectedVersion: '0.150.0', requiredMinVersion: '0.145.0',
      },
    });
    expect(nativeRunner).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform !== 'win32').each([
    ['installed', 'ready'],
    ['invalid-json', 'blocked'],
    ['failed-list', 'blocked'],
  ] as const)('observes a POSIX wrapper with aliased activation: %s', async (observation, state) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.env.HOME!, 'alias-home');
    await fs.ensureDir(cwd);
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'wrapper-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const configured = await configurePathSource(sourceRoot);
    const binRoot = path.join(isolation.layout.fixtureCwd, 'wrapper-bin');
    await fs.outputFile(path.join(binRoot, 'codex'), '#!/bin/sh\nexit 0\n');
    await fs.chmod(path.join(binRoot, 'codex'), 0o755);
    const env = { ...configured.env, PATH: binRoot, AW_CODEX_HOME: path.join(cwd, '.codex') };
    await writePluginIntentState({ scope: 'user', cwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    await writeCodexNativeResidue({
      cwd, env, version: '1.0.0', userEnabled: true, sourceIdentity: configured.sourceIdentity,
    });
    const nativeRunner = vi.fn<NativeCliRunner>(async (invocation) => {
      if (invocation.args.at(-1) === '--version') {
        return { exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' };
      }
      return {
        exitCode: observation === 'failed-list' ? 1 : 0,
        stdout: observation === 'invalid-json' ? '{}' : JSON.stringify({
          installed: [{ pluginId: 'demo@aw-local', installed: true, enabled: true, version: '1.0.0' }],
          available: [],
        }),
        stderr: '',
      };
    });
    const before = await filesystemSnapshot(cwd);
    const result = await statusCommandV8({
      plugins: ['local/demo'], cwd, env, platform: 'codex', json: true, nativeCliRunner: nativeRunner,
    });
    expect(result.payload.targets).toHaveLength(1);
    const target = result.payload.targets[0]!;
    expect(target).toMatchObject({ state });
    expect(target.platform).toBe('codex');
    const placement = target.placements.find((entry) => entry.scope === 'user')!;
    expect(placement).toMatchObject({ scope: 'user', state });
    expect(statusTargetActivation(placement)).toMatchObject({ user: true });
    expect(statusTargetActivation(placement)?.project).toBeUndefined();
    expect(target.reasons).not.toContainEqual(expect.objectContaining({ code: 'codexActivationDrift' }));
    expect(await filesystemSnapshot(cwd)).toEqual(before);
    expect(nativeRunner.mock.calls.filter(([call]) => call.args.at(-1) === '--version')).toHaveLength(1);
    expect(nativeRunner.mock.calls.filter(([call]) => call.args[0] === 'plugin')).toHaveLength(2);
    if (observation === 'installed') {
      const project = await statusCommandV8({
        plugins: ['local/demo'], cwd, env, platform: 'codex', scope: 'project',
        json: true, nativeCliRunner: nativeRunner,
      });
      expect(project.payload.targets[0]?.placements[0]?.reasons).toContainEqual(
        expect.objectContaining({ code: 'codexScopePathAlias' }),
      );
      const projectCwd = path.join(isolation.layout.fixtureCwd, 'separate-project');
      await fs.ensureDir(path.join(projectCwd, '.git'));
      await fs.outputFile(path.join(projectCwd, '.codex', 'config.toml'),
        '[plugins."demo@aw-local"]\nenabled = true\n');
      const drifted = await statusCommandV8({
        plugins: ['local/demo'], cwd: projectCwd, env, platform: 'codex',
        json: true, nativeCliRunner: nativeRunner,
      });
      expect(drifted.payload.targets[0]?.placements[0]?.reasons).toContainEqual(
        expect.objectContaining({ code: 'codexActivationDrift' }),
      );
    }
  });

  it.runIf(process.platform !== 'win32')('reports a failed version query as typed unresolved evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-codex-source-identity');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'invalid-system-prefix'),
      version: '0.151.0',
      packageName: 'foreign/codex',
    });
    const nativeRunner = vi.fn(async () => {
      throw new Error('version query failed');
    });
    setNativeCliRunnerOverrideForTests(nativeRunner);

    let result;
    try {
      result = await statusCommandV8({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexProjectPluginUnsupported' }),
      ]),
      recoveryActions: [{
        command: 'manual',
        description: '升级或修复官方 system Codex CLI 后重试原操作。',
      }],
    })]);
    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'unobserved',
      systemConsumer: expect.objectContaining({
        state: 'unresolved', code: 'codexProjectPluginUnsupported',
      }),
    });
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toMatchObject({
      state: 'unobserved',
    });
    expect(nativeRunner).toHaveBeenCalledTimes(1);
  });

  it('does not materialize intent or state paths while reading missing state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const env = isolation.env;
    const nativeRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setNativeCliRunnerOverrideForTests(nativeRunner);
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    try {
      const result = await statusCommandV8({
        cwd: isolation.layout.fixtureCwd, env, json: true,
      });
      expect(result.payload.schemaVersion).toBe(8);
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(await fs.pathExists(path.join(isolation.layout.fixtureCwd, '.agent-workflows'))).toBe(false);
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
    expect(await fs.pathExists(isolation.layout.codexHomeDir)).toBe(false);
    expect(await fs.pathExists(isolation.layout.claudeHomeDir)).toBe(false);
    expect(nativeRunner).not.toHaveBeenCalled();
  });
});
