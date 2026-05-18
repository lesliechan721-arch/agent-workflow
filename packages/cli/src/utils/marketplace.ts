import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  CURRENT_CATALOG_MANIFEST_FILE,
} from '../constants.js';
import type {
  CatalogChannel,
  CatalogVersion,
  MarketplaceManifest,
  PlatformName,
} from '../types.js';
import { readJsonFile } from './json.js';
import { validateCatalogManifest } from './manifest.js';
import { resolveCliPackageRoot, resolveCurrentCatalogCacheStagingDir, getMarketplaceManifestPath } from './paths.js';
import { runNativeCli } from './native-cli.js';

interface RegistryPackageVersionMetadata {
  version?: string;
  dist?: {
    integrity?: string;
    tarball?: string;
  };
}

interface RegistryPackageMetadata {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, RegistryPackageVersionMetadata>;
}

export interface CatalogPackageArchiveIdentity {
  packageName: string;
  version: CatalogVersion;
  integrity: string;
  tarballUrl?: string;
  requestedDistTag?: CatalogChannel;
}

export interface CatalogPackageArchive {
  identity: CatalogPackageArchiveIdentity;
  manifestText: string;
  rawManifest: unknown;
  packageRoot: string;
  materialize: (targetRoot: string) => Promise<void>;
  dispose: () => Promise<void>;
}

export interface CatalogPackageSource {
  resolveIdentityByDistTag: (
    packageName: string,
    distTag: CatalogChannel,
    env?: NodeJS.ProcessEnv,
  ) => Promise<CatalogPackageArchiveIdentity>;
  resolveIdentityByVersion: (
    packageName: string,
    version: CatalogVersion,
    env?: NodeJS.ProcessEnv,
  ) => Promise<CatalogPackageArchiveIdentity>;
  downloadArchive: (
    identity: CatalogPackageArchiveIdentity,
    env?: NodeJS.ProcessEnv,
  ) => Promise<CatalogPackageArchive>;
}

let catalogPackageSourceOverride: CatalogPackageSource | null = null;

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value;
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }

  return value.map((entry, index) => assertString(entry, `${fieldName}[${index}]`));
}

function validateMarketplaceManifestEntry(
  value: unknown,
  fieldName: string,
): void {
  const entry = assertObject(value, fieldName);
  assertString(entry.name, `${fieldName}.name`);
  assertString(entry.source, `${fieldName}.source`);
  assertString(entry.description, `${fieldName}.description`);
  assertString(entry.category, `${fieldName}.category`);

  if (entry.tags !== undefined) {
    assertStringArray(entry.tags, `${fieldName}.tags`);
  }
  if (typeof entry.strict !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.strict: expected a boolean.`);
  }
  if (entry.interface !== undefined) {
    const interfaceMeta = assertObject(entry.interface, `${fieldName}.interface`);
    if (interfaceMeta.displayName !== undefined) {
      assertString(interfaceMeta.displayName, `${fieldName}.interface.displayName`);
    }
    if (interfaceMeta.shortDescription !== undefined) {
      assertString(interfaceMeta.shortDescription, `${fieldName}.interface.shortDescription`);
    }
    if (interfaceMeta.capabilities !== undefined) {
      assertStringArray(interfaceMeta.capabilities, `${fieldName}.interface.capabilities`);
    }
  }

  const policy = assertObject(entry.policy, `${fieldName}.policy`);
  assertString(policy.installation, `${fieldName}.policy.installation`);
  assertString(policy.authentication, `${fieldName}.policy.authentication`);
  if (policy.products !== undefined) {
    assertStringArray(policy.products, `${fieldName}.policy.products`);
  }
}

export function validateMarketplaceManifest(
  value: unknown,
  fieldName = 'marketplace manifest',
): MarketplaceManifest {
  const manifest = assertObject(value, fieldName);
  if (assertString(manifest.name, `${fieldName}.name`) !== 'aw') {
    throw new Error(`Invalid ${fieldName}.name: expected "aw".`);
  }

  const owner = assertObject(manifest.owner, `${fieldName}.owner`);
  assertString(owner.name, `${fieldName}.owner.name`);
  assertString(owner.url, `${fieldName}.owner.url`);

  const interfaceMeta = assertObject(manifest.interface, `${fieldName}.interface`);
  assertString(interfaceMeta.displayName, `${fieldName}.interface.displayName`);

  const plugins = manifest.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`Invalid ${fieldName}.plugins: expected an array.`);
  }
  plugins.forEach((entry, index) => {
    validateMarketplaceManifestEntry(entry, `${fieldName}.plugins[${index}]`);
  });

  return manifest as unknown as MarketplaceManifest;
}

function normalizeRegistryBaseUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

async function readCliPublishRegistry(): Promise<string | null> {
  try {
    const packageJson = await readJsonFile<{ publishConfig?: { registry?: string } }>(
      path.join(resolveCliPackageRoot(), 'package.json'),
    );
    return typeof packageJson.publishConfig?.registry === 'string'
      ? packageJson.publishConfig.registry
      : null;
  } catch {
    return null;
  }
}

async function resolveCatalogRegistryUrl(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const fromEnv = env.AW_NPM_REGISTRY_URL || env.npm_config_registry;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return normalizeRegistryBaseUrl(fromEnv.trim());
  }

  const fromPackage = await readCliPublishRegistry();
  if (fromPackage) {
    return normalizeRegistryBaseUrl(fromPackage);
  }

  return 'https://registry.npmjs.org/';
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function verifyPackageIntegrity(buffer: Buffer, integrity: string): void {
  const token = integrity
    .split(/\s+/)
    .map((entry) => entry.trim())
    .find((entry) => entry.includes('-'));
  if (!token) {
    throw new Error(`Unsupported integrity string: ${integrity}`);
  }

  const separatorIndex = token.indexOf('-');
  const algorithm = token.slice(0, separatorIndex);
  const expected = token.slice(separatorIndex + 1);
  if (!algorithm || !expected) {
    throw new Error(`Unsupported integrity string: ${integrity}`);
  }

  const actual = crypto.createHash(algorithm).update(buffer).digest('base64');
  if (actual !== expected) {
    throw new Error(`Integrity mismatch for ${algorithm}.`);
  }
}

async function extractPackageArchive(
  archiveBuffer: Buffer,
  env: NodeJS.ProcessEnv,
): Promise<{ tempRoot: string; packageRoot: string }> {
  const stagingParent = resolveCurrentCatalogCacheStagingDir(env);
  await fs.ensureDir(stagingParent);

  const tempRoot = await fs.mkdtemp(path.join(stagingParent, 'package-'));
  const tarballPath = path.join(tempRoot, 'archive.tgz');
  const extractRoot = path.join(tempRoot, 'extract');
  await fs.ensureDir(extractRoot);
  await fs.writeFile(tarballPath, archiveBuffer);

  await runNativeCli({
    command: 'tar',
    args: ['-xzf', tarballPath, '-C', extractRoot],
  });

  const packageRoot = path.join(extractRoot, 'package');
  if (!(await fs.pathExists(packageRoot))) {
    throw new Error('npm tarball does not contain a package/ root.');
  }

  return {
    tempRoot,
    packageRoot,
  };
}

async function resolveRegistryPackageArchive(
  identity: CatalogPackageArchiveIdentity,
  env: NodeJS.ProcessEnv,
): Promise<CatalogPackageArchive> {
  if (!identity.tarballUrl) {
    throw new Error(`Package ${identity.packageName}@${identity.version} is missing dist.tarball.`);
  }

  const archiveBuffer = await fetchBuffer(identity.tarballUrl);
  verifyPackageIntegrity(archiveBuffer, identity.integrity);

  const extracted = await extractPackageArchive(archiveBuffer, env);
  const manifestPath = path.join(extracted.packageRoot, CURRENT_CATALOG_MANIFEST_FILE);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const rawManifest = JSON.parse(manifestText) as unknown;

  return {
    identity,
    manifestText,
    rawManifest,
    packageRoot: extracted.packageRoot,
    materialize: async (targetRoot: string) => {
      await fs.remove(targetRoot);
      await fs.ensureDir(path.dirname(targetRoot));
      await fs.copy(extracted.packageRoot, targetRoot);
    },
    dispose: async () => {
      await fs.remove(extracted.tempRoot);
    },
  };
}

async function resolvePackageIdentityByDistTag(
  packageName: string,
  distTag: CatalogChannel,
  env: NodeJS.ProcessEnv,
): Promise<CatalogPackageArchiveIdentity> {
  const registryUrl = await resolveCatalogRegistryUrl(env);
  const metadata = await fetchJson(
    `${registryUrl}${encodeURIComponent(packageName)}`,
  ) as RegistryPackageMetadata;

  const version = metadata['dist-tags']?.[distTag];
  if (!version) {
    throw new Error(`Registry dist-tag ${distTag} is missing for ${packageName}.`);
  }

  const versionMetadata = metadata.versions?.[version];
  if (!versionMetadata?.dist?.integrity || !versionMetadata.dist.tarball) {
    throw new Error(`Registry metadata for ${packageName}@${version} is missing dist.integrity or dist.tarball.`);
  }

  return {
    packageName,
    version,
    integrity: versionMetadata.dist.integrity,
    tarballUrl: versionMetadata.dist.tarball,
    requestedDistTag: distTag,
  };
}

async function resolvePackageIdentityByVersion(
  packageName: string,
  version: CatalogVersion,
  env: NodeJS.ProcessEnv,
): Promise<CatalogPackageArchiveIdentity> {
  const registryUrl = await resolveCatalogRegistryUrl(env);
  const metadata = await fetchJson(
    `${registryUrl}${encodeURIComponent(packageName)}`,
  ) as RegistryPackageMetadata;

  const versionMetadata = metadata.versions?.[version];
  if (!versionMetadata?.dist?.integrity || !versionMetadata.dist.tarball) {
    throw new Error(`Registry metadata for ${packageName}@${version} is missing dist.integrity or dist.tarball.`);
  }

  return {
    packageName,
    version,
    integrity: versionMetadata.dist.integrity,
    tarballUrl: versionMetadata.dist.tarball,
  };
}

const defaultCatalogPackageSource: CatalogPackageSource = {
  resolveIdentityByDistTag: async (packageName, distTag, env = process.env) =>
    resolvePackageIdentityByDistTag(packageName, distTag, env),
  resolveIdentityByVersion: async (packageName, version, env = process.env) =>
    resolvePackageIdentityByVersion(packageName, version, env),
  downloadArchive: async (identity, env = process.env) =>
    resolveRegistryPackageArchive(identity, env),
};

function getCatalogPackageSource(): CatalogPackageSource {
  return catalogPackageSourceOverride ?? defaultCatalogPackageSource;
}

export function setCatalogPackageSourceForTests(
  source: CatalogPackageSource | null,
): void {
  catalogPackageSourceOverride = source;
}

export function hasCatalogPackageSourceOverrideForTests(): boolean {
  return catalogPackageSourceOverride !== null;
}

export async function resolveCatalogPackageByDistTag(
  packageName: string,
  distTag: CatalogChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogPackageArchive> {
  const source = getCatalogPackageSource();
  const identity = await source.resolveIdentityByDistTag(packageName, distTag, env);
  return source.downloadArchive(identity, env);
}

export async function resolveCatalogPackageByVersion(
  packageName: string,
  version: CatalogVersion,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogPackageArchive> {
  const source = getCatalogPackageSource();
  const identity = await source.resolveIdentityByVersion(packageName, version, env);
  return source.downloadArchive(identity, env);
}

export async function resolveCatalogPackageIdentityByDistTag(
  packageName: string,
  distTag: CatalogChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogPackageArchiveIdentity> {
  return getCatalogPackageSource().resolveIdentityByDistTag(packageName, distTag, env);
}

export async function resolveCatalogPackageIdentityByVersion(
  packageName: string,
  version: CatalogVersion,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogPackageArchiveIdentity> {
  return getCatalogPackageSource().resolveIdentityByVersion(packageName, version, env);
}

export async function downloadCatalogPackageArchive(
  identity: CatalogPackageArchiveIdentity,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogPackageArchive> {
  return getCatalogPackageSource().downloadArchive(identity, env);
}

export async function readMarketplaceManifestAtPath(
  manifestPath: string,
  fieldName = 'marketplace manifest',
): Promise<MarketplaceManifest> {
  return validateMarketplaceManifest(
    await readJsonFile<unknown>(manifestPath),
    fieldName,
  );
}

export async function readMarketplaceManifest(
  _cwd: string,
  platform: PlatformName,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  path: string;
  manifest: MarketplaceManifest;
}> {
  const { resolveCurrentCatalog } = await import('./plugin-catalog.js');
  const catalog = await resolveCurrentCatalog(env);
  const targetPath = getMarketplaceManifestPath(catalog.rootDir, platform);
  const targetManifest = await readMarketplaceManifestAtPath(
    targetPath,
    `${platform} marketplace manifest`,
  );

  return {
    path: targetPath,
    manifest: targetManifest,
  };
}

export function validateCatalogArchiveManifest(
  archive: CatalogPackageArchive,
): ReturnType<typeof validateCatalogManifest> {
  return validateCatalogManifest(archive.rawManifest);
}
