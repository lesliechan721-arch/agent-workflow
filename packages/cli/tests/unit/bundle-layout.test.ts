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
