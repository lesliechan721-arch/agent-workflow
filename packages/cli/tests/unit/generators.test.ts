import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { parseTOML } from 'toml-eslint-parser';
import { afterEach, describe, expect, it } from 'vitest';

import { generateAgentArtifacts } from '../../src/generators/agents.js';
import { renderHooksArtifact, renderResolvedHooksArtifact } from '../../src/generators/hooks.js';
import {
  bundleLocalPlugin,
  type PluginStagingRunner,
} from '../../src/generators/local-plugin.js';
import {
  generateCodexPermissionArtifacts,
  mergeClaudePermissions,
} from '../../src/generators/permissions.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';

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

function createFakeStagingRunner(): PluginStagingRunner {
  async function writeInstalledPackage(
    packageRoot: string,
    dependencyName: string,
    options: { dependencies?: Record<string, string> } = {},
  ): Promise<void> {
    const storeName = `${dependencyName.replace('/', '+')}@1.0.0`;
    const dependencyRoot = path.join(
      packageRoot,
      'node_modules',
      '.pnpm',
      storeName,
      'node_modules',
      ...dependencyName.split('/'),
    );
    await fs.ensureDir(dependencyRoot);
    await fs.writeJson(
      path.join(dependencyRoot, 'package.json'),
      {
        name: dependencyName,
        version: '1.0.0',
        main: 'index.js',
        dependencies: options.dependencies,
        scripts: dependencyName === 'bad-install-script'
          ? {
              postinstall: 'node postinstall.js',
            }
          : undefined,
      },
      { spaces: 2 },
    );
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), 'module.exports = {};\n', 'utf8');

    const topLevelPackage = path.join(packageRoot, 'node_modules', ...dependencyName.split('/'));
    await fs.ensureDir(path.dirname(topLevelPackage));
    await fs.remove(topLevelPackage);
    const symlinkTarget = process.platform === 'win32'
      ? dependencyRoot
      : path.relative(path.dirname(topLevelPackage), dependencyRoot);
    await fs.symlink(symlinkTarget, topLevelPackage, process.platform === 'win32' ? 'junction' : 'dir');
  }

  return {
    async installPackageRoot(packageRoot) {
      const packageJson = await fs.readJson(path.join(packageRoot, 'package.json'));
      const dependencies = packageJson.dependencies ?? {};
      const devDependencies = packageJson.devDependencies ?? {};
      await fs.ensureDir(path.join(packageRoot, 'node_modules'));
      for (const dependencyName of Object.keys({ ...dependencies, ...devDependencies })) {
        await writeInstalledPackage(packageRoot, dependencyName);
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
  it('generates Claude and Codex runtime manifests with explicit bundle-local paths', async () => {
    const repoRoot = await makeTempRepo();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
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

    expect(result.claudeManifest).toMatchObject({
      skills: './claude/skills',
      hooks: './claude/hooks/hooks.json',
      agents: ['./claude/agents/aw-git-commit-commit-reviewer.md'],
    });
    expect(result.codexManifest).toMatchObject({
      skills: './codex/skills',
    });

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

  it('preserves dependencies only in the bundle source manifest and filters them from platform manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    manifest.dependencies = {
      plugins: [
        {
          name: 'shared-helper',
          target: {
            scope: 'user',
          },
          when: {
            platforms: ['codex'],
          },
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(repoRoot, 'out', 'git-commit');
    const result = await bundleLocalPlugin(plugin, outputRoot);

    await expect(
      fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      dependencies: {
        plugins: [
          {
            name: 'shared-helper',
            target: {
              scope: 'user',
            },
            when: {
              platforms: ['codex'],
            },
          },
        ],
      },
    });
    expect(result.claudeManifest).not.toHaveProperty('dependencies');
    expect(result.codexManifest).not.toHaveProperty('dependencies');
    await expect(
      fs.readJson(path.join(outputRoot, '.claude-plugin', 'plugin.json')),
    ).resolves.not.toHaveProperty('dependencies');
    await expect(
      fs.readJson(path.join(outputRoot, '.codex-plugin', 'plugin.json')),
    ).resolves.not.toHaveProperty('dependencies');
  });

  it('revalidates staging manifests after scripts.node.build rewrites dependencies', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeNodePackageFixture(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'build.mjs'), 'export {};\n', 'utf8');
    await fs.writeJson(
      path.join(pluginRoot, 'scripts', 'build-output.json'),
      {
        dependencies: {
          plugins: [
            {
              name: 'shared-helper',
              version: '^1.0.0',
            },
          ],
        },
      },
      { spaces: 2 },
    );
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

    const plugin = await readPluginManifest(pluginRoot);
    await expect(
      bundleLocalPlugin(plugin, path.join(repoRoot, 'out', 'git-commit'), {
        buildMode: 'staging',
        stagingRunner: createFakeStagingRunner(),
      }),
    ).rejects.toThrow('unknown field "version"');
  });

  it('copies lifecycle selectors, helper/runtime closure, and production package files into the bundle', async () => {
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
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'darwin.mjs'), 'import "./shared.mjs";\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'windows.mjs'), 'import "./shared.mjs";\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'aw-config.mjs'), 'import "./config-shared.mjs";\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'shared.mjs'), 'export const shared = true;\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'config-shared.mjs'), 'export const config = true;\n', 'utf8');
    await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.test.mjs'), 'throw new Error("test-only");\n', 'utf8');
    manifest.scripts = {
      lifecycle: {
        install: {
          linux: { runner: 'node', path: './scripts/linux.mjs' },
          darwin: { runner: 'node', path: './scripts/darwin.mjs' },
          win32: { runner: 'node', path: './scripts/windows.mjs' },
        },
      },
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
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'darwin.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'windows.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'shared.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'config-shared.mjs'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'package.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'pnpm-lock.yaml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', 'chalk', 'package.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', 'vitest'))).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', '.pnpm', 'chalk@1.0.0', 'node_modules', 'chalk', 'package.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'scripts', 'node_modules', '.pnpm', 'vitest@1.0.0')),
    ).resolves.toBe(false);
    await expect(fs.pathExists(path.join(outputRoot, 'scripts', 'lifecycle.test.mjs'))).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(outputRoot, '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      scripts: {
        lifecycle: {
          install: {
            linux: { path: './scripts/linux.mjs' },
            darwin: { path: './scripts/darwin.mjs' },
            win32: { path: './scripts/windows.mjs' },
          },
        },
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
      lifecycle: {
        install: './scripts/lifecycle.mjs',
      },
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
