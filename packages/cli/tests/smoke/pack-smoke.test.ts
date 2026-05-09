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
  it('packs the runtime bundle into the tarball with platform-filtered marketplaces', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-pack-smoke-'));
    tempDirs.push(tempRoot);

    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
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
    const codexExplorePluginRoot = path.join(unpackedPluginsRoot, 'plugins', 'codex-explore');
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
      path.join(codexExplorePluginRoot, '.agents-plugin', 'plugin.json'),
      path.join(codexExplorePluginRoot, '.codex-plugin', 'plugin.json'),
      path.join(codexExplorePluginRoot, 'scripts', 'render-artifacts.mjs'),
      path.join(codexExplorePluginRoot, 'codex', 'skills', 'codex-explore', 'SKILL.md'),
      path.join(codexExplorePluginRoot, 'codex', 'skills', 'codex-explore', 'agents', 'openai.yaml'),
    ];
    await Promise.all(requiredPaths.map(async (requiredPath) => {
      await expect(fs.pathExists(requiredPath)).resolves.toBe(true);
    }));
    await Promise.all([
      path.join(codexExplorePluginRoot, 'codex', 'roles', 'codex-explorer.md'),
      path.join(codexExplorePluginRoot, 'codex', 'instructions', 'lightweight.md'),
    ].map(async (removedPath) => {
      await expect(fs.pathExists(removedPath)).resolves.toBe(false);
    }));
    await expect(
      fs.pathExists(path.join(codexExplorePluginRoot, '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(codexExplorePluginRoot, 'claude')),
    ).resolves.toBe(false);

    const [
      packedPackageJson,
      claudeMarketplace,
      codexMarketplace,
      claudeManifest,
      sampleCodexManifest,
      codexExploreManifest,
      codexExploreCodexManifest,
    ] =
      await Promise.all([
        fs.readJson(path.join(unpackedPackageRoot, 'package.json')),
        fs.readJson(path.join(unpackedPluginsRoot, '.claude-plugin', 'marketplace.json')),
        fs.readJson(path.join(unpackedPluginsRoot, '.agents', 'plugins', 'marketplace.json')),
        fs.readJson(path.join(samplePluginRoot, '.claude-plugin', 'plugin.json')),
        fs.readJson(path.join(samplePluginRoot, '.codex-plugin', 'plugin.json')),
        fs.readJson(path.join(codexExplorePluginRoot, '.agents-plugin', 'plugin.json')),
        fs.readJson(path.join(codexExplorePluginRoot, '.codex-plugin', 'plugin.json')),
      ]);

    expect(packedPackageJson.name).toBe('@yiliang/aw');
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
    expect(claudeMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'git-commit',
    ]);
    expect(codexMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'codex-explore',
      'git-commit',
    ]);
    expect(codexMarketplace).toMatchObject({
      owner: claudeMarketplace.owner,
      interface: claudeMarketplace.interface,
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: 'codex-explore',
          source: './plugins/codex-explore',
          policy: expect.objectContaining({
            products: ['CODEX'],
          }),
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
    expect(codexExploreManifest).toMatchObject({
      scripts: {
        artifacts: {
          render: {
            runner: 'node',
            path: './scripts/render-artifacts.mjs',
          },
        },
      },
      artifacts: {
        targets: expect.arrayContaining([
          expect.objectContaining({
            id: 'codex-explore-skill',
            platform: 'codex',
            target: 'codex.skill',
            skillKey: 'codex-explore',
          }),
        ]),
      },
    });
    expect(codexExploreCodexManifest).toMatchObject({
      name: 'codex-explore',
      skills: './codex/skills',
    });

    const codexBundlePaths = collectStringPaths([
      sampleCodexManifest.skills,
      sampleCodexManifest.mcpServers,
      sampleCodexManifest.apps,
    ]);

    expect(claudeBundlePaths.every((entry) => !entry.startsWith('./shared/'))).toBe(true);
    expect(codexBundlePaths.every((entry) => !entry.startsWith('./shared/'))).toBe(true);
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
