import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bundleLocalPlugin,
  type PluginStagingRunner,
} from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
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
    name: options.name,
    version: '0.1.0',
    description: options.name,
    compatibility: { aw: { minVersion: options.distributions ? '0.1.0' : '0.0.0' } },
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

  it('copies portable runtime projections and artifact imports into the consumer bundle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-runtime-projection-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'portable-provider',
      buildConfig: { runtimeExports: [{ name: 'registry', source: './registry.json' }] },
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
    }]);
    const bundleManifest = await fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'));
    const resolvedImport = bundleManifest.artifacts.targets[0].runtimeImports[0].resolved;
    expect(resolvedImport).toMatchObject({
      providerPluginId: 'portable-provider',
      source: './registry.json',
    });
    await expect(fs.readFile(path.join(outputRoot, resolvedImport.path), 'utf8'))
      .resolves.toBe('{"portable":true}\n');
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

  it('exposes only the self-contained Eval corpus digest through its reserved provider', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-virtual-projection-'));
    tempRoots.push(root);
    const consumer = await createPlugin({ root, name: 'consumer' });
    const resolver = createCatalogRuntimeImportResolver([consumer]);
    const resolution = await resolver.resolve({
      consumer,
      reference: { plugin: '@aw/agent-skill-eval', export: 'case-corpus-digest' },
      purpose: 'build',
    });
    expect(resolution).toMatchObject({
      provider: '@aw/agent-skill-eval',
      name: 'case-corpus-digest',
      source: './dist/corpus-digest.js',
      virtual: true,
    });
    await expect(fs.readFile(resolution.sourcePath, 'utf8')).resolves.toContain('computeCaseCorpusDigest');
    await expect(resolver.resolve({
      consumer,
      reference: { plugin: '@aw/agent-skill-eval', export: 'case-corpus-digest' },
      purpose: 'skill-runtime-file',
    })).resolves.toMatchObject({ sourcePath: resolution.sourcePath });
    await expect(resolver.resolve({
      consumer,
      reference: { plugin: '@aw/agent-skill-eval', export: 'unknown' },
      purpose: 'build',
    })).rejects.toThrow('unknown @aw/agent-skill-eval export');
    await expect(resolver.resolve({
      consumer,
      reference: { plugin: '@aw/agent-skill-eval', export: 'case-corpus-digest' },
      purpose: 'artifact-runtime',
    })).rejects.toThrow('only available to buildImports and skillRuntimeFiles');
  });

  it('injects read-only catalog build imports and projects own and provider bytes with provenance', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-projection-'));
    tempRoots.push(root);
    const provider = await createPlugin({
      root,
      name: 'provider',
      buildConfig: {
        runtimeExports: [{ name: 'registry', source: './registry.json' }],
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
          export: 'registry',
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
    expect(result.runtimeProjection.buildImports).toMatchObject([{ provider: 'provider', name: 'registry' }]);
    expect(result.runtimeProjection.skillRuntimeFiles).toHaveLength(4);
    for (const entry of result.runtimeProjection.skillRuntimeFiles) {
      expect(entry.targetDigest).toBe(entry.sourceDigest);
    }
    expect(JSON.stringify(result.runtimeProjection)).not.toContain(root);
    const runtimeManifest = await fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'));
    expect(runtimeManifest.buildConfig?.buildImports).toBeUndefined();
    expect(runtimeManifest.buildConfig?.skillRuntimeFiles).toBeUndefined();
    expect(runtimeManifest.buildConfig?.cacheable).toBeUndefined();

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

  it.each(['provider'] as const)(
    'rejects a %s build import that changes during a successful build and removes partial state',
    async (providerKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-build-import-toctou-'));
      tempRoots.push(root);
      const provider = await createPlugin({
        root,
        name: 'provider',
        buildConfig: {
          runtimeExports: [{ name: 'registry', source: './registry.json' }],
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
              runtimeExports: [{ name: 'registry', source: './registry.json' }],
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
      buildConfig: { runtimeExports: [{ name: 'registry', source: './registry.json' }] },
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
