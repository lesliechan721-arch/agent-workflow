import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installLocalTarball, validateLocalTarballBundle } from '../../../../scripts/release/install-local-tarball.mjs';

const exec = promisify(execFile);
const roots: string[] = [];
const nativeNames = ['x64', 'arm64'].map((arch) => `@lesliechan721/aw-windows-job-win32-${arch}`);
const names = ['@lesliechan721/aw', '@lesliechan721/agent-skill-eval', '@lesliechan721/aw-plugin-core', ...nativeNames];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(change?: (manifests: Array<Record<string, any>>) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-bundle-'));
  roots.push(root);
  const manifests = names.map((name, index) => ({
    name, version: '1.2.3',
    ...(index === 0 ? { dependencies: { [names[1]!]: '1.2.3', [names[2]!]: '1.2.3' } } : {}),
    ...(index === 1 ? { optionalDependencies: Object.fromEntries(nativeNames.map((entry) => [entry, '1.2.3'])) } : {}),
    ...(index >= 3 ? { os: ['win32'], cpu: [['x64', 'arm64'][index - 3]] } : {}),
  }));
  change?.(manifests);
  const tarballs = await Promise.all(manifests.map(async (metadata, index) => {
    const source = path.join(root, String(index));
    await fs.mkdir(path.join(source, 'package'), { recursive: true });
    await fs.writeFile(path.join(source, 'package/package.json'), JSON.stringify(metadata));
    const tarball = path.join(root, `${index}.tgz`);
    await exec('tar', ['-czf', tarball, '-C', source, 'package']);
    return tarball;
  }));
  return { root, bundle: {
    cliTarballPath: tarballs[0], evalTarballPath: tarballs[1], coreTarballPath: tarballs[2], windowsJobTarballPaths: tarballs.slice(3),
  } };
}

describe('local five-package CLI installation', () => {
  // Test Value Gate: inspect real archives before allowing an installation side effect.
  it.each(['linux', 'darwin', 'win32'])('installs only the native package selected for %s', async (platform) => {
    const { bundle } = await fixture();
    const runCommand = vi.fn(async () => undefined);
    await expect(installLocalTarball(undefined, { packCliBundle: async () => bundle, platform, arch: 'arm64', runCommand })).resolves.toEqual(bundle);
    expect(runCommand).toHaveBeenCalledWith('npm', [
      'install', '-g', '--ignore-scripts',
      ...(platform === 'win32' ? [bundle.windowsJobTarballPaths[1]] : []),
      bundle.evalTarballPath, bundle.coreTarballPath, bundle.cliTarballPath,
    ]);
  });

  it('uses the explicit five archives without preparing another candidate', async () => {
    const { root, bundle } = await fixture();
    const packCliBundle = vi.fn();
    await expect(installLocalTarball('0.tgz', {
      cwd: root, evalTarballArg: '1.tgz', coreTarballArg: '2.tgz', windowsJobTarballArgs: ['3.tgz', '4.tgz'],
      platform: 'linux', packCliBundle, runCommand: async () => undefined,
    })).resolves.toEqual(bundle);
    expect(packCliBundle).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign package', (entries: any[]) => { entries[0].name = '@foreign/cli'; }, 'CLI tarball must contain'],
    ['different version', (entries: any[]) => { entries[1].version = '1.2.4'; }, 'same package version'],
    ['workspace reference', (entries: any[]) => { entries[1].optionalDependencies[nativeNames[0]!] = 'workspace:*'; }, 'exact package version'],
    ['wrong platform', (entries: any[]) => { entries[3].os = ['linux']; }, 'correct OS and CPU'],
    ['wrong CPU', (entries: any[]) => { entries[3].cpu = ['arm64']; }, 'correct OS and CPU'],
  ] as const)('rejects %s before npm install', async (_label, change, expected) => {
    const { bundle } = await fixture(change);
    const runCommand = vi.fn();
    await expect(installLocalTarball(undefined, { packCliBundle: async () => bundle, runCommand })).rejects.toThrow(expected);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects missing platform archives and incomplete explicit input', async () => {
    const { bundle } = await fixture();
    await expect(validateLocalTarballBundle({ ...bundle, windowsJobTarballPaths: [] })).rejects.toThrow('both Windows platform tarballs');
    await expect(installLocalTarball('cli.tgz')).rejects.toThrow('all five release tarballs');
  });
});
