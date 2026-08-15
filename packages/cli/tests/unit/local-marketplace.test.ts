import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireCurrentCatalogCacheLease,
  buildCurrentCatalogCacheKey,
  calculateBundleFingerprint,
  initializeLocalMarketplace,
  markCurrentCatalogCacheEntryValidated,
  readCliPackageInfo,
  readCurrentCatalogCacheEntry,
  readCurrentCatalogCacheEntryBySelector,
  setLocalMarketplaceAfterCatalogCachePreservedForTests,
  setLocalMarketplaceAfterTargetMovedToBackupForTests,
  setLocalMarketplaceAfterStagingPreparedForTests,
  validateLocalMarketplaceLayout,
  writeCurrentCatalogCacheEntry,
  type CurrentCatalogCacheEntry,
  type CurrentCatalogCacheIdentity,
  type CurrentCatalogCacheObservation,
} from '../../src/utils/local-marketplace.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  catalogSourceCacheInternal,
} from '../../src/utils/catalog-source-cache.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import {
  CatalogLeaseEscapeError,
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  type CatalogSourceProviderSet,
} from '../../src/utils/multi-source-catalog.js';
import { CATALOG_SOURCES_FILE } from '../../src/constants.js';
import {
  addCatalogSource,
  calculateCatalogSourcesConfigDigest,
  createDefaultCatalogSourcesConfig,
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { getCodexHome, resolveCurrentCatalogCacheEntryDir } from '../../src/utils/paths.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import {
  patchPluginConfigStore,
  setAtomicConfigBeforeRenameHookForTests,
} from '../../src/utils/plugin-config.js';
import { acquireLifecycleOperationLock } from '../../src/utils/lifecycle-active-store.js';
import { withActiveMarketplaceRuntimeLease } from '../../src/utils/active-marketplace-runtime-lock.js';
import { writeDynamicSkillTree } from '../../src/utils/dynamic-skill-tree.js';
import type { ProcessLockLease } from '../../src/utils/process-lock.js';
import type {
  CatalogResolution,
  CatalogSelector,
  CatalogSourcesConfig,
} from '../../src/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';

const tempDirs: string[] = [];
const {
  persistCatalogSourceObjectFault,
  readCatalogSourceCache,
  resolveCatalogSourceCacheLocation,
  withCatalogSourceCacheLease,
  withCatalogSourceCacheLock,
} = catalogSourceCacheInternal;
const resolveGitCatalogSource = catalogGitProviderInternal.resolve;
const resolvePathCatalogSource = catalogPathProviderInternal.resolve;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => { resolve = done; }),
    resolve,
  };
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  awHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cache-regression-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  return {
    awHome,
    embeddedRoot,
    env: { ...process.env, AW_HOME: awHome },
  };
}

async function makeCacheFixture(options: {
  awHome?: string;
  selector?: CatalogSelector;
  catalogVersion?: string;
} = {}): Promise<{
  env: NodeJS.ProcessEnv;
  sourceRoot: string;
  identity: CurrentCatalogCacheIdentity;
}> {
  const root = options.awHome
    ? path.dirname(options.awHome)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'aw-current-catalog-cache-'));
  if (!options.awHome) tempDirs.push(root);
  const awHome = options.awHome ?? path.join(root, 'aw-home');
  const sourceRoot = path.join(root, `source-${options.catalogVersion ?? '1.0.0'}`);
  await fs.ensureDir(sourceRoot);
  await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), {
    version: options.catalogVersion ?? '1.0.0',
  });
  return {
    env: { ...process.env, AW_HOME: awHome },
    sourceRoot,
    identity: {
      selector: options.selector ?? {
        kind: 'distTag',
        cliVersion: '1.0.0',
        defaultChannel: 'latest',
        requestedChannel: 'latest',
      },
      channel: 'latest',
      catalogVersion: options.catalogVersion ?? '1.0.0',
      minAwVersion: '1.0.0',
      schemaVersion: 1,
      sidecarIntegrity: `sha512-sidecar-${options.catalogVersion ?? '1.0.0'}`,
      fullIntegrity: `sha512-full-${options.catalogVersion ?? '1.0.0'}`,
    },
  };
}

function observation(
  entry: CurrentCatalogCacheEntry,
  sourceIdentity: string,
  observationOrder: number,
): CurrentCatalogCacheObservation {
  return {
    sidecarManifestPackage: {
      source: '@lesliechan721/aw-plugins-manifest',
      version: entry.metadata.catalogVersion,
      channel: entry.metadata.channel,
      npmIntegrity: entry.metadata.sidecarIntegrity,
      manifestDigest: entry.metadata.manifestDigest,
    },
    sourceIdentity,
    observationOrder,
  };
}

async function embeddedResolution(
  embeddedRoot: string,
): Promise<CatalogResolution> {
  const packageInfo = await readCliPackageInfo();
  return {
    rootDir: embeddedRoot,
    source: 'embedded',
    selector: {
      kind: 'default',
      cliVersion: packageInfo.version,
      defaultChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
    },
  };
}

afterEach(async () => {
  setLocalMarketplaceAfterStagingPreparedForTests(undefined);
  setLocalMarketplaceAfterCatalogCachePreservedForTests(undefined);
  setLocalMarketplaceAfterTargetMovedToBackupForTests(undefined);
  setAtomicConfigBeforeRenameHookForTests(undefined);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('strict current catalog cache', () => {
  it('holds the sibling cache lease before reading the multi-source config snapshot', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const customPrimaryRoot = path.join(path.dirname(workspace.awHome), 'custom-primary');
    const secondaryRoot = path.join(path.dirname(workspace.awHome), 'secondary');
    await Promise.all([
      createCatalogSnapshotFixture(customPrimaryRoot, 'primary-plugin'),
      createCatalogSnapshotFixture(secondaryRoot, 'secondary-plugin'),
    ]);
    const config: CatalogSourcesConfig = {
      schemaVersion: 1,
      sources: [
        { id: 'custom-primary', type: 'path', primary: true, path: customPrimaryRoot },
        { id: 'secondary', type: 'path', primary: false, path: secondaryRoot },
      ],
    };
    const initial = await readCatalogSourcesConfigSnapshot(workspace.env);
    await replaceCatalogSourcesConfig({
      config,
      expectedDigest: initial.digest,
      env: workspace.env,
    });
    const expectedDigest = calculateCatalogSourcesConfigDigest(config);
    const targetMoved = deferred();
    const releaseReplacement = deferred();
    setLocalMarketplaceAfterTargetMovedToBackupForTests(async () => {
      targetMoved.resolve();
      await releaseReplacement.promise;
    });

    const replacement = initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    await targetMoved.promise;
    const invoked: string[] = [];
    const providers: CatalogSourceProviderSet = {
      path: async (source, providerOptions) => {
        invoked.push(source.id);
        return resolvePathCatalogSource(source, providerOptions);
      },
      git: async (source) => {
        invoked.push(source.id);
        throw new Error(`Unexpected Git source "${source.id}".`);
      },
    };
    let settled = false;
    const catalog = withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      env: workspace.env,
      providers,
      consume: (resolved) => ({
        sourceIds: resolved.sources.map((item) => item.sourceId),
        primarySourceId: resolved.primarySourceId,
        configDigest: resolved.configDigest,
      }),
    }).finally(() => { settled = true; });
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    expect(invoked).toEqual([]);

    releaseReplacement.resolve();
    await replacement;
    const resolved = await catalog;
    expect(resolved.sourceIds).toEqual(['custom-primary', 'secondary']);
    expect(resolved.primarySourceId).toBe('custom-primary');
    expect(resolved.configDigest).toBe(expectedDigest);
    expect(invoked.sort()).toEqual(['custom-primary', 'secondary']);
    const lease = await acquireCurrentCatalogCacheLease(workspace.env, { timeoutMs: 100 });
    await expect(lease.release()).resolves.toBe(true);
  });

  it('releases the sibling cache lease when multi-source resolution throws', async () => {
    const workspace = await makeWorkspace();
    const config: CatalogSourcesConfig = {
      schemaVersion: 1,
      sources: [{
        id: 'custom-primary',
        type: 'path',
        primary: true,
        path: path.join(path.dirname(workspace.awHome), 'custom-primary'),
      }],
    };
    await expect(withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      sourceIds: ['missing'],
      configSnapshot: {
        config,
        digest: calculateCatalogSourcesConfigDigest(config),
        materialized: true,
      },
      env: workspace.env,
      consume: () => undefined,
    })).rejects.toThrow('Catalog source "missing" does not exist');

    const lease = await acquireCurrentCatalogCacheLease(workspace.env, { timeoutMs: 100 });
    await expect(lease.release()).resolves.toBe(true);
  });

  it('isolates shared lease waiter cancellation and keeps the remaining waiter active', async () => {
    const workspace = await makeWorkspace();
    const holder = await acquireCurrentCatalogCacheLease(workspace.env);
    const firstController = new AbortController();
    let firstRan = false;
    let secondRan = false;
    const first = withCatalogSourceCacheLease({
      env: workspace.env,
      signal: firstController.signal,
      action: async () => { firstRan = true; },
    });
    const second = withCatalogSourceCacheLease({
      env: workspace.env,
      action: async () => { secondRan = true; },
    });
    await new Promise<void>((done) => setImmediate(done));
    firstController.abort(new Error('cancel only first lease waiter'));
    await expect(first).rejects.toThrow('cancel only first lease waiter');
    expect(firstRan).toBe(false);
    expect(secondRan).toBe(false);

    await holder.release();
    await second;
    expect(secondRan).toBe(true);
  });

  it('releases an abandoned underlying lease after every waiter cancels', async () => {
    const workspace = await makeWorkspace();
    const lockParent = path.join(path.dirname(workspace.awHome), '.aw-local-marketplace-staging');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const holder = await acquireCurrentCatalogCacheLease(workspace.env);
      const controllers = [new AbortController(), new AbortController()];
      let actions = 0;
      const waiters = controllers.map((controller) => withCatalogSourceCacheLease({
        env: workspace.env,
        signal: controller.signal,
        action: async () => { actions += 1; },
      }));
      await new Promise<void>((done) => setImmediate(done));
      controllers.forEach((controller, index) => controller.abort(new Error(`cancel waiter ${index}`)));
      await Promise.all(waiters.map((waiter) => expect(waiter).rejects.toThrow('cancel waiter')));
      expect(actions).toBe(0);
      await holder.release();
      expect((await fs.readdir(lockParent)).filter((entry) => entry.includes('.catalog-cache-'))).toEqual([]);
    }
  });

  it('fully stops repeated already-aborted shared lease acquisition before rejection', async () => {
    const workspace = await makeWorkspace();
    const lockParent = path.join(path.dirname(workspace.awHome), '.aw-local-marketplace-staging');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const controller = new AbortController();
      controller.abort(new Error(`already aborted ${attempt}`));
      await expect(withCatalogSourceCacheLease({
        env: workspace.env,
        signal: controller.signal,
        action: async () => {
          throw new Error('already-aborted action must not run');
        },
      })).rejects.toThrow(`already aborted ${attempt}`);
      const entries = await fs.readdir(lockParent).catch(() => [] as string[]);
      expect(entries.filter((entry) => entry.includes('.catalog-cache-'))).toEqual([]);
    }
  });

  it('keeps plugin paths valid in the callback and blocks their escape before replacement', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const sourceRoot = path.join(path.dirname(workspace.awHome), 'selector-callback-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const config: CatalogSourcesConfig = {
      schemaVersion: 1,
      sources: [{ id: 'custom', type: 'path', primary: true, path: sourceRoot }],
    };
    const initial = await readCatalogSourcesConfigSnapshot(workspace.env);
    await replaceCatalogSourcesConfig({
      config,
      expectedDigest: initial.digest,
      env: workspace.env,
    });
    const callbackEntered = deferred();
    const replacementStaged = deferred();
    const allowCallbackRead = deferred();
    setLocalMarketplaceAfterStagingPreparedForTests(async () => {
      replacementStaged.resolve();
    });
    let callbackReadName: string | undefined;

    const selected = withResolvedCatalogPlugin({
      selector: 'custom/demo',
      cliVersion: '1.0.0',
      freshnessPolicy: 'cacheFirst',
      env: workspace.env,
      consume: async ({ pluginId, plugin }) => {
        callbackEntered.resolve();
        await allowCallbackRead.promise;
        const manifest = await fs.readJson(plugin.manifestPath);
        callbackReadName = manifest.name as string;
        return { pluginId, evidence: { path: plugin.manifestPath } };
      },
    });
    await callbackEntered.promise;
    let replacementSettled = false;
    const replacement = initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    }).finally(() => { replacementSettled = true; });
    await replacementStaged.promise;
    await new Promise<void>((done) => setImmediate(done));
    expect(replacementSettled).toBe(false);

    allowCallbackRead.resolve();
    await expect(selected).rejects.toBeInstanceOf(CatalogLeaseEscapeError);
    expect(callbackReadName).toBe('demo');
    await replacement;
    const lease = await acquireCurrentCatalogCacheLease(workspace.env, { timeoutMs: 100 });
    await expect(lease.release()).resolves.toBe(true);
  });

  it('publishes source cache state only after a paused root replacement completes', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const sourceRoot = path.join(path.dirname(workspace.awHome), 'path-catalog-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const source = {
      id: 'local',
      type: 'path' as const,
      primary: true,
      path: sourceRoot,
    };
    const gitWork = path.join(path.dirname(workspace.awHome), 'git-catalog-work');
    const gitRemote = path.join(path.dirname(workspace.awHome), 'git-catalog-remote.git');
    await fs.ensureDir(gitWork);
    await git(gitWork, ['init', '--initial-branch=main']);
    await git(gitWork, ['config', 'user.email', 'test@example.test']);
    await git(gitWork, ['config', 'user.name', 'AW Test']);
    await createCatalogSnapshotFixture(path.join(gitWork, 'catalog'));
    await git(gitWork, ['add', '.']);
    await git(gitWork, ['commit', '-m', 'catalog']);
    await git(path.dirname(gitWork), ['clone', '--bare', gitWork, gitRemote]);
    const gitSource = {
      id: 'official',
      type: 'git' as const,
      primary: false,
      url: gitRemote,
      refPolicy: { type: 'explicit' as const, ref: 'main' },
      subdir: 'catalog',
    };
    const faultSource = { ...source, id: 'fault-source', primary: false };
    const faultIdentity = await calculateCatalogSourceIdentity(faultSource);
    const faultLocation = resolveCatalogSourceCacheLocation({
      sourceId: faultSource.id,
      sourceIdentity: faultIdentity,
      env: workspace.env,
    });
    const cacheCopied = deferred();
    const releaseReplacement = deferred();
    setLocalMarketplaceAfterCatalogCachePreservedForTests(async () => {
      cacheCopied.resolve();
      await releaseReplacement.promise;
    });

    const replacement = initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    await cacheCopied.promise;
    let publicationSettled = false;
    let gitPublicationSettled = false;
    let faultSettled = false;
    const publication = resolvePathCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: workspace.env,
    }).finally(() => { publicationSettled = true; });
    const gitPublication = resolveGitCatalogSource(gitSource, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: workspace.env,
    }).finally(() => { gitPublicationSettled = true; });
    const faultWrite = persistCatalogSourceObjectFault({
      location: faultLocation,
      reason: 'test-only sanitized cleanup fault',
    }).finally(() => { faultSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(publicationSettled).toBe(false);
    expect(gitPublicationSettled).toBe(false);
    expect(faultSettled).toBe(false);

    releaseReplacement.resolve();
    await replacement;
    const published = await publication;
    const publishedGit = await gitPublication;
    await faultWrite;
    await expect(fs.pathExists(published.rootDir)).resolves.toBe(true);
    await expect(fs.pathExists(publishedGit.rootDir)).resolves.toBe(true);
    expect(path.relative(workspace.awHome, published.rootDir).startsWith('..')).toBe(false);
    await expect(fs.pathExists(faultLocation.objectsFaultPath)).resolves.toBe(true);
  });

  it('preserves completed source entries, selectors, faults, and retained object locks', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const sourceRoot = path.join(path.dirname(workspace.awHome), 'preserved-path-catalog');
    await createCatalogSnapshotFixture(sourceRoot);
    const source = {
      id: 'local',
      type: 'path' as const,
      primary: true,
      path: sourceRoot,
    };
    const published = await resolvePathCatalogSource(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: workspace.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const location = resolveCatalogSourceCacheLocation({
      sourceId: source.id,
      sourceIdentity,
      env: workspace.env,
    });
    await expect(withCatalogSourceCacheLock({
      location,
      name: 'objects',
      retainLockOnError: () => true,
      action: async () => {
        await persistCatalogSourceObjectFault({
          location,
          reason: 'test-only sanitized cleanup fault',
        });
        throw new Error('retain test object lock');
      },
    })).rejects.toThrow('retain test object lock');
    const ownerPath = path.join(location.locksDir, 'objects.lock', 'owner.json');
    const ownerBefore = await fs.readFile(ownerPath, 'utf8');

    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });

    await expect(fs.pathExists(published.rootDir)).resolves.toBe(true);
    await expect(readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'path',
      cliVersion: '1.0.0',
    })).resolves.toMatchObject({
      metadata: { entryKey: published.cacheEntryKey },
    });
    await expect(fs.pathExists(location.objectsFaultPath)).resolves.toBe(true);
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toBe(ownerBefore);
  });

  it.each([
    { force: false, label: 'normal' },
    { force: true, label: 'force' },
  ])('preserves catalog sources bytes through a $label marketplace rebuild', async ({ force }) => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const sourcePath = path.join(workspace.awHome, CATALOG_SOURCES_FILE);
    const sourceBytes = Buffer.from(
      `${JSON.stringify(createDefaultCatalogSourcesConfig(), null, 4)}\n`,
    );
    const fingerprintBefore = await calculateBundleFingerprint(workspace.awHome);
    await fs.writeFile(sourcePath, sourceBytes);
    await expect(calculateBundleFingerprint(workspace.awHome)).resolves.toBe(fingerprintBefore);
    if (!force) {
      await fs.appendFile(
        path.join(workspace.awHome, 'plugins', 'git-commit', 'README.md'),
        '\nactive drift\n',
      );
    }

    const rebuilt = await initializeLocalMarketplace({
      force,
      env: workspace.env,
      catalogResolution: resolution,
    });

    expect(rebuilt.changed).toBe(true);
    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytes);
  });

  it('rebuilds drifted active static content without treating runtime state as drift', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({ force: true, env: workspace.env, catalogResolution: resolution });
    const activeManifest = path.join(
      workspace.awHome,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const expected = await fs.readFile(activeManifest, 'utf8');
    const nestedConfig = path.join(workspace.awHome, 'plugins', 'git-commit', 'payload', 'config.json');
    const nestedCatalogCache = path.join(
      workspace.awHome,
      'plugins',
      'git-commit',
      'payload',
      'catalog-cache',
      'extra.txt',
    );
    await fs.outputJson(nestedConfig, { drift: true });
    await fs.outputFile(nestedCatalogCache, 'drift\n');
    await fs.outputJson(path.join(workspace.awHome, 'plugin-config', 'runtime.json'), { keep: true });

    const rebuilt = await initializeLocalMarketplace({
      force: false,
      env: workspace.env,
      catalogResolution: resolution,
    });

    expect(rebuilt.changed).toBe(true);
    await expect(fs.readFile(activeManifest, 'utf8')).resolves.toBe(expected);
    await expect(fs.pathExists(nestedConfig)).resolves.toBe(false);
    await expect(fs.pathExists(nestedCatalogCache)).resolves.toBe(false);
    await expect(fs.readJson(path.join(
      workspace.awHome,
      'plugin-config',
      'runtime.json',
    ))).resolves.toEqual({ keep: true });
  });

  it('preserves only a validated installed Codex static Skill owner marker across ensure', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({ force: true, env: workspace.env, catalogResolution: resolution });
    const platformManifest = await fs.readJson(path.join(
      workspace.awHome,
      'plugins',
      'git-commit',
      '.codex-plugin',
      'plugin.json',
    ));
    const skillsRoot = String(platformManifest.skills).replace(/^\.\//u, '');
    const skillRoot = path.join(workspace.awHome, 'plugins', 'git-commit', skillsRoot, 'commit');
    const markerPath = path.join(skillRoot, SKILL_OWNER_MARKER);
    await fs.outputJson(markerPath, {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'git-commit',
      artifactKey: 'commit',
      platform: 'codex',
      scope: 'user',
    });
    const codexHome = getCodexHome(workspace.env);
    await fs.outputFile(path.join(codexHome, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(workspace.awHome)}`,
      'source_type = "local"',
      '',
      '[plugins."git-commit@aw"]',
      'enabled = true',
      '',
    ].join('\n'));
    const cacheRoot = path.join(
      codexHome,
      'plugins',
      'cache',
      'aw',
      'git-commit',
      platformManifest.version,
    );
    await fs.copy(
      path.join(workspace.awHome, 'plugins', 'git-commit'),
      cacheRoot,
      { overwrite: true },
    );

    await initializeLocalMarketplace({ force: false, env: workspace.env, catalogResolution: resolution });
    await expect(fs.readJson(markerPath)).resolves.toMatchObject({
      plugin: 'git-commit', platform: 'codex', scope: 'user', artifactKey: 'commit',
    });

    await fs.outputJson(markerPath, {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'other-plugin',
      artifactKey: 'commit',
      platform: 'claude',
      scope: 'user',
    });
    await initializeLocalMarketplace({ force: false, env: workspace.env, catalogResolution: resolution });
    await expect(fs.pathExists(markerPath)).resolves.toBe(false);
  });

  it('writes and reads an identity-bound immutable entry', async () => {
    const { env, sourceRoot, identity } = await makeCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });

    expect(written.cacheKey).toBe(buildCurrentCatalogCacheKey(identity));
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      cacheKey: written.cacheKey,
      metadata: { version: 2, catalogVersion: '1.0.0' },
    });
    expect(written.metadata).not.toHaveProperty('historySchemaVersion');
    expect(written.observation).toBeUndefined();
  });

  it('partitions selector observations by registry source and keeps the newest order', async () => {
    const first = await makeCacheFixture();
    const sourceIdentity = 'https://registry.example/';
    const older = await writeCurrentCatalogCacheEntry({
      ...first.identity,
      sourceRoot: first.sourceRoot,
      env: first.env,
    });
    const olderObservation = observation(older, sourceIdentity, 1);
    await markCurrentCatalogCacheEntryValidated(older, first.env, undefined, olderObservation);

    const newerFixture = await makeCacheFixture({
      awHome: String(first.env.AW_HOME),
      selector: first.identity.selector,
      catalogVersion: '1.1.0',
    });
    const newer = await writeCurrentCatalogCacheEntry({
      ...newerFixture.identity,
      sourceRoot: newerFixture.sourceRoot,
      env: first.env,
    });
    const newerObservation = observation(newer, sourceIdentity, 2);
    await markCurrentCatalogCacheEntryValidated(newer, first.env, undefined, newerObservation);
    await markCurrentCatalogCacheEntryValidated(
      older,
      first.env,
      new Date(Date.now() + 100).toISOString(),
      olderObservation,
    );

    await expect(readCurrentCatalogCacheEntryBySelector(
      first.identity.selector,
      first.env,
      sourceIdentity,
    )).resolves.toMatchObject({
      cacheKey: newer.cacheKey,
      observation: { observationOrder: 2 },
    });
    await expect(readCurrentCatalogCacheEntryBySelector(
      first.identity.selector,
      first.env,
      'https://other-registry.example/',
    )).resolves.toBeNull();
  });

  it('publishes concurrent writers without exposing partial reader state', async () => {
    const { env, sourceRoot, identity } = await makeCacheFixture();
    const writers = Array.from({ length: 4 }, () =>
      writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env }));
    const readers = Array.from({ length: 6 }, () =>
      readCurrentCatalogCacheEntry(identity, env));
    const [written, observed] = await Promise.all([
      Promise.all(writers),
      Promise.all(readers),
    ]);

    expect(new Set(written.map((entry) => entry.rootDir)).size).toBe(1);
    expect(observed.every((entry) =>
      entry === null || entry.cacheKey === written[0]!.cacheKey)).toBe(true);
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      cacheKey: written[0]!.cacheKey,
    });
  });

  it('bounds lock waits, supports abort, and never releases another owner token', async () => {
    const { env } = await makeCacheFixture();
    const lease = await acquireCurrentCatalogCacheLease(env);
    await expect(acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 20,
      pollMs: 5,
      staleMs: 60_000,
    })).rejects.toThrow('Timed out after 20ms');

    const controller = new AbortController();
    const aborted = new Error('cache lock wait aborted');
    const waiting = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 5_000,
      pollMs: 1_000,
      staleMs: 60_000,
      signal: controller.signal,
    });
    controller.abort(aborted);
    await expect(waiting).rejects.toBe(aborted);

    const foreignToken = '00000000-0000-4000-8000-000000000001';
    await fs.writeJson(path.join(lease.lockPath, 'owner.json'), {
      ...lease.owner,
      token: foreignToken,
    });
    await expect(lease.release()).resolves.toBe(false);
    await expect(fs.readJson(path.join(lease.lockPath, 'owner.json'))).resolves.toMatchObject({
      token: foreignToken,
    });
    await fs.remove(lease.lockPath);
  });

  it('recovers a stale lock owned by a dead PID', async () => {
    const { env } = await makeCacheFixture();
    const stale = await acquireCurrentCatalogCacheLease(env);
    await fs.writeJson(path.join(stale.lockPath, 'owner.json'), {
      ...stale.owner,
      pid: 999_999,
      processStartIdentity: 'dead-process',
    });
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(stale.lockPath, oldTime, oldTime);

    const recovered = await acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 100,
      pollMs: 2,
      staleMs: 0,
    });
    await expect(stale.release()).resolves.toBe(false);
    await expect(recovered.release()).resolves.toBe(true);
  });

  it('recovers a stale lock after PID reuse changes process start identity', async () => {
    const { env } = await makeCacheFixture();
    const stale = await acquireCurrentCatalogCacheLease(env);
    await fs.writeJson(path.join(stale.lockPath, 'owner.json'), {
      ...stale.owner,
      pid: process.pid,
      processStartIdentity: 'different-process-start',
    });
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(stale.lockPath, oldTime, oldTime);

    const recovered = await acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 100,
      pollMs: 2,
      staleMs: 0,
    });
    await expect(stale.release()).resolves.toBe(false);
    await expect(recovered.release()).resolves.toBe(true);
  });

  it('recovers an empty ownerless stale lock directory', async () => {
    const { env } = await makeCacheFixture();
    const stale = await acquireCurrentCatalogCacheLease(env);
    await fs.remove(path.join(stale.lockPath, 'owner.json'));
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(stale.lockPath, oldTime, oldTime);

    const recovered = await acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 100,
      pollMs: 2,
      staleMs: 0,
    });
    await expect(stale.release()).resolves.toBe(false);
    await expect(recovered.release()).resolves.toBe(true);
    await expect(fs.pathExists(recovered.lockPath)).resolves.toBe(false);
  });

  it('keeps a replacement owner protected from a stale claimant and multiple waiters', async () => {
    const { env } = await makeCacheFixture();
    const ownerA = await acquireCurrentCatalogCacheLease(env);
    await fs.writeJson(path.join(ownerA.lockPath, 'owner.json'), {
      ...ownerA.owner,
      pid: 999_999,
      processStartIdentity: 'dead-owner-a',
    });
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(ownerA.lockPath, oldTime, oldTime);

    let staleClaimReady!: () => void;
    const staleClaimObservedOwnerA = new Promise<void>((resolve) => {
      staleClaimReady = resolve;
    });
    let releaseStaleClaim!: () => void;
    const staleClaimReleased = new Promise<void>((resolve) => {
      releaseStaleClaim = resolve;
    });
    const staleContenderResult = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 50,
      pollMs: 2,
      staleMs: 0,
      __testBeforeStaleClaim: async () => {
        staleClaimReady();
        await staleClaimReleased;
      },
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );
    await staleClaimObservedOwnerA;
    await expect(ownerA.release()).resolves.toBe(true);
    const ownerB = await acquireCurrentCatalogCacheLease(env);
    const waiters = [0, 1].map(() => acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 30,
      pollMs: 2,
      staleMs: 0,
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    ));

    releaseStaleClaim();
    const [staleContender, ...waiterResults] = await Promise.all([
      staleContenderResult,
      ...waiters,
    ]);
    expect(staleContender).toHaveProperty('error');
    expect(waiterResults.every((result) => 'error' in result)).toBe(true);
    await expect(fs.readJson(path.join(ownerB.lockPath, 'owner.json'))).resolves.toMatchObject({
      token: ownerB.owner.token,
    });
    await expect(ownerB.release()).resolves.toBe(true);
  });

  it('drops a conflicting selector observation but keeps the committed entry', async () => {
    const { env, sourceRoot, identity } = await makeCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    await markCurrentCatalogCacheEntryValidated(
      written,
      env,
      undefined,
      observation(written, 'https://registry.example/', 1),
    );
    const selectorsDir = path.join(String(env.AW_HOME), 'catalog-cache', 'selectors');
    const indexes = await Promise.all((await fs.readdir(selectorsDir)).map(async (indexName) => ({
      path: path.join(selectorsDir, indexName),
      value: await fs.readJson(path.join(selectorsDir, indexName)) as Record<string, unknown>,
    })));
    const observedIndex = indexes.find((entry) => entry.value.observation !== undefined);
    expect(observedIndex).toBeDefined();
    const indexPath = observedIndex!.path;
    const index = observedIndex!.value;
    const forged = structuredClone(index.observation) as CurrentCatalogCacheObservation;
    forged.sidecarManifestPackage.version = '9.9.9';
    await fs.writeJson(indexPath, { ...index, observation: forged });

    const cached = await readCurrentCatalogCacheEntryBySelector(identity.selector, env);
    expect(cached).toMatchObject({ cacheKey: written.cacheKey });
    expect(cached).not.toHaveProperty('observation');
  });

  it('isolates a corrupt final entry and lets a new writer publish a valid entry', async () => {
    const { env, sourceRoot, identity } = await makeCacheFixture();
    const entryDir = resolveCurrentCatalogCacheEntryDir(
      buildCurrentCatalogCacheKey(identity),
      env,
    );
    await fs.ensureDir(entryDir);
    await fs.writeJson(path.join(entryDir, 'entry.json'), { version: 'corrupt' });

    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      cacheKey: written.cacheKey,
      metadata: { version: 2 },
    });
  });

  it('preserves strict cache through a real active marketplace rebuild', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const cache = await makeCacheFixture({ awHome: workspace.awHome });
    const written = await writeCurrentCatalogCacheEntry({
      ...cache.identity,
      sourceRoot: cache.sourceRoot,
      env: workspace.env,
    });
    const before = await fs.readFile(written.metadataPath);

    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });

    await expect(fs.readFile(written.metadataPath)).resolves.toEqual(before);
    await expect(readCurrentCatalogCacheEntry(cache.identity, workspace.env)).resolves.toMatchObject({
      cacheKey: written.cacheKey,
    });
  });

  it('preserves config, lifecycle, and every owned dynamic Skill overlay during replacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-marketplace-overlay-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.copy(fixturePath('repo-template'), repoRoot);
    const secondRoot = path.join(repoRoot, 'plugins', 'second-plugin');
    await fs.copy(path.join(repoRoot, 'plugins', 'git-commit'), secondRoot);
    const secondManifestPath = path.join(secondRoot, '.agents-plugin', 'plugin.json');
    const secondManifest = await fs.readJson(secondManifestPath);
    secondManifest.name = 'second-plugin';
    secondManifest.description = 'Second overlay fixture.';
    await fs.writeJson(secondManifestPath, secondManifest, { spaces: 2 });
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const awHome = path.join(root, 'aw-home');
    const env = { ...process.env, AW_HOME: awHome };
    const resolution = await embeddedResolution(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env, catalogResolution: resolution });

    const configMarker = path.join(awHome, 'plugin-config', 'shared.json');
    const lifecycleMarker = path.join(awHome, 'lifecycle-active', 'active.json');
    await fs.outputJson(configMarker, { preserved: 'config' });
    await fs.outputJson(lifecycleMarker, { preserved: 'lifecycle' });

    for (const [pluginName, skillKey] of [
      ['git-commit', 'dynamic-a'],
      ['second-plugin', 'dynamic-b'],
    ] as const) {
      const manifestPath = path.join(awHome, 'plugins', pluginName, '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      manifest.artifacts = {
        targets: [{
          id: skillKey,
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey,
        }],
      };
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      await fs.writeJson(path.join(
        embeddedRoot,
        'plugins',
        pluginName,
        '.agents-plugin',
        'plugin.json',
      ), manifest, { spaces: 2 });
      const skillsRoot = pluginName === 'second-plugin' ? 'codex/custom-skills' : 'codex/skills';
      if (pluginName === 'second-plugin') {
        const platformManifestPath = path.join(
          awHome,
          'plugins',
          pluginName,
          '.codex-plugin',
          'plugin.json',
        );
        const platformManifest = await fs.readJson(platformManifestPath);
        await fs.writeJson(platformManifestPath, {
          ...platformManifest,
          skills: `./${skillsRoot}`,
        }, { spaces: 2 });
        await fs.writeJson(path.join(
          embeddedRoot,
          'plugins',
          pluginName,
          '.codex-plugin',
          'plugin.json',
        ), {
          ...platformManifest,
          skills: `./${skillsRoot}`,
        }, { spaces: 2 });
        await fs.ensureDir(path.join(
          embeddedRoot,
          'plugins',
          pluginName,
          ...skillsRoot.split('/'),
        ));
      }
      const skillRoot = path.join(awHome, 'plugins', pluginName, ...skillsRoot.split('/'), skillKey);
      await fs.outputFile(path.join(skillRoot, 'SKILL.md'), `# ${skillKey}\n`);
      await fs.outputFile(path.join(skillRoot, 'agents', 'openai.yaml'), [
        'interface:',
        `  display_name: "${skillKey}"`,
        '  short_description: "Dynamic overlay fixture"',
        `  default_prompt: "Use $${skillKey}."`,
        'policy:',
        '  allow_implicit_invocation: true',
        '',
      ].join('\n'));
      await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
        schemaVersion: 1,
        owner: 'agent-workflows',
        plugin: pluginName,
        artifactKey: skillKey,
        platform: 'codex',
        scope: 'user',
      });
    }

    await initializeLocalMarketplace({ force: true, env, catalogResolution: resolution });

    await expect(fs.readJson(configMarker)).resolves.toEqual({ preserved: 'config' });
    await expect(fs.readJson(lifecycleMarker)).resolves.toEqual({ preserved: 'lifecycle' });
    await expect(fs.readFile(path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'dynamic-a',
      'SKILL.md',
    ), 'utf8')).resolves.toBe('# dynamic-a\n');
    await expect(fs.readFile(path.join(
      awHome,
      'plugins',
      'second-plugin',
      'codex',
      'custom-skills',
      'dynamic-b',
      'SKILL.md',
    ), 'utf8')).resolves.toBe('# dynamic-b\n');
    await expect(fs.readJson(path.join(
      awHome,
      'plugins',
      'second-plugin',
      '.codex-plugin',
      'plugin.json',
    ))).resolves.toMatchObject({ skills: './codex/custom-skills' });
  });

  it('replays a Codex user Skill written after marketplace staging is prepared', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const skillKey = 'dynamic-race';
    const embeddedManifestPath = path.join(
      workspace.embeddedRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const embeddedManifest = await fs.readJson(embeddedManifestPath) as Record<string, unknown>;
    const artifacts = embeddedManifest.artifacts as { targets?: unknown[] } | undefined;
    await fs.writeJson(embeddedManifestPath, {
      ...embeddedManifest,
      artifacts: {
        ...(artifacts ?? {}),
        targets: [
          ...(artifacts?.targets ?? []),
          {
            id: skillKey,
            platform: 'codex',
            scopes: ['user'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: [],
            skillKey,
          },
        ],
      },
    }, { spaces: 2 });
    const skillsRoot = path.join(
      workspace.awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
    );
    const skillRoot = path.join(skillsRoot, skillKey);
    let writer: Promise<string[]> | undefined;
    setLocalMarketplaceAfterStagingPreparedForTests(async () => {
      writer = withActiveMarketplaceRuntimeLease(workspace.env, () => writeDynamicSkillTree(
        skillRoot,
        {
          skillKey,
          files: {
            'SKILL.md': Buffer.from('# Dynamic race\n'),
            'agents/openai.yaml': Buffer.from([
              'interface:',
              '  display_name: "Dynamic race"',
              '  short_description: "Concurrency fixture"',
              '  default_prompt: "Use $dynamic-race."',
              'policy:',
              '  allow_implicit_invocation: true',
              '',
            ].join('\n')),
          },
        },
        {
          allowedRoot: skillsRoot,
          identity: {
            owner: 'agent-workflows',
            plugin: 'git-commit',
            artifactKey: skillKey,
            platform: 'codex',
            scope: 'user',
          },
        },
      ));
      await writer;
    });

    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });

    await writer;
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Dynamic race\n');
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(true);
  });

  it('preserves the latest runtime state across two concurrent marketplace replacements', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const staleConfig = path.join(workspace.awHome, 'plugin-config', 'stale.json');
    const currentConfig = path.join(workspace.awHome, 'plugin-config', 'current.json');
    const staleLifecycle = path.join(workspace.awHome, 'lifecycle-active', 'stale.json');
    const currentSnapshot = path.join(
      workspace.awHome,
      'lifecycle-active',
      'targets',
      'current',
      'snapshot.json',
    );
    const operationLock = path.join(
      workspace.awHome,
      'lifecycle-active',
      'locks',
      'current.operation.lock',
    );
    await fs.outputJson(staleConfig, { generation: 'stale' });
    await fs.outputJson(staleLifecycle, { generation: 'stale' });

    let staged = 0;
    let releaseStaging!: () => void;
    const stagingBarrier = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    setLocalMarketplaceAfterStagingPreparedForTests(async () => {
      staged += 1;
      if (staged === 2) {
        await fs.remove(staleConfig);
        await fs.remove(staleLifecycle);
        await fs.outputJson(currentConfig, { generation: 'current' });
        await fs.outputJson(currentSnapshot, { generation: 'current' });
        await fs.outputFile(operationLock, 'current-owner\n');
        releaseStaging();
      }
      await stagingBarrier;
    });

    await Promise.all([
      initializeLocalMarketplace({
        force: true,
        env: workspace.env,
        catalogResolution: resolution,
      }),
      initializeLocalMarketplace({
        force: true,
        env: workspace.env,
        catalogResolution: resolution,
      }),
    ]);

    await expect(fs.pathExists(staleConfig)).resolves.toBe(false);
    await expect(fs.pathExists(staleLifecycle)).resolves.toBe(false);
    await expect(fs.readJson(currentConfig)).resolves.toEqual({ generation: 'current' });
    await expect(fs.readJson(currentSnapshot)).resolves.toEqual({ generation: 'current' });
    await expect(fs.readFile(operationLock, 'utf8')).resolves.toBe('current-owner\n');
  });

  it('serializes runtime writers and keeps operation locks outside an active root replacement', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });

    let configWrite: ReturnType<typeof patchPluginConfigStore> | undefined;
    let operationLease: ProcessLockLease | undefined;
    setLocalMarketplaceAfterTargetMovedToBackupForTests(async () => {
      expect(await fs.pathExists(workspace.awHome)).toBe(false);
      configWrite = patchPluginConfigStore({
        pluginName: 'runtime-writer',
        scope: 'user',
        cwd: path.dirname(workspace.awHome),
        env: workspace.env,
        updates: { generation: 'current' },
      });
      operationLease = await acquireLifecycleOperationLock({
        pluginName: 'runtime-writer',
        platform: 'codex',
        scope: 'user',
        cwd: path.dirname(workspace.awHome),
        env: workspace.env,
      });
      expect(path.relative(workspace.awHome, operationLease.lockPath).startsWith('..')).toBe(true);
      expect(await fs.pathExists(workspace.awHome)).toBe(false);
    });

    try {
      await initializeLocalMarketplace({
        force: true,
        env: workspace.env,
        catalogResolution: resolution,
      });
      await configWrite;
      await expect(fs.readJson(path.join(
        workspace.awHome,
        'plugin-config',
        'runtime-writer',
        'config.json',
      ))).resolves.toEqual({ generation: 'current' });
      expect(operationLease).toBeDefined();
      await operationLease!.release();
      operationLease = undefined;
      const nextLease = await acquireLifecycleOperationLock({
        pluginName: 'runtime-writer',
        platform: 'codex',
        scope: 'user',
        cwd: path.dirname(workspace.awHome),
        env: workspace.env,
      });
      await nextLease.release();
    } finally {
      setLocalMarketplaceAfterTargetMovedToBackupForTests(undefined);
      await configWrite?.catch(() => undefined);
      await operationLease?.release().catch(() => undefined);
    }
  });

  it('lets a catalog source CAS finish after a marketplace replacement without losing it', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const initial = await readCatalogSourcesConfigSnapshot(workspace.env);
    const nextConfig = await addCatalogSource(initial.config, {
      id: 'replacement-race',
      type: 'git',
      primary: false,
      url: 'https://example.test/replacement-race.git',
      refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
    }, path.dirname(workspace.awHome));
    let mutation: ReturnType<typeof replaceCatalogSourcesConfig> | undefined;
    setLocalMarketplaceAfterTargetMovedToBackupForTests(async () => {
      expect(await fs.pathExists(workspace.awHome)).toBe(false);
      let settled = false;
      mutation = replaceCatalogSourcesConfig({
        config: nextConfig,
        expectedDigest: initial.digest,
        env: workspace.env,
      });
      void mutation.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(await fs.pathExists(workspace.awHome)).toBe(false);
    });

    const rebuilt = await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });

    expect(rebuilt.changed).toBe(true);
    await expect(mutation).resolves.toMatchObject({ config: nextConfig });
    await expect(readCatalogSourcesConfigSnapshot(workspace.env)).resolves.toMatchObject({
      config: nextConfig,
      materialized: true,
    });
    await expect(validateLocalMarketplaceLayout(workspace.awHome)).resolves.toBeUndefined();
  });

  it('lets a catalog source CAS finish after marketplace replacement rollback', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });
    const marketplaceConfigPath = path.join(workspace.awHome, 'config.json');
    const marketplaceConfigBefore = await fs.readFile(marketplaceConfigPath);
    const sourcePath = path.join(workspace.awHome, CATALOG_SOURCES_FILE);
    const sourceBytesBefore = Buffer.from(
      `${JSON.stringify(createDefaultCatalogSourcesConfig(), null, 4)}\n`,
    );
    await fs.writeFile(sourcePath, sourceBytesBefore);
    const initial = await readCatalogSourcesConfigSnapshot(workspace.env);
    const nextConfig = await addCatalogSource(initial.config, {
      id: 'rollback-race',
      type: 'git',
      primary: false,
      url: 'https://example.test/rollback-race.git',
      refPolicy: { type: 'cliChannel' },
    }, path.dirname(workspace.awHome));
    let mutation: ReturnType<typeof replaceCatalogSourcesConfig> | undefined;
    setLocalMarketplaceAfterTargetMovedToBackupForTests(async () => {
      expect(await fs.pathExists(workspace.awHome)).toBe(false);
      mutation = replaceCatalogSourcesConfig({
        config: nextConfig,
        expectedDigest: initial.digest,
        env: workspace.env,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await fs.pathExists(workspace.awHome)).toBe(false);
    });
    const realMove: typeof fs.move = fs.move.bind(fs);
    const moveSpy = vi.spyOn(fs, 'move').mockImplementation(async (...args) => {
      if (
        String(args[0]).includes(`${path.sep}.aw-local-marketplace-staging${path.sep}`)
        && path.resolve(String(args[1])) === path.resolve(workspace.awHome)
      ) {
        throw new Error('injected catalog source replacement rollback');
      }
      return realMove(...args);
    });
    setAtomicConfigBeforeRenameHookForTests(async () => {
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBytesBefore);
    });

    await expect(initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    })).rejects.toThrow('injected catalog source replacement rollback');
    moveSpy.mockRestore();

    await expect(mutation).resolves.toMatchObject({ config: nextConfig });
    await expect(fs.readFile(marketplaceConfigPath)).resolves.toEqual(marketplaceConfigBefore);
    await expect(readCatalogSourcesConfigSnapshot(workspace.env)).resolves.toMatchObject({
      config: nextConfig,
      materialized: true,
    });
    await expect(validateLocalMarketplaceLayout(workspace.awHome)).resolves.toBeUndefined();
  });

  it('allows missing or damaged cache during rebuild and preserves the old cache on publish failure', async () => {
    const workspace = await makeWorkspace();
    const resolution = await embeddedResolution(workspace.embeddedRoot);
    await initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    });

    await fs.remove(path.join(workspace.awHome, 'catalog-cache'));
    await expect(initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    })).resolves.toMatchObject({ changed: true });

    const markerPath = path.join(workspace.awHome, 'catalog-cache', 'marker.bin');
    const configMarkerPath = path.join(workspace.awHome, 'plugin-config', 'marker.json');
    const lifecycleMarkerPath = path.join(workspace.awHome, 'lifecycle-active', 'marker.json');
    const marker = Buffer.from([0, 1, 2, 3, 255]);
    await fs.outputFile(markerPath, marker);
    await fs.outputJson(configMarkerPath, { preserved: 'config' });
    await fs.outputJson(lifecycleMarkerPath, { preserved: 'lifecycle' });
    const realMove: typeof fs.move = fs.move.bind(fs);
    const moveSpy = vi.spyOn(fs, 'move').mockImplementation(async (...args) => {
      if (
        String(args[0]).includes(`${path.sep}.aw-local-marketplace-staging${path.sep}`)
        && path.resolve(String(args[1])) === path.resolve(workspace.awHome)
      ) {
        throw new Error('injected marketplace publication failure');
      }
      return realMove(...args);
    });

    await expect(initializeLocalMarketplace({
      force: true,
      env: workspace.env,
      catalogResolution: resolution,
    })).rejects.toThrow('injected marketplace publication failure');
    moveSpy.mockRestore();

    await expect(fs.readFile(markerPath)).resolves.toEqual(marker);
    await expect(fs.readJson(configMarkerPath)).resolves.toEqual({ preserved: 'config' });
    await expect(fs.readJson(lifecycleMarkerPath)).resolves.toEqual({ preserved: 'lifecycle' });
    await expect(validateLocalMarketplaceLayout(workspace.awHome)).resolves.toBeUndefined();
  });
});
