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
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import { listManagedCommands, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { calculateCodexNativeRenderPayloadDigest } from '../../src/utils/catalog-digests.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { CODEX_NATIVE_RENDER_RECEIPT_PATH } from '../../src/utils/codex-native-render-receipt.js';

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

describe('five namespaced write commands', () => {
  beforeEach(async () => {
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
    }, { nativeCliRunner: (invocation) => invocation.command === 'claude'
      ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation) });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
    expect(receipt.targetResults.map(({ pluginId, agent }) => [pluginId, agent])).toEqual([
      ['team/first', 'codex'], ['team/second', 'claude'],
    ]);
    expect([...codex.installed]).toEqual(['first@aw']);
    expect(Object.keys((await fs.readJson(claude.installedPath)).plugins)).toEqual(['second@aw']);
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
    const repeated = await execute('team/first');
    expect(repeated.overallState, JSON.stringify(repeated)).toBe('succeeded');
    expect(repeated.targetResults[0]?.action).toBe('keep');
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    expect((await readFixtureRequirements({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).roots).toEqual([]);
    const projectConfig = await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'));
    expect(projectConfig.snapshot.plugins['second@aw']?.enabled).toBe(true);
    const publicResult = await runRecovery('sync', ['team/first'], {
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, runtime);
    expect(publicResult, JSON.stringify(publicResult)).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', ok: true,
      requestedRoots: ['team/first'],
      requestedTargets: [expect.objectContaining({ pluginId: 'team/first', agent: 'codex' })],
    });
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins['second@aw']?.enabled).toBe(true);
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
      .snapshot.plugins['second@aw']?.enabled).toBe(true);
  });

  it('runs User Native renderer with only User config from two projects and a non-repo cwd', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-neutral-native-source');
    const renderEvents = path.join(isolation.layout.rootDir, 'user-neutral-native.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(renderEvents)}, JSON.stringify({ cwd: process.cwd(), scope: context.scope, mode: context.config.values.mode }) + "\\n");`,
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "native", kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: "present", skillKey: "user-neutral", refreshKeys: ["mode"],',
      '  content: { files: { "SKILL.md": `mode=${context.config.values.mode}\\n`, "README.md": "native readme\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n" } }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'neutral\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common-default' } },
        platforms: { codex: { fields: { mode: { type: 'string', default: 'codex-default' } } } } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { targets: [{
        id: 'native', platform: 'codex', scopes: ['user'], target: 'codex.skill',
        states: ['present'], refreshKeys: ['mode'], skillKey: 'user-neutral',
      }] };
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
    expect(runtime.installed.has('demo@aw')).toBe(true);
    for (const cwd of callers.slice(0, 2)) {
      expect((await readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')))
        .snapshot.plugins['demo@aw']).toBeUndefined();
      expect(await fs.readFile(path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json'), 'utf8'))
        .toBe('{invalid-project-config');
    }
  }, 30_000);

  // Test Value Gate: cross-platform writes must preserve the other platform's installed bytes and unapplied configuration.
  it.each([
    ['static', ['codex', 'claude']],
    ['static', ['claude', 'codex']],
    ['dynamic', ['both']],
  ] as const)('preserves both native command platforms for %s Codex with install order %j', async (codexMode, order) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const authoringRoot = path.join(cwd, 'dual-native-authoring');
    const pluginRoot = path.join(authoringRoot, 'plugins', 'dual-native');
    const trace = path.join(cwd, 'dual-native-render-requests.jsonl');
    const tool = 'import fs from "node:fs";fs.writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(process.argv.slice(2)));\n';
    await fs.copy(path.join(repositoryRoot, 'plugins', 'marketplace-source.json'), path.join(authoringRoot, 'plugins', 'marketplace-source.json'));
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'dual-native', version: '1.0.0', description: 'Dual native fixture.', skills: './skills',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: { schemaVersion: 5, fields: { codexValue: { type: 'string', default: 'old-codex' }, claudeValue: { type: 'string', default: 'old-claude' } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      ...(codexMode === 'dynamic' ? { artifacts: { targets: [{ id: 'codex-rendered', platform: 'codex', target: 'codex.skill', scopes: ['user', 'project'], states: ['present'], refreshKeys: ['codexValue'], skillKey: 'codex-rendered' }] } } : {}),
      managedCommands: { sets: [
        { set: 'codex-tools', producer: codexMode === 'dynamic' ? { kind: 'artifact', artifactId: 'codex-rendered' } : { kind: 'static-skill', platform: 'codex', skillKey: 'shared' }, mode: 'dynamic', refreshKeys: ['codexValue'] },
        { set: 'claude-tools', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'shared' }, mode: 'dynamic', refreshKeys: ['claudeValue'] },
      ] },
      buildConfig: { skillRuntimeFiles: (['codex', 'claude'] as const).map((platform) => ({ skill: 'shared', source: `./${platform}-command.md`, target: `references/${platform}-command.md`, platforms: [platform] })) },
    });
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/SKILL.md'), '---\nname: shared\ndescription: Shared native fixture.\n---\nUse the platform command reference.\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/README.md'), '# Shared native\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/scripts/tool.mjs'), tool);
    for (const platform of ['codex', 'claude']) await fs.outputFile(path.join(pluginRoot, `${platform}-command.md`), `{{aw.command:${platform}-tools/run}} check\n`);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({platform:c.platform,ids:c.requestedArtifactIds})+'\\n');`,
      `const tool=${JSON.stringify(tool)};`,
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>id==='codex-rendered'?{id,target:'codex.skill',kind:'skill',platform:'codex',state:'present',skillKey:'codex-rendered',refreshKeys:['codexValue'],content:{files:{'SKILL.md':'---\\nname: codex-rendered\\ndescription: Rendered native.\\n---\\n{{aw.command:codex-tools/run}} check\\n','README.md':'# Native\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n','scripts/tool.mjs':tool}}}:{id,target:'aw.command-set',kind:'commandSet',platform:c.platform,state:'present',refreshKeys:[c.platform+'Value'],entries:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values[c.platform+'Value']]}]})}));",
    ].join('\n'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), { schemaVersion: 1, kind: 'catalog', workspaceIdentity: `fixture:${sourceRoot}`, sourceIdentity: `sha256:${'c'.repeat(64)}` });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: before.digest, env: isolation.env });
    const codex = await createCodexNativeTestRuntime(isolation, '0.151.0');
    const claude = await createClaudeNativeTestRuntime(isolation);
    const nativeCliRunner = async (invocation: NativeCliInvocation) => invocation.command === 'claude' ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation);
    const run = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], { cwd, env: isolation.env, io: captured.io, interactive: false, nativeCliRunner });
      return { exitCode, payload: JSON.parse(captured.readStdout()), stderr: captured.readStderr() };
    };
    const ids = new Map<string, string>();
    const assertCommands = async (expected: Record<string, string>) => {
      const commands = (await listManagedCommands(isolation.env)).commands;
      expect(commands).toHaveLength(Object.keys(expected).length);
      for (const [platform, value] of Object.entries(expected)) {
        const command = commands.find((entry) => entry.owner.kind === 'plugin' && entry.owner.producer.platform === platform)!;
        expect(command).toMatchObject({ availability: 'ready' });
        if (ids.has(platform)) expect(command.id).toBe(ids.get(platform));
        ids.set(platform, command.id);
        const record = await fs.readJson(path.join(command.resourceRoot!, '.aw-command-producer.json'));
        expect(record.producer).toMatchObject({ platform, sourceId: 'team', scope: 'user', projectRoot: null });
        expect((await resolveManagedCommand(command.id, isolation.env)).launch.args).toEqual([value]);
        const markdown = platform === 'codex' && codexMode === 'dynamic' ? 'SKILL.md' : `references/${platform}-command.md`;
        expect(await fs.readFile(path.join(command.resourceRoot!, markdown), 'utf8')).toContain(`aw command run ${command.id} -- check`);
        const capture = path.join(cwd, `${platform}-run.json`);
        expect(await runCli(['command', 'run', command.id, '--', 'check'], { cwd, env: { ...isolation.env, CAPTURE_FILE: capture }, io: createCapturedCliIo().io, interactive: false, nativeCliRunner })).toBe(0);
        expect(await fs.readJson(capture)).toEqual([value, 'check']);
      }
    };
    const expected: Record<string, string> = {};
    for (const platform of order) {
      await writePreferences({ scope: 'user', cwd, env: isolation.env }, {
        ...createEmptyPreferences(),
        targets: [...new Set([...Object.keys(expected), ...(platform === 'both' ? ['codex', 'claude'] : [platform])])] as Array<'codex' | 'claude'>,
      });
      const installed = await run(['plugin', 'install', 'team/dual-native', '--scope', 'user']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      for (const current of platform === 'both' ? ['codex', 'claude'] : [platform]) expected[current] = `old-${current}`;
      await assertCommands(expected);
    }
    for (const platform of ['codex', 'claude']) expect(await run(['plugin', 'config', 'set', 'team/dual-native', `${platform}Value`, '--context', 'user', '--platform', platform, '--value-json', JSON.stringify(`saved-${platform}`)])).toMatchObject({ exitCode: 0 });
    const selected = order[0] === 'both' ? ['claude', 'codex'] : [order.at(-1)!];
    for (const platform of selected) {
      const oldTrace = (await fs.readFile(trace, 'utf8')).trim().split('\n').length;
      const other = platform === 'codex' ? 'claude' : 'codex';
      const otherCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.owner.kind === 'plugin' && command.owner.producer.platform === other)!;
      const oldTree = await snapshotRegularTree(otherCommand.resourceRoot!);
      const receiptPath = path.join(isolation.env.AW_HOME!, 'marketplaces/team/plugins/dual-native', CODEX_NATIVE_RENDER_RECEIPT_PATH);
      const previousReceipt = codexMode === 'dynamic' && other === 'codex' ? await fs.readJson(receiptPath) : undefined;
      const synced = await run(['plugin', 'sync', 'team/dual-native', ...(platform === 'both' ? ['--target', 'codex', '--target', 'claude'] : ['--target', platform === 'claude' ? 'claude' : platform]), '--context', 'user', '--yes']);
      expect(synced, JSON.stringify(synced)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      const requests = (await fs.readFile(trace, 'utf8')).trim().split('\n').slice(oldTrace).map((line) => JSON.parse(line));
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.platform === platform)).toBe(true);
      expect(await snapshotRegularTree(otherCommand.resourceRoot!)).toEqual(oldTree);
      if (previousReceipt) {
        const afterReceipt = await fs.readJson(receiptPath);
        expect({ ...afterReceipt, payloadDigest: previousReceipt.payloadDigest }).toEqual(previousReceipt);
        expect(afterReceipt.payloadDigest).toBe(await calculateCodexNativeRenderPayloadDigest(path.dirname(path.dirname(receiptPath))));
      }
      expect(synced.payload.commandResults?.flatMap((result: { removedCommandIds: string[] }) => result.removedCommandIds) ?? []).not.toContain(ids.get(other));
      expected[platform] = `saved-${platform}`;
      await assertCommands(expected);
      if (platform === 'codex') {
        const mutations = () => codex.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args[0] === 'plugin' && ['add', 'remove'].includes(invocation.args[1] ?? '')).length;
        const beforeNoop = mutations();
        expect(await run(['plugin', 'sync', 'team/dual-native', '--target', 'codex', '--context', 'user', '--yes'])).toMatchObject({ exitCode: 0 });
        expect(mutations()).toBe(beforeNoop);
      }
    }
    if (codexMode === 'dynamic') {
      const codexCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.owner.kind === 'plugin' && command.owner.producer.platform === 'codex')!;
      const recordPath = path.join(codexCommand.resourceRoot!, '.aw-command-producer.json');
      await fs.writeFile(recordPath, '{damaged');
      const other = (await listManagedCommands(isolation.env)).commands.find((command) => command.owner.kind === 'plugin' && command.owner.producer.platform === 'claude')!;
      const otherTree = await snapshotRegularTree(other.resourceRoot!);
      const blocked = await run(['plugin', 'sync', 'team/dual-native', '--target', 'claude', '--context', 'user', '--yes']);
      expect(blocked.exitCode).toBe(1);
      expect(await snapshotRegularTree(other.resourceRoot!)).toEqual(otherTree);
      const repaired = await run(['plugin', 'sync', '--rebuild', 'team/dual-native', '--target', 'codex', '--target', 'claude', '--context', 'user', '--yes']);
      expect(repaired, JSON.stringify(repaired)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      await assertCommands({ codex: 'saved-codex', claude: 'saved-claude' });
    }
  }, 90000);

  // Protects the shared native payload across real scoped installation, config input, recovery, and offline cleanup.
  it('shares one Claude static command across user and two projects without scope cleanup revoking it', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['claude'] });
    const isolation = getCurrentSourceTestIsolation();
    const authoringRoot = path.join(isolation.layout.fixtureCwd, 'claude-shared-authoring');
    const pluginRoot = path.join(authoringRoot, 'plugins', 'shared-claude');
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    await fs.copy(path.join(repositoryRoot, 'plugins', 'marketplace-source.json'), path.join(authoringRoot, 'plugins', 'marketplace-source.json'));
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'shared-claude', version: '1.0.0', description: 'Shared Claude command fixture.', skills: './skills',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      platforms: ['claude'],
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: { schemaVersion: 5, fields: { revision: { type: 'string', default: 'default' } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: { sets: [{ set: 'native', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'shared-native' }, mode: 'dynamic', refreshKeys: ['revision'] }] },
      extensions: { permissions: [{ name: 'native', allow: [{ command: { set: 'native', key: 'run' }, argsPrefix: ['check'] }] }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'skills', 'shared-native', 'SKILL.md'), '---\nname: shared-native\ndescription: Shared Claude native fixture.\n---\n{{aw.command:native/run}} check\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'shared-native', 'README.md'), '# Shared native\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'shared-native', 'scripts', 'tool.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(process.argv.slice(2)));\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      "if(c.scope!=='user')throw new Error('Static command renderer must use user input.');",
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',platform:'claude',state:'present',refreshKeys:['revision'],entries:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values.revision]}]}))}));",
    ].join('\n'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), {
      schemaVersion: 1, kind: 'catalog',
      workspaceIdentity: `fixture:${crypto.createHash('sha256').update(sourceRoot).digest('hex')}`,
      sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${sourceRoot}`).digest('hex')}`,
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [source] }, expectedDigest: before.digest, env: isolation.env });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const projects = [path.join(isolation.layout.fixtureCwd, 'project-a'), path.join(isolation.layout.fixtureCwd, 'project-b')];
    for (const cwd of projects) { await fs.ensureDir(cwd); await git(cwd, ['init']); }
    const { runtime, nativeCliRunner, installedPath } = await createClaudeNativeTestRuntime(isolation);
    const config = { sourceId: 'team', sourceIdentity, logicalIdentity, pluginName: 'shared-claude', env: isolation.env };
    await writePluginConfigStore({ ...config, scope: 'user', cwd: projects[0]!, values: { revision: 'user-value' } });
    for (const cwd of projects) await fs.outputFile(path.join(cwd,
      '.agent-workflows/plugin-config/team/shared-claude/config.json'), '{legacy project config');
    const runPublic = async (cwd: string, args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], { cwd, env: isolation.env, io: captured.io, interactive: false, nativeCliRunner });
      return { exitCode, payload: JSON.parse(captured.readStdout()), stderr: captured.readStderr() };
    };
    let commandId: string | undefined, resourceRoot: string | undefined;
    for (const [scope, cwd] of [['user', projects[0]!], ['project', projects[0]!], ['project', projects[1]!]] as const) {
      const installed = await runPublic(cwd, ['plugin', 'install', 'team/shared-claude', '--scope', scope]);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      const commands = (await listManagedCommands(isolation.env)).commands;
      expect(commands).toHaveLength(1);
      commandId ??= commands[0]!.id;
      resourceRoot ??= commands[0]!.resourceRoot!;
      expect(commands[0]).toMatchObject({ id: commandId, resourceRoot, availability: 'ready', owner: { kind: 'plugin', producer: { scope: 'user', projectRoot: null, platform: 'claude', kind: 'static-skill' } } });
      expect((await resolveManagedCommand(commandId, isolation.env)).launch.args).toEqual(['user-value']);
    }
    const registry = await fs.readJson(installedPath);
    const nativeRecords = Object.values(registry.plugins).flat() as Array<{ installPath: string }>;
    expect(nativeRecords).toHaveLength(3);
    expect(new Set(nativeRecords.map((record) => record.installPath)).size).toBe(1);
    expect(await fs.readFile(path.join(resourceRoot!, 'SKILL.md'), 'utf8')).toContain(`aw command run ${commandId} -- check`);
    expect((await fs.readJson(path.join(resourceRoot!, '.aw-command-producer.json'))).producer).toMatchObject({ scope: 'user', projectRoot: null, kind: 'static-skill', platform: 'claude' });
    const userSettings = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    const checkRun = async () => {
      const capture = path.join(isolation.layout.fixtureCwd, 'claude-shared-capture.json');
      const output = createCapturedCliIo();
      expect(await runCli(['command', 'run', commandId!, '--', 'check'], { cwd: projects[1]!, env: { ...isolation.env, CAPTURE_FILE: capture }, io: output.io, interactive: false, nativeCliRunner })).toBe(0);
      expect(await fs.readJson(capture)).toEqual(['user-value', 'check']);
    };
    await checkRun();
    const cleaned = await runPublic(projects[0]!, ['plugin', 'cleanup', 'team/shared-claude', '--target', 'claude', '--scope', 'project', '--yes']);
    expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    expect((await fs.readJson(path.join(projects[0]!, '.claude', 'settings.json'))).permissions?.allow ?? []).not.toContain(`Bash(aw command run ${commandId} -- check *)`);
    expect((await fs.readJson(userSettings)).permissions.allow).toContain(`Bash(aw command run ${commandId} -- check *)`);
    await checkRun();
    const uninstalled = await runPublic(projects[1]!, ['plugin', 'remove', 'team/shared-claude', '--scope', 'project']);
    expect(uninstalled, JSON.stringify(uninstalled)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    await checkRun();
    const restoredProject = await runPublic(projects[1]!, ['plugin', 'install', 'team/shared-claude', '--scope', 'project', '--yes']);
    expect(restoredProject, JSON.stringify(restoredProject)).toMatchObject({ exitCode: 0 });
    const offline = await cleanupWriteCommand(['team/shared-claude'], { cwd: projects[1]!, platform: 'claude', scope: 'project', yes: true }, { ...runtime, catalogBootstrapError: new Error('Fixture Catalog offline.') });
    expect(offline.overallState, JSON.stringify(offline.rebuildResults)).toBe('succeeded');
    expect(offline.commandResults?.flatMap((result) => result.removedCommandIds) ?? []).not.toContain(commandId);
    await checkRun();
    const mirrorConfigPath = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'config.json');
    const mirrorConfig = await fs.readJson(mirrorConfigPath);
    await fs.writeJson(mirrorConfigPath, { ...mirrorConfig, sourceIdentity: `sha256:${'b'.repeat(64)}` });
    await expect(resolveManagedCommand(commandId!, isolation.env)).rejects.toThrow();
    await fs.writeJson(mirrorConfigPath, mirrorConfig);
    await fs.writeFile(path.join(resourceRoot!, '.aw-command-producer.json'), '{broken');
    await expect(resolveManagedCommand(commandId!, isolation.env)).rejects.toThrow();
    const repairedCommand = await runPublic(projects[0]!, ['plugin', 'sync', '--rebuild', 'team/shared-claude', '--target', 'claude', '--context', 'user', '--yes']);
    expect(repairedCommand, JSON.stringify(repairedCommand)).toMatchObject({ exitCode: 0 });
    expect((await listManagedCommands(isolation.env)).commands.map((entry) => entry.id)).toEqual([commandId]);
    await checkRun();
    await fs.remove(resourceRoot!);
    await expect(resolveManagedCommand(commandId!, isolation.env)).rejects.toThrow();
    const repairedMissingCommand = await runPublic(projects[0]!, ['plugin', 'sync', '--rebuild', 'team/shared-claude', '--target', 'claude', '--context', 'user', '--yes']);
    expect(repairedMissingCommand, JSON.stringify(repairedMissingCommand)).toMatchObject({ exitCode: 0 });
    await checkRun();
  }, 90000);

  it('separates mixed native Skill and AW role renderer requests', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-native-render-source');
    const rendererMarker = path.join(isolation.layout.fixtureCwd, 'mixed-native-renderer.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'mixed-native', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(rendererMarker)}, JSON.stringify({ ids: context.requestedArtifactIds, scope: context.scope, configScope: context.config.targetScope }) + "\\n");`,
      'const artifacts = context.requestedArtifactIds.map((id) => id === "native-skill" ? ({',
      '  id, kind: "skill", platform: "codex", target: "codex.skill", state: "present",',
      '  skillKey: "native-skill", refreshKeys: [], content: { files: {',
      '    "SKILL.md": "native mixed", "README.md": "native mixed readme",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } }',
      '}) : ({',
      '  id, kind: "codexRole", platform: "codex", target: "codex.agentRole", state: "present",',
      '  roleKey: "helper", refreshKeys: [], content: {',
      '    registration: { description: "Helper role." },',
      '    roleFile: { name: "helper", description: "Helper role.", developer_instructions: "Help." }',
      '  }',
      '}));',
      'console.log(JSON.stringify({ version: 2, artifacts }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'mixed-native', [], 'mixed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [
          {
            id: 'native-skill',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'native-skill',
          },
          {
            id: 'aw-role',
            platform: 'codex',
            scopes: ['project'],
            target: 'codex.agentRole',
            states: ['present'],
            refreshKeys: [],
            roleKey: 'helper',
            requiresCodexProjectConfig: true,
          },
        ],
      };
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
      .map((line) => JSON.parse(line) as { ids: string[]; scope: string; configScope: string });
    expect(events).toContainEqual({ ids: ['aw-role'], scope: 'project', configScope: 'project' });
    expect(events).toContainEqual({ ids: ['native-skill'], scope: 'user', configScope: 'user' });
    expect(events.every((event) => event.ids.length === 1)).toBe(true);
    await expect(fs.readFile(path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-mixed-native-helper.toml',
    ), 'utf8')).resolves.toContain('developer_instructions = "Help."');
    await expect(fs.readFile(path.join(
      isolation.env.CODEX_HOME!,
      'plugins',
      'cache',
      'aw',
      'mixed-native',
      '1.0.0',
      'codex',
      'skills',
      'native-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toBe('native mixed');

  });
});
