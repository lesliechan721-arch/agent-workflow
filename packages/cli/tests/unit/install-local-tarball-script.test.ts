import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalTarball } from '../../../../scripts/release/install-local-tarball.mjs';

const tempDirs: string[] = [];

async function createTempDirectory(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-local-tarball-'));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

describe('install-local-tarball script', () => {
  it('installs the tarball returned by packCli even when an older tarball has newer mtime', async () => {
    const tarballDirectory = await createTempDirectory();
    const packedTarballPath = path.join(tarballDirectory, 'yiliang-aw-current.tgz');
    const oldTarballPath = path.join(tarballDirectory, 'yiliang-aw-old.tgz');
    await Promise.all([
      fs.writeFile(packedTarballPath, 'current\n'),
      fs.writeFile(oldTarballPath, 'old\n'),
    ]);
    const newerTime = new Date(Date.now() + 60_000);
    await fs.utimes(oldTarballPath, newerTime, newerTime);
    const [packedStats, oldStats] = await Promise.all([
      fs.stat(packedTarballPath),
      fs.stat(oldTarballPath),
    ]);
    expect(oldStats.mtimeMs).toBeGreaterThan(packedStats.mtimeMs);

    const packCli = vi.fn(async () => packedTarballPath);
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball(undefined, { packCli, runCommand }))
      .resolves.toBe(packedTarballPath);
    expect(packCli).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', packedTarballPath],
    );
  });

  it('installs an explicit tarball path without packing again', async () => {
    const cwd = await createTempDirectory();
    const explicitTarballPath = path.join(cwd, 'explicit.tgz');
    const packCli = vi.fn(async () => path.join(cwd, 'unexpected.tgz'));
    const runCommand = vi.fn(async () => undefined);

    await expect(installLocalTarball('explicit.tgz', { cwd, packCli, runCommand }))
      .resolves.toBe(explicitTarballPath);
    expect(packCli).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', explicitTarballPath],
    );
  });
});
