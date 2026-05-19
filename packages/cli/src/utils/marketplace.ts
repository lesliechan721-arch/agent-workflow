import crypto from 'node:crypto';
import os from 'node:os';
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

interface NpmAuthConfig {
  token?: string;
  auth?: string;
  username?: string;
  password?: string;
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

function resolveNpmHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function resolveNpmUserConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG;
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override.trim());
  }

  return path.join(resolveNpmHomeDir(env), '.npmrc');
}

const npmNodeModulesMarker = 'node_modules';
const npmPackageJsonMarker = 'package.json';

function readNpmWorkspacePatternsFromPackageJson(
  manifest: unknown,
): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [];
  }

  const workspaces = (manifest as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '');
  }

  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) {
    return [];
  }

  const packages = (workspaces as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) {
    return [];
  }

  return packages.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '');
}

async function resolveNpmWorkspacePatterns(
  packageJsonPath: string,
): Promise<string[]> {
  try {
    return readNpmWorkspacePatternsFromPackageJson(await readJsonFile<unknown>(packageJsonPath));
  } catch {
    return [];
  }
}

function normalizeNpmWorkspacePattern(
  pattern: string,
): string {
  const normalizedPattern = path.posix.normalize(pattern.replaceAll('\\', path.posix.sep))
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return normalizedPattern === '.' ? '' : normalizedPattern;
}

function matchesNpmWorkspacePackagePath(
  workspaceRoot: string,
  packageDir: string,
  workspacePatterns: readonly string[],
): boolean {
  if (workspacePatterns.length === 0) {
    return false;
  }

  const relativePackagePath = path.relative(workspaceRoot, packageDir);
  if (!relativePackagePath || relativePackagePath.startsWith('..')) {
    return false;
  }

  const normalizedPackagePath = relativePackagePath.split(path.sep).join(path.posix.sep);
  let matched = false;

  for (const rawPattern of workspacePatterns) {
    const trimmedPattern = rawPattern.trim();
    if (!trimmedPattern) {
      continue;
    }

    const negated = trimmedPattern.startsWith('!');
    const pattern = normalizeNpmWorkspacePattern(
      negated ? trimmedPattern.slice(1) : trimmedPattern,
    );
    if (!pattern) {
      continue;
    }

    if (path.posix.matchesGlob(normalizedPackagePath, pattern)) {
      matched = !negated;
    }
  }

  return matched;
}

async function resolveNpmLocalPrefix(
  cwd = process.cwd(),
): Promise<string> {
  const startDir = path.resolve(cwd);
  let currentDir = startDir;
  let localPrefix: string | null = null;

  while (true) {
    const packageJsonPath = path.join(currentDir, npmPackageJsonMarker);
    if (await fs.pathExists(packageJsonPath)) {
      if (localPrefix === null) {
        localPrefix = currentDir;
      } else {
        const workspacePatterns = await resolveNpmWorkspacePatterns(packageJsonPath);
        if (matchesNpmWorkspacePackagePath(currentDir, localPrefix, workspacePatterns)) {
          return currentDir;
        }
      }
    } else if (
      localPrefix === null
      && await fs.pathExists(path.join(currentDir, npmNodeModulesMarker))
    ) {
      localPrefix = currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return localPrefix ?? startDir;
    }
    currentDir = parentDir;
  }
}

async function resolveNpmProjectConfigPath(
  cwd = process.cwd(),
): Promise<string> {
  return path.join(await resolveNpmLocalPrefix(cwd), '.npmrc');
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\'')))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function expandNpmConfigEnvReferences(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, rawName: string) => {
    const optional = rawName.endsWith('?');
    const envName = optional ? rawName.slice(0, -1) : rawName;
    const resolved = env[envName];
    return typeof resolved === 'string' ? resolved : '';
  });
}

async function readNpmConfigEntries(
  configPath: string,
  env: NodeJS.ProcessEnv,
): Promise<Array<[key: string, value: string]>> {
  if (!(await fs.pathExists(configPath))) {
    return [];
  }

  const text = await fs.readFile(configPath, 'utf8');
  const entries: Array<[key: string, value: string]> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = stripMatchingQuotes(
      expandNpmConfigEnvReferences(rawValue, env),
    );
    entries.push([key, value]);
  }

  return entries;
}

function normalizeNpmAuthPrefix(prefix: string): string {
  if (!prefix.startsWith('//')) {
    return prefix;
  }

  const slashIndex = prefix.indexOf('/', 2);
  const host = (
    slashIndex === -1
      ? prefix.slice(2)
      : prefix.slice(2, slashIndex)
  ).toLowerCase();
  let pathname = slashIndex === -1 ? '/' : prefix.slice(slashIndex);
  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  return `//${host}${pathname.endsWith('/') ? pathname : `${pathname}/`}`;
}

function applyNpmAuthConfigValue(
  config: NpmAuthConfig,
  field: '_authToken' | '_auth' | 'username' | '_password',
  value: string,
): void {
  const nextValue = value.trim() === '' ? undefined : value;

  switch (field) {
    case '_authToken':
      if (nextValue === undefined) {
        delete config.token;
      } else {
        config.token = nextValue;
      }
      break;
    case '_auth':
      if (nextValue === undefined) {
        delete config.auth;
      } else {
        config.auth = nextValue;
      }
      break;
    case 'username':
      if (nextValue === undefined) {
        delete config.username;
      } else {
        config.username = nextValue;
      }
      break;
    case '_password':
      if (nextValue === undefined) {
        delete config.password;
      } else {
        config.password = nextValue;
      }
      break;
    default:
      break;
  }
}

async function readNpmAuthConfigs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, NpmAuthConfig>> {
  const configPaths = [
    resolveNpmUserConfigPath(env),
    await resolveNpmProjectConfigPath(),
  ];
  const authConfigs = new Map<string, NpmAuthConfig>();
  const visited = new Set<string>();

  for (const configPath of configPaths) {
    const resolvedPath = path.resolve(configPath);
    if (visited.has(resolvedPath)) {
      continue;
    }
    visited.add(resolvedPath);

    const entries = await readNpmConfigEntries(resolvedPath, env);
    for (const [key, value] of entries) {
      if (!key.startsWith('//')) {
        continue;
      }

      const separatorIndex = key.lastIndexOf(':');
      if (separatorIndex <= 2 || separatorIndex === key.length - 1) {
        continue;
      }

      const prefix = normalizeNpmAuthPrefix(key.slice(0, separatorIndex));
      const field = key.slice(separatorIndex + 1);
      if (
        field !== '_authToken'
        && field !== '_auth'
        && field !== 'username'
        && field !== '_password'
      ) {
        continue;
      }

      const nextConfig = { ...(authConfigs.get(prefix) ?? {}) };
      applyNpmAuthConfigValue(nextConfig, field, value);
      authConfigs.set(prefix, nextConfig);
    }
  }

  return authConfigs;
}

function buildRequestAuthScope(url: string): string {
  const parsed = new URL(url);
  return normalizeNpmAuthPrefix(`//${parsed.host}${parsed.pathname || '/'}`);
}

function decodeBase64IfValid(value: string): string {
  const normalized = value.replace(/=+$/, '');
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const reencoded = Buffer.from(decoded, 'utf8')
    .toString('base64')
    .replace(/=+$/, '');

  return reencoded === normalized ? decoded : value;
}

function resolveAuthorizationHeader(
  config: NpmAuthConfig,
): string | null {
  if (typeof config.token === 'string' && config.token.trim() !== '') {
    return `Bearer ${config.token.trim()}`;
  }

  if (typeof config.auth === 'string' && config.auth.trim() !== '') {
    return `Basic ${config.auth.trim()}`;
  }

  if (
    typeof config.username === 'string'
    && config.username.trim() !== ''
    && typeof config.password === 'string'
    && config.password.trim() !== ''
  ) {
    const password = decodeBase64IfValid(config.password.trim());
    const basicAuth = Buffer.from(
      `${config.username.trim()}:${password}`,
      'utf8',
    ).toString('base64');
    return `Basic ${basicAuth}`;
  }

  return null;
}

async function resolveRegistryAuthorizationHeader(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const authConfigs = await readNpmAuthConfigs(env);
  if (authConfigs.size === 0) {
    return null;
  }

  const requestScope = buildRequestAuthScope(url);
  const matchingPrefixes = Array.from(authConfigs.keys())
    .filter((prefix) => requestScope.startsWith(prefix))
    .sort((left, right) => right.length - left.length);

  for (const prefix of matchingPrefixes) {
    const header = resolveAuthorizationHeader(authConfigs.get(prefix)!);
    if (header) {
      return header;
    }
  }

  return null;
}

async function buildRegistryRequestHeaders(
  url: string,
  env: NodeJS.ProcessEnv,
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  const resolvedHeaders = { ...headers };
  const authorization = await resolveRegistryAuthorizationHeader(url, env);
  if (authorization) {
    resolvedHeaders.authorization = authorization;
  }

  return resolvedHeaders;
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
  const fromEnv = env.AW_NPM_REGISTRY_URL || env.npm_config_registry || env.NPM_CONFIG_REGISTRY;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return normalizeRegistryBaseUrl(fromEnv.trim());
  }

  const fromPackage = await readCliPublishRegistry();
  if (fromPackage) {
    return normalizeRegistryBaseUrl(fromPackage);
  }

  return 'https://registry.npmjs.org/';
}

async function fetchJson(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: await buildRegistryRequestHeaders(url, env, {
      accept: 'application/json',
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchBuffer(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: await buildRegistryRequestHeaders(url, env),
  });
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

  const archiveBuffer = await fetchBuffer(identity.tarballUrl, env);
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
    env,
  ) as RegistryPackageMetadata;

  const version = metadata['dist-tags']?.[distTag];
  if (!version) {
    throw new Error(`Registry dist-tag ${distTag} is missing for ${packageName}.`);
  }

  const versionMetadata = metadata.versions?.[version];
  if (!versionMetadata) {
    throw new Error(`Registry version ${version} is missing for ${packageName}.`);
  }
  if (!versionMetadata.dist?.integrity || !versionMetadata.dist.tarball) {
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
    env,
  ) as RegistryPackageMetadata;

  const versionMetadata = metadata.versions?.[version];
  if (!versionMetadata) {
    throw new Error(`Registry version ${version} is missing for ${packageName}.`);
  }
  if (!versionMetadata.dist?.integrity || !versionMetadata.dist.tarball) {
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
