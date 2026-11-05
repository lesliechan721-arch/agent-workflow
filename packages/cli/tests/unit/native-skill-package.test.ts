import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createRebuildIntegration, inspectRebuildTarget, materializeReviewNativeSkills } from '../../src/commands/rebuild-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { CatalogResolution, PlatformName } from '../../src/types.js';
import { getArtifactSourceBundleRelativePath } from '../../src/utils/artifact-sources.js';
import { nativeSkillRenderReceiptPath, parseNativeSkillRenderReceipt } from '../../src/utils/claude-native-render-receipt.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { SYSTEM_CODEX_MANAGER } from '../../src/utils/native-cli.js';
import { inspectManagedCommand, publishManagedCommandBindings, readInstalledCommandProducer } from '../../src/utils/managed-command-store.js';
import { resolveClaudePaths } from '../../src/utils/paths.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';

const sourceIdentity = `sha256:${'a'.repeat(64)}`;

async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const catalogRoot = path.join(isolation.layout.rootDir, 'native-catalog');
  const pluginRoot = path.join(catalogRoot, 'plugins', 'native-skills');
  const rendererLog = path.join(isolation.layout.rootDir, 'native-renderer.log');
  const platforms = ['codex', 'claude'] as const;
  const targets = platforms.map((platform) => ({
    id: `${platform}-skill`, platform, target: `${platform}.skill`, scopes: ['user', 'project'],
    states: ['present'], refreshKeys: ['mode'], skillKey: 'native-skill', sourceDirs: ['./skills/native-skill'],
    runtimeConfig: { keys: ['mode'] },
  }));
  const manifest = {
    schemaVersion: 3, name: 'native-skills', version: '1.0.0', description: 'Native package fixture',
    platforms,
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    requires: { aw: { capabilities: ['aw.managed-commands.v1', 'aw.installed-runtime-config.v2'] } },
    config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common' } }, platforms: {
      codex: { fields: { mode: { type: 'string', default: 'codex-default' } } },
      claude: { fields: { mode: { type: 'string', default: 'claude-default' } } },
    } },
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    artifacts: { targets },
    managedCommands: { sets: platforms.map((platform) => ({
      set: `${platform}-tools`, producer: { kind: 'artifact', artifactId: `${platform}-skill` },
      mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'scripts/run.mjs' }],
    })) },
  };
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
  await fs.outputFile(path.join(pluginRoot, 'skills', 'native-skill', 'scripts', 'run.mjs'), 'export const available = true;\n');
  await fs.outputFile(path.join(pluginRoot, 'skills', 'native-skill', 'README.md'), '# Native Skill\n');
  await fs.outputFile(path.join(pluginRoot, 'skills', 'native-skill', 'agents', 'openai.yaml'),
    'interface:\n  display_name: Native Skill\n  short_description: Native package fixture\npolicy:\n  allow_implicit_invocation: true\n');
  for (const platform of platforms) {
    await fs.outputJson(path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json'), {
      name: manifest.name, version: manifest.version, skills: `./${platform}/skills`,
    });
    await fs.copy(path.join(pluginRoot, 'skills', 'native-skill'), path.join(pluginRoot,
      getArtifactSourceBundleRelativePath({ platform, artifactId: `${platform}-skill`, index: 0 })));
  }
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(rendererLog)}, "render\\n");`,
    'const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'if (c.scope !== "user" || c.config.targetScope !== "user" || process.cwd() !== c.plugin.rootDir) throw new Error("Native Skill input is not shared-user");',
    'console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({',
    'id,platform:c.platform,target:`${c.platform}.skill`,kind:"skill",state:"present",refreshKeys:["mode"],skillKey:"native-skill",',
    'content:{files:{"SKILL.md":`---\\nname: native-skill\\ndescription: Native package fixture\\n---\\n# ${c.config.values.mode}\\nRun {{aw.command:${c.platform}-tools/run}}.\\n`}}',
    '}))}));',
  ].join('\n'));
  for (const relative of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
    await fs.outputJson(path.join(catalogRoot, relative), {
      name: 'aw-team', owner: {}, interface: {}, plugins: [{ name: manifest.name, source: './plugins/native-skills', policy: manifest.marketplace.policy }],
    });
  }
  const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'team', sourceIdentity,
    pluginId: 'team/native-skills' };
  const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
  const config = { sourceId: 'team', sourceIdentity, pluginName: plugin.manifest.name,
    scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
  await writePluginConfigStore({ ...config, values: { mode: 'common-value' } });
  await writePluginConfigStore({ ...config, platform: 'codex', values: { mode: 'codex-value' } });
  await writePluginConfigStore({ ...config, platform: 'claude', values: { mode: 'claude-value' } });
  const claude = await createClaudeNativeTestRuntime(isolation);
  const codex = await createCodexNativeTestRuntime(isolation);
  const context = { ...createCommandExecutionContext({ env: isolation.env,
    nativeCliRunner: (invocation) => invocation.command === 'claude'
      ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation),
  }), codexManager: SYSTEM_CODEX_MANAGER };
  const integration = createRebuildIntegration({ context });
  const prepare = async (platform: PlatformName) => {
    const target = await integration.buildTarget({ plugin, platform, scope: 'project',
      cwd: isolation.layout.fixtureCwd, command: 'install', marketplaceName: 'aw-team', marketplaceRoot,
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution });
    await integration.prepareNativeMarketplaceGroup(target);
    await integration.driver.writeNative(target);
    return target;
  };
  return { isolation, plugin, integration, catalogRoot, marketplaceRoot, config, prepare, rendererLog };
}

async function claudeHealthFixture() {
  const native = await fixture();
  const { isolation, plugin, catalogRoot, marketplaceRoot } = native;
  await native.prepare('claude');
  const paths = resolveClaudePaths(isolation.layout.fixtureCwd, 'user', isolation.env);
  const pluginId = 'native-skills@aw-team';
  await fs.outputJson(paths.settingsPath, {
    extraKnownMarketplaces: { 'aw-team': { source: { source: 'directory', path: marketplaceRoot } } },
    enabledPlugins: { [pluginId]: true },
  });
  await fs.outputJson(paths.knownMarketplacesPath, {
    'aw-team': { source: { source: 'directory', path: marketplaceRoot }, installLocation: marketplaceRoot },
  });
  await fs.outputJson(paths.installedPluginsPath, {
    version: 2, plugins: { [pluginId]: [{ scope: 'user', version: plugin.manifest.version }] },
  });
  const nativeCalls: string[][] = [];
  const context = createCommandExecutionContext({
    env: isolation.env,
    nativeCliRunner: async (invocation) => {
      nativeCalls.push([...invocation.args]);
      throw new Error('Read-only Claude inspection must not execute the Native CLI.');
    },
  });
  const inspect = () => inspectRebuildTarget({
    sourceId: 'team', sourceIdentity, pluginId: 'team/native-skills',
    plugin, platform: 'claude', scope: 'user', cwd: isolation.layout.fixtureCwd,
    marketplaceName: 'aw-team', marketplaceRoot,
    catalog: { rootDir: catalogRoot, source: 'local' }, context,
  });
  return { ...native, nativeCalls, inspect, payloadRoot: path.join(marketplaceRoot, 'plugins', 'native-skills') };
}

// Test Value Gate: real renderer, filesystem projection, runtime reader and command
// records protect the Native package boundary and the platform's shared user identity.
describe('Native Skill package projection', () => {
  // Test Value Gate: preparing a complete group must not expose an unapplied
  // target's package or command resource to the installed canonical marketplace.
  it('publishes a prepared Native projection only when its target applies', async () => {
    const { isolation, plugin, integration, catalogRoot, marketplaceRoot, rendererLog } = await fixture();
    const target = await integration.buildTarget({ plugin, platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, command: 'install', marketplaceName: 'aw-team', marketplaceRoot,
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution });
    const skill = path.join(marketplaceRoot, 'plugins', 'native-skills', 'codex', 'skills', 'native-skill', 'SKILL.md');
    await integration.prepareNativeMarketplaceGroup(target);
    expect(await fs.pathExists(skill)).toBe(false);
    const rendered = await fs.readFile(rendererLog, 'utf8');
    await integration.driver.writeNative(target);
    expect(await fs.readFile(skill, 'utf8')).toContain('# codex-value');
    expect(await fs.readFile(rendererLog, 'utf8')).toBe(rendered);
  });

  // Test Value Gate: public read-only inspection must detect damaged shared Native
  // content from installed evidence without rendering or repairing the payload.
  it.each(['missing Skill', 'changed resource', 'invalid receipt'] as const)(
    'detects Claude dynamic %s during read-only inspection', async (damage) => {
      const { inspect, nativeCalls, rendererLog, payloadRoot } = await claudeHealthFixture();
      expect((await inspect()).inspection.state).toBe('present');
      const rendersBefore = await fs.readFile(rendererLog, 'utf8');
      const skillRoot = path.join(payloadRoot, 'claude', 'skills', 'native-skill');
      if (damage === 'missing Skill') await fs.remove(skillRoot);
      else if (damage === 'changed resource') await fs.appendFile(path.join(skillRoot, 'scripts', 'run.mjs'), '\n// changed\n');
      else await fs.writeFile(path.join(payloadRoot, nativeSkillRenderReceiptPath('claude')), '{invalid');

      const observed = await inspect();
      expect(observed.inspection.state).toBe('partial');
      expect(observed.inspection.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ component: expect.objectContaining({ kind: 'native-plugin' }), state: 'partial' }),
      ]));
      expect(await fs.readFile(rendererLog, 'utf8')).toBe(rendersBefore);
      expect(nativeCalls).toEqual([]);
      if (damage === 'missing Skill') expect(await fs.pathExists(skillRoot)).toBe(false);
    },
  );

  // Test Value Gate: a healthy installed package becomes stale only when the
  // selected Native platform's render inputs change; status stays read-only.
  it('detects stale Claude dynamic config without rendering or installing', async () => {
    const { inspect, config, nativeCalls, rendererLog } = await claudeHealthFixture();
    expect((await inspect()).inspection.state).toBe('present');
    const rendersBefore = await fs.readFile(rendererLog, 'utf8');
    await writePluginConfigStore({ ...config, platform: 'codex', values: { mode: 'other-platform' } });
    expect((await inspect()).inspection.state).toBe('present');
    await writePluginConfigStore({ ...config, platform: 'claude', values: { mode: 'changed' } });
    expect((await inspect()).inspection.state).toBe('partial');
    expect(await fs.readFile(rendererLog, 'utf8')).toBe(rendersBefore);
    expect(nativeCalls).toEqual([]);
  });

  it.each(['codex', 'claude'] as const)('projects %s dynamic Skills from platform user config', async (platform) => {
    const { isolation, marketplaceRoot, prepare } = await fixture();
    const target = await prepare(platform);
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'native-skills');
    const skillRoot = path.join(pluginRoot, platform, 'skills', 'native-skill');
    expect(await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).toContain(`# ${platform}-value`);
    expect(await fs.pathExists(path.join(skillRoot, 'scripts', 'run.mjs'))).toBe(true);
    expect(await fs.pathExists(path.join(skillRoot, '.agent-workflows-owner.json'))).toBe(false);
    expect(await fs.readJson(path.join(skillRoot, '.aw-command-producer.json'))).toMatchObject({
      producer: { platform, scope: 'user', projectRoot: null, kind: 'artifact', key: `${platform}-skill` },
    });
    const installed = await readInstalledCommandProducer(skillRoot);
    const commandIds = await publishManagedCommandBindings({ ...installed, resourceRoot: skillRoot, env: isolation.env });
    expect(commandIds).toHaveLength(1);
    expect(await inspectManagedCommand(commandIds[0]!, isolation.env)).toMatchObject({ availability: 'ready' });
    expect(target.desiredOwnedComponents?.some((component) => component.kind === 'skill-directory')).toBe(false);
    for (const root of [path.join(isolation.layout.fixtureCwd, '.agents', 'skills'),
      path.join(isolation.layout.fixtureCwd, '.claude', 'skills'), path.join(isolation.layout.codexHomeDir, 'skills'),
      path.join(isolation.layout.claudeHomeDir, 'skills')]) {
      expect(await fs.pathExists(path.join(root, 'native-skill'))).toBe(false);
    }
    const reader = pathToFileURL(path.join(skillRoot, 'scripts', 'aw-runtime-config.mjs')).href;
    const caller = path.join(skillRoot, 'scripts', 'run.mjs');
    const value = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval',
      `import {readRuntimeConfig} from ${JSON.stringify(reader)}; console.log(JSON.stringify(await readRuntimeConfig({from:${JSON.stringify(caller)},keys:["mode"]})));`,
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env, encoding: 'utf8' }));
    expect(value).toMatchObject({ installedIdentity: { platform, scope: 'user', configScope: 'user' },
      effectiveValues: { mode: `${platform}-value` } });
  });

  it.each(['codex', 'claude'] as const)('retains the %s projection when the other platform changes', async (retainedPlatform) => {
    const { isolation, plugin, marketplaceRoot, config, prepare } = await fixture();
    const platform = retainedPlatform === 'codex' ? 'claude' : 'codex';
    await prepare(retainedPlatform);
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'native-skills');
    const retainedSkill = path.join(pluginRoot, retainedPlatform, 'skills', 'native-skill', 'SKILL.md');
    const before = await fs.readFile(retainedSkill, 'utf8');
    await writePluginConfigStore({ ...config, platform: retainedPlatform, values: { mode: 'new-platform-value' } });
    await prepare(platform);
    expect(await fs.readFile(retainedSkill, 'utf8')).toBe(before);
    const receipt = parseNativeSkillRenderReceipt(platform, await fs.readFile(path.join(pluginRoot, nativeSkillRenderReceiptPath(platform)), 'utf8'));
    expect(receipt.targets.map((target) => target.id)).toEqual([`${platform}-skill`]);
    const review = await materializeReviewNativeSkills({ plugin, platform, scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, outputRoot: path.join(isolation.layout.rootDir, 'review'),
      skills: [{ skill: 'native-skill', targetId: `${platform}-skill` }] });
    expect(review.skills).toHaveLength(1);
    expect(await fs.readJson(path.join(review.skills[0]!.path, '.aw-runtime-config.json'))).toMatchObject({
      installedIdentity: { platform, scope: 'user', configScope: 'user' },
      nativeReceiptPath: '.aw-runtime-native-receipt.json',
    });
  });
});
