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
const corePackageName = '@lesliechan721/aw-plugin-core';
const windowsX64PackageName = '@lesliechan721/aw-windows-job-win32-x64';
const windowsArm64PackageName = '@lesliechan721/aw-windows-job-win32-arm64';

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
    dependencies: { [evalPackageName]: '1.2.3', [corePackageName]: '1.2.3' },
    ...overrides,
  };
}

function evalManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: evalPackageName,
    version: '1.2.3',
    optionalDependencies: {
      [windowsX64PackageName]: '1.2.3',
      [windowsArm64PackageName]: '1.2.3',
    },
    ...overrides,
  };
}

function coreManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: corePackageName, version: '1.2.3', ...overrides };
}

async function createWindowsTarballs(root: string): Promise<{
  windowsX64TarballPath: string;
  windowsArm64TarballPath: string;
}> {
  return {
    windowsX64TarballPath: await createPackageTarball(root, 'windows-x64.tgz', {
      name: windowsX64PackageName,
      version: '1.2.3',
    }),
    windowsArm64TarballPath: await createPackageTarball(root, 'windows-arm64.tgz', {
      name: windowsArm64PackageName,
      version: '1.2.3',
    }),
  };
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
    const coreTarballPath = path.join(tarballDirectory, 'lesliechan721-aw-plugin-core-current.tgz');
    const oldTarballPath = path.join(tarballDirectory, 'lesliechan721-aw-old.tgz');
    await createPackageTarball(tarballDirectory, path.basename(cliTarballPath), cliManifest());
    await createPackageTarball(tarballDirectory, path.basename(evalTarballPath), evalManifest());
    await createPackageTarball(tarballDirectory, path.basename(coreTarballPath), coreManifest());
    const windowsTarballs = await createWindowsTarballs(tarballDirectory);
    await fs.writeFile(oldTarballPath, 'old\n');
    const newerTime = new Date(Date.now() + 60_000);
    await fs.utimes(oldTarballPath, newerTime, newerTime);
    const [packedStats, oldStats] = await Promise.all([
      fs.stat(cliTarballPath),
      fs.stat(oldTarballPath),
    ]);
    expect(oldStats.mtimeMs).toBeGreaterThan(packedStats.mtimeMs);

    const bundle = { cliTarballPath, evalTarballPath, coreTarballPath, ...windowsTarballs };
    const packCliBundle = vi.fn(async () => bundle);
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(undefined, { packCliBundle, runCommand }))
      .resolves.toEqual(bundle);
    expect(packCliBundle).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '--omit=optional', evalTarballPath, coreTarballPath, cliTarballPath],
    );
  });

  it('installs explicit CLI and shared Eval tarballs without packing again', async () => {
    const cwd = await createTempDirectory();
    const cliTarballPath = await createPackageTarball(cwd, 'cli.tgz', cliManifest());
    const evalTarballPath = await createPackageTarball(cwd, 'eval.tgz', evalManifest());
    const coreTarballPath = await createPackageTarball(cwd, 'core.tgz', coreManifest());
    const windowsTarballs = await createWindowsTarballs(cwd);
    const packCliBundle = vi.fn(async () => ({
      cliTarballPath: path.join(cwd, 'unexpected-cli.tgz'),
      evalTarballPath: path.join(cwd, 'unexpected-eval.tgz'),
      coreTarballPath: path.join(cwd, 'unexpected-core.tgz'),
      windowsX64TarballPath: path.join(cwd, 'unexpected-windows-x64.tgz'),
      windowsArm64TarballPath: path.join(cwd, 'unexpected-windows-arm64.tgz'),
    }));
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball('cli.tgz', {
      cwd,
      evalTarballArg: 'eval.tgz',
      coreTarballArg: 'core.tgz',
      windowsX64TarballArg: path.basename(windowsTarballs.windowsX64TarballPath),
      windowsArm64TarballArg: path.basename(windowsTarballs.windowsArm64TarballPath),
      packCliBundle,
      runCommand,
    })).resolves.toEqual({ cliTarballPath, evalTarballPath, coreTarballPath, ...windowsTarballs });
    expect(packCliBundle).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '--omit=optional', evalTarballPath, coreTarballPath, cliTarballPath],
    );
  });

  it.each([
    { arch: 'x64', platformTarball: 'windowsX64TarballPath' },
    { arch: 'arm64', platformTarball: 'windowsArm64TarballPath' },
  ] as const)('installs only the matching $arch Windows Job platform tarball', async ({
    arch,
    platformTarball,
  }) => {
    const tarballDirectory = await createTempDirectory();
    const cliTarballPath = await createPackageTarball(tarballDirectory, 'cli.tgz', cliManifest());
    const evalTarballPath = await createPackageTarball(tarballDirectory, 'eval.tgz', evalManifest());
    const coreTarballPath = await createPackageTarball(tarballDirectory, 'core.tgz', coreManifest());
    const windowsTarballs = await createWindowsTarballs(tarballDirectory);
    const bundle = { cliTarballPath, evalTarballPath, coreTarballPath, ...windowsTarballs };
    const runCommand = vi.fn(async () => undefined);

    await installLocalTarball(undefined, {
      packCliBundle: async () => bundle,
      platform: 'win32',
      arch,
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith('npm', [
      'install',
      '-g',
      evalTarballPath,
      coreTarballPath,
      cliTarballPath,
      windowsTarballs[platformTarball],
    ]);
  });

  it('rejects an unsupported Windows architecture before npm install', async () => {
    const bundle = {
      cliTarballPath: '/bundle/cli.tgz',
      evalTarballPath: '/bundle/eval.tgz',
      coreTarballPath: '/bundle/core.tgz',
      windowsX64TarballPath: '/bundle/windows-x64.tgz',
      windowsArm64TarballPath: '/bundle/windows-arm64.tgz',
    };
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(undefined, {
      packCliBundle: async () => bundle,
      validateBundle: async () => bundle,
      platform: 'win32',
      arch: 'ia32',
      runCommand,
    })).rejects.toThrow('unsupported on architecture ia32');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects an explicit CLI tarball without all release tarballs', async () => {
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball('cli.tgz', { runCommand })).rejects.toThrow(
      'requires all five release tarballs',
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
    const coreTarballPath = await createPackageTarball(root, 'core.tgz', coreManifest());
    const windowsTarballs = await createWindowsTarballs(root);
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(cliTarballPath, {
      evalTarballArg: evalTarballPath,
      coreTarballArg: coreTarballPath,
      windowsX64TarballArg: windowsTarballs.windowsX64TarballPath,
      windowsArm64TarballArg: windowsTarballs.windowsArm64TarballPath,
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
    const coreTarballPath = await createPackageTarball(root, 'core.tgz', coreManifest());
    const windowsTarballs = await createWindowsTarballs(root);
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(cliTarballPath, {
      evalTarballArg: evalTarballPath,
      coreTarballArg: coreTarballPath,
      windowsX64TarballArg: windowsTarballs.windowsX64TarballPath,
      windowsArm64TarballArg: windowsTarballs.windowsArm64TarballPath,
      runCommand,
    })).rejects.toThrow(message);
    expect(runCommand).not.toHaveBeenCalled();
  });
});
