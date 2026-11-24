import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { describe, beforeEach, expect, it } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { render } from 'ink-testing-library';
import { syncWriteCommand as nativeSyncWriteCommand } from '../../src/commands/write-commands.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation, registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import type { PluginManifestSource } from '../../src/types.js';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';
import { type NativeCliInvocation, type NativeCliRunner } from '../../src/utils/native-cli.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';

import {
  syncWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
} from '../helpers/write-command-fixture.js';

const snapshotTool = [
  "import fs from 'node:fs';",
  "import { readCommandRuntimeConfig } from './.aw/command-runtime-config.mjs';",
  "const { values, installedIdentity, platform } = await readCommandRuntimeConfig({ from: import.meta.url, keys: ['mode'] });",
  "fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ mode: values.mode, version: installedIdentity.pluginVersion, platform, args: process.argv.slice(2) }));",
].join('\n');

function invokePublicCommand(nativeCliRunner: NativeCliRunner) {
  const { env } = getCurrentSourceTestIsolation();
  return async (cwd: string, args: string[]) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], { cwd, env, io: captured.io, interactive: false, nativeCliRunner });
    return { exitCode, payload: JSON.parse(captured.readStdout()), stderr: captured.readStderr() };
  };
}

async function configureCommandCatalog(root: string) {
  const { env } = getCurrentSourceTestIsolation();
  const source = { id: 'team', type: 'path', primary: true, path: root } as const;
  const before = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [source] }, expectedDigest: before.digest, env });
  return source;
}

async function readCommandSnapshot(cwd: string, selector: string, platform: 'codex' | 'claude', value: { mode: string; version: string }) {
  const { env } = getCurrentSourceTestIsolation();
  const capture = path.join(cwd, `command-${platform}.json`);
  await fs.remove(capture);
  const captured = createCapturedCliIo();
  const result = await runCli(['command', 'run', `${selector}/${platform}`, '--', 'check', 'payload'],
    { cwd, env: { ...env, CAPTURE_FILE: capture }, io: captured.io, interactive: false });
  expect({ exitCode: result, stderr: captured.readStderr() }).toEqual({ exitCode: 0, stderr: '' });
  expect(await fs.readJson(capture)).toEqual({ ...value, platform, args: ['payload'] });
}

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    installNativeTestQualification({ platforms: ['codex', 'claude'], discovery: true });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  // Test Value Gate: a shared source operation must execute only the selected plugin/platform pairs.
  it('groups exact Native targets without expanding the plugin and platform combinations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'exact-native-source');
    await createNativeDependencyCatalog(sourceRoot, ['first', 'second'].map((name) => ({
      name, configureManifest(manifest) { manifest.platforms = ['codex', 'claude']; },
    })));
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: before.digest, env: isolation.env,
    });
    const codex = await createCodexNativeTestRuntime(isolation);
    const claude = await createClaudeNativeTestRuntime(isolation);
    await writeIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      roots: [{ pluginId: 'team/first' }, { pluginId: 'team/second' }], targets: ['codex', 'claude'],
    });
    const receipt = await runRecovery('sync', ['team/first', 'team/second'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0',
      targets: ['codex', 'claude'], yes: true,
      exactTargets: [{ pluginId: 'team/first', agent: 'codex' },
        { pluginId: 'team/second', agent: 'claude' }],
    }, { nativeCliRunner: (invocation) => claude.isClaudeInvocation(invocation)
      ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation) });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
    expect(receipt.targetResults.map(({ pluginId, agent }) => [pluginId, agent])).toEqual([
      ['team/first', 'codex'], ['team/second', 'claude'],
    ]);
    expect([...codex.installed]).toEqual([expect.stringMatching(/^first@aw-/u)]);
    expect(Object.keys((await fs.readJson(claude.installedPath)).plugins)).toEqual([expect.stringMatching(/^second@aw-/u)]);
  });

  it('executes selected project Native demand without writing either intent file or other roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'execution-only-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'first' }, { name: 'second' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const requirements = {
      roots: ['first', 'second'].map((name) => ({ pluginId: `team/${name}`, platforms: ['codex' as const] })),
      dependencyScopeOverrides: [],
    };
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    await fs.outputJson(intentPath, {
      schemaVersion: 3, kind: 'aw-plugin-intents',
      sources: { team: { logicalIdentity: await readCatalogLogicalIdentity(sourceRoot) } },
      roots: requirements.roots.map(({ pluginId }) => ({ pluginId })),
    });
    const intentBytes = await fs.readFile(intentPath);
    const runtime = await createCodexNativeTestRuntime(isolation);
    const execute = (pluginId: string) => syncWriteCommand([pluginId], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const second = await execute('team/second');
    expect(second.overallState, JSON.stringify(second)).toBe('succeeded');
    const first = await execute('team/first');
    expect(first.overallState, JSON.stringify(first)).toBe('succeeded');
    const firstPackageRoot = [...runtime.packageRoots].find(([id]) => id.startsWith('first@'))![1];
    const firstTree = await snapshotRegularTree(firstPackageRoot);
    const nativeMutations = () => runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const args = invocation.args.slice(invocation.args.indexOf('plugin'));
      return ['add', 'remove'].includes(args[1] ?? '')
        || args[1] === 'marketplace' && ['add', 'remove'].includes(args[2] ?? '');
    }).length;
    const mutationCount = nativeMutations();
    const repeated = await execute('team/first');
    expect(repeated.overallState, JSON.stringify(repeated)).toBe('succeeded');
    expect(repeated.operationPlan?.deploymentPlans).toHaveLength(1);
    expect(repeated.operationPlan!.deploymentPlans!.flatMap((plan) => plan.effects)).toEqual([]);
    expect(nativeMutations()).toBe(mutationCount);
    expect(await snapshotRegularTree(firstPackageRoot)).toEqual(firstTree);
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    expect((await readFixtureRequirements({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).roots).toEqual([]);
    const projectConfig = await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'));
    const secondNativeId = [...runtime.installed].find((id) => id.startsWith('second@'))!;
    expect(projectConfig.snapshot.plugins[secondNativeId]?.enabled).toBe(true);
    const secondPackageRoot = runtime.packageRoots.get(secondNativeId)!;
    const secondTree = await snapshotRegularTree(secondPackageRoot);
    const firstNativeId = [...runtime.installed].find((id) => id.startsWith('first@'))!;
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    expect((await readCodexConfigFile(userConfigPath)).snapshot.plugins[firstNativeId]?.enabled).not.toBe(true);
    const publicMutationCount = nativeMutations();
    // Project installation restores the previous User activation, so this sync has no User work.
    const publicResult = await runRecovery('sync', ['team/first'], {
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, runtime);
    expect(publicResult, JSON.stringify(publicResult)).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', ok: true,
      requestedRoots: ['team/first'],
      requestedTargets: [
        expect.objectContaining({ pluginId: 'team/first', agent: 'codex', scope: 'project' }),
      ],
      outputsMayHaveChanged: false,
    });
    expect(publicResult.targetResults.map(({ pluginId, agent, scope, backend, execution }) => ({ pluginId, agent, scope, action: backend?.command, execution }))).toEqual([
      { pluginId: 'team/first', agent: 'codex', scope: 'project', action: 'sync', execution: 'no-op' },
    ]);
    expect(publicResult.targetResults.flatMap((target) => target.deploymentPlans?.flatMap((plan) => plan.effects) ?? [])).toEqual([]);
    expect(nativeMutations()).toBe(publicMutationCount);
    expect((await readCodexConfigFile(userConfigPath)).snapshot.plugins[firstNativeId]?.enabled).not.toBe(true);
    expect(await snapshotRegularTree(secondPackageRoot)).toEqual(secondTree);
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins[secondNativeId]?.enabled).toBe(true);
    const activationPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const activationBytes = await fs.readFile(activationPath);
    const context = await createScopeContext({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const noNativeSelection = await nativeSyncWriteCommand(['team/first'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, executionInput: {
      context, requirements, selectedTargets: [], preserveOtherObservedTargets: true,
    } });
    await context.dispose();
    expect(noNativeSelection.overallState).toBe('succeeded');
    expect(await fs.readFile(activationPath)).toEqual(activationBytes);
    const preferencesPath = await resolvePreferencesPath({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    for (const command of [uninstallWriteCommand, cleanupWriteCommand]) {
      if (command === cleanupWriteCommand) await fs.outputFile(preferencesPath, '{broken');
      const removed = await command(['team/first'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(removed.overallState, JSON.stringify(removed)).toBe('succeeded');
      expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    }
    const forced = await cleanupWriteCommand(['team/first'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime);
    expect(forced.overallState, JSON.stringify(forced)).toBe('succeeded');
    expect(await fs.readFile(preferencesPath, 'utf8')).toBe('{broken');
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    await fs.remove(preferencesPath);
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const userResult = await installFixturePlugin(['team/first'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(userResult.overallState, JSON.stringify(userResult)).toBe('succeeded');
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins[secondNativeId]?.enabled).toBe(true);
  });

  it('runs User Native renderer with only User config from two projects and a non-repo cwd', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-neutral-native-source');
    const renderEvents = path.join(isolation.layout.rootDir, 'user-neutral-native.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(renderEvents)}, JSON.stringify({ cwd: process.cwd(), scope: context.scope, mode: context.config.values.mode }) + "\\n");`,
      'console.log(JSON.stringify({ version: 3, components: context.allowedOutputKinds.includes("skill") ? [{',
      '  id: "native", kind: "skill", name: "user-neutral",',
      '  content: { files: { "SKILL.md": { text: `---\\nname: user-neutral\\ndescription: User config fixture.\\n---\\nmode=${context.config.values.mode}\\n` }, "README.md": { text: "native readme\\n" },',
      '    "agents/openai.yaml": { text: "policy:\\n  allow_implicit_invocation: true\\n" } } }',
      '}] : [], omitted: [], unmet: [] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'neutral\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common-default' } },
        platforms: { codex: { fields: { mode: { type: 'string', default: 'codex-default' } } } } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { scopes: ['user'], configKeys: ['mode'] };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [source] },
      expectedDigest: configured.digest, env: isolation.env });
    const callers = ['a', 'b', 'c'].map((name) => path.join(isolation.layout.rootDir, `neutral-${name}`));
    await Promise.all(callers.map((cwd) => fs.ensureDir(cwd)));
    for (const cwd of callers) registerCurrentTestWritableStateRoot(cwd, 'Native user invocation project fixture');
    await Promise.all(callers.slice(0, 2).map((cwd) => fs.ensureDir(path.join(cwd, '.git'))));
    for (const cwd of callers.slice(0, 2)) {
      await fs.outputFile(path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json'),
        '{invalid-project-config');
    }
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot), pluginName: 'demo',
      scope: 'user', cwd: callers[0]!, env: isolation.env, values: { mode: 'common-value' },
    });
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot), pluginName: 'demo',
      platform: 'codex', scope: 'user', cwd: callers[0]!, env: isolation.env, values: { mode: 'user-value' },
    });
    await writeIntentFixture({ scope: 'user', cwd: callers[0]!, env: isolation.env }, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    for (const cwd of callers) {
      const result = await runRecovery('reinstall', ['team/demo'], {
        scope: 'user', cwd, env: isolation.env, cliVersion: '1.0.0',
        targets: ['codex'], yes: true,
      }, runtime);
      expect(result, JSON.stringify(result)).toMatchObject({
        schemaVersion: 1, kind: 'aw-recovery', scope: 'user', ok: true,
        requestedTargets: [expect.objectContaining({ pluginId: 'team/demo', agent: 'codex' })],
      });
    }
    const events = (await fs.readFile(renderEvents, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { cwd: string; scope: string; mode: string });
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) {
      expect(event).toMatchObject({ scope: 'user', mode: 'user-value' });
      expect(callers).not.toContain(event.cwd);
    }
    for (const [invocation] of runtime.nativeCliRunner.mock.calls) {
      if (!invocation.cwd || !callers.includes(invocation.cwd)) continue;
      if (invocation.args.includes('--version')) continue;
      const pluginArgs = invocation.args.slice(invocation.args.indexOf('plugin'));
      expect(pluginArgs.slice(0, 2)).toEqual(['plugin', 'list']);
      expect(pluginArgs).toEqual(expect.arrayContaining(['--marketplace', '--json']));
    }
    const nativeId = [...runtime.installed].find((id) => id.startsWith('demo@'))!;
    expect(nativeId).toBeDefined();
    for (const cwd of callers.slice(0, 2)) {
      expect((await readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')))
        .snapshot.plugins[nativeId]).toBeUndefined();
      expect(await fs.readFile(path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json'), 'utf8'))
        .toBe('{invalid-project-config');
    }
  }, 30_000);

  // Installing a portable or excluded Native target must never prepare the command package.
  it.each(['generic', 'claude'] as const)('does not publish a Codex-only command when installing on %s', async (platform) => {
    const isolation = getCurrentSourceTestIsolation();
    const { fixtureCwd: cwd, awHomeDir } = isolation.layout;
    const sourceRoot = path.join(cwd, 'filtered-command-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'filtered-command');
    const selector = 'team/filtered-command';
    await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), 'throw new Error("The command platform was excluded.");\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/standalone/SKILL.md'),
      '---\nname: standalone\ndescription: Independent Skill.\n---\nNo command dependencies.\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/standalone/README.md'), '# Standalone\n');
    await createCatalogSnapshotFixture(sourceRoot, 'filtered-command', [], 'Filtered command fixture\n', (manifest) => {
      manifest.platforms = ['codex', platform];
      manifest.skills = './skills';
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.command = normalizePluginCommand({ sourceDir: './tools', platforms: ['codex'], mode: 'dynamic',
        refreshKeys: [] }, manifest);
    });
    await configureCommandCatalog(sourceRoot);
    const { nativeCliRunner } = await createClaudeNativeTestRuntime(isolation);
    const run = invokePublicCommand(nativeCliRunner);
    await writePreferences({ scope: 'user', cwd, env: isolation.env }, { ...createEmptyPreferences(), targets: [platform] });
    const installed = await run(cwd, ['plugin', 'install', selector, '--scope', 'user', '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    expect(installed.payload.data.commandResults ?? []).toEqual([]);
    expect(await fs.pathExists(path.join(awHomeDir, 'commands', 'packages'))).toBe(false);
  });

  // Sync keeps the other platform's installed Skill and already-applied snapshot across versions.
  it('publishes one command package across Codex and Claude and revokes it when the plugin drops its command', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const selector = 'team/dual-native';
    const sourceRoot = path.join(cwd, 'dual-native-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'dual-native');
    const skill = path.join(pluginRoot, 'skills', 'shared');
    const command: PluginManifestSource['command'] = { sourceDir: './tools', platforms: ['codex', 'claude'],
      mode: 'static', runtimeConfig: { keys: ['mode'] },
      routes: { subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }] } };
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), snapshotTool);
    await fs.outputFile(path.join(skill, 'README.md'), '# Shared Native Skill\n');
    await fs.outputFile(path.join(skill, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
    const writeVersion = async (version: string, withCommand = true) => {
      await fs.outputFile(path.join(skill, 'SKILL.md'), [
        '---', 'name: shared', 'description: Shared Native fixture.', '---',
        withCommand ? '{{aw.command}} check codex payload' : 'Independent Skill.', '',
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'dual-native', [], `Native version ${version}\n`, (manifest) => {
        manifest.version = version;
        manifest.platforms = ['codex', 'claude'];
        manifest.skills = './skills';
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common' } },
          platforms: { codex: { fields: { mode: { type: 'string', default: 'old-codex' } } },
            claude: { fields: { mode: { type: 'string', default: 'old-claude' } } } } };
        manifest.command = withCommand ? normalizePluginCommand(command, manifest) : undefined;
      });
    };
    await writeVersion('1.0.0');
    const source = await configureCommandCatalog(sourceRoot);
    const codex = await createCodexNativeTestRuntime(isolation, '0.167.0');
    const claude = await createClaudeNativeTestRuntime(isolation);
    const nativeCliRunner = (invocation: NativeCliInvocation) =>
      claude.isClaudeInvocation(invocation) ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation);
    const run = invokePublicCommand(nativeCliRunner);
    const preferences = { scope: 'user' as const, cwd, env: isolation.env };
    const show = async () => (await run(cwd, ['command', 'show', selector])).payload.data.commands[0];
    const expectPublication = (result: Awaited<ReturnType<typeof run>>, action: string, availability: string) => {
      expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, stderr: '', payload: { schemaVersion: 2,
        status: 'success', data: { commandResults: [{ selector, action, availability, state: 'completed', blockerCodes: [],
          subcommands: availability === 'removed' ? [] : ['check'], hasFallback: false,
          packageId: expect.stringMatching(/^pkg_[a-f0-9]{64}$/u) }] } } });
      const commandResult = result.payload.data.commandResults[0];
      for (const obsolete of ['commandIds', 'removedCommandIds', 'packageKey', 'scope']) {
        expect(commandResult).not.toHaveProperty(obsolete);
      }
    };

    await writePreferences(preferences, { ...createEmptyPreferences(), targets: ['codex'] });
    expectPublication(await run(cwd, ['plugin', 'install', selector, '--scope', 'user', '--yes']), 'created', 'ready');
    const first = await show();
    expect(first).toMatchObject({ selector, runtimeConfigPlatforms: ['codex'] });
    await fs.writeFile(path.join(first.resourceRoot, '.aw/runtime-config/codex.json'), '{broken');
    expect(await show()).toMatchObject({ availability: 'unavailable', requiresPlatformContext: null });
    const repair = await run(cwd, ['plugin', 'sync', selector, '--target', 'codex', '--context', 'user', '--yes']);
    expect(repair, JSON.stringify(repair)).toMatchObject({ exitCode: 0 });
    expect(await show()).toMatchObject({ availability: 'ready', requiresPlatformContext: true });
    await readCommandSnapshot(cwd, selector, 'codex', { mode: 'old-codex', version: '1.0.0' });

    await writePreferences(preferences, { ...createEmptyPreferences(), targets: ['codex', 'claude'] });
    expectPublication(await run(cwd, ['plugin', 'sync', selector, '--target', 'claude', '--context', 'user', '--yes']), 'updated', 'ready');
    const both = await show();
    expect(both.packageId).toBe(first.packageId);
    expect([...both.runtimeConfigPlatforms].sort()).toEqual(['claude', 'codex']);
    const installed = await run(cwd, ['command', 'list']);
    expect(installed.payload.data.packages).toEqual([expect.objectContaining({ packageId: first.packageId, selector })]);
    const codexOutput = [...codex.packageRoots.values()][0]!;
    const claudeOutput = [...claude.packageRoots.values()][0]!;
    for (const [platform, root] of [['codex', codexOutput], ['claude', claudeOutput]] as const) {
      expect(await fs.readFile(path.join(root, 'skills/shared/SKILL.md'), 'utf8')).toContain(`aw command run ${selector}/${platform} -- check`);
    }
    const untouchedClaude = await snapshotRegularTree(claudeOutput);
    for (const platform of ['codex', 'claude']) {
      expect(await run(cwd, ['plugin', 'config', 'set', selector, 'mode', '--platform', platform,
        '--context', 'user', '--value-json', JSON.stringify(`saved-${platform}`)])).toMatchObject({ exitCode: 0 });
    }

    await writeVersion('2.0.0');
    expect(await run(cwd, ['source', 'sync', source.id, '--yes'])).toMatchObject({ exitCode: 0 });
    await readCommandSnapshot(cwd, selector, 'codex', { mode: 'old-codex', version: '1.0.0' });
    expectPublication(await run(cwd, ['plugin', 'sync', selector, '--target', 'codex', '--context', 'user', '--yes']), 'updated', 'ready');
    expect(await snapshotRegularTree(claudeOutput)).toEqual(untouchedClaude);
    await readCommandSnapshot(cwd, selector, 'codex', { mode: 'saved-codex', version: '2.0.0' });
    await readCommandSnapshot(cwd, selector, 'claude', { mode: 'old-claude', version: '2.0.0' });
    const current = await show();
    expect(current.packageId).toBe(first.packageId);
    expect([...current.runtimeConfigPlatforms].sort()).toEqual(['claude', 'codex']);

    await writeVersion('3.0.0', false);
    expect(await run(cwd, ['source', 'sync', source.id, '--yes'])).toMatchObject({ exitCode: 0 });
    const revoked = await run(cwd, ['plugin', 'sync', selector, '--target', 'codex', '--context', 'user']);
    expect(revoked).toMatchObject({ exitCode: 3, payload: { status: 'blocked', data: {
      confirmation: { required: true, provided: false },
    } } });
    expect(JSON.stringify(revoked.payload.data.confirmation.effects)).toContain(selector);
    await readCommandSnapshot(cwd, selector, 'codex', { mode: 'saved-codex', version: '2.0.0' });
    expectPublication(await run(cwd, ['plugin', 'sync', selector, '--target', 'codex', '--context', 'user', '--yes']), 'removed', 'removed');
    expect(await fs.pathExists(path.dirname(path.dirname(current.resourceRoot)))).toBe(false);
    expect(await run(cwd, ['command', 'show', selector])).toMatchObject({ payload: {
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'commandNotFound' })]),
    } });
  }, 90_000);

  // Scoped output cleanup and the final uninstall leave the shared entry and its applied config usable offline.
  it('keeps a shared Claude command callable after the last Native deployment is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const selector = 'team/shared-claude';
    const sourceRoot = path.join(cwd, 'shared-claude-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'shared-claude');
    const skill = path.join(pluginRoot, 'skills', 'shared-native');
    const trace = path.join(cwd, 'shared-command-render.jsonl');
    await fs.outputFile(path.join(skill, 'SKILL.md'),
      '---\nname: shared-native\ndescription: Shared Claude fixture.\n---\n{{aw.command}} check payload\n');
    await fs.outputFile(path.join(skill, 'README.md'), '# Shared Claude\n');
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), snapshotTool);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ surface: context.surface, scope: context.scope, targetScope: context.config.targetScope, values: context.config.values }) + '\\n');`,
      "const launch = { name: 'check', runner: 'node', entry: 'tool.mjs' };",
      "const artifact = { id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['route'], routes: { subcommands: [launch] } };",
      "console.log(JSON.stringify({ version: 2, artifacts: [artifact] }));",
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'shared-claude', [], 'Shared Claude fixture\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.skills = './skills';
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'configured' },
        route: { type: 'string', default: 'common-route' } }, platforms: {
        claude: { fields: { route: { type: 'string', default: 'platform-route' } } },
      } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.command = normalizePluginCommand({ sourceDir: './tools', mode: 'dynamic', refreshKeys: ['route'],
        runtimeConfig: { keys: ['mode'] } }, manifest);
      manifest.extensions = { permissions: [{ name: 'native', allow: [{ argsPrefix: ['check'] }] }] };
    });
    await configureCommandCatalog(sourceRoot);
    const projects = [path.join(cwd, 'project-a'), path.join(cwd, 'project-b')];
    for (const project of projects) {
      await fs.ensureDir(project);
      await git(project, ['init']);
      await fs.outputFile(path.join(project, '.agent-workflows/plugin-config/team/shared-claude/config.json'),
        '{legacy project config');
    }
    const { runtime, nativeCliRunner, installedPath } = await createClaudeNativeTestRuntime(isolation);
    const run = invokePublicCommand(nativeCliRunner);
    await writePreferences({ scope: 'user', cwd, env: isolation.env }, { ...createEmptyPreferences(), targets: ['claude'] });

    const readPackage = async () => (await run(cwd, ['command', 'show', selector])).payload.data.commands[0];
    const checkRun = (cwd: string) => readCommandSnapshot(cwd, selector, 'claude', { mode: 'configured', version: '1.0.0' });
    const rule = `Bash(aw command run ${selector}/claude -- check *)`;
    let packageId: string | undefined;
    for (const [scope, project] of [['user', cwd], ['project', projects[0]!], ['project', projects[1]!]] as const) {
      const installed = await run(project, ['plugin', 'install', selector, '--scope', scope, '--yes']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
      const published = await readPackage();
      packageId ??= published.packageId;
      expect(published).toMatchObject({ selector, packageId, availability: 'ready', runtimeConfigPlatforms: ['claude'] });
      await checkRun(project);
    }
    const registry = await fs.readJson(installedPath);
    const nativeId = Object.keys(registry.plugins)[0]!;
    const records = Object.values(registry.plugins).flat() as Array<{ installPath: string }>;
    expect(records).toHaveLength(3);
    expect(new Set(records.map(({ installPath }) => installPath)).size).toBe(1);
    expect(await fs.readFile(path.join(records[0]!.installPath, 'skills/shared-native/SKILL.md'), 'utf8'))
      .toContain(`aw command run ${selector}/claude -- check payload`);
    const renders = (await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(renders.length).toBeGreaterThan(0);
    const sharedInput = {
      surface: { kind: 'aw', name: 'managed-commands' }, scope: 'user', targetScope: 'user', values: { route: 'common-route' },
    };
    expect(renders).toEqual(renders.map(() => sharedInput));
    const applied = await readPackage();
    expect(await run(cwd, ['plugin', 'config', 'set', selector, 'mode', '--platform', 'claude',
      '--context', 'user', '--value-json', '"saved-unapplied"'])).toMatchObject({ exitCode: 0 });
    const userSettings = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    const projectSettings = projects.map((project) => path.join(project, '.claude', 'settings.local.json'));
    const readSettings = (settings: string) => fs.readJson(settings).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    });
    const allowed = async (settings: string): Promise<string[]> => (await readSettings(settings)).permissions?.allow ?? [];
    for (const settings of [...projectSettings, userSettings]) expect(await allowed(settings)).toContain(rule);

    const offline = await cleanupWriteCommand([selector], { cwd: projects[0]!, platform: 'claude', scope: 'project', yes: true },
      { ...runtime, catalogBootstrapError: new Error('Fixture Catalog offline.') });
    expect(offline.overallState, JSON.stringify(offline.rebuildResults)).toBe('succeeded');
    expect(await allowed(projectSettings[0]!)).not.toContain(rule);
    expect(await allowed(projectSettings[1]!)).toContain(rule);
    expect(await allowed(userSettings)).toContain(rule);
    for (const [scope, project] of [['project', projects[1]!], ['project', projects[0]!], ['user', cwd]] as const) {
      const removed = await run(project, ['plugin', 'remove', selector, '--scope', scope, '--yes']);
      expect(removed, JSON.stringify(removed)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success' } });
      if (project !== projects[0]) {
        expect(removed.payload).toMatchObject({
          data: { commandResults: [{ packageId, selector, action: 'unchanged', availability: 'ready',
            subcommands: ['check'], hasFallback: false, state: 'completed', blockerCodes: [] }] },
        });
        const removal = removed.payload.nextActions.find((action: { argv?: string[] }) =>
          action.argv?.slice(0, 4).join(' ') === 'aw command package remove');
        expect(removal).toMatchObject({ kind: 'command', requiresConfirmation: true });
        expect(removal.argv).toHaveLength(5);
        expect([selector, packageId]).toContain(removal.argv[4]);
      }
    }
    for (const settings of [...projectSettings, userSettings]) {
      expect(await allowed(settings)).not.toContain(rule);
      expect((await readSettings(settings)).enabledPlugins?.[nativeId]).toBe(false);
    }
    await fs.remove(sourceRoot);
    expect(await readPackage()).toMatchObject({ packageId, runtimeConfigPlatforms: ['claude'], availability: 'ready',
      resourceRoot: applied.resourceRoot });
    await checkRun(projects[1]!);
    const legacy = createCapturedCliIo();
    const legacyExit = await runCli(['command', 'run', `cmdp_${'1'.repeat(16)}`, '--', 'check'],
      { cwd, env: isolation.env, io: legacy.io, interactive: false });
    expect(legacyExit).toBe(2);
    expect(legacy.readStderr()).toContain('invalidArguments');
  }, 90_000);

  it('separates mixed native Skill and AW role renderer requests', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-native-render-source');
    const rendererMarker = path.join(isolation.layout.fixtureCwd, 'mixed-native-renderer.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'mixed-native', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(rendererMarker)}, JSON.stringify({ kinds: context.allowedOutputKinds, scope: context.scope }) + "\\n");`,
      'const components = [];',
      'if (context.allowedOutputKinds.includes("skill")) components.push({',
      '  id: "native-skill", kind: "skill", name: "native-skill", content: { files: {',
      '    "SKILL.md": { text: "---\\nname: native-skill\\ndescription: Mixed native fixture.\\n---\\nnative mixed" },',
      '    "README.md": { text: "native mixed readme" },',
      '    "agents/openai.yaml": { text: "policy:\\n  allow_implicit_invocation: true\\n" }',
      '  } }',
      '});',
      'if (context.allowedOutputKinds.includes("agent")) components.push({',
      '  id: "aw-role", kind: "agent", name: "helper",',
      '  content: { description: "Helper role.", prompt: "Help." }',
      '});',
      'console.log(JSON.stringify({ version: 3, components, omitted: [], unmet: [] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'mixed-native', [], 'mixed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [] };
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/mixed-native'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(installed, JSON.stringify(installed, null, 2)).toMatchObject({ overallState: 'succeeded' });

    const events = (await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { kinds: string[]; scope: string });
    expect(events).toContainEqual({ kinds: ['agent'], scope: 'project' });
    expect(events).toContainEqual({ kinds: ['skill'], scope: 'user' });
    expect(events).toContainEqual({ kinds: ['mcp', 'hook', 'instruction'], scope: 'user' });
    expect(events.every((event) => !(event.kinds.includes('skill') && event.kinds.includes('agent')))).toBe(true);
    const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/mixed-native',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'project' });
    await expect(fs.readFile(path.join(
      layout.supplementRoot!,
      `${layout.physicalIdentity.resourceKey}-helper.toml`,
    ), 'utf8')).resolves.toContain('developer_instructions = "Help."');
    const packageRoot = [...runtime.packageRoots.values()][0]!;
    await expect(fs.readFile(path.join(
      packageRoot,
      'skills',
      'native-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toContain('native mixed');

  });
});
