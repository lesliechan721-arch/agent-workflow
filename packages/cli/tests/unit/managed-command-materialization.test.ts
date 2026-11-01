import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { resolveCommandSourceDirectory } from '../../src/utils/artifact-sources.js';
import { managedCommandProducerIdentity, prepareManagedCommandPackage, prepareManagedCommandPackageFiles,
  syncPluginManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { listManagedCommands } from '../../src/utils/managed-command-store.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { createDefaultPluginProcessRunner, defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';
import { terminateProcessTree } from '../../src/utils/process-tree.js';
import { waitForProcessExit } from '../support/process-tree.js';

describe('managed command package materialization', () => {
  let isolated: IsolatedTestEnvironment;
  let sourceRoot: string;
  const entry = normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'entry.mjs' });

  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    sourceRoot = path.join(isolated.layout.fixtureCwd, 'plugin', 'tools');
    await fs.outputFile(path.join(sourceRoot, 'entry.mjs'), 'import "./helper.mjs";\n');
    await fs.outputFile(path.join(sourceRoot, 'helper.mjs'), 'export const value = 1;\n');
    await fs.outputFile(path.join(sourceRoot, 'config.json'), '{"mode":"source"}\n');
    await fs.chmod(path.join(sourceRoot, 'entry.mjs'), 0o755);
  });
  afterEach(async () => { vi.restoreAllMocks(); await isolated.cleanup(); });

  async function writeControlledRenderer() {
    const pluginRoot = path.dirname(sourceRoot);
    const ready = path.join(pluginRoot, 'renderer-ready.json');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'package-lifecycle', version: '1.0.0', description: 'Package lifecycle fixture.',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: {
        packages: [{ key: 'shared', scope: 'user', platforms: ['codex'], sourceDir: './tools', render: true }],
        sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'shared' }, mode: 'static',
          entries: [{ key: 'run', runner: 'node', entry: 'entry.mjs' }] }],
      },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, contextPath: process.env.AW_PLUGIN_CONTEXT }));`,
      'setTimeout(() => { console.log(JSON.stringify({version:2,artifacts:[{',
      "id:'command-package.shared',target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:[],files:{'config.json':'{}'}",
      '}]})); }, 3000);',
    ].join('\n'));
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    return { plugin, ready };
  }

  // Test Value Gate: producer preparation and direct sync must stop their renderer before releasing temporary context or publishing commands.
  it.each([['cancel', 'prepare'], ['cancel', 'sync'], ['timeout', 'prepare'], ['timeout', 'sync']] as const)(
    'honors %s through %s with confirmed renderer and context cleanup', async (mode, entrypoint) => {
      const fixture = await writeControlledRenderer();
      const controller = new AbortController();
      const reason = new DOMException('package renderer cancelled', 'AbortError');
      const options = { plugin: fixture.plugin, packageKey: 'shared', scope: 'user' as const,
        cwd: isolated.layout.fixtureCwd, env: isolated.env, signal: controller.signal, scriptTimeoutMs: 1000 };
      const prepare = entrypoint === 'prepare';
      const operation = prepare ? prepareManagedCommandPackage(options) : syncPluginManagedCommandPackage(options);
      const outcome = operation.then(async (value) => {
        if ('cleanup' in value) await value.cleanup();
        return { value };
      }, (error: unknown) => ({ error }));
      await vi.waitFor(async () => expect(await fs.pathExists(fixture.ready)).toBe(true), { timeout: 2500 });
      const started = await fs.readJson(fixture.ready) as { pid: number; contextPath: string };
      if (mode === 'cancel') controller.abort(reason);
      const result = await outcome;
      if (mode === 'cancel') expect('error' in result ? result.error : undefined).toBe(reason);
      else if (prepare) expect(result).toMatchObject({ error: { message: expect.stringContaining('Artifact renderer timed out after 1000 ms') } });
      else expect(result).toMatchObject({ value: { state: 'failed' } });
      await waitForProcessExit(started.pid);
      expect(await fs.pathExists(path.dirname(started.contextPath))).toBe(false);
      expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    },
  );

  // Test Value Gate: cancelling a direct package sync must preserve the process boundary's cleanup failure and safe diagnostic.
  it.skipIf(process.platform === 'win32')('preserves renderer cleanup failure evidence when direct package sync is cancelled', async () => {
    const fixture = await writeControlledRenderer();
    const controller = new AbortController();
    const cause = new Error('synthetic process identity failure');
    const failure = Object.assign(new Error('Renderer cleanup could not be confirmed.', { cause }), {
      operationDiagnostic: { code: 'rendererCleanupFailed', safeMessage: 'Renderer cleanup could not be confirmed.' },
    });
    const runner = createDefaultPluginProcessRunner({
      terminateProcessTree: async (...args) => { await terminateProcessTree(...args); throw failure; },
    });
    vi.spyOn(defaultPluginProcessRunner, 'run').mockImplementation((invocation, options) => runner.run(invocation, options));
    const options = { plugin: fixture.plugin, packageKey: 'shared', scope: 'user' as const,
      cwd: isolated.layout.fixtureCwd, env: isolated.env, signal: controller.signal };
    const outcome = syncPluginManagedCommandPackage(options).catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await fs.pathExists(fixture.ready)).toBe(true), { timeout: 2500 });
    const started = await fs.readJson(fixture.ready) as { pid: number; contextPath: string };
    controller.abort(new DOMException('package renderer cancelled', 'AbortError'));
    expect(await outcome).toMatchObject({ cause: failure, operationDiagnostic: failure.operationDiagnostic });
    expect(failure.cause).toBe(cause);
    expect(failure.operationDiagnostic.code).toBe('rendererCleanupFailed');
    await waitForProcessExit(started.pid);
    expect(await fs.pathExists(path.dirname(started.contextPath))).toBe(false);
    expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
  });

  // Native static payload paths have no activation scope, so their IDs must not depend on the caller's project.
  it('gives static native Skills one shared user identity across both platforms and project activations', async () => {
    const pluginRoot = path.dirname(sourceRoot);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', 'SKILL.md'), '---\nname: provider\ndescription: Shared static fixture.\n---\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'static-identity', version: '1.0.0', description: 'Static identity fixture.', skills: './skills',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    });
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    for (const platform of ['codex', 'claude'] as const) {
      const identities = await Promise.all((['user', 'project', 'project'] as const).map((scope, index) => managedCommandProducerIdentity({
        plugin, producer: { kind: 'static-skill', platform, skillKey: 'provider' }, platform, scope,
        cwd: path.join(isolated.layout.fixtureCwd, `project-${index}`),
      })));
      expect(identities[0]).toMatchObject({ kind: 'static-skill', platform, scope: 'user', projectRoot: null });
      expect(identities).toEqual([identities[0], identities[0], identities[0]]);
    }
  });

  // Protects readonly source preparation, complete resources, and absence of real command publication.
  it('prepares final configuration in an isolated complete candidate and preserves source execution modes', async () => {
    const candidate = await prepareManagedCommandPackageFiles({ sourceRoot, files: { 'config.json': '{"mode":"configured"}\n' }, entries: [entry] });
    try {
      expect(await fs.readJson(path.join(candidate.resourceRoot, 'config.json'))).toEqual({ mode: 'configured' });
      expect(await fs.readJson(path.join(sourceRoot, 'config.json'))).toEqual({ mode: 'source' });
      expect(await fs.readFile(path.join(candidate.resourceRoot, 'helper.mjs'), 'utf8')).toContain('value = 1');
      if (process.platform !== 'win32') expect((await fs.stat(path.join(candidate.resourceRoot, 'entry.mjs'))).mode & 0o111).toBe(0o111);
      expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    } finally { await candidate.cleanup(); }
    expect(await fs.pathExists(candidate.resourceRoot)).toBe(false);
  });

  // Protects the package source executable closure and AW-owned metadata from renderer overlays.
  it('rejects generated entry, executable companion, and protected file replacements', async () => {
    for (const relative of ['entry.mjs', 'helper.mjs', '.aw-command-producer.json', '.aw-runtime-config.json', 'evals/result.json']) {
      await expect(prepareManagedCommandPackageFiles({ sourceRoot, files: { [relative]: '{}' }, entries: [entry] })).rejects.toMatchObject({ code: 'commandResourceInvalid' });
    }
    expect(await fs.readFile(path.join(sourceRoot, 'helper.mjs'), 'utf8')).toBe('export const value = 1;\n');
    await fs.remove(path.join(sourceRoot, 'helper.mjs'));
    await expect(prepareManagedCommandPackageFiles({ sourceRoot, files: {}, entries: [entry] })).rejects.toThrow();
  });

  // Protects context and package preparation from realpath hiding a source-directory symbolic link.
  it('rejects symbolic links at each command source path segment', async () => {
    const bundleRoot = path.dirname(sourceRoot);
    expect(await resolveCommandSourceDirectory({ bundleRoot, pluginRelativePath: './tools' })).toBe(sourceRoot);
    await fs.symlink(sourceRoot, path.join(bundleRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveCommandSourceDirectory({ bundleRoot, pluginRelativePath: './linked' })).rejects.toThrow('commandResourceInvalid');
    await expect(resolveCommandSourceDirectory({ bundleRoot, pluginRelativePath: '../tools' })).rejects.toThrow('commandResourceInvalid');
  });
});
