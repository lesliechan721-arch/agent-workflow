import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertTrackedHeadClean,
  prepareLocalRelease,
  publishPreparedRelease,
  repairPreparedCliRelease,
  resolvePreparedCandidates,
} from '../../../../scripts/release/prepared-release.mjs';
import { captureCommand, compareReleaseSemVer } from '../../../../scripts/release/common.mjs';
import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';
import { updateReleaseTargets } from '../../../../scripts/release/release-target.mjs';

const roots: string[] = [];
const head = 'a'.repeat(40);
const build = {
  generationId: 'generation-1',
  inputDigest: 'input-1',
  outputDigest: 'output-1',
  cliPackageDigest: 'cli-1',
};
const targets = { schemaVersion: 1, cli: '1.2.0', catalog: '2.3.0' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-prepared-release-test-'));
  roots.push(root);
  return root;
}

function sha256(value: string | Buffer) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function publicationFixture(axes: { cli: boolean; catalog: boolean }) {
  const root = await temporaryRoot();
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(path.join(artifacts, 'catalog'), { recursive: true });
  const evalBytes = Buffer.from('eval-tarball');
  const coreBytes = Buffer.from('core-tarball');
  const cliBytes = Buffer.from('cli-tarball');
  await fs.writeFile(path.join(artifacts, 'eval.tgz'), evalBytes);
  await fs.writeFile(path.join(artifacts, 'core.tgz'), coreBytes);
  await fs.writeFile(path.join(artifacts, 'cli.tgz'), cliBytes);
  await fs.writeFile(path.join(artifacts, 'catalog', 'catalog-manifest.json'), '{}');
  await fs.writeFile(path.join(artifacts, 'catalog', 'plugin-release-ledger.json'), '{}');
  return {
    root,
    descriptor: {
      schemaVersion: 1,
      source: { head, targetsDigest: calculateCanonicalDigest(targets) },
      channel: 'stable',
      axes,
      candidates: { cli: axes.cli ? '1.2.0' : null, catalog: axes.catalog ? '2.3.0' : null },
      build,
      npm: axes.cli ? {
        version: '1.2.0',
        packages: [
          { name: '@lesliechan721/agent-skill-eval', path: 'artifacts/eval.tgz', contentDigest: sha256(evalBytes) },
          { name: '@lesliechan721/aw-plugin-core', path: 'artifacts/core.tgz', contentDigest: sha256(coreBytes) },
          { name: '@lesliechan721/aw', path: 'artifacts/cli.tgz', contentDigest: sha256(cliBytes) },
        ],
        treeDigests: {
          '@lesliechan721/agent-skill-eval': 'eval-tree',
          '@lesliechan721/aw-plugin-core': 'core-tree',
          '@lesliechan721/aw': 'cli-tree',
        },
      } : null,
      catalog: axes.catalog ? {
        version: '2.3.0', path: 'artifacts/catalog', snapshotDigest: 'catalog-digest',
        minCliVersion: '1.0.0', ledgerDigest: calculateCanonicalDigest({}),
      } : null,
    },
  };
}

function publishOptions(fixture: Awaited<ReturnType<typeof publicationFixture>>) {
  return {
    readDescriptor: async () => fixture,
    assertClean: async () => undefined,
    resolveHead: async () => head,
    readTargets: async () => targets,
    assertPackageVersions: async () => ({ targetVersion: targets.cli }),
    withSnapshot: async (callback: (snapshot: typeof build) => unknown) => callback(build),
    readPackageVersions: async () => [],
    resolveCandidates: async () => fixture.descriptor.candidates,
    assertCatalogTagAvailable: async () => undefined,
    assertCliTagAvailable: async () => undefined,
    publishCliTag: async () => undefined,
    readPublishedCliVersion: async () => '1.2.0',
    computeTarballTreeDigest: async (file: string) => file.endsWith('eval.tgz')
      ? 'eval-tree'
      : file.endsWith('core.tgz') ? 'core-tree' : 'cli-tree',
    catalogModules: {
      catalogSnapshot: {
        validateCatalogSnapshot: async () => ({ snapshotDigest: 'catalog-digest', manifest: {} }),
      },
      pluginStaging: {
        validatePluginReleaseLedgerAgainstManifest: () => undefined,
      },
    },
    attemptPath: path.join(fixture.root, 'attempted.json'),
  };
}

describe('local prepared release', () => {
  it('allows ignored .DS_Store files but still rejects other ignored release inputs', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'packages', 'cli', 'src'), { recursive: true });
    await captureCommand('git', ['init', '--quiet'], { cwd: root });
    await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.DS_Store\nignored.ts\n');
    await fs.writeFile(path.join(root, 'packages', 'cli', 'src', '.DS_Store'), 'finder metadata\n');

    await expect(assertTrackedHeadClean(root)).resolves.toEqual([]);

    await fs.writeFile(path.join(root, 'packages', 'cli', 'src', 'ignored.ts'), 'ignored source\n');
    await expect(assertTrackedHeadClean(root)).rejects.toThrow('packages/cli/src/ignored.ts');
  });

  it('rejects assume-unchanged and skip-worktree release inputs', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'release'));
    await fs.writeFile(path.join(root, 'release', 'version-targets.json'), '{}\n');
    await captureCommand('git', ['init', '--quiet'], { cwd: root });
    await captureCommand('git', ['add', 'release/version-targets.json'], { cwd: root });
    await captureCommand('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'base'], { cwd: root });
    await captureCommand('git', ['update-index', '--assume-unchanged', 'release/version-targets.json'], { cwd: root });
    await expect(assertTrackedHeadClean(root)).rejects.toThrow('assume-unchanged');
    await captureCommand('git', ['update-index', '--no-assume-unchanged', 'release/version-targets.json'], { cwd: root });
    await captureCommand('git', ['update-index', '--skip-worktree', 'release/version-targets.json'], { cwd: root });
    await expect(assertTrackedHeadClean(root)).rejects.toThrow('skip-worktree');
  });

  it('keeps all public package versions and exact workspace dependencies synchronized', async () => {
    const root = await temporaryRoot();
    await Promise.all([
      fs.mkdir(path.join(root, 'release'), { recursive: true }),
      fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true }),
      fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true }),
      fs.mkdir(path.join(root, 'packages', 'plugin-core'), { recursive: true }),
    ]);
    await fs.writeFile(path.join(root, 'release', 'version-targets.json'), `${JSON.stringify({
      schemaVersion: 1, cli: '1.2.0', catalog: '2.3.0',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'packages', 'cli', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/aw', version: '1.2.0',
      dependencies: {
        '@lesliechan721/agent-skill-eval': 'workspace:1.2.0',
        '@lesliechan721/aw-plugin-core': 'workspace:1.2.0',
      },
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/agent-skill-eval', version: '1.2.0',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'packages', 'plugin-core', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/aw-plugin-core', version: '1.2.0',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), [
      'lockfileVersion: 9.0',
      'importers:',
      '  packages/cli:',
      "    dependencies:",
      "      '@lesliechan721/agent-skill-eval':",
      '        specifier: workspace:1.2.0',
      '        version: link:../agent-skill-eval',
      "      '@lesliechan721/aw-plugin-core':",
      '        specifier: workspace:1.2.0',
      '        version: link:../plugin-core',
      '',
    ].join('\n'));

    await updateReleaseTargets(['--cli', 'patch'], { repoRoot: root });
    const cli = JSON.parse(await fs.readFile(path.join(root, 'packages', 'cli', 'package.json'), 'utf8'));
    const evalPackage = JSON.parse(await fs.readFile(
      path.join(root, 'packages', 'agent-skill-eval', 'package.json'), 'utf8',
    ));
    const corePackage = JSON.parse(await fs.readFile(
      path.join(root, 'packages', 'plugin-core', 'package.json'), 'utf8',
    ));
    expect(cli.version).toBe('1.2.1');
    expect(evalPackage.version).toBe('1.2.1');
    expect(corePackage.version).toBe('1.2.1');
    expect(cli.dependencies['@lesliechan721/agent-skill-eval']).toBe('workspace:1.2.1');
    expect(cli.dependencies['@lesliechan721/aw-plugin-core']).toBe('workspace:1.2.1');
    expect(await fs.readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8'))
      .toContain('specifier: workspace:1.2.1');
  });

  it('prepares an empty-remote beta on a bumped train above the staged Catalog floor', async () => {
    const root = await temporaryRoot();
    const releaseRoot = path.join(root, '.release');
    await Promise.all([
      fs.mkdir(path.join(root, 'release'), { recursive: true }),
      fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true }),
      fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true }),
      fs.mkdir(path.join(root, 'packages', 'plugin-core'), { recursive: true }),
    ]);
    await fs.writeFile(path.join(root, 'release', 'version-targets.json'), `${JSON.stringify({
      schemaVersion: 1, cli: '0.1.0', catalog: '0.1.0',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'packages', 'cli', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/aw', version: '0.1.0',
      dependencies: {
        '@lesliechan721/agent-skill-eval': 'workspace:0.1.0',
        '@lesliechan721/aw-plugin-core': 'workspace:0.1.0',
      },
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/agent-skill-eval', version: '0.1.0',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'packages', 'plugin-core', 'package.json'), `${JSON.stringify({
      name: '@lesliechan721/aw-plugin-core', version: '0.1.0',
    }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), [
      'lockfileVersion: 9.0',
      'importers:',
      '  packages/cli:',
      '    dependencies:',
      "      '@lesliechan721/agent-skill-eval':",
      '        specifier: workspace:0.1.0',
      '        version: link:../agent-skill-eval',
      "      '@lesliechan721/aw-plugin-core':",
      '        specifier: workspace:0.1.0',
      '        version: link:../plugin-core',
      '',
    ].join('\n'));

    const bumped = await updateReleaseTargets([
      '--cli', 'patch', '--catalog', 'patch',
    ], { repoRoot: root });
    expect(bumped.targets).toEqual({ schemaVersion: 1, cli: '0.1.1', catalog: '0.1.1' });

    const emptyRemote = {
      readPackageVersions: async () => [],
      readPackageChannelVersion: async () => null,
      readCatalogVersions: async () => [],
      readCatalogChannelState: async () => null,
    };
    const candidates = await resolvePreparedCandidates('beta', bumped.targets, emptyRemote);
    expect(candidates).toEqual({ cli: '0.1.1-beta.1', catalog: '0.1.1-beta.1' });

    const floor = '0.1.0-beta.3';
    expect(compareReleaseSemVer(candidates.cli!, floor)).toBeGreaterThan(0);
    expect(compareReleaseSemVer('0.1.0-beta.2', floor)).toBeLessThan(0);
    const descriptor = await prepareLocalRelease('beta', {
      repoRoot: root,
      releaseRoot,
      axes: { cli: false, catalog: true },
      assertClean: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => bumped.targets,
      assertPackageVersions: async () => ({ targetVersion: bumped.targets.cli }),
      resolveHead: async () => head,
      ...emptyRemote,
      withSnapshot: async (callback: (snapshot: typeof build) => unknown) => callback(build),
      readContent: async () => ({
        catalog: { contentDigest: sha256('catalog'), minCliVersion: floor },
      }),
      readCatalogChannelLedger: async () => undefined,
      stageCatalog: async (argv: string[], stageOptions: { internalOutputRoot: string }) => {
        expect(argv).toEqual(['--catalog-version', candidates.catalog]);
        await fs.mkdir(stageOptions.internalOutputRoot, { recursive: true });
        await fs.writeFile(path.join(stageOptions.internalOutputRoot, 'catalog-manifest.json'), '{}');
        await fs.writeFile(path.join(stageOptions.internalOutputRoot, 'plugin-release-ledger.json'), '{}');
        return { outputRoot: stageOptions.internalOutputRoot, snapshotDigest: 'catalog-digest' };
      },
    });
    expect(descriptor).toMatchObject({
      channel: 'beta',
      candidates: { cli: null, catalog: '0.1.1-beta.1' },
      catalog: { minCliVersion: floor },
    });

    const prepared = { root: path.join(releaseRoot, 'prepared'), descriptor };
    const publishCatalog = vi.fn();
    const gateOptions = {
      ...publishOptions(prepared),
      readTargets: async () => bumped.targets,
      assertPackageVersions: async () => ({ targetVersion: bumped.targets.cli }),
      resolveCandidates: async () => descriptor.candidates,
      attemptPath: path.join(releaseRoot, 'attempted.json'),
      publishCatalog,
    };
    await expect(publishPreparedRelease({
      ...gateOptions,
      readPublishedCliVersion: async () => '0.1.0-beta.2',
    })).rejects.toThrow(`requires aw >= ${floor}`);
    expect(publishCatalog).not.toHaveBeenCalled();

    await expect(publishPreparedRelease({
      ...gateOptions,
      readPublishedCliVersion: async () => candidates.cli!,
    })).resolves.toBe(descriptor);
    expect(publishCatalog).toHaveBeenCalledTimes(1);
  });

  it('selects independent CLI and Catalog candidates for stable and beta channels', async () => {
    const stable = await resolvePreparedCandidates('stable', targets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw') ? ['1.2.0'] : ['1.2.0'],
      readPackageChannelVersion: async () => '1.2.0',
      readCatalogVersions: async () => [],
      readCatalogChannelState: async () => null,
    });
    expect(stable).toEqual({ cli: null, catalog: '2.3.0' });

    const beta = await resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async () => ['1.2.0-beta.1'],
      readPackageChannelVersion: async () => '1.2.0-beta.1',
      readCatalogVersions: async () => ['2.3.0-beta.1', '2.3.0-beta.2'],
      readCatalogChannelState: async () => ({ version: '2.3.0-beta.2' }),
    });
    expect(beta).toEqual({ cli: '1.2.0-beta.2', catalog: '2.3.0-beta.3' });

    const readPackageVersions = vi.fn(async () => []);
    const readPackageChannelVersion = vi.fn(async () => null);
    const readCatalogVersions = vi.fn(async () => []);
    const readCatalogChannelState = vi.fn(async () => null);
    await expect(resolvePreparedCandidates('beta', targets, {
      axes: { cli: true, catalog: false },
      readPackageVersions,
      readPackageChannelVersion,
      readCatalogVersions,
      readCatalogChannelState,
    })).resolves.toEqual({ cli: '1.2.0-beta.1', catalog: null });
    expect(readPackageVersions).toHaveBeenCalledTimes(3);
    expect(readCatalogVersions).not.toHaveBeenCalled();
    expect(readCatalogChannelState).not.toHaveBeenCalled();

    await expect(resolvePreparedCandidates('stable', targets, {
      readPackageVersions: async () => [],
      readPackageChannelVersion: async () => '1.3.0',
      readCatalogVersions: async () => [],
      readCatalogChannelState: async () => null,
    })).rejects.toThrow('must be higher');
  });

  it('advances a beta CLI candidate after an uncertain local attempt with no registry result', async () => {
    const root = await temporaryRoot();
    const attemptPath = path.join(root, 'attempted.json');
    await fs.writeFile(attemptPath, JSON.stringify({
      schemaVersion: 1,
      targetsDigest: calculateCanonicalDigest(targets),
      candidates: { cli: '1.2.0-beta.1' },
    }));

    await expect(resolvePreparedCandidates('beta', targets, {
      axes: { cli: true, catalog: false },
      attemptPath,
      readPackageVersions: async () => [],
      readPackageChannelVersion: async () => null,
    })).resolves.toEqual({ cli: '1.2.0-beta.2', catalog: null });
  });

  it('selects a higher stable train after an older partial publication split the npm channel tags', async () => {
    const nextTargets = { ...targets, cli: '1.2.1' };
    await expect(resolvePreparedCandidates('stable', nextTargets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.1.9']
        : ['1.1.9', '1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw') ? '1.1.9' : '1.2.0',
      readCatalogVersions: async () => ['2.3.0'],
      readCatalogChannelState: async () => ({ version: '2.3.0' }),
    })).resolves.toEqual({ cli: '1.2.1', catalog: null });
  });

  it('selects a beta on a higher base after an older partial beta split the npm channel tags', async () => {
    const nextTargets = { ...targets, cli: '1.3.0' };
    await expect(resolvePreparedCandidates('beta', nextTargets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.2.0-beta.1']
        : ['1.2.0-beta.1', '1.2.0-beta.2'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw')
        ? '1.2.0-beta.1'
        : '1.2.0-beta.2',
      readCatalogVersions: async () => ['2.3.0'],
      readCatalogChannelState: async () => null,
    })).resolves.toEqual({ cli: '1.3.0-beta.1', catalog: null });
  });

  it('rejects an unbumped stable target that only one npm package published', async () => {
    await expect(resolvePreparedCandidates('stable', targets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw') ? [] : ['1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw') ? '1.1.9' : '1.2.0',
      readCatalogVersions: async () => ['2.3.0'],
      readCatalogChannelState: async () => ({ version: '2.3.0' }),
    })).rejects.toThrow('CLI train 1.2.0 is only partially published');
  });

  it('advances the whole beta CLI train after partial npm publication', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.2.0-beta.1']
        : ['1.2.0-beta.1', '1.2.0-beta.2'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw')
        ? '1.2.0-beta.1'
        : '1.2.0-beta.2',
      readCatalogVersions: async () => ['2.3.0'],
      readCatalogChannelState: async () => null,
    })).resolves.toEqual({ cli: '1.2.0-beta.3', catalog: null });
  });

  it('requires a new train to be higher than both channel tags and published package versions', async () => {
    const nextTargets = { ...targets, cli: '1.2.1' };
    await expect(resolvePreparedCandidates('stable', nextTargets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.1.9', '1.2.2']
        : ['1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw') ? '1.1.9' : '1.2.0',
      readCatalogVersions: async () => ['2.3.0'],
      readCatalogChannelState: async () => ({ version: '2.3.0' }),
    })).rejects.toThrow('must be higher than published version 1.2.2');
  });

  it('selects a CLI-only beta after the Catalog axis closes', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async () => ['1.2.0-beta.1'],
      readPackageChannelVersion: async () => '1.2.0-beta.1',
      readCatalogVersions: async () => ['2.3.0', '2.3.0-beta.1'],
      readCatalogChannelState: async () => ({ version: '2.3.0-beta.1' }),
    })).resolves.toEqual({ cli: '1.2.0-beta.2', catalog: null });
  });

  it('selects a Catalog-only beta after the CLI axis closes', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async () => ['1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw')
        ? '1.2.0-beta.2'
        : '1.2.0-beta.1',
      readCatalogVersions: async () => ['2.3.0-beta.1'],
      readCatalogChannelState: async () => ({ version: '2.3.0-beta.1' }),
    })).resolves.toEqual({ cli: null, catalog: '2.3.0-beta.2' });
  });

  it('returns a beta no-op after both axes close', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async () => ['1.2.0'],
      readPackageChannelVersion: async () => null,
      readCatalogVersions: async () => ['2.3.0'],
      readCatalogChannelState: async () => null,
    })).resolves.toEqual({ cli: null, catalog: null });
  });

  it('rejects a partially published stable CLI train before selecting beta', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async (name: string) => name.endsWith('/aw') ? ['1.2.0'] : [],
      readPackageChannelVersion: async () => null,
      readCatalogVersions: async () => [],
      readCatalogChannelState: async () => null,
    })).rejects.toThrow('CLI train stable target 1.2.0 is only partially published');
  });

  it('writes an overwriteable ignored descriptor and stages all tarballs from one snapshot', async () => {
    const root = await temporaryRoot();
    const releaseRoot = path.join(root, '.release');
    const evalRoot = path.join(root, 'eval');
    const coreRoot = path.join(root, 'core');
    const cliRoot = path.join(root, 'cli');
    await Promise.all([fs.mkdir(evalRoot), fs.mkdir(coreRoot), fs.mkdir(cliRoot)]);
    await fs.writeFile(path.join(evalRoot, 'package.json'), JSON.stringify({
      name: '@lesliechan721/agent-skill-eval', version: '1.2.0',
    }));
    await fs.writeFile(path.join(coreRoot, 'package.json'), JSON.stringify({
      name: '@lesliechan721/aw-plugin-core', version: '1.2.0',
    }));
    await fs.writeFile(path.join(cliRoot, 'package.json'), JSON.stringify({
      name: '@lesliechan721/aw', version: '1.2.0',
      dependencies: {
        '@lesliechan721/agent-skill-eval': 'workspace:1.2.0',
        '@lesliechan721/aw-plugin-core': 'workspace:1.2.0',
      },
    }));
    const snapshot = {
      ...build,
      evalPackageRoot: evalRoot,
      corePackageRoot: coreRoot,
      cliPackageRoot: cliRoot,
    };
    const pack = (name: string, packageRoot: string) => async ({
      destination,
      snapshot: receivedSnapshot,
    }: { destination: string; snapshot: typeof snapshot }) => {
      expect(receivedSnapshot).toBe(snapshot);
      const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      if (name === 'cli') expect(manifest.dependencies['@lesliechan721/agent-skill-eval']).toBe('1.2.0');
      const output = path.join(destination, `${name}.tgz`);
      await fs.writeFile(output, JSON.stringify(manifest));
      return output;
    };
    const prepareOptions = {
      repoRoot: root,
      releaseRoot,
      assertClean: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => targets,
      assertPackageVersions: async () => ({ targetVersion: targets.cli }),
      resolveHead: async () => head,
      resolveCandidates: async () => ({ cli: '1.2.0', catalog: '2.3.0' }),
      withSnapshot: async (callback: (value: typeof snapshot) => unknown) => callback(snapshot),
      readContent: async () => ({ catalog: { contentDigest: sha256('catalog') } }),
      packEval: pack('eval', evalRoot),
      packCore: pack('core', coreRoot),
      packCli: pack('cli', cliRoot),
      computeTarballTreeDigest: async (file: string) => sha256(await fs.readFile(file)),
      readCatalogChannelLedger: async () => undefined,
      stageCatalog: async (_argv: string[], stageOptions: {
        internalOutputRoot: string;
        snapshot: typeof snapshot;
      }) => {
        expect(stageOptions.snapshot).toBe(snapshot);
        await fs.mkdir(stageOptions.internalOutputRoot, { recursive: true });
        await fs.writeFile(path.join(stageOptions.internalOutputRoot, 'catalog-manifest.json'), '{}');
        await fs.writeFile(path.join(stageOptions.internalOutputRoot, 'plugin-release-ledger.json'), '{}');
        return { outputRoot: stageOptions.internalOutputRoot, snapshotDigest: 'catalog-digest' };
      },
    };
    const descriptor = await prepareLocalRelease('stable', prepareOptions);
    expect(descriptor.axes).toEqual({ cli: true, catalog: true });
    expect(descriptor.build.generationId).toBe('generation-1');
    expect(await fs.readdir(path.join(releaseRoot, 'prepared'))).toContain('descriptor.json');
    await fs.writeFile(path.join(releaseRoot, 'prepared', 'stale'), 'stale');
    await prepareLocalRelease('stable', prepareOptions);
    expect(await fs.stat(path.join(releaseRoot, 'prepared', 'stale')).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(root, 'release', 'current-plan.json')).catch(() => null)).toBeNull();
    await fs.writeFile(path.join(releaseRoot, 'attempted.json'), JSON.stringify({
      targetsDigest: calculateCanonicalDigest(targets),
      candidates: { cli: '1.2.0', catalog: '2.3.0' },
    }));
    await expect(prepareLocalRelease('stable', prepareOptions)).rejects.toThrow('already attempted');
  });

  it.each([
    [{ cli: true, catalog: false }, ['eval', 'core', 'cli']],
    [{ cli: false, catalog: true }, ['catalog']],
    [{ cli: true, catalog: true }, ['eval', 'core', 'cli', 'catalog']],
  ] as const)('publishes enabled axes in eval, CLI, Catalog order: %j', async (axes, expected) => {
    const fixture = await publicationFixture(axes);
    const events: string[] = [];
    await publishPreparedRelease({
      ...publishOptions(fixture),
      runCommand: async (_command: string, args: string[]) => {
        events.push(args[1].includes('eval.tgz')
          ? 'eval'
          : args[1].includes('core.tgz') ? 'core' : 'cli');
      },
      publishCatalog: async () => { events.push('catalog'); },
    });
    expect(events).toEqual(expected);
  });

  it.each(['eval', 'cli'] as const)('stops before Catalog when %s publication is uncertain and requires a bump', async (failure) => {
    const fixture = await publicationFixture({ cli: true, catalog: true });
    const events: string[] = [];
    const publishCatalog = vi.fn();
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      runCommand: async (_command: string, args: string[]) => {
        const current = args[1].includes('eval.tgz') ? 'eval' : 'cli';
        events.push(current);
        if (current === failure) throw new Error('uncertain');
      },
      publishCatalog,
    })).rejects.toThrow('run pnpm release again with --cli-bump');
    expect(publishCatalog).not.toHaveBeenCalled();
    expect(events).toEqual(failure === 'eval' ? ['eval'] : ['eval', 'cli']);
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'attempted.json'), 'utf8')))
      .toMatchObject({ candidates: { cli: '1.2.0' } });
  });

  it('consumes a candidate before the first write and refuses a same-version retry', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: false });
    const runCommand = vi.fn(async () => { throw new Error('uncertain'); });
    await expect(publishPreparedRelease({ ...publishOptions(fixture), runCommand })).rejects.toThrow('Do not retry');
    await expect(publishPreparedRelease({ ...publishOptions(fixture), runCommand })).rejects.toThrow('already attempted');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('repairs only missing CLI packages after verifying existing artifacts', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: false });
    await fs.writeFile(path.join(fixture.root, 'attempted.json'), JSON.stringify({
      schemaVersion: 1,
      targetsDigest: fixture.descriptor.source.targetsDigest,
      candidates: { cli: fixture.descriptor.candidates.cli },
      descriptorDigest: calculateCanonicalDigest(fixture.descriptor),
    }));
    const published = new Set([
      '@lesliechan721/agent-skill-eval',
      '@lesliechan721/aw-plugin-core',
    ]);
    const verified: string[] = [];
    const runNpmCommand = vi.fn(async (_command: string, args: string[]) => {
      expect(args[1]).toContain('cli.tgz');
      published.add('@lesliechan721/aw');
    });
    const publishCliTag = vi.fn(async () => ({
      version: fixture.descriptor.candidates.cli,
      sourceHead: fixture.descriptor.source.head,
      status: 'published',
    }));

    await expect(repairPreparedCliRelease({
      ...publishOptions(fixture),
      readPackageVersions: async (name: string) => published.has(name)
        ? [fixture.descriptor.candidates.cli]
        : [],
      assertPublishedPackageMatches: async (name: string) => {
        expect(published.has(name)).toBe(true);
        verified.push(name);
      },
      runNpmCommand,
      publishCliTag,
    })).resolves.toMatchObject({
      version: fixture.descriptor.candidates.cli,
      status: 'published',
    });

    expect(runNpmCommand).toHaveBeenCalledTimes(1);
    expect(verified).toEqual([
      '@lesliechan721/agent-skill-eval',
      '@lesliechan721/aw-plugin-core',
      '@lesliechan721/aw',
    ]);
    expect(publishCliTag).toHaveBeenCalledOnce();
  });

  it('stops CLI repair when an existing package differs from the prepared artifact', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: false });
    await fs.writeFile(path.join(fixture.root, 'attempted.json'), JSON.stringify({
      schemaVersion: 1,
      targetsDigest: fixture.descriptor.source.targetsDigest,
      candidates: { cli: fixture.descriptor.candidates.cli },
      descriptorDigest: calculateCanonicalDigest(fixture.descriptor),
    }));
    const runNpmCommand = vi.fn();

    await expect(repairPreparedCliRelease({
      ...publishOptions(fixture),
      readPackageVersions: async () => [fixture.descriptor.candidates.cli],
      assertPublishedPackageMatches: async () => {
        throw new Error('different package files');
      },
      runNpmCommand,
    })).rejects.toThrow('different package files');
    expect(runNpmCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['CLI', { cli: '1.2.0', catalog: '2.3.1' }],
    ['Catalog', { cli: '1.2.1', catalog: '2.3.0' }],
  ] as const)('rejects a new descriptor that reuses the attempted %s candidate', async (_axis, candidates) => {
    const fixture = await publicationFixture({ cli: true, catalog: true });
    await fs.writeFile(path.join(fixture.root, 'attempted.json'), JSON.stringify({
      schemaVersion: 1,
      targetsDigest: 'sha256:old-targets',
      candidates: { cli: '1.2.0', catalog: '2.3.0' },
    }));
    fixture.descriptor.candidates = candidates;
    fixture.descriptor.npm!.version = candidates.cli;
    fixture.descriptor.catalog!.version = candidates.catalog;
    const runCommand = vi.fn();

    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      resolveCandidates: async () => candidates,
      runCommand,
    })).rejects.toThrow('already attempted');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('replaces the attempted marker after every participating candidate changes', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: true });
    const nextTargets = { ...targets, cli: '1.2.1', catalog: '2.3.1' };
    const candidates = { cli: '1.2.1', catalog: '2.3.1' };
    await fs.writeFile(path.join(fixture.root, 'attempted.json'), JSON.stringify({
      schemaVersion: 1,
      targetsDigest: calculateCanonicalDigest(targets),
      candidates: { cli: '1.2.0', catalog: '2.3.0' },
    }));
    fixture.descriptor.source.targetsDigest = calculateCanonicalDigest(nextTargets);
    fixture.descriptor.candidates = candidates;
    fixture.descriptor.npm!.version = candidates.cli;
    fixture.descriptor.catalog!.version = candidates.catalog;
    const events: string[] = [];

    await publishPreparedRelease({
      ...publishOptions(fixture),
      readTargets: async () => nextTargets,
      assertPackageVersions: async () => ({ targetVersion: nextTargets.cli }),
      resolveCandidates: async () => candidates,
      runCommand: async () => { events.push('cli'); },
      publishCatalog: async () => { events.push('catalog'); },
    });

    expect(events).toEqual(['cli', 'cli', 'cli', 'catalog']);
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'attempted.json'), 'utf8')))
      .toMatchObject({ candidates });
  });

  it('allows the unattempted Catalog candidate after an Eval failure and only a CLI bump', async () => {
    const failed = await publicationFixture({ cli: true, catalog: true });
    await expect(publishPreparedRelease({
      ...publishOptions(failed),
      runCommand: async () => { throw new Error('uncertain'); },
      publishCatalog: vi.fn(),
    })).rejects.toThrow('Do not retry');

    const nextTargets = { ...targets, cli: '1.2.1' };
    failed.descriptor.source.targetsDigest = calculateCanonicalDigest(nextTargets);
    failed.descriptor.candidates.cli = '1.2.1';
    failed.descriptor.npm!.version = '1.2.1';
    const events: string[] = [];
    await publishPreparedRelease({
      ...publishOptions(failed),
      readTargets: async () => nextTargets,
      assertPackageVersions: async () => ({ targetVersion: nextTargets.cli }),
      runCommand: async () => { events.push('cli'); },
      publishCatalog: async () => { events.push('catalog'); },
    });

    expect(events).toEqual(['cli', 'cli', 'cli', 'catalog']);
    expect(JSON.parse(await fs.readFile(path.join(failed.root, 'attempted.json'), 'utf8')))
      .toMatchObject({ candidates: { cli: '1.2.1', catalog: '2.3.0' } });
  });

  it('records both axes when CLI succeeds and Catalog publication is uncertain', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: true });
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      runCommand: async () => undefined,
      publishCatalog: async () => { throw new Error('uncertain'); },
    })).rejects.toThrow('uncertain');

    expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'attempted.json'), 'utf8')))
      .toMatchObject({ candidates: { cli: '1.2.0', catalog: '2.3.0' } });
  });

  it('rejects HEAD, build, artifact, and registry candidate drift before remote writes', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: false });
    const runCommand = vi.fn();
    await expect(publishPreparedRelease({
      ...publishOptions(fixture), resolveHead: async () => 'b'.repeat(40), runCommand,
    })).rejects.toThrow('HEAD changed');
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      readTargets: async () => ({ ...targets, catalog: '2.3.1' }),
      runCommand,
    })).rejects.toThrow('version targets changed');
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      withSnapshot: async (callback: (value: typeof build) => unknown) => callback({ ...build, outputDigest: 'drift' }),
      runCommand,
    })).rejects.toThrow('outputDigest changed');
    await fs.writeFile(path.join(fixture.root, 'artifacts', 'eval.tgz'), 'drift');
    await expect(publishPreparedRelease({ ...publishOptions(fixture), runCommand }))
      .rejects.toThrow('artifact digest changed');
    const fresh = await publicationFixture({ cli: true, catalog: false });
    await expect(publishPreparedRelease({
      ...publishOptions(fresh),
      readPackageVersions: async () => ['1.2.0'],
      runCommand,
    })).rejects.toThrow('already exists');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a Catalog-only release when the published CLI train is incompatible', async () => {
    const fixture = await publicationFixture({ cli: false, catalog: true });
    fixture.descriptor.catalog!.minCliVersion = '9.0.0';
    const publishCatalog = vi.fn();
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      readPublishedCliVersion: async () => '1.2.0',
      publishCatalog,
    })).rejects.toThrow('requires aw >= 9.0.0');
    expect(publishCatalog).not.toHaveBeenCalled();
  });

  it('rejects Catalog ledger drift and a Catalog-only channel with the wrong npm version type', async () => {
    const drift = await publicationFixture({ cli: false, catalog: true });
    await fs.writeFile(path.join(drift.root, 'artifacts', 'catalog', 'plugin-release-ledger.json'), '{"changed":true}');
    await expect(publishPreparedRelease({ ...publishOptions(drift), publishCatalog: vi.fn() }))
      .rejects.toThrow('ledger digest changed');

    const type = await publicationFixture({ cli: false, catalog: true });
    await expect(publishPreparedRelease({
      ...publishOptions(type),
      readPublishedCliVersion: async () => '1.2.0-beta.1',
      publishCatalog: vi.fn(),
    })).rejects.toThrow('wrong stable/beta type');
  });

  it('rejects a Catalog-only release when the selected npm channel tags are split', async () => {
    const fixture = await publicationFixture({ cli: false, catalog: true });
    const publishCatalog = vi.fn();
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      readPublishedCliVersion: undefined,
      registryUrl: 'https://registry.example.invalid',
      captureCommand: async (_command: string, args: string[]) => ({
        stdout: JSON.stringify(args[1].startsWith('@lesliechan721/aw@') ? '1.1.9' : '1.2.0'),
        stderr: '',
      }),
      publishCatalog,
    })).rejects.toThrow('requires matching published latest versions');
    expect(publishCatalog).not.toHaveBeenCalled();
  });
});
