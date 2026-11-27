import path from 'node:path';
import { Readable } from 'node:stream';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { COMMAND_PRODUCER_RECORD_FILE, normalizePluginCommand, readPluginManifest } from '@lesliechan721/aw-plugin-core/manifest';

import { runCli } from '../../src/index.js';
import * as platformDiscovery from '../../src/platforms/discovery.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogGenerationStatePath } from '../../src/utils/catalog-generation-state.js';
import { validateCatalogSnapshotComplete } from '../../src/utils/catalog-snapshot.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { setTargets, writePreferences, createEmptyPreferences, resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';

const discoverPlatforms = platformDiscovery.discoverPlatforms;

async function fixture(kind: 'config' | 'skill' | 'command' | 'nested' | 'platform-only' = 'config') {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  await git(cwd, ['init', '--quiet']);
  if (kind !== 'skill') await setTargets({ scope: 'user', cwd, env }, ['cursor', 'generic']);
  let nativeCliRunner: NativeCliRunner | undefined;
  if (kind === 'skill') {
    const discovery = vi.spyOn(platformDiscovery, 'discoverPlatforms').mockImplementation((ctx) => discoverPlatforms({
      ...ctx, macApplicationsDirectories: [], windowsApplicationsDirectories: [], linuxDesktopDirectories: [],
    }));
    onTestFinished(() => discovery.mockRestore());
    const binRoot = path.join(cwd, 'cursor-bin');
    const executable = path.join(binRoot, 'cursor-agent');
    await fs.outputFile(executable, '', { mode: 0o755 });
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = binRoot;
    nativeCliRunner = async (invocation) => {
      if (invocation.command === executable && invocation.args.length === 1 && invocation.args[0] === '--version') {
        return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      }
      throw new Error('The Cursor configuration fixture only permits a version probe.');
    };
  }
  const sourceRoot = path.join(cwd, 'config-source');
  const rendererMarker = path.join(cwd, 'command-rendered');
  if (kind === 'skill') await fs.outputFile(path.join(sourceRoot, 'plugins/demo/render.mjs'), [
    'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
    `const files=${JSON.stringify({ 'SKILL.md': '---\nname: config-demo\ndescription: Config apply fixture.\n---\nFixture.\n', 'README.md': '# Config fixture\n' })};`,
    'const allowed=c.allowedOutputKinds.includes("skill");const enabled=c.config.values.enabled;',
    'console.log(JSON.stringify({version:3,components:allowed&&enabled?[{id:"config-demo",kind:"skill",name:"config-demo",content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:allowed&&!enabled?[{id:"config-demo",kind:"skill",reason:"config-disabled"}]:[],unmet:[]}));',
  ].join('\n'));
  if (kind === 'command') {
    await fs.outputFile(path.join(sourceRoot, 'plugins/demo/tools/entry.mjs'),
      "process.exitCode = process.argv[2] === 'common-default' ? 17 : 19;\n");
    await fs.outputFile(path.join(sourceRoot, 'plugins/demo/render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      `fs.writeFileSync(${JSON.stringify(rendererMarker)}, JSON.stringify({
        event: context.event, values: context.config.values, changedConfigKeys: context.changedConfigKeys,
      }));`,
      "const fallback = { runner: 'node', entry: 'entry.mjs', args: [context.config.values.mode] };",
      "console.log(JSON.stringify({ version: 2, artifacts: [{ id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['mode', 'region'], routes: { fallback } }] }));",
    ].join('\n'));
  }
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], '# Config fixture\n', (manifest) => {
    manifest.platforms = ['cursor', 'generic'];
    if (kind === 'skill') {
      manifest.artifacts = { configKeys: ['enabled'], scopes: ['project'] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    }
    if (kind === 'command') {
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    }
    manifest.config = kind === 'platform-only' ? { schemaVersion: 5, fields: {
      profile: { type: 'string', platformOnly: true, required: true },
    } } : { schemaVersion: 5, fields: {
      mode: { type: 'string', default: 'common-default', choices: { allowCustom: true,
        presets: [{ id: 'fast', title: 'Common fast', value: 'common-fast' }] } },
      enabled: { type: 'boolean', default: true },
      token: { type: 'string', sensitive: true },
      ...(kind === 'nested' ? {
        subagentCommands: { type: 'array', items: { type: 'object', properties: {
          key: { type: 'string', required: true },
          models: { type: 'array', validation: { uniqueBy: 'id' }, items: { type: 'object', properties: {
            id: { type: 'string', required: true },
            efforts: { type: 'array', items: { type: 'string' } },
            default: { type: 'boolean' },
          } } },
        } } },
      } : {}),
      ...(kind === 'command' ? {
        region: { type: 'string', default: 'local', valueRef: { field: 'regions', key: 'name' } },
        regions: { type: 'array', default: [{ name: 'local' }], validation: { uniqueBy: 'name' }, items: {
          type: 'object', properties: { name: { type: 'string', required: true } }, additionalProperties: false,
        } },
      } : {}),
    }, platforms: { cursor: { fields: {
      mode: { type: 'string', default: 'cursor-default', choices: { allowCustom: true,
        presets: [{ id: 'fast', title: 'Cursor fast', value: 'cursor-fast' }] } },
      cursorOnly: { type: 'number', default: 1 },
    } } } };
    if (kind === 'command') {
      manifest.command = normalizePluginCommand({ sourceDir: './tools', mode: 'dynamic', refreshKeys: ['mode', 'region'] }, manifest);
    }
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const file = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
  const run = async (args: string[], input?: string | Buffer[]) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], {
      cwd, env, interactive: false, io: captured.io, nativeCliRunner,
      ...(input === undefined ? {} : { stdin: Readable.from(typeof input === 'string' ? [input] : input) })
    });
    return { exitCode, value: JSON.parse(captured.readStdout()), stdout: captured.readStdout(), stderr: captured.readStderr() };
  };
  return { cwd, env, file, run, rendererMarker };
}

describe('platform configuration CLI', () => {
  beforeEach(() => { installNativeTestDiscovery({ platforms: ['cursor'] }); });
  // Test Value Gate: rejected writes/apply leave stopped-target data intact, including when its target is excluded.
  it('blocks inactive platforms before writes and apply, but still permits inspecting and clearing historical overrides', async () => {
    const f = await fixture();
    const selector = 'team/demo';
    const prefix = ['plugin', 'config'];
    const location = { scope: 'user' as const, cwd: f.cwd, env: f.env };
    const set = [...prefix, 'set', selector, 'cursorOnly', '--platform', 'cursor', '--value-json', '2'];
    expect(await f.run(set)).toMatchObject({ exitCode: 0 });
    const before = await fs.readFile(f.file);
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['cursor', 'generic'],
      exclusions: [{ plugin: selector, target: 'cursor' }] });
    for (const args of [set, [...prefix, 'suggestions', selector, 'mode', '--platform', 'cursor'],
      [...prefix, 'apply', selector, '--platform', 'cursor', '--yes'],
      [...prefix, 'apply', selector, '--target', 'cursor', '--yes']]) {
      const blocked = await f.run(args);
      expect(blocked, blocked.stdout).toMatchObject({ exitCode: 3, value: { status: 'blocked',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'configPlatformNotEnabled',
          subject: expect.objectContaining({ pluginId: selector, target: 'cursor' }) })]),
        nextActions: expect.arrayContaining([expect.objectContaining({ kind: 'command',
          argv: ['aw', 'plugin', 'config', 'reset', selector, '--platform', 'cursor'] })]) } });
      expect(await fs.readFile(f.file)).toEqual(before);
    }
    expect(await f.run([...prefix, 'schema', selector, '--platform', 'cursor'])).toMatchObject({ exitCode: 0 });
    expect(await f.run([...prefix, 'get', selector, 'cursorOnly', '--platform', 'cursor']))
      .toMatchObject({ exitCode: 0, value: { data: { fields: [{ effectiveValue: 2 }] } } });
    const blockedText = createCapturedCliIo();
    expect(await runCli(set, { cwd: f.cwd, env: f.env, io: blockedText.io, interactive: false })).toBe(3);
    expect(blockedText.readStdout()).toContain('BLOCKED');
    expect(blockedText.readStderr()).toContain('configPlatformNotEnabled');
    const getText = createCapturedCliIo();
    expect(await runCli([...prefix, 'get', selector, 'cursorOnly', '--platform', 'cursor'],
      { cwd: f.cwd, env: f.env, io: getText.io, interactive: false })).toBe(0);
    expect(getText.readStdout()).toContain('SUCCESS');
    expect(await f.run([...prefix, 'unset', selector, 'cursorOnly', '--platform', 'cursor', '--apply', '--yes']))
      .toMatchObject({ exitCode: 4, value: { status: 'partial', data: { configWrite: 'succeeded',
        apply: { state: 'unavailable', error: { code: 'configPlatformNotEnabled' } } } } });
    expect(await fs.pathExists(f.file)).toBe(false);
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['cursor'] });
    expect(await f.run(set)).toMatchObject({ exitCode: 0 });
    await fs.outputFile(await resolvePreferencesPath(location), '{broken');
    expect(await f.run(set)).toMatchObject({ exitCode: 3, value: { status: 'blocked',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'deploymentPreferencesInvalid' })]) } });
    await fs.outputFile(f.file, '{broken');
    expect(await f.run([...prefix, 'schema', selector, '--platform', 'cursor']))
      .toMatchObject({ exitCode: 0, value: { data: { fields: { cursorOnly: expect.objectContaining({ type: 'number' }) } } } });
    expect(await f.run([...prefix, 'reset', selector, '--platform', 'cursor', '--apply', '--yes']))
      .toMatchObject({ exitCode: 4, value: { status: 'partial', data: { configWrite: 'succeeded',
        confirmation: { required: true, provided: true }, apply: { error: { code: 'deploymentPreferencesInvalid' } } } } });
    expect(await fs.pathExists(f.file)).toBe(false);
  });

  // Test Value Gate: an entirely platform-only declaration has no common write target, even when stale values exist.
  it('rejects common writes and suggestions for a platform-only plugin without preventing cleanup', async () => {
    const f = await fixture('platform-only');
    const selector = 'team/demo';
    const prefix = ['plugin', 'config'];
    const set = [...prefix, 'set', selector, 'profile', '--value-json', '"configured"'];
    expect(await f.run([...set, '--platform', 'cursor'])).toMatchObject({ exitCode: 0 });
    const document = await fs.readJson(f.file);
    await fs.outputJson(f.file, { ...document, common: { profile: 'stale-history' } });
    for (const args of [set, [...prefix, 'suggestions', selector, 'profile']]) {
      expect(await f.run(args)).toMatchObject({ exitCode: 3, value: { status: 'blocked',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'configCommonLayerUnavailable' })]),
        nextActions: expect.any(Array) } });
    }
    expect(await f.run([...prefix, 'get', selector, 'profile'])).toMatchObject({ exitCode: 0,
      value: { data: { fields: [expect.objectContaining({ effectiveValue: '[redacted]', canUnset: true })] } } });
    expect(await f.run([...prefix, 'unset', selector, 'profile'])).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(f.file)).toMatchObject({ common: {}, platforms: { cursor: { profile: 'configured' } } });
  });
  it.each([
    ['team/missing', 'pluginUnavailable'],
    ['team/demo', 'sourceActiveUnavailable'],
  ] as const)('stops before applying %s when its Active source cannot supply it', async (selector, code) => {
    const f = await fixture();
    if (code === 'sourceActiveUnavailable') await fs.unlink(resolveCatalogGenerationStatePath(f.env));
    const result = await f.run(['plugin', 'config', 'apply', selector, '--context', 'user', '--yes']);
    expect(result.exitCode).not.toBe(0);
    expect(result.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    expect(await fs.pathExists(f.file)).toBe(false);
    const reset = await f.run(['plugin', 'config', 'reset', selector, '--context', 'user', '--apply', '--yes']);
    expect(reset.exitCode).not.toBe(0);
    expect(reset.value.data.apply.error).toMatchObject({ stage: 'source', code });
  });

  // Test Value Gate: failed Active resolution must preserve the already runnable revision.
  it('keeps the published dynamic command callable when config apply cannot resolve Active', async () => {
    const f = await fixture('command');
    const selector = 'team/demo';
    const synced = await f.run(['command', 'package', 'sync', selector, '--yes']);
    expect(synced, synced.stdout).toMatchObject({ exitCode: 0 });
    const show = () => f.run(['command', 'show', selector]);
    const before = await show();
    expect(before).toMatchObject({ exitCode: 0, value: { data: {
      commands: [expect.objectContaining({ availability: 'ready', resourceRoot: expect.any(String),
        routes: { subcommands: [], fallback: expect.objectContaining({ entry: 'entry.mjs', args: ['common-default'] }) } })],
    } } });
    expect(await fs.readJson(f.rendererMarker)).toMatchObject({ values: { mode: 'common-default' } });
    await fs.unlink(f.rendererMarker);
    expect(await f.run(['plugin', 'config', 'set', selector, 'mode', '--context', 'user', '--value-json', '"saved"']))
      .toMatchObject({ exitCode: 0 });
    await fs.unlink(resolveCatalogGenerationStatePath(f.env));

    const result = await f.run(['plugin', 'config', 'apply', selector, '--context', 'user', '--yes']);
    expect(result.exitCode).not.toBe(0);
    expect(result.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'sourceActiveUnavailable' }));
    expect((await fs.readJson(f.file)).common.mode).toBe('saved');
    await expect(fs.pathExists(f.rendererMarker)).resolves.toBe(false);
    expect((await show()).value.data.commands).toEqual(before.value.data.commands);
    const capture = createCapturedCliIo();
    expect(await runCli(['command', 'run', selector, '--'], {
      cwd: f.cwd, env: f.env, interactive: false, io: capture.io,
    }), capture.readStderr()).toBe(17);
  });

  // The author renderer receives changes since the published routes, limited to its common non-sensitive inputs.
  it('reports actual route input changes for saved and immediate config apply', async () => {
    const f = await fixture('command');
    const selector = 'team/demo';
    const set = (key: string, value: unknown, ...flags: string[]) =>
      f.run(['plugin', 'config', 'set', selector, key, '--context', 'user', '--value-json', JSON.stringify(value), ...flags]);
    const synced = await f.run(['command', 'package', 'sync', selector, '--yes']);
    expect(synced, synced.stdout).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(f.rendererMarker)).toMatchObject({ changedConfigKeys: [] });
    await fs.unlink(f.rendererMarker);

    const regions = [{ name: 'local' }, { name: 'remote' }];
    expect(await set('mode', 'saved')).toMatchObject({ exitCode: 0 });
    expect(await set('regions', regions)).toMatchObject({ exitCode: 0 });
    expect(await set('enabled', false)).toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'config', 'set', selector, 'token', '--context', 'user', '--value-stdin'], 'fake-test-secret'))
      .toMatchObject({ exitCode: 0 });
    expect(await set('mode', 'cursor-only', '--platform', 'cursor')).toMatchObject({ exitCode: 0 });
    await expect(fs.pathExists(f.rendererMarker)).resolves.toBe(false);

    const applied = await f.run(['plugin', 'config', 'apply', selector, '--context', 'user', '--yes']);
    expect(applied, applied.stdout).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(f.rendererMarker)).toEqual({
      event: 'refresh', values: { mode: 'saved', region: 'local', regions },
      changedConfigKeys: ['mode', 'regions'],
    });

    const savedAndApplied = await set('region', 'remote', '--apply', '--yes');
    expect(savedAndApplied, savedAndApplied.stdout).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(f.rendererMarker)).toEqual({
      event: 'refresh', values: { mode: 'saved', region: 'remote', regions },
      changedConfigKeys: ['region'],
    });

    const shown = await f.run(['command', 'show', selector]);
    expect(shown, shown.stdout).toMatchObject({ exitCode: 0 });
    const producerFile = path.join(shown.value.data.commands[0].resourceRoot, COMMAND_PRODUCER_RECORD_FILE);
    const legacyRecord = await fs.readJson(producerFile);
    delete legacyRecord.routeConfigKeyDigests;
    await fs.writeJson(producerFile, legacyRecord);
    const legacyApply = await set('mode', 'legacy-refresh', '--apply', '--yes');
    expect(legacyApply, legacyApply.stdout).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(f.rendererMarker)).toMatchObject({
      event: 'refresh', values: { mode: 'legacy-refresh' }, changedConfigKeys: [],
    });
    const nextApply = await set('mode', 'next-refresh', '--apply', '--yes');
    expect(nextApply, nextApply.stdout).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(f.rendererMarker)).toMatchObject({
      event: 'refresh', values: { mode: 'next-refresh' }, changedConfigKeys: ['mode'],
    });
  });

  it('uses common by default, compiles platform presets, and keeps project context in the user store', async () => {
    const f = await fixture();
    const initial = await f.run(['plugin', 'config', 'get', 'team/demo', 'mode']);
    expect(initial).toMatchObject({
      exitCode: 0, value: {
        schemaVersion: 2,
        data: {
          platform: 'common',
          context: { context: 'user' },
          fields: [{ effectiveValue: 'common-default', sourceLayer: 'default' }]
        }
      }
    });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'fast']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: {
            configWrite: 'succeeded',
            apply: { reason: 'notRequested' }
          }
        }
      });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'cursor', '--context', 'project', '--preset', 'fast']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: {
            context: { context: 'project', projectRoot: f.cwd },
            platform: 'cursor'
          }
        }
      });
    expect(await fs.readJson(f.file)).toMatchObject({ schemaVersion: 6, common: { mode: 'common-fast' }, platforms: { cursor: { mode: 'cursor-fast' } } });
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows', 'plugin-config'))).toBe(false);
    expect(await f.run(['plugin', 'config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { fields: [{ effectiveValue: 'cursor-fast', sourceLayer: 'platform' }] }
        }
      });
    expect(await f.run(['plugin', 'config', 'unset', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { configWrite: 'succeeded' }
        }
      });
    expect(await f.run(['plugin', 'config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { fields: [{ effectiveValue: 'common-fast', sourceLayer: 'common' }] }
        }
      });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'cursorOnly', '--platform', 'cursor', '--value-json', '0']))
      .toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'config', 'schema', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: {
            configSchemaVersion: 5,
            schema: { platform: 'cursor' },
            fields: { mode: { default: 'cursor-default' }, cursorOnly: { default: 1 }, enabled: { default: true } }
          }
        }
      });
    const resetBefore = await fs.readFile(f.file);
    expect(await f.run(['plugin', 'config', 'reset', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 3, value: {
          command: 'plugin.config.reset', status: 'blocked',
          data: {
            confirmation: {
              required: true, provided: false, effects: [expect.objectContaining({
                code: 'deletePluginConfig', impact: 'user-wide', subject: { pluginId: 'team/demo', scope: 'user' },
              })]
            }
          },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
        }
      });
    expect(await fs.readFile(f.file)).toEqual(resetBefore);
    expect(await f.run(['plugin', 'config', 'reset', 'team/demo', '--platform', 'cursor', '--yes']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { configWrite: 'succeeded', confirmation: { required: true, provided: true } }
        }
      });
    expect((await fs.readJson(f.file)).common).toEqual({ mode: 'common-fast' });
    expect((await fs.readJson(f.file)).platforms).toEqual({});
  });

  // Public get and set must round-trip nested values with the existing envelope and preserve the last valid save.
  it('saves and lists nested arrays after reading earlier Store v6 values without a migration', async () => {
    const f = await fixture('nested');
    const selector = 'team/demo';
    const read = ['plugin', 'config', 'get', selector];
    const set = (rows: unknown[]) => f.run([
      'plugin', 'config', 'set', selector, 'subagentCommands', '--value-json', JSON.stringify(rows),
    ]);
    expect(await f.run(['plugin', 'config', 'set', selector, 'mode', '--preset', 'fast'])).toMatchObject({ exitCode: 0 });
    const previousStore = await fs.readFile(f.file);
    expect(await f.run([...read, 'mode'])).toMatchObject({
      exitCode: 0, value: { data: { fields: [{ effectiveValue: 'common-fast', sourceLayer: 'common' }] } },
    });
    expect(await fs.readFile(f.file)).toEqual(previousStore);

    const models = [{ id: 'example', efforts: ['low', 'high'], default: false }];
    const rows = [{ key: 'custom', models }];
    const saved = await set(rows);
    expect(saved, saved.stdout).toMatchObject({ exitCode: 0, value: { data: { configWrite: 'succeeded' } } });
    expect(await fs.readJson(f.file)).toEqual({
      ...JSON.parse(previousStore.toString()), common: { mode: 'common-fast', subagentCommands: rows },
    });
    for (const args of [read, [...read, 'subagentCommands']]) {
      expect(await f.run(args)).toMatchObject({
        exitCode: 0, value: { schemaVersion: 2, data: { fields: expect.arrayContaining([
          expect.objectContaining({ key: 'subagentCommands', effectiveValue: rows, sourceLayer: 'common' }),
        ]) } },
      });
    }
    const captured = createCapturedCliIo();
    expect(await runCli(read, { cwd: f.cwd, env: f.env, interactive: false, io: captured.io })).toBe(0);
    expect(captured.readStdout()).toContain('"models":[{"default":false,"efforts":["low","high"],"id":"example"}]');

    const validStore = await fs.readFile(f.file);
    const invalid = await set([{ key: 'custom', models: [...models, ...models] }]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toContain('subagentCommands[0].models[1].id');
    const unknownProperty = await set([{ key: 'custom', models: [{ ...models[0], 'private-user-key': 'private-user-value' }] }]);
    expect(unknownProperty.exitCode).toBe(2);
    expect(unknownProperty.stdout).not.toContain('private-user-key');
    expect(await fs.readFile(f.file)).toEqual(validStore);
  });

  // Catalog validation links declared providers and the public schema exposes their nested consumer fields.
  it('validates same-source suggestion providers, bundles their script closure, and projects nested suggestions', async () => {
    const { env, layout: { fixtureCwd: cwd } } = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(cwd, 'suggestions-source');
    const providerRoot = path.join(sourceRoot, 'plugins/provider');
    const suggestions = { provider: 'model-list', plugin: 'provider', dependsOn: ['executor'] };
    const createFixture = (withProvider: boolean) => createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'provider', configureManifest(manifest) {
        if (withProvider) manifest.scripts = { config: { suggestions: { runner: 'node', path: './scripts/suggestions.mjs' } } };
      } },
      { name: 'consumer', dependencies: ['provider'], configureManifest(manifest) {
        manifest.config = { schemaVersion: 5, fields: {
          commands: { type: 'array', items: { type: 'object', properties: { models: {
            type: 'array', items: { type: 'object', properties: {
              model: { type: 'string', suggestions },
              executor: { type: 'string' },
            } },
          } } } },
        } };
      } },
    ]);
    await createFixture(false);
    await expect(validateCatalogSnapshotComplete(sourceRoot)).rejects.toThrow(/dependency "provider" requires scripts.config.suggestions/u);

    await fs.outputFile(path.join(providerRoot, 'scripts/suggestions.mjs'), "import './providers.mjs';\n");
    await fs.outputFile(path.join(providerRoot, 'scripts/providers.mjs'), 'export const models = [];\n');
    await createFixture(true);
    await expect(validateCatalogSnapshotComplete(sourceRoot)).resolves.toBeDefined();
    const bundledRoot = path.join(cwd, 'bundled-provider');
    await bundleLocalPlugin(await readPluginManifest(providerRoot), bundledRoot);
    expect(await fs.readFile(path.join(bundledRoot, 'scripts/providers.mjs'), 'utf8')).toBe('export const models = [];\n');
    expect((await readPluginManifest(bundledRoot, { mode: 'bundle' })).manifest.scripts?.config?.suggestions)
      .toEqual({ runner: 'node', path: './scripts/suggestions.mjs' });

    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const captured = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'schema', 'team/consumer', '--json'], {
      cwd, env, interactive: false, io: captured.io,
    })).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({ data: { fields: {
      commands: { items: { properties: { models: { items: { properties: {
        model: { type: 'string', suggestions },
      } } } } } },
    } } });
  });

  it.each([
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--scope', 'project', '--value-json', '"bad"'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"bad"', '--apply-scope', 'project'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'claude-code', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'agent-skills', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'unknown', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'apply', 'team/demo', '--scope', 'user'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'apply', 'team/demo', '--target', 'unknown'], code: 'invalidArguments' },
  ])('rejects invalid arguments before changing the common document: $args', async ({ args, code }) => {
    const f = await fixture();
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"saved"'])).toMatchObject({ exitCode: 0 });
    const before = await fs.readFile(f.file);
    const result = await f.run(args);
    expect(result).toMatchObject({
      exitCode: 2, value: {
        schemaVersion: 2,
        command: `plugin.config.${args[2]}`,
        status: 'failed',
        diagnostics: [{ code }],
        data: {}
      }
    });
    expect(result.value.data).toEqual({});
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it('keeps exact sensitive stdin bytes and rejects sensitive argv from a project context', async () => {
    const f = await fixture();
    const secret = ' \t密钥 café 🔑\r\nline-two\n';
    const bytes = Buffer.from(secret, 'utf8');
    const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 14), bytes.subarray(14)];
    const rejected = await f.run(['plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', '--value-json', JSON.stringify(secret)]);
    expect(rejected).toMatchObject({
      exitCode: 2, value: {
        schemaVersion: 2,
        command: 'plugin.config.set',
        status: 'failed',
        diagnostics: [{ code: 'sensitiveConfigInputUnsupported' }],
        data: {}
      }
    });
    expect(rejected.value.data).toEqual({});
    expect(rejected.stdout + rejected.stderr).not.toContain('密钥');
    expect(rejected.stdout + rejected.stderr).not.toContain('line-two');
    expect(await fs.pathExists(f.file)).toBe(false);
    const saved = await f.run(['plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', '--value-stdin'], chunks);
    expect(saved).toMatchObject({
      exitCode: 0, value: {
        schemaVersion: 2,
        data: { configWrite: 'succeeded' }
      }
    });
    expect(saved.stdout + saved.stderr).not.toContain('密钥');
    expect(saved.stdout + saved.stderr).not.toContain('line-two');
    expect(Buffer.from((await fs.readJson(f.file)).common.token, 'utf8')).toEqual(bytes);
    const read = await f.run(['plugin', 'config', 'get', 'team/demo', 'token']);
    expect(read.stdout + read.stderr).not.toContain('密钥');
    expect(read.stdout + read.stderr).not.toContain('line-two');
  });

  it('reports a committed save separately when joint application is blocked', async () => {
    const f = await fixture('skill');
    expect(await f.run(['target', 'set', 'cursor'])).toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { targetResults: [expect.objectContaining({ pluginId: 'team/demo', target: 'cursor', scope: 'project', execution: 'applied' })] }
        }
      });
    const packageRoot = path.join(f.cwd, '.cursor', 'aw-plugins', (await fs.readdir(path.join(f.cwd, '.cursor', 'aw-plugins')))[0]!);
    const output = path.join(packageRoot, 'skills', 'config-demo');
    await fs.remove(path.join(packageRoot, SKILL_OWNER_MARKER));
    const existing = await fs.readFile(path.join(output, 'SKILL.md'));
    const result = await f.run(['plugin', 'config', 'set', 'team/demo', 'enabled', '--context', 'project', '--value-json', 'false', '--apply', '--yes']);
    expect(result, JSON.stringify(result)).toMatchObject({
      exitCode: 4, value: {
        schemaVersion: 2,
        status: 'partial',
        data: {
          configWrite: 'succeeded',
          context: { context: 'project', projectRoot: f.cwd }
        }
      }
    });
    expect(result.value.data.apply.state).not.toBe('succeeded');
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
    expect(await fs.readFile(path.join(output, 'SKILL.md'))).toEqual(existing);
    expect(await fs.pathExists(path.join(packageRoot, SKILL_OWNER_MARKER))).toBe(false);
    const applied = await f.run(['plugin', 'config', 'apply', 'team/demo', '--context', 'project', '--target', 'cursor', '--yes']);
    expect(applied.value).toMatchObject({
      schemaVersion: 2,
      command: 'plugin.config.apply',
      data: { configWrite: 'notStarted' }
    });
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
  });
});
