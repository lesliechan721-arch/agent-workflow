import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { cleanupWriteCommand } from '../../src/commands/write-commands.js';
import type { CatalogResolution, PlatformName, PluginMeta, RebuildCommand } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { listManagedCommands, listManagedCommandPackages, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { runManagedCommand } from '../../src/utils/managed-command-runtime.js';
import { syncPluginManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { SYSTEM_CODEX_MANAGER } from '../../src/utils/native-cli.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { buildRebuildReceiptJson, renderRebuildReceipt } from '../../src/output/command-receipt.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { createNativeTestExecution } from '../helpers/native-execution-fixture.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';

describe('managed command plugin lifecycle', () => {
  let isolated: IsolatedTestEnvironment;
  let pluginRoot: string;
  let capturePath: string;
  let codexRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  let claudeRuntime: Awaited<ReturnType<typeof createClaudeNativeTestRuntime>>;
  const sourceIdentity = `sha256:${'a'.repeat(64)}`;
  const baseManifest = {
    schemaVersion: 3, name: 'managed-lifecycle', version: '1.0.0', description: 'Lifecycle fixture.',
    platforms: ['codex', 'claude'],
    requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
  };
  const tool = 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n';
  const skillFiles = {
    'SKILL.md': '---\nname: provider\ndescription: Lifecycle fixture.\n---\n{{aw.command:tools/run}} check\n',
    'README.md': '# Provider\n', 'scripts/tool.mjs': tool,
    'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
  };

  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    pluginRoot = path.join(isolated.layout.fixtureCwd, 'plugin');
    capturePath = path.join(isolated.layout.fixtureCwd, 'capture.json');
    isolated.env.CAPTURE_FILE = capturePath;
    await fs.ensureDir(isolated.layout.awHomeDir);
    codexRuntime = await createCodexNativeTestRuntime(isolated);
    claudeRuntime = await createClaudeNativeTestRuntime(isolated);
  });
  afterEach(async () => { await isolated.cleanup(); });

  async function readFixture(): Promise<PluginMeta> {
    const sourceRoot = path.join(isolated.layout.fixtureCwd, 'catalog-source');
    const copiedRoot = path.join(sourceRoot, 'plugins', 'managed-lifecycle');
    await fs.remove(copiedRoot);
    await fs.copy(pluginRoot, copiedRoot);
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'marketplace-source.json'), {
      owner: { name: 'Fixture', url: 'https://example.invalid/fixture' },
      interface: { displayName: 'Fixture' }, catalog: { version: '1.0.0' },
    });
    const catalogRoot = path.join(isolated.layout.fixtureCwd, `catalog-${crypto.randomUUID()}`);
    await bundlePlugins({ repoRoot: sourceRoot, outputRoot: catalogRoot });
    return { ...await readPluginManifest(path.join(catalogRoot, 'plugins', 'managed-lifecycle'), { mode: 'bundle' }),
      sourceId: 'fixture', sourceIdentity, pluginId: 'fixture/managed-lifecycle' };
  }
  function integrationFor(env = isolated.env) {
    const context: RebuildExecutionContext = {
      ...createCommandExecutionContext({ env, nativeCliRunner: async (invocation) =>
        invocation.command.includes('claude')
          ? claudeRuntime.nativeCliRunner(invocation)
          : codexRuntime.nativeCliRunner(invocation) }),
      codexManager: SYSTEM_CODEX_MANAGER,
    };
    return { integration: createRebuildIntegration({ context }), context };
  }
  async function build(plugin: PluginMeta, command: RebuildCommand, platform: PlatformName, integration: ReturnType<typeof createRebuildIntegration>) {
    return integration.buildTarget({ plugin, command, platform, scope: 'user', cwd: isolated.layout.fixtureCwd,
      sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginId: plugin.pluginId,
      marketplaceRoot: path.join(isolated.layout.awHomeDir, 'marketplaces', 'fixture'), marketplaceName: 'aw-fixture',
      catalog: { rootDir: path.dirname(path.dirname(plugin.rootDir)), source: 'local' } as CatalogResolution });
  }
  async function execute(plugin: PluginMeta, command: RebuildCommand, env = isolated.env) {
    const { integration, context } = integrationFor(env);
    const target = await build(plugin, command, 'codex', integration);
    const result = await executeRebuildOperation({ command, target, driver: integration.driver });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    return { target, context };
  }
  async function cleanupFixture(runtime: RebuildCommandRuntime) {
    const native = await createNativeTestExecution({ scope: 'user', cwd: isolated.layout.fixtureCwd,
      env: isolated.env, selectedTargets: [{ pluginId: 'fixture/managed-lifecycle', platform: 'codex' }] });
    try {
      return await cleanupWriteCommand(['fixture/managed-lifecycle'], {
        cwd: isolated.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, { ...runtime, env: isolated.env, executionInput: native.executionInput });
    } finally {
      await native.dispose();
    }
  }

  // A refresh must reject a colliding identity before cleanup removes the old
  // binding or replaces the owned Skill. Only the identity hash is controlled.
  it('preserves the artifact command and Skill when refresh identities collide', async () => {
    const manifest = (key: string) => ({ ...baseManifest,
      artifacts: { targets: [{ id: 'provider', platform: 'codex', target: 'codex.skill', scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: 'provider' }] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', artifactId: 'provider' }, mode: 'static', entries: [{ key, runner: 'node', entry: 'scripts/tool.mjs' }] }] },
    });
    const files = { ...skillFiles, 'SKILL.md': '---\nname: provider\ndescription: Lifecycle fixture.\n---\nFixture.\n' };
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `console.log(JSON.stringify({version:2,artifacts:[{id:'provider',target:'codex.skill',kind:'skill',platform:'codex',state:'present',skillKey:'provider',refreshKeys:[],content:{files:${JSON.stringify(files)}}}]}));\n`);
    const createHash = crypto.createHash;
    const hashSpy = vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
      const hash = createHash(algorithm, options);
      const update = hash.update.bind(hash);
      const digest = hash.digest.bind(hash);
      let identity = false;
      hash.update = ((data: Parameters<typeof hash.update>[0], ...rest: unknown[]) => {
        if (typeof data === 'string' && data.includes('"schemaVersion":1') && data.includes('"producer":') && data.includes('"set":')) identity = true;
        Reflect.apply(update, hash, [data, ...rest]);
        return hash;
      }) as typeof hash.update;
      hash.digest = ((encoding?: crypto.BinaryToTextEncoding) => {
        const result = encoding ? digest(encoding) : digest();
        return identity && typeof result === 'string' ? '0123456789abcdef' + result.slice(16) : result;
      }) as typeof hash.digest;
      return hash;
    });
    syncBuiltinESMExports();
    try {
      const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
      await fs.outputJson(manifestPath, manifest('first'));
      await execute(await readFixture(), 'install');
      const command = (await listManagedCommands(isolated.env)).commands[0]!;
      const bindingPath = path.join(isolated.layout.awHomeDir, 'commands', 'bindings', `${command.id}.json`);
      const bindingBefore = await fs.readFile(bindingPath, 'utf8');
      const recordPath = path.join(command.resourceRoot!, '.aw-command-producer.json');
      const recordBefore = await fs.readFile(recordPath, 'utf8');
      const skillBefore = await fs.readFile(path.join(command.resourceRoot!, 'SKILL.md'), 'utf8');
      await fs.outputJson(manifestPath, manifest('second'));
      const { integration } = integrationFor();
      const target = await build(await readFixture(), 'sync', 'codex', integration);
      const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
      expect(result.status).toBe('failed');
      expect(result.failures).toContainEqual(expect.objectContaining({ message: expect.stringContaining('commandIdentityConflict') }));
      expect(await fs.readFile(bindingPath, 'utf8')).toBe(bindingBefore);
      expect(await fs.readFile(recordPath, 'utf8')).toBe(recordBefore);
      expect(await fs.readFile(path.join(command.resourceRoot!, 'SKILL.md'), 'utf8')).toBe(skillBefore);
    } finally {
      hashSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  // Protects publication after actual owned Skill writes, stable IDs across refresh, and cleanup revocation.
  it('installs, runs, refreshes, reinstalls, empties, and cleans an artifact command producer', async () => {
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { ...baseManifest,
      config: { schemaVersion: 4, fields: { revision: { type: 'string', default: 'v1' }, empty: { type: 'boolean', default: false } } },
      artifacts: { targets: [{ id: 'provider', platform: 'codex', target: 'codex.skill', scopes: ['user'], states: ['present'], refreshKeys: ['revision', 'empty'], skillKey: 'provider' }] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', artifactId: 'provider' }, mode: 'dynamic', refreshKeys: ['revision', 'empty'] }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      "const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `const files=${JSON.stringify(skillFiles)};`,
      "const empty=c.config.values.empty; if(empty)files['SKILL.md']='---\\nname: provider\\ndescription: Lifecycle fixture.\\n---\\nNo commands.\\n';",
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>id==='provider'?",
      "{id,target:'codex.skill',kind:'skill',platform:'codex',state:'present',skillKey:'provider',refreshKeys:['revision','empty'],content:{files}}:",
      "{id,target:'aw.command-set',kind:'commandSet',platform:'codex',state:'present',refreshKeys:['revision','empty'],entries:empty?[]:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values.revision],cwd:'resource'}]})}));",
    ].join('\n'));
    const plugin = await readFixture();
    expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    const installed = await execute(plugin, 'install');
    const command = (await listManagedCommands(isolated.env)).commands[0]!;
    expect(command).toMatchObject({ availability: 'ready', name: 'tools/run/default' });
    expect(installed.target.operationActions).toContainEqual(expect.objectContaining({
      kind: 'materializeNativeSkill', platform: 'codex', scope: 'user', skillKey: 'provider',
    }));
    const skillRoot = command.resourceRoot!;
    expect(await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).toContain(`aw command run ${command.id} -- check`);
    expect(await runManagedCommand({ id: command.id, args: ['user argument'], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
    expect(await fs.readJson(capturePath)).toEqual({ args: ['v1', 'user argument'], cwd: skillRoot });
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2' } });
    await execute(plugin, 'sync');
    expect((await listManagedCommands(isolated.env)).commands.map((entry) => entry.id)).toEqual([command.id]);
    expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['v2']);
    await execute(plugin, 'reinstall');
    expect((await listManagedCommands(isolated.env)).commands[0]?.id).toBe(command.id);
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2', empty: true } });
    await execute(plugin, 'sync');
    expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    await expect(resolveManagedCommand(command.id, isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
    await execute(plugin, 'cleanup');
    expect(await fs.pathExists(skillRoot)).toBe(true);
    await expect(resolveManagedCommand(command.id, isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
  });

  // Both activation scopes consume one Native shared-user Skill command producer.
  it('shares the Claude Native command producer across user and project activation', async () => {
    await git(isolated.layout.fixtureCwd, ['init']);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { ...baseManifest,
      platforms: ['claude'],
      artifacts: { targets: [{ id: 'provider', platform: 'claude', target: 'claude.skill', scopes: ['user', 'project'], states: ['present'], refreshKeys: [], skillKey: 'provider' }] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', artifactId: 'provider' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'scripts/tool.mjs' }] }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `console.log(JSON.stringify({version:2,artifacts:[{id:'provider',target:'claude.skill',kind:'skill',platform:'claude',state:'present',skillKey:'provider',refreshKeys:[],content:{files:${JSON.stringify(skillFiles)}}}]}));\n`);
    const plugin = await readFixture();
    const { integration } = integrationFor();
    const common = { plugin, platform: 'claude' as const, cwd: isolated.layout.fixtureCwd,
      marketplaceRoot: path.join(isolated.layout.awHomeDir, 'marketplaces', 'fixture'), marketplaceName: 'aw-fixture',
      catalog: { rootDir: path.dirname(path.dirname(plugin.rootDir)), source: 'local' } as CatalogResolution };
    for (const scope of ['user', 'project'] as const) {
      const target = await integration.buildTarget({ ...common, scope, command: 'install' });
      const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
      expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    }
    const commands = (await listManagedCommands(isolated.env)).commands;
    expect(commands).toHaveLength(1);
    const user = commands[0]!;
    expect(user.owner).toMatchObject({ kind: 'plugin', producer: { platform: 'claude', scope: 'user' } });
    const cleanup = await integration.buildTarget({ ...common, scope: 'project', command: 'cleanup' });
    const result = await executeRebuildOperation({ command: 'cleanup', target: cleanup, driver: integration.driver });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect((await listManagedCommands(isolated.env)).commands.map((command) => command.id)).toEqual([user.id]);
    expect(await runManagedCommand({ id: user.id, args: ['user-still-active'], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
  });

  // Protects executable modes and shared Native resources when offline cleanup removes only activation.
  it.skipIf(process.platform === 'win32')('keeps a shared Native sourceDir command runnable after reinstall and offline activation cleanup', async () => {
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { ...baseManifest,
      artifacts: { targets: [{ id: 'provider', platform: 'codex', target: 'codex.skill', scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: 'provider', sourceDirs: ['./skills/provider'] }] },
      managedCommands: { sets: [{ set: 'shell', producer: { kind: 'artifact', artifactId: 'provider' }, mode: 'static', entries: [{ key: 'run', runner: 'executable', entry: 'scripts/run.sh', args: ['preserved-mode'] }] }] },
    });
    for (const [relative, content] of Object.entries(skillFiles)) {
      await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', relative), content.replace('tools/run', 'shell/run'));
    }
    await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', 'scripts', 'run.sh'), '#!/bin/sh\nprintf "%s" "$1" > "$CAPTURE_FILE"\n');
    await fs.chmod(path.join(pluginRoot, 'skills', 'provider', 'scripts', 'run.sh'), 0o755);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), "console.log(JSON.stringify({version:2,artifacts:[{id:'provider',target:'codex.skill',kind:'skill',platform:'codex',state:'present',skillKey:'provider',refreshKeys:[],content:{files:{}}}]}));\n");
    const plugin = await readFixture();
    const bundleRoot = path.dirname(path.dirname(plugin.rootDir));
    for (const command of ['install', 'reinstall'] as const) {
      await execute(plugin, command);
      const installed = (await listManagedCommands(isolated.env)).commands[0]!;
      expect(installed.availability).toBe('ready');
      expect(await runManagedCommand({ id: installed.id, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
      expect(await fs.readFile(capturePath, 'utf8')).toBe('preserved-mode');
    }
    const installedId = (await listManagedCommands(isolated.env)).commands[0]!.id;
    await fs.remove(pluginRoot);
    await fs.remove(bundleRoot);
    const cleaned = await cleanupFixture({ catalogBootstrapError: new Error('Catalog is offline for this recovery test.'), codexManager: SYSTEM_CODEX_MANAGER,
      nativeCliRunner: codexRuntime.nativeCliRunner });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    const remaining = (await listManagedCommands(isolated.env)).commands;
    expect(cleaned.commandResults?.flatMap((result) => result.removedCommandIds)).toEqual([]);
    expect(remaining.map((command) => command.id)).toEqual([installedId]);
    expect(remaining[0]).toMatchObject({ availability: 'ready', owner: { kind: 'plugin', producer: {
      kind: 'artifact', platform: 'codex', scope: 'user', projectRoot: null,
      sourceId: 'fixture', sourceIdentity, pluginName: 'managed-lifecycle', key: 'provider',
    } } });
    const publicConfig = await readCodexConfigFile(path.join(isolated.env.CODEX_HOME!, 'config.toml'));
    expect(publicConfig.snapshot.plugins['managed-lifecycle@aw-fixture']?.enabled).toBe(false);
    expect(codexRuntime.installed.get('managed-lifecycle@aw-fixture')).toBe(plugin.manifest.version);
    const nativeSkillRoot = path.join(isolated.layout.awHomeDir, 'marketplaces', 'fixture',
      'plugins', 'managed-lifecycle', 'codex', 'skills', 'provider');
    await expect(fs.pathExists(path.join(nativeSkillRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.readJson(path.join(nativeSkillRoot, '.aw-command-producer.json'))).resolves.toMatchObject({
      producer: remaining[0]!.owner.kind === 'plugin' ? remaining[0]!.owner.producer : undefined,
    });
    expect(await runManagedCommand({ id: installedId, args: [], cwd: isolated.layout.fixtureCwd,
      cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
    expect(await fs.readFile(capturePath, 'utf8')).toBe('preserved-mode');
  });

  // Protects exact partial renderer requests and retention from verified producer content, including old launch values.
  it('refreshes only requested sets and prunes deleted declarations only during a complete producer refresh', async () => {
    const tracePath = path.join(isolated.layout.fixtureCwd, 'partial-requests.jsonl');
    await fs.outputFile(path.join(pluginRoot, 'tools', 'tool.mjs'), tool);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { ...baseManifest,
      config: { schemaVersion: 4, fields: { revision: { type: 'string', default: 'v1' }, empty: { type: 'boolean', default: false } } },
      managedCommands: { packages: [{ key: 'shared', scope: 'user', platforms: ['codex'], sourceDir: './tools' }],
        sets: ['first', 'second'].map((set) => ({ set, producer: { kind: 'package', packageKey: 'shared' }, mode: 'dynamic', refreshKeys: ['revision', 'empty'] })) },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify(c.requestedArtifactIds)+'\\n');`,
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',state:'present',refreshKeys:['revision','empty'],entries:c.config.values.empty?[]:[{key:'run',runner:'node',entry:'tool.mjs',args:[c.config.values.revision,id]}]}))}));",
    ].join('\n'));
    const plugin = await readFixture();
    const sync = (requestedArtifactIds?: readonly string[]) => syncPluginManagedCommandPackage({ plugin, packageKey: 'shared', scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, ...(requestedArtifactIds ? { requestedArtifactIds } : {}) });
    expect((await sync()).state).toBe('completed');
    const initial = (await listManagedCommands(isolated.env)).commands;
    const first = initial.find((command) => command.name.startsWith('first/'))!;
    const second = initial.find((command) => command.name.startsWith('second/'))!;
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2' } });
    await fs.writeFile(path.join(pluginRoot, 'tools', 'tool.mjs'), 'process.exit(99);\n');
    expect((await sync(['command-set.first'])).state).toBe('completed');
    for (const [command, revision] of [[first, 'v2'], [second, 'v1']] as const) {
      expect(await runManagedCommand({ id: command.id, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
      expect((await fs.readJson(capturePath)).args).toEqual([revision, `command-set.${command.name.split('/')[0]}`]);
    }
    const resourceRoot = (await listManagedCommandPackages(isolated.env)).packages[0]!.resourceRoot;
    const recordPath = path.join(resourceRoot, '.aw-command-producer.json');
    const record = await fs.readFile(recordPath);
    await fs.writeFile(recordPath, '{}');
    expect(await sync(['command-set.first'])).toMatchObject({ state: 'failed', errors: [{ code: 'commandBindingInvalid' }] });
    expect(await fs.readFile(recordPath, 'utf8')).toBe('{}');
    await fs.writeFile(recordPath, record);
    await writePluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env, values: { revision: 'v2', empty: true } });
    const emptied = await sync(['command-set.first']);
    expect(emptied).toMatchObject({ state: 'completed', removedCommandIds: [first.id] });
    expect((await listManagedCommands(isolated.env)).commands.map((command) => command.id)).toEqual([second.id]);
    expect((await resolveManagedCommand(second.id, isolated.env)).launch.args).toEqual(['v1', 'command-set.second']);
    plugin.manifest.managedCommands!.sets = plugin.manifest.managedCommands!.sets.filter((set) => set.set === 'first');
    expect((await sync()).removedCommandIds).toEqual([second.id]);
    expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    const requests = (await fs.readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(requests).toEqual([['command-set.first', 'command-set.second'], ['command-set.first'], ['command-set.first'], ['command-set.first']]);
  });

  // Protects shared package preparation/publication and retention after all platform consumers are cleaned.
  it('prepares one AW package for both platforms and retains its runnable resources after consumer cleanup', async () => {
    const tracePath = path.join(isolated.layout.fixtureCwd, 'renderer-contexts.jsonl');
    await fs.outputFile(path.join(pluginRoot, 'tools', 'tool.mjs'), tool);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { ...baseManifest,
      artifacts: { targets: ['codex', 'claude'].map((platform) => ({ id: `${platform}-consumer`, platform, target: `${platform}.skill`, scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: `${platform}-consumer` })) },
      managedCommands: { packages: [{ key: 'shared', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './tools', render: true }], sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'shared' }, mode: 'dynamic', refreshKeys: [] }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({surface:c.surface,platform:c.platform,distribution:c.distribution,commandSources:c.commandSources,platformEnv:process.env.AW_PLUGIN_PLATFORM})+'\\n');`,
      "const artifacts=c.requestedArtifactIds.map(id=>{if(id==='command-package.shared')return{id,target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:[],files:{'settings.json':'{\"mode\":\"configured\"}'}};",
      "if(id==='command-set.tools')return{id,target:'aw.command-set',kind:'commandSet',state:'present',refreshKeys:[],entries:[{key:'run',runner:'node',entry:'tool.mjs',args:['package']}]};",
      "const files={'SKILL.md':`---\\nname: ${id}\\ndescription: Consumer.\\n---\\n{{aw.command:tools/run}} check\\n`,'README.md':'# Consumer\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n'};return{id,target:`${c.platform}.skill`,kind:'skill',platform:c.platform,state:'present',skillKey:id,refreshKeys:[],content:{files}};});",
      "console.log(JSON.stringify({version:2,artifacts}));",
    ].join('\n'));
    const plugin = await readFixture();
    const { integration, context } = integrationFor();
    for (const platform of ['codex', 'claude'] as const) {
      const target = await build(plugin, 'install', platform, integration);
      if (platform === 'codex') {
        const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
        expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
      } else {
        const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
        expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
      }
    }
    const traces = (await fs.readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const packageTraces = traces.filter((entry) => (entry.surface as {kind:string}).kind === 'aw');
    expect(packageTraces).toEqual([{ surface: { kind: 'aw', name: 'managed-commands' }, commandSources: [{ packageKey: 'shared', sourceDir: path.join(plugin.rootDir, 'tools') }] }]);
    expect(context.commandResults?.filter((entry) => entry.producer.kind === 'package')).toHaveLength(1);
    const command = (await listManagedCommands(isolated.env)).commands[0]!;
    expect(command.owner).toMatchObject({ kind: 'plugin', producer: { platform: null, scope: 'user' } });
    const failed = integrationFor();
    const damaged = await build(plugin, 'sync', 'codex', failed.integration);
    const packageAction = damaged.operationActions!.find((action) => action.kind === 'syncManagedCommandPackage')!;
    if (packageAction.kind !== 'syncManagedCommandPackage') throw new Error('Missing package action.');
    packageAction.contentDigest = `sha256:${'0'.repeat(64)}`;
    await expect(failed.integration.driver.writeArtifacts(damaged)).rejects.toThrow('commandPackagePublishFailed');
    expect(failed.context.commandResults?.[0]).toMatchObject({ state: 'failed', errors: [{ code: 'commandResourceInvalid' }] });
    expect((await resolveManagedCommand(command.id, isolated.env)).launch.args).toEqual(['package']);
    for (const platform of ['codex', 'claude'] as const) {
      const target = await build(plugin, 'cleanup', platform, integration);
      expect(target.operationActions).toContainEqual(expect.objectContaining({ kind: 'retainManagedCommandPackage', commandIds: [command.id] }));
      expect((await executeRebuildOperation({ command: 'cleanup', target, driver: integration.driver })).status).toBe('succeeded');
    }
    expect((await listManagedCommandPackages(isolated.env)).packages).toHaveLength(1);
    const preview = await cleanupFixture({ previewOperationPlan: true, catalogBootstrapError: new Error('Catalog is offline.') });
    const retainedAction = preview.operationPlan?.actions.find((action) => action.kind === 'retainManagedCommandPackage');
    expect(retainedAction).toMatchObject({ commandIds: [command.id], producer: { sourceId: 'fixture', pluginName: 'managed-lifecycle', scope: 'user' } });
    if (retainedAction?.kind !== 'retainManagedCommandPackage') throw new Error('Missing retained package action.');
    const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'cleanup', pluginId: 'fixture/managed-lifecycle', platform: 'codex', scope: 'user' },
      evidence: { catalog: { configDigest: 'offline', compositeDigest: 'offline' }, operationPlan: preview.operationPlan } });
    expect(review.changes).toContainEqual(expect.objectContaining({ kind: 'keep', description: expect.stringContaining(retainedAction.recoveryAction) }));
    const cleaned = await cleanupFixture({ expectedPlanFingerprint: preview.operationPlan!.planFingerprint, catalogBootstrapError: new Error('Catalog is offline.') });
    const receipt = buildRebuildReceiptJson('cleanup', cleaned);
    expect(receipt.commandResults).toContainEqual(expect.objectContaining({ producer: retainedAction.producer, commandIds: [command.id], recoveryActions: [retainedAction.recoveryAction] }));
    const human = renderRebuildReceipt('cleanup', cleaned).join('\n');
    expect(human).toContain('保留命令包');
    expect(human).toContain('所有项目共用');
    expect(human).toContain(retainedAction.recoveryAction);
    expect(await runManagedCommand({ id: command.id, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
    expect((await fs.readJson(capturePath)).args).toEqual(['package']);
  });
});
