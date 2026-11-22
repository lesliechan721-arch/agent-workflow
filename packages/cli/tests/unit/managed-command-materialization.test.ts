import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommandPackageId, type PlatformName } from '@lesliechan721/aw-plugin-core/manifest';

import {
  managedCommandProducerIdentity,
  prepareManagedCommandPackage,
  publishPreparedManagedCommandPackage,
  readManagedCommandSource,
  type ManagedCommandPackageOperation,
} from '../../src/utils/managed-command-materialization.js';
import { validateManagedCommandSourceClosure } from '../../src/utils/managed-command-closure.js';
import { readManagedCommandRuntimeConfigSnapshot } from '../../src/utils/managed-command-snapshots.js';
import { readManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import type { PluginMeta } from '../../src/types.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';

describe('shared command package materialization', () => {
  let isolated: IsolatedTestEnvironment;
  let pluginRoot: string;
  let manifestPath: string;
  const nativeTools = {
    definitions: [{ key: 'windows-job', protocol: 'aw.windows-job.v1' }],
    consumers: [{ kind: 'plugin-command', tools: [{ key: 'windows-job', platforms: ['win32'], policy: 'required' }] }],
  };

  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    pluginRoot = path.join(isolated.layout.fixtureCwd, 'plugin');
    manifestPath = path.join(pluginRoot, '.agents-plugin/plugin.json');
    await fs.outputFile(path.join(pluginRoot, 'tools', 'entry.mjs'), [
      'import { readCommandRuntimeConfig } from "./.aw/command-runtime-config.mjs";',
      'export const read = (platform) => readCommandRuntimeConfig({ from: import.meta.url, platform, keys: ["mode"] });',
    ].join('\n'));
  });
  afterEach(async () => { await isolated.cleanup(); });

  async function plugin(options: {
    version?: string;
    newSchema?: boolean;
    platforms?: PlatformName[];
    renderer?: boolean;
    withNativeTools?: boolean;
    withReference?: boolean;
  } = {}): Promise<PluginMeta> {
    await fs.outputJson(manifestPath, {
      schemaVersion: 4, name: 'routing', version: options.version ?? '1.0.0', description: 'Command package fixture.',
      platforms: ['codex', 'claude'], marketplace: { category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      command: { sourceDir: './tools', platforms: options.platforms ?? ['codex', 'claude'],
        mode: 'static', routes: { fallback: { runner: 'node', entry: 'entry.mjs' } }, runtimeConfig: { keys: ['mode'] } },
      config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'normal',
        ...(options.newSchema ? { validation: { minLength: 4 } } : {}),
        ...(options.withReference ? { valueRef: { field: 'modes', key: 'id', include: ['normal'] } } : {}) },
      ...(options.withReference ? { modes: { type: 'array', default: [], validation: { uniqueBy: 'id' },
        items: { type: 'object', properties: { id: { type: 'string', required: true } } } } } : {}),
      unexposed: { type: 'string', default: 'private' } } },
      ...(options.renderer ? { scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } } : {}),
      ...(options.withNativeTools ? { nativeTools } : {}),
    });
    return { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
  }

  function inputs(current: PluginMeta) {
    return { plugin: current, cwd: isolated.layout.fixtureCwd, env: isolated.env };
  }

  async function save(current: PluginMeta, platform: PlatformName, mode: string): Promise<void> {
    await writePluginConfigStore({ ...inputs(current), pluginName: current.manifest.name, sourceId: current.sourceId,
      sourceIdentity: current.sourceIdentity, scope: 'user', platform, values: { mode } });
  }

  async function publish(current: PluginMeta, operation: ManagedCommandPackageOperation) {
    const candidate = await prepareManagedCommandPackage({ ...inputs(current), operation });
    try {
      const result = await publishPreparedManagedCommandPackage({ ...inputs(current), candidate });
      expect(result.errors).toEqual([]);
      return { resourceRoot: result.resourceRoot, record: candidate.record, changes: candidate.runtimeConfigChanges };
    } finally {
      await candidate.cleanup();
    }
  }

  // Platform sync crosses a version boundary without exposing another platform's unapplied override.
  it('reissues untouched snapshots with the new revision identity and keeps their last applied values', async () => {
    const old = await plugin();
    await save(old, 'codex', 'first-codex');
    await save(old, 'claude', 'first-claude');
    await publish(old, { kind: 'platform-sync', platforms: ['codex', 'claude'] });
    await save(old, 'codex', 'next-codex');
    await save(old, 'claude', 'next-claude');

    const updated = await plugin({ version: '2.0.0' });
    const rebuilt = await publish(updated, { kind: 'platform-sync', platforms: ['codex'] });
    expect(rebuilt.changes).toEqual([{ platform: 'codex', before: { mode: 'first-codex' }, after: { mode: 'next-codex' } }]);
    const { read } = await import(/* @vite-ignore */ pathToFileURL(path.join(rebuilt.resourceRoot, 'entry.mjs')).href);
    await expect(read('claude')).resolves.toMatchObject({ values: { mode: 'first-claude' },
      installedIdentity: { pluginVersion: '2.0.0', sourceContentDigest: rebuilt.record.sourceContentDigest } });
    await expect(read('codex')).resolves.toMatchObject({ values: { mode: 'next-codex' } });

    const refreshed = await publish(updated, { kind: 'explicit-sync' });
    expect(refreshed.record.sourceContentDigest).toBe(rebuilt.record.sourceContentDigest);
    expect(refreshed.changes).toEqual([{ platform: 'claude', before: { mode: 'first-claude' }, after: { mode: 'next-claude' } }]);
  });

  // A narrowed schema recomputes invalid old values, while explicit sync never establishes extra platforms for an existing package.
  it('rebuilds an incompatible previous snapshot and publishes only the reviewed snapshot set', async () => {
    const old = await plugin();
    await save(old, 'claude', 'old');
    await publish(old, { kind: 'platform-sync', platforms: ['claude'] });
    await save(old, 'claude', 'changed');
    const revised = await plugin({ version: '2.0.0', newSchema: true });
    const diff = await publish(revised, { kind: 'platform-sync', platforms: ['codex'] });
    expect(diff.changes).toContainEqual({ platform: 'claude', before: { mode: 'old' }, after: { mode: 'changed' } });

    const codexOnly = await plugin({ version: '3.0.0', platforms: ['codex'] });
    const narrowed = await publish(codexOnly, { kind: 'explicit-sync' });
    expect(narrowed.record.runtimeConfigPlatforms).toEqual(['codex']);
    expect(narrowed.changes).toContainEqual({ platform: 'claude', before: { mode: 'changed' } });

    const both = await plugin({ version: '4.0.0' });
    const expanded = await publish(both, { kind: 'explicit-sync' });
    expect(expanded.record.runtimeConfigPlatforms).toEqual(['codex']);
  });

  // A non-exported reference source only has saved values, so it cannot invalidate a different platform's prior snapshot.
  it('keeps applied values across versions when unapplied reference dependencies have changed', async () => {
    const old = await plugin({ withReference: true });
    const store = { ...inputs(old), sourceId: old.sourceId, sourceIdentity: old.sourceIdentity,
      pluginName: old.manifest.name, scope: 'user' as const, platform: 'claude' as const };
    await writePluginConfigStore({ ...store, values: { mode: 'first', modes: [{ id: 'first' }] } });
    await publish(old, { kind: 'explicit-sync' });
    await writePluginConfigStore({ ...store, values: { mode: 'pending', modes: [{ id: 'pending' }] } });

    const revised = await plugin({ version: '2.0.0', withReference: true });
    const installed = await publish(revised, { kind: 'platform-sync', platforms: ['codex'] });
    expect(installed.changes).toEqual([]);
    const retained = await readManagedCommandRuntimeConfigSnapshot(installed.resourceRoot, installed.record, 'claude');
    expect(retained.effectiveValues).toEqual({ mode: 'first' });
  });

  // First direct synchronization installs every declared snapshot and the reviewed native closure.
  it('initializes all platforms on first explicit sync and injects only AW runtime resources', async () => {
    const current = await plugin({ withNativeTools: true });
    const result = await publish(current, { kind: 'explicit-sync' });
    expect(result.record.runtimeConfigPlatforms).toEqual(['codex', 'claude']);
    expect(result.record.nativeTools?.consumers).toEqual(nativeTools.consumers);
    expect(await fs.pathExists(path.join(result.resourceRoot, '.aw/native-tool-reader.mjs'))).toBe(true);
    const snapshot = await readManagedCommandRuntimeConfigSnapshot(result.resourceRoot, result.record, 'codex');
    expect(snapshot.effectiveValues).toEqual({ mode: 'normal' });
  });

  // The real renderer is common-only, reads the installed table, and can replace or clear every route.
  it('renders and publishes complete dynamic routes while preserving the last revision on renderer failure', async () => {
    const report = path.join(isolated.layout.fixtureCwd, 'renderer-context.json');
    await fs.outputJson(manifestPath, {
      schemaVersion: 4, name: 'routing', version: '1.0.0', description: 'Dynamic command routes.',
      platforms: ['codex', 'claude'], marketplace: { category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
      command: { sourceDir: './tools', mode: 'dynamic', refreshKeys: ['mode'] },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      config: { schemaVersion: 5, fields: {
        mode: { type: 'string', default: 'first', valueRef: { field: 'options', key: 'id', include: [
          'first', 'next', 'empty', 'malformed', 'missing', 'throws', 'codex-choice', 'claude-choice',
        ] } },
        options: { type: 'array', validation: { uniqueBy: 'id' }, items: {
          type: 'object', properties: { id: { type: 'string', required: true } }, additionalProperties: false,
        } },
        unrelated: { type: 'string', default: 'other-default' },
        secret: { type: 'string', sensitive: true },
      } },
    });
    for (const file of ['first.mjs', 'next.mjs', 'fallback.mjs']) await fs.outputFile(path.join(pluginRoot, 'tools', file), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ context, cwd: process.cwd(), surface: process.env.AW_PLUGIN_SURFACE,
  platform: process.env.AW_PLUGIN_PLATFORM }));
const { mode } = context.config.values;
if (mode === 'throws') throw new Error('renderer failed');
const entry = (file) => ({ runner: 'node', entry: file });
const routes = mode === 'first' ? { subcommands: [{ name: 'export', ...entry('first.mjs') }, { name: 'message', ...entry('first.mjs') }], fallback: entry('fallback.mjs') }
  : mode === 'next' ? { subcommands: [{ name: 'export', ...entry('next.mjs') }] }
  : mode === 'missing' ? { fallback: entry('missing.mjs') } : {};
console.log(JSON.stringify({ version: 2, artifacts: mode === 'malformed' ? [] : [
  { id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['mode'], routes },
] }));`);
    const current = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    const common = (mode?: string) => writePluginConfigStore({ ...inputs(current), pluginName: current.manifest.name,
      sourceId: current.sourceId, sourceIdentity: current.sourceIdentity, scope: 'user',
      values: { ...(mode === undefined ? {} : { mode }), options: [{ id: 'extra-choice' }], secret: 'private-token-value' } });
    await common();
    await save(current, 'codex', 'codex-choice');
    await save(current, 'claude', 'claude-choice');

    const explicitSync = { kind: 'explicit-sync' } as const;
    const first = await publish(current, explicitSync);
    const firstContext = await fs.readJson(report);
    const bundleRoot = await fs.realpath(pluginRoot);
    expect(firstContext).toMatchObject({ cwd: bundleRoot, surface: 'managed-commands', context: {
      surface: { kind: 'aw', name: 'managed-commands' }, scope: 'user', commandSources: [{ sourceDir: path.join(bundleRoot, 'tools') }],
      requestedArtifactIds: ['command-routes'], previousArtifacts: [], config: { targetScope: 'user', issues: [] },
    } });
    expect(firstContext.context.commandSources).toEqual([{ sourceDir: path.join(bundleRoot, 'tools') }]);
    expect(firstContext).not.toHaveProperty('platform');
    expect(firstContext.context).not.toHaveProperty('platform');
    expect(firstContext.context.config.values).toEqual({ mode: 'first', options: [{ id: 'extra-choice' }] });
    expect(firstContext.context.config.sources).toEqual({ mode: 'default', options: 'common' });
    expect(Object.keys(firstContext.context.config.schema).sort()).toEqual(['mode', 'options']);

    await common('next');
    const next = await publish(current, explicitSync);
    expect((await fs.readJson(report)).context.previousArtifacts).toEqual([{
      id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['mode'], routes: first.record.routes,
    }]);
    expect(next.record.routes).toEqual({ subcommands: [expect.objectContaining({ name: 'export', entry: 'next.mjs' })] });

    const producer = managedCommandProducerIdentity({ plugin: current });
    for (const mode of ['malformed', 'missing', 'throws']) {
      await common(mode);
      await expect(prepareManagedCommandPackage({ ...inputs(current), operation: explicitSync })).rejects.toThrow();
      const stillInstalled = await readManagedCommandPackage(producer, isolated.env);
      expect(stillInstalled?.resourceRoot).toBe(next.resourceRoot);
      expect(stillInstalled?.record.routes).toEqual(next.record.routes);
    }

    await common('empty');
    const empty = await publish(current, explicitSync);
    expect(empty.record.routes).toEqual({ subcommands: [] });
    expect((await fs.readJson(report)).context.previousArtifacts[0].routes).toEqual(next.record.routes);
  });

  // Only bytes from the reviewed candidate may be published, even if the changed snapshot remains structurally valid.
  it('rejects an edited staging snapshot without replacing the current revision', async () => {
    const current = await plugin();
    const installed = await publish(current, { kind: 'explicit-sync' });
    const candidate = await prepareManagedCommandPackage({ ...inputs(current), operation: { kind: 'explicit-sync' } });
    try {
      const snapshotPath = path.join(candidate.resourceRoot, '.aw/runtime-config/codex.json');
      const snapshot = await fs.readJson(snapshotPath);
      await fs.writeJson(snapshotPath, { ...snapshot, effectiveValues: { mode: 'tampered' } });
      await expect(publishPreparedManagedCommandPackage({ ...inputs(current), candidate })).rejects.toHaveProperty('code', 'operationReviewStale');
      const producer = managedCommandProducerIdentity({ plugin: current });
      expect((await readManagedCommandPackage(producer, isolated.env))?.resourceRoot).toBe(installed.resourceRoot);
      expect(path.basename(path.dirname(path.dirname(installed.resourceRoot)))).toBe(getCommandPackageId(producer));
    } finally {
      await candidate.cleanup();
    }
  });

  // A malformed pointer cannot be interpreted as an existing package with an empty snapshot set.
  it('retains a damaged package when its previously applied snapshot set is unknown', async () => {
    const current = await plugin();
    const installed = await publish(current, { kind: 'explicit-sync' });
    const packageRoot = path.dirname(path.dirname(installed.resourceRoot));
    const pointer = path.join(packageRoot, 'current.json');
    await fs.writeFile(pointer, '{}');
    await expect(prepareManagedCommandPackage({ ...inputs(current), operation: { kind: 'explicit-sync' } })).rejects.toMatchObject({
      code: 'commandRuntimeConfigInvalid', message: expect.stringContaining(`aw command package remove ${path.basename(packageRoot)} --force`),
    });
    expect(await fs.readFile(pointer, 'utf8')).toBe('{}');
    expect(await fs.pathExists(installed.resourceRoot)).toBe(true);
  });

  // A renderer helper changes the source revision, while unrelated files and saved configuration are outside the closure.
  it('includes renderer imports and excludes unrelated files and saved config from the source digest', async () => {
    const current = await plugin({ renderer: true });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), 'import "./render-helper.mjs";');
    await fs.outputFile(path.join(pluginRoot, 'render-helper.mjs'), 'export const version = 1;');
    const first = await readManagedCommandSource(current);
    await fs.outputFile(path.join(pluginRoot, 'unrelated.mjs'), 'export const ignored = true;');
    await save(current, 'claude', 'changed');
    expect((await readManagedCommandSource(current)).sourceContentDigest).toBe(first.sourceContentDigest);
    await fs.writeFile(path.join(pluginRoot, 'render-helper.mjs'), 'export const version = 2;');
    expect((await readManagedCommandSource(current)).sourceContentDigest).not.toBe(first.sourceContentDigest);
  });

  // Source validation recognizes the declared generated reader but rejects author replacements and escaped imports.
  it('verifies the authored closure before injecting reserved runtime content', async () => {
    const current = await plugin();
    const sourceRoot = path.join(pluginRoot, 'tools');
    await expect(validateManagedCommandSourceClosure(pluginRoot, current.manifest)).resolves.toBeUndefined();
    await fs.outputFile(path.join(sourceRoot, '.aw/command-runtime-config.mjs'), 'export {};');
    await expect(prepareManagedCommandPackage({ ...inputs(current), operation: { kind: 'explicit-sync' } }))
      .rejects.toHaveProperty('code', 'commandResourceInvalid');
    await fs.remove(path.join(sourceRoot, '.aw'));
    await fs.outputFile(path.join(pluginRoot, 'outside.mjs'), 'export {};');
    await fs.writeFile(path.join(sourceRoot, 'entry.mjs'), 'import "../outside.mjs";');
    await expect(validateManagedCommandSourceClosure(pluginRoot, current.manifest)).rejects.toHaveProperty('code', 'commandResourceInvalid');
  });
});
