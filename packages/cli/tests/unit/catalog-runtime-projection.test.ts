import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bundleLocalPlugin,
  type PluginStagingRunner,
} from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { createCatalogManifestV6Entry } from '../../src/utils/catalog-manifest-v6.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type { PluginMeta } from '../../src/types.js';

const tempRoots: string[] = [];

async function createPlugin(options: {
  root: string;
  name: string;
  products?: string[];
  buildConfig?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  distributions?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  omitNativeSkills?: boolean;
  files?: Record<string, string>;
}): Promise<PluginMeta> {
  const pluginRoot = path.join(options.root, options.name);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    schemaVersion: 2,
    name: options.name,
    version: '0.1.0',
    description: options.name,
    ...(!options.omitNativeSkills ? { skills: './skills' } : {}),
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        ...(options.products ? { products: options.products } : {}),
      },
    },
    ...(options.buildConfig ? { buildConfig: options.buildConfig } : {}),
    ...(options.scripts ? { scripts: options.scripts } : {}),
    ...(options.distributions ? { distributions: options.distributions } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  }, { spaces: 2 });
  if (!options.omitNativeSkills) {
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'agents', 'openai.yaml'), 'interface:\n  display_name: Demo\n');
  }
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    await fs.outputFile(path.join(pluginRoot, relativePath), content);
  }
  return readPluginManifest(pluginRoot);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});
describe('catalog runtime projection', () => {
  it('validates portable generated source and final closure without a native Skill root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-generated-runtime-'));
    tempRoots.push(root);
    const plugin = await createPlugin({
      root,
      name: 'portable-generated-runtime',
      omitNativeSkills: true,
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/generated.md',
          distributions: ['agent-skills'],
        }],
      },
      scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
      files: {
        'build.mjs': 'export {};\n',
        'portable-skills/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\n[generated](references/generated.md)\n',
        'portable-skills/demo/README.md': '# Demo\n',
      },
    });
    const runner: PluginStagingRunner = {
      async installPackageRoot() {},
      async runNodeBuild({ pluginRoot }) {
        await fs.outputFile(
          path.join(pluginRoot, 'portable-skills', 'demo', 'references', 'generated.md'),
          '[nested](nested.md)\n',
        );
      },
    };

    await expect(bundleLocalPlugin(plugin, path.join(root, 'portable-final'), {
      buildMode: 'staging',
      stagingRunner: runner,
    })).rejects.toThrow('markdown-link target "nested.md"');
  });

  it('requires every declared generated Skill file in the final bundle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-generated-skill-runtime-'));
    tempRoots.push(root);
    const plugin = await createPlugin({
      root,
      name: 'generated-runtime',
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/generated.md',
        }],
      },
      scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
      files: {
        'build.mjs': 'export {};\n',
        'skills/demo/SKILL.md': '---\nname: demo\ndescription: demo\n---\n[generated](references/generated.md)\n',
      },
    });
    const noOutputRunner: PluginStagingRunner = {
      async installPackageRoot() {},
      async runNodeBuild() {},
    };

    await expect(bundleLocalPlugin(plugin, path.join(root, 'missing-output'), {
      buildMode: 'staging',
      stagingRunner: noOutputRunner,
    })).rejects.toThrow('build did not create regular final target');

    const outputRunner: PluginStagingRunner = {
      async installPackageRoot() {},
      async runNodeBuild({ pluginRoot }) {
        await fs.outputFile(
          path.join(pluginRoot, 'skills', 'demo', 'references', 'generated.md'),
          '[nested](nested.md)\n',
        );
      },
    };
    await expect(bundleLocalPlugin(plugin, path.join(root, 'nested-missing'), {
      buildMode: 'staging',
      stagingRunner: outputRunner,
    })).rejects.toThrow('markdown-link target "nested.md"');
  });

  it('propagates used Skill runtime export capabilities to the bundle, Catalog entry, and every Skill receipt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-runtime-projection-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'portable-provider',
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './registry.json',
        requires: { aw: { capabilities: ['aw.review-publication.v1'] } },
      }] },
      files: { 'registry.json': '{"portable":true}\n' },
    });
    const consumer = await createPlugin({
      root,
      name: 'portable-consumer',
      distributions: { agentSkills: { skills: './portable-skills' } },
      artifacts: {
        targets: [{
          id: 'dynamic-portable',
          distribution: 'agent-skills',
          target: 'agent-skills.skill',
          scopes: ['user'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'dynamic-portable',
          runtimeImports: [{ name: 'registry', plugin: 'portable-provider', export: 'registry' }],
        }],
      },
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/registry.json',
          distributions: ['agent-skills'],
          import: { plugin: 'portable-provider', export: 'registry' },
        }],
      },
      files: {
        'portable-skills/demo/SKILL.md': '---\nname: demo\ndescription: portable demo\n---\n',
        'portable-skills/demo/README.md': '# Portable demo\n',
      },
    });
    const outputRoot = path.join(root, 'portable-bundle');
    const result = await bundleLocalPlugin(consumer, outputRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });

    await expect(fs.readFile(
      path.join(outputRoot, 'agent-skills', 'skills', 'demo', 'references', 'registry.json'),
      'utf8',
    )).resolves.toBe('{"portable":true}\n');
    expect(result.runtimeProjection.skillRuntimeFiles).toMatchObject([{
      distribution: 'agent-skills',
      provider: 'portable-provider',
      requiredCapabilities: ['aw.review-publication.v1'],
      capabilitySetDigest: expect.stringMatching(/^sha256:/u),
    }]);
    const bundleManifest = await fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'));
    expect(consumer.manifest.requires?.aw.capabilities ?? []).not.toContain('aw.review-publication.v1');
    expect(bundleManifest.requires.aw.capabilities).toContain('aw.review-publication.v1');
    const resolvedImport = bundleManifest.artifacts.targets[0].runtimeImports[0].resolved;
    expect(resolvedImport).toMatchObject({
      providerPluginId: 'portable-provider',
      source: './registry.json',
      requiredCapabilities: ['aw.review-publication.v1'],
      capabilitySetDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(fs.readFile(path.join(outputRoot, resolvedImport.path), 'utf8'))
      .resolves.toBe('{"portable":true}\n');
    const bundledPlugin = await readPluginManifest(outputRoot, { mode: 'bundle' });
    await expect(createCatalogManifestV6Entry(bundledPlugin, outputRoot))
      .resolves.toMatchObject({
        requires: { aw: { capabilities: expect.arrayContaining(['aw.review-publication.v1']) } },
      });
    for (const receiptPath of [
      'claude/skills/demo/aw-plugin-requirements.json',
      'codex/skills/demo/aw-plugin-requirements.json',
      'agent-skills/skills/demo/aw-plugin-requirements.json',
    ]) {
      await expect(fs.readJson(path.join(outputRoot, receiptPath))).resolves.toMatchObject({
        requiredCapabilities: expect.arrayContaining(['aw.review-publication.v1']),
      });
    }
  });

  it('propagates artifact runtime import capabilities without a Skill runtime import', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-artifact-runtime-capability-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'artifact-provider',
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './registry.json',
        requires: { aw: { capabilities: ['aw.review-publication.v1'] } },
      }] },
      files: { 'registry.json': '{}\n' },
    });
    const consumer = await createPlugin({
      root,
      name: 'artifact-consumer',
      distributions: { agentSkills: {} },
      artifacts: {
        targets: [{
          id: 'dynamic',
          distribution: 'agent-skills',
          target: 'agent-skills.skill',
          scopes: ['user'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'dynamic',
          runtimeImports: [{ name: 'registry', plugin: 'artifact-provider', export: 'registry' }],
        }],
      },
    });
    const outputRoot = path.join(root, 'artifact-bundle');

    await bundleLocalPlugin(consumer, outputRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });

    const bundleManifest = await fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'));
    expect(bundleManifest.requires.aw.capabilities).toContain('aw.review-publication.v1');
    expect(bundleManifest.artifacts.targets[0].runtimeImports[0].resolved)
      .toMatchObject({ requiredCapabilities: ['aw.review-publication.v1'] });
  });

  it('rejects removed CLI virtual capability providers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-virtual-projection-'));
    tempRoots.push(root);
    await expect(createPlugin({
      root,
      name: 'consumer',
      buildConfig: {
        buildImports: [{
          plugin: '@aw/cli',
          export: 'skill-frontmatter-capabilities',
          env: 'AW_PLUGIN_IMPORT_FRONTMATTER',
        }],
      },
      scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
      files: { 'build.mjs': 'export {};\n' },
    })).rejects.toThrow('unknown reserved provider "@aw/cli"');
  });

  it('rejects the removed Eval virtual runtime provider', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-virtual-projection-'));
    tempRoots.push(root);
    const consumer = await createPlugin({ root, name: 'consumer' });
    const resolver = createCatalogRuntimeImportResolver([consumer]);

    await expect(resolver.resolve({
      consumer,
      reference: { plugin: '@aw/agent-skill-eval', export: 'case-corpus-digest' },
      purpose: 'build',
    })).rejects.toThrow('unknown reserved provider "@aw/agent-skill-eval"');
  });

  it('injects read-only catalog build imports and projects own and provider bytes with provenance', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-projection-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'provider',
      buildConfig: {
        runtimeExports: [
          {
            name: 'registry', source: './registry.json',
            requires: { aw: { capabilities: [] } },
          },
          {
            name: 'build-input', source: './registry.json',
            requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
          },
        ],
      },
      files: { 'registry.json': '{"provider":1}\n' },
    });
    const consumer = await createPlugin({
      root,
      name: 'consumer',
      buildConfig: {
        cacheable: true,
        buildImports: [{
          plugin: 'provider',
          export: 'build-input',
          env: 'AW_PLUGIN_IMPORT_REGISTRY',
        }],
        skillRuntimeFiles: [
          { skill: 'demo', target: 'references/provider.json', import: { plugin: 'provider', export: 'registry' } },
          { skill: 'demo', target: 'assets/generated.txt', source: './generated.txt' },
        ],
      },
      scripts: {
        node: { build: { runner: 'node', path: './build.mjs' } },
      },
      files: { 'build.mjs': 'export {};\n' },
    });
    let receivedImportPath = '';
    const runner: PluginStagingRunner = {
      async installPackageRoot() {},
      async runNodeBuild({ pluginRoot, env }) {
        receivedImportPath = env.AW_PLUGIN_IMPORT_REGISTRY ?? '';
        expect(path.isAbsolute(receivedImportPath)).toBe(true);
        expect(await fs.readFile(receivedImportPath, 'utf8')).toMatch(/^\{"provider":\d\}\n$/u);
        expect((await fs.stat(receivedImportPath)).mode & 0o222).toBe(0);
        await fs.writeFile(path.join(pluginRoot, 'generated.txt'), 'generated\n');
      },
    };
    const outputRoot = path.join(root, 'bundle');
    const result = await bundleLocalPlugin(consumer, outputRoot, {
      buildMode: 'staging',
      stagingRunner: runner,
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });

    expect(receivedImportPath).not.toBe('');
    await expect(fs.readFile(path.join(outputRoot, 'codex', 'skills', 'demo', 'references', 'provider.json'), 'utf8'))
      .resolves.toBe('{"provider":1}\n');
    await expect(fs.readFile(path.join(outputRoot, 'claude', 'skills', 'demo', 'references', 'provider.json'), 'utf8'))
      .resolves.toBe('{"provider":1}\n');
    await expect(fs.readFile(path.join(outputRoot, 'codex', 'skills', 'demo', 'assets', 'generated.txt'), 'utf8'))
      .resolves.toBe('generated\n');
    await expect(fs.readFile(path.join(outputRoot, 'claude', 'skills', 'demo', 'assets', 'generated.txt'), 'utf8'))
      .resolves.toBe('generated\n');
    expect(result.runtimeProjection.buildImports).toMatchObject([{
      provider: 'provider',
      name: 'build-input',
      requiredCapabilities: ['aw.future-feature.v3'],
    }]);
    expect(result.runtimeProjection.skillRuntimeFiles).toHaveLength(4);
    for (const entry of result.runtimeProjection.skillRuntimeFiles) {
      expect(entry.targetDigest).toBe(entry.sourceDigest);
    }
    expect(JSON.stringify(result.runtimeProjection)).not.toContain(root);
    const runtimeManifest = await fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'));
    expect(runtimeManifest.buildConfig?.buildImports).toBeUndefined();
    expect(runtimeManifest.buildConfig?.skillRuntimeFiles).toBeUndefined();
    expect(runtimeManifest.buildConfig?.cacheable).toBeUndefined();
    expect(runtimeManifest.requires.aw.capabilities).not.toContain('aw.future-feature.v3');

    await fs.writeFile(path.join(provider.rootDir, 'registry.json'), '{"provider":2}\n');
    const changedResult = await bundleLocalPlugin(consumer, path.join(root, 'changed-bundle'), {
      buildMode: 'staging',
      stagingRunner: runner,
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });
    expect(changedResult.runtimeProjection.skillRuntimeFiles[0]?.sourceDigest)
      .not.toBe(result.runtimeProjection.skillRuntimeFiles[0]?.sourceDigest);
    await expect(fs.readFile(
      path.join(root, 'changed-bundle', 'codex', 'skills', 'demo', 'references', 'provider.json'),
      'utf8',
    )).resolves.toBe('{"provider":2}\n');
  });

  it('changes final requirements and Catalog identity when export metadata changes without byte changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-metadata-identity-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'metadata-provider',
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './registry.json',
        requires: { aw: { capabilities: [] } },
      }] },
      files: { 'registry.json': '{"stable":true}\n' },
    });
    const consumer = await createPlugin({
      root,
      name: 'metadata-consumer',
      buildConfig: { skillRuntimeFiles: [{
        skill: 'demo',
        target: 'references/registry.json',
        import: { plugin: 'metadata-provider', export: 'registry' },
      }] },
    });
    const firstRoot = path.join(root, 'first-bundle');
    const first = await bundleLocalPlugin(consumer, firstRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });
    const firstBundlePlugin = await readPluginManifest(firstRoot, { mode: 'bundle' });
    const firstEntry = await createCatalogManifestV6Entry(firstBundlePlugin, firstRoot);

    const providerManifestPath = path.join(provider.rootDir, '.agents-plugin', 'plugin.json');
    const providerManifest = await fs.readJson(providerManifestPath);
    providerManifest.buildConfig.runtimeExports[0].requires.aw.capabilities = [
      'aw.review-publication.v1',
    ];
    await fs.writeJson(providerManifestPath, providerManifest, { spaces: 2 });
    const changedProvider = await readPluginManifest(provider.rootDir);
    const secondRoot = path.join(root, 'second-bundle');
    const second = await bundleLocalPlugin(consumer, secondRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([changedProvider, consumer]),
    });
    const secondBundlePlugin = await readPluginManifest(secondRoot, { mode: 'bundle' });
    const secondEntry = await createCatalogManifestV6Entry(secondBundlePlugin, secondRoot);

    expect(second.runtimeProjection.skillRuntimeFiles[0]?.sourceDigest)
      .toBe(first.runtimeProjection.skillRuntimeFiles[0]?.sourceDigest);
    expect(second.runtimeProjection.skillRuntimeFiles[0]?.capabilitySetDigest)
      .not.toBe(first.runtimeProjection.skillRuntimeFiles[0]?.capabilitySetDigest);
    expect(firstBundlePlugin.manifest.requires?.aw.capabilities ?? [])
      .not.toContain('aw.review-publication.v1');
    expect(secondBundlePlugin.manifest.requires?.aw.capabilities ?? [])
      .toContain('aw.review-publication.v1');
    expect(secondEntry.manifestDigest).not.toBe(firstEntry.manifestDigest);
    expect(secondEntry.contentDigest).not.toBe(firstEntry.contentDigest);
  });

  it('blocks an unsupported propagated capability before completing a bundle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-unsupported-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'future-provider',
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './registry.json',
        requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
      }] },
      files: { 'registry.json': '{}\n' },
    });
    const consumer = await createPlugin({
      root,
      name: 'future-consumer',
      buildConfig: { skillRuntimeFiles: [{
        skill: 'demo',
        target: 'references/registry.json',
        import: { plugin: 'future-provider', export: 'registry' },
      }] },
    });
    const outputRoot = path.join(root, 'unsupported-bundle');

    await expect(bundleLocalPlugin(consumer, outputRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    })).rejects.toMatchObject({
      code: 'awCapabilityUnsupported',
      missingCapabilities: ['aw.future-feature.v3'],
    });
    await expect(fs.pathExists(outputRoot)).resolves.toBe(false);
  });

  it.each(['provider'] as const)(
    'rejects a %s build import that changes during a successful build and removes partial state',
    async (providerKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-build-import-toctou-'));
      tempRoots.push(root);
      const provider = await createPlugin({
        root,
        name: 'provider',
        buildConfig: {
          runtimeExports: [{
            name: 'registry', source: './registry.json',
            requires: { aw: { capabilities: [] } },
          }],
        },
        files: { 'registry.json': '{"version":"a"}\n' },
      });
      const canonicalSource = path.join(provider.rootDir, 'registry.json');
      const consumer = await createPlugin({
        root,
        name: 'consumer',
        buildConfig: {
          buildImports: [{
            plugin: providerKind,
            export: 'registry',
            env: 'AW_PLUGIN_IMPORT_REGISTRY',
          }],
        },
        scripts: { node: { build: { runner: 'node', path: './build.mjs' } } },
        files: { 'build.mjs': 'export {};\n' },
      });
      let stagingPluginRoot = '';
      const runner: PluginStagingRunner = {
        async installPackageRoot() {},
        async runNodeBuild({ pluginRoot, env }) {
          stagingPluginRoot = pluginRoot;
          await expect(fs.readFile(env.AW_PLUGIN_IMPORT_REGISTRY!, 'utf8'))
            .resolves.toBe('{"version":"a"}\n');
          await fs.writeFile(canonicalSource, '{"version":"b"}\n');
        },
      };
      const outputRoot = path.join(root, 'bundle');
      await fs.outputFile(path.join(outputRoot, 'stale.txt'), 'stale\n');

      await expect(bundleLocalPlugin(consumer, outputRoot, {
        buildMode: 'staging',
        stagingRunner: runner,
        runtimeResolver: createCatalogRuntimeImportResolver(
          [provider, consumer],
        ),
      })).rejects.toThrow('changed during build import projection');
      await expect(fs.pathExists(outputRoot)).resolves.toBe(false);
      await expect(fs.pathExists(stagingPluginRoot)).resolves.toBe(false);
    },
  );

  it.each(['provider import', 'own source'] as const)(
    'rejects a %s that changes between platform projections and removes the partial bundle',
    async (sourceKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-projection-toctou-'));
      tempRoots.push(root);
      const provider = sourceKind === 'provider import'
        ? await createPlugin({
            root,
            name: 'provider',
            buildConfig: {
              runtimeExports: [{
                name: 'registry', source: './registry.json',
                requires: { aw: { capabilities: [] } },
              }],
            },
            files: { 'registry.json': '{"version":"a"}\n' },
          })
        : undefined;
      const consumer = await createPlugin({
        root,
        name: 'consumer',
        buildConfig: {
          skillRuntimeFiles: [{
            skill: 'demo',
            target: 'references/registry.json',
            ...(provider
              ? { import: { plugin: 'provider', export: 'registry' } }
              : { source: './registry.json' }),
          }],
        },
        ...(!provider ? { files: { 'registry.json': '{"version":"a"}\n' } } : {}),
      });
      const canonicalSource = path.join(provider?.rootDir ?? consumer.rootDir, 'registry.json');
      const outputRoot = path.join(root, 'bundle');
      const firstProjectionTarget = path.join(
        outputRoot,
        'claude',
        'skills',
        'demo',
        'references',
        'registry.json',
      );
      const copyFile = fs.copyFile.bind(fs);
      vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
        await copyFile(...args);
        if (path.normalize(String(args[1])) === firstProjectionTarget) {
          await fs.writeFile(canonicalSource, '{"version":"b"}\n', 'utf8');
        }
      });

      await expect(bundleLocalPlugin(consumer, outputRoot, {
        ...(provider
          ? { runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]) }
          : {}),
      })).rejects.toThrow('changed during runtime Skill projection');
      await expect(fs.pathExists(outputRoot)).resolves.toBe(false);
    },
  );

  it('fails closed for missing resolver, target collisions, provider platform gaps, and symlink exports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-projection-fail-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'provider',
      products: ['CODEX'],
      buildConfig: { runtimeExports: [{
        name: 'registry', source: './registry.json',
        requires: { aw: { capabilities: [] } },
      }] },
      files: { 'registry.json': '{}\n' },
    });
    const consumer = await createPlugin({
      root,
      name: 'consumer',
      buildConfig: {
        skillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/registry.json',
          import: { plugin: 'provider', export: 'registry' },
        }],
      },
    });

    await expect(bundleLocalPlugin(consumer, path.join(root, 'no-resolver')))
      .rejects.toThrow('catalog runtime import resolver is required');
    await expect(bundleLocalPlugin(consumer, path.join(root, 'platform-gap'), {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    })).rejects.toThrow('unavailable for platform "claude"');

    await fs.outputFile(path.join(consumer.rootDir, 'skills', 'demo', 'references', 'registry.json'), 'existing\n');
    await expect(bundleLocalPlugin(consumer, path.join(root, 'collision'), {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    })).rejects.toThrow('staged Skill already contains');

    await fs.remove(path.join(consumer.rootDir, 'skills', 'demo', 'references'));
    await fs.ensureDir(path.join(root, 'outside-references'));
    await fs.symlink(
      path.join(root, 'outside-references'),
      path.join(consumer.rootDir, 'skills', 'demo', 'references'),
    );
    await expect(bundleLocalPlugin(consumer, path.join(root, 'target-symlink'), {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    })).rejects.toThrow();

    const linkProviderRoot = path.join(root, 'link-provider');
    await fs.copy(provider.rootDir, linkProviderRoot);
    await fs.remove(path.join(linkProviderRoot, 'registry.json'));
    await fs.symlink(path.join(provider.rootDir, 'registry.json'), path.join(linkProviderRoot, 'registry.json'));
    await expect(readPluginManifest(linkProviderRoot)).rejects.toThrow('symbolic links are not supported');
  });
});
