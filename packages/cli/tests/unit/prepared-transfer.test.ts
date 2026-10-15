import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureCommand } from '../../../../scripts/release/common.mjs';
import {
  exportPreparedRelease,
  importPreparedRelease,
  markPreparedCliAttempt,
  prepareLocalRelease,
  publishPreparedRelease,
  repairPreparedCliRelease,
} from '../../../../scripts/release/prepared-release.mjs';
import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';

const roots: string[] = [];
const head = 'a'.repeat(40);
const version = '1.2.0-beta.7';
const targets = { schemaVersion: 2, cli: '1.2.0' };
const packageNames = [
  '@lesliechan721/aw-windows-job-win32-x64',
  '@lesliechan721/aw-windows-job-win32-arm64',
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw-plugin-core',
  '@lesliechan721/aw',
];
const packageDirectories = [
  'aw-windows-job-win32-x64', 'aw-windows-job-win32-arm64',
  'agent-skill-eval', 'plugin-core', 'cli',
];
const hash = (value: string) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-prepared-transfer-'));
  roots.push(repoRoot);
  const releaseRoot = path.join(repoRoot, '.release');
  const packageRoots = packageDirectories.map((name) => path.join(repoRoot, 'snapshot', name));
  await Promise.all(packageRoots.map(async (root, index) => {
    await fs.mkdir(path.join(root, 'package'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: packageNames[index],
      version: targets.cli,
      ...(index === 2 ? { optionalDependencies: {
        [packageNames[0]]: `workspace:${targets.cli}`,
        [packageNames[1]]: `workspace:${targets.cli}`,
      } } : {}),
      ...(index === 4 ? { dependencies: {
        [packageNames[2]]: `workspace:${targets.cli}`,
        [packageNames[3]]: `workspace:${targets.cli}`,
      } } : {}),
    }));
    await fs.writeFile(path.join(root, 'package', 'index.js'), `export const packageIndex = ${index};\n`);
  }));
  const snapshot = {
    generationId: crypto.randomUUID(),
    inputDigest: hash('saved-input'),
    outputDigest: hash('saved-output'),
    cliPackageDigest: hash('saved-package'),
    windowsX64PackageRoot: packageRoots[0], windowsArm64PackageRoot: packageRoots[1],
    evalPackageRoot: packageRoots[2], corePackageRoot: packageRoots[3], cliPackageRoot: packageRoots[4],
  };
  const pack = (index: number) => async ({ destination }: { destination: string }) => {
    const root = packageRoots[index]!;
    await fs.copyFile(path.join(root, 'package.json'), path.join(root, 'package', 'package.json'));
    const target = path.join(destination, `${packageDirectories[index]}.tgz`);
    await captureCommand('tar', ['-czf', target, '-C', root, 'package']);
    return target;
  };
  const sourceOptions = {
    repoRoot, releaseRoot,
    axes: { cli: true, catalog: false },
    assertClean: async () => undefined,
    assertTargetsMatchHead: async () => undefined,
    readTargets: async () => targets,
    assertPackageVersions: async () => ({ targetVersion: targets.cli }),
    resolveHead: async () => head,
    withSnapshot: async (callback: (value: typeof snapshot) => unknown) => callback(snapshot),
  };
  const resolveCandidates = vi.fn(async () => { throw new Error('Exact prepare must not select another version.'); });
  const descriptor = await prepareLocalRelease('beta', {
    ...sourceOptions,
    exactCandidates: { cli: version, catalog: null },
    resolveCandidates,
    packWindowsJobX64: pack(0), packWindowsJobArm64: pack(1),
    packEval: pack(2), packCore: pack(3), packCli: pack(4),
  });
  expect(resolveCandidates).not.toHaveBeenCalled();
  const intent = await markPreparedCliAttempt(sourceOptions);
  const from = path.join(repoRoot, 'bundle', 'cli');
  const preparedRoot = path.join(releaseRoot, 'prepared');
  await fs.writeFile(path.join(preparedRoot, 'private.npmrc'), '//registry.invalid/:_authToken=must-not-export');
  await exportPreparedRelease({ ...sourceOptions, destination: from, requireAttempt: true });
  const destinationReleaseRoot = path.join(repoRoot, 'other-runner', '.release');
  const importOptions = {
    from, releaseRoot: destinationReleaseRoot,
    expectedSourceHead: head, expectedVersion: version,
    expectedDescriptorDigest: calculateCanonicalDigest(descriptor),
  };
  return { repoRoot, releaseRoot, sourceOptions, descriptor, intent, from, preparedRoot, importOptions };
}

function publicationOptions(value: Awaited<ReturnType<typeof fixture>>, imported: Awaited<ReturnType<typeof importPreparedRelease>>) {
  return {
    ...value.sourceOptions,
    releaseRoot: value.importOptions.releaseRoot,
    preparedRoot: imported.root,
    portable: true,
    portableBinding: imported.portableBinding,
    expectedDescriptorDigest: imported.descriptorDigest,
    withSnapshot: async () => { throw new Error('A transferred candidate must not build.'); },
    readPackageVersions: async () => [],
    readPackageChannelVersion: async () => null,
    assertCliTagAvailable: async () => undefined,
    publishCliTag: async () => undefined,
    npmCommand: 'npm',
  };
}

describe('portable prepared CLI release', () => {
  // Test Value Gate: use real five-package archives to protect the saved candidate and recovery boundary.
  it('moves the exact five-package candidate and unchanged intent without old paths or another build', async () => {
    const value = await fixture();
    const imported = await importPreparedRelease(value.importOptions);
    expect(imported.descriptor.candidates).toEqual({ cli: version, catalog: null });
    expect(imported.root).not.toBe(value.preparedRoot);
    expect(await fs.readFile(path.join(imported.root, 'descriptor.json')))
      .toEqual(await fs.readFile(path.join(value.preparedRoot, 'descriptor.json')));
    expect(await fs.readFile(path.join(value.importOptions.releaseRoot, 'attempted.json')))
      .toEqual(await fs.readFile(path.join(value.releaseRoot, 'attempted.json')));
    expect(await fs.readdir(path.join(value.from, 'prepared'))).toEqual(['artifacts', 'descriptor.json']);
    const calls: string[] = [];
    const options = publicationOptions(value, imported);
    await publishPreparedRelease({
      ...options,
      initialAttemptDigest: value.intent.intentDigest,
      runNpmCommand: async (command: string, args: string[]) => {
        expect(command).toBe('npm');
        const attempt = JSON.parse(await fs.readFile(path.join(value.importOptions.releaseRoot, 'attempted.json'), 'utf8'));
        expect(attempt.publicationStarted).toBe(true);
        expect(attempt.descriptorDigest).toBe(imported.descriptorDigest);
        calls.push(path.basename(args[1]!));
      },
    });
    expect(calls).toEqual(packageDirectories.map((name) => `${name}.tgz`));
    const repeat = vi.fn();
    await expect(publishPreparedRelease({ ...options, runNpmCommand: repeat })).rejects.toThrow('already attempted');
    await expect(publishPreparedRelease({
      ...options, initialAttemptDigest: value.intent.intentDigest, runNpmCommand: repeat,
    })).rejects.toThrow('explicit CLI repair');
    expect(repeat).not.toHaveBeenCalled();
  });

  it('keeps partial npm success and repairs only missing packages from the same imported bytes', async () => {
    const value = await fixture();
    const imported = await importPreparedRelease(value.importOptions);
    const options = publicationOptions(value, imported);
    const published = new Set<string>();
    const artifactNames = imported.descriptor.npm.packages.map((entry: { path: string }) => path.basename(entry.path));
    await expect(publishPreparedRelease({
      ...options, initialAttemptDigest: value.intent.intentDigest,
      runNpmCommand: async (_command: string, args: string[]) => {
        const index = artifactNames.indexOf(path.basename(args[1]!));
        if (index === 2) throw new Error('registry result is uncertain');
        published.add(packageNames[index]!);
      },
    })).rejects.toThrow('Do not retry');
    const attemptBeforeRepair = await fs.readFile(path.join(value.importOptions.releaseRoot, 'attempted.json'));
    const repaired: string[] = [];
    await repairPreparedCliRelease({
      ...options,
      readPackageVersions: async (name: string) => published.has(name) ? [version] : [],
      runNpmCommand: async (command: string, args: string[]) => {
        expect(command).toBe('npm');
        const name = packageNames[artifactNames.indexOf(path.basename(args[1]!))]!;
        repaired.push(name);
        published.add(name);
      },
      assertPublishedPackageMatches: async (name: string) => { expect(published.has(name)).toBe(true); },
    });
    expect(repaired).toEqual(packageNames.slice(2));
    expect(await fs.readFile(path.join(value.importOptions.releaseRoot, 'attempted.json'))).toEqual(attemptBeforeRepair);
    const final = await exportPreparedRelease({ ...options, destination: path.join(value.repoRoot, 'final'), requireAttempt: true });
    expect(final.attempt.publicationStarted).toBe(true);
  });

  it('rejects source, version, descriptor, archive, and missing recovery evidence before installing it', async () => {
    const value = await fixture();
    for (const overrides of [
      { expectedSourceHead: 'b'.repeat(40) }, { expectedVersion: '1.2.0-beta.8' },
      { expectedDescriptorDigest: hash('other-descriptor') }, { expectedDescriptorDigest: undefined },
    ]) {
      await expect(importPreparedRelease({ ...value.importOptions, ...overrides })).rejects.toThrow();
    }
    const attemptPath = path.join(value.from, 'attempted.json');
    const attemptBytes = await fs.readFile(attemptPath);
    await fs.rm(attemptPath);
    await expect(importPreparedRelease(value.importOptions)).rejects.toThrow('attempt');
    await fs.writeFile(attemptPath, JSON.stringify({ ...value.intent.attempt, descriptorDigest: hash('different') }));
    await expect(importPreparedRelease(value.importOptions)).rejects.toThrow('does not match');
    await fs.writeFile(attemptPath, attemptBytes);
    const archivePath = path.join(value.from, 'prepared', value.descriptor.npm.packages[0].path);
    const archiveBytes = await fs.readFile(archivePath);
    await fs.writeFile(archivePath, 'corrupt archive');
    await expect(importPreparedRelease(value.importOptions)).rejects.toThrow('artifact digest changed');
    await fs.writeFile(archivePath, archiveBytes);
    const descriptorPath = path.join(value.from, 'prepared', 'descriptor.json');
    const descriptorBytes = await fs.readFile(descriptorPath);
    const changed = { ...value.descriptor, build: { ...value.descriptor.build, outputDigest: hash('changed-build') } };
    await fs.writeFile(descriptorPath, JSON.stringify(changed));
    await expect(importPreparedRelease(value.importOptions)).rejects.toThrow('descriptor digest');
    await fs.writeFile(descriptorPath, JSON.stringify({
      ...value.descriptor, npm: { ...value.descriptor.npm, packages: value.descriptor.npm.packages.slice(1) },
    }));
    await expect(importPreparedRelease(value.importOptions)).rejects.toThrow('axes or candidates');
    await fs.writeFile(descriptorPath, descriptorBytes);
    expect(await fs.stat(path.join(value.importOptions.releaseRoot, 'prepared')).catch(() => null)).toBeNull();
  });

  it('requires an actual import and its expected digest to use portable publication', async () => {
    const value = await fixture();
    const imported = await importPreparedRelease(value.importOptions);
    const options = publicationOptions(value, imported);
    const runNpmCommand = vi.fn();
    for (const overrides of [
      { portableBinding: {} }, { expectedDescriptorDigest: undefined },
      { expectedDescriptorDigest: hash('untrusted') },
    ]) {
      await expect(publishPreparedRelease({
        ...options, ...overrides, initialAttemptDigest: value.intent.intentDigest, runNpmCommand,
      })).rejects.toThrow('verified imported');
    }
    expect(runNpmCommand).not.toHaveBeenCalled();
  });
});
