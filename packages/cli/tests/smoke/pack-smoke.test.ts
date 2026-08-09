import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterAll, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { execPnpmForTest } from '../helpers/pnpm.js';

const execFileAsync = promisify(execFile);
const sharedTempBase = os.tmpdir();
const tempDirs: string[] = [];
let packedCliPromise: Promise<{
  packageRoot: string;
  tempRoot: string;
  snapshotEntriesBefore: string[];
  snapshotEntriesAfter: string[];
}> | null = null;

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
  const rootPath = await fs.mkdtemp(path.join(sharedTempBase, prefix));
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

async function listBuildSnapshotEntries(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, '.release', 'build-snapshots')).catch(() => []))
    .filter((entry) => entry.startsWith('build-'))
    .sort();
}

async function preparePackedCli(): Promise<{
  packageRoot: string;
  tempRoot: string;
  snapshotEntriesBefore: string[];
  snapshotEntriesAfter: string[];
}> {
  if (packedCliPromise) {
    const packed = await packedCliPromise;
    registerSmokeWritableRoot(packed.tempRoot, 'shared pack smoke temp root');
    return packed;
  }

  packedCliPromise = (async () => {
    const root = repoRoot();
    const tempRoot = await createSmokeTempRoot('aw-pack-smoke-', 'pack smoke temp root');
    const packDir = path.join(tempRoot, 'pack');
    const unpackDir = path.join(tempRoot, 'unpack');
    registerSmokeWritableRoot(packDir, 'pack smoke tarball staging root');
    registerSmokeWritableRoot(unpackDir, 'pack smoke tarball unpack root');
    await fs.ensureDir(packDir);
    await fs.ensureDir(unpackDir);

    const snapshotEntriesBefore = await listBuildSnapshotEntries(root);
    const packed = await execPnpmForTest(
      ['pack:cli', '--pack-destination', packDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    expect(packed.stdout).toContain('Packed tarball:');
    const snapshotEntriesAfter = await listBuildSnapshotEntries(root);
    expect(snapshotEntriesAfter).toEqual(snapshotEntriesBefore);

    return {
      packageRoot: await unpackSingleTarball(packDir, unpackDir),
      tempRoot,
      snapshotEntriesBefore,
      snapshotEntriesAfter,
    };
  })();
  return packedCliPromise;
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('pack smoke', () => {
  it('packs the CLI tarball without the staged plugins-dist snapshot', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');

    const packageJson = await fs.readJson(path.join(packageRoot, 'package.json'));
    expect(packageJson.files).toEqual(['dist/']);
    expect(packageJson.scripts.prepack).toBe('pnpm --dir ../.. build:ensure');

    const {
      packageRoot: unpackedPackageRoot,
      snapshotEntriesBefore,
      snapshotEntriesAfter,
    } = await preparePackedCli();
    const unpackedFiles = await listFilesRecursively(unpackedPackageRoot);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'dist', 'index.js'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'plugins-dist'))).resolves.toBe(false);
    expect(unpackedFiles.some((file) => file.startsWith('plugins-dist/'))).toBe(false);
    expect(unpackedFiles.some((file) => file === 'node_modules' || file.startsWith('node_modules/')))
      .toBe(false);
    expect(unpackedFiles.some((file) => file.includes('build-snapshots'))).toBe(false);
    expect(unpackedFiles.some((file) => file.startsWith('.release/'))).toBe(false);
    expect(snapshotEntriesAfter).toEqual(snapshotEntriesBefore);
    await expect(fs.readJson(path.join(unpackedPackageRoot, 'package.json'))).resolves.toMatchObject({
      name: '@yiliang/aw',
      files: ['dist/'],
    });
  });

  it('bundles public slashCommands correctly from the unpacked tarball runtime', async () => {
    const root = repoRoot();
    const packageRoot = path.join(root, 'packages', 'cli');
    const { packageRoot: unpackedPackageRoot, tempRoot } = await preparePackedCli();
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'pack smoke slash commands repo root');
    registerSmokeWritableRoot(outputRoot, 'pack smoke slash commands output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', 'slashCommands-only'),
      path.join(tempRepo, 'plugins', 'slash-commands-only'),
    );

    await fs.ensureSymlink(
      path.join(packageRoot, 'node_modules'),
      path.join(unpackedPackageRoot, 'node_modules'),
    );
    await installCurrentSmokeDistIsolationBridge(unpackedPackageRoot);

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
