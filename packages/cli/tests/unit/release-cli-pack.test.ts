import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computePackageTarballTreeDigest,
  computeReleasePackageContentDigest,
  packCli,
  stampReleaseCandidateSnapshot,
  withPrivateCliTarball,
} from '../../../../scripts/release/common.mjs';

const generatedTarballName = 'lesliechan721-aw-9.9.9.tgz';
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const pnpmExecPath = path.join(path.dirname(require.resolve('pnpm')), 'bin/pnpm.cjs');
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
  it('stamps both candidates only in an isolated snapshot with an exact train dependency', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-stamp-'));
    tempDirs.push(root);
    const sourceRoot = path.join(root, 'source');
    const snapshotRoot = path.join(root, 'snapshot');
    for (const packageRoot of [sourceRoot, snapshotRoot]) {
      await fs.mkdir(path.join(packageRoot, 'eval'), { recursive: true });
      await fs.mkdir(path.join(packageRoot, 'cli'), { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'eval', 'package.json'), `${JSON.stringify({
        name: '@lesliechan721/agent-skill-eval', version: '1.2.3',
      }, null, 2)}\n`);
      await fs.writeFile(path.join(packageRoot, 'cli', 'package.json'), `${JSON.stringify({
        name: '@lesliechan721/aw', version: '1.2.3',
        dependencies: { '@lesliechan721/agent-skill-eval': 'workspace:*' },
      }, null, 2)}\n`);
    }
    const sourceBefore = await Promise.all([
      fs.readFile(path.join(sourceRoot, 'eval', 'package.json'), 'utf8'),
      fs.readFile(path.join(sourceRoot, 'cli', 'package.json'), 'utf8'),
    ]);
    const digest = `sha256:${'a'.repeat(64)}`;
    await stampReleaseCandidateSnapshot({
      evalPackageRoot: path.join(snapshotRoot, 'eval'),
      cliPackageRoot: path.join(snapshotRoot, 'cli'),
    }, {
      targetVersion: '1.2.3',
      candidateVersion: '1.2.3-beta.1',
      planId: digest,
      sourceHead: 'b'.repeat(40),
      packageContentDigest: digest,
      trainContentDigest: digest,
    });
    const [evalPackage, cliPackage] = await Promise.all([
      fs.readFile(path.join(snapshotRoot, 'eval', 'package.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(snapshotRoot, 'cli', 'package.json'), 'utf8').then(JSON.parse),
    ]);
    expect(evalPackage.version).toBe('1.2.3-beta.1');
    expect(cliPackage.version).toBe('1.2.3-beta.1');
    expect(cliPackage.dependencies['@lesliechan721/agent-skill-eval']).toBe('1.2.3-beta.1');
    expect(evalPackage.awRelease).toMatchObject({ schemaVersion: 1, planId: digest });
    expect(cliPackage.awRelease).toMatchObject({ schemaVersion: 1, planId: digest });
    await expect(Promise.all([
      fs.readFile(path.join(sourceRoot, 'eval', 'package.json'), 'utf8'),
      fs.readFile(path.join(sourceRoot, 'cli', 'package.json'), 'utf8'),
    ])).resolves.toEqual(sourceBefore);
  });

  it('normalizes the packed CLI train dependency, candidate version, and awRelease', async () => {
    const tarballs = [];
    for (const version of ['1.2.3-beta.1', '1.2.3-beta.2', '1.2.3']) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-content-pack-'));
      tempDirs.push(root);
      const cliRoot = path.join(root, 'packages', 'aw');
      const evalRoot = path.join(root, 'packages', 'eval');
      await fs.mkdir(cliRoot, { recursive: true });
      await fs.mkdir(evalRoot, { recursive: true });
      await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({
        private: true, packageManager: 'pnpm@10.33.0',
      }, null, 2)}\n`);
      await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      await fs.writeFile(path.join(cliRoot, 'index.js'), 'export const value = 1;\n');
      await fs.writeFile(path.join(evalRoot, 'package.json'), `${JSON.stringify({
        name: '@lesliechan721/agent-skill-eval', version,
      }, null, 2)}\n`);
      await fs.writeFile(path.join(cliRoot, 'package.json'), `${JSON.stringify({
        name: '@lesliechan721/aw',
        version,
        files: ['index.js'],
        dependencies: { '@lesliechan721/agent-skill-eval': 'workspace:*' },
        awRelease: {
          schemaVersion: 1,
          candidateVersion: version,
          planId: `sha256:${'a'.repeat(64)}`,
        },
      }, null, 2)}\n`);
      await execFileAsync(process.execPath, [
        pnpmExecPath, 'install', '--offline', '--ignore-scripts',
      ], { cwd: root });
      await execFileAsync(process.execPath, [
        pnpmExecPath, '--config.ignore-scripts=true', 'pack', '--pack-destination', root,
      ], { cwd: cliRoot }).catch((error: { stderr?: string; stdout?: string; code?: number }) => {
        throw new Error(error.stderr || error.stdout || `pnpm pack failed with code ${error.code}.`);
      });
      const tarball = (await fs.readdir(root)).find((entry) => entry.endsWith('.tgz'));
      tarballs.push(path.join(root, tarball!));
    }
    const normalized = await Promise.all(tarballs.map(computeReleasePackageContentDigest));
    const raw = await Promise.all(tarballs.map((entry) => computePackageTarballTreeDigest(entry)));
    expect(new Set(normalized).size).toBe(1);
    expect(new Set(raw).size).toBe(3);
  }, 45_000);

  it('rejects a packed CLI with a missing or mismatched exact train dependency', async () => {
    for (const { name, dependency, message } of [
      { name: '@lesliechan721/aw', dependency: undefined, message: 'must depend on' },
      { name: '@lesliechan721/aw', dependency: '1.2.3-beta.1', message: 'must depend on' },
      { name: '@fixture/not-a-release-package', dependency: '1.2.3-beta.2', message: 'Unsupported release package' },
    ]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-content-invalid-'));
      tempDirs.push(root);
      await fs.writeFile(path.join(root, 'index.js'), 'export const value = 1;\n');
      await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({
        name,
        version: '1.2.3-beta.2',
        files: ['index.js'],
        ...(dependency === undefined ? {} : {
          dependencies: { '@lesliechan721/agent-skill-eval': dependency },
        }),
      }, null, 2)}\n`);
      await execFileAsync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: root });
      const tarball = (await fs.readdir(root)).find((entry) => entry.endsWith('.tgz'))!;
      await expect(computeReleasePackageContentDigest(path.join(root, tarball)))
        .rejects.toThrow(message);
    }
  });

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
      generatedTarballName,
      'notes.txt',
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

  it('keeps a publish tarball in an owned private random directory until its consumer finishes', async () => {
    const fixture = await createPackFixture('success');
    let consumedPath = '';

    await expect(withPrivateCliTarball(fixture.snapshot, async (tarballPath) => {
      consumedPath = tarballPath;
      const directory = path.dirname(tarballPath);
      const stats = await fs.stat(directory);
      expect(stats.mode & 0o777).toBe(0o700);
      expect(path.basename(directory)).toMatch(/^aw-cli-publish-/);
      await expect(fs.readFile(tarballPath, 'utf8')).resolves.toBe('new tarball');
      return 'consumed';
    })).resolves.toBe('consumed');

    await expect(fs.stat(consumedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
