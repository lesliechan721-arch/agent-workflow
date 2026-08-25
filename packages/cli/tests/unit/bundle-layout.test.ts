import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginStagingRunner } from '../../src/generators/local-plugin.js';
import { validateBundleLayout } from '../../src/utils/bundle-layout.js';
import {
  validateRuntimeSkillClosure,
  validateRuntimeSkillClosuresRoot,
  validateSkillRuntimeProjectionFreshness,
} from '../../src/utils/runtime-skill-closure.js';
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
    targetVersion: string;
    evalVersion: string;
    cliVersion: string;
  },
): Promise<void> {
  await fs.writeJson(
    path.join(repoRoot, 'package.json'),
    {
      name: 'agent-workflows',
      private: true,
    },
    { spaces: 2 },
  );
  await fs.outputJson(
    path.join(repoRoot, 'release', 'version-targets.json'),
    {
      schemaVersion: 1,
      cli: versions.targetVersion,
      catalog: versions.targetVersion,
    },
    { spaces: 2 },
  );
  await fs.outputJson(
    path.join(repoRoot, 'packages', 'agent-skill-eval', 'package.json'),
    {
      name: '@lesliechan721/agent-skill-eval',
      version: versions.evalVersion,
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
  it('omits .DS_Store path segments from the plugin bundle but keeps other hidden files', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    await fs.outputFile(path.join(pluginRoot, '.DS_Store'), 'finder metadata\n');
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'commit', 'references', '.DS_Store', 'metadata'),
      'nested finder metadata\n',
    );
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'commit', '.runtime-hidden'),
      'hidden production file\n',
    );

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const bundledPluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const bundledFiles = await fs.readdir(bundledPluginRoot);
    expect(bundledFiles).not.toContain('.DS_Store');
    for (const platform of ['claude', 'codex']) {
      await expect(fs.pathExists(path.join(
        bundledPluginRoot,
        platform,
        'skills',
        'commit',
        'references',
        '.DS_Store',
      ))).resolves.toBe(false);
      await expect(fs.readFile(path.join(
        bundledPluginRoot,
        platform,
        'skills',
        'commit',
        '.runtime-hidden',
      ), 'utf8')).resolves.toBe('hidden production file\n');
    }
  });

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

  it('validates static portable distribution roots and generated dynamic sources', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    await updateFixturePluginManifest(repoRoot, (manifest) => {
      manifest.compatibility.aw.minVersion = '0.1.0';
      manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
      manifest.artifacts = { targets: [{
        id: 'portable-source',
        distribution: 'agent-skills',
        target: 'agent-skills.skill',
        kind: 'skill',
        scopes: ['project'],
        states: ['present'],
        refreshKeys: [],
        skillKey: 'portable-source',
        sourceDirs: ['./portable-source'],
      }] };
    });
    await fs.outputFile(
      path.join(pluginRoot, 'agent-skills', 'skills', 'static-portable', 'SKILL.md'),
      '---\nname: static-portable\ndescription: Static portable fixture.\n---\nBody.\n',
    );
    await fs.outputFile(
      path.join(pluginRoot, 'agent-skills', 'skills', 'static-portable', 'README.md'),
      '# Static portable\n',
    );
    await fs.outputFile(path.join(pluginRoot, 'portable-source', 'README.md'), '# Portable source\n');

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const bundledSource = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'artifact-sources',
      'agent-skills',
      'portable-source',
      '0',
    );
    await expect(fs.pathExists(bundledSource)).resolves.toBe(true);
    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();

    await fs.remove(bundledSource);
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'artifacts.targets[0].sourceDirs[0]',
    );
    await fs.ensureDir(bundledSource);

    const bundledPortableRoot = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      'agent-skills',
      'skills',
    );
    const savedPortableRoot = path.join(
      embeddedRoot,
      'plugins',
      'git-commit',
      'saved-portable-skills',
    );
    await fs.rename(bundledPortableRoot, savedPortableRoot);
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'distributions.agentSkills.skills',
    );

    if (process.platform !== 'win32') {
      await fs.symlink(path.relative(path.dirname(bundledPortableRoot), savedPortableRoot), bundledPortableRoot, 'dir');
      await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
        'distributions.agentSkills.skills',
      );
    }
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
      targetVersion: '1.0.0',
      evalVersion: '1.0.0',
      cliVersion: 'v1.0.0',
    });

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).rejects.toThrow(
      'Invalid packages/cli/package.json version: expected a strict SemVer 2.0.0 string.',
    );
  });

  it('allows synthetic external roots with no release version truth files', async () => {
    const repoRoot = await makeTempRepo();

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).resolves.toMatchObject({
      pluginNames: ['git-commit'],
    });
  });

  it('rejects portable source manifests without an explicit AW minimum before catalog output', async () => {
    const repoRoot = await makeTempRepo();
    const outputRoot = path.join(repoRoot, 'embedded');
    await updateFixturePluginManifest(repoRoot, (manifest) => {
      delete manifest.compatibility;
      manifest.distributions = { agentSkills: {} };
    });

    await expect(bundlePlugins({ repoRoot, outputRoot })).rejects.toThrow(
      'Invalid compatibility.aw.minVersion: expected a strict SemVer 2.0.0 string. Received undefined.',
    );
    await expect(fs.pathExists(path.join(outputRoot, 'catalog-manifest.json'))).resolves.toBe(false);
  });

  it.each([
    'package.json',
    'release/version-targets.json',
    'packages/agent-skill-eval/package.json',
    'packages/cli/package.json',
  ])('rejects an incomplete release version truth set missing %s', async (missing) => {
    const repoRoot = await makeTempRepo();
    await writeRepoPackageVersions(repoRoot, {
      targetVersion: '1.0.0',
      evalVersion: '1.0.0',
      cliVersion: '1.0.0',
    });
    await fs.remove(path.join(repoRoot, missing));

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).rejects.toThrow(`Incomplete release version truth set: missing ${missing}.`);
  });

  it('rejects a root version when the complete release version truth set exists', async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoPackageVersions(repoRoot, {
      targetVersion: '1.0.0',
      evalVersion: '1.0.0',
      cliVersion: '1.0.0',
    });
    await fs.writeJson(path.join(repoRoot, 'package.json'), {
      name: 'agent-workflows',
      private: true,
      version: '1.0.0',
    }, { spaces: 2 });

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).rejects.toThrow(
      'package.json must not declare a version; release/version-targets.json is the release target source.',
    );
  });

  it('rejects public packages that diverge from the release target before writing bundled output', async () => {
    const repoRoot = await makeTempRepo();
    await writeRepoPackageVersions(repoRoot, {
      targetVersion: '1.0.0',
      evalVersion: '1.0.0',
      cliVersion: '1.0.1',
    });

    await expect(bundlePlugins({
      repoRoot,
      outputRoot: path.join(repoRoot, 'embedded'),
    })).rejects.toThrow(
      'Invalid release versions: release/version-targets.json cli 1.0.0 must match packages/agent-skill-eval/package.json version 1.0.0 and packages/cli/package.json version 1.0.1.',
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

  it.each([
    ['Claude', '.claude-plugin', 'claude'],
    ['Codex', '.codex-plugin', 'codex'],
  ])('rejects a regular file used as the %s skills collection root', async (
    _platformLabel,
    manifestDir,
    runtimeDir,
  ) => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, manifestDir, 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    const skillsRoot = path.join(pluginRoot, runtimeDir, 'skills');
    await fs.remove(skillsRoot);
    await fs.outputFile(skillsRoot, 'not a directory\n', 'utf8');
    manifest.skills = `./${runtimeDir}/skills`;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      `Invalid ${runtimeDir}.skills: skills root must be a regular directory.`,
    );
  });

  it.each([
    ['Claude', '.claude-plugin', 'claude'],
    ['Codex', '.codex-plugin', 'codex'],
  ])('allows a missing %s skills collection only when the manifest does not declare it', async (
    _platformLabel,
    manifestDir,
    runtimeDir,
  ) => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, manifestDir, 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.skills;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.remove(path.join(pluginRoot, runtimeDir, 'skills'));

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== 'win32').each([
    ['Claude', '.claude-plugin', 'claude'],
    ['Codex', '.codex-plugin', 'codex'],
  ])('rejects a symbolic link used as the %s skills collection root', async (
    _platformLabel,
    manifestDir,
    runtimeDir,
  ) => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, manifestDir, 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    const skillsRoot = path.join(pluginRoot, runtimeDir, 'skills');
    const targetRoot = path.join(pluginRoot, runtimeDir, 'linked-skills');
    await fs.rename(skillsRoot, targetRoot);
    await fs.symlink('linked-skills', skillsRoot, 'dir');
    manifest.skills = `./${runtimeDir}/skills`;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      `Invalid ${runtimeDir}.skills: skills root must be a regular directory.`,
    );
  });

  it.runIf(process.platform !== 'win32')(
    'propagates an operational error while reading a declared skills collection root',
    async () => {
      const { embeddedRoot } = await createEmbeddedRootFromFixture();
      const skillsRoot = path.join(
        embeddedRoot,
        'plugins',
        'git-commit',
        'claude',
        'skills',
      );
      await fs.chmod(skillsRoot, 0o000);
      try {
        await expect(validateBundleLayout(embeddedRoot)).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EACCES|EPERM)$/u),
        });
      } finally {
        await fs.chmod(skillsRoot, 0o700);
      }
    },
  );

  it('propagates ENOTDIR from a declared skills collection path', async () => {
    const { embeddedRoot } = await createEmbeddedRootFromFixture();
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skills = './claude/not-a-directory/skills';
    await fs.outputFile(
      path.join(pluginRoot, 'claude', 'not-a-directory'),
      'regular file\n',
      'utf8',
    );
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(validateBundleLayout(embeddedRoot)).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
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

describe('runtime Skill resource closure', () => {
  async function createRuntimeSkill(
    content: string,
    files: Record<string, string> = {},
  ): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-skill-closure-'));
    tempDirs.push(root);
    const skillRoot = path.join(root, 'demo-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), content, 'utf8');
    for (const [relativePath, fileContent] of Object.entries(files)) {
      await fs.outputFile(path.join(skillRoot, relativePath), fileContent, 'utf8');
    }
    return skillRoot;
  }

  it('matches the shared deterministic closure corpus', async () => {
    const corpus = await fs.readJson(path.resolve(
      import.meta.dirname,
      '../../../../plugins/agent-skill-toolkit/standards/runtime-skill-closure-cases.json',
    )) as {
      cases: Array<{
        id: string;
        skill: string;
        files: Record<string, string>;
        expected: { valid: boolean; target: string | null };
      }>;
    };
    for (const fixture of corpus.cases) {
      const skillRoot = await createRuntimeSkill([
        '---',
        'name: demo-skill',
        'description: fixture',
        '---',
        fixture.skill,
      ].join('\n'), fixture.files);
      if (fixture.expected.valid) {
        await expect(validateRuntimeSkillClosure(skillRoot), fixture.id).resolves.toBeUndefined();
      } else {
        await expect(validateRuntimeSkillClosure(skillRoot), fixture.id).rejects.toThrow(
          fixture.expected.target!,
        );
      }
    }
  });

  it('accepts valid links and inline commands while ignoring non-local targets', async () => {
    const skillRoot = await createRuntimeSkill([
      '[guide](references/guide.md#L12)',
      '![icon](assets/icon.svg?raw#preview)',
      '[provider][provider-doc]',
      '[provider-doc]: providers/model.json?view=compact',
      '[root file](./root.txt:8)',
      '`node scripts/run.mjs --provider providers/model.json`',
      '`./root.txt`',
      '`./eval-runtime-capabilities.json`',
      '[remote](https://example.com/references/missing.md)',
      '[mail](mailto:team@example.com)',
      '[section](#local-section)',
      '`references/{{name}}.md`',
      '`references/<name>.md`',
      '`assets/*.svg`',
      '`references/$FILE.md`',
      '`$SKILL_ROOT/references/missing.md`',
      '`%SKILL_ROOT%/references/missing.md`',
    ].join('\n'), {
      'references/guide.md': 'guide\n',
      'assets/icon.svg': '<svg/>\n',
      'root.txt': 'root\n',
      'scripts/run.mjs': 'export {};\n',
      'providers/model.json': '{}\n',
    });

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('allows only exact declared generated files during source closure validation', async () => {
    const skillRoot = await createRuntimeSkill([
      '[generated](references/generated.md)',
      '[nested missing](references/nested/missing.md)',
    ].join('\n'));

    await expect(validateRuntimeSkillClosure(skillRoot, {
      declaredGeneratedFiles: new Set(['references/generated.md']),
    })).rejects.toThrow('references/nested/missing.md');

    await fs.outputFile(
      path.join(skillRoot, 'references', 'nested', 'missing.md'),
      '[deep missing](deep.md)\n',
    );
    await expect(validateRuntimeSkillClosure(skillRoot, {
      declaredGeneratedFiles: new Set(['references/generated.md']),
    })).rejects.toThrow('markdown-link target "deep.md" from "references/nested/missing.md"');
  });

  it('scans balanced, angle, escaped, and reference-definition Markdown destinations', async () => {
    const skillRoot = await createRuntimeSkill([
      '[balanced](references/guide_(v2).md)',
      '[escaped](references/guide_\\(v3\\).md)',
      '[angle](<references/guide%20v4.md>)',
      '[defined][guide-v5]',
      '[guide-v5]: references/guide_(v5).md "Guide title"',
    ].join('\n'), {
      'references/guide_(v2).md': 'v2\n',
      'references/guide_(v3).md': 'v3\n',
      'references/guide v4.md': 'v4\n',
      'references/guide_(v5).md': 'v5\n',
    });

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('does not treat escaped link text or fenced, indented, and inline code as Markdown links', async () => {
    const skillRoot = await createRuntimeSkill([
      '\\[escaped](references/missing-escaped.md)',
      '```md',
      '[fenced](references/missing-fenced.md)',
      '```',
      '    [four spaces](references/missing-four-spaces.md)',
      '',
      '\t[tab](references/missing-tab.md)',
      '`[inline](references/missing-inline.md)`',
    ].join('\n'));

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it.each([
    ['empty fenced block', '```\nnode scripts/missing-fenced.mjs\n```'],
    ['shell fenced block', '```sh\nnode providers/missing-fenced.json\n```'],
    ['escaping shell fenced block', '```bash\nnode scripts/../outside.mjs\n```'],
    ['pwsh fenced block', '```pwsh\npwsh -File .\\scripts\\missing.ps1\n```'],
    ['ps1 fenced block', '```ps1\npwsh -File .\\scripts\\missing.ps1\n```'],
    ['four-space indented block', '    node scripts/missing-indented.mjs'],
    ['tab-indented block', '\tnode providers/missing-indented.json'],
    ['escaping indented block', '    node ../outside.mjs'],
  ])('scans command paths in a %s', async (_name, content) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'inline-command target',
    );
  });

  it('does not scan command paths in non-shell fenced examples', async () => {
    const skillRoot = await createRuntimeSkill([
      '```json',
      '{ "script": "scripts/missing-example.mjs" }',
      '```',
    ].join('\n'));

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('continues to scan path tokens inside inline command code', async () => {
    const skillRoot = await createRuntimeSkill('`node references/missing-inline.md`\n');

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'inline-command target "references/missing-inline.md"',
    );
  });

  it.each([
    ['node', '`node ./missing-runtime.mjs`'],
    ['python', '`python ./missing-runtime.py`'],
    ['shell', '`sh ./missing-runtime.sh`'],
    ['direct executable', '`./missing-runtime`'],
  ])('rejects a missing dot-relative target with explicit %s execution semantics', async (
    _name,
    content,
  ) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'inline-command target',
    );
  });

  it.each([
    ['PowerShell', '`powershell .\\missing-runtime.ps1`', '.\\missing-runtime.ps1'],
    ['pwsh', '`pwsh -File .\\missing-runtime.ps1`', '.\\missing-runtime.ps1'],
    ['cmd', '`cmd /c .\\missing-runtime.cmd`', '.\\missing-runtime.cmd'],
    ['drive-relative executor argument', '`powershell C:missing-runtime.ps1`', 'C:missing-runtime.ps1'],
  ])('rejects an unsafe explicit Windows %s target', async (
    _name,
    content,
    lexicalTarget,
  ) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      `inline-command target ${JSON.stringify(lexicalTarget)}`,
    );
  });

  it.each([
    ['PowerShell script', '`powershell .\\scripts\\run.ps1`', 'scripts/run.ps1'],
    ['pwsh fenced script', '```pwsh\npwsh -File .\\scripts\\run.ps1\n```', 'scripts/run.ps1'],
    ['ps1 fenced script', '```ps1\npwsh -File .\\scripts\\run.ps1\n```', 'scripts/run.ps1'],
    ['cmd script', '`cmd /c .\\scripts\\run.cmd`', 'scripts/run.cmd'],
  ])('accepts an existing regular Skill-local %s', async (
    _name,
    content,
    relativeTarget,
  ) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`, {
      [relativeTarget]: 'exit 0\n',
    });

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('ignores dot-relative plan working files without local execution semantics', async () => {
    const skillRoot = await createRuntimeSkill([
      'Use `./plan.json` as the working file.',
      'Run `aw-skill-eval run ./plan.json`.',
    ].join('\n'));

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it.each([
    ['input redirection', '`node <scripts/missing-input.mjs`', '<scripts/missing-input.mjs'],
    ['file-descriptor redirection', '`node 2>assets/missing-output.log`', '2>assets/missing-output.log'],
  ])('keeps a core resource after stripping %s syntax', async (
    _name,
    content,
    lexicalTarget,
  ) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      `inline-command target ${JSON.stringify(lexicalTarget)}`,
    );
  });

  it('does not turn escaped backticks into inline command delimiters', async () => {
    const skillRoot = await createRuntimeSkill(
      '\\`node scripts/missing-escaped.mjs\\`\n',
    );

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('supports reference-definition destinations on the next line', async () => {
    const skillRoot = await createRuntimeSkill([
      '[balanced]:',
      '  references/guide_(v6).md',
      '[angle]:',
      '   <references/guide%20v7.md>',
      '[escaped]:',
      ' references/guide_\\(v8\\).md',
    ].join('\n'), {
      'references/guide_(v6).md': 'v6\n',
      'references/guide v7.md': 'v7\n',
      'references/guide_(v8).md': 'v8\n',
    });

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('rejects a missing reference-definition destination on the next line', async () => {
    const skillRoot = await createRuntimeSkill('[missing]:\n   references/missing.md\n');

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'markdown-link target "references/missing.md"',
    );
  });

  it('does not parse a four-space indented reference definition as Markdown', async () => {
    const skillRoot = await createRuntimeSkill(
      '    [example]: <references\\missing-example.md>\n',
    );

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('ignores protocol-relative and URI-scheme Markdown destinations', async () => {
    const skillRoot = await createRuntimeSkill([
      '[protocol relative](//example.com/references/missing.md)',
      '[custom scheme](vscode://file/references/missing.md)',
      '[data](data:text/plain,references/missing.md)',
    ].join('\n'));

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('decodes only the Markdown path before applying local closure boundaries', async () => {
    const skillRoot = await createRuntimeSkill([
      '[query](references/guide.md?target=..%2Foutside.md)',
      '[source query](references/guide.md?source=..%2Foutside.md)',
      '[fragment](references/guide.md#target=..%2Foutside.md)',
    ].join('\n'), {
      'references/guide.md': 'guide\n',
    });

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it.each([
    ['encoded traversal', '[unsafe](references%2F..%2Foutside.md)', 'references%2F..%2Foutside.md'],
    ['encoded parent traversal', '[unsafe](%2e%2e%2foutside.md)', '%2e%2e%2foutside.md'],
    ['malformed percent escape', '[unsafe](references/guide%2.md)', 'references/guide%2.md'],
    ['POSIX absolute path', '[unsafe](/tmp/outside.md)', '/tmp/outside.md'],
    ['Windows drive path', '[unsafe](C:/outside.md)', 'C:/outside.md'],
    ['Windows drive-relative path', '[unsafe](C:outside.md)', 'C:outside.md'],
    ['Windows drive-relative numeric path', '[unsafe](C:12)', 'C:12'],
    ['Windows root-relative path', '[unsafe](\\outside\\file.md)', '\\outside\\file.md'],
    ['Windows UNC path', '[unsafe](\\\\server\\share\\file.md)', '\\\\server\\share\\file.md'],
    ['Windows parent traversal', '[unsafe](..\\outside.md)', '..\\outside.md'],
    ['Markdown Windows environment token', '[unsafe](references/%NAME%.md)', 'references/%NAME%.md'],
  ])('rejects %s after Markdown destination normalization', async (
    _name,
    content,
    lexicalTarget,
  ) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      `markdown-link target ${JSON.stringify(lexicalTarget)}`,
    );
  });

  it('ignores arbitrary absolute inline paths and complete Windows environment tokens', async () => {
    const skillRoot = await createRuntimeSkill([
      '`cat /tmp/references/missing.md`',
      '`type C:\\temp\\references\\missing.md`',
      '`type \\\\server\\share\\missing.md`',
      '`C:external.txt`',
      '`%SKILL_ROOT%\\references\\missing.md`',
    ].join('\n'));

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('accepts the current bundled Skill closures', async () => {
    const pluginsRoot = path.resolve(import.meta.dirname, '../../plugins-dist/plugins');
    const pluginEntries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    for (const pluginEntry of pluginEntries) {
      if (!pluginEntry.isDirectory()) continue;
      for (const platform of ['claude', 'codex']) {
        const skillsRoot = path.join(pluginsRoot, pluginEntry.name, platform, 'skills');
        if (await fs.pathExists(skillsRoot)) {
          await expect(validateRuntimeSkillClosuresRoot(skillsRoot)).resolves.toBeUndefined();
        }
      }
    }
  });

  it('does not exempt a Windows environment placeholder embedded in an inline local path', async () => {
    const skillRoot = await createRuntimeSkill('`type assets/%NAME%.svg`\n');

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'inline-command target "assets/%NAME%.svg"',
    );
  });

  it('keeps known core absolute and relative traversal inline paths in the local gate', async () => {
    const absoluteSkillRoot = await createRuntimeSkill('`cat /references/missing.md`\n');
    await expect(validateRuntimeSkillClosure(absoluteSkillRoot)).rejects.toThrow(
      'inline-command target "/references/missing.md"',
    );

    const traversalSkillRoot = await createRuntimeSkill('`cat ..\\outside.md`\n');
    await expect(validateRuntimeSkillClosure(traversalSkillRoot)).rejects.toThrow(
      'inline-command target "..\\\\outside.md"',
    );

    const nestedTraversalSkillRoot = await createRuntimeSkill('`cat notes/../outside.md`\n');
    await expect(validateRuntimeSkillClosure(nestedTraversalSkillRoot)).rejects.toThrow(
      'inline-command target "notes/../outside.md"',
    );
  });

  it('rejects missing Markdown resources with the skill key and lexical target', async () => {
    const skillRoot = await createRuntimeSkill('[missing](references/missing.md)\n');

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'skill "demo-skill" markdown-link target "references/missing.md"',
    );
  });

  it('rejects missing core resources named in plain Agent-facing text', async () => {
    const skillRoot = await createRuntimeSkill(
      'Read references/missing-policy.md before deciding.\n',
    );

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'skill "demo-skill" plain-text target "references/missing-policy.md"',
    );
  });

  it('rejects a missing runtime dependency reached through a reference', async () => {
    const skillRoot = await createRuntimeSkill(
      '[guide](references/guide.md)\n',
      {
        'references/guide.md': 'Run `node scripts/missing.mjs`.\n',
      },
    );

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'skill "demo-skill" inline-command target "scripts/missing.mjs" from "references/guide.md"',
    );
  });

  it('terminates safely when reachable Agent-facing references form a cycle', async () => {
    const skillRoot = await createRuntimeSkill(
      '[guide](references/guide.md)\n',
      {
        'references/guide.md': '[details](details.md)\n',
        'references/details.md': '[guide](guide.md)\n',
      },
    );

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it.each([
    ['root file', '[policy](POLICY.md)', 'POLICY.md'],
    ['nested file', '[guide](sub/guide.md)', 'sub/guide.md'],
  ])('rejects a missing ordinary relative Markdown %s', async (
    _name,
    content,
    lexicalTarget,
  ) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      `skill "demo-skill" markdown-link target ${JSON.stringify(lexicalTarget)}`,
    );
  });

  it('accepts existing ordinary relative Markdown files', async () => {
    const skillRoot = await createRuntimeSkill(
      '[policy](POLICY.md)\n[guide](sub/guide.md)\n',
      {
        'POLICY.md': 'policy\n',
        'sub/guide.md': 'guide\n',
      },
    );

    await expect(validateRuntimeSkillClosure(skillRoot)).resolves.toBeUndefined();
  });

  it('rejects missing providers referenced by inline commands', async () => {
    const skillRoot = await createRuntimeSkill('`node providers/missing.mjs`\n');

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'skill "demo-skill" inline-command target "providers/missing.mjs"',
    );
  });

  it.each([
    ['parent traversal', '[unsafe](../outside.md)', '../outside.md'],
    ['absolute path', '[unsafe](/references/outside.md)', '/references/outside.md'],
    ['backslash path', '[unsafe](references\\outside.md)', 'references\\outside.md'],
  ])('rejects %s references', async (_name, content, lexicalTarget) => {
    const skillRoot = await createRuntimeSkill(`${content}\n`);

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      `skill "demo-skill" markdown-link target ${JSON.stringify(lexicalTarget)}`,
    );
  });

  it('rejects directory targets because runtime references must resolve to regular files', async () => {
    const skillRoot = await createRuntimeSkill('[directory](references/)\n', {
      'references/guide.md': 'guide\n',
    });

    await expect(validateRuntimeSkillClosure(skillRoot)).rejects.toThrow(
      'target "references/" is not a regular file',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects final and intermediate symbolic links without exposing their referents',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-skill-symlink-'));
      tempDirs.push(root);
      const outsideRoot = path.join(root, 'private-referent');
      await fs.outputFile(path.join(outsideRoot, 'secret.md'), 'secret\n', 'utf8');

      const finalLinkSkill = await createRuntimeSkill('[guide](references/guide.md)\n');
      await fs.ensureDir(path.join(finalLinkSkill, 'references'));
      await fs.symlink(
        path.join(outsideRoot, 'secret.md'),
        path.join(finalLinkSkill, 'references', 'guide.md'),
      );
      const finalLinkError = await validateRuntimeSkillClosure(finalLinkSkill).catch(
        (error: unknown) => error,
      );
      expect(finalLinkError).toBeInstanceOf(Error);
      expect((finalLinkError as Error).message).toContain('symbolic link');
      expect((finalLinkError as Error).message).not.toContain('private-referent');

      const intermediateLinkSkill = await createRuntimeSkill('[guide](references/guide.md)\n');
      await fs.symlink(outsideRoot, path.join(intermediateLinkSkill, 'references'));
      const intermediateLinkError = await validateRuntimeSkillClosure(intermediateLinkSkill).catch(
        (error: unknown) => error,
      );
      expect(intermediateLinkError).toBeInstanceOf(Error);
      expect((intermediateLinkError as Error).message).toContain('symbolic link');
      expect((intermediateLinkError as Error).message).not.toContain('private-referent');
    },
  );

  it('makes the real bundle path fail before returning a missing Skill resource', async () => {
    const repoRoot = await makeTempRepo();
    const skillPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      'skills',
      'commit',
      'SKILL.md',
    );
    await fs.appendFile(skillPath, '\n[missing projection](references/projected.md)\n', 'utf8');

    await expect(createSyntheticEmbeddedRoot(repoRoot)).rejects.toThrow(
      'target "references/projected.md"',
    );
  });

  it('rechecks final projected target bytes against recorded provenance', async () => {
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-projection-freshness-'));
    tempDirs.push(outputRoot);
    const targetPath = path.join(
      outputRoot,
      'codex',
      'skills',
      'demo',
      'references',
      'projected.json',
    );
    await fs.outputFile(targetPath, 'projected\n', 'utf8');
    const digest = 'sha256:997d78afe9decd97dc223f43ac067dd28b1ed16ff2d5a9c83afc52ff517f7520';
    const provenance = [{
      platform: 'codex' as const,
      skill: 'demo',
      target: 'references/projected.json',
      sourceDigest: digest,
      targetDigest: digest,
    }];

    await expect(
      validateSkillRuntimeProjectionFreshness(outputRoot, provenance),
    ).resolves.toBeUndefined();

    await fs.writeFile(targetPath, 'changed\n', 'utf8');
    await expect(
      validateSkillRuntimeProjectionFreshness(outputRoot, provenance),
    ).rejects.toThrow('skill "demo" projection target "references/projected.json"');
  });
});
