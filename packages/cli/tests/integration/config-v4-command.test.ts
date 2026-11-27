import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { replaceCatalogSourcesConfig, readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { createConfigV4Definition } from '../helpers/config-v4-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { readInstalledCommandProducer, readManagedCommandPackageView, resolveManagedCommandPackageId } from '../../src/utils/managed-command-store.js';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';
import { nativeToolFixture } from '../helpers/native-tools.js';

describe('public config command', () => {
  beforeEach(() => { installNativeTestDiscovery({ platforms: ['codex', 'claude'] }); });
  it('advertises v4, preserves raw values, rejects invalid candidates, and leaves installed runtime resources unchanged until sync', async (test) => {
    const timing = createCommandTestTiming(test);
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'v4-command-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/demo');
    const hostSecret = 'host-reference-only-secret';
    const env = { ...isolation.env, HOST_TOKEN: hostSecret };
    const caller = "import {readRuntimeConfig} from './aw-runtime-config.mjs';\nconsole.log(JSON.stringify(await readRuntimeConfig({from:import.meta.url,keys:['advisorProfile','subagentCommands']})));\n";
    const native = await timing.measure('fixture', 'config runtime', async () => {
      await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
        "import fs from 'node:fs';",
        "const context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
        `const files=${JSON.stringify({
          'SKILL.md': '---\nname: executor-tool\ndescription: Use an executor for a bounded task.\n---\n# Executor\n',
          'README.md': '# Executor runtime\n',
          'agents/openai.yaml': 'interface:\n  display_name: Executor\n  short_description: Use an executor for a bounded task.\n  default_prompt: Use the executor for this task.\npolicy:\n  allow_implicit_invocation: true\n',
          'scripts/caller.mjs': caller,
        })};`,
        "console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes('skill')?[{id:'executor-skill',kind:'skill',name:'executor-tool',runtimeConfig:{keys:['advisorProfile','subagentCommands']},content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));",
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'demo', ['aw.installed-runtime-config.v2'], 'Executor fixture\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.config = createConfigV4Definition();
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
        manifest.artifacts = { configKeys: ['advisorProfile', 'subagentCommands'], scopes: ['user'] };
      });
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
      await timing.measure('fixture', 'activate catalog', () =>
        syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env }));
      return createCodexNativeTestRuntime({ env, layout: isolation.layout });
    });
    const { nativeCliRunner } = native;
    const run = (args: string[]) => timing.measure('command', args.slice(0, args[1] === 'config' ? 3 : 2).join(' '), async (sequence) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner,
        debugLogger: { log: (event) => timing.commandEvent(sequence, event) } });
      return { exitCode, payload: JSON.parse(output.readStdout()) as Record<string, unknown>, stderr: output.readStderr() };
    });
    const describe = await run(['self', 'describe']);
    expect(describe).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        data: { capabilities: expect.arrayContaining(['aw.plugin-config.v4']) }
      }
    });
    expect(await run(['self', 'check', '--from', pluginRoot])).toMatchObject({
      exitCode: 0,
      payload: {
        schemaVersion: 2,
        status: 'success',
        data: {
          requiredCapabilities: expect.arrayContaining(['aw.plugin-config.v4']),
          missingCapabilities: []
        }
      }
    });
    const oldCommands = [{ key: 'remote', title: 'Original', adapter: 'codex', args: ['', '--old'], envFrom: { TOKEN: 'HOST_TOKEN' } }];
    const set = (field: string, value: unknown) => run(['plugin', 'config', 'set', 'team/demo', field, '--context', 'user', '--value-json', JSON.stringify(value)]);
    expect(await set('subagentCommands', oldCommands)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        data: { configWrite: 'succeeded' }
      }
    });
    expect(await set('advisorProfile', { executor: 'remote' })).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        data: { configWrite: 'succeeded' }
      }
    });
    expect(await run(['target', 'set', 'codex'])).toMatchObject({ exitCode: 0 });
    const installed = await run(['plugin', 'install', 'team/demo', '--scope', 'user', '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        status: 'success'
      }
    });
    const skillRoot = path.join([...native.marketplaces.values()][0]!, 'plugins/demo/skills/executor-tool');
    const bindingFile = path.join(skillRoot, '.aw-runtime-config.json');
    const originalBinding = await fs.readFile(bindingFile);
    const readRuntime = () => JSON.parse(execFileSync(process.execPath, [path.join(skillRoot, 'scripts/caller.mjs')], { env, encoding: 'utf8' }));
    expect(readRuntime().effectiveValues).toEqual({ advisorProfile: { executor: 'remote' }, subagentCommands: oldCommands });

    const commands = [{ key: 'remote', title: 'Updated', adapter: 'oracle', args: [], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' } }];
    expect(await set('subagentCommands', commands)).toMatchObject({
      exitCode: 0,
      payload: {
        schemaVersion: 2,
        data: {
          configWrite: 'succeeded',
          apply: { state: 'skipped', reason: 'notRequested' }
        }
      }
    });
    const storeFile = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
    const saved = await fs.readFile(storeFile);
    expect(JSON.parse(saved.toString()).common).toEqual({ advisorProfile: { executor: 'remote' }, subagentCommands: commands });
    expect(saved.toString()).not.toContain(hostSecret);
    expect(originalBinding.toString()).not.toContain(hostSecret);
    expect(await fs.readFile(bindingFile)).toEqual(originalBinding);
    expect(readRuntime().effectiveValues.subagentCommands).toEqual(oldCommands);

    const invalid = await set('subagentCommands', [{ ...commands[0], command: process.execPath }]);
    expect(invalid).toMatchObject({
      exitCode: 2,
      payload: {
        schemaVersion: 2,
        command: 'plugin.config.set',
        status: 'failed',
        diagnostics: [expect.objectContaining({ code: 'invalidArguments' })],
        data: {}
      }
    });
    expect(invalid.payload.data).toEqual({});
    expect(await fs.readFile(storeFile)).toEqual(saved);
    expect(await fs.readFile(bindingFile)).toEqual(originalBinding);
    const synced = await run(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--yes']);
    expect(synced, JSON.stringify(synced)).toMatchObject({
      exitCode: 0,
      payload: {
        schemaVersion: 2,
        status: 'success'
      }
    });
    expect(readRuntime().effectiveValues).toEqual({ advisorProfile: { executor: 'remote' }, subagentCommands: commands });
  }, process.platform === 'win32' ? 30_000 : 15_000);

  // Test Value Gate: a published common route change still reprojects visible permissions when an old revision cannot be cleaned up.
  it('reviews and withdraws Claude grants when config apply removes the shared route', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    await fs.ensureDir(path.join(cwd, '.git'));
    const catalog = path.join(cwd, 'catalog');
    const pluginRoot = path.join(catalog, 'plugins/demo');
    const trace = path.join(cwd, 'renders');
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'),
      '---\nname: provider\ndescription: Config route fixture.\n---\n{{aw.command}} check\n');
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), 'process.exitCode = 0;\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      'fs.appendFileSync(' + JSON.stringify(trace) + ', JSON.stringify(context.config.values) + "\\n");',
      "const subcommands = context.config.values.mode === 'ready' ? [{ name: 'check', runner: 'node', entry: 'tool.mjs' }] : [];",
      "console.log(JSON.stringify({version: 2, artifacts: [{id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['mode'], routes: {subcommands}}]}));",
    ].join('\n'));
    await createCatalogSnapshotFixture(catalog, 'demo', [], 'Config route fixture.', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.skills = './skills';
      manifest.config = { schemaVersion: 5, fields: {
        mode: { type: 'string', default: 'ready' }, runtime: { type: 'string', default: 'initial' },
      } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.command = normalizePluginCommand({ sourceDir: './tools', mode: 'dynamic', refreshKeys: ['mode'],
        runtimeConfig: { keys: ['runtime'] } }, manifest);
      manifest.extensions = { permissions: [
        { name: 'grant', allow: [{ argsPrefix: ['check'] }], agentOverrides: { claude: { sandbox: {
          excludedCommands: [{ argsPrefix: ['check'] }],
        } } } },
        { name: 'restrict', deny: [{ argsPrefix: ['check', 'blocked'] }] },
      ] };
    });
    const native = await createClaudeNativeTestRuntime(isolation);
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io,
        interactive: false, nativeCliRunner: native.nativeCliRunner });
      return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
    };
    const selector = 'team/demo';
    expect(await run(['source', 'add', 'team', '--path', catalog, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
    expect(await run(['source', 'sync', 'team'])).toMatchObject({ exitCode: 0 });
    expect(await run(['target', 'set', 'claude'])).toMatchObject({ exitCode: 0 });
    const installed = await run(['plugin', 'install', selector, '--scope', 'project', '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0 });
    const settings = path.join(cwd, '.claude/settings.local.json');
    const invocation = 'aw command run team/demo/claude -- check';
    expect((await fs.readJson(settings)).permissions.allow).toContain('Bash(' + invocation + ' *)');
    const renderCount = async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').length;
    const initialRenders = await renderCount();
    expect(await run(['plugin', 'config', 'set', selector, 'runtime', '--platform', 'claude', '--value-json', '"changed"']))
      .toMatchObject({ exitCode: 0 });
    const targeted = await run(['plugin', 'config', 'apply', selector, '--context', 'project', '--platform', 'claude', '--yes']);
    expect(targeted, JSON.stringify(targeted)).toMatchObject({
      exitCode: 0, payload: { data: { apply: { commandResults: [{ action: 'updated', availability: 'ready' }] } } },
    });
    expect(await renderCount()).toBe(initialRenders);
    const set = ['plugin', 'config', 'set', selector, 'mode', '--context', 'project', '--value-json', '"empty"', '--apply'];
    const review = await run(set);
    expect(review, JSON.stringify(review)).toMatchObject({ exitCode: 3, payload: { data: { confirmation: { effects:
      expect.arrayContaining([
        expect.objectContaining({ code: 'reviewCommandPackage', message: expect.stringContaining(invocation + '  subcommand:') }),
        expect.objectContaining({ code: 'reviewCommandPackage', message: expect.stringContaining('Other projects') }),
        expect.objectContaining({ code: 'retainInactiveCommandRestriction',
          message: expect.stringContaining('No handler is currently reachable'),
          subject: { pluginId: selector, target: 'claude', scope: 'project' } }),
      ]),
    } } } });
    expect((await fs.readJson(settings)).permissions.allow).toContain('Bash(' + invocation + ' *)');
    const packageId = await resolveManagedCommandPackageId(selector, env);
    const active = await readManagedCommandPackageView(packageId, env);
    const staleRevision = path.join(path.dirname(active.resourceRoot!), randomUUID());
    await fs.symlink(catalog, staleRevision, process.platform === 'win32' ? 'junction' : 'dir');
    const reviewedRenders = await renderCount();
    const applied = await run([...set, '--yes']);
    expect(applied, JSON.stringify(applied.payload.diagnostics)).toMatchObject({ payload: { status: 'partial', data: { configWrite: 'succeeded',
      apply: { state: 'partial', commandResults: [{ selector, action: 'updated', availability: 'empty', subcommands: [], hasFallback: false,
        state: 'partial', blockerCodes: ['commandResourceInvalid'] }] },
    } } });
    expect(applied.payload.nextActions).toContainEqual(expect.objectContaining({
      kind: 'command', argv: ['aw', 'command', 'package', 'sync', selector], requiresConfirmation: true,
    }));
    const current = await readManagedCommandPackageView(packageId, env);
    expect(current.availability).toBe('empty');
    expect(current.resourceRoot).not.toBe(active.resourceRoot);
    expect(await fs.realpath(staleRevision)).toBe(await fs.realpath(catalog));
    await fs.unlink(staleRevision);
    expect(await renderCount()).toBe(reviewedRenders + 1);
    const projected = await fs.readJson(settings);
    expect(projected.permissions.allow ?? []).toEqual([]);
    expect(projected.sandbox?.excludedCommands ?? []).toEqual([]);
    expect(projected.permissions.deny).toContain('Bash(' + invocation + ' blocked *)');
  }, 30_000);

  // Test Value Gate: Active native closure changes take precedence over version/digest changes, and no guard runs renderer or replaces the installed revision.
  it.each([
    { change: 'native and version', version: '2.0.0', preferred: true, code: 'nativeToolSyncRequired' },
    { change: 'version', version: '2.0.0', preferred: false, code: 'configApplyVersionMismatch' },
    { change: 'source bytes', version: '1.0.0', preferred: false, code: 'configApplyVersionMismatch' },
  ] as const)('keeps the previous revision when Active changes $change', async ({ version, preferred, code }) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const catalog = path.join(cwd, 'catalog');
    const pluginRoot = path.join(catalog, 'plugins/demo');
    const marker = path.join(cwd, 'renders');
    const nativeCli = await createClaudeNativeTestRuntime(isolation);
    const writeSnapshot = async (native: ReturnType<typeof nativeToolFixture>, pluginVersion: string, entry: string) => {
      for (const [relative, content] of Object.entries(native.files)) await fs.outputFile(path.join(pluginRoot, relative), content);
      await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), entry);
      await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'),
        '---\nname: provider\ndescription: Native command guard fixture.\n---\nUse the provider.\n');
      await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
        "import fs from 'node:fs';",
        "const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
        'fs.appendFileSync(' + JSON.stringify(marker) + ', "render\\n");',
        "if (c.surface.name === 'managed-commands') console.log(JSON.stringify({version: 2, artifacts: [{id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['registry'], routes: {fallback: {runner: 'node', entry: 'tool.mjs'}}}]}));",
        "else console.log(JSON.stringify({version: 3, components: [], omitted: [], unmet: []}));",
      ].join('\n'));
      await createDependencyCatalogSnapshotFixture(catalog, [
        { name: 'demo', configureManifest(manifest) {
          manifest.version = pluginVersion;
          manifest.platforms = ['claude'];
          manifest.skills = './skills';
          manifest.config = { schemaVersion: 5, fields: { registry: { type: 'array', default: [], validation: { uniqueBy: 'key' },
            items: { type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false },
          } } };
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
          manifest.artifacts = { configKeys: ['registry'], scopes: ['user'] };
          manifest.command = normalizePluginCommand({ sourceDir: './tools', mode: 'dynamic', refreshKeys: ['registry'] }, manifest);
          manifest.nativeTools = { reader: native.closure.reader, definitions: native.closure.definitions,
            consumers: native.closure.consumers };
        } },
        { name: 'consumer', dependencies: ['demo'], configureManifest(manifest) {
          manifest.platforms = ['claude'];
          manifest.config = { schemaVersion: 5, fields: { selected: { type: 'string', default: 'local',
            valueRef: { plugin: 'demo', field: 'registry', key: 'key', include: ['local'] },
          } } };
        } },
      ]);
    };
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false,
        nativeCliRunner: nativeCli.nativeCliRunner });
      return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
    };
    const selector = 'team/demo';
    await writeSnapshot(nativeToolFixture(), '1.0.0', 'process.exitCode = 0;');
    expect(await run(['source', 'add', 'team', '--path', catalog, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
    expect(await run(['source', 'sync', 'team'])).toMatchObject({ exitCode: 0 });
    expect(await run(['target', 'set', 'claude'])).toMatchObject({ exitCode: 0 });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0 });
    const packageId = await resolveManagedCommandPackageId(selector, env);
    const before = await readManagedCommandPackageView(packageId, env);
    const oldRecord = await readInstalledCommandProducer(before.resourceRoot!);
    await fs.remove(marker);
    await writeSnapshot(nativeToolFixture({ policy: preferred ? 'preferred' : 'required' }), version,
      version === '1.0.0' ? 'process.exitCode = 1;' : 'process.exitCode = 0;');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
    // The dependent deployment also needs refresh once the saved consumer value becomes valid.
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
      pluginName: 'consumer', scope: 'user', cwd, env, values: { selected: 'remote' } });
    const applied = await run(['plugin', 'config', 'set', selector, 'registry', '--value-json', '[{"key":"remote"}]', '--apply', '--yes']);
    expect(applied, JSON.stringify(applied)).toMatchObject({
      exitCode: 4, payload: {
        status: 'partial',
        data: { configWrite: 'succeeded', apply: { targetResults: expect.arrayContaining([
          expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/consumer' }),
            state: expect.stringMatching(/^(?:failed|skipped)$/u) }),
        ]), commandResults: [
          { packageId, selector, action: 'unchanged', availability: 'ready', state: 'failed', blockerCodes: [code], errors: [{ code }] },
        ] } },
        nextActions: expect.arrayContaining([expect.objectContaining({ kind: 'command', argv: ['aw', 'command', 'package', 'sync', selector] })]),
      },
    });
    const store = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
    expect((await fs.readJson(store)).common.registry).toEqual([{ key: 'remote' }]);
    expect(await fs.pathExists(marker)).toBe(false);
    expect(await readManagedCommandPackageView(packageId, env)).toEqual(before);
    expect(await readInstalledCommandProducer(before.resourceRoot!)).toEqual(oldRecord);
  }, 30_000);
});
