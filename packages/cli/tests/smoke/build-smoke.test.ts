import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('bundles declared MCP and app assets through the compiled bundle script', async () => {
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

    const { validateBundleLayout } = (await import(
      '../../src/utils/bundle-layout.js'
    )) as { validateBundleLayout: (rootDir: string) => Promise<void> };
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });
});
