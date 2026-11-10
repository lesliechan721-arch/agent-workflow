import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { resolveCommandSourceDirectory } from '../../src/utils/artifact-sources.js';
import { discoverInstalledPluginManagedCommandPackages, managedCommandProducerIdentity, prepareManagedCommandPackage, prepareManagedCommandPackageFiles,
  syncPluginManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { listManagedCommands, syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { createDefaultPluginProcessRunner, defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';
import { terminateProcessTree } from '../../src/utils/process-tree.js';
import { waitForProcessExit } from '../support/process-tree.js';
import { prepareAgentCommandSets, resolveManagedCommandSkillProducers } from '../../src/utils/managed-command-preparation.js';

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
      schemaVersion: 4, name: 'package-lifecycle', version: '1.0.0', description: 'Package lifecycle fixture.',
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

  // Shared activation must retain one physical identity, while different physical placements get distinct IDs.
  it('gives static native Skills one shared user identity across both platforms and project activations', async () => {
    const pluginRoot = path.dirname(sourceRoot);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', 'SKILL.md'), '---\nname: provider\ndescription: Shared static fixture.\n---\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name: 'static-identity', version: '1.0.0', description: 'Static identity fixture.', skills: './skills',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    });
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    for (const platform of ['codex', 'claude'] as const) {
      const identities = await Promise.all((['user', 'project', 'project'] as const).map((scope, index) => managedCommandProducerIdentity({
        plugin, producer: { kind: 'static-skill', platform, skillKey: 'provider' }, scope,
        renderUnit: { physicalKey: `sha256:${'a'.repeat(64)}`, renderScope: { kind: 'user' } },
        cwd: path.join(isolated.layout.fixtureCwd, `project-${index}`),
      })));
      expect(identities[0]).toMatchObject({ kind: 'static-skill', platform, scope: 'user', projectRoot: null, placementKey: `sha256:${'a'.repeat(64)}` });
      expect(identities).toEqual([identities[0], identities[0], identities[0]]);
      await expect(managedCommandProducerIdentity({ plugin, producer: { kind: 'static-skill', platform, skillKey: 'provider' }, scope: 'user', cwd: isolated.layout.fixtureCwd })).rejects.toThrow('verified render unit');
    }
  });

  // Test Value Gate: a static Skill can request its dynamic command set without a platform-component renderer request or sensitive config input.
  it('renders one agent command request from the complete candidate Skill and only the set config keys', async () => {
    const pluginRoot = path.dirname(sourceRoot);
    const resourceRoot = path.join(pluginRoot, 'skills/provider');
    const capturedPath = path.join(pluginRoot, 'captured-command-context.json');
    await fs.outputFile(path.join(resourceRoot, 'SKILL.md'), '---\nname: provider\ndescription: Static command producer.\n---\n');
    await fs.outputFile(path.join(resourceRoot, 'run.mjs'), 'process.exitCode = 0;\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), {
      schemaVersion: 4, name: 'agent-command-render', version: '1.0.0', description: 'Agent command renderer fixture.', skills: './skills',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'one' }, unrelated: { type: 'string', default: 'hidden' }, secret: { type: 'string', sensitive: true } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: { sets: [{ set: 'tools', mode: 'dynamic', refreshKeys: ['mode'], producer: { kind: 'static-skill', platform: 'codex', skillKey: 'provider' } }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `fs.writeFileSync(${JSON.stringify(capturedPath)}, JSON.stringify({ context, surface: process.env.AW_PLUGIN_SURFACE, platform: process.env.AW_PLUGIN_PLATFORM }));`,
      'console.log(JSON.stringify({version:2,artifacts:[{id:"command-set.tools",target:"aw.command-set",kind:"commandSet",platform:"codex",state:"present",refreshKeys:["mode"],entries:[{key:"run",runner:"node",entry:"run.mjs"}]}]}));',
    ].join('\n'));
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    const physicalKey = `sha256:${'b'.repeat(64)}`;
    const [resolved] = await resolveManagedCommandSkillProducers({ plugin, platform: 'codex', renderUnit: { physicalKey, renderScope: { kind: 'user' } },
      components: { components: [{ id: 'skill:provider', kind: 'skill', name: 'provider', content: { files: { 'SKILL.md': { text: '# Provider' } } } }], omitted: [], unmet: [], sources: { 'skill:provider': 'static' } },
      skillResources: [{ componentId: 'skill:provider', resourceRoot, physicalKey }], cwd: isolated.layout.fixtureCwd });
    if (resolved?.state !== 'ready') throw new Error('Missing static candidate.');
    const candidate = await prepareAgentCommandSets({ plugin, resolved, cwd: isolated.layout.fixtureCwd, env: isolated.env, changedConfigKeys: ['mode', 'secret', 'unrelated'] });
    expect(candidate.sets).toMatchObject([{ set: 'tools', state: 'present', entries: [{ key: 'run', variant: 'default', entry: 'run.mjs' }] }]);
    const captured = await fs.readJson(capturedPath);
    expect(captured).toMatchObject({ surface: 'agent-commands', platform: 'codex', context: { schemaVersion: 1, surface: 'agent-commands', scope: 'user', requestedArtifactIds: ['command-set.tools'], changedConfigKeys: ['mode'], producers: [{ componentId: 'skill:provider', resourceRoot }] } });
    expect(Object.keys(captured.context.config.schema.fields)).toEqual(['mode']);
    expect(captured.context.config.values).toEqual({ mode: 'one' });
    expect(await fs.pathExists(path.join(resourceRoot, '.aw-command-producer.json'))).toBe(false);
    await expect(prepareAgentCommandSets({ plugin, resolved, cwd: isolated.layout.fixtureCwd, env: isolated.env,
      previousProducer: { record: { schemaVersion: 1, producer: { ...candidate.producer, placementKey: `sha256:${'c'.repeat(64)}` }, sets: candidate.sets }, artifacts: candidate.artifacts } })).rejects.toMatchObject({ code: 'commandIdentityConflict' });
  });

  // Test Value Gate: a retained project package must not block user config apply outside a repository.
  it('discovers user packages outside a repository without including retained or declared project packages', async () => {
    const pluginRoot = path.dirname(sourceRoot);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name: 'discovery-scope', version: '1.0.0', description: 'Package scope fixture.',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      managedCommands: { packages: [
        { key: 'user-tools', scope: 'user', platforms: ['codex'], sourceDir: './tools' },
        { key: 'project-tools', scope: 'project', platforms: ['codex'], sourceDir: './tools' },
      ] },
    });
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    await syncManagedCommandPackage({
      producer: { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name,
        kind: 'package', key: 'project-tools', platform: null, placementKey: null, scope: 'project', projectRoot: isolated.layout.fixtureCwd },
      sourceDirectory: sourceRoot, sets: [], env: isolated.env,
    });
    const outside = path.join(isolated.layout.rootDir, 'outside');
    await fs.ensureDir(outside);
    const discovered = await discoverInstalledPluginManagedCommandPackages({
      plugin, scope: 'user', cwd: outside, env: isolated.env,
      platformTargets: [{ platform: 'codex', scope: 'user' }],
    });
    expect(discovered.errors).toEqual([]);
    expect(discovered.packages.map((entry) => entry.packageKey)).toEqual(['user-tools']);
    expect(discovered.packages[0]!.producer).toMatchObject({ scope: 'user', platform: null, projectRoot: null });
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
