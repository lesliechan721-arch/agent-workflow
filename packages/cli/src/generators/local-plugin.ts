import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { preparePluginNativeTools, validateManagedCommandSources, PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core/manifest';

import { applyFileRules } from '../utils/file-rules.js';
import { calculateFileDigest } from '../utils/bundle-integrity.js';
import type {
  CanonicalRuntimeSourceIdentity,
  CatalogRuntimeExportResolution,
  CatalogRuntimeImportResolver,
} from '../utils/catalog-runtime-projection.js';
import { resolveCanonicalRuntimeSourceIdentity } from '../utils/catalog-runtime-projection.js';
import { validateManagedCommandPackageClosure } from '../utils/managed-command-closure.js';
import {
  assertManifestPlatformSupport,
  assertPluginInputTree,
  checkAwCapabilitySupport,
  computeAwCapabilitySetDigest,
  createAwPluginRequirementsReceipt,
  createBundleSourceManifest,
  createPlatformManifestBase,
  isIgnoredPluginInputDirectory,
  normalizeAwCapabilities,
  readPluginManifest,
  resolvePluginRequirements,
  validatePluginManifest,
} from '../utils/manifest.js';
import {
  AwCapabilityUnsupportedError,
  IMPLEMENTED_AW_CAPABILITIES,
} from '../commands/aw-capabilities.js';
import { writeJsonFile } from '../utils/json.js';
import { resolveSupportedPlatforms } from '../utils/platform-support.js';
import { renderTemplate } from '../utils/template-engine.js';
import { scanNodeImportContract } from '../utils/plugin-script-contract.js';
import {
  isSkillAuthorOnlyPath,
  isSkillCollectionAuthorOnlyPath,
} from '../utils/skill-authoring.js';
import { assertTestWritablePath } from '../utils/test-path-fence.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import {
  validateRuntimeSkillClosure,
  validateSkillRuntimeProjectionFreshness,
} from '../utils/runtime-skill-closure.js';
import {
  AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH,
  validatePortableSkillDirectory,
} from '../utils/dynamic-skill-tree.js';
import type {
  DistributionName,
  PlatformName,
  PlatformPluginManifest,
  PluginMeta,
} from '../types.js';

const execFileAsync = promisify(execFile);
const requireFromCli = createRequire(import.meta.url);
const NODE_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const INSTALL_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const PLATFORM_ORDER = ['claude', 'codex'] as const;
const PLATFORM_MANIFEST_DIRS: Readonly<Record<(typeof PLATFORM_ORDER)[number], string>> = {
  claude: '.claude-plugin',
  codex: '.codex-plugin',
};

const EXACT_PNPM_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function assertLocalPluginStagingPathForTests(
  targetPath: string,
  source: string,
): string {
  return assertTestWritablePath(
    targetPath,
    source,
    '用 createIsolatedTestEnv() 生成默认 TMPDIR，或通过 registerWritableStateRoot() 登记 local plugin staging 路径。',
  );
}

export type PluginBundleBuildMode = 'build-free' | 'staging' | 'prepared';

export interface PluginStagingRunner {
  installPackageRoot(packageRoot: string): Promise<void>;
  runNodeBuild(options: {
    pluginRoot: string;
    scriptPath: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }): Promise<void>;
}

export interface RuntimeImportProvenance {
  provider: string;
  providerVersion: string;
  name: string;
  source: string;
  sourceDigest: string;
  requiredCapabilities: string[];
  capabilitySetDigest: string;
}

export interface SkillRuntimeFileProvenance extends RuntimeImportProvenance {
  platform: PlatformTarget;
  distribution?: DistributionName;
  skill: string;
  target: string;
  targetDigest: string;
}

interface PortableRuntimeFileMetadata {
  platform: PlatformTarget;
  skill: string;
  target: string;
  path: string;
  digest: string;
}

interface SkillRuntimeFileProjection {
  provenance: SkillRuntimeFileProvenance;
  bindingKey: string;
  canonicalSource: CanonicalRuntimeSourceIdentity;
  sourcePath: string;
  targetPath: string;
}

interface BuildImportProjection {
  provenance: RuntimeImportProvenance;
  bindingKey: string;
  canonicalSource: CanonicalRuntimeSourceIdentity;
}

export interface PreparedPluginRuntimeContext {
  resolver?: CatalogRuntimeImportResolver;
  buildImports: RuntimeImportProvenance[];
}

const preparedBuildImportProjections = new WeakMap<
PreparedPluginRuntimeContext,
readonly BuildImportProjection[]
>();

export interface BundleLocalPluginOptions {
  buildMode?: PluginBundleBuildMode;
  stagingRunner?: PluginStagingRunner;
  commandEnv?: NodeJS.ProcessEnv;
  runtimeResolver?: CatalogRuntimeImportResolver;
  preparedRuntimeContext?: PreparedPluginRuntimeContext;
  runtimeSkillClosureValidation?: 'current' | 'historical';
  strictRequirements?: boolean;
}

export async function validateStagingPackageManager(packageRoot: string): Promise<string> {
  const [cliPackageJson, packageJson] = await Promise.all([
    readJsonObject(
      path.join(resolveCliPackageRoot(), 'package.json'),
      '@lesliechan721/aw package.json',
    ),
    readJsonObject(
      path.join(packageRoot, 'package.json'),
      'scripts.node.packageRoot.package.json',
    ),
  ]);
  // pnpm pack removes packageManager, but preserves runtime dependencies.
  const dependencies = cliPackageJson.dependencies as { pnpm?: unknown } | undefined;
  const supportedPnpmVersion = dependencies?.pnpm;
  if (
    typeof supportedPnpmVersion !== 'string'
    || !EXACT_PNPM_VERSION_PATTERN.test(supportedPnpmVersion)
  ) {
    throw new Error(
      'Invalid @lesliechan721/aw dependencies.pnpm: expected an exact "<major>.<minor>.<patch>" version.',
    );
  }
  const supportedPackageManager = `pnpm@${supportedPnpmVersion}`;
  if (packageJson.packageManager !== supportedPackageManager) {
    throw new Error(
      'Invalid scripts.node.packageRoot.package.json.packageManager: '
      + `expected "${supportedPackageManager}".`,
    );
  }

  return supportedPackageManager;
}

async function resolveFixedPnpmEntry(
  supportedPackageManager: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const configuredEntry = env.npm_execpath?.trim();
  if (!configuredEntry || !path.isAbsolute(configuredEntry)) {
    return undefined;
  }

  const entryPath = await fs.realpath(configuredEntry).catch(() => undefined);
  if (!entryPath) {
    return undefined;
  }

  let current = path.dirname(entryPath);
  while (true) {
    const packageJson = await fs.readJson(path.join(current, 'package.json')).catch(() => undefined) as
      | { name?: unknown; version?: unknown }
      | undefined;
    if (packageJson?.name === 'pnpm') {
      return `pnpm@${packageJson.version}` === supportedPackageManager
        ? entryPath
        : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function resolveRuntimePnpmEntry(
  supportedPackageManager: string,
): Promise<string | undefined> {
  const packageJsonPath = (() => {
    try {
      return requireFromCli.resolve('pnpm');
    } catch {
      return undefined;
    }
  })();
  if (!packageJsonPath) {
    return undefined;
  }

  const packageJson = await fs.readJson(packageJsonPath).catch(() => undefined) as
    | { name?: unknown; version?: unknown }
    | undefined;
  if (
    packageJson?.name !== 'pnpm'
    || `pnpm@${packageJson.version}` !== supportedPackageManager
  ) {
    return undefined;
  }

  const entryPath = path.join(path.dirname(packageJsonPath), 'bin', 'pnpm.cjs');
  const stats = await fs.stat(entryPath).catch(() => undefined);
  return stats?.isFile() ? entryPath : undefined;
}

function createDefaultStagingRunner(commandEnv: NodeJS.ProcessEnv): PluginStagingRunner {
  return {
    async installPackageRoot(packageRoot) {
      const supportedPackageManager = await validateStagingPackageManager(packageRoot);
      const fixedPnpmEntry = await resolveFixedPnpmEntry(supportedPackageManager, commandEnv)
        ?? await resolveRuntimePnpmEntry(supportedPackageManager);
      if (!fixedPnpmEntry) {
        throw new Error(
          `Cannot stage scripts.node.packageRoot: missing bundled ${supportedPackageManager} runtime dependency.`,
        );
      }
      const args = [
        fixedPnpmEntry,
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
      ];
      await execFileAsync(process.execPath, args, {
        cwd: packageRoot,
        env: commandEnv,
        maxBuffer: 10 * 1024 * 1024,
      });
    },
    async runNodeBuild({ pluginRoot, scriptPath, args, env }) {
      await execFileAsync(process.execPath, [path.join(pluginRoot, stripDotSlash(scriptPath)), ...args], {
        cwd: pluginRoot,
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
    },
  };
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function toPlatformRelativePath(value: string, platform: PlatformTarget): string {
  return `./${platform}/${stripDotSlash(value)}`;
}

function isTextFile(filePath: string): boolean {
  return /\.(md|markdown|txt|json|yaml|yml|toml|rules)$/i.test(filePath);
}

function isMacOsMetadataName(name: string): boolean {
  return name === '.DS_Store';
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (isMacOsMetadataName(entry.name)) continue;
    if (isIgnoredPluginInputDirectory(entry.name)) continue;
    if (entry.name === '.agents-plugin' || entry.name === '.claude-plugin' || entry.name === '.codex-plugin') {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursively(entryPath);
      files.push(
        ...nestedFiles.map((nestedFile) => path.join(entry.name, nestedFile).split(path.sep).join('/')),
      );
      continue;
    }

    files.push(entry.name);
  }

  return files.sort();
}

async function listFilesRecursivelyIncludingManaged(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    if (isIgnoredPluginInputDirectory(entry.name) || isMacOsMetadataName(entry.name)) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursivelyIncludingManaged(entryPath);
      files.push(
        ...nestedFiles.map((nestedFile) => path.join(entry.name, nestedFile).split(path.sep).join('/')),
      );
      continue;
    }

    files.push(entry.name);
  }

  return files.sort();
}

async function collectFilesForPath(pluginRoot: string, relativePath: string): Promise<string[]> {
  const absolutePath = path.join(pluginRoot, stripDotSlash(relativePath));
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats) {
    throw new Error(`Missing source path "${relativePath}".`);
  }

  if (stats.isDirectory()) {
    const nestedFiles = await listFilesRecursively(absolutePath);
    return nestedFiles.map((filePath) =>
      path.join(stripDotSlash(relativePath), filePath).split(path.sep).join('/'),
    );
  }

  return [stripDotSlash(relativePath).split(path.sep).join('/')];
}

async function copyFileWithTemplateSupport(
  pluginRoot: string,
  outputRoot: string,
  sourceRelativePath: string,
  platform: PlatformTarget,
  templatePatterns: string[],
  templateVars: Record<string, Partial<Record<PlatformTarget, string | boolean>>>,
): Promise<void> {
  const normalizedSource = sourceRelativePath.split(path.sep).join('/');
  const sourcePath = path.join(pluginRoot, normalizedSource);
  const targetPath = path.join(outputRoot, platform, normalizedSource);
  await fs.ensureDir(path.dirname(targetPath));

  const shouldRenderTemplate =
    isTextFile(normalizedSource) &&
    templatePatterns.length > 0 &&
    applyFileRules([normalizedSource], templatePatterns, []).length > 0;

  if (!shouldRenderTemplate) {
    await fs.copyFile(sourcePath, targetPath);
    return;
  }

  const content = await fs.readFile(sourcePath, 'utf8');
  await fs.writeFile(targetPath, renderTemplate(content, templateVars, platform), 'utf8');
}

async function copyBundleRootFile(
  pluginRoot: string,
  outputRoot: string,
  relativePath: string,
): Promise<void> {
  const normalized = stripDotSlash(relativePath).split(path.sep).join('/');
  const sourcePath = path.join(pluginRoot, normalized);
  const targetPath = path.join(outputRoot, normalized);
  await fs.ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
}

async function assertArtifactSourceTreePortable(
  rootDir: string,
  fieldName: string,
  relativeRoot = '',
): Promise<void> {
  const rootStats = await fs.lstat(rootDir);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Invalid ${fieldName}: source root must be a regular directory.`);
  }
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeRoot
      ? path.posix.join(relativeRoot, entry.name)
      : entry.name;
    if (isSkillAuthorOnlyPath(relativePath)) continue;
    if (isMacOsMetadataName(entry.name)) continue;
    if (relativePath === AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH) {
      throw new Error(`Invalid ${fieldName}: source root cannot declare reserved file ${AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH}.`);
    }
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Invalid ${fieldName}: symbolic links are not supported (${entry.name}).`);
    }
    if (entry.isDirectory()) {
      await assertArtifactSourceTreePortable(entryPath, fieldName, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Invalid ${fieldName}: only regular files and directories are supported (${entry.name}).`);
    }
  }
}

async function copyArtifactSourceDirectories(
  plugin: PluginMeta,
  outputRoot: string,
): Promise<void> {
  for (const [sourceIndex, sourceDir] of (plugin.manifest.artifacts?.sourceDirs ?? []).entries()) {
    const sourcePath = path.join(plugin.rootDir, stripDotSlash(sourceDir));
    await assertArtifactSourceTreePortable(sourcePath, `artifacts.sourceDirs[${sourceIndex}]`);
    const targetRoot = path.join(outputRoot, stripDotSlash(sourceDir));
    await fs.ensureDir(targetRoot);
    for (const relativePath of await listFilesRecursively(sourcePath)) {
      if (isSkillAuthorOnlyPath(relativePath)) continue;
      const destination = path.join(targetRoot, relativePath);
      await fs.ensureDir(path.dirname(destination));
      await fs.copyFile(path.join(sourcePath, relativePath), destination);
    }
  }
}

async function copyManagedCommandPackages(plugin: PluginMeta, outputRoot: string): Promise<void> {
  await validateManagedCommandSources(plugin.rootDir, plugin.manifest);
  for (const commandPackage of plugin.manifest.managedCommands?.packages ?? []) {
    const relativePath = stripDotSlash(commandPackage.sourceDir);
    await fs.copy(path.join(plugin.rootDir, relativePath), path.join(outputRoot, relativePath), {
      overwrite: true,
      dereference: false,
    });
    const entries = (plugin.manifest.managedCommands?.sets ?? []).flatMap((set) =>
      set.producer.kind === 'package' && set.producer.packageKey === commandPackage.key && set.mode === 'static' ? set.entries : []);
    await validateManagedCommandPackageClosure(path.join(outputRoot, relativePath), entries);
  }
  await validateManagedCommandSources(outputRoot, plugin.manifest);
}

async function resolveArtifactRuntimeImports(options: {
  plugin: PluginMeta;
  outputRoot: string;
  resolver?: CatalogRuntimeImportResolver;
}): Promise<{
  manifest: PluginMeta['manifest'];
  requiredCapabilities: string[];
  projections: Array<{
    sourcePath: string;
    targetPath: string;
    sourceDigest: string;
    label: string;
  }>;
}> {
  const manifest = createBundleSourceManifest(options.plugin);
  const requiredCapabilities: string[] = [];
  const projections: Array<{
    sourcePath: string;
    targetPath: string;
    sourceDigest: string;
    label: string;
  }> = [];
  for (const [importIndex, runtimeImport] of (manifest.artifacts?.runtimeImports ?? []).entries()) {
    if (!options.resolver) {
      throw new Error(`Cannot resolve artifacts.runtimeImports[${importIndex}]: catalog runtime import resolver is required.`);
    }
    const resolution = await options.resolver.resolve({
      consumer: options.plugin, reference: runtimeImport, purpose: 'artifact-runtime',
    });
    requiredCapabilities.push(...resolution.requiredCapabilities);
    const relativePath = `./.agents-plugin/runtime-imports/${runtimeImport.name}`;
    projections.push({
      sourcePath: resolution.sourcePath,
      targetPath: path.join(options.outputRoot, stripDotSlash(relativePath)),
      sourceDigest: resolution.sourceDigest,
      label: runtimeImport.name,
    });
    runtimeImport.resolved = {
      path: relativePath, digest: resolution.sourceDigest,
      providerPluginId: resolution.provider, providerVersion: resolution.providerVersion,
      source: resolution.source, requiredCapabilities: resolution.requiredCapabilities,
      capabilitySetDigest: resolution.capabilitySetDigest,
    };
  }
  return {
    manifest,
    requiredCapabilities: normalizeAwCapabilities(requiredCapabilities),
    projections,
  };
}

async function materializeArtifactRuntimeImports(
  projections: readonly {
    sourcePath: string;
    targetPath: string;
    sourceDigest: string;
    label: string;
  }[],
): Promise<void> {
  for (const projection of projections) {
    await fs.ensureDir(path.dirname(projection.targetPath));
    await fs.copyFile(projection.sourcePath, projection.targetPath);
    if (await calculateFileDigest(projection.targetPath) !== projection.sourceDigest) {
      throw new Error(`Artifact runtime import digest mismatch at "${projection.label}".`);
    }
  }
}

async function injectRequirementsReceipts(options: {
  outputRoot: string;
  plugin: PluginMeta;
  requiredCapabilities: readonly string[];
}): Promise<void> {
  const receipt = createAwPluginRequirementsReceipt(
    { name: options.plugin.manifest.name, version: options.plugin.manifest.version },
    options.requiredCapabilities,
  );
  for (const relativeRoot of PLATFORM_TARGETS.map((platform) => `${platform}/skills`)) {
    const skillsRoot = path.join(options.outputRoot, relativeRoot);
    if (!(await fs.pathExists(skillsRoot))) continue;
    for (const entry of await fs.readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillRoot = path.join(skillsRoot, entry.name);
      if (!(await fs.pathExists(path.join(skillRoot, 'SKILL.md')))) continue;
      const receiptPath = path.join(skillRoot, 'aw-plugin-requirements.json');
      if (await fs.pathExists(receiptPath)) {
        throw new Error(`Reserved runtime requirements receipt conflicts with source content: ${receiptPath}`);
      }
      await writeJsonFile(receiptPath, receipt);
    }
  }
}

async function addDeclaredPathFiles(
  plugin: PluginMeta,
  platform: PlatformName,
  relativePath: string | undefined,
  targetFiles: Set<string>,
): Promise<string | undefined> {
  if (!relativePath) {
    return undefined;
  }

  const files = await collectFilesForPath(plugin.rootDir, relativePath);
  for (const filePath of files) {
    targetFiles.add(filePath);
  }

  return toPlatformRelativePath(relativePath, platform);
}

async function addDeclaredSkillPathFiles(
  plugin: PluginMeta,
  platform: PlatformTarget,
  relativePath: string | undefined,
  targetFiles: Set<string>,
): Promise<string | undefined> {
  if (!relativePath) return undefined;
  const root = stripDotSlash(relativePath);
  const files = await collectFilesForPath(plugin.rootDir, relativePath);
  let added = false;
  for (const filePath of files) {
    const skillCollectionPath = path.posix.relative(
      root.split(path.sep).join('/'),
      filePath.split(path.sep).join('/'),
    );
    if (
      !isSkillCollectionAuthorOnlyPath(skillCollectionPath)
    ) {
      targetFiles.add(filePath);
      added = true;
    }
  }
  return added ? toPlatformRelativePath(relativePath, platform) : undefined;
}

function relativePathInside(root: string, candidate: string): string | null {
  const relative = path.posix.relative(root, candidate);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function isDeclaredSkillAuthorOnlyFile(plugin: PluginMeta, filePath: string): boolean {
  const normalizedFile = filePath.split(path.sep).join('/');
  if (normalizedFile === 'reports' || normalizedFile.startsWith('reports/')) return true;
  if (plugin.manifest.skills) {
    const staticRoot = stripDotSlash(plugin.manifest.skills).split(path.sep).join('/');
    const staticRelative = relativePathInside(staticRoot, normalizedFile);
    if (staticRelative && isSkillCollectionAuthorOnlyPath(staticRelative)) return true;
  }
  for (const sourceDir of plugin.manifest.artifacts?.sourceDirs ?? []) {
    const sourceRelative = relativePathInside(stripDotSlash(sourceDir), normalizedFile);
    if (sourceRelative && isSkillAuthorOnlyPath(sourceRelative)) return true;
  }
  return false;
}


function addPreApplyRuntimeEntry(
  plugin: PluginMeta,
  rootFiles: Set<string>,
  nodeEntries: Set<string>,
): void {
  const entry = plugin.manifest.scripts?.preApply;
  if (!entry) return;
  const filePath = stripDotSlash(entry.path);
  rootFiles.add(filePath);
  nodeEntries.add(filePath);
}

function addHelperRuntimeEntries(
  plugin: PluginMeta,
  rootFiles: Set<string>,
  nodeEntries: Set<string>,
): void {
  const configHelper = plugin.manifest.scripts?.helpers?.config;
  if (!configHelper) {
    return;
  }

  const filePath = stripDotSlash(configHelper);
  rootFiles.add(filePath);
  nodeEntries.add(filePath);
}

function addArtifactRendererRuntimeEntry(
  plugin: PluginMeta,
  rootFiles: Set<string>,
  nodeEntries: Set<string>,
): void {
  const renderer = plugin.manifest.scripts?.artifacts?.render;
  if (!renderer) {
    return;
  }

  const filePath = stripDotSlash(renderer.path);
  rootFiles.add(filePath);
  nodeEntries.add(filePath);
}

async function readJsonObject(filePath: string, fieldName: string): Promise<Record<string, unknown>> {
  const content = await fs.readJson(filePath);
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(`Invalid ${fieldName}: expected a JSON object.`);
  }

  return content as Record<string, unknown>;
}

function readDependencyNames(packageJson: Record<string, unknown>, fieldName: string): string[] {
  const dependencies = packageJson[fieldName];
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return [];
  }

  return Object.keys(dependencies as Record<string, unknown>).sort();
}

async function readPackageRootDependencySets(
  plugin: PluginMeta,
): Promise<{ dependencies: string[]; devDependencies: string[] }> {
  const packageRoot = plugin.manifest.scripts?.node?.packageRoot;
  if (!packageRoot) {
    return { dependencies: [], devDependencies: [] };
  }

  const packageJson = await readJsonObject(
    path.join(plugin.rootDir, stripDotSlash(packageRoot), 'package.json'),
    'scripts.node.packageRoot.package.json',
  );

  return {
    dependencies: readDependencyNames(packageJson, 'dependencies'),
    devDependencies: readDependencyNames(packageJson, 'devDependencies'),
  };
}

async function collectRuntimeClosureFiles(
  plugin: PluginMeta,
  entryFiles: string[],
): Promise<string[]> {
  if (entryFiles.length === 0) {
    return [];
  }

  const allFiles = await listFilesRecursivelyIncludingManaged(plugin.rootDir);
  const scanFiles: Record<string, string> = {};
  await Promise.all(
    allFiles
      .filter((filePath) => (
        NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase())
        || path.posix.basename(filePath) === 'package.json'
      ))
      .map(async (filePath) => {
        scanFiles[filePath] = await fs.readFile(path.join(plugin.rootDir, filePath), 'utf8');
      }),
  );

  const { dependencies, devDependencies } = await readPackageRootDependencySets(plugin);
  const scan = scanNodeImportContract({
    files: scanFiles,
    filePaths: allFiles,
    entryFiles,
    dependencies,
    devDependencies,
    runtimeConfigSkillRoots: plugin.manifest.artifacts?.sourceDirs ?? [],
  });
  if (scan.errors.length > 0) {
    throw new Error(`Invalid scripts.node runtime imports:\n${scan.errors.join('\n')}`);
  }

  return scan.files;
}

async function collectAwRuntimeFiles(plugin: PluginMeta): Promise<string[]> {
  const rootFiles = new Set<string>();
  const nodeEntries = new Set<string>();
  addPreApplyRuntimeEntry(plugin, rootFiles, nodeEntries);
  addHelperRuntimeEntries(plugin, rootFiles, nodeEntries);
  addArtifactRendererRuntimeEntry(plugin, rootFiles, nodeEntries);
  if (plugin.manifest.nativeTools) {
    rootFiles.add(stripDotSlash(plugin.manifest.nativeTools.reader));
  }

  const closureFiles = await collectRuntimeClosureFiles(plugin, [...nodeEntries]);
  for (const filePath of closureFiles) {
    rootFiles.add(filePath);
  }

  const configHelper = plugin.manifest.scripts?.helpers?.config;
  if (configHelper) {
    const helperDir = path.posix.dirname(stripDotSlash(configHelper));
    const re2RuntimeRoot = path.posix.join(helperDir, 're2-wasm');
    if (closureFiles.includes(path.posix.join(re2RuntimeRoot, 'build/src/re2.js'))) {
      rootFiles.add(path.posix.join(re2RuntimeRoot, 'build/wasm/re2.wasm'));
      rootFiles.add(path.posix.join(re2RuntimeRoot, 'LICENSE'));
    }
  }

  return [...rootFiles].sort();
}

function packageRootPath(plugin: PluginMeta): string | undefined {
  const packageRoot = plugin.manifest.scripts?.node?.packageRoot;
  return packageRoot ? path.join(plugin.rootDir, stripDotSlash(packageRoot)) : undefined;
}

async function findInstalledPackageDir(
  packageRoot: string,
  importerDir: string,
  packageName: string,
): Promise<string | undefined> {
  let current = importerDir;
  const packageRootParent = path.dirname(packageRoot);

  while (current.startsWith(packageRootParent)) {
    const candidate = path.join(current, 'node_modules', ...packageName.split('/'));
    const stats = await fs.stat(candidate).catch(() => null);
    if (stats?.isDirectory()) {
      return fs.realpath(candidate);
    }

    if (current === packageRoot) {
      break;
    }
    current = path.dirname(current);
  }

  return undefined;
}

interface InstalledDependencyPackage {
  importerDir: string;
  packageName: string;
  packageDir: string;
  packageJson: Record<string, unknown>;
}

type DependencyRequirement = 'required' | 'optional-dependency' | 'optional-peer';

async function collectInstalledDependencyClosure(
  packageRoot: string,
  rootDependencies: string[],
): Promise<InstalledDependencyPackage[]> {
  const packageRootReal = await fs.realpath(packageRoot);
  const queue = rootDependencies.map((dependencyName) => ({
    packageName: dependencyName,
    importerDir: packageRootReal,
    requirement: 'required' as DependencyRequirement,
  }));
  const visitedEntries = new Set<string>();
  const visitedPackageDirs = new Set<string>();
  const packageJsonByDir = new Map<string, Record<string, unknown>>();
  const packages: InstalledDependencyPackage[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const dependencyDir = await findInstalledPackageDir(packageRootReal, next.importerDir, next.packageName);
    if (!dependencyDir) {
      if (next.requirement === 'optional-peer') {
        continue;
      }
      if (next.requirement === 'optional-dependency') {
        throw new Error(
          `Invalid scripts.node.packageRoot: missing transitive optional dependency "${next.packageName}" in node_modules; cross-platform staging cannot prove that all supported runtime operating systems exclude it.`,
        );
      }
      throw new Error(`Invalid scripts.node.packageRoot: missing production dependency "${next.packageName}" in node_modules.`);
    }

    const entryKey = JSON.stringify([next.importerDir, next.packageName, dependencyDir]);
    if (visitedEntries.has(entryKey)) {
      continue;
    }
    visitedEntries.add(entryKey);

    let packageJson = packageJsonByDir.get(dependencyDir);
    if (!packageJson) {
      packageJson = await readJsonObject(
        path.join(dependencyDir, 'package.json'),
        `${next.packageName} package.json`,
      );
      packageJsonByDir.set(dependencyDir, packageJson);
    }
    packages.push({
      importerDir: next.importerDir,
      packageName: next.packageName,
      packageDir: dependencyDir,
      packageJson,
    });

    if (visitedPackageDirs.has(dependencyDir)) {
      continue;
    }
    visitedPackageDirs.add(dependencyDir);

    const optionalDependencies = new Set(readDependencyNames(packageJson, 'optionalDependencies'));
    for (const childDependency of readDependencyNames(packageJson, 'dependencies')) {
      if (optionalDependencies.has(childDependency)) {
        continue;
      }
      queue.push({
        packageName: childDependency,
        importerDir: dependencyDir,
        requirement: 'required',
      });
    }
    for (const childDependency of optionalDependencies) {
      queue.push({
        packageName: childDependency,
        importerDir: dependencyDir,
        requirement: 'optional-dependency',
      });
    }

    const peerDependenciesMeta = packageJson.peerDependenciesMeta;
    const peerMeta = peerDependenciesMeta && typeof peerDependenciesMeta === 'object'
      && !Array.isArray(peerDependenciesMeta)
      ? peerDependenciesMeta as Record<string, unknown>
      : {};
    for (const peerDependency of readDependencyNames(packageJson, 'peerDependencies')) {
      const metadata = peerMeta[peerDependency];
      const optional = metadata !== null
        && typeof metadata === 'object'
        && !Array.isArray(metadata)
        && (metadata as Record<string, unknown>).optional === true;
      queue.push({
        packageName: peerDependency,
        importerDir: dependencyDir,
        requirement: optional ? 'optional-peer' : 'required',
      });
    }
  }

  return packages;
}

async function readProductionDependencyClosure(packageRoot: string): Promise<InstalledDependencyPackage[]> {
  const rootPackageJson = await readJsonObject(
    path.join(packageRoot, 'package.json'),
    'scripts.node.packageRoot.package.json',
  );
  return collectInstalledDependencyClosure(packageRoot, readDependencyNames(rootPackageJson, 'dependencies'));
}

async function assertNoProductionInstallScripts(packageRoot: string): Promise<void> {
  for (const dependency of await readProductionDependencyClosure(packageRoot)) {
    const scripts = dependency.packageJson.scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      continue;
    }
    for (const scriptName of INSTALL_SCRIPT_NAMES) {
      if (typeof (scripts as Record<string, unknown>)[scriptName] === 'string') {
        throw new Error(
          `Invalid scripts.node.packageRoot: production dependency "${dependency.packageName}" declares unsupported "${scriptName}" script.`,
        );
      }
    }
  }
}

async function copyProductionDependencyClosure(
  sourcePackageRoot: string,
  targetPackageRoot: string,
): Promise<void> {
  const targetNodeModules = path.join(targetPackageRoot, 'node_modules');
  const sourcePackageRootReal = await fs.realpath(sourcePackageRoot);
  const productionDependencies = await readProductionDependencyClosure(sourcePackageRoot);
  const dependenciesByImporter = new Map<string, InstalledDependencyPackage[]>();

  for (const dependency of productionDependencies) {
    const importerDependencies = dependenciesByImporter.get(dependency.importerDir) ?? [];
    importerDependencies.push(dependency);
    dependenciesByImporter.set(dependency.importerDir, importerDependencies);
  }

  await fs.remove(targetNodeModules);
  await fs.ensureDir(targetNodeModules);

  async function materializeDependency(
    dependency: InstalledDependencyPackage,
    targetPackageDir: string,
    ancestorResolutions: readonly ReadonlyMap<string, string>[],
  ): Promise<void> {
    await fs.copy(dependency.packageDir, targetPackageDir, {
      filter(source) {
        return path.basename(source) !== 'node_modules'
          && !isMacOsMetadataName(path.basename(source));
      },
    });

    const childDependencies = dependenciesByImporter.get(dependency.packageDir) ?? [];
    const childResolutions = new Map(
      childDependencies.map((child) => [child.packageName, child.packageDir]),
    );
    for (const child of childDependencies) {
      const ancestorPackageDir = ancestorResolutions
        .map((resolutions) => resolutions.get(child.packageName))
        .find((packageDir) => packageDir !== undefined);
      if (ancestorPackageDir === child.packageDir) {
        continue;
      }
      await materializeDependency(
        child,
        path.join(targetPackageDir, 'node_modules', ...child.packageName.split('/')),
        [childResolutions, ...ancestorResolutions],
      );
    }
  }

  const rootDependencies = dependenciesByImporter.get(sourcePackageRootReal) ?? [];
  const rootResolutions = new Map(
    rootDependencies.map((dependency) => [dependency.packageName, dependency.packageDir]),
  );
  for (const dependency of rootDependencies) {
    await materializeDependency(
      dependency,
      path.join(targetNodeModules, ...dependency.packageName.split('/')),
      [rootResolutions],
    );
  }
}

async function copyProductionPackageRoot(plugin: PluginMeta, outputRoot: string): Promise<void> {
  const declaredPackageRoot = plugin.manifest.scripts?.node?.packageRoot;
  if (!declaredPackageRoot) {
    return;
  }

  const sourcePackageRoot = path.join(plugin.rootDir, stripDotSlash(declaredPackageRoot));
  const targetPackageRoot = path.join(outputRoot, stripDotSlash(declaredPackageRoot));
  await fs.ensureDir(targetPackageRoot);
  await fs.copyFile(
    path.join(sourcePackageRoot, 'package.json'),
    path.join(targetPackageRoot, 'package.json'),
  );
  await fs.copyFile(
    path.join(sourcePackageRoot, 'pnpm-lock.yaml'),
    path.join(targetPackageRoot, 'pnpm-lock.yaml'),
  );

  const sourceNodeModules = path.join(sourcePackageRoot, 'node_modules');
  if (!(await fs.pathExists(sourceNodeModules))) {
    throw new Error('Invalid scripts.node.packageRoot: missing production node_modules after staging install.');
  }

  await copyProductionDependencyClosure(sourcePackageRoot, targetPackageRoot);
}

function toRuntimeImportProvenance(
  resolution: CatalogRuntimeExportResolution,
): RuntimeImportProvenance {
  return {
    provider: resolution.provider,
    providerVersion: resolution.providerVersion,
    name: resolution.name,
    source: resolution.source,
    sourceDigest: resolution.sourceDigest,
    requiredCapabilities: resolution.requiredCapabilities,
    capabilitySetDigest: resolution.capabilitySetDigest,
  };
}

async function resolveOwnSkillRuntimeSource(
  plugin: PluginMeta,
  source: string,
): Promise<{
  sourcePath: string;
  sourceDigest: string;
  canonicalSource: CanonicalRuntimeSourceIdentity;
}> {
  const canonicalSource = await resolveCanonicalRuntimeSourceIdentity(
    plugin.rootDir,
    source,
    'buildConfig.skillRuntimeFiles source',
  );
  return {
    sourcePath: canonicalSource.sourceRealPath,
    sourceDigest: await calculateFileDigest(canonicalSource.sourceRealPath),
    canonicalSource,
  };
}

async function assertSkillRuntimeTargetAbsent(
  skillRoot: string,
  target: string,
  fieldName: string,
): Promise<void> {
  let current = skillRoot;
  const segments = target.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch(() => undefined);
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw new Error(`Invalid ${fieldName}: target path contains a symbolic link (${target}).`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Invalid ${fieldName}: target parent is not a directory (${target}).`);
    }
    if (index === segments.length - 1) {
      throw new Error(`Invalid ${fieldName}: staged Skill already contains "${target}".`);
    }
  }
}

async function assertSkillRuntimeProjectionTargets(plugin: PluginMeta): Promise<void> {
  for (const [index, entry] of (plugin.manifest.buildConfig?.skillRuntimeFiles ?? []).entries()) {
    const roots = [path.join(plugin.rootDir, stripDotSlash(plugin.manifest.skills ?? './skills'), entry.skill)];
    for (const skillRoot of roots) {
      const skillRootStats = await fs.lstat(skillRoot).catch(() => undefined);
      if (!skillRootStats?.isDirectory() || skillRootStats.isSymbolicLink()) {
        throw new Error(
          `Invalid buildConfig.skillRuntimeFiles[${index}].skill: "${entry.skill}" is not a declared static Skill key.`,
        );
      }
      await assertSkillRuntimeTargetAbsent(
        skillRoot,
        entry.target,
        `buildConfig.skillRuntimeFiles[${index}].target`,
      );
    }
  }
}

async function validateGeneratedSkillRuntimeFiles(
  plugin: PluginMeta,
  outputRoot: string,
  supportedPlatforms: ReadonlySet<PlatformTarget>,
): Promise<void> {
  for (const [index, entry] of (plugin.manifest.buildConfig?.generatedSkillRuntimeFiles ?? []).entries()) {
    const surfaces = entry.platforms?.length ? entry.platforms : [...supportedPlatforms];
    for (const surface of surfaces) {
      const targetPath = path.join(outputRoot, surface, 'skills', entry.skill, ...entry.target.split('/'));
      const stats = await fs.lstat(targetPath).catch(() => undefined);
      if (!stats?.isFile() || stats.isSymbolicLink()) {
        throw new Error(
          `Invalid buildConfig.generatedSkillRuntimeFiles[${index}]: build did not create regular final target "${surface}:${entry.skill}/${entry.target}".`,
        );
      }
    }
  }
}

async function projectSkillRuntimeFiles(options: {
  plugin: PluginMeta;
  outputRoot: string;
  supportedPlatforms: ReadonlySet<PlatformTarget>;
  resolver?: CatalogRuntimeImportResolver;
}): Promise<SkillRuntimeFileProjection[]> {
  const projections: SkillRuntimeFileProjection[] = [];
  const claims = new Set<string>();
  for (const [index, entry] of (options.plugin.manifest.buildConfig?.skillRuntimeFiles ?? []).entries()) {
    for (const platform of entry.platforms?.length ? entry.platforms : [...options.supportedPlatforms]) {
      if (!options.supportedPlatforms.has(platform)) {
        throw new Error(
          `Invalid buildConfig.skillRuntimeFiles[${index}].platforms: plugin does not support "${platform}".`,
        );
      }
      const distribution = platform === 'codex' || platform === 'claude' ? undefined : 'agent-skills' as const;
      const claim = `${platform}:${entry.skill}/${entry.target}`;
      if (claims.has(claim)) {
        throw new Error(`Invalid buildConfig.skillRuntimeFiles: target collision at "${claim}".`);
      }
      claims.add(claim);

      let sourcePath: string;
      let sourceDigest: string;
      let canonicalSource: CanonicalRuntimeSourceIdentity;
      let bindingKey: string;
      let runtimeProvenance: RuntimeImportProvenance;
      if (entry.source) {
        const ownSource = await resolveOwnSkillRuntimeSource(options.plugin, entry.source);
        sourcePath = ownSource.sourcePath;
        sourceDigest = ownSource.sourceDigest;
        canonicalSource = ownSource.canonicalSource;
        bindingKey = `source:${entry.source}`;
        runtimeProvenance = {
          provider: options.plugin.manifest.name,
          providerVersion: options.plugin.manifest.version,
          name: entry.source,
          source: entry.source,
          sourceDigest,
          requiredCapabilities: [],
          capabilitySetDigest: computeAwCapabilitySetDigest([]),
        };
      } else {
        if (!entry.import || !options.resolver) {
          throw new Error(
            `Cannot resolve buildConfig.skillRuntimeFiles[${index}].import for plugin "${options.plugin.manifest.name}": catalog runtime import resolver is required.`,
          );
        }
        const resolution = await options.resolver.resolve({
          consumer: options.plugin,
          reference: entry.import,
          purpose: 'skill-runtime-file',
          platform,
        });
        sourcePath = resolution.sourcePath;
        sourceDigest = resolution.sourceDigest;
        canonicalSource = resolution.canonicalSource;
        bindingKey = `import:${entry.import.plugin}/${entry.import.export}`;
        runtimeProvenance = toRuntimeImportProvenance(resolution);
      }

      const targetPath = path.join(
        options.outputRoot,
        platform,
        'skills',
        entry.skill,
        ...entry.target.split('/'),
      );
      projections.push({
        bindingKey,
        canonicalSource,
        sourcePath,
        targetPath,
        provenance: {
          ...runtimeProvenance,
          platform,
          distribution,
          skill: entry.skill,
          target: entry.target,
          targetDigest: sourceDigest,
        },
      });
    }
  }
  return projections;
}

async function materializeSkillRuntimeFiles(
  projections: readonly SkillRuntimeFileProjection[],
): Promise<void> {
  for (const projection of projections) {
    if (await fs.pathExists(projection.targetPath)) {
      const surface = projection.provenance.platform;
      throw new Error(
        `Invalid buildConfig.skillRuntimeFiles: bundle target already exists at "${surface}:${projection.provenance.skill}/${projection.provenance.target}".`,
      );
    }
    await fs.ensureDir(path.dirname(projection.targetPath));
    await fs.copyFile(projection.sourcePath, projection.targetPath);
    if (await calculateFileDigest(projection.targetPath) !== projection.provenance.sourceDigest) {
      throw new Error(
        `Canonical source "${projection.provenance.source}" changed during runtime Skill projection.`,
      );
    }
  }
}

function hasSameCanonicalSource(
  left: CanonicalRuntimeSourceIdentity,
  right: CanonicalRuntimeSourceIdentity,
): boolean {
  return left.rootPath === right.rootPath
    && left.rootRealPath === right.rootRealPath
    && left.relativePath === right.relativePath
    && left.sourceRealPath === right.sourceRealPath;
}

async function validateSkillRuntimeProjectionSources(
  projections: readonly SkillRuntimeFileProjection[],
): Promise<void> {
  const bindings = new Map<string, SkillRuntimeFileProjection>();
  for (const projection of projections) {
    const existing = bindings.get(projection.bindingKey);
    if (
      existing
      && (
        existing.provenance.provider !== projection.provenance.provider
        || existing.provenance.providerVersion !== projection.provenance.providerVersion
        || existing.provenance.name !== projection.provenance.name
        || existing.provenance.source !== projection.provenance.source
        || existing.provenance.sourceDigest !== projection.provenance.sourceDigest
        || existing.provenance.capabilitySetDigest !== projection.provenance.capabilitySetDigest
        || JSON.stringify(existing.provenance.requiredCapabilities)
          !== JSON.stringify(projection.provenance.requiredCapabilities)
        || !hasSameCanonicalSource(existing.canonicalSource, projection.canonicalSource)
      )
    ) {
      throw new Error(
        `Canonical source "${projection.provenance.source}" changed during runtime Skill projection.`,
      );
    }
    bindings.set(projection.bindingKey, projection);
  }

  for (const projection of projections) {
    let currentSource: CanonicalRuntimeSourceIdentity;
    try {
      currentSource = await resolveCanonicalRuntimeSourceIdentity(
        projection.canonicalSource.rootPath,
        projection.canonicalSource.relativePath,
        'runtime Skill projection canonical source',
      );
    } catch {
      throw new Error(
        `Canonical source "${projection.provenance.source}" changed during runtime Skill projection.`,
      );
    }
    if (
      !hasSameCanonicalSource(projection.canonicalSource, currentSource)
      || await calculateFileDigest(currentSource.sourceRealPath) !== projection.provenance.sourceDigest
    ) {
      throw new Error(
        `Canonical source "${projection.provenance.source}" changed during runtime Skill projection.`,
      );
    }
  }
}

async function validateBuildImportProjectionSources(
  projections: readonly BuildImportProjection[],
): Promise<void> {
  const bindings = new Map<string, BuildImportProjection>();
  for (const projection of projections) {
    const existing = bindings.get(projection.bindingKey);
    if (
      existing
      && (
        existing.provenance.provider !== projection.provenance.provider
        || existing.provenance.providerVersion !== projection.provenance.providerVersion
        || existing.provenance.name !== projection.provenance.name
        || existing.provenance.source !== projection.provenance.source
        || existing.provenance.sourceDigest !== projection.provenance.sourceDigest
        || existing.provenance.capabilitySetDigest !== projection.provenance.capabilitySetDigest
        || JSON.stringify(existing.provenance.requiredCapabilities)
          !== JSON.stringify(projection.provenance.requiredCapabilities)
        || !hasSameCanonicalSource(existing.canonicalSource, projection.canonicalSource)
      )
    ) {
      throw new Error(
        `Catalog runtime import "${projection.provenance.provider}/${projection.provenance.name}" changed during build import projection.`,
      );
    }
    bindings.set(projection.bindingKey, projection);
  }

  for (const projection of projections) {
    try {
      const currentSource = await resolveCanonicalRuntimeSourceIdentity(
        projection.canonicalSource.rootPath,
        projection.canonicalSource.relativePath,
        'build import projection canonical source',
      );
      if (
        !hasSameCanonicalSource(projection.canonicalSource, currentSource)
        || await calculateFileDigest(currentSource.sourceRealPath) !== projection.provenance.sourceDigest
      ) {
        throw new Error('stale canonical source');
      }
    } catch {
      throw new Error(
        `Catalog runtime import "${projection.provenance.provider}/${projection.provenance.name}" changed during build import projection.`,
      );
    }
  }
}

async function createStagedPlugin(
  plugin: PluginMeta,
  runner: PluginStagingRunner,
  resolver?: CatalogRuntimeImportResolver,
  commandEnv: NodeJS.ProcessEnv = process.env,
): Promise<{
  plugin: PluginMeta;
  runtimeContext: PreparedPluginRuntimeContext;
  cleanup(): Promise<void>;
}> {
  const stagingRoot = await fs.mkdtemp(
    assertLocalPluginStagingPathForTests(
      path.join(os.tmpdir(), 'aw-plugin-staging-'),
      'local plugin bundle staging root',
    ),
  );
  const stagingPluginRoot = assertLocalPluginStagingPathForTests(
    path.join(stagingRoot, 'plugin'),
    'local plugin staged plugin root',
  );

  try {
    await fs.copy(plugin.rootDir, stagingPluginRoot, {
      filter(source) {
        return !isIgnoredPluginInputDirectory(path.basename(source))
          && !isMacOsMetadataName(path.basename(source));
      },
    });

    const nativeReader = await preparePluginNativeTools(stagingPluginRoot, plugin.manifest);
    const sourceBuild = plugin.manifest.scripts?.node?.build;
    const declaredBuildImports = plugin.manifest.buildConfig?.buildImports ?? [];
    if (declaredBuildImports.length > 0 && !sourceBuild) {
      throw new Error(
        `Invalid plugin "${plugin.manifest.name}": buildConfig.buildImports requires scripts.node.build.`,
      );
    }
    const buildEnv: NodeJS.ProcessEnv = { ...commandEnv };
    for (const key of Object.keys(buildEnv)) if (key.toUpperCase() === 'AW_PLUGIN_NATIVE_READER') delete buildEnv[key];
    if (nativeReader) buildEnv.AW_PLUGIN_NATIVE_READER = nativeReader;
    const buildImportProvenance: RuntimeImportProvenance[] = [];
    const buildImportProjections: BuildImportProjection[] = [];
    for (const buildImport of declaredBuildImports) {
      if (!resolver) {
        throw new Error(
          `Cannot resolve buildConfig.buildImports for plugin "${plugin.manifest.name}": catalog runtime import resolver is required.`,
        );
      }
      if (Object.hasOwn(commandEnv, buildImport.env)) {
        throw new Error(
          `Invalid buildConfig.buildImports env "${buildImport.env}": refusing to overwrite an existing environment variable.`,
        );
      }
      const resolution = await resolver.resolve({
        consumer: plugin,
        reference: buildImport,
        purpose: 'build',
      });
      const importPath = path.join(stagingRoot, 'build-imports', buildImport.env);
      await fs.ensureDir(path.dirname(importPath));
      await fs.copyFile(resolution.sourcePath, importPath);
      await fs.chmod(importPath, 0o444);
      if (await calculateFileDigest(importPath) !== resolution.sourceDigest) {
        throw new Error(
          `Catalog runtime import "${buildImport.plugin}/${buildImport.export}" changed while it was materialized.`,
        );
      }
      buildEnv[buildImport.env] = importPath;
      const provenance = toRuntimeImportProvenance(resolution);
      buildImportProvenance.push(provenance);
      buildImportProjections.push({
        provenance,
        bindingKey: `${buildImport.plugin}/${buildImport.export}`,
        canonicalSource: resolution.canonicalSource,
      });
    }
    await validateBuildImportProjectionSources(buildImportProjections);
    if (sourceBuild) {
      const sourcePackageRoot = packageRootPath({
        ...plugin,
        rootDir: stagingPluginRoot,
      });
      if (sourcePackageRoot) {
        await runner.installPackageRoot(sourcePackageRoot);
      }
      await runner.runNodeBuild({
        pluginRoot: stagingPluginRoot,
        scriptPath: sourceBuild.path,
        args: sourceBuild.args ?? [],
        env: buildEnv,
      });
      await validateBuildImportProjectionSources(buildImportProjections);
    }

    const stagedPlugin = await readPluginManifest(stagingPluginRoot);
    if (stagedPlugin.manifest.name !== plugin.manifest.name) {
      throw new Error(
        `Invalid scripts.node.build: build changed plugin name from "${plugin.manifest.name}" to "${stagedPlugin.manifest.name}".`,
      );
    }

    const finalPackageRoot = packageRootPath(stagedPlugin);
    if (finalPackageRoot) {
      await runner.installPackageRoot(finalPackageRoot);
      await assertNoProductionInstallScripts(finalPackageRoot);
    }

    const runtimeContext: PreparedPluginRuntimeContext = {
      resolver,
      buildImports: buildImportProvenance,
    };
    preparedBuildImportProjections.set(runtimeContext, buildImportProjections);
    return {
      plugin: stagedPlugin,
      runtimeContext,
      cleanup: () => fs.remove(stagingRoot),
    };
  } catch (error) {
    await fs.remove(stagingRoot);
    throw error;
  }
}

async function resolveBuildPlugin(
  plugin: PluginMeta,
  options: Required<Pick<BundleLocalPluginOptions, 'buildMode' | 'stagingRunner'>>
    & Pick<BundleLocalPluginOptions, 'commandEnv' | 'runtimeResolver' | 'preparedRuntimeContext'>,
): Promise<{
  plugin: PluginMeta;
  runtimeContext: PreparedPluginRuntimeContext;
  cleanup(): Promise<void>;
}> {
  if (options.buildMode === 'prepared') {
    if (
      (
        (plugin.manifest.buildConfig?.buildImports?.length ?? 0) > 0
        || (plugin.manifest.buildConfig?.skillRuntimeFiles ?? []).some((entry) => entry.import)
      )
      && !options.preparedRuntimeContext
    ) {
      throw new Error(
        `Cannot bundle prepared plugin "${plugin.manifest.name}": prepared runtime import context is required.`,
      );
    }
    return {
      plugin,
      runtimeContext: options.preparedRuntimeContext ?? {
        resolver: options.runtimeResolver,
        buildImports: [],
      },
      cleanup: async () => {},
    };
  }

  if (options.buildMode === 'build-free') {
    if (plugin.manifest.scripts?.node || (plugin.manifest.buildConfig?.buildImports?.length ?? 0) > 0) {
      throw new Error(
        `Cannot bundle plugin "${plugin.manifest.name}" in build-free mode because scripts.node requires staging build mode.`,
      );
    }
    return {
      plugin,
      runtimeContext: { resolver: options.runtimeResolver, buildImports: [] },
      cleanup: async () => {},
    };
  }

  return createStagedPlugin(
    plugin,
    options.stagingRunner,
    options.runtimeResolver,
    options.commandEnv,
  );
}

export async function prepareLocalPluginBundleSource(
  plugin: PluginMeta,
  options: Pick<
    BundleLocalPluginOptions,
    'buildMode' | 'stagingRunner' | 'commandEnv' | 'runtimeResolver'
  > = {},
): Promise<{
  plugin: PluginMeta;
  runtimeContext: PreparedPluginRuntimeContext;
  cleanup(): Promise<void>;
}> {
  await assertPluginInputTree(plugin.rootDir);
  const buildOptions = {
    buildMode: options.buildMode ?? 'staging',
    stagingRunner: options.stagingRunner
      ?? createDefaultStagingRunner(options.commandEnv ?? process.env),
    commandEnv: options.commandEnv,
    runtimeResolver: options.runtimeResolver,
    preparedRuntimeContext: undefined,
  };
  return resolveBuildPlugin(plugin, buildOptions);
}

export interface LocalPluginBundleResult {
  outputRoot: string;
  plugin: PluginMeta;
  platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>>;
  runtimeProjection: {
    buildImports: RuntimeImportProvenance[];
    skillRuntimeFiles: SkillRuntimeFileProvenance[];
  };
}

function assertPluginRequirementsSupported(
  pluginName: string,
  requirements: Awaited<ReturnType<typeof resolvePluginRequirements>>,
  strictRequirements = false,
): void {
  if (requirements.unsupportedByCurrentAw.length > 0) {
    throw new AwCapabilityUnsupportedError(pluginName, requirements.unsupportedByCurrentAw);
  }
  if (!strictRequirements) return;
  const satisfied = new Set([...requirements.declared, ...requirements.derived]);
  const strictObservations = requirements.observations.filter((observation) => (
    observation.code !== 'aw-command-detected'
    || observation.capability === undefined
    || !satisfied.has(observation.capability)
  ));
  if (strictObservations.length > 0) {
    const error = new Error(
      `Official strict requirements failed: ${strictObservations.map((observation) => (
        `plugin=${JSON.stringify(pluginName)} path=${JSON.stringify(observation.path)} `
        + `command=${JSON.stringify(observation.command ?? '<dynamic>')} `
        + `capability=${JSON.stringify(observation.capability ?? (
          observation.code === 'aw-command-dynamic' ? '<dynamic>' : '<unmapped>'
        ))}`
      )).join('; ')}`,
    ) as Error & { code: string; observations: typeof strictObservations };
    error.code = 'awCapabilityStrictRequirements';
    error.observations = strictObservations;
    throw error;
  }
}

function assertRequiredCapabilitiesSupported(
  pluginName: string,
  requiredCapabilities: readonly string[],
): void {
  const support = checkAwCapabilitySupport(
    requiredCapabilities,
    IMPLEMENTED_AW_CAPABILITIES,
  );
  if (!support.supported) {
    throw new AwCapabilityUnsupportedError(pluginName, support.missing);
  }
}

export async function bundleLocalPlugin(
  plugin: PluginMeta,
  outputRoot: string,
  options: BundleLocalPluginOptions = {},
): Promise<LocalPluginBundleResult> {
  const historicalComparison = options.runtimeSkillClosureValidation === 'historical';
  plugin = { ...plugin, manifest: validatePluginManifest(plugin.rootDir, plugin.manifest) };
  const buildOptions = {
    buildMode: options.buildMode ?? 'build-free',
    stagingRunner: options.stagingRunner
      ?? createDefaultStagingRunner(options.commandEnv ?? process.env),
    commandEnv: options.commandEnv,
    runtimeResolver: options.runtimeResolver,
    preparedRuntimeContext: options.preparedRuntimeContext,
  };
  await assertPluginInputTree(plugin.rootDir);
  const sourceRequirements = await resolvePluginRequirements({
    pluginRoot: plugin.rootDir,
    manifest: plugin.manifest,
    implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES,
  });
  if (!historicalComparison) {
    assertPluginRequirementsSupported(
      plugin.manifest.name,
      sourceRequirements,
      options.strictRequirements ?? false,
    );
  }
  await fs.remove(outputRoot);
  const buildPlugin = await resolveBuildPlugin(plugin, buildOptions);

  try {
    plugin = buildPlugin.plugin;
    const requirements = buildOptions.buildMode === 'build-free'
      ? sourceRequirements
      : await resolvePluginRequirements({
          pluginRoot: plugin.rootDir,
          manifest: plugin.manifest,
          implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES,
        });
    if (!historicalComparison) {
      assertPluginRequirementsSupported(
        plugin.manifest.name,
        requirements,
        options.strictRequirements ?? false,
      );
    }
    assertManifestPlatformSupport(plugin.manifest.name, plugin.manifest);
    const supportedPlatforms = resolveSupportedPlatforms(plugin.manifest);
    await assertSkillRuntimeProjectionTargets(plugin);
    const skillRuntimeFileProjections = await projectSkillRuntimeFiles({
      plugin,
      outputRoot,
      supportedPlatforms,
      resolver: buildPlugin.runtimeContext.resolver,
    });
    const skillRuntimeFiles = skillRuntimeFileProjections.map(({ provenance }) => provenance);
    const portableRuntimeFiles: PortableRuntimeFileMetadata[] = skillRuntimeFiles
      .filter((entry) => entry.distribution === 'agent-skills')
      .map((entry) => ({
        skill: entry.skill,
        target: entry.target,
        platform: entry.platform,
        path: `./${entry.platform}/skills/${entry.skill}/${entry.target}`,
        digest: entry.targetDigest,
        provider: entry.provider,
        providerVersion: entry.providerVersion,
        exportName: entry.name,
        source: entry.source,
        sourceDigest: entry.sourceDigest,
        requiredCapabilities: entry.requiredCapabilities,
        capabilitySetDigest: entry.capabilitySetDigest,
      }));
    const artifactRuntimeProjection = await resolveArtifactRuntimeImports({
      plugin,
      outputRoot,
      resolver: buildPlugin.runtimeContext.resolver,
    });
    const finalEffective = normalizeAwCapabilities([
      ...requirements.effective,
      ...skillRuntimeFiles.flatMap((entry) => entry.requiredCapabilities),
      ...artifactRuntimeProjection.requiredCapabilities,
    ]);
    if (!historicalComparison) {
      assertRequiredCapabilitiesSupported(plugin.manifest.name, finalEffective);
    }
    artifactRuntimeProjection.manifest.requires = {
      aw: { capabilities: finalEffective },
    };
    const bundleManifest = artifactRuntimeProjection.manifest;

    await fs.ensureDir(outputRoot);
    const platformFiles: Partial<Record<PlatformTarget, Set<string>>> = {};
    const platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>> = {};
    const buildConfig = plugin.manifest.buildConfig;
    const templatePatterns = buildConfig?.templates?.include ?? [];
    const templateVars = buildConfig?.templates?.vars ?? {};

    for (const platform of PLATFORM_ORDER) {
      if (!supportedPlatforms.has(platform)) {
        continue;
      }
      platformFiles[platform] = new Set<string>();
      platformManifests[platform] = createPlatformManifestBase(plugin);
    }

    for (const platform of PLATFORM_ORDER) {
      const manifest = platformManifests[platform];
      const files = platformFiles[platform];
      if (!manifest || !files) {
        continue;
      }

      manifest.skills = await addDeclaredSkillPathFiles(
        plugin,
        platform,
        plugin.manifest.skills,
        files,
      );
      manifest.mcpServers = await addDeclaredPathFiles(
        plugin,
        platform,
        plugin.manifest.mcpServers,
        files,
      );
    }

    for (const platform of supportedPlatforms) {
      await fs.ensureDir(path.join(outputRoot, platform));
      if (platform === 'codex' || platform === 'claude') continue;
      const files = new Set<string>();
      platformFiles[platform] = files;
      if (plugin.manifest.skills) await fs.ensureDir(path.join(outputRoot, platform, 'skills'));
      await addDeclaredSkillPathFiles(plugin, platform, plugin.manifest.skills, files);
      if (plugin.manifest.mcpServers) {
        for (const file of await collectFilesForPath(plugin.rootDir, plugin.manifest.mcpServers)) files.add(file);
      }
    }

    const sourceFiles = (await listFilesRecursively(plugin.rootDir)).filter(
      (filePath) => !isDeclaredSkillAuthorOnlyFile(plugin, filePath),
    );
    for (const platform of supportedPlatforms) {
      const files = platformFiles[platform];
      if (!files) continue;
      const rules = buildConfig?.fileRules?.[platform];
      if (rules) {
        for (const filePath of applyFileRules(
          sourceFiles,
          rules.include, rules.exclude,
        )) {
          files.add(filePath);
        }
        for (const filePath of [...files]) {
          if (applyFileRules([filePath], ['**/*'], rules.exclude).length === 0) files.delete(filePath);
        }
      }
      for (const filePath of files) {
        await copyFileWithTemplateSupport(plugin.rootDir, outputRoot, filePath, platform, templatePatterns, templateVars);
      }
    }

    await materializeSkillRuntimeFiles(skillRuntimeFileProjections);

    if (await fs.pathExists(path.join(plugin.rootDir, 'README.md'))) {
      await copyBundleRootFile(plugin.rootDir, outputRoot, 'README.md');
    }
    for (const filePath of await collectAwRuntimeFiles(plugin)) {
      await copyBundleRootFile(plugin.rootDir, outputRoot, filePath);
    }
    if (plugin.manifest.skills) {
      const collection = stripDotSlash(plugin.manifest.skills);
      for (const file of await collectFilesForPath(plugin.rootDir, collection)) {
        const relative = path.posix.relative(collection, file);
        if (isSkillCollectionAuthorOnlyPath(relative)) continue;
        await copyBundleRootFile(plugin.rootDir, outputRoot, file);
      }
    }
    if (plugin.manifest.mcpServers) {
      await copyBundleRootFile(plugin.rootDir, outputRoot, stripDotSlash(plugin.manifest.mcpServers));
    }
    await copyArtifactSourceDirectories(plugin, outputRoot);
    await copyManagedCommandPackages(plugin, outputRoot);
    await copyProductionPackageRoot(plugin, outputRoot);
    await materializeArtifactRuntimeImports(artifactRuntimeProjection.projections);
    await writeJsonFile(
      path.join(outputRoot, '.agents-plugin', 'plugin.json'),
      bundleManifest,
    );
    if (portableRuntimeFiles.length > 0) {
      await writeJsonFile(
        path.join(outputRoot, '.agents-plugin', 'portable-runtime-files.json'),
        portableRuntimeFiles,
      );
    }
    for (const platform of PLATFORM_ORDER) {
      const manifest = platformManifests[platform];
      if (!manifest) {
        continue;
      }
      await writeJsonFile(
        path.join(outputRoot, PLATFORM_MANIFEST_DIRS[platform], 'plugin.json'),
        manifest,
      );
    }
    await injectRequirementsReceipts({
      outputRoot,
      plugin,
      requiredCapabilities: finalEffective,
    });

    await validateSkillRuntimeProjectionSources(skillRuntimeFileProjections);
    await validateSkillRuntimeProjectionFreshness(
      outputRoot,
      skillRuntimeFiles,
    );
    await validateGeneratedSkillRuntimeFiles(plugin, outputRoot, supportedPlatforms);
    if ((options.runtimeSkillClosureValidation ?? 'current') === 'current') {
      for (const platform of supportedPlatforms) {
        const root = path.join(outputRoot, platform, 'skills');
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
          const skillRoot = path.join(root, entry.name);
          if (platform !== 'codex' && platform !== 'claude') {
            await validatePortableSkillDirectory(skillRoot, { frontmatterProfile: 'claude-current' });
          }
          await validateRuntimeSkillClosure(skillRoot);
        }
      }
    }
    await validateBuildImportProjectionSources(
      preparedBuildImportProjections.get(buildPlugin.runtimeContext) ?? [],
    );

    // Git must retain the skills root declared by a dynamic-only Native bundle.
    for (const platform of PLATFORM_ORDER) {
      const manifest = platformManifests[platform];
      if (!manifest?.skills) continue;
      const skillsRoot = path.join(outputRoot, stripDotSlash(manifest.skills));
      if ((await fs.readdir(skillsRoot)).length === 0) {
        await fs.writeFile(path.join(skillsRoot, '.gitkeep'), '');
      }
    }

    return {
      outputRoot,
      plugin,
      platformManifests,
      runtimeProjection: {
        buildImports: buildPlugin.runtimeContext.buildImports,
        skillRuntimeFiles,
      },
    };
  } catch (error) {
    await fs.remove(outputRoot);
    throw error;
  } finally {
    await buildPlugin.cleanup();
  }
}
