import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPublishedPackageTarballMatchesCandidate,
  computePackageTarballTreeDigest,
  downloadExactPackageTarball,
} from '../../../../scripts/release/common.mjs';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function packageTarball(
  root: string,
  name: string,
  contents: string,
  packageName = 'fixture',
): Promise<string> {
  const source = path.join(root, `${name}-source`);
  await fs.mkdir(path.join(source, 'package', 'dist'), { recursive: true });
  await fs.writeFile(path.join(source, 'package', 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '1.0.0',
  })}\n`);
  await fs.writeFile(path.join(source, 'package', 'dist', 'index.js'), contents);
  const tarballPath = path.join(root, `${name}.tgz`);
  await execFileAsync('tar', ['-czf', tarballPath, '-C', source, 'package']);
  return tarballPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('published package file consistency', () => {
  it.each([
    '@lesliechan721/aw-windows-job-win32-x64',
    '@lesliechan721/aw-windows-job-win32-arm64',
  ])('normalizes Windows Job release package metadata for %s', async (packageName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-package-consistency-'));
    roots.push(root);
    const tarball = await packageTarball(root, 'release-package', 'fixture\n', packageName);

    await expect(computePackageTarballTreeDigest(tarball, {
      normalizeReleaseMetadata: true,
      expectedPackageName: packageName,
      expectedVersion: '1.0.0',
    })).resolves.toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('downloads the exact version without lifecycle scripts through an injectable registry command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-package-consistency-'));
    roots.push(root);
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = await downloadExactPackageTarball(
      '@scope/fixture',
      '1.0.0',
      path.join(root, 'package.json'),
      root,
      {
        registryUrl: 'https://registry.example.test/',
        captureCommand: async (command, args, options) => {
          calls.push({ command, args, options });
          await fs.writeFile(path.join(root, 'fixture.tgz'), 'fixture');
          return { stdout: '[]', stderr: '' };
        },
      },
    );

    expect(result).toEqual({
      tarballPath: path.join(root, 'fixture.tgz'),
      registryUrl: 'https://registry.example.test/',
    });
    expect(calls[0]).toMatchObject({
      command: 'npm',
      args: [
        'pack', '@scope/fixture@1.0.0', '--ignore-scripts', '--json',
        '--pack-destination', root, '--registry', 'https://registry.example.test/',
      ],
      options: {
        env: {
          npm_config_ignore_scripts: 'true',
          NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        },
      },
    });
  });

  it('normalizes tar metadata and cleans the private registry download', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-package-consistency-'));
    roots.push(root);
    const candidate = await packageTarball(root, 'candidate', 'export const value = 1;\n');
    const published = await packageTarball(root, 'published', 'export const value = 1;\n');
    let downloadRoot = '';

    await expect(assertPublishedPackageTarballMatchesCandidate(
      '@scope/fixture',
      '1.0.0',
      path.join(root, 'package.json'),
      candidate,
      {
        downloadExactPackageTarball: async (_name, _version, _manifest, destination) => {
          downloadRoot = destination;
          const target = path.join(destination, 'fixture.tgz');
          await fs.copyFile(published, target);
          return { tarballPath: target, registryUrl: 'https://registry.example.test/' };
        },
      },
    )).resolves.toMatchObject({
      candidateTreeDigest: await computePackageTarballTreeDigest(candidate),
      publishedTreeDigest: await computePackageTarballTreeDigest(published),
    });
    await expect(fs.stat(downloadRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when an exact registry version has different production files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-package-consistency-'));
    roots.push(root);
    const candidate = await packageTarball(root, 'candidate', 'export const value = 1;\n');
    const published = await packageTarball(root, 'published', 'export const value = 2;\n');

    await expect(assertPublishedPackageTarballMatchesCandidate(
      '@scope/fixture',
      '1.0.0',
      path.join(root, 'package.json'),
      candidate,
      {
        downloadExactPackageTarball: async (_name, _version, _manifest, destination) => {
          const target = path.join(destination, 'fixture.tgz');
          await fs.copyFile(published, target);
          return { tarballPath: target, registryUrl: 'https://registry.example.test/' };
        },
      },
    )).rejects.toThrow('has different package files from the release candidate');
  });
});
