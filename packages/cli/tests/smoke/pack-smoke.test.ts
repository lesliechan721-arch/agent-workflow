import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function collectStringPaths(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringPaths(entry));
  }
  return [];
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('pack smoke', () => {
  it('packs the runtime bundle into the tarball and can init from the unpacked package', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-pack-smoke-'));
    tempDirs.push(tempRoot);

    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
    const awHome = path.join(tempRoot, 'aw-home');
    await fs.ensureDir(packDir);
    await fs.ensureDir(unpackDir);

    const packageJson = await fs.readJson(path.join(packageRoot, 'package.json'));
    expect(packageJson.files).toEqual(['dist/', 'plugins-dist/']);
    expect(packageJson.scripts.prepack).toBe('pnpm build');

    await execFileAsync(
      'pnpm',
      ['pack:cli', '--pack-destination', packDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const tarballs = (await fs.readdir(packDir)).filter((entry) => entry.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);

    await execFileAsync(
      'tar',
      ['-xzf', path.join(packDir, tarballs[0]), '-C', unpackDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const unpackedPackageRoot = path.join(unpackDir, 'package');
    const unpackedPluginsRoot = path.join(unpackedPackageRoot, 'plugins-dist');
    const samplePluginRoot = path.join(unpackedPluginsRoot, 'plugins', 'git-commit');
    await fs.ensureSymlink(
      path.join(packageRoot, 'node_modules'),
      path.join(unpackedPackageRoot, 'node_modules'),
    );

    const requiredPaths = [
      path.join(unpackedPackageRoot, 'dist', 'index.js'),
      path.join(unpackedPluginsRoot, '.claude-plugin', 'marketplace.json'),
      path.join(unpackedPluginsRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(samplePluginRoot, '.agents-plugin', 'plugin.json'),
      path.join(samplePluginRoot, '.claude-plugin', 'plugin.json'),
      path.join(samplePluginRoot, '.codex-plugin', 'plugin.json'),
    ];
    await Promise.all(requiredPaths.map(async (requiredPath) => {
      await expect(fs.pathExists(requiredPath)).resolves.toBe(true);
    }));

    const [packedPackageJson, claudeMarketplace, codexMarketplace, claudeManifest, codexManifest] =
      await Promise.all([
        fs.readJson(path.join(unpackedPackageRoot, 'package.json')),
        fs.readJson(path.join(unpackedPluginsRoot, '.claude-plugin', 'marketplace.json')),
        fs.readJson(path.join(unpackedPluginsRoot, '.agents', 'plugins', 'marketplace.json')),
        fs.readJson(path.join(samplePluginRoot, '.claude-plugin', 'plugin.json')),
        fs.readJson(path.join(samplePluginRoot, '.codex-plugin', 'plugin.json')),
      ]);

    expect(packedPackageJson.name).toBe('@yiliang/aw');
    expect(claudeMarketplace).toEqual(codexMarketplace);
    expect(claudeMarketplace).toMatchObject({
      name: 'aw',
      owner: {
        name: 'Leslie Chan',
        url: 'https://github.com/LeslieChan/agent-workflows',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: 'git-commit',
          source: './plugins/git-commit',
          category: 'workflow',
          tags: ['git', 'commit'],
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        }),
      ]),
    });
    const gitCommitEntry = claudeMarketplace.plugins.find(
      (plugin: { name?: string }) => plugin.name === 'git-commit',
    );
    expect(gitCommitEntry?.policy).not.toHaveProperty('products');

    const claudeBundlePaths = collectStringPaths([
      claudeManifest.skills,
      claudeManifest.hooks,
      claudeManifest.mcpServers,
      claudeManifest.commands,
      claudeManifest.outputStyles,
      claudeManifest.agents,
      claudeManifest.lspServers,
    ]);
    const codexBundlePaths = collectStringPaths([
      codexManifest.skills,
      codexManifest.mcpServers,
      codexManifest.apps,
    ]);

    expect(claudeBundlePaths.every((entry) => !entry.startsWith('./shared/'))).toBe(true);
    expect(codexBundlePaths.every((entry) => !entry.startsWith('./shared/'))).toBe(true);

    const { validateBundleLayout } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'bundle-layout.js')).href
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(unpackedPluginsRoot)).resolves.toBeUndefined();

    const { resolveEmbeddedPluginsRoot } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'paths.js')).href
    )) as { resolveEmbeddedPluginsRoot: () => Promise<string> };
    await expect(resolveEmbeddedPluginsRoot()).resolves.toBe(
      await fs.realpath(unpackedPluginsRoot),
    );

    const previousAwHome = process.env.AW_HOME;
    try {
      process.env.AW_HOME = awHome;
      const { initCommand } = (await import(
        pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'src', 'commands', 'init.js')).href
      )) as { initCommand: (options?: { force?: boolean }) => Promise<{ rootDir: string; changed: boolean }> };

      await expect(initCommand({ force: true })).resolves.toMatchObject({
        rootDir: awHome,
        changed: true,
      });
    } finally {
      if (previousAwHome === undefined) {
        delete process.env.AW_HOME;
      } else {
        process.env.AW_HOME = previousAwHome;
      }
    }

    await expect(
      fs.pathExists(path.join(awHome, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(awHome, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(true);
    await expect(fs.readJson(path.join(awHome, 'config.json'))).resolves.toMatchObject({
      sourcePackage: '@yiliang/aw',
      sourceVersion: packedPackageJson.version,
    });
  });

  it('bundles public slashCommands correctly from the unpacked tarball runtime', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-pack-slash-commands-'));
    tempDirs.push(tempRoot);

    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    await fs.ensureDir(packDir);
    await fs.ensureDir(unpackDir);
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', 'slashCommands-only'),
      path.join(tempRepo, 'plugins', 'slash-commands-only'),
    );

    await execFileAsync(
      'pnpm',
      ['pack:cli', '--pack-destination', packDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const tarballs = (await fs.readdir(packDir)).filter((entry) => entry.endsWith('.tgz'));
    expect(tarballs).toHaveLength(1);
    await execFileAsync(
      'tar',
      ['-xzf', path.join(packDir, tarballs[0]), '-C', unpackDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const unpackedPackageRoot = path.join(unpackDir, 'package');
    await fs.ensureSymlink(
      path.join(packageRoot, 'node_modules'),
      path.join(unpackedPackageRoot, 'node_modules'),
    );

    const { bundlePlugins } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'scripts', 'bundle-plugins.js')).href
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    const pluginRoot = path.join(outputRoot, 'plugins', 'slash-commands-only');
    await expect(
      fs.pathExists(path.join(pluginRoot, 'claude', 'commands', 'review.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'agents', 'openai.yaml')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'slash-commands', 'review.md')),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(pluginRoot, 'codex', 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).resolves.not.toContain('$ARGUMENTS');

    const { validateBundleLayout } = (await import(
      pathToFileURL(path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'bundle-layout.js')).href
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });
});
