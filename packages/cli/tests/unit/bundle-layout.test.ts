import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginStagingRunner } from '../../src/generators/local-plugin.js';
import { validateBundleLayout } from '../../src/utils/bundle-layout.js';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

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

async function writeRepoPackageVersions(
  repoRoot: string,
  versions: {
    rootVersion: string;
    cliVersion: string;
  },
): Promise<void> {
  await fs.writeJson(
    path.join(repoRoot, 'package.json'),
    {
      name: 'agent-workflows',
      private: true,
      version: versions.rootVersion,
    },
    { spaces: 2 },
  );
  await fs.outputJson(
    path.join(repoRoot, 'packages', 'cli', 'package.json'),
    {
      name: '@lesliechan721/aw',
      version: versions.cliVersion,
    },
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

  it('rejects non-strict SemVer plugin versions in bundled manifests before release output', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const manifestPath = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      '.claude-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.version = 'v1.2.3';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Invalid claude manifest.version: expected a strict SemVer 2.0.0 string.',
    );
  });

  it('rejects invalid CLI package versions before writing bundled release output', async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoPackageVersions(repoRoot, {
      rootVersion: '1.0.0',
      cliVersion: 'v1.0.0',
    });

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).rejects.toThrow(
      'Invalid packages/cli/package.json version: expected a strict SemVer 2.0.0 string.',
    );
  });

  it('rejects mismatched root and CLI package versions before writing bundled release output', async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoPackageVersions(repoRoot, {
      rootVersion: '1.0.0',
      cliVersion: '1.0.1',
    });

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).rejects.toThrow(
      'Invalid release versions: package.json version 1.0.0 must match packages/cli/package.json version 1.0.1.',
    );
  });

  it('rejects Codex skills that are missing agents/openai.yaml', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();

    await fs.remove(
      path.join(
        embeddedRoot,
        'plugins',
        'git-commit',
        'codex',
        'skills',
        'commit',
        'agents',
        'openai.yaml',
      ),
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'skill "commit" is missing agents/openai.yaml',
    );
  });

  it('rejects Codex skills with invalid native invocation metadata', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();

    await fs.writeFile(
      path.join(
        embeddedRoot,
        'plugins',
        'git-commit',
        'codex',
        'skills',
        'commit',
        'agents',
        'openai.yaml',
      ),
      'policy:\n  allow_implicit_invocation: "false"\n',
      'utf8',
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'policy.allow_implicit_invocation 必须是 boolean',
    );
  });

  it('accepts Claude version and minimum-profile quoted boolean metadata', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const skillPath = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      'claude',
      'skills',
      'commit',
      'SKILL.md',
    );
    const skillContent = await fs.readFile(skillPath, 'utf8');
    await fs.writeFile(
      skillPath,
      skillContent.replace(
        'user-invocable: true',
        'version: 0.1.0\nuser-invocable: "true"',
      ),
      'utf8',
    );

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('rejects Claude skills with invalid native invocation metadata', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const skillPath = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      'claude',
      'skills',
      'commit',
      'SKILL.md',
    );
    const skillContent = await fs.readFile(skillPath, 'utf8');
    await fs.writeFile(
      skillPath,
      skillContent.replace('user-invocable: true', 'user-invocable: enabled'),
      'utf8',
    );

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'known-field-invalid-type-value',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symbolic links inside bundled Skills roots',
    async () => {
      const { repoRoot, embeddedRoot } = await createEmbeddedRootFromFixture();
      const outsideSkill = path.join(repoRoot, 'outside-skill');
      await fs.outputFile(path.join(outsideSkill, 'SKILL.md'), '# Linked\n', 'utf8');
      await fs.outputFile(
        path.join(outsideSkill, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: "false"\n',
        'utf8',
      );
      await replaceFileWithSymlink(
        path.join(
          embeddedRoot,
          'plugins',
          'git-commit',
          'codex',
          'skills',
          'commit',
        ),
        outsideSkill,
      );

      await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
        'symbolic links are not supported',
      );
    },
  );

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

  it('accepts Codex inline hooks and Claude bundle-local hooks in platform manifests', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const codexManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const codexManifest = await fs.readJson(codexManifestPath);
    codexManifest.hooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo codex ok' }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo prompt ok' }],
          },
        ],
      },
    };
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });

    const claudeManifest = await fs.readJson(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    );
    expect(claudeManifest.hooks).toBe('./claude/hooks/hooks.json');

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it.each([
    {
      name: 'string hooks field',
      hooks: './codex/hooks/hooks.json',
      message: 'Invalid codex.hooks: expected an inline hooks object.',
    },
    {
      name: 'unsupported event',
      hooks: {
        hooks: {
          SessionEnd: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo done' }],
            },
          ],
        },
      },
      message: 'codex.hooks.hooks.SessionEnd',
    },
    {
      name: 'matcher on matcherless event',
      hooks: {
        hooks: {
          UserPromptSubmit: [
            {
              matcher: 'ignored',
              hooks: [{ type: 'command', command: 'echo prompt' }],
            },
          ],
        },
      },
      message: 'does not allow matcher',
    },
    {
      name: 'unsupported handler schema',
      hooks: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo slow', timeout: 1000 }],
            },
          ],
        },
      },
      message: 'unsupported fields "timeout"',
    },
  ])('rejects invalid Codex inline hooks: $name', async ({ hooks, message }) => {
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
    codexManifest.hooks = hooks;
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(message);
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

  it('includes static template imports in the bundled runtime closure', async () => {
    const repoRoot = await makeTempRepo();
    await writeRuntimeScriptFixture(repoRoot);
    await fs.writeFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'lifecycle.mjs'),
      'await import(`./shared.mjs`);\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'aw-config.mjs'),
      'export default {};\n',
      'utf8',
    );

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(
      fs.pathExists(path.join(embeddedRoot, 'plugins', 'git-commit', 'scripts', 'shared.mjs')),
    ).resolves.toBe(true);
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('rejects extensionless ESM imports that Node cannot resolve', async () => {
    const repoRoot = await makeTempRepo();
    await writeRuntimeScriptFixture(repoRoot);
    const scriptsRoot = path.join(repoRoot, 'plugins', 'git-commit', 'scripts');
    const lifecyclePath = path.join(scriptsRoot, 'lifecycle.mjs');
    await fs.writeFile(lifecyclePath, 'import "./helper";\n', 'utf8');
    await fs.writeFile(path.join(scriptsRoot, 'helper.mjs'), 'export default true;\n', 'utf8');
    await fs.writeFile(path.join(scriptsRoot, 'aw-config.mjs'), 'export default {};\n', 'utf8');

    await expect(execFileAsync(process.execPath, [lifecyclePath])).rejects.toMatchObject({
      stderr: expect.stringContaining('ERR_MODULE_NOT_FOUND'),
    });
    await expect(createSyntheticEmbeddedRoot(repoRoot)).rejects.toThrow(
      'Unable to resolve relative import "./helper" from "scripts/lifecycle.mjs".',
    );
  });

  it('includes a relative require after a postfix increment in the bundled runtime closure', async () => {
    const repoRoot = await makeTempRepo();
    await writeRuntimeScriptFixture(repoRoot);
    const scriptsRoot = path.join(repoRoot, 'plugins', 'git-commit', 'scripts');
    await fs.writeFile(
      path.join(scriptsRoot, 'lifecycle.mjs'),
      'let count = 0; count++ / require("./factor.cjs");\n',
      'utf8',
    );
    await fs.writeFile(path.join(scriptsRoot, 'factor.cjs'), 'module.exports = 2;\n', 'utf8');
    await fs.writeFile(path.join(scriptsRoot, 'aw-config.mjs'), 'export default {};\n', 'utf8');

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(
      fs.readFile(
        path.join(embeddedRoot, 'plugins', 'git-commit', 'scripts', 'factor.cjs'),
        'utf8',
      ),
    ).resolves.toBe('module.exports = 2;\n');
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('includes and runs a CommonJS helper loaded with module.require', async () => {
    const repoRoot = await makeTempRepo();
    await writeRuntimeScriptFixture(repoRoot);
    const scriptsRoot = path.join(repoRoot, 'plugins', 'git-commit', 'scripts');
    await fs.writeFile(
      path.join(scriptsRoot, 'lifecycle.cjs'),
      'process.stdout.write(module.require("./helper.cjs"));\n',
      'utf8',
    );
    await fs.writeFile(path.join(scriptsRoot, 'helper.cjs'), 'module.exports = "helper-ok";\n', 'utf8');
    await fs.writeFile(path.join(scriptsRoot, 'aw-config.mjs'), 'export default {};\n', 'utf8');
    await updateFixturePluginManifest(repoRoot, (manifest) => {
      manifest.scripts.lifecycle.install = './scripts/lifecycle.cjs';
    });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const bundledEntry = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      'scripts',
      'lifecycle.cjs',
    );

    await expect(execFileAsync(process.execPath, [bundledEntry])).resolves.toMatchObject({
      stdout: 'helper-ok',
    });
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('includes and runs a JSON runtime leaf loaded by CommonJS require', async () => {
    const repoRoot = await makeTempRepo();
    await writeRuntimeScriptFixture(repoRoot);
    const scriptsRoot = path.join(repoRoot, 'plugins', 'git-commit', 'scripts');
    await fs.writeFile(
      path.join(scriptsRoot, 'lifecycle.cjs'),
      'process.stdout.write(require("./config").message);\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(scriptsRoot, 'config.mjs'),
      'export default { message: "mjs-wrong" };\n',
      'utf8',
    );
    await fs.writeJson(path.join(scriptsRoot, 'config.json'), {
      message: 'json-ok',
      sourceLikeText: 'require("./ghost.cjs")',
    });
    await fs.writeFile(path.join(scriptsRoot, 'aw-config.mjs'), 'export default {};\n', 'utf8');
    await updateFixturePluginManifest(repoRoot, (manifest) => {
      manifest.scripts.lifecycle.install = './scripts/lifecycle.cjs';
    });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const bundledPluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');

    await expect(execFileAsync(
      process.execPath,
      [path.join(bundledPluginRoot, 'scripts', 'lifecycle.cjs')],
    )).resolves.toMatchObject({ stdout: 'json-ok' });
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();

    await fs.remove(path.join(bundledPluginRoot, 'scripts', 'config.json'));
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'Unable to resolve relative import "./config"',
    );
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

  it.each([
    ['missing dependencies field', false],
    ['empty dependencies object', true],
  ] as const)('bundles and validates a zero-dependency packageRoot with %s', async (_label, useEmptyObject) => {
    const repoRoot = await makeTempRepo();
    await writePackageRuntimeFixture(repoRoot);
    const packageJsonPath = path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'package.json');
    const packageJson = await fs.readJson(packageJsonPath);
    if (useEmptyObject) {
      packageJson.dependencies = {};
    } else {
      delete packageJson.dependencies;
    }
    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
    await fs.writeFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'scripts', 'lifecycle.mjs'),
      'export const ok = true;\n',
      'utf8',
    );

    const embeddedRoot = path.join(repoRoot, 'embedded');
    await bundlePlugins({
      repoRoot,
      outputRoot: embeddedRoot,
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner(),
    });
    const nodeModulesPath = path.join(embeddedRoot, 'plugins', 'git-commit', 'scripts', 'node_modules');

    await expect(fs.pathExists(nodeModulesPath)).resolves.toBe(false);
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });
});
