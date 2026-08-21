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
  cliTarballPath: string;
  evalTarballPath: string;
  tempRoot: string;
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

async function unpackTarball(tarballPath: string, unpackDir: string): Promise<string> {
  await execFileAsync(
    'tar',
    ['-xzf', tarballPath, '-C', unpackDir],
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

async function installDeclaredDependencyOnlyView(
  unpackedPackageRoot: string,
  workspacePackageRoot: string,
): Promise<void> {
  const packageJson = await fs.readJson(
    path.join(unpackedPackageRoot, 'package.json'),
  ) as { dependencies?: Record<string, string> };
  const nodeModulesRoot = path.join(unpackedPackageRoot, 'node_modules');
  await fs.remove(nodeModulesRoot);
  await fs.ensureDir(nodeModulesRoot);

  for (const dependencyName of Object.keys(packageJson.dependencies ?? {}).sort()) {
    const sourceDependency = path.join(
      workspacePackageRoot,
      'node_modules',
      ...dependencyName.split('/'),
    );
    const targetDependency = path.join(nodeModulesRoot, ...dependencyName.split('/'));
    await expect(fs.pathExists(sourceDependency)).resolves.toBe(true);
    await fs.ensureDir(path.dirname(targetDependency));
    await fs.symlink(
      sourceDependency,
      targetDependency,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

async function preparePackedCli(): Promise<{
  packageRoot: string;
  cliTarballPath: string;
  evalTarballPath: string;
  tempRoot: string;
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

    const packageRoot = path.join(root, 'packages', 'cli');
    const staleDistPath = path.join(packageRoot, 'dist', 'stale-build-sentinel.js');
    await fs.outputFile(staleDistPath, 'export const stale = true;\n', 'utf8');
    const snapshotEntriesBefore = await listBuildSnapshotEntries(root);
    await execPnpmForTest(
      ['pack:cli', '--pack-destination', packDir],
      {
        cwd: root,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await expect(fs.pathExists(staleDistPath)).resolves.toBe(false);
    const snapshotEntriesAfter = await listBuildSnapshotEntries(root);
    expect(snapshotEntriesAfter).toEqual(snapshotEntriesBefore);

    const tarballs = (await fs.readdir(packDir))
      .filter((entry) => entry.endsWith('.tgz'))
      .sort();
    expect(tarballs).toHaveLength(2);
    const cliTarballName = tarballs.find((entry) => entry.includes('-aw-'));
    const evalTarballName = tarballs.find((entry) => entry.includes('-agent-skill-eval-'));
    expect(cliTarballName).toBeDefined();
    expect(evalTarballName).toBeDefined();
    const cliTarballPath = path.join(packDir, cliTarballName!);
    const evalTarballPath = path.join(packDir, evalTarballName!);

    return {
      packageRoot: await unpackTarball(cliTarballPath, unpackDir),
      cliTarballPath,
      evalTarballPath,
      tempRoot,
    };
  })();
  return packedCliPromise;
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('pack smoke', () => {
  it('installs both local tarballs into a clean prefix and runs both package bins', async () => {
    const { packageRoot, cliTarballPath, evalTarballPath, tempRoot } = await preparePackedCli();
    const installPrefix = path.join(tempRoot, 'install-prefix');
    registerSmokeWritableRoot(installPrefix, 'pack smoke clean npm install prefix');
    await fs.ensureDir(installPrefix);

    await execFileAsync(
      'npm',
      [
        'install',
        '--global',
        '--prefix',
        installPrefix,
        evalTarballPath,
        cliTarballPath,
      ],
      {
        cwd: tempRoot,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const cliPackageJson = await fs.readJson(path.join(packageRoot, 'package.json')) as {
      version: string;
    };
    const binRoot = process.platform === 'win32' ? installPrefix : path.join(installPrefix, 'bin');
    const awBin = path.join(binRoot, process.platform === 'win32' ? 'aw.cmd' : 'aw');
    const evalBin = path.join(
      binRoot,
      process.platform === 'win32' ? 'aw-skill-eval.cmd' : 'aw-skill-eval',
    );
    await expect(execFileAsync(awBin, ['--version'], {
      cwd: tempRoot,
      env: process.env,
    })).resolves.toMatchObject({ stdout: `${cliPackageJson.version}\n`, stderr: '' });
    await expect(execFileAsync(awBin, ['plugin', '--help'], {
      cwd: tempRoot,
      env: process.env,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining('check-versions'),
      stderr: '',
    });

    const authorRepo = path.join(tempRoot, 'author-repo');
    registerSmokeWritableRoot(authorRepo, 'pack smoke plugin author repository');
    await fs.copy(fixturePath('repo-template'), authorRepo);
    await execFileAsync(awBin, [
      'plugin',
      'init',
      'validate-fixture',
      '--description',
      'A deterministic fixture for the packed CLI validator.',
      '--no-skills',
      '--repo-root',
      authorRepo,
    ], { cwd: authorRepo, env: process.env });
    const validation = await execFileAsync(awBin, [
      'plugin',
      'validate',
      path.join(authorRepo, 'plugins', 'validate-fixture'),
      '--json',
    ], { cwd: authorRepo, env: process.env });
    expect(JSON.parse(validation.stdout)).toMatchObject({
      ok: true,
      profile: 'aw-source',
    });
    expect(validation.stderr).toBe('');

    await execFileAsync(awBin, [
      'plugin',
      'init',
      'author-smoke',
      '--description',
      'A deterministic fixture for packed CLI scaffolding.',
      '--skill-description',
      'Create and validate a deterministic packed CLI authoring fixture.',
      '--skill-short-description',
      'Create a packed CLI authoring fixture.',
      '--repo-root',
      authorRepo,
      '--plugin-root',
      'tools/author-smoke',
    ], { cwd: authorRepo, env: process.env });
    await execFileAsync(awBin, [
      'plugin',
      'add-skill',
      'author-smoke',
      '--skill-name',
      'second-skill',
      '--skill-description',
      'Add a second deterministic Skill from the packed CLI runtime.',
      '--skill-short-description',
      'Add a second packed CLI Skill fixture.',
      '--repo-root',
      authorRepo,
      '--plugin-root',
      'tools/author-smoke',
    ], { cwd: authorRepo, env: process.env });
    await expect(fs.pathExists(path.join(
      authorRepo,
      'tools',
      'author-smoke',
      'skills',
      'second-skill',
      'SKILL.md',
    ))).resolves.toBe(true);
    const capabilities = await execFileAsync(evalBin, ['capabilities', '--json'], {
      cwd: tempRoot,
      env: process.env,
    });
    expect(JSON.parse(capabilities.stdout)).toMatchObject({
      provider: 'aw-skill-eval-process',
    });
    expect(capabilities.stderr).toBe('');

    if (process.platform !== 'win32') {
      const installedEvalRoot = path.join(
        installPrefix,
        'lib',
        'node_modules',
        '@lesliechan721',
        'agent-skill-eval',
      );
      expect((await fs.lstat(installedEvalRoot)).isSymbolicLink()).toBe(false);
    }
  });

  it('packs the CLI tarball without the staged plugins-dist snapshot', async () => {
    const packageRoot = path.join(repoRoot(), 'packages', 'cli');
    const { packageRoot: unpackedPackageRoot } = await preparePackedCli();
    const unpackedFiles = await listFilesRecursively(unpackedPackageRoot);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'dist', 'index.js'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      unpackedPackageRoot,
      'dist',
      'authoring',
      'scripts',
      'validate-plugin.mjs',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(
      unpackedPackageRoot,
      'dist',
      'authoring',
      'assets',
      'aw-config.mjs',
    ))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(unpackedPackageRoot, 'plugins-dist'))).resolves.toBe(false);
    expect(unpackedFiles).not.toContain('dist/stale-build-sentinel.js');
    expect(unpackedFiles.some((file) => file.startsWith('plugins-dist/'))).toBe(false);
    expect(unpackedFiles.some((file) => file === 'node_modules' || file.startsWith('node_modules/')))
      .toBe(false);
    expect(unpackedFiles.some((file) => file.includes('build-snapshots'))).toBe(false);
    expect(unpackedFiles.some((file) => file.startsWith('.release/'))).toBe(false);
    const unpackedPackageJson = await fs.readJson(
      path.join(unpackedPackageRoot, 'package.json'),
    ) as {
      version: string;
      dependencies: Record<string, string>;
      bin: Record<string, string>;
    };
    expect(unpackedPackageJson).toMatchObject({
      name: '@lesliechan721/aw',
      engines: {
        node: '>=22',
      },
      files: ['dist/'],
    });
    expect(unpackedPackageJson.dependencies['@lesliechan721/agent-skill-eval'])
      .toBe(unpackedPackageJson.version);
    expect(unpackedPackageJson.bin).toEqual({ aw: './dist/index.js' });

    await installDeclaredDependencyOnlyView(unpackedPackageRoot, packageRoot);
    await expect(execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), '--version'],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).resolves.toMatchObject({
      stdout: `${unpackedPackageJson.version}\n`,
      stderr: '',
    });
    await expect(execFileAsync(
      process.execPath,
      [path.join(unpackedPackageRoot, 'dist', 'index.js'), '--help'],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).resolves.toMatchObject({
      stdout: expect.stringContaining('Usage: aw'),
      stderr: '',
    });

    const criticalImports = [
      path.join(unpackedPackageRoot, 'dist', 'src', 'utils', 'manifest.js'),
      path.join(unpackedPackageRoot, 'dist', 'src', 'generators', 'local-plugin.js'),
      path.join(unpackedPackageRoot, 'dist', 'scripts', 'bundle-plugins.js'),
    ].map((filePath) => pathToFileURL(filePath).href);
    await expect(execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'await Promise.all(process.argv.slice(1).map((specifier) => import(specifier)));',
        ...criticalImports,
      ],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).resolves.toMatchObject({ stdout: '', stderr: '' });

    const undeclaredImportProbe = path.join(unpackedPackageRoot, 'undeclared-import-probe.mjs');
    await fs.writeFile(undeclaredImportProbe, 'import "vitest";\n', 'utf8');
    await expect(execFileAsync(
      process.execPath,
      [undeclaredImportProbe],
      {
        cwd: unpackedPackageRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    )).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('ERR_MODULE_NOT_FOUND'),
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

    await installDeclaredDependencyOnlyView(unpackedPackageRoot, packageRoot);
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
