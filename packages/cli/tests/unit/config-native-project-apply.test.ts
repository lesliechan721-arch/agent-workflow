import path from 'node:path';
import { execFileSync } from 'node:child_process';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyPluginConfig, applyPluginConfigWrite } from '../../src/utils/plugin-config-write.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { executeRecovery, executeRecoveryPreApply, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';

const sessions: PlatformRebuildSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

async function nativeFixture(cwd: string, env: NodeJS.ProcessEnv, platform: 'codex' | 'claude') {
  const bin = path.join(cwd, 'native-bin');
  await fs.outputFile(path.join(bin, `${platform}${process.platform === 'win32' ? '.exe' : ''}`), '', { mode: 0o755 });
  env.PATH = [bin, path.dirname(process.execPath), ...(process.platform === 'win32'
    ? [path.join(env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const installedPath = platform === 'codex' ? path.join(env.CODEX_HOME!, 'config.toml')
    : path.join(env.CLAUDE_CONFIG_DIR!, 'plugins/installed_plugins.json');
  const marketplaces = new Map<string, string>();
  const packages = new Map<string, { version: string; root: string }>();
  const nativeCliRunner = vi.fn(async (call: NativeCliInvocation) => {
    if (call.args.includes('--version')) return { exitCode: 0, stdout: platform === 'codex' ? 'codex-cli 0.167.0' : '2.1.317 (Claude Code)', stderr: '' };
    const args = call.args;
    if (args[0] !== 'plugin') throw new Error('Unexpected fixture native command.');
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      marketplaces.set(marketplaceName, root);
      if (platform === 'claude') {
        const knownPath = path.join(env.CLAUDE_CONFIG_DIR!, 'plugins/known_marketplaces.json');
        await fs.outputJson(knownPath, { ...await fs.readJson(knownPath).catch(() => ({})),
          [marketplaceName]: { source: { source: 'directory', path: root }, installLocation: root } });
      } else {
        const current = await fs.readFile(installedPath, 'utf8').catch(() => '');
        if (!(await readCodexConfigFile(installedPath)).snapshot.marketplaces[marketplaceName]) await fs.outputFile(installedPath,
          `${current}\n[marketplaces.${JSON.stringify(marketplaceName)}]\nsource_type = "local"\nsource = ${JSON.stringify(root)}\n`);
      }
    } else if (args[1] !== 'list') {
      const id = args[2]!;
      const scope = args.includes('--scope') ? args[args.indexOf('--scope') + 1]! : 'user';
      if (['add', 'install', 'update'].includes(args[1]!)) {
        const root = path.join(marketplaces.get(id.slice(id.lastIndexOf('@') + 1))!, 'plugins', id.slice(0, id.lastIndexOf('@')));
        const manifest = await fs.readJson(path.join(root, `.${platform}-plugin/plugin.json`));
        packages.set(id, { version: manifest.version, root });
      }
      if (platform === 'codex') {
        if (args[1] === 'add') await applyCodexConfigTransactionFile(installedPath, { upsertPluginActivations: { [id]: true } });
        if (args[1] === 'remove') { packages.delete(id); await applyCodexConfigTransactionFile(installedPath, { removePluginActivations: [id] }); }
      } else {
        const settingsPath = scope === 'local' ? path.join(call.cwd, '.claude/settings.local.json') : path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json');
        const settings = await fs.readJson(settingsPath).catch(() => ({}));
        await fs.outputJson(settingsPath, { ...settings, enabledPlugins: { ...settings.enabledPlugins, [id]: !['disable', 'uninstall'].includes(args[1]!) } });
        if (['install', 'update', 'uninstall'].includes(args[1]!)) {
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} }));
          const records = (installed.plugins[id] ?? []).filter((record: { scope: string; projectPath?: string }) => record.scope !== scope || scope === 'local' && record.projectPath !== call.cwd);
          if (args[1] !== 'uninstall') records.push({ scope, ...(scope === 'local' ? { projectPath: call.cwd } : {}),
            version: packages.get(id)!.version, installPath: packages.get(id)!.root });
          const plugins = { ...installed.plugins };
          if (records.length) plugins[id] = records; else delete plugins[id];
          await fs.outputJson(installedPath, { version: 2, plugins });
        }
      }
    }
    if (platform === 'codex' && args[1] === 'list') {
      const user = await readCodexConfigFile(installedPath);
      const project = await readCodexConfigFile(path.join(cwd, '.codex/config.toml'));
      const exactProject = path.resolve(call.cwd) === path.resolve(cwd);
      return { exitCode: 0, stdout: JSON.stringify({ installed: [...packages].map(([pluginId, value]) => ({ pluginId,
        name: pluginId.slice(0, pluginId.lastIndexOf('@')), marketplaceName: pluginId.slice(pluginId.lastIndexOf('@') + 1),
        source: { source: 'local', path: value.root }, marketplaceSource: { sourceType: 'local',
          source: marketplaces.get(pluginId.slice(pluginId.lastIndexOf('@') + 1)) },
        version: value.version, installed: true, enabled: exactProject
          ? project.snapshot.plugins[pluginId]?.enabled ?? user.snapshot.plugins[pluginId]?.enabled === true
          : user.snapshot.plugins[pluginId]?.enabled === true })), available: [] }), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const runtime = () => {
    const context = { ...createCommandExecutionContext({ env, nativeCliRunner }), platformRebuildSession: undefined as PlatformRebuildSession | undefined };
    // Qualify only this synthetic Skill. Client discovery, projection, ownership and mutations remain real.
    context.platformRebuildSession = new PlatformRebuildSession(context, (target) => {
      const adapter = getAgentPluginAdapter(target);
      return { ...adapter, capabilities: (input) => adapter.capabilities({ ...input, profile: { ...input.profile,
        kinds: { ...input.profile.kinds, skill: { ...input.profile.kinds.skill, status: 'supported', reasonCodes: [] } } } }) };
    });
    sessions.push(context.platformRebuildSession);
    return context;
  };
  return { installedPath, nativeCliRunner, packages, runtime };
}

async function fixture(options: { preApply?: boolean; platform?: 'codex' | 'claude' } = {}) {
  const platform = options.platform ?? 'claude';
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  execFileSync('git', ['init', '-q'], { cwd });
  const sourceRoot = path.join(cwd, 'native-source');
  const pluginRoot = path.join(sourceRoot, 'plugins/demo');
  const trace = path.join(cwd, 'native-pre-apply.jsonl');
  const fail = path.join(cwd, 'fail-native-pre-apply');
  if (options.preApply) await fs.outputFile(path.join(pluginRoot, 'pre-apply.mjs'), [
    "import fs from 'node:fs';",
    'const c=JSON.parse(fs.readFileSync(0,"utf8"));',
    `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(c)+"\\n");`,
    `if(fs.existsSync(${JSON.stringify(fail)}))process.exit(23);`,
  ].join('\n'));
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
    "import fs from 'node:fs';",
    'const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
    'if(c.allowedOutputKinds.includes("skill")&&c.scope!=="user")throw new Error("Native Skills must use the shared user context");',
    'const files={"SKILL.md":"---\\nname: native-skill\\ndescription: Native config test\\n---\\n# "+c.config.values.mode+"\\n","README.md":"# Native config\\n"};',
    'console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes("skill")?[{id:"native-skill",kind:"skill",name:"native-skill",content:{files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,{text}]))}}]:[],omitted:[],unmet:[]}));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Native project apply fixture\n', (manifest) => {
    manifest.platforms = [platform];
    manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common-default' } },
      platforms: { [platform]: { fields: { mode: { type: 'string', default: `${platform}-default` } } } } };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } },
      ...(options.preApply ? { preApply: { path: './pre-apply.mjs' } } : {}) };
    manifest.artifacts = { configKeys: ['mode'], scopes: ['user', 'project'] };
  });
  const configured = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: configured.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const operation = await resolveCatalogOperationContext({ sourceIds: ['team'], env });
  const source = operation.catalog.sources[0]!.resolution!;
  const plugin = { ...await readPluginManifest(path.join(source.rootDir, 'plugins/demo'), { mode: 'bundle' }),
    sourceId: 'team', sourceIdentity: source.sourceIdentity, catalogLogicalIdentity: source.logicalIdentity, pluginId: 'team/demo' };
  const store = { pluginName: 'demo', sourceId: 'team', sourceIdentity: source.sourceIdentity,
    scope: 'user' as const, cwd, env };
  await writePluginConfigStore({ ...store, values: { mode: 'common-saved' } });
  await writePluginConfigStore({ ...store, platform, values: { mode: 'native-before' } });
  const native = await nativeFixture(cwd, env, platform);
  await setTargets({ cwd, env, scope: 'user' }, [platform]);
  const installed = await runRecovery('install', ['team/demo'],
    { cwd, env, cliVersion: '1.0.0', scope: 'project', context: 'project', yes: true }, native.runtime());
  expect(installed.ok, JSON.stringify(installed)).toBe(true);
  expect(installed.targetResults, JSON.stringify(installed)).toContainEqual(expect.objectContaining({ agent: platform, execution: 'applied' }));
  if (platform === 'claude') {
    const records = Object.values((await fs.readJson(native.installedPath)).plugins).flat() as Array<{ scope: string }>;
    expect(records.map((record) => record.scope)).toEqual(['local']);
  }
  const skill = path.join([...native.packages.values()][0]!.root, 'skills/native-skill/SKILL.md');
  expect(await fs.readFile(skill, 'utf8')).toContain('# native-before');
  return { cwd, env, plugin, store, native, skill, trace, fail };
}

// Test Value Gate: real recovery, native activation and rendered package outputs
// prove that the reading context never becomes a project value layer.
describe('Native project activation and user configuration', () => {
  // Test Value Gate: a hook used before provider cleanup must share the normal Native execution cache,
  // preserve its platform/scope inputs, and fail before any output mutation.
  it('runs the Native preApply gate before output changes and reuses the actual execution once', async () => {
    const f = await fixture({ preApply: true });
    await fs.writeFile(f.trace, '');
    const before = await fs.readFile(f.skill);
    // Request a real package change, so this gate cannot be satisfied by a no-op.
    await writePluginConfigStore({ ...f.store, platform: 'claude', values: { mode: 'native-next' } });
    const options = { cwd: f.cwd, env: f.env, context: 'project' as const, targets: ['claude'], cliVersion: '1.0.0' };
    const preparedRuntime = f.native.runtime();
    const plan = await prepareRecovery('sync', ['team/demo'], options, preparedRuntime);
    const result = await withAwHomeMutationLock({ env: f.env, action: async (token) => {
      const runtime = { ...preparedRuntime, awHomeMutationToken: token,
        preApplyConfirmed: true, preApplyExecutionCache: new Map<string, Promise<void>>() };
      const child = plan.joint!.children.find((entry) => entry.options.scope === 'project')!;
      expect(await executeRecoveryPreApply(child, 'team/demo', 'claude', runtime)).toBeUndefined();
      expect(await fs.readFile(f.skill)).toEqual(before);
      return executeRecovery(plan, { yes: true, runtime });
    } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const events = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({
      target: { platform: 'claude', scope: 'project', projectRoot: f.cwd },
      config: { values: { mode: 'native-next' } },
    })]);
    const published = await fs.readFile(f.skill);
    expect(published.toString('utf8')).toContain('# native-next');
    await fs.outputFile(f.fail, 'fail hook');
    await writePluginConfigStore({ ...f.store, platform: 'claude', values: { mode: 'native-failed' } });
    const failedRuntime = f.native.runtime();
    const failed = await prepareRecovery('sync', ['team/demo'], options, failedRuntime);
    try {
      const installed = await fs.readFile(f.native.installedPath);
      const child = failed.joint!.children.find((entry) => entry.options.scope === 'project')!;
      expect(await withAwHomeMutationLock({ env: f.env, action: (token) => executeRecoveryPreApply(child, 'team/demo', 'claude', {
        ...failedRuntime, awHomeMutationToken: token, preApplyConfirmed: true,
      }) })).toBe('preApplyFailed');
      expect(child.receipt.targetResults).toContainEqual(expect.objectContaining({ agent: 'claude', execution: 'failed',
        backend: expect.objectContaining({ targetResults: expect.arrayContaining([expect.objectContaining({ cleanupAttempted: false,
          failures: expect.arrayContaining([expect.objectContaining({ operationDiagnostic: expect.objectContaining({ code: 'preApplyExited', exitCode: 23 }) })]),
        })]) }) }));
      expect(await fs.readFile(f.native.installedPath)).toEqual(installed);
      expect(await fs.readFile(f.skill)).toEqual(published);
    } finally { await failed.context.dispose(); }
  }, 30_000);

  // Test Value Gate: a replacement's script must succeed before the old scope is cleaned up.
  // A failed switch retains the working Native activation; a fresh retry executes the script once.
  it.each(['codex', 'claude'] as const)('preserves the %s project provider on failed user-scope preApply, then switches once', async (platform) => {
    const f = await fixture({ preApply: true, platform });
    const projectFile = path.join(f.cwd, platform === 'codex' ? '.codex/config.toml' : '.claude/settings.local.json');
    const before = { project: await fs.readFile(projectFile), native: await fs.readFile(f.native.installedPath),
      skill: await fs.readFile(f.skill) };
    await fs.writeFile(f.trace, '');
    await fs.outputFile(f.fail, 'fail new provider');
    const options = { cwd: f.cwd, env: f.env, cliVersion: '1.0.0', context: 'project' as const, yes: true };
    const blocked = await runRecovery('install', ['team/demo'], { ...options, scope: 'user' }, f.native.runtime());
    expect(blocked.ok).toBe(false);
    expect(await fs.readFile(projectFile)).toEqual(before.project);
    expect(await fs.readFile(f.native.installedPath)).toEqual(before.native);
    expect(await fs.readFile(f.skill)).toEqual(before.skill);
    const failedEvents = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(failedEvents).toEqual([expect.objectContaining({ target: { platform, scope: 'user' } })]);
    expect(blocked.targetResults).toContainEqual(expect.objectContaining({ agent: platform, scope: 'user', execution: 'failed',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'preApplyFailed' })]),
      backend: expect.objectContaining({ targetResults: expect.arrayContaining([expect.objectContaining({
        target: expect.objectContaining({ platform, scope: 'user' }), cleanupAttempted: false,
        failures: expect.arrayContaining([expect.objectContaining({
          operationDiagnostic: expect.objectContaining({ code: 'preApplyExited', exitCode: 23 }),
        })]),
      })]) }),
    }));
    await fs.remove(f.fail);
    await fs.writeFile(f.trace, '');
    const retried = await runRecovery('sync', ['team/demo'], { ...options, targets: [platform] }, f.native.runtime());
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    const events = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({ target: { platform, scope: 'user' } })]);
    if (platform === 'codex') {
      const user = await readCodexConfigFile(f.native.installedPath);
      expect(Object.values(user.snapshot.plugins).some((plugin) => plugin.enabled)).toBe(true);
    } else {
      const records = Object.values((await fs.readJson(f.native.installedPath)).plugins).flat() as Array<{ scope: string }>;
      expect(records.map((record) => record.scope)).toContain('user');
    }
  }, 30_000);

  it.each(['user', 'project'] as const)('saves in %s context and refreshes only that context before an explicit project retry', async (context) => {
    const f = await fixture();
    const apply = { plugin: f.plugin, scope: 'user' as const, context, platform: 'claude' as const,
      cwd: f.cwd, env: f.env, cliVersion: '1.0.0', nativeCliRunner: f.native.nativeCliRunner,
      sharedNativeApplyConfirmed: true, preApplyConfirmed: true };
    const saved = await applyPluginConfigWrite({ ...apply, rebuildRuntime: f.native.runtime(), apply: true, request: { updates: { mode: 'native-next' } } });
    expect(saved.configWrite).toBe('succeeded');
    if (context === 'user') {
      expect(saved.apply, JSON.stringify(saved)).toMatchObject({ state: 'skipped', reason: 'noVisibleTarget' });
      expect(await fs.readFile(f.skill, 'utf8')).toContain('# native-before');
    } else {
      expect(saved.apply, JSON.stringify(saved)).toMatchObject({ state: 'succeeded',
        targetResults: [expect.objectContaining({ target: expect.objectContaining({ platform: 'claude', scope: 'project' }), state: 'completed' })] });
      expect(await fs.readFile(f.skill, 'utf8')).toContain('# native-next');
    }
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file, 'utf8');
    const stat = await fs.stat(file);
    const retried = await applyPluginConfig({ ...apply, rebuildRuntime: f.native.runtime(), context: 'project' });
    expect(retried, JSON.stringify(retried)).toMatchObject({ configWrite: 'notStarted', overallState: 'succeeded' });
    expect(await fs.readFile(f.skill, 'utf8')).toContain('# native-next');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await fs.stat(file)).mtimeMs).toBe(stat.mtimeMs);
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows/plugin-config'))).toBe(false);
    for (const root of [path.join(f.cwd, '.claude/skills'), path.join(f.cwd, '.agents/skills')]) {
      expect(await fs.pathExists(path.join(root, 'native-skill'))).toBe(false);
    }
    const records = Object.values((await fs.readJson(f.native.installedPath)).plugins).flat() as Array<{ scope: string }>;
    expect(records.map((record) => record.scope)).toEqual(['local']);
  }, 30_000);
});
