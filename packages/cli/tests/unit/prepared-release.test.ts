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
  selectCatalogReleaseCandidate,
} from '../../../../scripts/release/prepared-release.mjs';
import { captureCommand } from '../../../../scripts/release/common.mjs';
import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';
import { updateReleaseTargets } from '../../../../scripts/release/release-target.mjs';
import {
  prepareCatalogRelease,
  readCatalogAttemptVersions,
  readReusableCatalogAttempt,
} from '../../../../scripts/release/catalog-publication.mjs';

const roots: string[] = [];
const head = 'a'.repeat(40);
const build = {
  generationId: 'generation-1',
  inputDigest: 'input-1',
  outputDigest: 'output-1',
  cliPackageDigest: 'cli-1',
};
const targets = { schemaVersion: 2, cli: '1.2.0' };

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

function catalogPublicationPlan(overrides: Record<string, unknown> = {}) {
  return {
    catalogVersion: '2.3.0',
    channel: 'latest',
    planDigest: sha256('catalog-plan'),
    ...overrides,
  };
}

async function publicationFixture(axes: { cli: boolean; catalog: boolean }) {
  const root = await temporaryRoot();
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const evalBytes = Buffer.from('eval-tarball');
  const coreBytes = Buffer.from('core-tarball');
  const cliBytes = Buffer.from('cli-tarball');
  await fs.writeFile(path.join(artifacts, 'eval.tgz'), evalBytes);
  await fs.writeFile(path.join(artifacts, 'core.tgz'), coreBytes);
  await fs.writeFile(path.join(artifacts, 'cli.tgz'), cliBytes);
  const catalogPublication = catalogPublicationPlan();
  return {
    root,
    descriptor: {
      schemaVersion: 1,
      source: {
        head,
        targetsDigest: axes.cli ? calculateCanonicalDigest(targets) : null,
      },
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
        version: '2.3.0', publication: { planDigest: catalogPublication.planDigest },
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
    assertCliTagAvailable: async () => undefined,
    publishCliTag: async () => undefined,
    computeTarballTreeDigest: async (file: string) => file.endsWith('eval.tgz')
      ? 'eval-tree'
      : file.endsWith('core.tgz') ? 'core-tree' : 'cli-tree',
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

    await fs.rm(path.join(root, 'packages', 'cli', 'src', 'ignored.ts'));
    await fs.mkdir(path.join(root, 'packages', 'agent-skill-eval', 'schemas'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'packages', 'agent-skill-eval', 'schemas', 'ignored.json'),
      '{}\n',
    );
    await expect(assertTrackedHeadClean(root)).rejects.toThrow(
      'packages/agent-skill-eval/schemas/ignored.json',
    );
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
      schemaVersion: 2, cli: '1.2.0',
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

  it('prepares and publishes Catalog-only without reading CLI targets or npm state', async () => {
    const root = await temporaryRoot();
    const releaseRoot = path.join(root, '.release');
    const candidate = '0.1.1-beta.1';
    const forbiddenCliRead = vi.fn(async () => {
      throw new Error('CLI state must not be read');
    });
    const descriptor = await prepareLocalRelease('beta', {
      repoRoot: root,
      releaseRoot,
      axes: { cli: false, catalog: true },
      assertClean: async () => undefined,
      readTargets: forbiddenCliRead,
      assertPackageVersions: forbiddenCliRead,
      resolveHead: async () => head,
      resolveCandidates: async () => ({ cli: null, catalog: candidate }),
      withSnapshot: async (callback: (snapshot: typeof build) => unknown) => callback(build),
      prepareCatalog: async (mode: string) => {
        expect(mode).toBe('beta');
        return {
          ...catalogPublicationPlan(),
          catalogVersion: candidate,
          channel: 'beta',
        };
      },
    });
    expect(descriptor.source.targetsDigest).toBeNull();
    expect(descriptor.catalog).toEqual({
      version: candidate,
      publication: { planDigest: sha256('catalog-plan') },
    });
    expect(forbiddenCliRead).not.toHaveBeenCalled();

    const prepared = { root: path.join(releaseRoot, 'prepared'), descriptor };
    const publishCatalog = vi.fn();
    const captureNpm = vi.fn(async () => {
      throw new Error('npm must not be queried');
    });
    await expect(publishPreparedRelease({
      ...publishOptions(prepared),
      readTargets: forbiddenCliRead,
      assertPackageVersions: forbiddenCliRead,
      captureCommand: captureNpm,
      publishCatalog,
    })).resolves.toBe(descriptor);
    expect(forbiddenCliRead).not.toHaveBeenCalled();
    expect(captureNpm).not.toHaveBeenCalled();
    expect(publishCatalog).toHaveBeenCalledOnce();
  });

  it('selects Catalog candidates from exact metadata, published tags, and every journal', () => {
    expect(selectCatalogReleaseCandidate('stable', '2.3.0', [])).toBe('2.3.0');
    expect(selectCatalogReleaseCandidate('stable', '2.3.0', ['2.3.0'])).toBeNull();
    expect(selectCatalogReleaseCandidate('stable', '2.3.0-beta.4', [
      '2.3.0-beta.4',
    ])).toBe('2.3.0');
    expect(selectCatalogReleaseCandidate('stable', '2.3.0-beta.4', [
      '2.3.0-beta.4', '2.3.0',
    ])).toBeNull();
    expect(selectCatalogReleaseCandidate('beta', '2.3.0-beta.2', [
      '2.3.0-beta.1',
    ])).toBe('2.3.0-beta.2');
    expect(selectCatalogReleaseCandidate('beta', '2.3.0-beta.2', [
      '2.3.0-beta.1', '2.3.0-beta.2', '2.3.0-beta.4',
    ])).toBe('2.3.0-beta.5');
    expect(selectCatalogReleaseCandidate('beta', '2.3.0', [
      '2.3.0', '2.3.0-beta.1',
    ])).toBe('2.3.0-beta.2');
  });

  it('treats a corrupt Workspace journal as an occupied exact Catalog version', async () => {
    const root = await temporaryRoot();
    const journalsRoot = path.join(root, '.aw', 'publish');
    await fs.mkdir(journalsRoot, { recursive: true });
    await fs.writeFile(path.join(journalsRoot, '2.3.0-beta.2.json'), '{ corrupt journal');
    const attempted = await readCatalogAttemptVersions({ repoRoot: root });
    expect(attempted).toEqual(['2.3.0-beta.2']);
    expect(selectCatalogReleaseCandidate('beta', '2.3.0-beta.2', attempted))
      .toBe('2.3.0-beta.3');
  });

  it.each(['prepared', 'uncertain'] as const)(
    'reuses a strictly validated %s journal for the current exact Catalog version',
    async (state) => {
      const root = await temporaryRoot();
      await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
      await fs.mkdir(path.join(root, '.aw', 'publish'), { recursive: true });
      await fs.writeFile(path.join(root, 'plugins', 'marketplace-source.json'), JSON.stringify({
        catalog: { version: '2.3.0-beta.2' },
      }));
      await fs.writeFile(path.join(root, '.aw', 'publish', '2.3.0-beta.2.json'), '{}');
      const prepareCatalogPublicationPlan = vi.fn(async () => ({
        state,
        catalogVersion: '2.3.0-beta.2',
        channel: 'beta',
      }));

      await expect(readReusableCatalogAttempt('beta', '2.3.0-beta.2', {
        repoRoot: root,
        catalogPublicationService: { prepareCatalogPublicationPlan },
      })).resolves.toBe('2.3.0-beta.2');
      expect(prepareCatalogPublicationPlan).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: root,
        branch: 'catalog/beta',
      }));
    },
  );

  it('keeps published and non-matching Catalog attempts occupied', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
    await fs.mkdir(path.join(root, '.aw', 'publish'), { recursive: true });
    await fs.writeFile(path.join(root, 'plugins', 'marketplace-source.json'), JSON.stringify({
      catalog: { version: '2.3.0' },
    }));
    await fs.writeFile(path.join(root, '.aw', 'publish', '2.3.0.json'), '{}');
    await expect(readReusableCatalogAttempt('stable', '2.3.0', {
      repoRoot: root,
      catalogPublicationService: {
        prepareCatalogPublicationPlan: async () => ({
          state: 'published', catalogVersion: '2.3.0', channel: 'latest',
        }),
      },
    })).resolves.toBeNull();
    await expect(readReusableCatalogAttempt('stable', '2.3.0', {
      repoRoot: root,
      catalogPublicationService: {
        prepareCatalogPublicationPlan: async () => {
          throw new Error('Catalog publication identity changed. Increase the Catalog version.');
        },
      },
    })).rejects.toThrow('Increase the Catalog version');

    await expect(resolvePreparedCandidates('stable', targets, {
      axes: { cli: false, catalog: true },
      readCatalogVersion: async () => '2.3.0',
      readCatalogVersions: async () => [],
      readCatalogAttemptVersions: async () => ['2.3.0'],
      readReusableCatalogAttempt: async () => null,
    })).resolves.toEqual({ cli: null, catalog: null });

    await expect(resolvePreparedCandidates('beta', targets, {
      axes: { cli: false, catalog: true },
      readCatalogVersion: async () => '2.3.0-beta.2',
      readCatalogVersions: async () => [],
      readCatalogAttemptVersions: async () => ['2.3.0-beta.2'],
      readReusableCatalogAttempt: async () => null,
    })).resolves.toEqual({ cli: null, catalog: '2.3.0-beta.3' });
  });

  it.each([
    ['stable', '2.3.0'],
    ['beta', '2.3.0-beta.2'],
  ] as const)('does not skip the current %s Catalog version for a reusable plan', async (channel, version) => {
    await expect(resolvePreparedCandidates(channel, targets, {
      axes: { cli: false, catalog: true },
      readCatalogVersion: async () => version,
      readCatalogVersions: async () => [],
      readCatalogAttemptVersions: async () => [version],
      readReusableCatalogAttempt: async () => version,
    })).resolves.toEqual({ cli: null, catalog: version });
  });

  it('rejects an official channel mismatch before creating a publication plan', async () => {
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(root, 'plugins', 'marketplace-source.json'), JSON.stringify({
      catalog: { version: '2.3.0-beta.1' },
    }));
    const prepareCatalogPublicationPlan = vi.fn();
    await expect(prepareCatalogRelease('latest', {
      repoRoot: root,
      catalogPublicationService: { prepareCatalogPublicationPlan },
    })).rejects.toThrow('does not match the latest release channel');
    expect(prepareCatalogPublicationPlan).not.toHaveBeenCalled();
  });

  it('selects independent CLI and exact Catalog candidates without cross-axis closure', async () => {
    await expect(resolvePreparedCandidates('stable', targets, {
      readPackageVersions: async () => ['1.2.0'],
      readPackageChannelVersion: async () => '1.2.0',
      readCatalogVersion: async () => '2.3.0',
      readCatalogVersions: async () => ['2.3.0-beta.3'],
      readCatalogAttemptVersions: async () => [],
    })).resolves.toEqual({ cli: null, catalog: '2.3.0' });

    await expect(resolvePreparedCandidates('beta', targets, {
      readPackageVersions: async () => ['1.2.0-beta.1'],
      readPackageChannelVersion: async () => '1.2.0-beta.1',
      readCatalogVersion: async () => '2.3.0-beta.2',
      readCatalogVersions: async () => ['2.3.0-beta.1'],
      readCatalogAttemptVersions: async () => [],
    })).resolves.toEqual({ cli: '1.2.0-beta.2', catalog: '2.3.0-beta.2' });

    const readCatalogVersions = vi.fn(async () => []);
    await expect(resolvePreparedCandidates('beta', targets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async () => [],
      readPackageChannelVersion: async () => null,
      readCatalogVersions,
    })).resolves.toEqual({ cli: '1.2.0-beta.1', catalog: null });
    expect(readCatalogVersions).not.toHaveBeenCalled();
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

  it('selects a higher stable CLI train after an older partial publication split the npm channel tags', async () => {
    const nextTargets = { ...targets, cli: '1.2.1' };
    await expect(resolvePreparedCandidates('stable', nextTargets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.1.9']
        : ['1.1.9', '1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw') ? '1.1.9' : '1.2.0',
    })).resolves.toEqual({ cli: '1.2.1', catalog: null });
  });

  it('selects a beta on a higher base after an older partial beta split the npm channel tags', async () => {
    const nextTargets = { ...targets, cli: '1.3.0' };
    await expect(resolvePreparedCandidates('beta', nextTargets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.2.0-beta.1']
        : ['1.2.0-beta.1', '1.2.0-beta.2'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw')
        ? '1.2.0-beta.1'
        : '1.2.0-beta.2',
    })).resolves.toEqual({ cli: '1.3.0-beta.1', catalog: null });
  });

  it('rejects an unbumped stable target that only one npm package published', async () => {
    await expect(resolvePreparedCandidates('stable', targets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async (name: string) => name.endsWith('/aw') ? [] : ['1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw') ? '1.1.9' : '1.2.0',
    })).rejects.toThrow('CLI train 1.2.0 is only partially published');
  });

  it('advances the whole beta CLI train after partial npm publication', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.2.0-beta.1']
        : ['1.2.0-beta.1', '1.2.0-beta.2'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw')
        ? '1.2.0-beta.1'
        : '1.2.0-beta.2',
    })).resolves.toEqual({ cli: '1.2.0-beta.3', catalog: null });
  });

  it('requires a new train to be higher than both channel tags and published package versions', async () => {
    const nextTargets = { ...targets, cli: '1.2.1' };
    await expect(resolvePreparedCandidates('stable', nextTargets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async (name: string) => name.endsWith('/aw')
        ? ['1.1.9', '1.2.2']
        : ['1.2.0'],
      readPackageChannelVersion: async (name: string) => name.endsWith('/aw') ? '1.1.9' : '1.2.0',
    })).rejects.toThrow('must be higher than published version 1.2.2');
  });

  it('rejects a partially published stable CLI train before selecting beta', async () => {
    await expect(resolvePreparedCandidates('beta', targets, {
      axes: { cli: true, catalog: false },
      readPackageVersions: async (name: string) => name.endsWith('/aw') ? ['1.2.0'] : [],
      readPackageChannelVersion: async () => null,
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
      packEval: pack('eval', evalRoot),
      packCore: pack('core', coreRoot),
      packCli: pack('cli', cliRoot),
      computeTarballTreeDigest: async (file: string) => sha256(await fs.readFile(file)),
      prepareCatalog: async (mode: string) => {
        expect(mode).toBe('latest');
        return catalogPublicationPlan();
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

  it('rejects a new descriptor that reuses the attempted CLI candidate', async () => {
    const candidates = { cli: '1.2.0', catalog: '2.3.1' };
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

  it('does not let .release/attempted.json own the Catalog candidate', async () => {
    const fixture = await publicationFixture({ cli: false, catalog: true });
    await fs.writeFile(path.join(fixture.root, 'attempted.json'), '{ corrupt CLI attempt');
    const publishCatalog = vi.fn();

    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      publishCatalog,
    })).resolves.toBe(fixture.descriptor);
    expect(publishCatalog).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(fixture.root, 'attempted.json'), 'utf8'))
      .resolves.toBe('{ corrupt CLI attempt');
  });

  it('replaces the attempted marker after every participating candidate changes', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: true });
    const nextTargets = { ...targets, cli: '1.2.1' };
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
      .toMatchObject({ candidates: { cli: candidates.cli } });
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
      .toMatchObject({ candidates: { cli: '1.2.1' } });
  });

  it('keeps Catalog journal state out of .release/attempted.json when publication is uncertain', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: true });
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      runCommand: async () => undefined,
      publishCatalog: async () => { throw new Error('uncertain'); },
    })).rejects.toThrow('uncertain');

    expect(JSON.parse(await fs.readFile(path.join(fixture.root, 'attempted.json'), 'utf8')))
      .toMatchObject({ candidates: { cli: '1.2.0' } });
  });

  it('rejects HEAD, build, artifact, and registry candidate drift before remote writes', async () => {
    const fixture = await publicationFixture({ cli: true, catalog: false });
    const runCommand = vi.fn();
    await expect(publishPreparedRelease({
      ...publishOptions(fixture), resolveHead: async () => 'b'.repeat(40), runCommand,
    })).rejects.toThrow('HEAD changed');
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      readTargets: async () => ({ ...targets, cli: '1.2.1' }),
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

  it('publishes Catalog-only without an npm version provider gate', async () => {
    const fixture = await publicationFixture({ cli: false, catalog: true });
    const publishCatalog = vi.fn();
    const readPublishedCliVersion = vi.fn(async () => {
      throw new Error('npm compatibility must not be queried');
    });
    await expect(publishPreparedRelease({
      ...publishOptions(fixture),
      readPublishedCliVersion,
      publishCatalog,
    })).resolves.toBe(fixture.descriptor);
    expect(readPublishedCliVersion).not.toHaveBeenCalled();
    expect(publishCatalog).toHaveBeenCalledOnce();
  });

  it('applies the exact Catalog plan authorized by the prepared release', async () => {
    const fixture = await publicationFixture({ cli: false, catalog: true });
    const publishCatalog = vi.fn();
    await publishPreparedRelease({ ...publishOptions(fixture), publishCatalog });
    expect(publishCatalog).toHaveBeenCalledWith({
      channel: 'stable',
      expectedPlanDigest: fixture.descriptor.catalog!.publication.planDigest,
    }, expect.any(Object));
  });
});
