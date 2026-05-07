import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginStagingRunner } from '../../src/generators/local-plugin.js';
import { validateBundleLayout } from '../../src/utils/bundle-layout.js';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-bundle-layout-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

async function readFixturePluginManifest(repoRoot: string): Promise<Record<string, unknown>> {
  return fs.readJson(
    path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
  );
}

async function writeFixturePluginManifest(
  repoRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await fs.writeJson(
    path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
    manifest,
    { spaces: 2 },
  );
}

async function replaceFileWithSymlink(linkPath: string, targetPath: string): Promise<void> {
  await fs.remove(linkPath);
  await fs.symlink(path.relative(path.dirname(linkPath), targetPath), linkPath, 'file');
}

async function updateFixturePluginManifest(
  repoRoot: string,
  updater: (manifest: Record<string, any>) => void,
): Promise<void> {
  const manifest = await readFixturePluginManifest(repoRoot);
  updater(manifest);
  await writeFixturePluginManifest(repoRoot, manifest);
}

async function createEmbeddedRootFromFixture(
  updater?: (manifest: Record<string, any>) => void,
): Promise<{ repoRoot: string; embeddedRoot: string }> {
  const repoRoot = await makeTempRepo();
  if (updater) {
    await updateFixturePluginManifest(repoRoot, updater);
  }
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  return { repoRoot, embeddedRoot };
}

async function createClaudeOnlyEmbeddedRoot(): Promise<{ repoRoot: string; embeddedRoot: string }> {
  const repoRoot = await makeTempRepo();
  await updateFixturePluginManifest(repoRoot, (manifest) => {
    manifest.marketplace.policy.products = ['CLAUDE'];
    delete manifest.apps;
  });
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  return { repoRoot, embeddedRoot };
}

function createFakeStagingRunner(): PluginStagingRunner {
  return {
    async installPackageRoot(packageRoot) {
      const packageJson = await fs.readJson(path.join(packageRoot, 'package.json'));
      const dependencies = packageJson.dependencies ?? {};
      await fs.ensureDir(path.join(packageRoot, 'node_modules'));
      for (const dependencyName of Object.keys(dependencies)) {
        const dependencyRoot = path.join(packageRoot, 'node_modules', ...dependencyName.split('/'));
        await fs.ensureDir(dependencyRoot);
        await fs.writeJson(
          path.join(dependencyRoot, 'package.json'),
          {
            name: dependencyName,
            version: '1.0.0',
            main: 'index.js',
          },
          { spaces: 2 },
        );
        await fs.writeFile(path.join(dependencyRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
      }
    },
    async runNodeBuild() {},
  };
}

async function writeRuntimeScriptFixture(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  const manifest = await readFixturePluginManifest(repoRoot);
  await fs.ensureDir(path.join(pluginRoot, 'scripts'));
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import "./shared.mjs";\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'aw-config.mjs'), 'import "./shared.mjs";\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'shared.mjs'), 'export const ok = true;\n', 'utf8');
  manifest.scripts = {
    lifecycle: {
      install: './scripts/lifecycle.mjs',
    },
    helpers: {
      config: './scripts/aw-config.mjs',
    },
  };
  await writeFixturePluginManifest(repoRoot, manifest);
}

async function writePackageRuntimeFixture(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  const manifest = await readFixturePluginManifest(repoRoot);
  await fs.ensureDir(path.join(pluginRoot, 'scripts'));
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import chalk from "chalk";\n', 'utf8');
  await fs.writeJson(
    path.join(pluginRoot, 'scripts', 'package.json'),
    {
      name: 'git-commit-scripts',
      version: '0.1.0',
      type: 'module',
      dependencies: {
        chalk: '^5.0.0',
      },
    },
    { spaces: 2 },
  );
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
  manifest.scripts = {
    lifecycle: {
      install: './scripts/lifecycle.mjs',
    },
    node: {
      packageRoot: './scripts',
    },
  };
  await writeFixturePluginManifest(repoRoot, manifest);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('bundle layout validation', () => {
  it('accepts platform-filtered marketplaces that match supported plugin sets', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture((manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
    });

    await expect(
      fs.pathExists(path.join(embeddedRoot, 'plugins', 'git-commit', '.claude-plugin')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(embeddedRoot, 'plugins', 'git-commit', 'claude')),
    ).resolves.toBe(false);
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('rejects plugin directories that are missing .agents-plugin/plugin.json', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();

    await fs.remove(
      path.join(embeddedRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'missing .agents-plugin/plugin.json',
    );
  });

  it('rejects missing supported Claude manifests', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();

    await fs.remove(
      path.join(embeddedRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json'),
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'missing supported Claude manifest',
    );
  });

  it('rejects missing supported Codex manifests', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();

    await fs.remove(
      path.join(embeddedRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json'),
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'missing supported Codex manifest',
    );
  });

  it('rejects unexpected Claude bundle manifests for unsupported plugins', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture((manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
    });
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');

    await fs.outputJson(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      {
        name: 'git-commit',
        version: '0.1.0',
        description: 'unexpected claude manifest',
      },
      { spaces: 2 },
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'unexpected Claude bundle files for unsupported platform',
    );
  });

  it('rejects unexpected Claude runtime directories for unsupported plugins', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture((manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
    });

    await fs.outputFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'claude', 'ghost.txt'),
      'unexpected',
      'utf8',
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'unexpected Claude bundle files for unsupported platform',
    );
  });

  it('rejects unexpected Codex bundle manifests for unsupported plugins', async () => {
    const { embeddedRoot } = await createClaudeOnlyEmbeddedRoot();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');

    await fs.outputJson(
      path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
      {
        name: 'git-commit',
        version: '0.1.0',
        description: 'unexpected codex manifest',
      },
      { spaces: 2 },
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'unexpected Codex bundle files for unsupported platform',
    );
  });

  it('rejects unexpected Codex runtime directories for unsupported plugins', async () => {
    const { embeddedRoot } = await createClaudeOnlyEmbeddedRoot();

    await fs.outputFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'ghost.txt'),
      'unexpected',
      'utf8',
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'unexpected Codex bundle files for unsupported platform',
    );
  });

  it('rejects Claude manifest artifact paths that normalize into the Codex subtree', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', '.mcp.json')),
    ).resolves.toBe(true);

    manifest.mcpServers = './claude/../codex/.mcp.json';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid claude.mcpServers: path must stay inside "./claude/".',
    );
  });

  it('rejects Codex manifest artifact paths that normalize into the Claude subtree', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    await expect(
      fs.pathExists(path.join(pluginRoot, 'claude', '.mcp.json')),
    ).resolves.toBe(true);

    manifest.mcpServers = './codex/../claude/.mcp.json';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid codex.mcpServers: path must stay inside "./codex/".',
    );
  });

  it('rejects Claude manifest artifact symlinks that point into the Codex subtree', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    const linkPath = path.join(pluginRoot, 'claude', 'linked-mcp.json');
    const targetPath = path.join(pluginRoot, 'codex', '.mcp.json');

    await replaceFileWithSymlink(linkPath, targetPath);

    manifest.mcpServers = './claude/linked-mcp.json';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid claude.mcpServers: resolved target must stay inside "./claude/".',
    );
  });

  it('rejects Codex manifest artifact symlinks that point into the Claude subtree', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    const linkPath = path.join(pluginRoot, 'codex', 'linked-mcp.json');
    const targetPath = path.join(pluginRoot, 'claude', '.mcp.json');

    await replaceFileWithSymlink(linkPath, targetPath);

    manifest.mcpServers = './codex/linked-mcp.json';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid codex.mcpServers: resolved target must stay inside "./codex/".',
    );
  });

  it('rejects marketplace entries that do not match supported plugin sets', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture((manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
    });
    const claudeMarketplacePath = path.join(embeddedRoot, '.claude-plugin', 'marketplace.json');
    const codexMarketplace = await fs.readJson(
      path.join(embeddedRoot, '.agents', 'plugins', 'marketplace.json'),
    );
    const claudeMarketplace = await fs.readJson(claudeMarketplacePath);
    claudeMarketplace.plugins = codexMarketplace.plugins;
    await fs.writeJson(claudeMarketplacePath, claudeMarketplace, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid Claude marketplace entries',
    );
  });

  it('accepts bundle source manifests with skillTriggers without requiring a source skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(
      fs.pathExists(path.join(embeddedRoot, 'plugins', 'git-commit', 'skills')),
    ).resolves.toBe(false);
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('rejects bundle source manifests whose dependencies cannot be resolved in the current catalog', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readFixturePluginManifest(repoRoot);
    manifest.dependencies = {
      plugins: [
        {
          name: 'missing-helper',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'current catalog is missing plugin "missing-helper"',
    );
  });

  it('rejects platform manifests that accidentally keep AW-managed dependencies fields', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const codexManifestPath = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      '.codex-plugin',
      'plugin.json',
    );
    const codexManifest = await fs.readJson(codexManifestPath);
    codexManifest.dependencies = {
      plugins: [{ name: 'shared-helper' }],
    };
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid codex manifest: unknown field "dependencies".',
    );
  });

  it('rejects bundles missing lifecycle, helper, or runtime sibling files', async () => {
    const repoRoot = await makeTempRepo();
    await writeRuntimeScriptFixture(repoRoot);
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();

    await fs.remove(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow('scripts.lifecycle.install.default.path');

    await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import "./shared.mjs";\n', 'utf8');
    await fs.remove(path.join(pluginRoot, 'scripts', 'aw-config.mjs'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow('scripts.helpers.config');

    await fs.writeFile(path.join(pluginRoot, 'scripts', 'aw-config.mjs'), 'import "./shared.mjs";\n', 'utf8');
    await fs.remove(path.join(pluginRoot, 'scripts', 'shared.mjs'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow('Unable to resolve relative import "./shared.mjs"');
  });

  it('validates packageRoot metadata, production node_modules, and runtime bare imports', async () => {
    const repoRoot = await makeTempRepo();
    await writePackageRuntimeFixture(repoRoot);
    const embeddedRoot = path.join(repoRoot, 'embedded');
    await bundlePlugins({
      repoRoot,
      outputRoot: embeddedRoot,
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner(),
    });
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();

    await fs.remove(path.join(pluginRoot, 'scripts', 'node_modules'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow('missing production node_modules');

    await bundlePlugins({
      repoRoot,
      outputRoot: embeddedRoot,
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner(),
    });
    await fs.remove(path.join(pluginRoot, 'scripts', 'package.json'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow('scripts.node.packageRoot');

    await bundlePlugins({
      repoRoot,
      outputRoot: embeddedRoot,
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner(),
    });
    await fs.remove(path.join(pluginRoot, 'scripts', 'node_modules', 'chalk'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow('package is missing from bundle node_modules');
  });
});
