import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { packCli } from '../../../../scripts/release/common.mjs';

const generatedTarballName = 'yiliang-aw-9.9.9.tgz';
const tempDirs: string[] = [];
const originalEnvironment = {
  npmExecPath: process.env.npm_execpath,
  npmUserAgent: process.env.npm_config_user_agent,
  packMarker: process.env.AW_CLI_PACK_MARKER,
  packMode: process.env.AW_CLI_PACK_MODE,
};

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function createPackFixture(mode: 'fail' | 'success') {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-cli-pack-'));
  tempDirs.push(fixtureRoot);
  const cliPackageRoot = path.join(fixtureRoot, 'cli');
  const markerPath = path.join(fixtureRoot, 'pack-destination.txt');
  const fakePnpmPath = path.join(fixtureRoot, 'fake-pnpm.cjs');
  await fs.mkdir(cliPackageRoot);
  await fs.writeFile(fakePnpmPath, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const destinationIndex = process.argv.indexOf('--pack-destination');",
    "const destination = process.argv[destinationIndex + 1];",
    "fs.writeFileSync(process.env.AW_CLI_PACK_MARKER, destination);",
    `fs.writeFileSync(path.join(destination, '${generatedTarballName}'), 'new tarball');`,
    "if (process.env.AW_CLI_PACK_MODE === 'fail') process.exitCode = 7;",
  ].join('\n'));

  process.env.npm_execpath = fakePnpmPath;
  process.env.npm_config_user_agent = 'pnpm/10.33.0 npm/? node/test test test';
  process.env.AW_CLI_PACK_MARKER = markerPath;
  process.env.AW_CLI_PACK_MODE = mode;

  return {
    destination: path.join(fixtureRoot, 'destination'),
    markerPath,
    snapshot: { cliPackageRoot },
  };
}

afterEach(async () => {
  restoreEnvironmentVariable('npm_execpath', originalEnvironment.npmExecPath);
  restoreEnvironmentVariable('npm_config_user_agent', originalEnvironment.npmUserAgent);
  restoreEnvironmentVariable('AW_CLI_PACK_MARKER', originalEnvironment.packMarker);
  restoreEnvironmentVariable('AW_CLI_PACK_MODE', originalEnvironment.packMode);
  await Promise.all(tempDirs.splice(0).map((tempDir) =>
    fs.rm(tempDir, { recursive: true, force: true })
  ));
});

describe('CLI release pack staging', () => {
  it('preserves existing tarballs and atomically replaces only the current tarball', async () => {
    const fixture = await createPackFixture('success');
    const existingTarballPath = path.join(fixture.destination, 'keep-me.tgz');
    const currentTarballPath = path.join(fixture.destination, generatedTarballName);
    const existingFilePath = path.join(fixture.destination, 'notes.txt');
    await fs.mkdir(fixture.destination);
    await Promise.all([
      fs.writeFile(existingTarballPath, 'keep tarball\n'),
      fs.writeFile(currentTarballPath, 'old tarball\n'),
      fs.writeFile(existingFilePath, 'keep file\n'),
    ]);

    await expect(packCli({
      destination: fixture.destination,
      snapshot: fixture.snapshot,
    })).resolves.toBe(currentTarballPath);

    await expect(fs.readFile(existingTarballPath, 'utf8')).resolves.toBe('keep tarball\n');
    await expect(fs.readFile(currentTarballPath, 'utf8')).resolves.toBe('new tarball');
    await expect(fs.readFile(existingFilePath, 'utf8')).resolves.toBe('keep file\n');
    const privatePackDirectory = await fs.readFile(fixture.markerPath, 'utf8');
    expect(privatePackDirectory).not.toBe(fixture.destination);
    await expect(fs.stat(privatePackDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readdir(fixture.destination).then((entries) => entries.sort())).resolves.toEqual([
      'keep-me.tgz',
      'notes.txt',
      generatedTarballName,
    ]);
  });

  it('preserves every existing tarball when pnpm pack fails', async () => {
    const fixture = await createPackFixture('fail');
    const existingTarballPath = path.join(fixture.destination, 'keep-me.tgz');
    const currentTarballPath = path.join(fixture.destination, generatedTarballName);
    await fs.mkdir(fixture.destination);
    await Promise.all([
      fs.writeFile(existingTarballPath, 'keep tarball\n'),
      fs.writeFile(currentTarballPath, 'old tarball\n'),
    ]);

    await expect(packCli({
      destination: fixture.destination,
      snapshot: fixture.snapshot,
    })).rejects.toThrow('Command failed: pnpm');

    await expect(fs.readFile(existingTarballPath, 'utf8')).resolves.toBe('keep tarball\n');
    await expect(fs.readFile(currentTarballPath, 'utf8')).resolves.toBe('old tarball\n');
    const privatePackDirectory = await fs.readFile(fixture.markerPath, 'utf8');
    await expect(fs.stat(privatePackDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readdir(fixture.destination).then((entries) => entries.sort())).resolves.toEqual([
      'keep-me.tgz',
      generatedTarballName,
    ]);
  });
});
