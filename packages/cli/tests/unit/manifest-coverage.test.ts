import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBundleSourceManifest,
  createMarketplaceManifest,
  createMarketplaceManifestEntry,
  createPlatformManifestBase,
  discoverPlugins,
  discoverPluginsInDirectory,
  resolvePlugins,
  resolvePluginsFromCatalog,
  validateMarketplaceSourceMeta,
  validatePluginManifest,
} from '../../src/utils/manifest.js';
import type { PluginMeta } from '../../src/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-coverage-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

function createPluginMeta(manifest: PluginMeta['manifest']): PluginMeta {
  return {
    rootDir: '/tmp/plugin',
    manifestPath: '/tmp/plugin/.agents-plugin/plugin.json',
    manifest,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('manifest coverage', () => {
  it('normalizes full plugin manifests with native assets, overrides, and per-platform agent overrides', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      name: 'demo',
      version: '1.2.3',
      description: 'demo plugin',
      skills: './skills',
      slashCommands: './slash-commands',
      skillTriggers: {
        commit: {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      },
      mcpServers: './.mcp.json',
      apps: './.app.json',
      marketplace: {
        category: 'workflow',
        tags: [' git ', 'git', 'commit'],
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: [' CODEX ', 'CLAUDE', 'CODEX'],
        },
      },
      interface: {
        displayName: 'Demo Plugin',
        shortDescription: 'Covers manifest branches',
        capabilities: ['Skills', 'Hooks'],
      },
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
            target: {
              scope: 'user',
            },
            inheritInstallOptions: true,
            when: {
              platforms: ['codex'],
            },
          },
          {
            name: 'shared-helper',
            when: {
              platforms: ['claude'],
            },
          },
        ],
      },
      extensions: {
        instructions: [
          {
            name: 'instruction',
            title: 'Instruction',
            content: 'Keep things tidy.',
            paths: ['src/**'],
            agentOverrides: {
              claude: null,
              codex: {
                name: 'instruction-codex',
                title: 'Instruction Codex',
                content: 'Codex variant',
                paths: ['docs/**'],
              },
            },
          },
        ],
        permissions: [
          {
            name: 'permission',
            deny: ['git push'],
            agentOverrides: {
              claude: {
                name: 'permission-claude',
                allow: ['git status'],
                ask: ['git commit'],
                deny: ['git push'],
              },
            },
          },
        ],
        hooks: [
          {
            event: 'session_start',
            command: 'echo base hook',
            agentOverrides: {
              codex: {
                event: 'before_tool',
                matcher: 'Bash',
                command: 'echo codex hook',
              },
            },
          },
        ],
        agents: [
          {
            name: 'reviewer',
            description: 'Reviews commands',
            prompt: 'Review the current action.',
            agentOverrides: {
              claude: {
                name: 'reviewer-claude',
                description: 'Claude reviewer',
                prompt: 'Claude-specific prompt.',
                tools: ['shell'],
              },
            },
          },
        ],
      },
      buildConfig: {
        templates: {
          vars: {
            use_cli: {
              claude: true,
              codex: 'enabled',
            },
          },
          include: ['skills/**/*.md'],
        },
        fileRules: {
          claude: {
            include: ['skills/**'],
            exclude: [],
          },
          codex: {
            include: ['skills/**'],
            exclude: ['output-styles/**'],
          },
        },
        manifestOverrides: {
          claude: {
            outputStyles: './output-styles',
            lspServers: {
              name: 'inline-lsp',
            },
            userConfig: {
              theme: 'light',
            },
            channels: [
              {
                name: 'stable',
              },
            ],
          },
          codex: {},
        },
      },
    });

    expect(manifest).toMatchObject({
      skills: './skills',
      slashCommands: './slash-commands',
      skillTriggers: {
        commit: {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      },
      mcpServers: './.mcp.json',
      apps: './.app.json',
      marketplace: {
        tags: ['git', 'commit'],
        policy: {
          products: ['CODEX', 'CLAUDE'],
        },
      },
      interface: {
        displayName: 'Demo Plugin',
        shortDescription: 'Covers manifest branches',
        capabilities: ['Skills', 'Hooks'],
      },
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
            target: {
              scope: 'user',
            },
            inheritInstallOptions: true,
            when: {
              platforms: ['codex'],
            },
          },
          {
            name: 'shared-helper',
            when: {
              platforms: ['claude'],
            },
          },
        ],
      },
      buildConfig: {
        templates: {
          vars: {
            use_cli: {
              claude: true,
              codex: 'enabled',
            },
          },
        },
        fileRules: {
          codex: {
            exclude: ['output-styles/**'],
          },
        },
        manifestOverrides: {
          claude: {
            outputStyles: './output-styles',
            lspServers: {
              name: 'inline-lsp',
            },
            userConfig: {
              theme: 'light',
            },
            channels: [
              {
                name: 'stable',
              },
            ],
          },
          codex: {},
        },
      },
    });

    expect(manifest.extensions?.instructions?.[0].agentOverrides).toEqual({
      claude: null,
      codex: {
        name: 'instruction-codex',
        title: 'Instruction Codex',
        content: 'Codex variant',
        paths: ['docs/**'],
      },
    });
    expect(manifest.extensions?.permissions?.[0]).toMatchObject({
      deny: ['git push'],
      agentOverrides: {
        claude: {
          name: 'permission-claude',
          allow: ['git status'],
          ask: ['git commit'],
          deny: ['git push'],
        },
      },
    });
    expect(manifest.extensions?.hooks?.[0]).toMatchObject({
      matcher: undefined,
      agentOverrides: {
        codex: {
          event: 'before_tool',
          matcher: 'Bash',
          command: 'echo codex hook',
        },
      },
    });
    expect(manifest.extensions?.agents?.[0]).toMatchObject({
      tools: undefined,
      agentOverrides: {
        claude: {
          name: 'reviewer-claude',
          description: 'Claude reviewer',
          prompt: 'Claude-specific prompt.',
          tools: ['shell'],
        },
      },
    });
  });

  it('accepts object-based channels and rejects plugin paths that escape the root', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      name: 'demo-object-channels',
      version: '0.1.0',
      description: 'demo',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      buildConfig: {
        manifestOverrides: {
          claude: {
            lspServers: './config/lsp.json',
            channels: {
              default: true,
            },
          },
        },
      },
    });

    expect(manifest.buildConfig?.manifestOverrides?.claude).toMatchObject({
      lspServers: './config/lsp.json',
      channels: {
        default: true,
      },
    });

    expect(() =>
      validatePluginManifest('/tmp/plugin', {
        name: 'bad-demo',
        version: '0.1.0',
        description: 'demo',
        skills: './../skills',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      }),
    ).toThrow('path must stay inside the plugin root');

    expect(() =>
      validatePluginManifest('/tmp/plugin', {
        name: 'bad-demo-abs',
        version: '0.1.0',
        description: 'demo',
        apps: '/tmp/apps.json',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      }),
    ).toThrow('absolute paths are not allowed');
  });

  it('discovers, resolves, and selects plugins from repo and catalog directories', async () => {
    const repoRoot = await makeTempRepo();
    const alphaRoot = path.join(repoRoot, 'plugins', 'alpha-note');
    await fs.ensureDir(path.join(alphaRoot, '.agents-plugin'));
    await fs.writeJson(
      path.join(alphaRoot, '.agents-plugin', 'plugin.json'),
      {
        name: 'alpha-note',
        version: '0.1.0',
        description: 'alpha plugin',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      },
      { spaces: 2 },
    );
    await fs.ensureDir(path.join(repoRoot, 'plugins', 'ignored-dir'));

    await expect(
      discoverPluginsInDirectory(path.join(repoRoot, 'missing')),
    ).resolves.toEqual([]);

    await expect(discoverPluginsInDirectory(path.join(repoRoot, 'plugins'))).resolves.toMatchObject([
      {
        manifest: {
          name: 'alpha-note',
        },
      },
      {
        manifest: {
          name: 'git-commit',
        },
      },
    ]);

    await expect(discoverPlugins(repoRoot)).resolves.toMatchObject([
      {
        manifest: {
          name: 'alpha-note',
        },
      },
      {
        manifest: {
          name: 'git-commit',
        },
      },
    ]);

    await expect(resolvePlugins(repoRoot, ['git-commit', 'alpha-note'])).resolves.toMatchObject([
      {
        manifest: {
          name: 'git-commit',
        },
      },
      {
        manifest: {
          name: 'alpha-note',
        },
      },
    ]);

    await expect(resolvePluginsFromCatalog(repoRoot, ['missing-plugin'])).rejects.toThrow(
      'Unknown plugin "missing-plugin".',
    );
  });

  it('creates marketplace and bundle manifests without mutating the source plugin', () => {
    const sourceMeta = validateMarketplaceSourceMeta({
      owner: {
        name: 'Example Maintainer',
        url: 'https://example.com/aw',
      },
      interface: {
        displayName: 'Example Marketplace',
      },
    });
    const plugin = createPluginMeta(
      validatePluginManifest('/tmp/plugin', {
        name: 'bundle-demo',
        version: '0.3.0',
        description: 'bundle demo',
        skills: './skills',
        skillTriggers: {
          review: {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        },
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
        interface: {
          displayName: 'Bundle Demo',
        },
        dependencies: {
          plugins: [
            {
              name: 'shared-helper',
            },
          ],
        },
        extensions: {
          instructions: [
            {
              name: 'keep-clean',
              title: 'Keep Clean',
              content: 'Keep the workspace tidy.',
            },
          ],
          nativeHooks: {
            claude: [
              {
                event: 'Notification',
                matcher: '*',
                command: 'echo notify',
              },
            ],
            codex: [
              {
                event: 'UserPromptSubmit',
                command: 'echo prompt',
              },
            ],
          },
        },
      }),
    );

    const entry = createMarketplaceManifestEntry(plugin);
    const manifest = createMarketplaceManifest(sourceMeta, [plugin]);
    const bundleSource = createBundleSourceManifest(plugin);
    const noExtensionsBundle = createBundleSourceManifest(
      createPluginMeta(
        validatePluginManifest('/tmp/plugin', {
          name: 'bundle-no-ext',
          version: '0.1.0',
          description: 'no extensions',
          marketplace: {
            category: 'workflow',
            strict: true,
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
          },
        }),
      ),
    );

    bundleSource.extensions?.instructions?.push({
      name: 'extra',
      title: 'Extra',
      content: 'Added only in clone.',
    });
    if (bundleSource.extensions?.nativeHooks?.claude?.[0]) {
      bundleSource.extensions.nativeHooks.claude[0].command = 'echo mutated notify';
    }
    bundleSource.extensions?.nativeHooks?.codex?.push({
      event: 'Stop',
      command: 'echo stop',
    });
    if (bundleSource.skillTriggers?.review) {
      bundleSource.skillTriggers.review.allowDynamicTrigger = false;
    }
    if (bundleSource.dependencies?.plugins[0]) {
      bundleSource.dependencies.plugins[0].name = 'mutated-helper';
    }

    expect(entry).toMatchObject({
      name: 'bundle-demo',
      source: './plugins/bundle-demo',
      interface: {
        displayName: 'Bundle Demo',
      },
    });
    expect(manifest).toMatchObject({
      name: 'aw',
      owner: {
        name: 'Example Maintainer',
      },
      interface: {
        displayName: 'Example Marketplace',
      },
      plugins: [entry],
    });
    expect(plugin.manifest.extensions?.instructions).toHaveLength(1);
    expect(bundleSource.extensions?.instructions).toHaveLength(2);
    expect(plugin.manifest.extensions?.nativeHooks).toEqual({
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo notify',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo prompt',
        },
      ],
    });
    expect(bundleSource.extensions?.nativeHooks).toEqual({
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo mutated notify',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo prompt',
        },
        {
          event: 'Stop',
          command: 'echo stop',
        },
      ],
    });
    expect(plugin.manifest.skillTriggers).toEqual({
      review: {
        defaultTrigger: 'auto',
        allowDynamicTrigger: true,
      },
    });
    expect(plugin.manifest.dependencies).toEqual({
      plugins: [
        {
          name: 'shared-helper',
        },
      ],
    });
    expect(bundleSource.dependencies).toEqual({
      plugins: [
        {
          name: 'mutated-helper',
        },
      ],
    });
    expect(bundleSource.skillTriggers).toEqual({
      review: {
        defaultTrigger: 'auto',
        allowDynamicTrigger: false,
      },
    });
    expect(noExtensionsBundle.extensions).toBeUndefined();
    expect(createPlatformManifestBase(plugin)).toMatchObject({
      name: 'bundle-demo',
      version: '0.3.0',
      description: 'bundle demo',
      interface: {
        displayName: 'Bundle Demo',
      },
    });
    expect(createPlatformManifestBase(plugin)).not.toHaveProperty('dependencies');
  });

  it('preserves nativeHooks through the embedded bundle catalog', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions ??= {};
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    const [plugin] = await resolvePluginsFromCatalog(embeddedRoot, ['git-commit']);

    expect(plugin.manifest.extensions?.nativeHooks).toEqual({
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    });
    await expect(
      fs.readJson(path.join(embeddedRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'Notification',
              matcher: '*',
              command: 'echo claude notification',
            },
          ],
          codex: [
            {
              event: 'UserPromptSubmit',
              command: 'echo codex prompt',
            },
          ],
        },
      },
    });
  });
});
