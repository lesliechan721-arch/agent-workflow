import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

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

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function createSmokeTempRoot(prefix: string, source: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootPath);
  return registerSmokeWritableRoot(rootPath, source);
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      files.push(...nested.map((file) => path.join(entry.name, file).split(path.sep).join('/')));
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

async function unpackSingleTarball(packDir: string, unpackDir: string): Promise<string> {
  const tarballs = (await fs.readdir(packDir)).filter((entry) => entry.endsWith('.tgz'));
  expect(tarballs).toHaveLength(1);
  await execFileAsync(
    'tar',
    ['-xzf', path.join(packDir, tarballs[0]), '-C', unpackDir],
    {
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return path.join(unpackDir, 'package');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('pack smoke', () => {
  it('packs the CLI tarball without the staged plugins-dist snapshot', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const tempRoot = await createSmokeTempRoot('aw-pack-smoke-', 'pack smoke temp root');

    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
    registerSmokeWritableRoot(packDir, 'pack smoke tarball staging root');
    registerSmokeWritableRoot(unpackDir, 'pack smoke tarball unpack root');
    await fs.ensureDir(packDir);
    await fs.ensureDir(unpackDir);

    const packageJson = await fs.readJson(path.join(packageRoot, 'package.json'));
    expect(packageJson.files).toEqual(['dist/']);
    expect(packageJson.scripts.prepack).toBe('pnpm build');
    const staleDistPath = path.join(packageRoot, 'dist', 'stale-build-sentinel.js');
    await fs.outputFile(staleDistPath, 'export const stale = true;\n', 'utf8');

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
    const unpackedPackageRoot = await unpackSingleTarball(packDir, unpackDir);
    const unpackedFiles = await listFilesRecursively(unpackedPackageRoot);
    await expect(fs.pathExists(staleDistPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'dist', 'index.js'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'plugins-dist'))).resolves.toBe(false);
    expect(unpackedFiles).not.toContain('dist/stale-build-sentinel.js');
    expect(unpackedFiles.some((file) => file.startsWith('plugins-dist/'))).toBe(false);
    await expect(fs.readJson(path.join(unpackedPackageRoot, 'package.json'))).resolves.toMatchObject({
      name: '@yiliang/aw',
      files: ['dist/'],
    });
  });

  it('bundles public slashCommands correctly from the unpacked tarball runtime', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const tempRoot = await createSmokeTempRoot(
      'aw-pack-slash-commands-',
      'pack smoke slash commands temp root',
    );

    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(packDir, 'pack smoke slash commands tarball staging root');
    registerSmokeWritableRoot(unpackDir, 'pack smoke slash commands unpack root');
    registerSmokeWritableRoot(tempRepo, 'pack smoke slash commands repo root');
    registerSmokeWritableRoot(outputRoot, 'pack smoke slash commands output root');
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
