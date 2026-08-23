import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOG_BETA_REF,
  CATALOG_LATEST_REF,
  CATALOG_SOURCE_IDENTITY_VERSION,
  OFFICIAL_CATALOG_SOURCE_URL,
} from '../../src/constants.js';
import {
  calculateCatalogSourceIdentity,
  canonicalizeCatalogGitUrl,
} from '../../src/utils/catalog-source-identity.js';
import {
  addCatalogSource,
  calculateCatalogSourcesConfigDigest,
  CatalogSourcesConfigConflictError,
  createDefaultCatalogSourcesConfig,
  readCatalogSourcesConfig,
  readCatalogSourcesConfigSnapshot,
  removeCatalogSource,
  replaceCatalogSourcesConfig,
  resolveCatalogSourceRef,
  resolveCatalogSourcesConfigPath,
  setPrimaryCatalogSource,
  updateCatalogSource,
  validateCatalogSourcesConfig,
  type CatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import {
  resolveConfigFileLockPath,
  setAtomicConfigBeforeRenameHookForTests,
  setConfigFileLockBeforeReleaseHookForTests,
} from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const tempDirs: string[] = [];

async function makePathSourceRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-source-'));
  tempDirs.push(root);
  return root;
}

async function createTwoSourceConfig(pathSourceRoot: string): Promise<CatalogSourcesConfig> {
  return addCatalogSource(createDefaultCatalogSourcesConfig(), {
    id: 'local',
    type: 'path',
    primary: false,
    path: pathSourceRoot,
  }, path.dirname(pathSourceRoot));
}

afterEach(async () => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
  setConfigFileLockBeforeReleaseHookForTests(undefined);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('catalog sources config v1', () => {
  it('validates the source union, ID, primary invariant, and stable ID order', () => {
    const config = validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: [
        {
          id: 'z-local',
          type: 'path',
          primary: false,
          path: path.join(os.tmpdir(), 'catalog'),
        },
        {
          id: 'official',
          type: 'git',
          primary: true,
          url: 'https://example.test/catalog.git',
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        },
      ],
    });

    expect(config.sources.map((source) => source.id)).toEqual(['official', 'z-local']);
    expect(calculateCatalogSourcesConfigDigest({
      schemaVersion: 1,
      sources: [...config.sources].reverse(),
    })).toBe(calculateCatalogSourcesConfigDigest(config));
    expect(() => validateCatalogSourcesConfig({ schemaVersion: 2, sources: config.sources }))
      .toThrow('schemaVersion');
    expect(() => validateCatalogSourcesConfig({ schemaVersion: 1, sources: [] }))
      .toThrow('at least one source');
    expect(() => validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: [{ ...config.sources.find((source) => source.type === 'path'), path: './catalog' }],
    })).toThrow('canonical absolute path');
    expect(() => validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: [{ ...config.sources[0], id: 'Bad_ID' }],
    })).toThrow('sources[0].id');
    expect(() => validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: [config.sources[0], config.sources[0]],
    })).toThrow('source IDs must be unique');
    expect(() => validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: config.sources.map((source) => ({ ...source, primary: false })),
    })).toThrow('exactly one primary');
    expect(() => validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: config.sources.map((source) => ({ ...source, primary: true })),
    })).toThrow('exactly one primary');
  });

  it('returns the virtual official primary without creating a file', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const configPath = resolveCatalogSourcesConfigPath(isolation.env);

    const config = await readCatalogSourcesConfig(isolation.env);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);

    expect(snapshot.materialized).toBe(false);
    expect(config).toEqual(createDefaultCatalogSourcesConfig());
    expect(config.sources[0]).toMatchObject({
      id: 'official',
      type: 'git',
      primary: true,
      url: OFFICIAL_CATALOG_SOURCE_URL,
      refPolicy: { type: 'cliChannel' },
    });
    expect(OFFICIAL_CATALOG_SOURCE_URL)
      .toBe('https://github.com/lesliechan721-arch/agent-workflow.git');
    expect(new URL(config.sources[0]!.type === 'git'
      ? config.sources[0].url
      : '').protocol).toBe('https:');
    await expect(fs.pathExists(configPath)).resolves.toBe(false);
  });

  it('does not downgrade a materialized config when an existence probe hides an operational error', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = await makePathSourceRoot();
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const configured = await createTwoSourceConfig(sourceRoot);
    await replaceCatalogSourcesConfig({
      config: configured,
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configPath = resolveCatalogSourcesConfigPath(isolation.env);
    const originalPathExists = fs.pathExists.bind(fs);
    vi.spyOn(fs, 'pathExists').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(configPath)) return false;
      return originalPathExists(candidate);
    });

    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
      materialized: true,
      config: configured,
    });
  });

  it.each(['EPERM', 'EBUSY'])('propagates catalog config %s instead of selecting defaults', async (code) => {
    const isolation = getCurrentSourceTestIsolation();
    const configPath = resolveCatalogSourcesConfigPath(isolation.env);
    await fs.outputJson(configPath, createDefaultCatalogSourcesConfig());
    const failure = Object.assign(new Error(`injected ${code}`), { code });
    const originalReadJson = fs.readJson.bind(fs);
    vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
      if (path.resolve(String(args[0])) === path.resolve(configPath)) throw failure;
      return originalReadJson(...args);
    });

    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).rejects.toBe(failure);
  });

  it('applies add, update, set-primary, and remove without changing type or update primary', async () => {
    const sourceRoot = await makePathSourceRoot();
    const addedPrimary = await addCatalogSource(createDefaultCatalogSourcesConfig(), {
      id: 'local',
      type: 'path',
      primary: true,
      path: path.basename(sourceRoot),
    }, path.dirname(sourceRoot));
    expect(addedPrimary.sources.map((source) => [source.id, source.primary])).toEqual([
      ['local', true],
      ['official', false],
    ]);

    const updated = await updateCatalogSource(addedPrimary, 'official', {
      type: 'git',
      url: 'https://example.test/other.git',
      subdir: 'catalog/stable',
    }, path.dirname(sourceRoot));
    expect(updated.sources.find((source) => source.id === 'official')).toMatchObject({
      primary: false,
      subdir: 'catalog/stable',
      url: 'https://example.test/other.git',
    });
    await expect(updateCatalogSource(updated, 'official', { type: 'path' }, sourceRoot))
      .rejects.toThrow('type cannot be changed');

    const officialPrimary = setPrimaryCatalogSource(updated, 'official');
    expect(officialPrimary.sources.find((source) => source.id === 'official')?.primary).toBe(true);
    expect(() => removeCatalogSource(officialPrimary, 'official')).toThrow('primary');
    expect(removeCatalogSource(officialPrimary, 'local').sources.map((source) => source.id))
      .toEqual(['official']);
    expect(() => removeCatalogSource(createDefaultCatalogSourcesConfig(), 'official'))
      .toThrow();
  });

  it('maps cliChannel refs from an explicitly injected CLI version', () => {
    expect(resolveCatalogSourceRef({ type: 'cliChannel' }, '1.2.3')).toBe(CATALOG_LATEST_REF);
    expect(resolveCatalogSourceRef({ type: 'cliChannel' }, '1.2.3-beta.4')).toBe(CATALOG_BETA_REF);
    expect(resolveCatalogSourceRef(
      { type: 'explicit', ref: 'refs/tags/catalog-1.2.3' },
      '1.2.3-beta.4',
    )).toBe('refs/tags/catalog-1.2.3');
    expect(() => resolveCatalogSourceRef({ type: 'cliChannel' }, 'not-semver')).toThrow('cliVersion');
  });

  it('materializes the first mutation atomically and rejects a stale digest', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'catalog');
    await fs.ensureDir(sourceRoot);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const nextConfig = await addCatalogSource(initial.config, {
      id: 'local',
      type: 'path',
      primary: false,
      path: './catalog',
    }, isolation.layout.fixtureCwd);
    const written = await replaceCatalogSourcesConfig({
      config: nextConfig,
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    expect(written.materialized).toBe(true);
    await expect(fs.readJson(resolveCatalogSourcesConfigPath(isolation.env)))
      .resolves.toEqual(nextConfig);
    const error = await replaceCatalogSourcesConfig({
      config: setPrimaryCatalogSource(nextConfig, 'local'),
      expectedDigest: initial.digest,
      env: isolation.env,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CatalogSourcesConfigConflictError);
    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
      digest: written.digest,
      config: nextConfig,
    });
  });

  it('keeps the old config when atomic replacement fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'atomic-catalog');
    await fs.ensureDir(sourceRoot);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const current = await replaceCatalogSourcesConfig({
      config: await createTwoSourceConfig(sourceRoot),
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    setAtomicConfigBeforeRenameHookForTests(async () => {
      throw new Error('injected catalog source replacement failure');
    });

    await expect(replaceCatalogSourcesConfig({
      config: setPrimaryCatalogSource(current.config, 'local'),
      expectedDigest: current.digest,
      env: isolation.env,
    })).rejects.toThrow('injected catalog source replacement failure');

    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
      digest: current.digest,
      config: current.config,
    });
    const entries = await fs.readdir(isolation.layout.awHomeDir);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    await expect(fs.pathExists(resolveConfigFileLockPath(
      resolveCatalogSourcesConfigPath(isolation.env),
    ))).resolves.toBe(false);
  });

  it.each([1, 2])(
    'returns the committed source config after %s transient lock release failures',
    async (failures) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `source-release-${failures}`);
      await fs.ensureDir(sourceRoot);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      const nextConfig = await createTwoSourceConfig(sourceRoot);
      const attempts: number[] = [];
      setConfigFileLockBeforeReleaseHookForTests(async (_lockPath, attempt) => {
        attempts.push(attempt);
        if (attempt <= failures) {
          throw Object.assign(new Error('transient source lock release'), {
            code: failures === 1 ? 'EBUSY' : 'EPERM',
          });
        }
      });

      await expect(replaceCatalogSourcesConfig({
        config: nextConfig,
        expectedDigest: initial.digest,
        env: isolation.env,
      })).resolves.toMatchObject({ config: nextConfig, materialized: true });
      expect(attempts).toEqual(Array.from({ length: failures + 1 }, (_, index) => index + 1));
      await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
        config: nextConfig,
        materialized: true,
      });
    },
  );
});

describe('catalog source identity v1', () => {
  it('matches the v1 golden and isolates internal duplicate Git path slashes', async () => {
    expect(CATALOG_SOURCE_IDENTITY_VERSION).toBe(1);
    const golden = await calculateCatalogSourceIdentity({
      id: 'golden',
      type: 'git',
      primary: true,
      url: 'https://example.test/catalog.git',
      refPolicy: { type: 'cliChannel' },
    });
    const singleSlash = await calculateCatalogSourceIdentity({
      id: 'single',
      type: 'git',
      primary: false,
      url: 'https://example.test/a/b.git',
      refPolicy: { type: 'cliChannel' },
    });
    const duplicateSlash = await calculateCatalogSourceIdentity({
      id: 'duplicate',
      type: 'git',
      primary: false,
      url: 'https://example.test/a//b.git',
      refPolicy: { type: 'cliChannel' },
    });

    expect(golden).toBe(
      'sha256:001600846ca6aa9da55e8b9679f151eb14e0e6e7cc5b8c5cbfd5af8dbd88e908',
    );
    expect(singleSlash).not.toBe(duplicateSlash);
  });

  it('is stable across source ID, ref, and equivalent Git URL spelling', async () => {
    const left = await calculateCatalogSourceIdentity({
      id: 'first',
      type: 'git',
      primary: true,
      url: 'https://GitHub.com:443/example/catalog.git/',
      refPolicy: { type: 'explicit', ref: 'refs/heads/one' },
    });
    const right = await calculateCatalogSourceIdentity({
      id: 'second',
      type: 'git',
      primary: false,
      url: 'https://github.com/example/catalog.git',
      refPolicy: { type: 'explicit', ref: 'refs/heads/two' },
    });
    const other = await calculateCatalogSourceIdentity({
      id: 'third',
      type: 'git',
      primary: false,
      url: 'https://github.com/example/other.git',
      refPolicy: { type: 'cliChannel' },
    });

    expect(left).toBe(right);
    expect(left).not.toBe(other);
  });

  it('keeps scp-relative and ssh-url-absolute repository paths distinct', async () => {
    const scpRelative = await calculateCatalogSourceIdentity({
      id: 'scp-relative',
      type: 'git',
      primary: true,
      url: 'git@Example.Test:repo.git/',
      refPolicy: { type: 'cliChannel' },
    });
    const equivalentScpSpelling = await calculateCatalogSourceIdentity({
      id: 'scp-equivalent',
      type: 'git',
      primary: false,
      url: 'git@example.test:repo.git',
      refPolicy: { type: 'explicit', ref: 'refs/heads/other' },
    });
    const sshAbsolute = await calculateCatalogSourceIdentity({
      id: 'ssh-absolute',
      type: 'git',
      primary: false,
      url: 'ssh://git@example.test/repo.git',
      refPolicy: { type: 'cliChannel' },
    });

    expect(scpRelative).toBe(
      'sha256:0ec4fad104f7eec7c60572b57a3adc4150cb9d6b3761da583518bc86ebf118a7',
    );
    expect(equivalentScpSpelling).toBe(scpRelative);
    expect(sshAbsolute).not.toBe(scpRelative);
  });

  it('hashes the persisted absolute path without IO and rejects path subdir', async () => {
    const root = await makePathSourceRoot();
    const alias = `${root}-alias`;
    tempDirs.push(alias);
    await fs.symlink(root, alias, 'dir');
    const direct = await calculateCatalogSourceIdentity({
      id: 'direct',
      type: 'path',
      primary: true,
      path: root,
    });
    const linked = await calculateCatalogSourceIdentity({
      id: 'linked',
      type: 'path',
      primary: false,
      path: alias,
    });
    expect(direct).not.toBe(linked);
    await fs.remove(root);
    await expect(calculateCatalogSourceIdentity({
      id: 'missing',
      type: 'path',
      primary: true,
      path: root,
    })).resolves.toBe(direct);
    expect(() => validateCatalogSourcesConfig({
      schemaVersion: 1,
      sources: [{
        id: 'invalid',
        type: 'path',
        primary: true,
        path: root,
        subdir: 'catalog',
      }],
    })).toThrow('unknown field "subdir"');
  });

  it('materializes path aliases once and stays stable across caller cwd values', async () => {
    const root = await makePathSourceRoot();
    const firstCwd = path.join(root, 'first');
    const secondCwd = path.join(root, 'second', 'nested');
    const catalogRoot = path.join(root, 'catalog');
    const alias = path.join(root, 'catalog-alias');
    await fs.ensureDir(firstCwd);
    await fs.ensureDir(secondCwd);
    await fs.ensureDir(catalogRoot);
    await fs.symlink(catalogRoot, alias, 'dir');

    const first = await addCatalogSource(createDefaultCatalogSourcesConfig(), {
      id: 'local',
      type: 'path',
      primary: false,
      path: '../catalog-alias',
    }, firstCwd);
    const second = await addCatalogSource(createDefaultCatalogSourcesConfig(), {
      id: 'local',
      type: 'path',
      primary: false,
      path: '../../catalog',
    }, secondCwd);
    const firstSource = first.sources.find((source) => source.id === 'local')!;
    const secondSource = second.sources.find((source) => source.id === 'local')!;

    expect(firstSource).toMatchObject({ type: 'path', path: await fs.realpath(catalogRoot) });
    expect(secondSource).toEqual(firstSource);
    expect(await calculateCatalogSourceIdentity(firstSource))
      .toBe(await calculateCatalogSourceIdentity(secondSource));

    const replacement = path.join(root, 'replacement');
    const replacementAlias = path.join(root, 'replacement-alias');
    await fs.ensureDir(replacement);
    await fs.symlink(replacement, replacementAlias, 'dir');
    const updated = await updateCatalogSource(
      first,
      'local',
      { type: 'path', path: '../replacement-alias' },
      firstCwd,
    );
    expect(updated.sources.find((source) => source.id === 'local'))
      .toMatchObject({ path: await fs.realpath(replacement) });
  });

  it('rejects invalid and credential-bearing Git URLs', () => {
    expect(() => canonicalizeCatalogGitUrl('not-a-url')).toThrow('absolute URL');
    expect(() => canonicalizeCatalogGitUrl('https://user:secret@example.test/repo.git'))
      .toThrow('credentials');
    expect(canonicalizeCatalogGitUrl('file:///tmp/catalog')).toBe('file:///tmp/catalog');
    expect(canonicalizeCatalogGitUrl('/tmp/catalog/')).toBe('/tmp/catalog');
    expect(() => canonicalizeCatalogGitUrl('http://example.test/repo.git')).toThrow('protocol');
    expect(() => canonicalizeCatalogGitUrl('git://example.test/repo.git')).toThrow('protocol');
    expect(() => canonicalizeCatalogGitUrl('ext::helper repo')).toThrow();
    expect(() => canonicalizeCatalogGitUrl('https://example.test/repo.git?token=secret'))
      .toThrow('query strings');
    expect(() => canonicalizeCatalogGitUrl('https://example.test/repo.git#main'))
      .toThrow('fragments');
  });
});
