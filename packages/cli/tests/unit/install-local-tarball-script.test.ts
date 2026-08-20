import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalTarball } from '../../../../scripts/release/install-local-tarball.mjs';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const cliPackageName = '@lesliechan721/aw';
const evalPackageName = '@lesliechan721/agent-skill-eval';

async function createTempDirectory(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-local-tarball-'));
  tempDirs.push(tempDir);
  return tempDir;
}

async function createPackageTarball(
  root: string,
  fileName: string,
  packageJson: Record<string, unknown> | null,
  options: { duplicateManifest?: boolean } = {},
): Promise<string> {
  const sourceRoot = path.join(root, `${fileName}-source`);
  const packageRoot = path.join(sourceRoot, 'package');
  await fs.mkdir(path.join(packageRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'dist', 'index.js'), 'export {};\n');
  if (packageJson) {
    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify(packageJson)}\n`,
    );
  }
  const tarballPath = path.join(root, fileName);
  const entries = packageJson
    ? ['package/package.json', 'package/dist/index.js']
    : ['package/dist/index.js'];
  if (options.duplicateManifest) {
    const duplicateRoot = path.join(root, `${fileName}-duplicate-source`);
    const duplicatePackageRoot = path.join(duplicateRoot, 'package');
    const archivePath = path.join(root, `${fileName}.tar`);
    await fs.mkdir(duplicatePackageRoot, { recursive: true });
    await fs.writeFile(
      path.join(duplicatePackageRoot, 'package.json'),
      `${JSON.stringify(packageJson)}\n`,
    );
    await execFileAsync('tar', ['-cf', archivePath, '-C', sourceRoot, ...entries]);
    await execFileAsync('tar', [
      '-rf',
      archivePath,
      '-C',
      duplicateRoot,
      'package/package.json',
    ]);
    const { stdout } = await execFileAsync('gzip', ['-c', archivePath], { encoding: 'buffer' });
    await fs.writeFile(tarballPath, stdout);
    return tarballPath;
  }
  await execFileAsync('tar', ['-czf', tarballPath, '-C', sourceRoot, ...entries]);
  return tarballPath;
}

function cliManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: cliPackageName,
    version: '1.2.3',
    dependencies: { [evalPackageName]: '1.2.3' },
    ...overrides,
  };
}

function evalManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: evalPackageName, version: '1.2.3', ...overrides };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

describe('install-local-tarball script', () => {
  it('installs the exact bundle returned by packCliBundle without inspecting directory mtimes', async () => {
    const tarballDirectory = await createTempDirectory();
    const cliTarballPath = path.join(tarballDirectory, 'lesliechan721-aw-current.tgz');
    const evalTarballPath = path.join(
      tarballDirectory,
      'lesliechan721-agent-skill-eval-current.tgz',
    );
    const oldTarballPath = path.join(tarballDirectory, 'lesliechan721-aw-old.tgz');
    await createPackageTarball(tarballDirectory, path.basename(cliTarballPath), cliManifest());
    await createPackageTarball(tarballDirectory, path.basename(evalTarballPath), evalManifest());
    await fs.writeFile(oldTarballPath, 'old\n');
    const newerTime = new Date(Date.now() + 60_000);
    await fs.utimes(oldTarballPath, newerTime, newerTime);
    const [packedStats, oldStats] = await Promise.all([
      fs.stat(cliTarballPath),
      fs.stat(oldTarballPath),
    ]);
    expect(oldStats.mtimeMs).toBeGreaterThan(packedStats.mtimeMs);

    const packCliBundle = vi.fn(async () => ({ cliTarballPath, evalTarballPath }));
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(undefined, { packCliBundle, runCommand }))
      .resolves.toEqual({ cliTarballPath, evalTarballPath });
    expect(packCliBundle).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', evalTarballPath, cliTarballPath],
    );
  });

  it('installs explicit CLI and shared Eval tarballs without packing again', async () => {
    const cwd = await createTempDirectory();
    const cliTarballPath = await createPackageTarball(cwd, 'cli.tgz', cliManifest());
    const evalTarballPath = await createPackageTarball(cwd, 'eval.tgz', evalManifest());
    const packCliBundle = vi.fn(async () => ({
      cliTarballPath: path.join(cwd, 'unexpected-cli.tgz'),
      evalTarballPath: path.join(cwd, 'unexpected-eval.tgz'),
    }));
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball('cli.tgz', {
      cwd,
      evalTarballArg: 'eval.tgz',
      packCliBundle,
      runCommand,
    })).resolves.toEqual({ cliTarballPath, evalTarballPath });
    expect(packCliBundle).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', evalTarballPath, cliTarballPath],
    );
  });

  it('rejects an explicit CLI tarball without its exact shared Eval tarball', async () => {
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball('cli.tgz', { runCommand })).rejects.toThrow(
      'requires both the CLI tarball and its exact shared Eval tarball',
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'wrong CLI package name',
      cli: cliManifest({ name: '@example/not-aw' }),
      eval: evalManifest(),
      message: `CLI tarball must contain package ${cliPackageName}`,
    },
    {
      label: 'wrong shared Eval package name',
      cli: cliManifest(),
      eval: evalManifest({ name: '@example/not-eval' }),
      message: `Shared Eval tarball must contain package ${evalPackageName}`,
    },
    {
      label: 'different package versions',
      cli: cliManifest(),
      eval: evalManifest({ version: '1.2.4' }),
      message: 'must have the same package version',
    },
    {
      label: 'non-exact shared Eval dependency',
      cli: cliManifest({ dependencies: { [evalPackageName]: '^1.2.3' } }),
      eval: evalManifest(),
      message: 'at its exact package version',
    },
  ])('rejects $label before npm install', async ({ cli, eval: evalPackage, message }) => {
    const root = await createTempDirectory();
    const cliTarballPath = await createPackageTarball(root, 'cli.tgz', cli);
    const evalTarballPath = await createPackageTarball(root, 'eval.tgz', evalPackage);
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(cliTarballPath, {
      evalTarballArg: evalTarballPath,
      runCommand,
    })).rejects.toThrow(message);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing', packageJson: null, duplicateManifest: false, message: 'missing package/package.json' },
    {
      label: 'duplicate',
      packageJson: evalManifest(),
      duplicateManifest: true,
      message: 'duplicate path "package.json"',
    },
  ])('rejects a $label shared Eval manifest before npm install', async ({
    packageJson,
    duplicateManifest,
    message,
  }) => {
    const root = await createTempDirectory();
    const cliTarballPath = await createPackageTarball(root, 'cli.tgz', cliManifest());
    const evalTarballPath = await createPackageTarball(
      root,
      'eval.tgz',
      packageJson,
      { duplicateManifest },
    );
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(cliTarballPath, {
      evalTarballArg: evalTarballPath,
      runCommand,
    })).rejects.toThrow(message);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
