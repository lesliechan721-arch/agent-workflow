import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatformFeatureRegistry, type PlatformCapabilitiesV1 } from '@lesliechan721/aw-plugin-core/manifest';

import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { PlatformName } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import * as registry from '../../src/platforms/registry.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { materializeProfilePluginComponents } from '../../src/review/skill-materialization.js';
import * as authorProfile from '../../src/review/platform-profile.js';
import { readScopedRecoveryStatus } from '../../src/recovery/status.js';
import { observeIntent, writeIntent } from '../../src/intent/intent-store.js';
import { observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import { inspectManagedCommand, publishManagedCommandBindings, readInstalledCommandProducer } from '../../src/utils/managed-command-store.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sourceIdentity = `sha256:${'a'.repeat(64)}`;
const sessions: PlatformRebuildSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.restoreAllMocks();
});

// Test-only qualification facts permit successful orchestration. They do not
// qualify a real client; resolution, projection, ownership and status stay real.
function qualifySkillCapabilities(input: PlatformCapabilitiesV1): PlatformCapabilitiesV1 {
  const capabilities = structuredClone(input);
  capabilities.kinds.skill = { ...capabilities.kinds.skill, status: 'supported', reasonCodes: [] };
  for (const [id, feature] of Object.entries(getPlatformFeatureRegistry())) if (id.startsWith('skill.')) {
    capabilities.features[id] = { status: 'supported', reasonCodes: [], ...(feature.values ? { values: [...feature.values] } : {}) };
  }
  return capabilities;
}

function packageRoot(target: Awaited<ReturnType<ReturnType<typeof createRebuildIntegration>['buildTarget']>>): string {
  return target.platformDeployment!.plans[0]!.evidence.layout.packageRoot;
}
function skillRoot(target: Parameters<typeof packageRoot>[0]): string {
  const plan = target.platformDeployment!.plans[0]!;
  const component = plan.projections.flatMap((projection) => projection.components).find((entry) => entry.id === `${plan.binding.platform}-skill`)!;
  return path.join(packageRoot(target), 'skills', component.nativeName);
}


async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  await fs.outputFile(path.join(isolation.layout.fixtureCwd, 'pnpm-workspace.yaml'), 'packages: []\n');
  const catalogRoot = path.join(isolation.layout.rootDir, 'native-catalog');
  const pluginRoot = path.join(catalogRoot, 'plugins', 'native-skills');
  const rendererLog = path.join(isolation.layout.rootDir, 'native-renderer.log');
  const platforms = ['codex', 'claude'] as const;
  const manifest = {
    schemaVersion: 4, name: 'native-skills', version: '1.0.0', description: 'Native package fixture',
    platforms,
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    requires: { aw: { capabilities: ['aw.managed-commands.v1', 'aw.installed-runtime-config.v2'] } },
    config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common' } }, platforms: {
      codex: { fields: { mode: { type: 'string', default: 'codex-default' } } },
      claude: { fields: { mode: { type: 'string', default: 'claude-default' } } },
    } },
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    artifacts: { configKeys: ['mode'], sourceDirs: ['./skill-resources/native-skill'] },
    managedCommands: { sets: platforms.map((platform) => ({
      set: `${platform}-tools`, producer: { kind: 'artifact', platform, artifactId: `${platform}-skill` },
      mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'scripts/run.mjs' }],
    })) },
  };
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
  await fs.outputFile(path.join(pluginRoot, 'skill-resources', 'native-skill', 'scripts', 'run.mjs'), 'export const available = true;\n');
  await fs.outputFile(path.join(pluginRoot, 'skill-resources', 'native-skill', 'README.md'), '# Native Skill\n');
  await fs.outputFile(path.join(pluginRoot, 'skill-resources', 'native-skill', 'agents', 'openai.yaml'),
    'interface:\n  display_name: Native Skill\n  short_description: Native package fixture\npolicy:\n  allow_implicit_invocation: true\n');
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(rendererLog)}, 'render\\n');
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (context.surface !== 'agent-plugin') throw new Error('Unexpected component surface.');
const plan = { version: 3, components: [], omitted: [], unmet: [] };
if (context.allowedOutputKinds.includes('skill')) {
 const requirements = [{ feature: 'component.kind.skill' }, { feature: 'skill.runtime-config', values: ['aw.installed-runtime-config.v2'] }];
 const missing = requirements.filter(requirement => requirement.feature === 'component.kind.skill'
  ? context.platformCapabilities.kinds.skill.status !== 'supported'
  : context.platformCapabilities.features[requirement.feature].status !== 'supported');
 if (missing.length) plan.unmet.push({ id: context.platform + '-skill', kind: 'skill', name: 'native-skill',
  requiredFeatures: missing, reasonCode: 'capability-unverified' });
 else plan.components.push({ id: context.platform + '-skill', kind: 'skill', name: 'native-skill', runtimeConfig: { keys: ['mode'] }, content: { files: {
  'SKILL.md': { text: '---\\nname: native-skill\\ndescription: Native package fixture\\n---\\n# ' + context.config.values.mode + '\\nRun {{aw.command:' + context.platform + '-tools/run}}.\\n' },
  'README.md': { source: { kind: 'bundle', path: 'skill-resources/native-skill/README.md' } },
  'agents/openai.yaml': { source: { kind: 'bundle', path: 'skill-resources/native-skill/agents/openai.yaml' } },
  'scripts/run.mjs': { source: { kind: 'bundle', path: 'skill-resources/native-skill/scripts/run.mjs' } }
 } } });
}
console.log(JSON.stringify(plan));
`);
  for (const relative of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
    await fs.outputJson(path.join(catalogRoot, relative), {
      name: 'aw-team', owner: {}, interface: {}, plugins: [{ name: manifest.name, source: './plugins/native-skills', policy: manifest.marketplace.policy }],
    });
  }
  const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'team', sourceIdentity,
    pluginId: 'team/native-skills' };
  const config = { sourceId: 'team', sourceIdentity, pluginName: plugin.manifest.name,
    scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
  await writePluginConfigStore({ ...config, values: { mode: 'common-value' } });
  await writePluginConfigStore({ ...config, platform: 'codex', values: { mode: 'codex-value' } });
  await writePluginConfigStore({ ...config, platform: 'claude', values: { mode: 'claude-value' } });
  const realAdapters = new Map(registry.getAgentPluginAdapters().map((adapter) => [adapter.platform, adapter]));
  const adapters = new Map([...realAdapters].map(([platform, adapter]) => [platform, {
    ...adapter,
    async discover(ctx: Parameters<typeof adapter.discover>[0]) {
      return { platform, availability: 'available' as const, diagnostics: [], installations: [{
        id: `controlled:${platform}`, product: 'cli' as const,
        version: platform === 'codex' ? '0.155.0' : '2.1.292', availability: 'available' as const,
        reasonCodes: [], entry: { kind: 'cli' as const, executable: platform, configRoot: resolvePlatformConfigRoot(platform, ctx) },
      }] };
    },
    capabilities(input: Parameters<typeof adapter.capabilities>[0]) {
      return qualifySkillCapabilities(adapter.capabilities(input));
    },
    async inspect(...args: Parameters<typeof adapter.inspect>) {
      const observation = await adapter.inspect(...args);
      // A controlled host supplies trust explicitly, without claiming model load.
      for (const consumer of observation.consumers) { consumer.trust = 'trusted'; consumer.load = 'not-observed'; }
      return observation;
    },
  }]));
  vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => adapters.get(platform)!);
  const realProfile = authorProfile.getAuthoringPlatformCapabilities;
  vi.spyOn(authorProfile, 'getAuthoringPlatformCapabilities').mockImplementation((platform, scope) =>
    qualifySkillCapabilities(realProfile(platform, scope)));

  const nativeCalls: string[][] = [];
  const codexInstalled = new Map<string, string>();
  const codexMarketplaces = new Map<string, string>();
  const nativeCliRunner: NativeCliRunner = async (invocation) => {
    const { args } = invocation;
    const invocationCwd = invocation.cwd ?? isolation.layout.fixtureCwd;
    nativeCalls.push([...args]);
    const platform = path.basename(invocation.command);
    if (args.includes('--version')) return { exitCode: 0, stdout: platform === 'codex' ? 'codex-cli 0.155.0' : '2.1.292 (Claude Code)', stderr: '' };
    if (args[0] !== 'plugin') throw new Error(`Unexpected controlled host command: ${args.join(' ')}`);
    if (platform === 'codex') {
      const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
      if (args[1] === 'marketplace' && args[2] === 'add') {
        const root = args[3]!;
        const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
        codexMarketplaces.set(marketplaceName, root);
        const current = await fs.readFile(configPath, 'utf8').catch(() => '');
        await fs.outputFile(configPath, [current, `[marketplaces.${JSON.stringify(marketplaceName)}]`,
          `source = ${JSON.stringify(root)}`, 'source_type = "local"', ''].join('\n'));
      } else if (args[1] === 'add') {
        const id = args[2]!;
        const separator = id.lastIndexOf('@');
        const root = codexMarketplaces.get(id.slice(separator + 1))!;
        const manifest = await fs.readJson(path.join(root, 'plugins', id.slice(0, separator), '.codex-plugin/plugin.json'));
        codexInstalled.set(id, manifest.version);
        await applyCodexConfigTransactionFile(configPath, { upsertPluginActivations: { [id]: true } });
      } else if (args[1] === 'remove') codexInstalled.delete(args[2]!);
      else if (args[1] === 'list' && args.includes('--json')) {
        const [user, project] = await Promise.all([readCodexConfigFile(configPath),
          readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex/config.toml'))]);
        const exact = path.resolve(invocationCwd) === path.resolve(isolation.layout.fixtureCwd);
        const marketplace = args[args.indexOf('--marketplace') + 1];
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ installed: [...codexInstalled]
          .filter(([id]) => id.endsWith(`@${marketplace}`)).map(([pluginId, version]) => ({ pluginId, installed: true, version,
            enabled: user.snapshot.plugins[pluginId]?.enabled === true || exact && project.snapshot.plugins[pluginId]?.enabled === true,
          })), available: [] }) };
      } else throw new Error(`Unexpected controlled Codex command: ${args.join(' ')}`);
    } else if (platform === 'claude') {
      const home = resolvePlatformConfigRoot('claude', { cwd: invocationCwd, env: isolation.env });
      const knownPath = path.join(home, 'plugins/known_marketplaces.json');
      const known = await fs.readJson(knownPath).catch(() => ({}));
      if (args[1] === 'marketplace' && args[2] === 'add') {
        const root = args[3]!;
        const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
        await fs.outputJson(knownPath, { ...known, [marketplaceName]: { source: { source: 'directory', path: root }, installLocation: root } });
      } else {
        const id = args[2]!;
        const scope = args[args.indexOf('--scope') + 1];
        const settingsPath = scope === 'local' ? path.join(invocationCwd, '.claude/settings.local.json') : path.join(home, 'settings.json');
        const settings = await fs.readJson(settingsPath).catch(() => ({}));
        const installedPath = path.join(home, 'plugins/installed_plugins.json');
        const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} }));
        const records = (installed.plugins[id] ?? []).filter((record: { scope: string; projectPath?: string }) =>
          record.scope !== scope || scope === 'local' && record.projectPath !== invocationCwd);
        if (['install', 'update', 'uninstall'].includes(args[1]!)) {
          if (args[1] !== 'uninstall') {
            const marketplace = known[id.slice(id.lastIndexOf('@') + 1)];
            const root = path.join(marketplace.installLocation, 'plugins', id.slice(0, id.lastIndexOf('@')));
            const manifest = await fs.readJson(path.join(root, '.claude-plugin/plugin.json'));
            records.push({ scope, ...(scope === 'local' ? { projectPath: invocationCwd } : {}), version: manifest.version, installPath: root });
          }
          const plugins = { ...installed.plugins };
          if (records.length) plugins[id] = records; else delete plugins[id];
          await fs.outputJson(installedPath, { version: 2, plugins });
        }
        if (['install', 'enable', 'disable', 'uninstall'].includes(args[1]!)) await fs.outputJson(settingsPath,
          { ...settings, enabledPlugins: { ...settings.enabledPlugins, [id]: !['disable', 'uninstall'].includes(args[1]!) } });
      }
    } else throw new Error(`Unexpected controlled host: ${platform}`);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const context: RebuildExecutionContext = createCommandExecutionContext({ env: isolation.env, nativeCliRunner });
  context.platformRebuildSession = new PlatformRebuildSession(context);
  sessions.push(context.platformRebuildSession);
  const integration = createRebuildIntegration({ context });
  const build = async (platform: PlatformName) => {
    const target = await integration.buildTarget({ plugin, platform, scope: 'project',
      cwd: isolation.layout.fixtureCwd, command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' } });
    await integration.sealMarketplaceGenerations([target]);
    return target;
  };
  const apply = async (target: Awaited<ReturnType<typeof build>>) => {
    const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect(result.deploymentReceipts?.flatMap((receipt) => receipt.effects)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'applied', mutation: 'confirmed' }),
    ]));
    return target;
  };
  const prepare = async (platform: PlatformName) => apply(await build(platform));
  return { isolation, plugin, integration, catalogRoot, config, build, apply, prepare, rendererLog, nativeCalls, nativeCliRunner };
}

async function claudeHealthFixture() {
  const native = await fixture();
  const { isolation, plugin, nativeCliRunner } = native;
  const target = await native.prepare('claude');
  const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
  await writeIntent(location, { schemaVersion: 3, kind: 'aw-plugin-intents',
    sources: { team: { logicalIdentity: 'controlled-team-source' } }, roots: [{ pluginId: plugin.pluginId }] });
  await writePreferences(location, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['claude'], exclusions: [] });
  const inspect = async () => {
    const status = await readScopedRecoveryStatus({ ...location, nativeCliRunner, demandOverride: {
      scope: 'project', intent: await observeIntent(location), preferences: await observePreferences(location),
      roots: [{ pluginId: plugin.pluginId, sourceId: 'team', sourceState: 'ready', blockers: [], plugin }],
      plugins: [plugin], errors: [],
    } });
    expect(status.errors, JSON.stringify(status)).toEqual([]);
    return status.inventory![0]!.targetResults[0]!;
  };
  native.nativeCalls.length = 0;
  return { ...native, target, inspect, payloadRoot: packageRoot(target), skillRoot: skillRoot(target) };
}

// Test Value Gate: real renderer, filesystem projection, runtime reader and command
// records protect the Native package boundary and the platform's shared user identity.
describe('Native Skill package projection', () => {
  // Test Value Gate: preparing a complete group must not expose an unapplied
  // target's package or command resource to the installed canonical marketplace.
  it('publishes a prepared Native projection only when its target applies', async () => {
    const { build, apply, rendererLog } = await fixture();
    const target = await build('codex');
    const skill = path.join(skillRoot(target), 'SKILL.md');
    expect(await fs.pathExists(packageRoot(target))).toBe(false);
    const rendered = await fs.readFile(rendererLog, 'utf8');
    await apply(target);
    expect(await fs.readFile(skill, 'utf8')).toContain('# codex-value');
    expect(await fs.readFile(rendererLog, 'utf8')).toBe(rendered);
  });

  // Test Value Gate: public read-only inspection must detect damaged shared Native
  // content from installed evidence without rendering or repairing the payload.
  it.each(['missing Skill', 'changed resource', 'invalid projection evidence'] as const)(
    'detects Claude dynamic %s during read-only inspection', async (damage) => {
      const { inspect, nativeCalls, rendererLog, payloadRoot, skillRoot } = await claudeHealthFixture();
      expect((await inspect()).content).toBe('satisfied');
      const rendersBefore = await fs.readFile(rendererLog, 'utf8');
      if (damage === 'missing Skill') await fs.remove(skillRoot);
      else if (damage === 'changed resource') await fs.appendFile(path.join(skillRoot, 'scripts', 'run.mjs'), '\n// changed\n');
      else {
        const markerPath = path.join(payloadRoot, '.agent-workflows-owner.json');
        const marker = await fs.readJson(markerPath);
        marker.nativeProjection.contentDigest = 'invalid';
        await fs.writeJson(markerPath, marker);
      }

      const observed = await inspect();
      expect(observed.content).toBe(damage === 'invalid projection evidence' ? 'unknown' : 'drifted');
      expect(observed.deploymentObservations?.[0]?.after).toMatchObject({ package: 'present', ownership: 'aw' });
      expect(observed.blockers).toContainEqual(expect.objectContaining({ code:
        damage === 'invalid projection evidence' ? 'platformExpectationUnconfirmed' : 'platformContentDrift' }));
      if (damage === 'missing Skill') expect(observed.deploymentObservations?.[0]?.after.components)
        .toContainEqual(expect.objectContaining({ id: 'claude-skill', presence: 'absent' }));
      expect(await fs.readFile(rendererLog, 'utf8')).toBe(rendersBefore);
      expect(nativeCalls).toEqual([]);
      if (damage === 'missing Skill') expect(await fs.pathExists(skillRoot)).toBe(false);
    },
  );

  // Test Value Gate: a healthy installed package becomes stale only when the
  // selected Native platform's render inputs change; status stays read-only.
  it('detects stale Claude dynamic config without rendering or installing', async () => {
    const { inspect, config, nativeCalls, rendererLog } = await claudeHealthFixture();
    expect((await inspect()).content).toBe('satisfied');
    const rendersBefore = await fs.readFile(rendererLog, 'utf8');
    await writePluginConfigStore({ ...config, platform: 'codex', values: { mode: 'other-platform' } });
    expect((await inspect()).content).toBe('satisfied');
    await writePluginConfigStore({ ...config, platform: 'claude', values: { mode: 'changed' } });
    const stale = await inspect();
    expect(stale.content).toBe('drifted');
    expect(stale.blockers).toContainEqual(expect.objectContaining({ code: 'platformInputDrift' }));
    expect(await fs.readFile(rendererLog, 'utf8')).toBe(rendersBefore);
    expect(nativeCalls).toEqual([]);
  });

  it.each(['codex', 'claude'] as const)('projects %s dynamic Skills from platform user config', async (platform) => {
    const { isolation, prepare } = await fixture();
    const target = await prepare(platform);
    const skill = skillRoot(target);
    expect(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8')).toContain(`# ${platform}-value`);
    expect(await fs.pathExists(path.join(skill, 'scripts', 'run.mjs'))).toBe(true);
    expect(await fs.pathExists(path.join(skill, '.agent-workflows-owner.json'))).toBe(false);
    expect(await fs.readJson(path.join(skill, '.aw-command-producer.json'))).toMatchObject({
      producer: { platform, scope: 'user', projectRoot: null, kind: 'artifact', key: `${platform}-skill` },
    });
    const installed = await readInstalledCommandProducer(skill);
    const commandIds = await publishManagedCommandBindings({ ...installed, resourceRoot: skill, env: isolation.env });
    expect(commandIds).toHaveLength(1);
    expect(await inspectManagedCommand(commandIds[0]!, isolation.env)).toMatchObject({ availability: 'ready' });
    expect(target.desiredOwnedComponents?.some((component) => component.kind === 'skill-directory')).toBe(false);
    for (const root of [path.join(isolation.layout.fixtureCwd, '.agents', 'skills'),
      path.join(isolation.layout.fixtureCwd, '.claude', 'skills'), path.join(isolation.layout.codexHomeDir, 'skills'),
      path.join(isolation.layout.claudeHomeDir, 'skills')]) {
      expect(await fs.pathExists(path.join(root, 'native-skill'))).toBe(false);
    }
    const reader = pathToFileURL(path.join(skill, 'scripts', 'aw-runtime-config.mjs')).href;
    const caller = path.join(skill, 'scripts', 'run.mjs');
    const value = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval',
      `import {readRuntimeConfig} from ${JSON.stringify(reader)}; console.log(JSON.stringify(await readRuntimeConfig({from:${JSON.stringify(caller)},keys:["mode"]})));`,
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env, encoding: 'utf8' }));
    expect(value).toMatchObject({ installedIdentity: { platform, scope: 'user', configScope: 'user' },
      effectiveValues: { mode: `${platform}-value` } });
  });

  it.each(['codex', 'claude'] as const)('retains the %s projection when the other platform changes', async (retainedPlatform) => {
    const { isolation, plugin, config, prepare } = await fixture();
    const platform = retainedPlatform === 'codex' ? 'claude' : 'codex';
    const retained = await prepare(retainedPlatform);
    const retainedSkill = path.join(skillRoot(retained), 'SKILL.md');
    const retainedMarker = await fs.readFile(path.join(packageRoot(retained), '.agent-workflows-owner.json'), 'utf8');
    const before = await fs.readFile(retainedSkill, 'utf8');
    await writePluginConfigStore({ ...config, platform: retainedPlatform, values: { mode: 'new-platform-value' } });
    const changed = await prepare(platform);
    expect(packageRoot(changed)).not.toBe(packageRoot(retained));
    expect(await fs.readFile(retainedSkill, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(packageRoot(retained), '.agent-workflows-owner.json'), 'utf8')).toBe(retainedMarker);
    const marker = await fs.readJson(path.join(packageRoot(changed), '.agent-workflows-owner.json'));
    expect(marker.nativeProjection).toMatchObject({ preparation: 'complete',
      physicalIdentity: { platform, sourceIdentity, pluginId: plugin.pluginId },
      components: [expect.objectContaining({ id: `${platform}-skill` })] });
    const review = await materializeProfilePluginComponents({ plugin, platform, scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, outputRoot: path.join(isolation.layout.rootDir, 'review'),
      selectedSkills: ['native-skill'], kinds: ['skill'] });
    expect(review.skills).toHaveLength(1);
    expect(review.preparation.flatMap((unit) => unit.unmet)).toEqual([]);
    expect(await fs.readJson(path.join(review.skills[0]!.path, '.aw-runtime-config.json'))).toMatchObject({
      installedIdentity: { platform, scope: 'user', configScope: 'user' },
    });
    expect(await fs.readFile(path.join(review.skills[0]!.path, 'SKILL.md'), 'utf8')).toContain(`# ${platform}-value`);
  });
});
