import { beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { realpath } from 'node:fs/promises';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { canonicalNamespaceRoot, getPhysicalKey } from '../../src/platforms/identity.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getNativeTestLayout, installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import type { PluginMeta } from '../../src/types.js';
import { SKILL_OWNER_MARKER, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import {
  syncWriteCommand,
  installFixturePlugin,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    installNativeTestDiscovery({ platforms: ['codex', 'claude'] });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  // Windows needs a completion window for seven sequential public commands.
  it.for(['user', 'project'] as const)('refreshes an installed %s Codex role after removing its Intent root', async (scope, test) => {
    const timing = createCommandTestTiming(test);
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-role-refresh-source');
    const otherSourceRoot = path.join(isolation.layout.fixtureCwd, 'other-config-role-source');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const effort = context.config.values.effort ?? "medium";',
      'console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes("agent")?[{id:"helper-role",name:"helper",kind:"agent",content:{description:"Helper role.",prompt:`Help with effort=${effort}.`}}]:[],omitted:[],unmet:[]}));',
    ].join('\n'));
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-native', 'SKILL.md'),
        '---\nname: demo-native\ndescription: Native fixture.\n---\n',
      ),
      fs.outputFile(
        path.join(
          sourceRoot,
          'plugins',
          'demo',
          'skills',
          'demo-native',
          'agents',
          'openai.yaml',
        ),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        fields: {
          effort: {
            type: 'string',
            default: 'medium',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'medium', title: 'Medium', value: 'medium' },
                { id: 'high', title: 'High', value: 'high' },
                { id: 'xhigh', title: 'Extra high', value: 'xhigh' },
              ],
            },
          },
        },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: ['effort'], scopes: ['user', 'project'] };
    });
    await createCatalogSnapshotFixture(otherSourceRoot, 'sentinel', [], 'sentinel\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        agents: [{ name: 'watcher', description: 'Watcher.', prompt: 'Watch.' }],
      };
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'team', type: 'path', primary: true, path: sourceRoot },
          { id: 'other', type: 'path', primary: false, path: otherSourceRoot },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await timing.measure('command', args[1] === 'config' ? `plugin config ${args[2]}` : `plugin ${args[1]}`, () => runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner: runtime.nativeCliRunner,
      }));
      return {
        exitCode,
        payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
      };
    };
    const rolePath = path.join(scope === 'user' ? isolation.env.CODEX_HOME!
      : path.join(isolation.layout.fixtureCwd, '.codex'), 'agents', 'aw-team-demo-helper.toml');
    const otherScope = scope === 'user' ? 'project' : 'user';
    const otherHome = otherScope === 'user' ? isolation.env.CODEX_HOME!
      : path.join(isolation.layout.fixtureCwd, '.codex');
    const otherRolePath = path.join(otherHome, 'agents', 'aw-other-sentinel-watcher.toml');

    expect(await runPublic([
      'plugin', 'install', 'team/demo', '--scope', scope, '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
    expect(await runPublic([
      'plugin', 'install', 'other/sentinel', '--scope', otherScope, '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
    const otherRoleBefore = await fs.readFile(otherRolePath);
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=medium');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope, '--value-json', '"high"',
    ])).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 2, status: 'success', data: { apply: { state: 'skipped', reason: 'notRequested' } }, },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=medium');
    expect(await runPublic([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', scope, '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=high');

    const extraHighApply = await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope,
      '--value-json', '"xhigh"', '--apply', '--yes',
    ]);
    expect(extraHighApply, JSON.stringify(extraHighApply)).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 2, status: 'success', data: { apply: { state: 'succeeded' } }, },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=xhigh');

    const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const intentPath = await resolveIntentPath(intentLocation);
    const otherIntentPath = await resolveIntentPath({ ...intentLocation, scope: otherScope });
    const intentBeforeRemoval = await fs.readFile(intentPath);
    const otherIntentBefore = await fs.readFile(otherIntentPath);
    expect(await runPublic(['plugin', 'remove', 'team/demo', '--scope', scope, '--only', 'requirements'])).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2, command: 'plugin.remove', status: 'success',
        data: { changes: { requirements: 'changed', outputs: 'none' }, requirements: { roots: [] }, targetResults: [] }
      },
    });
    const intentAfterRemoval = await fs.readFile(intentPath);
    expect(intentAfterRemoval).not.toEqual(intentBeforeRemoval);
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=xhigh');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope,
      '--value-json', '"medium"', '--apply', '--yes',
    ])).toMatchObject({
      exitCode: 0, payload: { schemaVersion: 2, status: 'success', data: { apply: { state: 'succeeded' } }, },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=medium');
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentAfterRemoval);
    await expect(fs.readFile(otherIntentPath)).resolves.toEqual(otherIntentBefore);
    await expect(fs.readFile(otherRolePath)).resolves.toEqual(otherRoleBefore);
    expect([...runtime.installed].some((id) => id.startsWith('demo@'))).toBe(true);
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it.each([
    ['SKILL.md', 'native-sensitive-skill'],
    ['references/secret.md', 'native-sensitive-reference'],
  ] as const)(
    'blocks sensitive config in native %s before live Codex mutations',
    async (leakPath, pluginName) => {
      const isolation = getCurrentSourceTestIsolation();
      const env = {
        ...isolation.env,
        AW_HOME: path.join(isolation.env.AW_HOME!, 'renderer-process-long-working-directory'),
      };
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `${pluginName}-source`);
      const rendererPath = path.join(sourceRoot, 'plugins', pluginName, 'scripts', 'render.mjs');
      const secret = `secret-${pluginName}-value`;
      const writeRenderer = async (leak: boolean) => {
        const skill = `---\nname: ${pluginName}\ndescription: Sensitive boundary fixture.\n---\n${leak && leakPath === 'SKILL.md' ? `native ${secret}` : 'native safe'}\n`;
        const reference = leak && leakPath === 'references/secret.md'
          ? `, "references/secret.md": ${JSON.stringify(secret)}`
          : '';
        await fs.outputFile(rendererPath, [
          'import assert from "node:assert/strict";',
          'import { readFile } from "node:fs/promises";',
          'import { fileURLToPath } from "node:url";',
          'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          'assert.ok(fileURLToPath(import.meta.url).length >= 260);',
          `const files={"SKILL.md":${JSON.stringify(skill)},"README.md":"native readme"${reference}};`,
          `console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes('skill')?[{id:${JSON.stringify(pluginName)},kind:'skill',name:${JSON.stringify(pluginName)},content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));`,
        ].join('\n'));
      };
      const createFixture = () => createCatalogSnapshotFixture(
        sourceRoot,
        pluginName,
        [],
        'native sensitive fixture\n',
        (manifest) => {
          manifest.platforms = ['codex'];
          manifest.config = {
            fields: { secret: { type: 'string', sensitive: true } },
          };
          manifest.scripts = {
            artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
          };
          manifest.artifacts = { configKeys: [], scopes: ['user'] };
        },
      );

      await writeRenderer(false);
      await createFixture();
      const before = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: before.digest,
        env,
      });
      await writePluginConfigStore({
        sourceId: 'team',
        sourceIdentity: await calculateCatalogSourceIdentity({
          id: 'team', type: 'path', primary: true, path: sourceRoot,
        }),
        pluginName,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        env,
        values: { secret },
      });
      const runtime = await createCodexNativeTestRuntime({ ...isolation, env });
      const installed = await installFixturePlugin([`team/${pluginName}`], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);
      expect(installed, JSON.stringify(installed, null, 2))
        .toMatchObject({ overallState: 'succeeded' });

      const marketplaceRoot = [...runtime.marketplaceRoots.values()][0]!;
      const pluginId = [...runtime.installed][0]!;
      const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
      const installedBefore = new Set(runtime.installed);
      const configPath = path.join(env.CODEX_HOME!, 'config.toml');
      const configBefore = await fs.readFile(configPath);
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const projectConfigBefore = await fs.readFile(projectConfigPath).catch(() => undefined);

      await writeRenderer(true);
      await createFixture();
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env,
      });
      const callsBeforeSync = runtime.nativeCliRunner.mock.calls.length;
      const result = await syncWriteCommand([`team/${pluginName}`], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);

      expect(result, JSON.stringify(result, null, 2)).toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({
          state: 'failed', errorCode: 'artifactRendererSensitiveConfigExposed',
        })],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
      const mutationCalls = runtime.nativeCliRunner.mock.calls.slice(callsBeforeSync)
        .filter(([invocation]) => {
          const pluginIndex = invocation.args.indexOf('plugin');
          const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
          return args[1] === 'add' || args[1] === 'remove'
            || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        });
      expect(mutationCalls).toEqual([]);
      await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
      expect(await fs.readFile(projectConfigPath).catch(() => undefined)).toEqual(projectConfigBefore);
      expect(runtime.installed).toEqual(installedBefore);
      expect(runtime.installed).toContain(pluginId);
    },
    30_000,
  );

  it('blocks a sensitive user override found only in a static native Skill before Codex mutations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'static-sensitive-source');
    const pluginName = 'static-sensitive';
    const skillKey = 'static-sensitive-skill';
    const secret = 'user-static-sensitive-token';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { secret: { type: 'string', sensitive: true } } } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'static sensitive\n', configureManifest);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'SKILL.md'),
        `---\nname: ${skillKey}\ndescription: Sensitive boundary fixture.\n---\nstatic payload ${secret}\n`,
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'static sensitive\n', configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret },
    });
    const runtime = await createCodexNativeTestRuntime(isolation);

    const result = await installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'componentSensitiveConfigExposed',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'platforms', 'codex')))
      .resolves.toBe(false);
    expect(runtime.installed).toEqual(new Set());
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
  }, 30_000);

  it('blocks activation-only reuse when current canonical native Skills contain a sensitive user value', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-sensitive-source');
    const pluginName = 'activation-sensitive';
    const skillKey = 'activation-sensitive-skill';
    const secret = 'existing-static-sensitive-token';
    const safeDefault = 'non-skill-sensitive-default';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        schemaVersion: 5,
        fields: { secret: { type: 'string', sensitive: true } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], `${safeDefault}\n`, configureManifest);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'SKILL.md'),
        `---\nname: ${skillKey}\ndescription: Sensitive boundary fixture.\n---\nstatic payload ${secret}\n`,
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], `${safeDefault}\n`, configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret },
    });
    const marketplaceRoot = [...runtime.marketplaceRoots.values()][0]!;
    const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const userConfigBefore = await fs.readFile(userConfigPath);
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const projectConfigBefore = await fs.readFile(projectConfigPath).catch(() => undefined);
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'componentSensitiveConfigExposed',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(userConfigPath)).resolves.toEqual(userConfigBefore);
    expect(await fs.readFile(projectConfigPath).catch(() => undefined)).toEqual(projectConfigBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
    expect([...runtime.installed].some((id) => id.startsWith(`${pluginName}@`))).toBe(true);
  }, 30_000);

  it('repairs an owned damaged Native manifest only after authorization without reading outside Skills or changing foreign siblings', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unsafe-native-skills-root-source');
    const pluginName = 'unsafe-native-skills-root';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        schemaVersion: 5,
        fields: { secret: { type: 'string', sensitive: true } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'safe-default\n', configureManifest);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', pluginName, 'skills', 'safe', 'SKILL.md'),
      '---\nname: safe\ndescription: Safe fixture.\n---\n# Safe\n',
    );
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', pluginName, 'skills', 'safe', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'safe-default\n', configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret: 'safe-default' },
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret: 'sensitive-value' },
    });
    const marketplaceRoot = [...runtime.marketplaceRoots.values()][0]!;
    const codexManifestPath = path.join(
      marketplaceRoot,
      'plugins',
      pluginName,
      '.codex-plugin',
      'plugin.json',
    );
    const codexManifest = await fs.readJson(codexManifestPath);
    await fs.outputJson(codexManifestPath, { ...codexManifest, skills: '..\\outside' });
    const packageRoot = path.dirname(path.dirname(codexManifestPath));
    const outsideRoot = path.join(path.dirname(packageRoot), 'outside');
    const foreignRoot = path.join(path.dirname(packageRoot), 'foreign-sibling');
    const sentinel = path.join(outsideRoot, 'SKILL.md');
    await fs.outputFile(sentinel, '---\nname: outside\ndescription: Foreign sentinel.\n---\nsensitive-value\n');
    await fs.outputFile(path.join(foreignRoot, 'foreign.txt'), 'foreign sibling must remain\n');
    const outsideBefore = await snapshotRegularTree(outsideRoot);
    const foreignBefore = await snapshotRegularTree(foreignRoot);
    const sentinelBefore = await fs.stat(sentinel);
    const damagedBefore = await fs.readFile(codexManifestPath);
    const intentBefore = await observeIntent({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;
    const outsideReads: string[] = [];
    const readFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const file = path.resolve(String(args[0]));
      const relative = path.relative(outsideRoot, file);
      const insideOutsideRoot = relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      // Discovery can inspect this fixed owner marker, but must not read foreign Skill resources.
      if (insideOutsideRoot && file !== path.join(outsideRoot, SKILL_OWNER_MARKER)) outsideReads.push(file);
      return readFile(...args);
    });
    const run = async (yes: boolean) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli(['plugin', 'install', `team/${pluginName}`, '--scope', 'project', '--target', 'codex',
        ...(yes ? ['--yes'] : []), '--json'], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
        nativeCliRunner: runtime.nativeCliRunner, io: output.io, interactive: false });
      return { exitCode, payload: JSON.parse(output.readStdout()) };
    };
    try {
      const blocked = await run(false);
      expect(blocked, JSON.stringify(blocked)).toMatchObject({ exitCode: 3, payload: { status: 'blocked',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]) } });
      expect(await fs.readFile(codexManifestPath)).toEqual(damagedBefore);
      expect(await observeIntent({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(intentBefore);
      expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        return ['add', 'remove'].includes(invocation.args[index + 1] ?? '');
      })).toEqual([]);
      const repaired = await run(true);
      expect(repaired, JSON.stringify(repaired)).toMatchObject({ exitCode: 4, payload: {
        status: 'partial',
        data: { targetResults: [
          expect.objectContaining({ scope: 'user', content: 'satisfied', observation: 'verified' }),
          expect.objectContaining({
            scope: 'project', content: 'unknown', observation: 'unknown',
            deploymentReceipts: [expect.objectContaining({ after: expect.objectContaining({
              package: 'present', registration: 'present', scopeActivation: 'unknown',
              consumers: [expect.objectContaining({ activation: 'enabled' })],
            }) })],
          }),
        ] },
      } });
      expect(JSON.stringify(repaired)).not.toContain('sensitive-value');
      expect((await fs.readJson(codexManifestPath)).skills).toBe('./skills/');
      expect(await fs.readFile(path.join(packageRoot, 'skills/safe/SKILL.md'), 'utf8')).toContain('name: safe');
      expect(outsideReads).toEqual([]);
    } finally { spy.mockRestore(); }
    expect(await snapshotRegularTree(outsideRoot)).toEqual(outsideBefore);
    expect(await snapshotRegularTree(foreignRoot)).toEqual(foreignBefore);
    expect((await fs.stat(sentinel)).mtimeMs).toBe(sentinelBefore.mtimeMs);
  }, 30_000);

  describe('project Codex intent with shared user config', () => {
    async function createNativeConfigFixture(test: TestContext) {
      const timing = createCommandTestTiming(test);
      const isolation = getCurrentSourceTestIsolation();
      const cwd = isolation.layout.fixtureCwd;
      const env = isolation.env;
      await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['codex'] });
      const sourceRoot = path.join(cwd, 'shared-native-config-source');
      const rendererMarker = path.join(cwd, 'native-config-renderer.jsonl');
      await fs.outputFile(path.join(sourceRoot, 'plugins/native-config/scripts/render.mjs'), [
        'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
        'import { fileURLToPath } from "node:url";',
        'const mode=c.config.values.mode;if(mode==="fail")throw new Error("native renderer requested failure");',
        `fs.appendFileSync(${JSON.stringify(rendererMarker)},JSON.stringify({cwd:process.cwd(),realCwd:fs.realpathSync(process.cwd()),entryPath:fs.realpathSync(fileURLToPath(import.meta.url)),bundleRoot:fs.realpathSync(process.env.AW_PLUGIN_ROOT),home:process.env.HOME,awHome:process.env.AW_HOME,contextPath:process.env.AW_PLUGIN_CONTEXT,context:c})+'\\n');`,
        'const allowed=c.allowedOutputKinds.includes("skill");',
        'const text=`---\nname: native-config\ndescription: Shared config fixture.\n---\nmode=${mode}\nrequestScope=${c.scope}\nsource=${c.config.sources.mode}\n`;',
        'console.log(JSON.stringify({version:3,components:allowed&&mode!=="off"?[{id:"native-config",kind:"skill",name:"native-config",content:{files:{"SKILL.md":{text},"README.md":{text:"Native config fixture.\\n"}}}}]:[],omitted:allowed&&mode==="off"?[{id:"native-config",kind:"skill",reason:"config-disabled"}]:[],unmet:[]}));',
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'native-config', [], 'native\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.config = { schemaVersion: 5, fields: {
          mode: { type: 'string', default: 'safe' }, projectMode: { type: 'string', default: 'project-default' },
        } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
        manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
        manifest.extensions = { instructions: [{ name: 'package-anchor', title: 'Shared config',
          content: 'Keep the independent plugin context when its optional Skill is disabled.', coverage: ['main'] }] };
      });
      const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
      const before = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfigWithoutActive({ config: { schemaVersion: 2, sources: [source] }, expectedDigest: before.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const runPublic = async (args: string[], interactive = false) => {
        const captured = createCapturedCliIo();
        const confirm = vi.fn(async () => ({ action: 'select' as const, cancelled: false, value: true }));
        const exitCode = await timing.measure('command', args.slice(0, 3).join(' '), () => runCli([...args, '--json'], {
          cwd, env, io: captured.io, interactive, nativeCliRunner: runtime.nativeCliRunner,
          ...(interactive ? { prompt: { confirm }, ...createTtyRuntimeStreams() } : {}),
        }));
        expect(confirm).not.toHaveBeenCalled();
        return { exitCode, payload: JSON.parse(captured.readStdout()), stdout: captured.readStdout(), stderr: captured.readStderr() };
      };
      const store = { sourceId: 'team', sourceIdentity, logicalIdentity, pluginName: 'native-config', scope: 'user' as const, cwd, env };
      const writeMode = (mode: string) => writePluginConfigStore({ ...store, values: { mode } });
      await writePluginConfigStore({ ...store, platform: 'codex', values: { projectMode: 'platform-only' } });
      const initial = await runPublic(['plugin', 'install', 'team/native-config', '--scope', 'project', '--yes']);
      expect(initial, JSON.stringify(initial)).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
      const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/native-config', sourceIdentity, cwd, env });
      const packageRoot = layout.packageRoot;
      const skillRoot = path.join(packageRoot, 'skills/native-config');
      const ownerPath = path.join(packageRoot, SKILL_OWNER_MARKER);
      const canonicalPluginId = layout.nativeIdentity.registrationId!;
      const cacheRoot = path.join(env.CODEX_HOME!, 'plugins/cache', layout.marketplaceName!, 'native-config/1.0.0');
      const userConfig = path.join(env.CODEX_HOME!, 'config.toml');
      const projectConfig = path.join(cwd, '.codex/config.toml');
      const userIntentBefore = await observeIntent({ scope: 'user', cwd, env });
      expect(userIntentBefore).toMatchObject({ state: 'absent' });
      await fs.writeFile(rendererMarker, '');
      const readStore = () => readPluginConfigStore(store);
      const configFile = resolvePluginConfigStorePath(store);
      const snapshotOutputs = async () => ({ package: await snapshotRegularTree(packageRoot),
        user: await fs.readFile(userConfig), project: await fs.readFile(projectConfig) });
      const readStatus = () => runPublic(['plugin', 'status', '--context', 'project']);
      const assertActivation = async () => {
        expect((await readCodexConfigFile(userConfig)).snapshot.plugins[canonicalPluginId]?.enabled).toBe(false);
        expect((await readCodexConfigFile(projectConfig)).snapshot.plugins[canonicalPluginId]?.enabled).toBe(true);
        expect(await observeIntent({ scope: 'user', cwd, env })).toEqual(userIntentBefore);
      };
      return { isolation, cwd, env, runtime, runPublic, sourceIdentity, rendererMarker, readStore, writeMode,
        layout, packageRoot, skillRoot, ownerPath, canonicalPluginId, cacheRoot, configFile, snapshotOutputs, readStatus, assertActivation };
    }

    // Test Value Gate: saving and consent are separate; project apply shares bytes but never adds user intent.
    it('saves and authorizes shared native config without creating user intent', async (test) => {
      const f = await createNativeConfigFixture(test);
      const outputsBefore = await f.snapshotOutputs();
      expect(await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"saved"', '--context', 'project']))
        .toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { reason: 'notRequested', targetResults: [] } } } });
      expect(await f.snapshotOutputs()).toEqual(outputsBefore);
      expect(await fs.readFile(f.rendererMarker, 'utf8')).toBe('');
      const storeBefore = await fs.readFile(f.configFile);
      const blocked = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"blocked"', '--context', 'project', '--apply']);
      expect(blocked, JSON.stringify(blocked)).toMatchObject({ exitCode: 3, payload: { status: 'blocked', data: {
        confirmation: { required: true, provided: false, effects: expect.arrayContaining([expect.objectContaining({ code: 'replaceSharedOutput', impact: 'shared' })]) },
      } } });
      expect(await fs.readFile(f.configFile)).toEqual(storeBefore);
      expect(await f.snapshotOutputs()).toEqual(outputsBefore);
      await f.assertActivation();
      const applied = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"authorized"', '--context', 'project', '--apply', '--yes']);
      expect(applied, JSON.stringify(applied)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: {
        state: 'succeeded', targetResults: [expect.objectContaining({ target: expect.objectContaining({ platform: 'codex', scope: 'project' }), state: 'completed' })],
      } } } });
      await f.assertActivation();
      expect((await f.readStore()).values).toEqual({ mode: 'authorized' });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=authorized\nrequestScope=user\n');
      const events = (await fs.readFile(f.rendererMarker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const projectRoot = path.toNamespacedPath(await realpath(f.cwd));
        const bundleRoot = path.toNamespacedPath(event.bundleRoot);
        expect(path.toNamespacedPath(event.realCwd)).toBe(projectRoot);
        expect(path.toNamespacedPath(event.entryPath)).toBe(path.join(bundleRoot, 'scripts/render.mjs'));
        expect(bundleRoot).not.toBe(projectRoot);
        expect(path.relative(path.toNamespacedPath(await realpath(f.env.AW_HOME!)), bundleRoot)).toMatch(/^catalog-store[/\\]/u);
        const isolatedRoot = path.dirname(event.contextPath);
        expect(event.home).toBe(path.join(isolatedRoot, 'home'));
        expect(event.awHome).toBe(path.join(isolatedRoot, 'aw-home'));
        expect(event.home).not.toBe(f.env.HOME);
        expect(event.awHome).not.toBe(f.env.AW_HOME);
        expect(await fs.pathExists(isolatedRoot)).toBe(false);
        expect(event.context).toMatchObject({ surface: 'agent-plugin', scope: 'user' });
        expect(event.context.allowedOutputKinds).toEqual(event.context.allowedOutputKinds.includes('skill')
          ? ['skill'] : ['mcp', 'hook', 'instruction']);
        expect(event.context.config.schema.fields).not.toHaveProperty('projectMode');
        expect(event.context.config.values).not.toHaveProperty('projectMode');
      }
      const ownerBefore = await fs.readFile(f.ownerPath);
      expect(await f.runPublic(['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project', '--apply']))
        .toMatchObject({ exitCode: 3 });
      expect(await fs.readFile(f.ownerPath)).toEqual(ownerBefore);
      expect(await f.runPublic(['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project']))
        .toMatchObject({ exitCode: 0, payload: { data: { apply: { reason: 'notRequested' } } } });
      const savedBytes = await fs.readFile(f.configFile);
      expect(await f.runPublic(['plugin', 'config', 'apply', 'team/native-config', '--context', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'notStarted', apply: { state: 'succeeded' } } } });
      expect(await fs.readFile(f.configFile)).toEqual(savedBytes);
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=safe\n');
      expect(await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"safe"', '--context', 'project', '--apply', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { data: { updatedKeys: ['mode'], apply: { state: 'succeeded' } } } });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('source=common\n');
      await f.assertActivation();
    }, 120_000);

    // Test Value Gate: package ownership, unsafe paths and missing output are observed without executing the renderer.
    it('diagnoses and recovers damaged shared native projections without trusting cache evidence', async (test) => {
      const f = await createNativeConfigFixture(test);
      const ownerBytes = await fs.readFile(f.ownerPath);
      const owner = JSON.parse(ownerBytes.toString());
      const rendererBefore = await fs.readFile(f.rendererMarker);
      const status = await f.readStatus();
      expect(status, JSON.stringify(status)).toMatchObject({ exitCode: 0 });
      expect(await fs.readFile(f.rendererMarker)).toEqual(rendererBefore);
      await f.writeMode('drifted');
      await f.readStatus();
      expect(await fs.readFile(f.rendererMarker)).toEqual(rendererBefore);
      const applied = await f.runPublic(['plugin', 'config', 'apply', 'team/native-config', '--context', 'project', '--yes']);
      expect(applied, JSON.stringify(applied)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'notStarted', apply: { state: 'succeeded' } } } });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=drifted\n');
      const currentOwner = await fs.readFile(f.ownerPath);
      await fs.outputJson(f.ownerPath, { ...JSON.parse(currentOwner.toString()), sourceIdentity: `sha256:${'f'.repeat(64)}` });
      const foreignBytes = await f.snapshotOutputs();
      const foreign = await f.runPublic(['plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes']);
      expect(foreign, JSON.stringify(foreign)).toMatchObject({ exitCode: 3, payload: {
        status: 'blocked', data: { changes: { outputs: 'none' } },
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'stateInventoryFailed' })]),
      } });
      expect(await f.snapshotOutputs()).toEqual(foreignBytes);
      await fs.outputFile(f.ownerPath, currentOwner);
      if (process.platform !== 'win32') {
        const outside = path.join(f.cwd, 'foreign-native-config-skill');
        await fs.move(f.skillRoot, outside);
        await fs.symlink(outside, f.skillRoot, 'dir');
        const unsafeBefore = await fs.readFile(path.join(outside, 'SKILL.md'));
        const unsafe = await f.runPublic(['plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes']);
        expect(unsafe, JSON.stringify(unsafe)).toMatchObject({ exitCode: 3, payload: {
          status: 'blocked', data: { changes: { outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'stateInventoryFailed' })]),
        } });
        expect((await fs.lstat(f.skillRoot)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(outside, 'SKILL.md'))).toEqual(unsafeBefore);
        await fs.remove(f.skillRoot);
        await fs.move(outside, f.skillRoot);
      }
      await fs.remove(f.skillRoot);
      const missing = await f.readStatus();
      expect(JSON.stringify(missing.payload)).toContain('componentOutputMissing');
      const rendererBeforeStatus = await fs.readFile(f.rendererMarker);
      await f.readStatus();
      expect(await fs.readFile(f.rendererMarker)).toEqual(rendererBeforeStatus);
      const recovered = await f.runPublic(['plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes']);
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ exitCode: 0 });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=drifted\n');
      // Client cache files are not AW ownership evidence for the canonical package.
      const cacheSkill = path.join(f.cacheRoot, 'skills/native-config/SKILL.md');
      await fs.outputFile(cacheSkill, 'foreign cache bytes\n');
      const cacheBefore = await fs.readFile(cacheSkill);
      const canonicalBefore = await snapshotRegularTree(f.packageRoot);
      await f.readStatus();
      expect(await snapshotRegularTree(f.packageRoot)).toEqual(canonicalBefore);
      expect(await fs.readFile(cacheSkill)).toEqual(cacheBefore);
      expect(owner.nativeProjection.components).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'native-config', nativeName: 'native-config' })]));
      await f.assertActivation();
    }, 120_000);

    // Test Value Gate: omitting the optional Skill retains independent Instructions; failure and missing consent preserve bytes.
    it('recovers disabled shared native config and preserves scope ownership through interactive changes', async (test) => {
      const f = await createNativeConfigFixture(test);
      const disabled = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"', '--context', 'project', '--apply', '--yes']);
      expect(disabled, JSON.stringify(disabled)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { state: 'succeeded' } } } });
      expect(await fs.pathExists(f.skillRoot)).toBe(false);
      expect(await fs.pathExists(f.ownerPath)).toBe(true);
      expect(f.runtime.installed.has(f.canonicalPluginId)).toBe(true);
      const disabledOutput = await f.snapshotOutputs();
      const failed = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"fail"', '--context', 'project', '--apply', '--yes']);
      expect(failed, JSON.stringify(failed)).toMatchObject({ exitCode: 4, payload: { data: { configWrite: 'succeeded', apply: { state: 'partial' } } } });
      expect((await f.readStore()).values).toEqual({ mode: 'fail' });
      expect(await f.snapshotOutputs()).toEqual(disabledOutput);
      await f.writeMode('off');
      const configBefore = await fs.readFile(f.configFile);
      const renderBefore = await fs.readFile(f.rendererMarker);
      const callsBefore = f.runtime.nativeCliRunner.mock.calls.length;
      const cancelled = await f.runPublic(['plugin', 'config', 'reset', 'team/native-config', '--context', 'project', '--apply'], true);
      expect(cancelled).toMatchObject({ exitCode: 3 });
      expect(await fs.readFile(f.configFile)).toEqual(configBefore);
      expect(await f.snapshotOutputs()).toEqual(disabledOutput);
      expect(await fs.readFile(f.rendererMarker)).toEqual(renderBefore);
      const mutations = f.runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        return ['add', 'remove'].includes(invocation.args[index + 1] ?? '');
      });
      expect(mutations).toEqual([]);
      const restored = await f.runPublic(['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project', '--apply', '--yes'], true);
      expect(restored, JSON.stringify(restored)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { state: 'succeeded' } } } });
      expect((await f.readStore()).values).toEqual({});
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=safe\nrequestScope=user\n');
      const legacyRoot = path.join(f.cwd, '.agents/skills/native-config');
      await fs.outputFile(path.join(legacyRoot, 'SKILL.md'), 'project legacy bytes\n');
      await writeSkillOwnerMarker({ skillRoot: legacyRoot, allowedRoot: path.dirname(legacyRoot), identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity: f.sourceIdentity, pluginId: 'team/native-config',
        plugin: 'native-config', artifactKey: 'native-config', platform: 'codex', scope: 'project',
        physicalKey: getPhysicalKey({ sourceIdentity: f.sourceIdentity, pluginId: 'team/native-config', platform: 'codex',
          route: 'codex-marketplace', namespaceRoot: await canonicalNamespaceRoot(path.dirname(legacyRoot)), resourceKey: 'aw-team-native-config:legacy-skill' }),
      } });
      const legacyBefore = await snapshotRegularTree(legacyRoot);
      const userInstall = await installFixturePlugin(['team/native-config'], { cwd: f.cwd, platform: 'codex', scope: 'user' }, f.runtime);
      expect(userInstall, JSON.stringify(userInstall)).toMatchObject({ overallState: 'succeeded' });
      expect(await snapshotRegularTree(legacyRoot)).toEqual(legacyBefore);
      const reset = await f.runPublic(['plugin', 'config', 'reset', 'team/native-config', '--context', 'project', '--apply', '--yes'], true);
      expect(reset, JSON.stringify(reset)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded' } } });
      expect(await f.readStore()).toMatchObject({ values: {}, platforms: { codex: { projectMode: 'platform-only' } } });
      expect(await snapshotRegularTree(legacyRoot)).toEqual(legacyBefore);
    }, 120_000);
  });
});
