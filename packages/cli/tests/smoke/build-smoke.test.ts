import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { writeNodeScriptFixture } from '../support/plugin-scripts-node-fixture.js';

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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('build smoke', () => {
  it('runs pnpm build and produces plugins-dist through the compiled bundle script', async () => {
    const root = repoRoot();
    const outputRoot = path.join(root, 'packages', 'cli', 'plugins-dist');
    await fs.remove(outputRoot);

    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    await expect(
      fs.pathExists(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
    });

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('starts the real dist entry and reads the bundled plugins-dist', async () => {
    const root = repoRoot();
    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    await expect(
      execFileAsync('node', ['packages/cli/dist/index.js', '--help'], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Usage: aw'),
    });

    await expect(
      execFileAsync(
        'node',
        ['packages/cli/dist/index.js', 'install', 'git-commit', '--skill-trigger', 'sometimes'],
        {
          cwd: root,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Unsupported skill trigger preference "sometimes"'),
    });

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dist-entry-'));
    tempDirs.push(tempRoot);
    const awHome = path.join(tempRoot, 'aw-home');
    await expect(
      execFileAsync('node', ['packages/cli/dist/index.js', 'init', '--force'], {
        cwd: root,
        env: {
          ...process.env,
          AW_HOME: awHome,
        },
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('local marketplace'),
    });
    await expect(
      fs.pathExists(path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toBe(true);
  });

  it('bundles declared MCP, app and native hook assets through the compiled bundle script', async () => {
    const root = repoRoot();
    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-smoke-assets-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const manifestPath = path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo smoke claude notification',
        },
      ],
      codex: [
        {
          event: 'Stop',
          command: 'echo smoke codex stop',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const { bundlePlugins } = (await import(
      '../../dist/scripts/bundle-plugins.js'
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', '.mcp.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'codex', '.app.json')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'Notification',
              matcher: '*',
              command: 'echo smoke claude notification',
            },
          ],
          codex: [
            {
              event: 'Stop',
              command: 'echo smoke codex stop',
            },
          ],
        },
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'hooks', 'hooks.json')),
    ).resolves.toMatchObject({
      hooks: {
        Notification: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo smoke claude notification' }],
          },
        ],
      },
    });

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('bundles public slashCommands through the compiled bundler without shipping raw source directories', async () => {
    const root = repoRoot();
    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-smoke-slash-commands-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', 'slashCommands-only'),
      path.join(tempRepo, 'plugins', 'slash-commands-only'),
    );

    const { bundlePlugins } = (await import(
      '../../dist/scripts/bundle-plugins.js'
    )) as { bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown> };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    const pluginRoot = path.join(outputRoot, 'plugins', 'slash-commands-only');
    await expect(
      fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      slashCommands: './slash-commands',
    });
    await expect(
      fs.pathExists(path.join(pluginRoot, 'claude', 'commands', 'review.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'SKILL.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'agents', 'openai.yaml')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'codex', 'skills', 'review', 'assets', 'review-16.svg')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'slash-commands', 'review.md')),
    ).resolves.toBe(false);
    await expect(
      fs.readFile(path.join(pluginRoot, 'codex', 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).resolves.not.toContain('$ARGUMENTS');

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('bundles scripts.node plugins through the compiled staging bundle path', async () => {
    const root = repoRoot();
    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-smoke-scripts-node-'));
    tempDirs.push(tempRoot);
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await writeNodeScriptFixture(tempRepo);

    const { bundlePlugins } = (await import(
      '../../dist/scripts/bundle-plugins.js'
    )) as {
      bundlePlugins: (options: {
        repoRoot: string;
        outputRoot: string;
        buildMode: 'staging';
      }) => Promise<unknown>;
    };
    await bundlePlugins({ repoRoot: tempRepo, outputRoot, buildMode: 'staging' });

    const pluginRoot = path.join(outputRoot, 'plugins', 'git-commit');
    const bundleManifest = await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
    expect(bundleManifest).toMatchObject({
      description: 'Built smoke description',
      marketplace: {
        policy: {
          products: ['CODEX'],
        },
      },
      scripts: {
        lifecycle: {
          install: {
            default: {
              runner: 'node',
              path: './scripts/runtime.mjs',
            },
          },
        },
        node: {
          packageRoot: './scripts',
        },
      },
    });
    expect(bundleManifest.scripts.tests).toBeUndefined();
    expect(bundleManifest.scripts.node.build).toBeUndefined();

    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', 'yaml', 'package.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', 'fs-extra')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', '.pnpm', 'fs-extra@11.3.4')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', '.pnpm', 'universalify@2.0.1')),
    ).resolves.toBe(false);

    const runtime = (await import(
      pathToFileURL(path.join(pluginRoot, 'scripts', 'runtime.mjs')).href
    )) as { parseSmokeConfig: (source: string) => string };
    expect(runtime.parseSmokeConfig('name: bundle\n')).toBe('bundle:runtime-helper');

    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: expect.not.stringContaining('Built smoke description'),
      marketplace: {
        policy: {
          products: ['CLAUDE'],
        },
      },
      scripts: {
        tests: {
          node: ['./scripts/source-only.test.mjs'],
        },
      },
    });

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  }, 120_000);
});
