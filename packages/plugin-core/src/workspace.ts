import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import fs from 'fs-extra';

import {
  assertCatalogVersion,
  assertStrictSemVer,
  compareStrictSemVer,
  MARKETPLACE_SOURCE_PATH,
  SOURCE_MANIFEST_PATH,
  createMarketplaceManifest,
  createMarketplaceManifestEntry,
  normalizeCatalogManifestBase,
  normalizeCatalogMarketplaceIdentity,
  normalizeCatalogManifestEntries,
  normalizeManifestDigestInput,
  readMarketplaceSourceMeta,
  readPluginManifest,
  validatePlatformManifestProjection,
} from './manifest-contract.js';
import { resolveSupportedPlatforms } from './platform-support.js';
import {
  createAwPluginRequirementsReceipt,
  normalizeAwCapabilities,
  parseAwPluginRequirementsReceipt,
} from './aw-capabilities.js';
import {
  appendCatalogToPluginReleaseLedger,
  assertStablePluginVersion,
  PLUGIN_RELEASE_LEDGER_FILENAME,
  PLUGIN_RELEASE_LEDGER_SCHEMA_VERSION,
  resolveBetaPluginVersionOverrides,
  validatePluginReleaseLedgerAgainstManifest,
  type PluginReleaseLedger,
} from './plugin-release.js';
import type { ReservedImportRegistry } from './manifest-contract.js';
import type {
  CatalogChannel,
  CatalogManifestV5,
  MarketplaceSourceMeta,
  MarketplaceManifest,
  PluginMeta,
} from './types.js';

export const DEFAULT_CATALOG_WORKSPACE_VERSION = '0.1.0';
export const DEFAULT_CATALOG_OUTPUT_PATH = path.join('.aw', 'catalog');
export const DEFAULT_PUBLISHED_CATALOG_OUTPUT_PATH = path.join('.aw', 'publish', 'catalog');
export const DEFAULT_PLUGIN_OUTPUT_PATH = path.join('.aw', 'plugins');
export const CATALOG_MANIFEST_FILENAME = 'catalog-manifest.json';
export const GENERATED_OUTPUT_MARKER_FILENAME = '.aw-generated.json';
export const CATALOG_WORKSPACE_MARKER_FILENAME = '.aw-workspace.json';
const AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME = 'aw-plugin-requirements.json';

export interface CatalogWorkspaceInitOptions {
  workspaceRoot: string;
  ownerName?: string;
  ownerUrl?: string;
  displayName?: string;
  catalogVersion?: string;
  force?: boolean;
}

export interface CatalogWorkspacePluginBuildAdapter {
  build(options: {
    workspaceRoot: string;
    plugin: PluginMeta;
    plugins: readonly PluginMeta[];
    dependencies: PluginMeta[];
    outputRoot: string;
  }): Promise<void>;
}

export type CatalogWorkspaceBuildAdapter = CatalogWorkspacePluginBuildAdapter;

export interface CatalogWorkspaceSourceOptions {
  reservedImports?: ReservedImportRegistry;
}

export type CatalogVersionBump = 'major' | 'minor' | 'patch';

export interface CatalogVersionMutation {
  version?: string;
  bump?: CatalogVersionBump;
}

export interface CatalogWorkspace {
  workspaceRoot: string;
  markerPath: string;
  workspaceIdentity: string;
  metadataPath: string;
  metadata: MarketplaceSourceMeta;
  plugins: PluginMeta[];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function assertDirectoryWithoutSymlinks(directory: string, label: string): Promise<string> {
  const requested = path.resolve(directory);
  const stat = await fs.lstat(requested).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic-link directory: ${requested}`);
  }
  return fs.realpath(requested);
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Output path must not contain symbolic links: ${current}`);
    }
  }
}

export async function resolveCatalogWorkspaceOutputPath(options: {
  workspaceRoot: string;
  outputPath: string;
  kind?: 'catalog' | 'plugin';
}): Promise<{ workspaceRoot: string; outputRoot: string }> {
  const workspaceRoot = await assertDirectoryWithoutSymlinks(options.workspaceRoot, 'Catalog Workspace root');
  const outputRoot = path.resolve(workspaceRoot, options.outputPath);
  if (!isInside(workspaceRoot, outputRoot) || outputRoot === workspaceRoot) {
    throw new Error(`Output must be inside the Catalog Workspace: ${outputRoot}`);
  }
  await assertNoSymlinkPath(workspaceRoot, outputRoot);
  const protectedRoots = [
    path.join(workspaceRoot, '.aw'),
    path.join(workspaceRoot, '.git'),
    path.join(workspaceRoot, 'plugins'),
  ];
  for (const protectedRoot of protectedRoots) {
    if (protectedRoot.endsWith(`${path.sep}.aw`) && outputRoot !== protectedRoot) continue;
    if (isInside(protectedRoot, outputRoot) || isInside(outputRoot, protectedRoot)) {
      throw new Error(`Output overlaps a protected Catalog Workspace path: ${outputRoot}`);
    }
  }
  const otherGeneratedRoot = path.join(
    workspaceRoot,
    options.kind === 'catalog' ? DEFAULT_PLUGIN_OUTPUT_PATH : DEFAULT_CATALOG_OUTPUT_PATH,
  );
  if (options.kind && (isInside(otherGeneratedRoot, outputRoot) || isInside(outputRoot, otherGeneratedRoot))) {
    throw new Error(`Output overlaps a different generated output kind: ${outputRoot}`);
  }
  return { workspaceRoot, outputRoot };
}

function safeCatalogWorkspaceName(workspaceRoot: string): string {
  const normalized = path.basename(workspaceRoot).toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalized || 'aw-workspace';
}

function catalogWorkspaceMetadata(options: CatalogWorkspaceInitOptions, workspaceRoot: string): MarketplaceSourceMeta {
  const catalogWorkspaceName = safeCatalogWorkspaceName(workspaceRoot);
  return {
    owner: {
      name: options.ownerName?.trim() || catalogWorkspaceName,
      url: options.ownerUrl?.trim() || `https://example.invalid/aw-workspaces/${catalogWorkspaceName}`,
    },
    interface: {
      displayName: options.displayName?.trim() || catalogWorkspaceName,
    },
    catalog: {
      version: assertCatalogVersion(
        options.catalogVersion ?? DEFAULT_CATALOG_WORKSPACE_VERSION,
        'catalog version',
      ),
    },
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.remove(temporary);
    throw error;
  }
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, value, { flag: 'wx' });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.remove(temporary);
    throw error;
  }
}

function catalogWorkspaceMarker() {
  return {
    schemaVersion: 1,
    kind: 'aw-catalog-workspace',
    workspaceIdentity: sha256(crypto.randomUUID()),
  };
}

function validateCatalogWorkspaceMarker(
  value: unknown,
): { workspaceIdentity: string } {
  const marker = value as Record<string, unknown>;
  if (
    !marker
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || !isDeepStrictEqual(Object.keys(marker).sort(), [
      'kind', 'schemaVersion', 'workspaceIdentity',
    ])
    || marker.schemaVersion !== 1
    || marker.kind !== 'aw-catalog-workspace'
    || typeof marker.workspaceIdentity !== 'string'
    || marker.workspaceIdentity.trim().length === 0
  ) {
    throw new Error('Invalid Catalog Workspace marker.');
  }
  return { workspaceIdentity: marker.workspaceIdentity };
}

async function readCatalogWorkspaceMarker(
  workspaceRoot: string,
): Promise<{ markerPath: string; workspaceIdentity: string }> {
  const markerPath = path.join(workspaceRoot, CATALOG_WORKSPACE_MARKER_FILENAME);
  const marker = validateCatalogWorkspaceMarker(
    await readRegularJson(markerPath, 'Catalog Workspace marker'),
  );
  return { markerPath, workspaceIdentity: marker.workspaceIdentity };
}

async function readRegularJson(filePath: string, label: string): Promise<unknown> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic-link file: ${filePath}`);
  }
  return fs.readJson(filePath);
}

export async function initializeCatalogWorkspace(
  options: CatalogWorkspaceInitOptions,
): Promise<{
  workspaceRoot: string;
  markerPath: string;
  workspaceIdentity: string;
  metadataPath: string;
  metadata: MarketplaceSourceMeta;
}> {
  const workspaceRoot = await assertDirectoryWithoutSymlinks(options.workspaceRoot, 'Catalog Workspace root');
  const pluginsRoot = path.join(workspaceRoot, 'plugins');
  const metadataPath = path.join(workspaceRoot, MARKETPLACE_SOURCE_PATH);
  const markerPath = path.join(workspaceRoot, CATALOG_WORKSPACE_MARKER_FILENAME);
  const metadata = catalogWorkspaceMetadata(options, workspaceRoot);
  const existingMetadata = await fs.pathExists(metadataPath);
  const existingMarker = await fs.pathExists(markerPath);
  if ((existingMetadata || existingMarker) && !options.force) {
    throw new Error(`Catalog Workspace scaffold already exists: ${workspaceRoot}`);
  }
  if (existingMetadata && !existingMarker) {
    throw new Error(`Refusing to adopt Catalog Workspace metadata without a valid marker: ${metadataPath}`);
  }
  if (await fs.pathExists(pluginsRoot)) {
    const stat = await fs.lstat(pluginsRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Catalog Workspace plugins path must be a regular directory: ${pluginsRoot}`);
    }
    const entries = (await fs.readdir(pluginsRoot)).filter((entry) => entry !== path.basename(metadataPath));
    if (entries.length > 0 && !existingMarker) {
      throw new Error(`Refusing to initialize over a non-managed plugins directory: ${pluginsRoot}`);
    }
  }
  if (existingMetadata) {
    const current = await readMarketplaceSourceMeta(workspaceRoot);
    if (!isDeepStrictEqual(current, metadata)) {
      throw new Error(`Refusing to replace different Catalog Workspace metadata: ${metadataPath}`);
    }
  }
  const expectedMarker = catalogWorkspaceMarker();
  let workspaceIdentity = expectedMarker.workspaceIdentity;
  if (existingMarker) {
    const currentMarker = await readRegularJson(markerPath, 'Catalog Workspace marker');
    try {
      workspaceIdentity = validateCatalogWorkspaceMarker(currentMarker).workspaceIdentity;
    } catch {
      throw new Error(`Refusing to replace a Catalog Workspace marker with a different identity: ${workspaceRoot}`);
    }
  }
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  const gitignoreExists = await fs.pathExists(gitignorePath);
  let previousGitignore: string | null = null;
  if (gitignoreExists) {
    const stat = await fs.lstat(gitignorePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Catalog Workspace .gitignore must be a regular file: ${gitignorePath}`);
    }
    previousGitignore = await fs.readFile(gitignorePath, 'utf8');
  }
  await fs.ensureDir(pluginsRoot);
  try {
    if (previousGitignore === null) {
      await fs.writeFile(gitignorePath, '.aw/\n', { flag: 'wx' });
    } else if (!previousGitignore.split(/\r?\n/u).includes('.aw/')) {
      const separator = previousGitignore.length === 0 || previousGitignore.endsWith('\n') ? '' : '\n';
      await writeTextAtomic(gitignorePath, `${previousGitignore}${separator}.aw/\n`);
    }
    if (!existingMetadata) await writeJsonAtomic(metadataPath, metadata);
    if (!existingMarker) await writeJsonAtomic(markerPath, expectedMarker);
  } catch (error) {
    if (!existingMetadata) await fs.remove(metadataPath);
    if (!existingMarker) await fs.remove(markerPath);
    if (previousGitignore === null) await fs.remove(gitignorePath);
    else await writeTextAtomic(gitignorePath, previousGitignore);
    if ((await fs.readdir(pluginsRoot)).length === 0) await fs.remove(pluginsRoot);
    throw error;
  }
  return { workspaceRoot, markerPath, workspaceIdentity, metadataPath, metadata };
}

export async function readCatalogWorkspace(
  workspaceRoot: string,
  options: CatalogWorkspaceSourceOptions = {},
): Promise<CatalogWorkspace> {
  const root = await assertDirectoryWithoutSymlinks(workspaceRoot, 'Catalog Workspace root');
  const marker = await readCatalogWorkspaceMarker(root);
  const metadataPath = path.join(root, MARKETPLACE_SOURCE_PATH);
  await readRegularJson(metadataPath, 'Catalog Workspace metadata');
  if (!isInside(root, await fs.realpath(metadataPath))) throw new Error('Catalog Workspace metadata resolves outside the workspace.');
  const metadata = await readMarketplaceSourceMeta(root);
  const pluginsRoot = await assertDirectoryWithoutSymlinks(path.join(root, 'plugins'), 'Catalog Workspace plugins directory');
  if (!isInside(root, pluginsRoot)) throw new Error('Catalog Workspace plugins directory resolves outside the workspace.');
  const plugins: PluginMeta[] = [];
  for (const entry of (await fs.readdir(pluginsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === path.basename(metadataPath) || !entry.isDirectory()) {
      if (entry.isSymbolicLink()) throw new Error(`Catalog Workspace plugin source must not be a symbolic link: ${entry.name}`);
      continue;
    }
    const pluginRoot = path.join(pluginsRoot, entry.name);
    const pluginStat = await fs.lstat(pluginRoot);
    if (!pluginStat.isDirectory() || pluginStat.isSymbolicLink() || !isInside(root, await fs.realpath(pluginRoot))) {
      throw new Error(`Catalog Workspace plugin source must be a regular in-workspace directory: ${pluginRoot}`);
    }
    const manifestDir = path.join(pluginRoot, path.dirname(SOURCE_MANIFEST_PATH));
    const manifestPath = path.join(pluginRoot, SOURCE_MANIFEST_PATH);
    await assertDirectoryWithoutSymlinks(manifestDir, 'Plugin manifest directory');
    await readRegularJson(manifestPath, 'Plugin manifest');
    if (!isInside(root, await fs.realpath(manifestPath))) throw new Error(`Plugin manifest resolves outside the Catalog Workspace: ${manifestPath}`);
    const plugin = await readPluginManifest(pluginRoot, { mode: 'source', reservedImports: options.reservedImports });
    if (plugin.manifest.name !== entry.name) {
      throw new Error(`Plugin directory name ${JSON.stringify(entry.name)} must match manifest name ${JSON.stringify(plugin.manifest.name)}.`);
    }
    plugins.push(plugin);
  }
  return {
    workspaceRoot: root,
    markerPath: marker.markerPath,
    workspaceIdentity: marker.workspaceIdentity,
    metadataPath,
    metadata,
    plugins,
  };
}

export function resolveCatalogVersionMutation(
  currentVersion: string,
  mutation: CatalogVersionMutation,
): string {
  const current = assertCatalogVersion(currentVersion, 'current catalog version');
  const hasVersion = mutation.version !== undefined;
  const hasBump = mutation.bump !== undefined;
  if (hasVersion === hasBump) {
    throw new Error('Catalog version mutation requires exactly one of version or bump.');
  }
  if (mutation.version !== undefined) {
    return assertCatalogVersion(mutation.version, 'catalog version');
  }
  if (!['major', 'minor', 'patch'].includes(mutation.bump!)) {
    throw new Error('Catalog version bump must be major, minor, or patch.');
  }
  const [major, minor, patch] = current.split('-', 1)[0]!.split('.').map(BigInt);
  if (mutation.bump === 'major') return `${major + 1n}.0.0`;
  if (mutation.bump === 'minor') return `${major}.${minor + 1n}.0`;
  return `${major}.${minor}.${patch + 1n}`;
}

export async function mutateCatalogWorkspaceVersion(
  workspaceRoot: string,
  mutation: CatalogVersionMutation,
  options: CatalogWorkspaceSourceOptions = {},
): Promise<MarketplaceSourceMeta> {
  const current = await readCatalogWorkspace(workspaceRoot, options);
  const version = resolveCatalogVersionMutation(current.metadata.catalog.version, mutation);
  if (version === current.metadata.catalog.version) return current.metadata;
  const metadata = {
    ...current.metadata,
    catalog: {
      version,
    },
  };
  await writeJsonAtomic(current.metadataPath, metadata);
  return metadata;
}

export function deriveCatalogChannel(version: string): CatalogChannel {
  const parsed = assertCatalogVersion(version, 'catalog version');
  return parsed.includes('-') ? 'beta' : 'latest';
}

async function replaceGeneratedOutput(options: {
  outputRoot: string;
  force: boolean;
  build: (stagingRoot: string) => Promise<void>;
  validate: (stagingRoot: string) => Promise<void>;
  assertReplaceable?: (existingRoot: string) => Promise<void>;
}): Promise<void> {
  const parent = path.dirname(options.outputRoot);
  await fs.ensureDir(parent);
  const stagingRoot = path.join(parent, `.${path.basename(options.outputRoot)}.aw-staging-${crypto.randomUUID()}`);
  const backupRoot = path.join(parent, `.${path.basename(options.outputRoot)}.aw-backup-${crypto.randomUUID()}`);
  const exists = await fs.pathExists(options.outputRoot);
  if (exists && !options.force) throw new Error(`Output already exists: ${options.outputRoot}`);
  if (exists && options.assertReplaceable) await options.assertReplaceable(options.outputRoot);
  await fs.ensureDir(stagingRoot);
  try {
    await options.build(stagingRoot);
    await options.validate(stagingRoot);
    if (exists) await fs.rename(options.outputRoot, backupRoot);
    try {
      await fs.rename(stagingRoot, options.outputRoot);
    } catch (error) {
      if (exists) await fs.rename(backupRoot, options.outputRoot);
      throw error;
    }
    if (exists) await fs.remove(backupRoot);
  } catch (error) {
    await fs.remove(stagingRoot);
    throw error;
  }
}

function assertDependencyGraph(plugins: readonly PluginMeta[]): void {
  const byName = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`Plugin dependency cycle includes ${JSON.stringify(name)}.`);
    if (visited.has(name)) return;
    const plugin = byName.get(name);
    if (!plugin) throw new Error(`Missing same-source plugin dependency ${JSON.stringify(name)}.`);
    visiting.add(name);
    for (const dependency of plugin.manifest.dependencies ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const plugin of plugins) visit(plugin.manifest.name);
}

function orderPlugins(plugins: readonly PluginMeta[]): PluginMeta[] {
  assertDependencyGraph(plugins);
  const result: PluginMeta[] = [];
  const seen = new Set<string>();
  const byName = new Map(plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const visit = (plugin: PluginMeta): void => {
    if (seen.has(plugin.manifest.name)) return;
    for (const name of [...(plugin.manifest.dependencies ?? [])].sort()) visit(byName.get(name)!);
    seen.add(plugin.manifest.name);
    result.push(plugin);
  };
  for (const plugin of [...plugins].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))) visit(plugin);
  return result;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function publishedContentDigest(
  manifest: Pick<CatalogManifestV5, 'schemaVersion' | 'requires' | 'marketplace' | 'entries'>,
): string {
  return sha256(stableStringify({
    schemaIdentity: { schemaVersion: manifest.schemaVersion },
    marketplaceMetadata: {
      name: 'aw',
      owner: manifest.marketplace.owner,
      interface: manifest.marketplace.interface,
    },
    requires: manifest.requires,
    plugins: manifest.entries.map((entry) => ({
      name: entry.name,
      targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
      contentDigest: entry.contentDigest,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  }));
}

const SOURCE_IDENTITY_EXCLUDED_DIRECTORIES = new Set([
  '.git', '.aw', 'node_modules', 'evals', 'reports',
]);
const SOURCE_IDENTITY_EXCLUDED_FILES = new Set([
  '.DS_Store', 'AGENTS.md', 'CLAUDE.md',
]);

async function sourceIdentityRecords(root: string, relative = ''): Promise<string[]> {
  const records: string[] = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (SOURCE_IDENTITY_EXCLUDED_DIRECTORIES.has(entry.name) || SOURCE_IDENTITY_EXCLUDED_FILES.has(entry.name)) {
      continue;
    }
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const filePath = path.join(root, child);
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Catalog source identity does not accept symbolic links: ${filePath}`);
    if (stat.isDirectory()) records.push(...await sourceIdentityRecords(root, child));
    else if (stat.isFile()) {
      const mode = (stat.mode & 0o111) === 0 ? '100644' : '100755';
      records.push(`${child}\0${mode}\0${sha256(await fs.readFile(filePath))}`);
    } else {
      throw new Error(`Catalog source identity only accepts regular files and directories: ${filePath}`);
    }
  }
  return records;
}

export async function calculateCatalogWorkspaceSourceIdentity(
  workspace: Pick<CatalogWorkspace, 'workspaceRoot' | 'metadataPath' | 'plugins'>,
): Promise<string> {
  const roots = [workspace.metadataPath, ...workspace.plugins.map((plugin) => plugin.rootDir)];
  const records: string[] = [];
  for (const sourceRoot of roots.sort((left, right) => left.localeCompare(right))) {
    const relativeRoot = path.relative(workspace.workspaceRoot, sourceRoot).split(path.sep).join('/');
    const stat = await fs.lstat(sourceRoot);
    if (stat.isSymbolicLink()) throw new Error(`Catalog source identity does not accept symbolic links: ${sourceRoot}`);
    if (stat.isFile()) {
      const mode = (stat.mode & 0o111) === 0 ? '100644' : '100755';
      records.push(`${relativeRoot}\0${mode}\0${sha256(await fs.readFile(sourceRoot))}`);
    } else if (stat.isDirectory()) {
      for (const record of await sourceIdentityRecords(sourceRoot)) records.push(`${relativeRoot}/${record}`);
    }
  }
  return sha256(records.sort().join('\n'));
}

function generatedOutputMarker(options: {
  kind: 'catalog' | 'plugin';
  workspaceIdentity: string;
  sourceIdentity: string;
  sourceName?: string;
}) {
  return {
    schemaVersion: 1,
    kind: options.kind,
    workspaceIdentity: options.workspaceIdentity,
    sourceIdentity: options.sourceIdentity,
    ...(options.sourceName ? { sourceName: options.sourceName } : {}),
  };
}

async function listBundleFiles(root: string, relative = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...await listBundleFiles(root, child));
    else result.push(child);
  }
  return result.sort();
}

async function catalogPathRecord(root: string, relative: string, versionNeutral: boolean): Promise<{
  path: string;
  kind: 'file' | 'symlink';
  mode: '100644' | '100755' | '120000';
  digest: string;
}> {
  const filePath = path.join(root, ...relative.split('/'));
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    return { path: relative, kind: 'symlink', mode: '120000', digest: sha256(await fs.readlink(filePath)) };
  }
  if (!stat.isFile()) throw new Error(`Catalog digest path must be a regular file or symlink: ${filePath}.`);
  const manifests = new Set(['.agents-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']);
  let digest: string;
  if (versionNeutral && manifests.has(relative)) {
    digest = sha256(stableStringify({
      ...(await fs.readJson(filePath) as Record<string, unknown>),
      version: '<plugin-version>',
    }));
  } else if (versionNeutral && path.posix.basename(relative) === AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME) {
    const receipt = await fs.readJson(filePath) as Record<string, unknown>;
    const plugin = receipt.plugin && typeof receipt.plugin === 'object' && !Array.isArray(receipt.plugin)
      ? receipt.plugin as Record<string, unknown>
      : {};
    digest = sha256(stableStringify({
      ...receipt,
      plugin: { ...plugin, version: '<plugin-version>' },
    }));
  } else {
    digest = sha256(await fs.readFile(filePath));
  }
  return { path: relative, kind: 'file', mode: (stat.mode & 0o100) === 0 ? '100644' : '100755', digest };
}

async function calculateEntryDigest(root: string, versionNeutral: boolean): Promise<string> {
  const files = await listBundleFiles(root);
  return sha256(stableStringify(await Promise.all(files.map((file) => catalogPathRecord(root, file, versionNeutral)))));
}

async function expectedCatalogEntry(plugin: PluginMeta, pluginRoot: string) {
  const bundleManifest = await readRegularJson(
    path.join(pluginRoot, SOURCE_MANIFEST_PATH),
    `Catalog plugin ${JSON.stringify(plugin.manifest.name)} bundle manifest`,
  );
  return {
    ...createMarketplaceManifestEntry(plugin),
    version: plugin.manifest.version,
    dependencies: [...(plugin.manifest.dependencies ?? [])].sort(),
    requires: {
      aw: {
        capabilities: normalizeAwCapabilities(plugin.manifest.requires?.aw.capabilities ?? []),
      },
    },
    artifactDigest: await calculateEntryDigest(pluginRoot, false),
    manifestDigest: sha256(normalizeManifestDigestInput(bundleManifest as PluginMeta['manifest'])),
    contentDigest: await calculateEntryDigest(pluginRoot, true),
  };
}

async function validateBundleRuntimeRequirementsReceipts(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<void> {
  const files = await listBundleFiles(pluginRoot);
  const expectedReceiptPaths = new Set(files.flatMap((relative) =>
    /^(?:claude|codex|agent-skills)\/skills\/[^/]+\/SKILL\.md$/u.test(relative)
      ? [path.posix.join(path.posix.dirname(relative), AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME)]
      : []));
  const actualReceiptPaths = files.filter((relative) =>
    path.posix.basename(relative) === AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME);
  for (const relative of expectedReceiptPaths) {
    if (!actualReceiptPaths.includes(relative)) {
      throw new Error(
        `Catalog plugin ${JSON.stringify(plugin.manifest.name)} Skill root is missing ${AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME}: ${relative}.`,
      );
    }
  }
  const expected = createAwPluginRequirementsReceipt(
    { name: plugin.manifest.name, version: plugin.manifest.version },
    plugin.manifest.requires?.aw.capabilities ?? [],
  );
  for (const relative of actualReceiptPaths) {
    if (!expectedReceiptPaths.has(relative)) {
      throw new Error(
        `Catalog plugin ${JSON.stringify(plugin.manifest.name)} has a reserved runtime requirements receipt outside a Skill root: ${relative}.`,
      );
    }
    const receipt = parseAwPluginRequirementsReceipt(await readRegularJson(
      path.join(pluginRoot, ...relative.split('/')),
      `Catalog plugin ${JSON.stringify(plugin.manifest.name)} runtime requirements receipt`,
    ));
    if (!isDeepStrictEqual(receipt, expected)) {
      throw new Error(
        `Catalog plugin ${JSON.stringify(plugin.manifest.name)} has a mismatched runtime requirements receipt: ${relative}.`,
      );
    }
  }
}

function normalizeCatalogRelease(
  raw: unknown,
  catalogVersion: string,
): CatalogManifestV5['release'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid catalog manifest release: expected an object.');
  }
  const release = raw as Record<string, unknown>;
  if (release.state === 'development') {
    if (Object.keys(release).join('\0') !== 'state') {
      throw new Error('Invalid development catalog release: unknown field.');
    }
    return { state: 'development' };
  }
  const allowed = new Set(['state', 'targetVersion', 'planId', 'sourceHead', 'contentDigest']);
  if (release.state !== 'published' || Object.keys(release).some((key) => !allowed.has(key))) {
    throw new Error('Invalid published catalog release.');
  }
  const targetVersion = assertStrictSemVer(release.targetVersion, 'catalog release targetVersion');
  if (targetVersion.includes('-') || targetVersion.includes('+')) {
    throw new Error('Invalid catalog release targetVersion: expected a stable version.');
  }
  if (targetVersion !== catalogVersion.replace(/-beta\.[1-9]\d*$/u, '')) {
    throw new Error('Invalid catalog release targetVersion: must match catalogVersion.');
  }
  const digestPattern = /^sha256:[0-9a-f]{64}$/u;
  if (typeof release.planId !== 'string' || !digestPattern.test(release.planId)) {
    throw new Error('Invalid catalog release planId.');
  }
  if (typeof release.contentDigest !== 'string' || !digestPattern.test(release.contentDigest)) {
    throw new Error('Invalid catalog release contentDigest.');
  }
  if (typeof release.sourceHead !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(release.sourceHead)) {
    throw new Error('Invalid catalog release sourceHead.');
  }
  return {
    state: 'published',
    targetVersion,
    planId: release.planId,
    sourceHead: release.sourceHead,
    contentDigest: release.contentDigest,
  };
}

export async function buildCatalogWorkspace(options: {
  workspaceRoot: string;
  outputPath?: string;
  force?: boolean;
  adapter: CatalogWorkspaceBuildAdapter;
  reservedImports?: ReservedImportRegistry;
}): Promise<{ outputRoot: string; catalogVersion: string; channel: CatalogChannel; pluginNames: string[] }> {
  const catalogWorkspace = await readCatalogWorkspace(options.workspaceRoot, { reservedImports: options.reservedImports });
  const plugins = orderPlugins(catalogWorkspace.plugins);
  const resolved = await resolveCatalogWorkspaceOutputPath({
    workspaceRoot: catalogWorkspace.workspaceRoot,
    outputPath: options.outputPath ?? DEFAULT_CATALOG_OUTPUT_PATH,
    kind: 'catalog',
  });
  const catalogVersion = catalogWorkspace.metadata.catalog.version;
  const channel = deriveCatalogChannel(catalogVersion);
  const pluginNames = plugins.map((plugin) => plugin.manifest.name).sort();
  const identity = await calculateCatalogWorkspaceSourceIdentity(catalogWorkspace);
  const marker = generatedOutputMarker({
    kind: 'catalog',
    workspaceIdentity: catalogWorkspace.workspaceIdentity,
    sourceIdentity: identity,
  });
  await replaceGeneratedOutput({
    outputRoot: resolved.outputRoot,
    force: options.force === true,
    build: async (stagingRoot) => {
      const bundledPlugins: PluginMeta[] = [];
      for (const plugin of plugins) {
        const closure = dependencyClosure(plugin, plugins);
        const outputRoot = path.join(stagingRoot, 'plugins', plugin.manifest.name);
        await fs.ensureDir(outputRoot);
        await options.adapter.build({
          workspaceRoot: catalogWorkspace.workspaceRoot,
          plugin,
          plugins,
          dependencies: closure.slice(0, -1),
          outputRoot,
        });
        bundledPlugins.push(await readPluginManifest(outputRoot, { mode: 'bundle' }));
      }
      const byPlatform = (platform: 'claude' | 'codex'): PluginMeta[] => bundledPlugins
        .filter((plugin) => resolveSupportedPlatforms(plugin.manifest).has(platform))
        .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
      await fs.outputJson(
        path.join(stagingRoot, '.agents', 'plugins', 'marketplace.json'),
        createMarketplaceManifest(catalogWorkspace.metadata, byPlatform('codex')),
        { spaces: 2 },
      );
      await fs.outputJson(
        path.join(stagingRoot, '.claude-plugin', 'marketplace.json'),
        createMarketplaceManifest(catalogWorkspace.metadata, byPlatform('claude')),
        { spaces: 2 },
      );
      const entries = await Promise.all(
        [...bundledPlugins]
          .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
          .map((plugin) => expectedCatalogEntry(plugin, plugin.rootDir)),
      );
      const manifest: CatalogManifestV5 = {
        schemaVersion: 5,
        catalogVersion,
        channel,
        requires: { aw: { capabilities: ['aw.catalog-snapshot.v5'] } },
        marketplace: {
          owner: catalogWorkspace.metadata.owner,
          interface: catalogWorkspace.metadata.interface,
        },
        release: { state: 'development' },
        entries,
      };
      await fs.writeJson(path.join(stagingRoot, CATALOG_MANIFEST_FILENAME), manifest, { spaces: 2 });
      await fs.writeJson(path.join(stagingRoot, GENERATED_OUTPUT_MARKER_FILENAME), marker, { spaces: 2 });
    },
    validate: async (stagingRoot) => { await validateCatalogSnapshotComplete(stagingRoot); },
    assertReplaceable: async (existingRoot) => {
      await validateCatalogSnapshotComplete(existingRoot);
      await assertGeneratedOutput(existingRoot, marker);
    },
  });
  return { outputRoot: resolved.outputRoot, catalogVersion, channel, pluginNames };
}

async function rewritePublishedPluginVersions(
  snapshotRoot: string,
  overrides: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [pluginName, version] of Object.entries(overrides)) {
    assertStrictSemVer(version, `${pluginName} published version`);
    for (const relative of [
      '.agents-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ]) {
      const manifestPath = path.join(snapshotRoot, 'plugins', pluginName, relative);
      if (!(await fs.pathExists(manifestPath))) continue;
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    }
    const pluginRoot = path.join(snapshotRoot, 'plugins', pluginName);
    for (const relative of await listBundleFiles(pluginRoot)) {
      if (path.posix.basename(relative) !== AW_PLUGIN_REQUIREMENTS_RECEIPT_FILENAME) continue;
      const receiptPath = path.join(pluginRoot, ...relative.split('/'));
      const receipt = parseAwPluginRequirementsReceipt(await fs.readJson(receiptPath));
      if (receipt.plugin.name !== pluginName) {
        throw new Error(`Catalog plugin ${JSON.stringify(pluginName)} has a mismatched runtime requirements receipt.`);
      }
      await fs.writeFile(receiptPath, `${JSON.stringify(createAwPluginRequirementsReceipt(
        { name: pluginName, version },
        receipt.requiredCapabilities,
      ), null, 2)}\n`);
    }
  }
}

export async function validatePublishedCatalogSnapshot(snapshotDirectory: string): Promise<{
  rootDir: string;
  manifest: CatalogManifestV5;
  ledger: PluginReleaseLedger;
  snapshotDigest: string;
}> {
  const validation = await validateCatalogSnapshotComplete(snapshotDirectory);
  if (validation.manifest.release.state !== 'published') {
    throw new Error('Published Catalog snapshot must have release.state published.');
  }
  if (!validation.ledger) throw new Error('Published Catalog snapshot must include a plugin release ledger.');
  return { ...validation, ledger: validation.ledger };
}

export async function preparePublishedCatalogWorkspace(options: {
  workspaceRoot: string;
  sourceHead: string;
  outputPath?: string;
  previousSnapshotRoot?: string;
  adapter: CatalogWorkspaceBuildAdapter;
  reservedImports?: ReservedImportRegistry;
}): Promise<{
  outputRoot: string;
  catalogVersion: string;
  channel: CatalogChannel;
  pluginNames: string[];
  snapshotDigest: string;
  contentDigest: string;
  planId: string;
}> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(options.sourceHead)) {
    throw new Error('Published Catalog sourceHead must be a committed Git object ID.');
  }
  const catalogWorkspace = await readCatalogWorkspace(options.workspaceRoot, { reservedImports: options.reservedImports });
  for (const plugin of catalogWorkspace.plugins) {
    assertStablePluginVersion(plugin.manifest.version, `${plugin.manifest.name} source version`);
  }
  const catalogVersion = catalogWorkspace.metadata.catalog.version;
  const channel = deriveCatalogChannel(catalogVersion);
  const previous = options.previousSnapshotRoot
    ? await validatePublishedCatalogSnapshot(options.previousSnapshotRoot)
    : null;
  if (previous && compareStrictSemVer(catalogVersion, previous.manifest.catalogVersion) <= 0) {
    throw new Error(
      `Catalog version ${catalogVersion} must be higher than published ${previous.manifest.catalogVersion}.`,
    );
  }
  const previousLedger = previous?.ledger ?? {
    schemaVersion: PLUGIN_RELEASE_LEDGER_SCHEMA_VERSION,
    records: [],
  } satisfies PluginReleaseLedger;
  const temporaryRelative = path.join('.aw', 'publish', `.catalog-preparation-${crypto.randomUUID()}`);
  const finalRelative = options.outputPath
    ?? `${DEFAULT_PUBLISHED_CATALOG_OUTPUT_PATH}-v${catalogVersion}`;
  let temporaryRoot = path.resolve(catalogWorkspace.workspaceRoot, temporaryRelative);
  try {
    const built = await buildCatalogWorkspace({
      workspaceRoot: catalogWorkspace.workspaceRoot,
      outputPath: temporaryRelative,
      adapter: options.adapter,
      reservedImports: options.reservedImports,
    });
    temporaryRoot = built.outputRoot;
    const development = await validateCatalogSnapshotComplete(temporaryRoot);
    const contentDigests = new Map(development.manifest.entries.map((entry) => [entry.name, entry.contentDigest]));
    const overrides = channel === 'beta'
      ? resolveBetaPluginVersionOverrides({
          plugins: catalogWorkspace.plugins,
          contentDigests,
          ledger: previousLedger,
        })
      : Object.fromEntries(catalogWorkspace.plugins.map((plugin) => [plugin.manifest.name, plugin.manifest.version]));
    await rewritePublishedPluginVersions(temporaryRoot, overrides);
    const bundledPlugins = await Promise.all(
      catalogWorkspace.plugins.map((plugin) => readPluginManifest(
        path.join(temporaryRoot, 'plugins', plugin.manifest.name),
        { mode: 'bundle' },
      )),
    );
    const entries = await Promise.all(
      bundledPlugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
        .map((plugin) => expectedCatalogEntry(plugin, plugin.rootDir)),
    );
    const manifestWithoutRelease = {
      ...development.manifest,
      catalogVersion,
      channel,
      entries,
    };
    const contentDigest = publishedContentDigest(manifestWithoutRelease);
    const manifest: CatalogManifestV5 = {
      ...manifestWithoutRelease,
      release: {
        state: 'published',
        targetVersion: catalogVersion.replace(/-beta\.[1-9]\d*$/u, ''),
        planId: contentDigest,
        sourceHead: options.sourceHead,
        contentDigest,
      },
    };
    const ledger = appendCatalogToPluginReleaseLedger({
      previous: previousLedger,
      manifest,
      contentDigests,
    });
    await Promise.all([
      fs.writeFile(path.join(temporaryRoot, CATALOG_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`),
      fs.writeFile(path.join(temporaryRoot, PLUGIN_RELEASE_LEDGER_FILENAME), `${JSON.stringify(ledger, null, 2)}\n`),
    ]);
    const prepared = await validatePublishedCatalogSnapshot(temporaryRoot);
    const resolved = await resolveCatalogWorkspaceOutputPath({
      workspaceRoot: catalogWorkspace.workspaceRoot,
      outputPath: finalRelative,
      kind: 'catalog',
    });
    const marker = await fs.readJson(path.join(temporaryRoot, GENERATED_OUTPUT_MARKER_FILENAME)) as Record<string, unknown>;
    await replaceGeneratedOutput({
      outputRoot: resolved.outputRoot,
      force: true,
      build: (stagingRoot) => fs.copy(temporaryRoot, stagingRoot, { dereference: false }),
      validate: async (stagingRoot) => { await validatePublishedCatalogSnapshot(stagingRoot); },
      assertReplaceable: async (existingRoot) => {
        await validatePublishedCatalogSnapshot(existingRoot);
        await assertGeneratedOutput(existingRoot, marker);
      },
    });
    return {
      outputRoot: resolved.outputRoot,
      catalogVersion,
      channel,
      pluginNames: built.pluginNames,
      snapshotDigest: prepared.snapshotDigest,
      contentDigest,
      planId: contentDigest,
    };
  } finally {
    await fs.remove(temporaryRoot);
  }
}

function dependencyClosure(plugin: PluginMeta, all: readonly PluginMeta[]): PluginMeta[] {
  const byName = new Map(all.map((entry) => [entry.manifest.name, entry]));
  const result: PluginMeta[] = [];
  const visited = new Set<string>();
  const visit = (entry: PluginMeta): void => {
    if (visited.has(entry.manifest.name)) return;
    for (const name of [...(entry.manifest.dependencies ?? [])].sort()) {
      const dependency = byName.get(name);
      if (!dependency) throw new Error(`Missing same-source plugin dependency ${JSON.stringify(name)}.`);
      visit(dependency);
    }
    visited.add(entry.manifest.name);
    result.push(entry);
  };
  visit(plugin);
  return result;
}

export async function buildCatalogWorkspacePlugin(options: {
  workspaceRoot: string;
  pluginDirectory: string;
  outputPath?: string;
  force?: boolean;
  adapter: CatalogWorkspacePluginBuildAdapter;
  reservedImports?: ReservedImportRegistry;
}): Promise<{ outputRoot: string; pluginName: string; dependencies: string[]; digest: string }> {
  const catalogWorkspace = await readCatalogWorkspace(options.workspaceRoot, { reservedImports: options.reservedImports });
  assertDependencyGraph(catalogWorkspace.plugins);
  const requestedPluginRoot = path.resolve(catalogWorkspace.workspaceRoot, options.pluginDirectory);
  const pluginRoot = await fs.realpath(requestedPluginRoot);
  if (!isInside(catalogWorkspace.workspaceRoot, pluginRoot)) throw new Error('Plugin directory must stay inside the Catalog Workspace.');
  const plugin = catalogWorkspace.plugins.find((entry) => entry.rootDir === pluginRoot);
  if (!plugin) {
    throw new Error(`Plugin directory is not part of this Catalog Workspace source: ${pluginRoot}`);
  }
  const closure = dependencyClosure(plugin, catalogWorkspace.plugins);
  const identity = sha256(normalizeManifestDigestInput(plugin.manifest));
  const marker = generatedOutputMarker({
    kind: 'plugin',
    workspaceIdentity: catalogWorkspace.workspaceIdentity,
    sourceIdentity: identity,
    sourceName: plugin.manifest.name,
  });
  const resolved = await resolveCatalogWorkspaceOutputPath({
    workspaceRoot: catalogWorkspace.workspaceRoot,
    outputPath: options.outputPath ?? path.join(DEFAULT_PLUGIN_OUTPUT_PATH, plugin.manifest.name),
    kind: 'plugin',
  });
  await replaceGeneratedOutput({
    outputRoot: resolved.outputRoot,
    force: options.force === true,
    build: (stagingRoot) => options.adapter.build({
      workspaceRoot: catalogWorkspace.workspaceRoot,
      plugin,
      plugins: catalogWorkspace.plugins,
      dependencies: closure.slice(0, -1),
      outputRoot: stagingRoot,
    }).then(() => fs.writeJson(path.join(stagingRoot, GENERATED_OUTPUT_MARKER_FILENAME), marker, { spaces: 2 })),
    validate: async (stagingRoot) => {
      await readPluginManifest(stagingRoot, { mode: 'bundle' });
      await assertGeneratedOutput(stagingRoot, marker);
    },
    assertReplaceable: async (existingRoot) => {
      await assertGeneratedOutput(existingRoot, marker);
    },
  });
  const digest = await digestDirectory(resolved.outputRoot);
  return {
    outputRoot: resolved.outputRoot,
    pluginName: plugin.manifest.name,
    dependencies: closure.slice(0, -1).map((entry) => entry.manifest.name),
    digest,
  };
}

async function assertGeneratedOutput(root: string, expected: Record<string, unknown>): Promise<void> {
  const markerPath = path.join(root, GENERATED_OUTPUT_MARKER_FILENAME);
  const stat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to replace foreign plugin output: ${root}`);
  }
  const marker = await fs.readJson(markerPath) as Record<string, unknown>;
  const expectedKeys = expected.sourceName === undefined
    ? ['kind', 'schemaVersion', 'sourceIdentity', 'workspaceIdentity']
    : ['kind', 'schemaVersion', 'sourceIdentity', 'sourceName', 'workspaceIdentity'];
  const digestPattern = /^sha256:[0-9a-f]{64}$/u;
  if (
    !isDeepStrictEqual(Object.keys(marker).sort(), expectedKeys)
    || marker.schemaVersion !== 1
    || typeof marker.workspaceIdentity !== 'string'
    || marker.workspaceIdentity.trim().length === 0
    || typeof marker.sourceIdentity !== 'string'
    || !digestPattern.test(marker.sourceIdentity)
  ) {
    throw new Error(`Refusing to replace foreign plugin output: ${root}`);
  }
  const ownershipFields = ['schemaVersion', 'kind', 'workspaceIdentity', 'sourceName'] as const;
  if (ownershipFields.some((field) => marker[field] !== expected[field])) {
    throw new Error(`Refusing to replace plugin output with a different identity: ${root}`);
  }
}

async function digestDirectory(root: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const filePath = path.join(directory, name);
      const relative = path.relative(root, filePath).split(path.sep).join('/');
      if (relative === GENERATED_OUTPUT_MARKER_FILENAME) continue;
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) throw new Error(`Generated output contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) await walk(filePath);
      else if (stat.isFile()) entries.push(`${relative}\0${crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')}`);
      else throw new Error(`Generated output contains an unsupported entry: ${relative}`);
    }
  };
  await walk(root);
  return `sha256:${crypto.createHash('sha256').update(entries.join('\n')).digest('hex')}`;
}

export async function validateCatalogSnapshotTransport(snapshotDirectory: string): Promise<{
  rootDir: string;
  manifest: CatalogManifestV5;
  ledger?: PluginReleaseLedger;
  snapshotDigest: string;
}> {
  const rootDir = await assertDirectoryWithoutSymlinks(snapshotDirectory, 'Catalog snapshot');
  const allowed = new Set([
    CATALOG_MANIFEST_FILENAME,
    GENERATED_OUTPUT_MARKER_FILENAME,
    '.agents',
    '.claude-plugin',
    'plugins',
    'plugin-release-ledger.json',
  ]);
  const entries = await fs.readdir(rootDir);
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  const required = [CATALOG_MANIFEST_FILENAME, '.agents', '.claude-plugin', 'plugins'];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(`Invalid catalog snapshot root layout: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}].`);
  }
  if (entries.includes(GENERATED_OUTPUT_MARKER_FILENAME)) {
    const marker = await readRegularJson(
      path.join(rootDir, GENERATED_OUTPUT_MARKER_FILENAME),
      'Catalog generated output marker',
    ) as Record<string, unknown>;
    const digestPattern = /^sha256:[0-9a-f]{64}$/u;
    if (
      !isDeepStrictEqual(Object.keys(marker).sort(), [
        'kind', 'schemaVersion', 'sourceIdentity', 'workspaceIdentity',
      ])
      || marker.schemaVersion !== 1
      || marker.kind !== 'catalog'
      || typeof marker.workspaceIdentity !== 'string'
      || marker.workspaceIdentity.trim().length === 0
      || typeof marker.sourceIdentity !== 'string'
      || !digestPattern.test(marker.sourceIdentity)
    ) {
      throw new Error('Invalid catalog generated output marker.');
    }
  }
  const assertLayout = async (directory: string, expected: readonly string[]): Promise<void> => {
    const real = await assertDirectoryWithoutSymlinks(directory, 'Catalog snapshot directory');
    if (!isInside(rootDir, real)) throw new Error(`Catalog snapshot directory resolves outside the snapshot: ${directory}`);
    const actual = (await fs.readdir(directory)).sort();
    const wanted = [...expected].sort();
    if (!isDeepStrictEqual(actual, wanted)) {
      throw new Error(`Invalid catalog snapshot directory layout at ${directory}.`);
    }
  };
  await assertLayout(path.join(rootDir, '.agents'), ['plugins']);
  await assertLayout(path.join(rootDir, '.agents', 'plugins'), ['marketplace.json']);
  await assertLayout(path.join(rootDir, '.claude-plugin'), ['marketplace.json']);
  await readRegularJson(path.join(rootDir, '.agents', 'plugins', 'marketplace.json'), 'Codex marketplace');
  await readRegularJson(path.join(rootDir, '.claude-plugin', 'marketplace.json'), 'Claude marketplace');
  const snapshotDigest = await digestDirectory(rootDir);
  const raw = await fs.readJson(path.join(rootDir, CATALOG_MANIFEST_FILENAME)) as Record<string, unknown>;
  const allowedManifestKeys = new Set([
    'schemaVersion', 'catalogVersion', 'channel', 'requires', 'marketplace', 'release', 'entries',
  ]);
  for (const key of Object.keys(raw)) if (!allowedManifestKeys.has(key)) throw new Error(`Invalid catalog manifest: unknown field ${JSON.stringify(key)}.`);
  if (raw.schemaVersion !== 5) throw new Error('Invalid catalog manifest schemaVersion: expected 5.');
  const base = normalizeCatalogManifestBase(raw, 'catalog manifest v5');
  if (!(base.requires.aw.capabilities ?? []).includes('aw.catalog-snapshot.v5')) {
    throw new Error('Invalid catalog manifest requires.aw.capabilities: expected aw.catalog-snapshot.v5.');
  }
  const marketplaceIdentity = normalizeCatalogMarketplaceIdentity(raw.marketplace);
  if (!Array.isArray(raw.entries)) throw new Error('Invalid catalog manifest entries: expected an array.');
  const rawEntries = raw.entries as Array<Record<string, unknown>>;
  const contentDigests = rawEntries.map((entry, index) => {
    if (typeof entry.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(entry.contentDigest)) {
      throw new Error(`Invalid catalog manifest entries[${index}].contentDigest.`);
    }
    return entry.contentDigest;
  });
  const entriesWithoutContentDigest = rawEntries.map((entry) => {
    const copy = { ...entry };
    delete copy.contentDigest;
    return copy;
  });
  const normalizedEntries = normalizeCatalogManifestEntries(entriesWithoutContentDigest, base, 'catalog manifest v5')
    .map((entry, index) => ({ ...entry, contentDigest: contentDigests[index]! }));
  const pluginNames = normalizedEntries.map((entry, index) => {
    if (typeof entry.name !== 'string') throw new Error(`Invalid catalog manifest entries[${index}].name.`);
    return entry.name;
  });
  if (new Set(pluginNames).size !== pluginNames.length) throw new Error('Invalid catalog manifest entries: duplicate plugin name.');
  if (pluginNames.join('\0') !== [...pluginNames].sort().join('\0')) throw new Error('Invalid catalog manifest entries: expected stable name order.');
  const diskNames = (await fs.readdir(path.join(rootDir, 'plugins'))).sort();
  if (diskNames.join('\0') !== [...pluginNames].sort().join('\0')) throw new Error('Invalid catalog snapshot plugin inventory.');
  const platformEntries: Record<'claude' | 'codex', typeof normalizedEntries> = {
    claude: [],
    codex: [],
  };
  for (const [index, name] of pluginNames.entries()) {
    const pluginRoot = path.join(rootDir, 'plugins', name);
    await assertDirectoryWithoutSymlinks(pluginRoot, `Catalog plugin ${JSON.stringify(name)}`);
    const entry = normalizedEntries[index]!;
    if (entry.source !== `./plugins/${name}`) {
      throw new Error(`Catalog entry source for ${JSON.stringify(name)} does not match its plugin bundle.`);
    }
    const rawBundleManifest = await readRegularJson(
      path.join(pluginRoot, SOURCE_MANIFEST_PATH),
      `Catalog plugin ${JSON.stringify(name)} bundle manifest`,
    );
    const expectedDigests = {
      artifactDigest: await calculateEntryDigest(pluginRoot, false),
      manifestDigest: sha256(normalizeManifestDigestInput(rawBundleManifest as PluginMeta['manifest'])),
      contentDigest: await calculateEntryDigest(pluginRoot, true),
    };
    for (const field of Object.keys(expectedDigests) as Array<keyof typeof expectedDigests>) {
      if (entry[field] !== expectedDigests[field]) {
        throw new Error(`Catalog entry ${field} for ${JSON.stringify(name)} does not match its plugin bundle.`);
      }
    }
    for (const platform of ['claude', 'codex'] as const) {
      const platformManifest = path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json');
      const exists = await fs.pathExists(platformManifest);
      if (exists) {
        await readRegularJson(platformManifest, `${platform} plugin manifest`);
        platformEntries[platform].push(entry);
      }
    }
  }
  const agentsMarketplace = await fs.readJson(
    path.join(rootDir, '.agents', 'plugins', 'marketplace.json'),
  ) as MarketplaceManifest;
  const claudeMarketplace = await fs.readJson(
    path.join(rootDir, '.claude-plugin', 'marketplace.json'),
  ) as MarketplaceManifest;
  const marketplaceEntry = (entry: typeof normalizedEntries[number]): MarketplaceManifest['plugins'][number] => ({
    name: entry.name,
    source: entry.source,
    description: entry.description,
    interface: entry.interface,
    category: entry.category,
    tags: entry.tags,
    strict: entry.strict,
    policy: entry.policy,
  });
  const expectedMarketplace = (platform: 'claude' | 'codex'): MarketplaceManifest => ({
    name: 'aw',
    owner: marketplaceIdentity.owner,
    interface: marketplaceIdentity.interface,
    plugins: platformEntries[platform].map(marketplaceEntry),
  });
  const expectedAgents = expectedMarketplace('codex');
  const expectedClaude = expectedMarketplace('claude');
  const normalizeMarketplaceOrder = (marketplace: MarketplaceManifest): MarketplaceManifest => {
    const canonical = JSON.parse(JSON.stringify(marketplace)) as MarketplaceManifest;
    return {
      ...canonical,
      plugins: Array.isArray(canonical.plugins)
        ? [...canonical.plugins].sort((left, right) => String(left?.name).localeCompare(String(right?.name)))
        : canonical.plugins,
    };
  };
  if (!isDeepStrictEqual(normalizeMarketplaceOrder(agentsMarketplace), normalizeMarketplaceOrder(expectedAgents))) {
    throw new Error('Codex marketplace metadata or plugin inventory does not match the snapshot bundles.');
  }
  if (!isDeepStrictEqual(normalizeMarketplaceOrder(claudeMarketplace), normalizeMarketplaceOrder(expectedClaude))) {
    throw new Error('Claude marketplace metadata or plugin inventory does not match the snapshot bundles.');
  }
  const release = normalizeCatalogRelease(raw.release, base.catalogVersion);
  const manifest: CatalogManifestV5 = {
    schemaVersion: 5,
    catalogVersion: base.catalogVersion,
    channel: base.channel,
    requires: base.requires,
    marketplace: marketplaceIdentity,
    release,
    entries: normalizedEntries,
  };
  if (release.state === 'published') {
    const contentDigest = publishedContentDigest(manifest);
    if (release.contentDigest !== contentDigest) {
      throw new Error('Published catalog release contentDigest does not match the snapshot.');
    }
  }
  const hasLedger = entries.includes(PLUGIN_RELEASE_LEDGER_FILENAME);
  if (release.state === 'published' && !hasLedger) {
    throw new Error('Published Catalog snapshot must include plugin-release-ledger.json.');
  }
  if (release.state === 'development' && hasLedger) {
    throw new Error('Development Catalog snapshot must not include plugin-release-ledger.json.');
  }
  const ledger = hasLedger
    ? validatePluginReleaseLedgerAgainstManifest(
        await readRegularJson(
          path.join(rootDir, PLUGIN_RELEASE_LEDGER_FILENAME),
          'Plugin release ledger',
        ),
        manifest,
      )
    : undefined;
  return { rootDir, manifest, ...(ledger ? { ledger } : {}), snapshotDigest };
}

type CatalogSnapshotValidationResult = {
  rootDir: string;
  manifest: CatalogManifestV5;
  ledger?: PluginReleaseLedger;
  snapshotDigest: string;
};

async function validateCatalogPluginEntriesComplete(
  validation: CatalogSnapshotValidationResult,
  pluginNames: readonly string[],
): Promise<void> {
  const entriesByName = new Map(validation.manifest.entries.map((entry) => [entry.name, entry]));
  const plugins: PluginMeta[] = [];
  for (const name of pluginNames) {
    const entry = entriesByName.get(name);
    if (!entry) throw new Error(`Catalog plugin ${JSON.stringify(name)} does not exist.`);
    const pluginRoot = path.join(validation.rootDir, 'plugins', entry.name);
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await validateBundleRuntimeRequirementsReceipts(plugin, pluginRoot);
    for (const platform of ['claude', 'codex'] as const) {
      const platformManifestPath = path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json');
      const exists = await fs.pathExists(platformManifestPath);
      if (exists !== resolveSupportedPlatforms(plugin.manifest).has(platform)) {
        throw new Error(`Catalog plugin ${JSON.stringify(entry.name)} has an inconsistent ${platform} bundle projection.`);
      }
      if (exists) {
        const rawPlatformManifest = await readRegularJson(platformManifestPath, `${platform} plugin manifest`);
        await validatePlatformManifestProjection(plugin, platform, rawPlatformManifest);
      }
    }
    const expected = await expectedCatalogEntry(plugin, pluginRoot);
    for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
      if (!isDeepStrictEqual(entry[field], expected[field])) {
        throw new Error(`Catalog entry ${field} for ${JSON.stringify(entry.name)} does not match its plugin bundle.`);
      }
    }
    plugins.push(plugin);
  }
  assertDependencyGraph(plugins);
}

export async function validateCatalogSnapshotPluginEntriesComplete(
  snapshotDirectory: string,
  pluginNames: readonly string[],
): Promise<CatalogSnapshotValidationResult> {
  const validation = await validateCatalogSnapshotTransport(snapshotDirectory);
  await validateCatalogPluginEntriesComplete(validation, pluginNames);
  return validation;
}

export async function validateCatalogSnapshotComplete(
  snapshotDirectory: string,
): Promise<CatalogSnapshotValidationResult> {
  const validation = await validateCatalogSnapshotTransport(snapshotDirectory);
  await validateCatalogPluginEntriesComplete(
    validation,
    validation.manifest.entries.map((entry) => entry.name),
  );
  return validation;
}
