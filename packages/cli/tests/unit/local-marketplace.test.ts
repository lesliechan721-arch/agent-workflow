import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireCurrentCatalogCacheLease,
  buildCurrentCatalogCacheKey,
  initializeLocalMarketplace,
  markCurrentCatalogCacheEntryValidated,
  readCliPackageInfo,
  readCurrentCatalogCacheEntry,
  readCurrentCatalogCacheEntryBySelector,
  validateLocalMarketplaceLayout,
  writeCurrentCatalogCacheEntry,
  type CurrentCatalogCacheEntry,
  type CurrentCatalogCacheIdentity,
  type CurrentCatalogCacheObservation,
} from '../../src/utils/local-marketplace.js';
import { getCodexHome, resolveCurrentCatalogCacheEntryDir } from '../../src/utils/paths.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import type { CatalogResolution, CatalogSelector } from '../../src/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

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
      source: '@yiliang/aw-plugins-manifest',
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
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('strict current catalog cache', () => {
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
    const marker = Buffer.from([0, 1, 2, 3, 255]);
    await fs.outputFile(markerPath, marker);
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
    await expect(validateLocalMarketplaceLayout(workspace.awHome)).resolves.toBeUndefined();
  });
});
