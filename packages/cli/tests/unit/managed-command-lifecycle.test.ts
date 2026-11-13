import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformFeatureRegistry } from '@lesliechan721/aw-plugin-core/manifest';

import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import type { PlatformName, PluginMeta, RebuildCommand, Scope } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { listManagedCommands, listManagedCommandPackages, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { runManagedCommand } from '../../src/utils/managed-command-runtime.js';
import { syncPluginManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { git } from '../helpers/catalog-source-fixture.js';

describe('managed command plugin lifecycle', () => {
  let isolated: IsolatedTestEnvironment;
  let pluginRoot: string;
  let capturePath: string;
  const contexts: RebuildExecutionContext[] = [];
  const sourceIdentity = `sha256:${'a'.repeat(64)}`;
  const baseManifest = {
    schemaVersion: 4, name: 'managed-lifecycle', version: '1.0.0', description: 'Lifecycle fixture.',
    platforms: ['opencode', 'claude'], requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
  };
  const tool = 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n';
  const skillFiles = { 'SKILL.md': '---\nname: provider\ndescription: Lifecycle fixture.\n---\n{{aw.command:tools/run}} check\n', 'scripts/tool.mjs': tool };

  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    pluginRoot = path.join(isolated.layout.fixtureCwd, 'plugin');
    capturePath = path.join(isolated.layout.fixtureCwd, 'capture.json');
    isolated.env.CAPTURE_FILE = capturePath;
    const bin = path.join(isolated.layout.fixtureCwd, 'native-bin');
    for (const name of ['opencode', 'claude']) await fs.outputFile(path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    isolated.env.PATH = bin;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await Promise.all(contexts.splice(0).map((context) => context.platformRebuildSession?.dispose()));
    await isolated.cleanup();
  });

  async function readFixture(): Promise<PluginMeta> {
    const source = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity, pluginId: 'fixture/managed-lifecycle' };
    const root = path.join(isolated.layout.fixtureCwd, `bundle-${crypto.randomUUID()}`);
    await bundleLocalPlugin(source, root, { commandEnv: isolated.env });
    return { ...await readPluginManifest(root, { mode: 'bundle' }), sourceId: source.sourceId, sourceIdentity, pluginId: source.pluginId };
  }
  async function nativeRunner(invocation: Parameters<NonNullable<RebuildExecutionContext['nativeCliRunner']>>[0]) {
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: /claude/iu.test(invocation.command) ? '2.1.292 (Claude Code)' : 'opencode 2.0.0', stderr: '' };
    const args = invocation.args;
    if (args[0] !== 'plugin') throw new Error('Unexpected fixture native mutation.');
    const home = isolated.env.AW_CLAUDE_HOME!;
    const knownPath = path.join(home, 'plugins/known_marketplaces.json');
    const known = await fs.readJson(knownPath).catch(() => ({}));
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      await fs.outputJson(knownPath, { ...known, [marketplaceName]: { source: { source: 'directory', path: root }, installLocation: root } });
    } else {
      const id = args[2]!;
      const scope = args[args.indexOf('--scope') + 1];
      const settingsPath = scope === 'local' ? path.join(invocation.cwd, '.claude/settings.local.json') : path.join(home, 'settings.json');
      const settings = await fs.readJson(settingsPath).catch(() => ({}));
      const installedPath = path.join(home, 'plugins/installed_plugins.json');
      const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} }));
      const records = (installed.plugins[id] ?? []).filter((record: { scope: string; projectPath?: string }) => record.scope !== scope || scope === 'local' && record.projectPath !== invocation.cwd);
      if (['install', 'update', 'uninstall'].includes(args[1]!)) {
        if (args[1] !== 'uninstall') {
          const marketplace = known[id.slice(id.lastIndexOf('@') + 1)];
          const root = path.join(marketplace.installLocation, 'plugins', id.slice(0, id.lastIndexOf('@')));
          const manifest = await fs.readJson(path.join(root, '.claude-plugin/plugin.json'));
          records.push({ scope, ...(scope === 'local' ? { projectPath: invocation.cwd } : {}), version: manifest.version, installPath: root });
        }
        const plugins = { ...installed.plugins };
        if (records.length) plugins[id] = records;
        else delete plugins[id];
        await fs.outputJson(installedPath, { plugins });
      }
      if (['install', 'enable', 'disable', 'uninstall'].includes(args[1]!)) await fs.outputJson(settingsPath, { ...settings, enabledPlugins: { ...settings.enabledPlugins, [id]: !['disable', 'uninstall'].includes(args[1]!) } });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  function integrationFor(env = isolated.env) {
    const context: RebuildExecutionContext = createCommandExecutionContext({ env, nativeCliRunner: nativeRunner });
    // Replace qualification facts only. Discovery, layout, renderer, projection, ownership and execution remain real.
    context.platformRebuildSession = new PlatformRebuildSession(context, (platform) => {
      const adapter = getAgentPluginAdapter(platform);
      return { ...adapter, capabilities: (input) => {
        const facts = adapter.capabilities(input);
        facts.kinds.skill = { ...facts.kinds.skill, status: 'supported', reasonCodes: [] };
        for (const [id, feature] of Object.entries(getPlatformFeatureRegistry())) if (id.startsWith('skill.')) facts.features[id] = { status: 'supported', reasonCodes: [], ...(feature.values ? { values: [...feature.values] } : {}) };
        return facts;
      } };
    });
    contexts.push(context);
    return { integration: createRebuildIntegration({ context }), context };
  }
  function input(plugin: PluginMeta, command: RebuildCommand, platform: PlatformName, scope: Scope = 'user') {
    return { plugin, command, platform, scope, cwd: isolated.layout.fixtureCwd, sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginId: plugin.pluginId,
      catalog: { rootDir: plugin.rootDir, source: 'local' as const, catalogVersion: '1.0.0', channel: 'stable' as const } };
  }
  async function execute(plugin: PluginMeta, command: RebuildCommand, options: { platform?: PlatformName; scope?: Scope; env?: NodeJS.ProcessEnv } = {}) {
    const { integration, context } = integrationFor(options.env);
    const target = await integration.buildTarget(input(plugin, command, options.platform ?? 'opencode', options.scope));
    await integration.sealMarketplaceGenerations?.([target]);
    const result = await executeRebuildOperation({ command, target, driver: integration.driver });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    return { target, context, result };
  }
  async function writeDynamicFixture(options: { platform?: 'opencode' | 'claude'; key?: string; tracePath?: string } = {}) {
    const platform = options.platform ?? 'opencode';
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), { ...baseManifest, platforms: [platform],
      config: { schemaVersion: 5, fields: { revision: { type: 'string', default: 'v1' }, empty: { type: 'boolean', default: false } } },
      artifacts: { configKeys: ['revision', 'empty'] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', platform, artifactId: 'provider' }, mode: options.key ? 'static' : 'dynamic',
        ...(options.key ? { entries: [{ key: options.key, runner: 'node', entry: 'scripts/tool.mjs' }] } : { refreshKeys: ['revision', 'empty'] }) }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      ...(options.tracePath ? [`fs.appendFileSync(${JSON.stringify(options.tracePath)},JSON.stringify({surface:c.surface,scope:c.scope})+'\\n');`] : []),
      `const files=${JSON.stringify(skillFiles)};`,
      ...(options.key ? ["files['SKILL.md']='---\\nname: provider\\ndescription: Lifecycle fixture.\\n---\\nProvider.\\n';"] : ["if(c.config.values.empty)files['SKILL.md']='---\\nname: provider\\ndescription: Lifecycle fixture.\\n---\\nNo commands.\\n';"]),
      "if(c.surface==='agent-plugin')console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:'provider',kind:'skill',name:'provider',content:{files:Object.fromEntries(Object.entries(files).map(([file,text])=>[file,{text}]))}}]:[],omitted:[],unmet:[]}));",
      "else if(c.surface==='agent-commands')console.log(JSON.stringify({version:2,artifacts:[{id:'command-set.tools',target:'aw.command-set',kind:'commandSet',platform:c.platform,state:'present',refreshKeys:['revision','empty'],entries:c.config.values.empty?[]:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values.revision,c.scope],cwd:'resource'}]}]}));",
      "else throw new Error('Unexpected command request.');",
    ].join('\n'));
  }

  // A command identity conflict must fail before replacing any of the installed producer bytes.
  it('preserves an installed producer when newly prepared command identities collide', async () => {
    const createHash = crypto.createHash;
    vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
      const hash = createHash(algorithm, options);
      const update = hash.update.bind(hash);
      const digest = hash.digest.bind(hash);
      let command = false;
      hash.update = ((data: Parameters<typeof hash.update>[0], ...rest: unknown[]) => { if (typeof data === 'string' && data.includes('"schemaVersion":2') && data.includes('"producer":') && data.includes('"set":')) command = true; Reflect.apply(update, hash, [data, ...rest]); return hash; }) as typeof hash.update;
      hash.digest = ((encoding?: crypto.BinaryToTextEncoding) => { const value = encoding ? digest(encoding) : digest(); return command && typeof value === 'string' ? '0123456789abcdef' + value.slice(16) : value; }) as typeof hash.digest;
      return hash;
    });
    syncBuiltinESMExports();
    await writeDynamicFixture({ key: 'first' });
    await execute(await readFixture(), 'install');
    const installed = (await listManagedCommands(isolated.env)).commands[0]!;
    const binding = path.join(isolated.layout.awHomeDir, 'commands/bindings', `${installed.id}.json`);
    const record = path.join(installed.resourceRoot!, '.aw-command-producer.json');
    const before = await Promise.all([binding, record, path.join(installed.resourceRoot!, 'SKILL.md')].map((file) => fs.readFile(file, 'utf8')));
    await writeDynamicFixture({ key: 'second' });
    const plugin = await readFixture();
    const { integration } = integrationFor();
    await expect(integration.buildTarget(input(plugin, 'sync', 'opencode'))).rejects.toThrow('commandIdentityConflict');
    expect(await Promise.all([binding, record, path.join(installed.resourceRoot!, 'SKILL.md')].map((file) => fs.readFile(file, 'utf8')))).toEqual(before);
  });

  it('installs, runs, refreshes, reinstalls, empties and cleans one complete artifact producer', async () => {
    await writeDynamicFixture();
    const plugin = await readFixture();
    const installed = await execute(plugin, 'install');
    const command = (await listManagedCommands(isolated.env)).commands[0]!;
    expect(installed.target.platformDeployment?.plans[0]?.effects.some((effect) => effect.kind === 'publish-package')).toBe(true);
    expect(await fs.readFile(path.join(command.resourceRoot!, 'SKILL.md'), 'utf8')).toContain(`aw command run ${command.id} -- check`);
    expect(await runManagedCommand({ id: command.id, args: ['argument'], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
    expect(await fs.readJson(capturePath)).toEqual({ args: ['v1', 'user', 'argument'], cwd: command.resourceRoot });
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2' } });
    await execute(plugin, 'sync');
    expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['v2', 'user']);
    await execute(plugin, 'reinstall');
    expect((await listManagedCommands(isolated.env)).commands.map((command) => command.id)).toEqual([command.id]);
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2', empty: true } });
    await execute(plugin, 'sync');
    expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    await execute(plugin, 'cleanup');
    expect(await fs.pathExists(command.resourceRoot!)).toBe(false);
  });

  // A missing producer blocks its own bindings; unrelated Skills and an independent command package still publish.
  it('publishes independent Skill and package outputs while reporting one missing producer', async () => {
    await writeDynamicFixture({ key: 'ready' });
    const manifestPath = path.join(pluginRoot, '.agents-plugin/plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.managedCommands.packages = [{ key: 'independent', scope: 'user', platforms: ['opencode'], sourceDir: './tools' }];
    manifest.managedCommands.sets.push({ set: 'bad', producer: { kind: 'artifact', platform: 'opencode', artifactId: 'missing-id' },
      mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'scripts/tool.mjs' }] }, {
      set: 'independent', producer: { kind: 'package', packageKey: 'independent' }, mode: 'static',
      entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }],
    });
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'process.exitCode = 0;\n');
    const plugin = await readFixture();
    const { integration, context } = integrationFor();
    const target = await integration.buildTarget(input(plugin, 'install', 'opencode'));
    await integration.sealMarketplaceGenerations?.([target]);
    const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
    expect(result.status).toBe('failed');
    expect(result.deploymentReceipts?.flatMap((receipt) => receipt.diagnostics)).toContainEqual(expect.objectContaining({ code: 'managedCommandProducerFailed' }));
    const commands = (await listManagedCommands(isolated.env)).commands;
    expect(commands.map((command) => command.name).sort()).toEqual(['independent/run/default', 'tools/ready/default']);
    expect(commands.every((command) => command.availability === 'ready')).toBe(true);
    expect(context.commandResults).toContainEqual(expect.objectContaining({ producer: expect.objectContaining({ kind: 'package', key: 'independent' }), state: 'completed' }));
    const packageRoot = target.platformDeployment!.plans[0]!.evidence.layout.packageRoot;
    expect(await fs.pathExists(path.join(packageRoot, 'skills/provider/SKILL.md'))).toBe(true);
  });

  it('updates and revokes only the selected physical placement', async () => {
    await writeDynamicFixture();
    const plugin = await readFixture();
    const environments = ['a', 'b'].map((name) => ({ ...isolated.env, XDG_CONFIG_HOME: path.join(isolated.layout.fixtureCwd, `config-${name}`) }));
    await execute(plugin, 'install', { env: environments[0] });
    const firstId = (await listManagedCommands(environments[0]!)).commands[0]!.id;
    await execute(plugin, 'install', { env: environments[1] });
    const commands = (await listManagedCommands(environments[0]!)).commands;
    expect(commands).toHaveLength(2);
    const first = commands.find((command) => command.id === firstId)!;
    const second = commands.find((command) => command.id !== first.id)!;
    expect(first.owner.kind === 'plugin' && first.owner.producer.placementKey).not.toBe(second.owner.kind === 'plugin' && second.owner.producer.placementKey);
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: environments[0]!, values: { revision: 'v2' } });
    await execute(plugin, 'sync', { env: environments[0] });
    expect((await resolveManagedCommand(first.id, environments[0])).launch.args).toEqual(['v2', 'user']);
    expect((await resolveManagedCommand(second.id, environments[1])).launch.args).toEqual(['v1', 'user']);
    await execute(plugin, 'cleanup', { env: environments[0] });
    await expect(resolveManagedCommand(first.id, environments[0])).rejects.toMatchObject({ code: 'commandNotFound' });
    expect((await resolveManagedCommand(second.id, environments[1])).view.availability).toBe('ready');
  });

  it('uses one shared-user producer across Claude user and project activation', async () => {
    await git(isolated.layout.fixtureCwd, ['init']);
    const trace = path.join(isolated.layout.fixtureCwd, 'shared-trace.jsonl');
    await writeDynamicFixture({ platform: 'claude', tracePath: trace });
    const plugin = await readFixture();
    const { integration } = integrationFor();
    await integration.resolvePlatformTargets?.(['user', 'project'].map((scope) => input(plugin, 'install', 'claude', scope as Scope)));
    const targets = [];
    for (const scope of ['user', 'project'] as const) targets.push(await integration.buildTarget(input(plugin, 'install', 'claude', scope)));
    await integration.sealMarketplaceGenerations?.(targets);
    for (const target of targets) {
      const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
      expect(result.status, JSON.stringify(result)).toBe('succeeded');
    }
    const commands = (await listManagedCommands(isolated.env)).commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]!.owner).toMatchObject({ kind: 'plugin', producer: { scope: 'user', projectRoot: null } });
    expect((await resolveManagedCommand(commands[0]!.id, isolated.env)).launch.args).toEqual(['v1', 'user']);
    const requests = (await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.filter((request) => request.surface === 'agent-commands')).toEqual([{ surface: 'agent-commands', scope: 'user' }]);
    await execute(plugin, 'cleanup', { platform: 'claude', scope: 'project' });
    expect((await resolveManagedCommand(commands[0]!.id, isolated.env)).view.availability).toBe('ready');
  });

  // The independent package uses its frozen Review bytes and survives platform consumer removal.
  it('publishes frozen package bytes, retains the package on cleanup and rejects a changed package action', async () => {
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), tool);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), { ...baseManifest, scripts: undefined,
      managedCommands: { packages: [{ key: 'shared', scope: 'user', platforms: ['opencode'], sourceDir: './tools' }],
        sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'shared' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'tool.mjs', args: ['frozen'] }] }] } });
    const plugin = await readFixture();
    const installed = await execute(plugin, 'install');
    const command = (await listManagedCommands(isolated.env)).commands[0]!;
    expect(installed.context.commandResults).toMatchObject([{ state: 'completed', commandIds: [command.id] }]);
    expect(command.owner).toMatchObject({ kind: 'plugin', producer: { kind: 'package', platform: null, placementKey: null } });
    await execute(plugin, 'cleanup');
    expect((await listManagedCommandPackages(isolated.env)).packages).toHaveLength(1);
    expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['frozen']);
    const { integration } = integrationFor();
    const target = await integration.buildTarget(input(plugin, 'sync', 'opencode'));
    await integration.sealMarketplaceGenerations?.([target]);
    const action = target.operationActions?.find((action) => action.kind === 'syncManagedCommandPackage');
    if (action?.kind !== 'syncManagedCommandPackage') throw new Error('Missing frozen package action.');
    action.contentDigest = `sha256:${'0'.repeat(64)}`;
    await expect(integration.driver.applyManagedCommands!(target)).rejects.toThrow('commandPackagePublishFailed');
    expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['frozen']);
  });

  // Multiple platform consumers share the same independent package request and command identity.
  it('prepares a shared command package once for two platform consumers and retains it after both are cleaned', async () => {
    const trace = path.join(isolated.layout.fixtureCwd, 'surfaces.jsonl');
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), tool);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), { ...baseManifest, artifacts: { configKeys: [] },
      managedCommands: { packages: [{ key: 'shared', scope: 'user', platforms: ['opencode', 'claude'], sourceDir: './tools', render: true }],
        sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'shared' }, mode: 'dynamic', refreshKeys: [] }] } });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(typeof c.surface==='string'?c.surface:c.surface.name)+'\\n');`,
      "if(c.surface==='agent-plugin'){const name=c.platform+'-consumer';console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:'consumer',kind:'skill',name,content:{files:{'SKILL.md':{text:'---\\nname: '+name+'\\ndescription: Package consumer.\\n---\\n{{aw.command:tools/run}} check\\n'}}}}]:[],omitted:[],unmet:[]}));}",
      "else console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>id==='command-package.shared'?{id,target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:[],files:{'settings.json':'{}'}}:{id,target:'aw.command-set',kind:'commandSet',state:'present',refreshKeys:[],entries:[{key:'run',runner:'node',entry:'tool.mjs',args:['package']} ]})}));",
    ].join('\n'));
    const plugin = await readFixture();
    const { integration, context } = integrationFor();
    await integration.resolvePlatformTargets?.(['opencode', 'claude'].map((platform) => input(plugin, 'install', platform as PlatformName)));
    const targets = [];
    for (const platform of ['opencode', 'claude'] as const) targets.push(await integration.buildTarget(input(plugin, 'install', platform)));
    await integration.sealMarketplaceGenerations?.(targets);
    for (const target of targets) {
      const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
      expect(result.status, JSON.stringify(result)).toBe('succeeded');
    }
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((surface) => surface === 'managed-commands')).toEqual(['managed-commands']);
    expect(context.commandResults?.filter((result) => result.producer.kind === 'package')).toHaveLength(1);
    const command = (await listManagedCommands(isolated.env)).commands[0]!;
    expect(command.owner).toMatchObject({ kind: 'plugin', producer: { kind: 'package', platform: null, placementKey: null } });
    for (const target of targets) {
      const plan = target.platformDeployment!.plans[0]!;
      const body = await fs.readFile(path.join(plan.evidence.layout.packageRoot, 'skills', `${plan.binding.platform}-consumer/SKILL.md`), 'utf8');
      expect(body).toContain(`aw command run ${command.id} -- check`);
    }
    for (const platform of ['opencode', 'claude'] as const) await execute(plugin, 'cleanup', { platform });
    expect((await listManagedCommandPackages(isolated.env)).packages).toHaveLength(1);
    expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['package']);
  });

  // Complete static runtime resources keep their executable mode when only a shared activation is cleaned.
  it.skipIf(process.platform === 'win32')('keeps a shared executable command after reinstall and source-unavailable activation cleanup', async () => {
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'), skillFiles['SKILL.md']);
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/scripts/run.sh'), '#!/bin/sh\nprintf "%s" "$1" > "$CAPTURE_FILE"\n', { mode: 0o755 });
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), { ...baseManifest, platforms: ['claude'], scripts: undefined, skills: './skills',
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'provider' }, mode: 'static', entries: [{ key: 'run', runner: 'executable', entry: 'scripts/run.sh', args: ['preserved-mode'] }] }] } });
    const plugin = await readFixture();
    let commandId = '';
    for (const command of ['install', 'reinstall'] as const) {
      await execute(plugin, command, { platform: 'claude' });
      const installed = (await listManagedCommands(isolated.env)).commands[0]!;
      if (commandId) expect(installed.id).toBe(commandId);
      commandId = installed.id;
      expect(await runManagedCommand({ id: commandId, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
      expect(await fs.readFile(capturePath, 'utf8')).toBe('preserved-mode');
    }
    await git(isolated.layout.fixtureCwd, ['init']);
    await execute(plugin, 'install', { platform: 'claude', scope: 'project' });
    await fs.remove(plugin.rootDir);
    await execute(plugin, 'cleanup', { platform: 'claude', scope: 'project' });
    expect((await resolveManagedCommand(commandId, isolated.env)).view.availability).toBe('ready');
    expect(await runManagedCommand({ id: commandId, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
  });

  it('retains unrequested package sets and prunes deleted declarations only on complete refresh', async () => {
    const trace = path.join(isolated.layout.fixtureCwd, 'package-requests.jsonl');
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), tool);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), { ...baseManifest,
      config: { schemaVersion: 5, fields: { revision: { type: 'string', default: 'v1' }, empty: { type: 'boolean', default: false } } },
      managedCommands: { packages: [{ key: 'shared', scope: 'user', platforms: ['opencode'], sourceDir: './tools' }], sets: ['first', 'second'].map((set) => ({ set, producer: { kind: 'package', packageKey: 'shared' }, mode: 'dynamic', refreshKeys: ['revision', 'empty'] })) } });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8')); fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(c.requestedArtifactIds)+'\\n'); console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',state:'present',refreshKeys:['revision','empty'],entries:c.config.values.empty?[]:[{key:'run',runner:'node',entry:'tool.mjs',args:[c.config.values.revision,id]}]}))}));`);
    const plugin = await readFixture();
    const sync = (requestedArtifactIds?: readonly string[]) => syncPluginManagedCommandPackage({ plugin, packageKey: 'shared', scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, requestedArtifactIds });
    expect((await sync()).state).toBe('completed');
    const initial = (await listManagedCommands(isolated.env)).commands;
    const first = initial.find((command) => command.name.startsWith('first/'))!;
    const second = initial.find((command) => command.name.startsWith('second/'))!;
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2' } });
    expect((await sync(['command-set.first'])).state).toBe('completed');
    expect((await resolveManagedCommand(first.id, isolated.env)).launch.args).toEqual(['v2', 'command-set.first']);
    expect((await resolveManagedCommand(second.id, isolated.env)).launch.args).toEqual(['v1', 'command-set.second']);
    const recordPath = path.join((await listManagedCommandPackages(isolated.env)).packages[0]!.resourceRoot, '.aw-command-producer.json');
    const record = await fs.readFile(recordPath);
    await fs.writeFile(recordPath, '{}');
    expect(await sync(['command-set.first'])).toMatchObject({ state: 'failed', errors: [{ code: 'commandBindingInvalid' }] });
    expect(await fs.readFile(recordPath, 'utf8')).toBe('{}');
    await fs.writeFile(recordPath, record);
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2', empty: true } });
    expect(await sync(['command-set.first'])).toMatchObject({ state: 'completed', removedCommandIds: [first.id] });
    expect((await listManagedCommands(isolated.env)).commands.map((command) => command.id)).toEqual([second.id]);
    plugin.manifest.managedCommands!.sets = plugin.manifest.managedCommands!.sets.filter((set) => set.set === 'first');
    expect((await sync()).removedCommandIds).toEqual([second.id]);
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toEqual([['command-set.first', 'command-set.second'], ['command-set.first'], ['command-set.first'], ['command-set.first']]);
  });
});
