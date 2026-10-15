import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  resolvePublishedPluginVersions,
  validateCatalogSnapshotComplete,
} from '@lesliechan721/aw-plugin-core';
import { afterEach, describe, expect, it } from 'vitest';

import { planAutomaticBeta } from '../../../../scripts/release/beta-plan.mjs';
import { computePackageTarballTreeDigest } from '../../../../scripts/release/common.mjs';
import { readCatalogPublicationPluginHistory } from '../../src/commands/catalog-publication-inspection.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const packages = [
  ['aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-x64'],
  ['aw-windows-job-win32-arm64', '@lesliechan721/aw-windows-job-win32-arm64'],
  ['agent-skill-eval', '@lesliechan721/agent-skill-eval'],
  ['plugin-core', '@lesliechan721/aw-plugin-core'],
  ['cli', '@lesliechan721/aw'],
];

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root })).stdout.trim();
}

async function packageTarball(root: string, name: string, version: string, payload: string,
  options: { thirdParty?: string; executable?: boolean; optionalVersion?: string } = {}): Promise<string> {
  const directory = await fs.mkdtemp(path.join(root, 'pack-'));
  const manifest = {
    name, version, engines: { node: '>=22' }, bin: { fixture: './dist/index.js' },
    exports: './dist/index.js',
    dependencies: {
      thirdparty: options.thirdParty ?? '1.0.0',
      ...(name === packages[4][1] ? { [packages[2][1]]: version, [packages[3][1]]: version } : {}),
    },
    ...(name === packages[2][1] ? {
      optionalDependencies: {
        [packages[0][1]]: options.optionalVersion ?? version,
        [packages[1][1]]: options.optionalVersion ?? version,
      },
    } : {}),
  };
  await writeJson(path.join(directory, 'package', 'package.json'), manifest);
  await fs.mkdir(path.join(directory, 'package', 'dist'));
  await fs.writeFile(path.join(directory, 'package', 'dist', 'index.js'), payload,
    { mode: options.executable === false ? 0o644 : 0o755 });
  const tarballPath = `${directory}.tgz`;
  await execFileAsync('tar', ['-czf', tarballPath, '-C', directory, 'package']);
  return tarballPath;
}

async function packagesAt(root: string, version: string, payload: string) {
  return Promise.all(packages.map(async ([, name]) => ({
    name, tarballPath: await packageTarball(root, name, version, payload),
  })));
}

async function catalogAt(root: string, readme = '# Production README\n') {
  await createCatalogSnapshotFixture(root, 'demo', [], readme);
  const marker = await readJson(path.join(root, '.aw-generated.json'));
  marker.workspaceIdentity = 'fixture:automatic-beta';
  await writeJson(path.join(root, '.aw-generated.json'), marker);
  return root;
}

async function commit(root: string, message = 'source change') {
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

async function fixture(published = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-beta-plan-test-'));
  roots.push(root);
  const repoRoot = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  await fs.mkdir(repoRoot);
  await git(root, 'init', '--quiet', '--bare', remote);
  await git(repoRoot, 'init', '--quiet', '--initial-branch=main');
  await git(repoRoot, 'config', 'user.name', 'Beta fixture');
  await git(repoRoot, 'config', 'user.email', 'beta@example.invalid');
  await git(repoRoot, 'config', 'commit.gpgsign', 'false');
  await writeJson(path.join(repoRoot, '.aw-workspace.json'), {
    schemaVersion: 1, kind: 'aw-catalog-workspace', workspaceIdentity: 'fixture:automatic-beta',
  });
  await writeJson(path.join(repoRoot, 'release', 'version-targets.json'), { schemaVersion: 2, cli: '1.0.0' });
  await writeJson(path.join(repoRoot, 'plugins', 'marketplace-source.json'), {
    owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture Marketplace' }, catalog: { version: '1.0.0' },
  });
  await writeJson(path.join(repoRoot, 'plugins', 'demo', '.agents-plugin', 'plugin.json'), {
    schemaVersion: 3, name: 'demo', version: '1.0.0',
  });
  await fs.mkdir(path.join(repoRoot, 'packages', 'cli', 'src'), { recursive: true });
  await writeJson(path.join(repoRoot, 'packages', 'cli', 'package.json'), { name: packages[4][1], version: '1.0.0' });
  await fs.writeFile(path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'), 'export const value = 1;\n');
  const baselineSource = await commit(repoRoot, 'initial source');
  await git(repoRoot, 'remote', 'add', 'origin', remote);
  await git(repoRoot, 'push', '--quiet', 'origin', 'main');
  const registry = new Map<string, Map<string, string>>(packages.map(([, name]) => [name, new Map()]));
  const initialPackages = await packagesAt(root, '1.0.0', 'export const value = 1;\n');
  const initialCatalog = await catalogAt(path.join(root, 'initial-catalog'));

  async function publishCli(version: string, source: string, payload: string) {
    const originalHead = await git(repoRoot, 'rev-parse', 'main');
    await git(repoRoot, 'checkout', '--quiet', '--detach', source);
    await writeJson(path.join(repoRoot, 'release', 'version-targets.json'), {
      schemaVersion: 2, cli: version.split('-', 1)[0],
    });
    const changes = await git(repoRoot, 'status', '--porcelain');
    if (changes) await commit(repoRoot, 'legacy version candidate');
    await git(repoRoot, 'tag', `cli-v${version}`);
    await git(repoRoot, 'push', '--quiet', 'origin', `refs/tags/cli-v${version}`);
    await git(repoRoot, 'checkout', '--quiet', 'main');
    expect(await git(repoRoot, 'rev-parse', 'HEAD')).toBe(originalHead);
    for (const artifact of await packagesAt(root, version, payload)) registry.get(artifact.name)!.set(version, artifact.tarballPath);
  }

  async function publishCatalog(version: string, source: string, snapshot: string,
    options: { parentRef?: string; publishChannel?: boolean } = {}) {
    const manifest = await readJson(path.join(snapshot, 'catalog-manifest.json'));
    manifest.catalogVersion = version;
    manifest.channel = version.includes('-') ? 'beta' : 'latest';
    manifest.release = { state: 'published', sourceHead: source };
    const history = await readCatalogPublicationPluginHistory({
      workspaceRoot: repoRoot, remoteUrl: remote,
      branches: ['catalog/latest', 'catalog/beta'], env: process.env,
    });
    const versions = resolvePublishedPluginVersions({ channel: manifest.channel,
      entries: manifest.entries, officialPluginHistory: history });
    for (const entry of manifest.entries) {
      const pluginRoot = path.join(snapshot, 'plugins', entry.name);
      for (const platform of ['agents', 'claude', 'codex']) {
        const pluginPath = path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json');
        const plugin = await readJson(pluginPath);
        plugin.version = versions[entry.name];
        await writeJson(pluginPath, plugin);
      }
      Object.assign(entry, await createCatalogManifestV7Entry(await readPluginManifest(pluginRoot, { mode: 'bundle' }), pluginRoot));
    }
    await writeJson(path.join(snapshot, 'catalog-manifest.json'), manifest);
    await git(snapshot, 'init', '--quiet', `--initial-branch=catalog/${manifest.channel}`);
    await git(snapshot, 'config', 'user.name', 'Beta fixture');
    await git(snapshot, 'config', 'user.email', 'beta@example.invalid');
    await git(snapshot, 'config', 'commit.gpgsign', 'false');
    if (options.parentRef) {
      await git(snapshot, 'fetch', '--quiet', remote, `refs/heads/${options.parentRef}`);
      await git(snapshot, 'reset', '--mixed', 'FETCH_HEAD');
    }
    await commit(snapshot, 'published snapshot');
    await git(snapshot, 'tag', '-a', `catalog-v${version}`, '-m', 'Published snapshot');
    await git(snapshot, 'push', '--quiet', remote,
      ...(options.publishChannel === false ? [] : [`catalog/${manifest.channel}`]),
      `refs/tags/catalog-v${version}`);
  }

  if (published) {
    await publishCli('1.0.0', baselineSource, 'export const value = 1;\n');
    await publishCatalog('1.0.0', baselineSource, initialCatalog);
  }
  let currentPackages = initialPackages;
  let currentCatalog = await catalogAt(path.join(root, 'current-catalog'));
  let sourceHead = baselineSource;
  let builds = 0;
  const options = {
    repoRoot,
    remote,
    sourceHead,
    readPackageVersions: async (name: string) => [...registry.get(name)!.keys()],
    downloadExactPackageTarball: async (name: string, version: string, _manifest: string, destination: string) => {
      const tarballPath = path.join(destination, 'published.tgz');
      await fs.copyFile(registry.get(name)!.get(version)!, tarballPath);
      return { tarballPath, registryUrl: 'https://registry.example.invalid/' };
    },
    withProductionArtifacts: async (_source: unknown, callback: (artifacts: unknown) => Promise<unknown>) => {
      builds += 1;
      return callback({ cli: currentPackages, catalogRoot: currentCatalog,
        validateCatalogSnapshot: validateCatalogSnapshotComplete,
        resolvePublishedPluginVersions, readCatalogPublicationPluginHistory });
    },
  };
  return {
    root, repoRoot, remote, baselineSource, registry, options, publishCli, publishCatalog,
    get builds() { return builds; },
    async change({ cli = false, catalog = false, target }: { cli?: boolean; catalog?: boolean; target?: string } = {}) {
      if (cli) {
        await fs.writeFile(path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'), 'export const value = 2;\n');
        currentPackages = await packagesAt(root, '1.0.0', 'export const value = 2;\n');
      }
      if (catalog) {
        await fs.writeFile(path.join(repoRoot, 'plugins', 'demo', 'README.md'), '# Changed production README\n');
        currentCatalog = await catalogAt(path.join(root, `changed-catalog-${builds}`), '# Changed production README\n');
      }
      if (target) await writeJson(path.join(repoRoot, 'release', 'version-targets.json'), { schemaVersion: 2, cli: target });
      await fs.writeFile(path.join(repoRoot, 'README.md'), `Development notes ${Date.now()}\n`);
      sourceHead = await commit(repoRoot);
      await git(repoRoot, 'push', '--quiet', 'origin', 'main');
      options.sourceHead = sourceHead;
      return sourceHead;
    },
    get catalogRoot() { return currentCatalog; },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('automatic beta product planning', () => {
  it.each([
    { cli: true, catalog: false },
    { cli: false, catalog: true },
    { cli: true, catalog: true },
    { cli: false, catalog: false },
  ])('compares production artifacts independently for $cli/$catalog and preserves main', async (changes) => {
    const f = await fixture();
    const source = await f.change(changes);
    const refs = await git(f.repoRoot, 'show-ref');
    const result = await planAutomaticBeta(f.options);

    expect(result.skipped).toBe(false);
    expect(result.products.cli).toMatchObject({ changed: changes.cli,
      version: changes.cli ? '1.0.1-beta.1' : null, baselineSource: f.baselineSource });
    expect(result.products.catalog).toMatchObject({ changed: changes.catalog,
      version: changes.catalog ? '1.0.1-beta.1' : null, baselineSource: f.baselineSource });
    if (changes.catalog) expect(result.products.catalog.pluginBaseVersions).toEqual({ demo: '1.0.1' });
    expect(await git(f.repoRoot, 'rev-parse', 'HEAD')).toBe(source);
    expect(await git(f.repoRoot, 'status', '--porcelain')).toBe('');
    expect(await git(f.repoRoot, 'show-ref')).toBe(refs);
  });

  it('detects marketplace metadata changes even when all plugin entries are unchanged', async () => {
    const f = await fixture();
    await f.change();
    for (const relative of ['catalog-manifest.json', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
      const value = await readJson(path.join(f.catalogRoot, relative));
      (relative === 'catalog-manifest.json' ? value.marketplace : value).owner.name = 'New Owner';
      await writeJson(path.join(f.catalogRoot, relative), value);
    }
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli.changed).toBe(false);
    expect(result.products.catalog.changed).toBe(true);
  });

  it('detects a deleted plugin and reports it in the affected inventory', async () => {
    const f = await fixture();
    await fs.rm(path.join(f.repoRoot, 'plugins', 'demo'), { recursive: true });
    await f.change();
    await fs.rm(path.join(f.catalogRoot, 'plugins', 'demo'), { recursive: true });
    for (const relative of ['catalog-manifest.json', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
      const value = await readJson(path.join(f.catalogRoot, relative));
      if (relative === 'catalog-manifest.json') value.entries = [];
      else value.plugins = [];
      await writeJson(path.join(f.catalogRoot, relative), value);
    }
    const result = await planAutomaticBeta(f.options);
    expect(result.products.catalog).toMatchObject({ changed: true, affectedPlugins: ['demo'] });
  });

  it('keeps a higher beta line while failed source tags, partial packages and attempts occupy numbers', async () => {
    const f = await fixture();
    await f.change({ cli: true });
    await git(f.repoRoot, 'tag', 'release/cli/v2.0.0-beta.4');
    await git(f.repoRoot, 'push', '--quiet', 'origin', 'refs/tags/release/cli/v2.0.0-beta.4');
    f.registry.get(packages[0][1])!.set('2.0.0-beta.6', 'not-downloaded-partial');
    await writeJson(path.join(f.repoRoot, '.release', 'attempted.json'), {
      schemaVersion: 1, candidates: { cli: '2.0.0-beta.8' },
    });
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ version: '2.0.0-beta.9', baseVersion: '2.0.0', baselineSource: f.baselineSource });
    expect(result.products.catalog.changed).toBe(false);
  });

  it('applies an explicit higher target without production changes and rejects explicit downgrade', async () => {
    const f = await fixture();
    await f.change({ target: '2.0.0' });
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ changed: true, version: '2.0.0-beta.1' });
    await git(f.repoRoot, 'tag', 'release/cli/v3.0.0-beta.2');
    await git(f.repoRoot, 'push', '--quiet', 'origin', 'refs/tags/release/cli/v3.0.0-beta.2');
    const conflict = await planAutomaticBeta(f.options);
    expect(conflict.products.cli).toMatchObject({ changed: false, version: null,
      error: expect.stringContaining('Explicit version target 2.0.0 conflicts') });
    expect(conflict.products.catalog).not.toHaveProperty('error');
  });

  it('uses the latest successful main source across stable and beta and ignores later documentation changes', async () => {
    const f = await fixture();
    const delivered = await f.change({ cli: true, catalog: true });
    await f.publishCli('1.0.1-beta.3', delivered, 'export const value = 2;\n');
    const publishedCatalog = await catalogAt(path.join(f.root, 'beta-catalog'), '# Changed production README\n');
    await f.publishCatalog('1.0.1-beta.3', delivered, publishedCatalog);
    await f.change();

    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ changed: false, version: null, baselineSource: delivered, baselineVersion: '1.0.1-beta.3' });
    expect(result.products.catalog).toMatchObject({ changed: false, version: null, baselineSource: delivered, baselineVersion: '1.0.1-beta.3' });
  });

  it('uses the source base for the first delivery and preserves occupied Catalog journal numbers', async () => {
    const f = await fixture(false);
    f.registry.get(packages[0][1])!.set('0.9.0-beta.3', 'earlier-failed-line');
    await fs.mkdir(path.join(f.repoRoot, '.aw', 'publish', '1.0.0-beta.4'), { recursive: true });
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ changed: true, version: '1.0.0-beta.1', baselineSource: null });
    expect(result.products.catalog).toMatchObject({ changed: true, version: '1.0.0-beta.5', baselineSource: null });
  });

  it('keeps registry failure distinct from a first release and still plans Catalog', async () => {
    const f = await fixture(false);
    const result = await planAutomaticBeta({ ...f.options,
      readPackageVersions: async () => { throw new Error('registry unavailable'); },
    });
    expect(result.products.cli).toMatchObject({ changed: false, version: null, error: 'registry unavailable' });
    expect(result.products.catalog).toMatchObject({ changed: true, version: '1.0.0-beta.1' });
    expect(f.builds).toBe(1);
  });

  it('keeps a partial five-package completion out of the successful source baseline', async () => {
    const f = await fixture();
    const source = await f.change({ cli: true });
    await f.publishCli('1.0.1-beta.7', source, 'export const value = 2;\n');
    f.registry.get(packages[4][1])!.delete('1.0.1-beta.7');
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ changed: true, version: '1.0.1-beta.8', baselineSource: f.baselineSource });
  });

  it.each(['missing', 'parent', 'complete', 'later'] as const)(
    'requires channel delivery before treating a Catalog tag as a successful baseline: %s', async (state) => {
      const f = await fixture(state !== 'missing');
      if (state === 'missing') {
        await f.publishCli('1.0.0', f.baselineSource, 'export const value = 1;\n');
      } else {
        const parent = await catalogAt(path.join(f.root, 'channel-parent'));
        await f.publishCatalog('1.0.0-beta.1', f.baselineSource, parent);
      }
      const candidateSource = await f.change({ cli: true, catalog: state !== 'missing' });
      const candidateVersion = state === 'missing' ? '1.0.0-beta.1' : '1.0.1-beta.1';
      const snapshot = await catalogAt(path.join(f.root, 'partial-catalog'),
        state === 'missing' ? '# Production README\n' : '# Changed production README\n');
      await f.publishCatalog(candidateVersion, candidateSource, snapshot, {
        parentRef: state === 'missing' ? undefined : 'catalog/beta',
        publishChannel: state === 'complete' || state === 'later',
      });
      if (state === 'later') {
        await git(snapshot, 'commit', '--quiet', '--allow-empty', '-m', 'Later channel commit');
        await git(snapshot, 'push', '--quiet', f.remote, 'catalog/beta');
      }
      await fs.mkdir(path.join(f.repoRoot, 'tests'));
      await fs.writeFile(path.join(f.repoRoot, 'tests', 'only-test-change.txt'), 'test-only change\n');
      f.options.sourceHead = await commit(f.repoRoot, 'test-only follow-up');
      await git(f.repoRoot, 'push', '--quiet', 'origin', 'main');

      const result = await planAutomaticBeta(f.options);
      const delivered = state === 'complete' || state === 'later';
      expect(result.products.catalog).toMatchObject({
        changed: !delivered,
        version: delivered ? null : state === 'missing' ? '1.0.0-beta.2' : '1.0.1-beta.2',
        baselineSource: delivered ? candidateSource : state === 'missing' ? null : f.baselineSource,
        baselineVersion: delivered ? candidateVersion : state === 'missing' ? null : '1.0.0',
      });
      expect(result.products.catalog).not.toHaveProperty('error');
      expect(result.products.cli).toMatchObject({ changed: true, version: '1.0.1-beta.1',
        baselineSource: f.baselineSource });
      expect(result.products.cli).not.toHaveProperty('error');
    },
  );

  it('keeps invalid Catalog content isolated from a valid CLI production change', async () => {
    const f = await fixture();
    await f.change({ cli: true });
    await fs.writeFile(path.join(f.catalogRoot, 'plugins', 'demo', 'README.md'), 'tampered after digest\n');
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ changed: true, version: '1.0.1-beta.1' });
    expect(result.products.catalog).toMatchObject({ changed: false, version: null,
      error: expect.stringContaining('does not match its plugin bundle') });
  });

  it('skips superseded CI sources before build and rechecks main after comparison', async () => {
    const f = await fixture();
    await f.change();
    const skipped = await planAutomaticBeta({ ...f.options, sourceHead: f.baselineSource });
    expect(skipped).toMatchObject({ skipped: true, products: { cli: { changed: false, version: null } } });
    expect(f.builds).toBe(0);
    const original = f.options.withProductionArtifacts;
    const result = await planAutomaticBeta({ ...f.options,
      withProductionArtifacts: async (source: unknown, callback: (artifacts: unknown) => Promise<unknown>) => {
        const value = await original(source, callback);
        await f.change({ cli: true });
        return value;
      },
    });
    expect(result.skipped).toBe(true);
    expect((await git(f.repoRoot, 'ls-remote', '--refs', f.remote, 'refs/tags/release/*')).trim()).toBe('');
  });

  it('rejects a completion tag whose source includes unmerged production changes', async () => {
    const f = await fixture();
    await git(f.repoRoot, 'checkout', '--quiet', '--detach', f.baselineSource);
    await fs.writeFile(path.join(f.repoRoot, 'packages', 'cli', 'src', 'index.ts'), 'unmerged production\n');
    await commit(f.repoRoot, 'unmerged source');
    await git(f.repoRoot, 'tag', 'cli-v1.0.1-beta.1');
    await git(f.repoRoot, 'push', '--quiet', 'origin', 'refs/tags/cli-v1.0.1-beta.1');
    await git(f.repoRoot, 'checkout', '--quiet', 'main');
    for (const [, name] of packages) f.registry.get(name)!.set('1.0.1-beta.1', 'not-downloaded');
    const result = await planAutomaticBeta(f.options);
    expect(result.products.cli).toMatchObject({ changed: false, version: null,
      error: expect.stringContaining('non-version path') });
    expect(result.products.catalog).not.toHaveProperty('error');
  });
});

describe('release production package normalization', () => {
  it('normalizes all five release versions and both Eval Windows dependencies, while retaining actual dependencies and modes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-beta-package-test-'));
    roots.push(root);
    const old = await packagesAt(root, '1.0.0', 'production\n');
    const candidate = await packagesAt(root, '1.0.1-beta.4', 'production\n');
    for (let index = 0; index < old.length; index += 1) {
      expect(await computePackageTarballTreeDigest(old[index].tarballPath, { normalizeReleaseMetadata: true }))
        .toBe(await computePackageTarballTreeDigest(candidate[index].tarballPath, { normalizeReleaseMetadata: true }));
    }
    const original = await computePackageTarballTreeDigest(candidate[2].tarballPath, { normalizeReleaseMetadata: true });
    for (const change of [{ thirdParty: '2.0.0' }, { executable: false }]) {
      const changed = await packageTarball(root, packages[2][1], '1.0.1-beta.4', 'production\n', change);
      expect(await computePackageTarballTreeDigest(changed, { normalizeReleaseMetadata: true })).not.toBe(original);
    }
    const invalid = await packageTarball(root, packages[2][1], '1.0.1-beta.4', 'production\n', { optionalVersion: '1.0.0' });
    await expect(computePackageTarballTreeDigest(invalid, { normalizeReleaseMetadata: true }))
      .rejects.toThrow('must optionally depend');
  });
});
