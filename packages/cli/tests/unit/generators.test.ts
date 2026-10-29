import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { parseTOML } from 'toml-eslint-parser';
import { afterEach, describe, expect, it } from 'vitest';

import { generateAgentArtifacts } from '../../src/generators/agents.js';
import { renderHooksArtifact, renderResolvedHooksArtifact } from '../../src/generators/hooks.js';
import {
  bundleLocalPlugin,
  type PluginStagingRunner,
  validateStagingPackageManager,
} from '../../src/generators/local-plugin.js';
import {
  generateCodexPermissionArtifacts,
  mergeClaudePermissions,
} from '../../src/generators/permissions.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolveCliPackageRoot } from '../../src/utils/paths.js';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

interface FakeDependencyPackage {
  dependencies?: Record<string, string>;
  installedDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  physicalPackageName?: string;
  os?: string[];
  source?: string;
  version?: string;
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-plugin-'));
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

async function writeNodePackageFixture(
  pluginRoot: string,
  options: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {},
): Promise<void> {
  await fs.ensureDir(path.join(pluginRoot, 'scripts'));
  await fs.writeJson(
    path.join(pluginRoot, 'scripts', 'package.json'),
    {
      name: 'git-commit-scripts',
      version: '0.1.0',
      type: 'module',
      dependencies: options.dependencies ?? {},
      devDependencies: options.devDependencies ?? {},
    },
    { spaces: 2 },
  );
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
}

function createFakeStagingRunner(
  dependencyPackages: Record<string, FakeDependencyPackage> = {},
  options: { absoluteLinks?: boolean } = {},
): PluginStagingRunner {
  async function writeInstalledPackage(
    packageRoot: string,
    dependencyName: string,
    options: FakeDependencyPackage = {},
  ): Promise<string> {
    const physicalPackageName = options.physicalPackageName ?? dependencyName;
    const version = options.version ?? '1.0.0';
    const storeName = `${physicalPackageName.replace('/', '+')}@${version}`;
    const dependencyRoot = path.join(
      packageRoot,
      'node_modules',
      '.pnpm',
      storeName,
      'node_modules',
      ...physicalPackageName.split('/'),
    );
    await fs.ensureDir(dependencyRoot);
    await fs.writeJson(
      path.join(dependencyRoot, 'package.json'),
      {
        name: physicalPackageName,
        version,
        main: 'index.js',
        dependencies: options.dependencies,
        optionalDependencies: options.optionalDependencies,
        peerDependencies: options.peerDependencies,
        peerDependenciesMeta: options.peerDependenciesMeta,
        os: options.os,
        scripts: dependencyName === 'bad-install-script'
          ? {
              postinstall: 'node postinstall.js',
            }
          : undefined,
      },
      { spaces: 2 },
    );
    await fs.writeFile(
      path.join(dependencyRoot, 'index.js'),
      options.source ?? 'module.exports = {};\n',
      'utf8',
    );

    const topLevelPackage = path.join(packageRoot, 'node_modules', ...dependencyName.split('/'));
    await fs.ensureDir(path.dirname(topLevelPackage));
    await fs.remove(topLevelPackage);
    const symlinkTarget = options.absoluteLinks || process.platform === 'win32'
      ? dependencyRoot
      : path.relative(path.dirname(topLevelPackage), dependencyRoot);
    await fs.symlink(symlinkTarget, topLevelPackage, process.platform === 'win32' ? 'junction' : 'dir');
    return dependencyRoot;
  }

  return {
    async installPackageRoot(packageRoot) {
      const packageJson = await fs.readJson(path.join(packageRoot, 'package.json'));
      const dependencies = packageJson.dependencies ?? {};
      const devDependencies = packageJson.devDependencies ?? {};
      await fs.ensureDir(path.join(packageRoot, 'node_modules'));
      const installedPackageDirs = new Map<string, string>();
      for (const dependencyName of Object.keys({
        ...dependencies,
        ...devDependencies,
        ...dependencyPackages,
      })) {
        installedPackageDirs.set(dependencyName, await writeInstalledPackage(
          packageRoot,
          dependencyName,
          dependencyPackages[dependencyName],
        ));
      }
      for (const [dependencyName, dependencyPackage] of Object.entries(dependencyPackages)) {
        const importerDir = installedPackageDirs.get(dependencyName);
        if (!importerDir) {
          continue;
        }
        for (const [installedName, installedPackageKey] of Object.entries(
          dependencyPackage.installedDependencies ?? {},
        )) {
          const installedPackageDir = installedPackageDirs.get(installedPackageKey);
          if (!installedPackageDir) {
            throw new Error(`Missing fake installed package "${installedPackageKey}".`);
          }
          const entryPath = path.join(importerDir, 'node_modules', ...installedName.split('/'));
          await fs.ensureDir(path.dirname(entryPath));
          await fs.symlink(
            options.absoluteLinks || process.platform === 'win32'
              ? installedPackageDir
              : path.relative(path.dirname(entryPath), installedPackageDir),
            entryPath,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
      }
    },
    async runNodeBuild({ pluginRoot }) {
      const buildOutputPath = path.join(pluginRoot, 'scripts', 'build-output.json');
      if (!(await fs.pathExists(buildOutputPath))) {
        return;
      }

      const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
      const [manifest, patch] = await Promise.all([
        fs.readJson(manifestPath),
        fs.readJson(buildOutputPath),
      ]);
      await fs.writeJson(manifestPath, { ...manifest, ...patch }, { spaces: 2 });
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local-plugin generator', () => {
  it('rejects missing or mismatched packageRoot pnpm versions before staging', async () => {
    const repoRoot = await makeTempRepo();
    const packageRoot = path.join(repoRoot, 'package-root');
    const cliPackageJson = await fs.readJson(
      path.join(resolveCliPackageRoot(), 'package.json'),
    ) as { dependencies: { pnpm: string } };
    const supportedPackageManager = `pnpm@${cliPackageJson.dependencies.pnpm}`;
    await fs.ensureDir(packageRoot);
    await fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: 'staging-package',
      version: '1.0.0',
    });

    await expect(validateStagingPackageManager(packageRoot)).rejects.toThrow(
      `expected "${supportedPackageManager}"`,
    );

    await fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: 'staging-package',
      version: '1.0.0',
      packageManager: 'pnpm@9.0.0',
    });
    await expect(validateStagingPackageManager(packageRoot)).rejects.toThrow(
      `expected "${supportedPackageManager}"`,
    );

    await fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: 'staging-package',
      version: '1.0.0',
      packageManager: supportedPackageManager,
    });
    await expect(validateStagingPackageManager(packageRoot)).resolves.toBe(
      supportedPackageManager,
    );
  });

  it('generates Claude and Codex runtime manifests with explicit bundle-local paths', async () => {
    const repoRoot = await makeTempRepo();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'evals', 'manifest.json'),
      '{}\n',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'commit', 'reports', 'run-1', 'summary.json'),
      '{}\n',
    );
    plugin.manifest.extensions ??= {};
    plugin.manifest.extensions.hooks ??= [];
    plugin.manifest.extensions.hooks.push({
      event: 'session_start',
      command: 'echo shared session start',
    });
    plugin.manifest.extensions.nativeHooks = {
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
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);

    const result = await bundleLocalPlugin(plugin, outputRoot);

    for (const platform of ['claude', 'codex']) {
      await expect(
        fs.pathExists(path.join(outputRoot, platform, 'skills', 'commit', 'evals')),
      ).resolves.toBe(false);
      await expect(
        fs.pathExists(path.join(outputRoot, platform, 'skills', 'commit', 'reports')),
      ).resolves.toBe(false);
    }

    expect(Object.keys(result.platformManifests).sort()).toEqual(['claude', 'codex']);
    expect(result.platformManifests).toMatchObject({
      claude: {
        skills: './claude/skills',
        hooks: './claude/hooks/hooks.json',
        agents: ['./claude/agents/aw-git-commit-commit-reviewer.md'],
      },
      codex: {
        skills: './codex/skills',
        hooks: {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo git hook' }],
              },
            ],
            SessionStart: [
              {
                matcher: 'startup|resume|clear',
                hooks: [{ type: 'command', command: 'echo shared session start' }],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [{ type: 'command', command: 'echo codex prompt' }],
              },
            ],
          },
        },
      },
    });

    await expect(
      fs.readJson(path.join(outputRoot, '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      hooks: {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo git hook' }],
            },
          ],
          SessionStart: [
            {
              matcher: 'startup|resume|clear',
              hooks: [{ type: 'command', command: 'echo shared session start' }],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [{ type: 'command', command: 'echo codex prompt' }],
            },
          ],
        },
      },
    });
    await expect(
      fs.pathExists(path.join(outputRoot, 'codex', 'hooks', 'hooks.json')),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(outputRoot, 'claude', 'agents', 'aw-git-commit-commit-reviewer.md'), 'utf8'),
    ).resolves.toContain('name: "commit-reviewer"');
    await expect(
      fs.pathExists(path.join(outputRoot, 'codex', 'skills', 'commit', 'SKILL.md')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'claude', 'hooks', 'hooks.json')),
    ).resolves.toEqual({
      hooks: {
        Notification: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo claude notification' }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [{ type: 'command', command: 'echo shared session start' }],
          },
        ],
      },
    });
  });

  it('excludes top-level Skill author directories but preserves nested domain directories', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await Promise.all([
      fs.outputFile(
        path.join(pluginRoot, 'README.md'),
        '# Git Commit\n\nPlugin documentation.\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'commit', 'README.md'),
        '# Commit\n\nCommit report summary ships with the Skill.\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'commit', 'evals', 'manifest.json'),
        '{}\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'commit', 'references', 'evals', 'contract.md'),
        '# Eval contract\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'reports', 'commit', 'batch-1', 'summary.json'),
        '{}\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'SKILL.md'),
        '---\nname: dynamic\ndescription: Test dynamic Skill.\n---\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'README.md'),
        '# Dynamic\n\nDynamic report summary ships with the Skill.\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'evals', 'manifest.json'),
        '{}\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'references', 'evals', 'contract.md'),
        '# Dynamic eval contract\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'base', 'SKILL.md'),
        '---\nname: dynamic\ndescription: Test rendered dynamic Skill.\n---\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'base', 'README.md'),
        '# Dynamic\n\nRendered dynamic report summary ships with the Skill.\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'base', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'dynamic', 'base', 'evals', 'private.json'),
        '{"secret":"author-only"}\n',
      ),
    ]);
    manifest.artifacts = {
      targets: [
        {
          id: 'dynamic-skill',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'dynamic',
          sourceDirs: ['./skills/dynamic', './skills/dynamic/base'],
        },
        {
          id: 'dynamic-claude-skill',
          platform: 'claude',
          scopes: ['user', 'project'],
          target: 'claude.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'dynamic',
          sourceDirs: ['./skills/dynamic', './skills/dynamic/base'],
        },
      ],
    };
    manifest.buildConfig = {
      fileRules: {
        claude: { include: ['**/*'], exclude: [] },
        codex: { include: ['**/*'], exclude: [] },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);
    await bundleLocalPlugin(plugin, outputRoot);

    for (const platform of ['claude', 'codex']) {
      await expect(fs.pathExists(path.join(
        outputRoot,
        platform,
        'skills',
        'commit',
        'evals',
      ))).resolves.toBe(false);
      await expect(fs.readFile(path.join(
        outputRoot,
        platform,
        'skills',
        'commit',
        'references',
        'evals',
        'contract.md',
      ), 'utf8')).resolves.toBe('# Eval contract\n');
      await expect(fs.pathExists(path.join(
        outputRoot,
        platform,
        'reports',
        'commit',
      ))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(
        outputRoot,
        platform,
        'skills',
        'dynamic',
        'SKILL.md',
      ))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(
        outputRoot,
        platform,
        'reports',
      ))).resolves.toBe(false);
    }
    const dynamicSourceRoot = path.join(
      outputRoot,
      '.agents-plugin',
      'artifact-sources',
      'codex',
      'dynamic-skill',
      '0',
    );
    await expect(fs.pathExists(path.join(dynamicSourceRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(dynamicSourceRoot, 'README.md'))).resolves.toBe(true);
    await expect(fs.readFile(path.join(dynamicSourceRoot, 'README.md'), 'utf8')).resolves.toContain(
      'Dynamic report summary ships with the Skill.',
    );
    await expect(fs.pathExists(path.join(dynamicSourceRoot, 'evals'))).resolves.toBe(false);
    await expect(fs.readFile(path.join(
      dynamicSourceRoot,
      'references',
      'evals',
      'contract.md',
    ), 'utf8')).resolves.toBe('# Dynamic eval contract\n');
    await expect(fs.readJson(path.join(
      dynamicSourceRoot,
      'base',
      'evals',
      'private.json',
    ))).resolves.toEqual({ secret: 'author-only' });
    await expect(fs.pathExists(path.join(dynamicSourceRoot, 'reports'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      outputRoot,
      '.agents-plugin',
      'artifact-sources',
      'codex',
      'dynamic-skill',
      '1',
      'evals',
    ))).resolves.toBe(false);
    await expect(fs.readFile(path.join(
      outputRoot,
      '.agents-plugin',
      'artifact-sources',
      'codex',
      'dynamic-skill',
      '1',
      'README.md',
    ), 'utf8')).resolves.toContain('Rendered dynamic report summary ships with the Skill.');
    await expect(fs.readFile(path.join(outputRoot, 'README.md'), 'utf8')).resolves.toContain(
      'Plugin documentation.',
    );
    await expect(fs.readFile(
      path.join(outputRoot, 'codex', 'skills', 'commit', 'README.md'),
      'utf8',
    )).resolves.toContain('Commit report summary ships with the Skill.');
  });

  it('rejects a reserved requirements receipt at a dynamic sourceDirs root', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    delete manifest.skills;
    manifest.artifacts = {
      targets: [{
        id: 'dynamic-commit',
        platform: 'codex',
        scopes: ['user'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'commit',
        sourceDirs: ['./skills/commit'],
      }],
    };
    await Promise.all([
      writeFixturePluginManifest(repoRoot, manifest),
      fs.outputJson(
        path.join(pluginRoot, 'skills', 'commit', 'aw-plugin-requirements.json'),
        { reserved: true },
      ),
    ]);

    const plugin = await readPluginManifest(pluginRoot);
    await expect(bundleLocalPlugin(
      plugin,
      path.join(repoRoot, 'out', plugin.manifest.name),
    )).rejects.toThrow('source root cannot declare reserved file aw-plugin-requirements.json');
  });

  it('does not declare a static Codex skills root for user-only dynamic codex.skill targets', async () => {
    const repoRoot = await makeTempRepo();
    const manifest = await readFixturePluginManifest(repoRoot);
    delete manifest.skills;
    manifest.config = {
      fields: {
        explorerModel: {
          type: 'string',
          default: 'gpt-5.4-mini',
        },
      },
    };
    manifest.artifacts = {
      targets: [
        {
          id: 'dynamic-explore-skill',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: ['explorerModel'],
          skillKey: 'dynamic-explore',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', 'skills'));

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);
    const result = await bundleLocalPlugin(plugin, outputRoot);

    expect(result.platformManifests.codex?.skills).toBeUndefined();
    await expect(
      fs.readJson(path.join(outputRoot, '.codex-plugin', 'plugin.json')),
    ).resolves.not.toHaveProperty('skills');
    await expect(fs.pathExists(path.join(outputRoot, 'codex', 'skills'))).resolves.toBe(false);
  });

  it('generates only Codex bundle outputs for Codex-only plugins and removes stale Claude outputs', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    manifest.marketplace.policy.products = ['CODEX'];
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);
    await fs.outputFile(path.join(outputRoot, '.claude-plugin', 'plugin.json'), '{"stale":true}\n', 'utf8');
    await fs.outputFile(path.join(outputRoot, 'claude', 'stale.txt'), 'stale\n', 'utf8');

    const result = await bundleLocalPlugin(plugin, outputRoot);

    expect(Object.keys(result.platformManifests)).toEqual(['codex']);
    expect(result.platformManifests.codex).toMatchObject({
      skills: './codex/skills',
      mcpServers: './codex/.mcp.json',
      apps: './codex/.app.json',
    });
    expect(result.platformManifests.claude).toBeUndefined();
    await expect(fs.pathExists(path.join(outputRoot, '.codex-plugin', 'plugin.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'codex', 'skills', 'commit', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, '.claude-plugin'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(outputRoot, 'claude'))).resolves.toBe(false);
  });

  it('generates only Claude bundle outputs for Claude-only plugins', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    manifest.marketplace.policy.products = ['CLAUDE'];
    delete manifest.apps;
    await writeFixturePluginManifest(repoRoot, manifest);
    await fs.remove(path.join(pluginRoot, '.app.json'));

    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);

    const result = await bundleLocalPlugin(plugin, outputRoot);

    expect(Object.keys(result.platformManifests)).toEqual(['claude']);
    expect(result.platformManifests.claude).toMatchObject({
      skills: './claude/skills',
      mcpServers: './claude/.mcp.json',
      agents: ['./claude/agents/aw-git-commit-commit-reviewer.md'],
    });
    expect(result.platformManifests.codex).toBeUndefined();
    await expect(fs.pathExists(path.join(outputRoot, '.claude-plugin', 'plugin.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'claude', 'skills', 'commit', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, '.codex-plugin'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(outputRoot, 'codex'))).resolves.toBe(false);
  });

  it('bundles slashCommands only for the final supported platforms', async () => {
    const pluginRoot = fixturePath(
      'codex-project-repo-managed',
      'plugins',
      'slashCommands-only',
    );

    const claudeOnlyPlugin = await readPluginManifest(pluginRoot);
    claudeOnlyPlugin.manifest.marketplace.policy.products = ['CLAUDE'];
    const claudeOutputRoot = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-claude-bundle-')),
      'bundle',
    );
    tempDirs.push(path.dirname(claudeOutputRoot));
    const claudeResult = await bundleLocalPlugin(claudeOnlyPlugin, claudeOutputRoot);

    expect(Object.keys(claudeResult.platformManifests)).toEqual(['claude']);
    await expect(
      fs.readFile(path.join(claudeOutputRoot, 'claude', 'commands', 'review.md'), 'utf8'),
    ).resolves.toContain('argument-hint: "[path]"');
    await expect(fs.pathExists(path.join(claudeOutputRoot, 'codex'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(claudeOutputRoot, '.codex-plugin'))).resolves.toBe(false);

    const codexOnlyPlugin = await readPluginManifest(pluginRoot);
    codexOnlyPlugin.manifest.marketplace.policy.products = ['CODEX'];
    const codexOutputRoot = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'aw-slash-commands-codex-bundle-')),
      'bundle',
    );
    tempDirs.push(path.dirname(codexOutputRoot));
    const codexResult = await bundleLocalPlugin(codexOnlyPlugin, codexOutputRoot);

    expect(Object.keys(codexResult.platformManifests)).toEqual(['codex']);
    await expect(
      fs.readFile(path.join(codexOutputRoot, 'codex', 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Run `git status` and `git diff` yourself');
    await expect(
      fs.pathExists(path.join(codexOutputRoot, 'codex', 'skills', 'review', 'assets', 'review-16.svg')),
    ).resolves.toBe(true);
    await expect(fs.pathExists(path.join(codexOutputRoot, 'claude'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(codexOutputRoot, '.claude-plugin'))).resolves.toBe(false);
  });

  it('renders Claude agents with frontmatter and Codex agents as valid role-file TOML', () => {
    const [claudeArtifact] = generateAgentArtifacts(
      'git-commit',
      [
        {
          name: 'commit-reviewer',
          description: '检查提交范围和信息是否匹配。',
          prompt: '请检查这次提交是否符合提交规范，并指出 scope 是否准确。',
          tools: ['shell'],
        },
      ],
      'claude',
    );
    expect(claudeArtifact).toMatchObject({
      relativePath: 'agents/aw-git-commit-commit-reviewer.md',
    });
    expect(claudeArtifact.content).toContain('name: "commit-reviewer"');
    expect(claudeArtifact.content).toContain('description:');
    expect(claudeArtifact.content).toContain('tools:');
    expect(claudeArtifact.content).toContain('请检查这次提交是否符合提交规范');

    const [codexArtifact] = generateAgentArtifacts(
      'git-commit',
      [
        {
          name: 'commit-reviewer',
          description: '检查提交范围和信息是否匹配。',
          prompt: '请检查这次提交是否符合提交规范，并指出 scope 是否准确。',
          tools: ['shell'],
        },
      ],
      'codex',
    );
    expect(codexArtifact).toMatchObject({
      relativePath: 'agents/aw-git-commit-commit-reviewer.toml',
    });
    const parsed = parseTOML(codexArtifact.content);
    const rendered = parsed.body[0];
    expect(rendered.type).toBe('TOMLTopLevelTable');
    expect(codexArtifact.content).toContain('name = "commit-reviewer"');
    expect(codexArtifact.content).toContain('description = "检查提交范围和信息是否匹配。');
    expect(codexArtifact.content).toContain('developer_instructions =');
    expect(codexArtifact.content).not.toContain('tools =');
  });

  it('renders public hook event mappings for Claude and Codex runtime contracts', () => {
    const claudeArtifact = renderHooksArtifact([
      {
        event: 'after_tool',
        matcher: 'Edit',
        command: 'echo after',
      },
      {
        event: 'session_start',
        command: 'echo start',
      },
    ], 'claude');
    const codexArtifact = renderHooksArtifact([
      {
        event: 'before_tool',
        matcher: 'Write',
        command: 'echo before',
      },
    ], 'codex');

    expect(claudeArtifact?.content).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo after' }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [{ type: 'command', command: 'echo start' }],
          },
        ],
      },
    });
    expect(codexArtifact?.content).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo before' }],
          },
        ],
      },
    });
  });

  it('renders hook groups in stable canonical order', () => {
    const artifact = renderResolvedHooksArtifact([
      {
        kind: 'public',
        event: 'before_tool',
        matcher: 'Write',
        command: 'echo write',
      },
      {
        kind: 'public',
        event: 'before_tool',
        matcher: 'Edit',
        command: 'echo edit',
      },
    ], 'codex');

    expect(artifact?.content).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo edit' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo write' }],
          },
        ],
      },
    });
  });

  it('renders native hooks alongside public hooks and omits matcher for matcherless events', () => {
    const claudeArtifact = renderResolvedHooksArtifact([
      {
        kind: 'public',
        event: 'after_tool',
        matcher: 'Edit',
        command: 'echo after',
      },
      {
        kind: 'native',
        event: 'Stop',
        command: 'echo stop',
      },
    ], 'claude');
    const codexArtifact = renderResolvedHooksArtifact([
      {
        kind: 'public',
        event: 'before_tool',
        matcher: 'Write',
        command: 'echo before',
      },
      {
        kind: 'native',
        event: 'UserPromptSubmit',
        command: 'echo prompt',
      },
    ], 'codex');

    expect(claudeArtifact?.content).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo after' }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo stop' }],
          },
        ],
      },
    });
    expect(codexArtifact?.content).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo before' }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo prompt' }],
          },
        ],
      },
    });
  });

  it('renders permissions into platform-native allow, prompt, and forbidden rules', () => {
    const permissions = [
      {
        name: 'git-ops',
        allow: ['git status'],
        ask: ['git commit'],
        deny: ['git push'],
      },
    ];

    expect(mergeClaudePermissions(permissions)).toEqual({
      allow: ['Bash(git status)'],
      ask: ['Bash(git commit)'],
      deny: ['Bash(git push)'],
    });
    expect(generateCodexPermissionArtifacts('git-commit', permissions)[0].content).toContain(
      'prefix_rule(pattern = ["git","push"], decision = "forbidden")',
    );
    expect(generateCodexPermissionArtifacts('git-commit', permissions)[0].content).toContain(
      'prefix_rule(pattern = ["git","commit"], decision = "prompt")',
    );
  });

  it('resolves managed permissions to the same narrow command in both platforms', () => {
    const id = `cmdp_${'a'.repeat(64)}`;
    const command = { set: 'guide', key: 'subagent', variant: 'default' };
    const entry = { command, argsPrefix: ['wait'] };
    const permissions = [{ name: 'guide', allow: [entry, entry], sandbox: { excludedCommands: [entry] } }];
    const resolve = (reference: typeof command) => {
      expect(reference).toEqual(command);
      return id;
    };
    expect(mergeClaudePermissions(permissions, resolve)).toEqual({
      allow: [`Bash(aw command run ${id} -- wait *)`], ask: [], deny: [],
      excludedCommands: [`aw command run ${id} -- wait *`],
    });
    const rule = generateCodexPermissionArtifacts('guide', permissions, resolve)[0].content;
    expect(rule).toContain(`prefix_rule(pattern = ["aw","command","run","${id}","--","wait"], decision = "allow")`);
    expect(rule.match(/prefix_rule/gu)).toHaveLength(1);
    expect(mergeClaudePermissions([{ name: 'sandbox-only', sandbox: { excludedCommands: [entry] } }], resolve).allow)
      .toEqual([]);
    expect(() => mergeClaudePermissions(permissions)).toThrow('commandReferenceInvalid');
    expect(() => mergeClaudePermissions(permissions, () => 'other')).toThrow('commandReferenceInvalid');
    expect(() => mergeClaudePermissions([{ name: 'unsafe', allow: [{ command, argsPrefix: ['wait *'] }] }], resolve))
      .toThrow();
  });

  it('rejects permission prefixes with shell control characters', () => {
    expect(() =>
      mergeClaudePermissions([
        {
          name: 'unsafe',
          allow: ['git;rm -rf'],
        },
      ]),
    ).toThrow('shell control characters');

    expect(() =>
      generateCodexPermissionArtifacts('git-commit', [
        {
          name: 'unsafe',
          allow: ['git && rm'],
        },
      ]),
    ).toThrow('shell control characters');
  });

  it('rejects scripts.node plugins in build-free mode with a deterministic error', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot);
    manifest.scripts = {
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    await expect(
      bundleLocalPlugin(plugin, path.join(repoRoot, 'out', 'git-commit')),
    ).rejects.toThrow('build-free mode');
  });

  it('rejects unsupported platform build fields before writing bundle outputs', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const plugin = await readPluginManifest(pluginRoot);

    plugin.manifest.marketplace = {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    };
    plugin.manifest.buildConfig = {
      manifestOverrides: {
        claude: {
          userConfig: {
            theme: 'dark',
          },
        },
      },
    };

    await expect(
      bundleLocalPlugin(plugin, path.join(repoRoot, 'out', 'git-commit'), {
        buildMode: 'prepared',
      }),
    ).rejects.toThrow(
      'Invalid plugin "git-commit": buildConfig.manifestOverrides.claude requires CLAUDE support, but marketplace.policy.products=[CODEX].',
    );
  });

  it('uses the staging manifest as the marketplace and bundle truth without modifying source', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'build.mjs'), 'export {};\n', 'utf8');
    await fs.writeJson(
      path.join(pluginRoot, 'scripts', 'build-output.json'),
      {
        description: 'Built description',
        version: '9.9.9',
      },
      { spaces: 2 },
    );
    manifest.description = 'Source description';
    manifest.version = '0.1.0';
    manifest.scripts = {
      node: {
        packageRoot: './scripts',
        build: {
          runner: 'node',
          path: './scripts/build.mjs',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const outputRoot = path.join(repoRoot, 'out');
    await bundlePlugins({
      repoRoot,
      outputRoot,
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner(),
    });

    await expect(
      fs.readJson(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toMatchObject({
      plugins: [
        {
          name: 'git-commit',
          description: 'Built description',
        },
      ],
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: 'Built description',
      version: '9.9.9',
      scripts: {
        node: {
          packageRoot: './scripts',
        },
      },
    });
    await expect(
      fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: 'Source description',
      version: '0.1.0',
    });
  });

  it('rejects removed catalog status preflight requirements introduced by a staging build', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'build.mjs'), 'export {};\n', 'utf8');
    manifest.scripts = {
      node: {
        packageRoot: './scripts',
        build: {
          runner: 'node',
          path: './scripts/build.mjs',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const stagingRunner = createFakeStagingRunner();
    stagingRunner.runNodeBuild = async ({ pluginRoot: stagedPluginRoot }) => {
      await fs.appendFile(
        path.join(stagedPluginRoot, 'skills', 'commit', 'SKILL.md'),
        '\n```bash\naw catalog status --preflight --json\n```\n',
        'utf8',
      );
    };

    await expect(bundleLocalPlugin(
      await readPluginManifest(pluginRoot),
      path.join(repoRoot, 'out', 'git-commit'),
      {
        buildMode: 'staging',
        stagingRunner,
        strictRequirements: true,
      },
    )).rejects.toMatchObject({
      code: 'awCapabilityStrictRequirements',
      message: expect.stringContaining('capability="<unmapped>"'),
    });
  });

  it('rejects staging builds that change plugin name', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'build.mjs'), 'export {};\n', 'utf8');
    await fs.writeJson(path.join(pluginRoot, 'scripts', 'build-output.json'), { name: 'renamed' }, { spaces: 2 });
    manifest.scripts = {
      node: {
        packageRoot: './scripts',
        build: {
          runner: 'node',
          path: './scripts/build.mjs',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    await expect(
      bundlePlugins({
        repoRoot,
        outputRoot: path.join(repoRoot, 'out'),
        buildMode: 'staging',
        stagingRunner: createFakeStagingRunner(),
      }),
    ).rejects.toThrow('build changed plugin name');
  });

  it('copies preApply, helper/runtime closure, and production package files into the bundle', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        chalk: '^5.0.0',
      },
      devDependencies: {
        vitest: '^3.0.0',
      },
    });
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'linux.mjs'), 'import chalk from "chalk";\nimport "./shared.mjs";\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'aw-config.mjs'), 'import "./config-shared.mjs";\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'shared.mjs'), 'export const shared = true;\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'config-shared.mjs'), 'export const config = true;\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.test.mjs'), 'throw new Error("test-only");\n', 'utf8');
    manifest.scripts = {
      preApply: { path: './scripts/linux.mjs' },
      helpers: {
        config: './scripts/aw-config.mjs',
      },
      node: {
        packageRoot: './scripts',
      },
      tests: {
        node: ['./scripts/*.test.mjs'],
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    await bundleLocalPlugin(plugin, outputRoot, {
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner(),
    });

    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'linux.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'shared.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'config-shared.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'package.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'pnpm-lock.yaml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', 'chalk', 'package.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', 'vitest'))).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', '.pnpm', 'chalk@1.0.0', 'node_modules', 'chalk', 'package.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', '.pnpm', 'vitest@1.0.0')),
    ).resolves.toBe(false);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'lifecycle.test.mjs'))).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      scripts: {
        preApply: { path: './scripts/linux.mjs' },
        helpers: {
          config: './scripts/aw-config.mjs',
        },
        node: {
          packageRoot: './scripts',
        },
      },
    });
    const bundleManifest = await fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json'));
    expect(bundleManifest.scripts.tests).toBeUndefined();
    expect(bundleManifest.scripts.node.build).toBeUndefined();
  });

  it('keeps the vendored WASM closure runnable for an existing config helper', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    const runtimeRoot = path.join(pluginRoot, 'scripts', 're2-wasm');
    await fs.ensureDir(path.join(runtimeRoot, 'build', 'src'));
    await fs.ensureDir(path.join(runtimeRoot, 'build', 'wasm'));
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'aw-config.mjs'),
      [
        "import fs from 'node:fs';",
        "import './re2-wasm/build/src/re2.js';",
        "for (const file of ['./re2-wasm/build/wasm/re2.wasm', './re2-wasm/LICENSE']) {",
        '  if (!fs.existsSync(new URL(file, import.meta.url))) throw new Error(`Missing ${file}`);',
        '}',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(runtimeRoot, 'build', 'src', 're2.js'),
      "import '../wasm/re2.js';\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(runtimeRoot, 'build', 'wasm', 're2.js'),
      'export const RE2 = true;\n',
      'utf8',
    );
    await fs.writeFile(path.join(runtimeRoot, 'build', 'wasm', 're2.wasm'), 'wasm fixture', 'utf8');
    await fs.writeFile(path.join(runtimeRoot, 'LICENSE'), 'license fixture\n', 'utf8');
    manifest.scripts = {
      helpers: { config: './scripts/aw-config.mjs' },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    await bundleLocalPlugin(await readPluginManifest(pluginRoot), outputRoot);

    await expect(execFileAsync(
      process.execPath,
      [path.join(outputRoot, 'scripts', 'aw-config.mjs')],
      { cwd: outputRoot },
    )).resolves.toMatchObject({ stderr: '' });
  });

  it('copies installed darwin and linux transitive optional dependencies into an isolated runnable bundle', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'runtime-host': '^1.0.0',
      },
    });
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'lifecycle.mjs'),
      [
        'import value from "runtime-host";',
        'if (value !== "required-peer:optional-peer:optional-darwin:optional-linux") {',
        '  throw new Error(`Unexpected dependency closure: ${value}`);',
        '}',
      ].join('\n'),
      'utf8',
    );
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    await bundleLocalPlugin(await readPluginManifest(pluginRoot), outputRoot, {
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner({
        'runtime-host': {
          optionalDependencies: {
            'optional-darwin': '^1.0.0',
            'optional-linux': '^1.0.0',
          },
          peerDependencies: {
            'optional-peer': '^1.0.0',
            'required-peer': '^1.0.0',
            'uninstalled-optional-peer': '^1.0.0',
          },
          peerDependenciesMeta: {
            'optional-peer': { optional: true },
            'uninstalled-optional-peer': { optional: true },
          },
          source: [
            'module.exports = [',
            '  require("required-peer"),',
            '  require("optional-peer"),',
            '  require("optional-darwin"),',
            '  require("optional-linux"),',
            '].join(":");',
            '',
          ].join('\n'),
        },
        'required-peer': { source: 'module.exports = "required-peer";\n' },
        'optional-peer': { source: 'module.exports = "optional-peer";\n' },
        'optional-darwin': {
          os: ['darwin'],
          source: 'module.exports = "optional-darwin";\n',
        },
        'optional-linux': {
          os: ['linux'],
          source: 'module.exports = "optional-linux";\n',
        },
      }),
    });

    const nodeModules = path.join(outputRoot, 'scripts', 'node_modules');
    const runtimeHost = path.join(nodeModules, 'runtime-host');
    expect((await fs.lstat(runtimeHost)).isSymbolicLink()).toBe(false);
    for (const dependencyName of [
      'required-peer',
      'optional-peer',
      'optional-darwin',
      'optional-linux',
    ]) {
      const dependencyPath = path.join(runtimeHost, 'node_modules', dependencyName);
      expect((await fs.lstat(dependencyPath)).isSymbolicLink()).toBe(false);
    }
    for (const dependencyName of ['uninstalled-optional-peer']) {
      await expect(
        fs.pathExists(path.join(runtimeHost, 'node_modules', dependencyName)),
      ).resolves.toBe(false);
    }
    await expect(execFileAsync(
      process.execPath,
      [path.join(outputRoot, 'scripts', 'lifecycle.mjs')],
      { cwd: outputRoot },
    )).resolves.toMatchObject({ stderr: '' });
  });

  it('materializes absolute directory-link installs into a runnable portable bundle', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'runtime-host': '^1.0.0',
      },
    });
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'lifecycle.mjs'),
      'import value from "runtime-host";\nif (value !== "portable") throw new Error("not portable");\n',
      'utf8',
    );
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    await bundleLocalPlugin(await readPluginManifest(pluginRoot), outputRoot, {
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner({
        'runtime-host': { source: 'module.exports = "portable";\n' },
      }, { absoluteLinks: true }),
    });

    const bundledDependency = path.join(outputRoot, 'scripts', 'node_modules', 'runtime-host');
    expect((await fs.lstat(bundledDependency)).isSymbolicLink()).toBe(false);
    await expect(execFileAsync(
      process.execPath,
      [path.join(outputRoot, 'scripts', 'lifecycle.mjs')],
      { cwd: outputRoot },
    )).resolves.toMatchObject({ stderr: '' });
  });

  it('rejects a transitive optional dependency missing from the cross-platform install', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'runtime-host': '^1.0.0',
      },
    });
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import "runtime-host";\n', 'utf8');
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    await expect(bundleLocalPlugin(
      await readPluginManifest(pluginRoot),
      path.join(repoRoot, 'out', 'git-commit'),
      {
        buildMode: 'staging',
        stagingRunner: createFakeStagingRunner({
          'runtime-host': {
            optionalDependencies: {
              'optional-linux': '^1.0.0',
            },
          },
        }),
      },
    )).rejects.toThrow('missing transitive optional dependency "optional-linux"');
  });

  it('preserves two npm aliases to one physical package in an isolated runnable bundle', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'yaml-a': 'npm:yaml@1.0.0',
        'yaml-b': 'npm:yaml@1.0.0',
      },
    });
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'lifecycle.mjs'),
      [
        'import value from "yaml-b";',
        'if (value !== "shared-child") {',
        '  throw new Error(`Unexpected alias runtime value: ${value}`);',
        '}',
      ].join('\n'),
      'utf8',
    );
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    const yamlAliasPackage: FakeDependencyPackage = {
      physicalPackageName: 'yaml',
      dependencies: {
        'shared-child': '^1.0.0',
      },
      source: 'module.exports = require("shared-child");\n',
    };
    await bundleLocalPlugin(await readPluginManifest(pluginRoot), outputRoot, {
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner({
        'yaml-a': yamlAliasPackage,
        'yaml-b': yamlAliasPackage,
        'shared-child': { source: 'module.exports = "shared-child";\n' },
      }),
    });

    const nodeModules = path.join(outputRoot, 'scripts', 'node_modules');
    const yamlA = path.join(nodeModules, 'yaml-a');
    const yamlB = path.join(nodeModules, 'yaml-b');
    expect((await fs.lstat(yamlA)).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(yamlB)).isSymbolicLink()).toBe(false);
    await expect(fs.readJson(path.join(yamlA, 'package.json'))).resolves.toMatchObject({ name: 'yaml' });
    await expect(fs.readJson(path.join(yamlB, 'package.json'))).resolves.toMatchObject({ name: 'yaml' });
    await expect(execFileAsync(
      process.execPath,
      [path.join(outputRoot, 'scripts', 'lifecycle.mjs')],
      { cwd: outputRoot },
    )).resolves.toMatchObject({ stderr: '' });
  });

  it('preserves nested resolutions of two versions of the same package', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'host-a': '^1.0.0',
        'host-b': '^1.0.0',
      },
    });
    await fs.writeFile(
      path.join(pluginRoot, 'scripts', 'lifecycle.mjs'),
      [
        'import hostA from "host-a";',
        'import hostB from "host-b";',
        'if (`${hostA}:${hostB}` !== "v1:v2") {',
        '  throw new Error(`Unexpected versions: ${hostA}:${hostB}`);',
        '}',
      ].join('\n'),
      'utf8',
    );
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    await bundleLocalPlugin(await readPluginManifest(pluginRoot), outputRoot, {
      buildMode: 'staging',
      stagingRunner: createFakeStagingRunner({
        'host-a': {
          dependencies: { shared: '^1.0.0' },
          installedDependencies: { shared: 'shared-v1' },
          source: 'module.exports = require("shared");\n',
        },
        'host-b': {
          dependencies: { shared: '^2.0.0' },
          installedDependencies: { shared: 'shared-v2' },
          source: 'module.exports = require("shared");\n',
        },
        'shared-v1': {
          physicalPackageName: 'shared',
          version: '1.0.0',
          source: 'module.exports = "v1";\n',
        },
        'shared-v2': {
          physicalPackageName: 'shared',
          version: '2.0.0',
          source: 'module.exports = "v2";\n',
        },
      }),
    });

    await expect(execFileAsync(
      process.execPath,
      [path.join(outputRoot, 'scripts', 'lifecycle.mjs')],
      { cwd: outputRoot },
    )).resolves.toMatchObject({ stderr: '' });
    await expect(
      fs.readJson(path.join(outputRoot, 'scripts', 'node_modules', 'host-a', 'node_modules', 'shared', 'package.json')),
    ).resolves.toMatchObject({ version: '1.0.0' });
    await expect(
      fs.readJson(path.join(outputRoot, 'scripts', 'node_modules', 'host-b', 'node_modules', 'shared', 'package.json')),
    ).resolves.toMatchObject({ version: '2.0.0' });
  });

  it('rejects a missing transitive required peer dependency', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'runtime-host': '^1.0.0',
      },
    });
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import "runtime-host";\n', 'utf8');
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    await expect(bundleLocalPlugin(
      await readPluginManifest(pluginRoot),
      path.join(repoRoot, 'out', 'git-commit'),
      {
        buildMode: 'staging',
        stagingRunner: createFakeStagingRunner({
          'runtime-host': {
            peerDependencies: {
              'required-peer': '^1.0.0',
            },
          },
        }),
      },
    )).rejects.toThrow('missing production dependency "required-peer"');
  });

  it('rejects production dependency closure install scripts after final staging install', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot, {
      dependencies: {
        'bad-install-script': '^1.0.0',
      },
    });
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import bad from "bad-install-script";\n', 'utf8');
    manifest.scripts = {
      preApply: { path: './scripts/lifecycle.mjs' },
      node: {
        packageRoot: './scripts',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    await expect(
      bundleLocalPlugin(plugin, path.join(repoRoot, 'out', 'git-commit'), {
        buildMode: 'staging',
        stagingRunner: createFakeStagingRunner(),
      }),
    ).rejects.toThrow('declares unsupported "postinstall" script');
  });
});
