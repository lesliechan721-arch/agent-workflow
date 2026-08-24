import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import { renderResolvedHooksArtifact } from './hooks.js';
import { buildGeneratedName } from './shared.js';
import { applyFileRules } from '../utils/file-rules.js';
import { calculateFileDigest } from '../utils/bundle-integrity.js';
import type {
  CanonicalRuntimeSourceIdentity,
  CatalogRuntimeExportResolution,
  CatalogRuntimeImportResolver,
} from '../utils/catalog-runtime-projection.js';
import { resolveCanonicalRuntimeSourceIdentity } from '../utils/catalog-runtime-projection.js';
import { getArtifactSourceBundleRelativePath } from '../utils/artifact-sources.js';
import { resolvePlatformHookDefinitions } from '../utils/hooks-contract.js';
import {
  assertManifestPlatformSupport,
  createBundleSourceManifest,
  createPlatformManifestBase,
  normalizePluginRelativePath,
  readPluginManifest,
} from '../utils/manifest.js';
import { writeJsonFile } from '../utils/json.js';
import { resolveSupportedPlatforms } from '../utils/platform-support.js';
import { renderTemplate } from '../utils/template-engine.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import { scanNodeImportContract } from '../utils/plugin-script-contract.js';
import {
  isSkillAuthorOnlyPath,
  isSkillCollectionAuthorOnlyPath,
} from '../utils/skill-authoring.js';
import { assertTestWritablePath } from '../utils/test-path-fence.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import {
  validateRuntimeSkillClosuresRoot,
  validateSkillRuntimeProjectionFreshness,
} from '../utils/runtime-skill-closure.js';
import { validatePortableSkillDirectoriesRoot } from '../utils/dynamic-skill-tree.js';
import {
  renderClaudeSlashCommand,
  renderCodexSlashCommandOpenAiYaml,
  renderCodexSlashCommandSkillMarkdown,
  resolveSlashCommands,
} from '../utils/slash-commands.js';
import type {
  AgentDefinition,
  DistributionName,
  PluginLifecycleScriptEntry,
  PlatformName,
  PlatformPluginManifest,
  PluginMeta,
} from '../types.js';

const execFileAsync = promisify(execFile);
const requireFromCli = createRequire(import.meta.url);
const NODE_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const INSTALL_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const PLATFORM_ORDER: readonly PlatformName[] = ['claude', 'codex'];
const PLATFORM_MANIFEST_DIRS: Readonly<Record<PlatformName, string>> = {
  claude: '.claude-plugin',
  codex: '.codex-plugin',
};

const EXACT_PNPM_PACKAGE_MANAGER_PATTERN = /^pnpm@\d+\.\d+\.\d+$/u;

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
}

export interface SkillRuntimeFileProvenance extends RuntimeImportProvenance {
  platform?: PlatformName;
  distribution?: DistributionName;
  skill: string;
  target: string;
  targetDigest: string;
}

interface SkillRuntimeFileProjection {
  provenance: SkillRuntimeFileProvenance;
  bindingKey: string;
  canonicalSource: CanonicalRuntimeSourceIdentity;
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
  runtimeResolver?: CatalogRuntimeImportResolver;
  preparedRuntimeContext?: PreparedPluginRuntimeContext;
  runtimeSkillClosureValidation?: 'current' | 'historical';
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
  const supportedPackageManager = cliPackageJson.packageManager;
  if (
    typeof supportedPackageManager !== 'string'
    || !EXACT_PNPM_PACKAGE_MANAGER_PATTERN.test(supportedPackageManager)
  ) {
    throw new Error(
      'Invalid @lesliechan721/aw packageManager: expected an exact "pnpm@<version>" declaration.',
    );
  }
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

const defaultStagingRunner: PluginStagingRunner = {
  async installPackageRoot(packageRoot) {
    const supportedPackageManager = await validateStagingPackageManager(packageRoot);
    const fixedPnpmEntry = await resolveFixedPnpmEntry(supportedPackageManager, process.env)
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
      env: process.env,
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

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function toPlatformRelativePath(value: string, platform: PlatformName): string {
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
    if (entry.name === 'node_modules' || entry.name === '.git' || isMacOsMetadataName(entry.name)) {
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

function renderClaudeAgentContent(agent: AgentDefinition): string {
  const frontmatterLines = ['---', `name: ${JSON.stringify(agent.name)}`, `description: ${JSON.stringify(agent.description)}`];
  if (agent.tools && agent.tools.length > 0) {
    frontmatterLines.push('tools:');
    for (const tool of agent.tools) {
      frontmatterLines.push(`  - ${tool}`);
    }
  }
  frontmatterLines.push('---', '');

  return `${frontmatterLines.join('\n')}${agent.prompt.trim()}\n`;
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

async function copyFileWithTemplateSupport(
  pluginRoot: string,
  outputRoot: string,
  sourceRelativePath: string,
  platform: PlatformName,
  templatePatterns: string[],
  templateVars: Record<string, { claude: string | boolean; codex: string | boolean }>,
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
  for (const [targetIndex, target] of (plugin.manifest.artifacts?.targets ?? []).entries()) {
    for (const [sourceIndex, sourceDir] of (target.sourceDirs ?? []).entries()) {
      const sourcePath = path.join(plugin.rootDir, stripDotSlash(sourceDir));
      await assertArtifactSourceTreePortable(
        sourcePath,
        `artifacts.targets[${targetIndex}].sourceDirs[${sourceIndex}]`,
      );
      await fs.copy(
        sourcePath,
        path.join(outputRoot, getArtifactSourceBundleRelativePath({
          platform: target.platform,
          distribution: target.distribution,
          artifactId: target.id,
          index: sourceIndex,
        })),
        {
          overwrite: true,
          dereference: false,
          filter: (source) =>
            !isMacOsMetadataName(path.basename(source))
            && !isSkillAuthorOnlyPath(path.relative(sourcePath, source)),
        },
      );
    }
  }
}

async function copyPortableStaticSkills(plugin: PluginMeta, outputRoot: string): Promise<void> {
  const skillsPath = plugin.manifest.distributions?.agentSkills?.skills;
  if (!skillsPath) return;
  const sourceRoot = path.join(plugin.rootDir, stripDotSlash(skillsPath));
  const targetRoot = path.join(outputRoot, 'agent-skills', 'skills');
  await assertArtifactSourceTreePortable(sourceRoot, 'distributions.agentSkills.skills');
  await fs.copy(sourceRoot, targetRoot, {
    dereference: false,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source).split(path.sep).join('/');
      return !isMacOsMetadataName(path.basename(source))
        && !isSkillCollectionAuthorOnlyPath(relative);
    },
  });
}

async function resolveArtifactRuntimeImports(options: {
  plugin: PluginMeta;
  outputRoot: string;
  resolver?: CatalogRuntimeImportResolver;
}): Promise<PluginMeta['manifest']> {
  const manifest = createBundleSourceManifest(options.plugin);
  for (const [targetIndex, target] of (manifest.artifacts?.targets ?? []).entries()) {
    for (const [importIndex, runtimeImport] of (target.runtimeImports ?? []).entries()) {
      if (!options.resolver) {
        throw new Error(
          `Cannot resolve artifacts.targets[${targetIndex}].runtimeImports[${importIndex}]: catalog runtime import resolver is required.`,
        );
      }
      const resolution = await options.resolver.resolve({
        consumer: options.plugin,
        reference: runtimeImport,
        purpose: 'artifact-runtime',
      });
      const relativePath = `./.agents-plugin/runtime-imports/${target.id}/${runtimeImport.name}`;
      const targetPath = path.join(options.outputRoot, stripDotSlash(relativePath));
      await fs.ensureDir(path.dirname(targetPath));
      await fs.copyFile(resolution.sourcePath, targetPath);
      const digest = await calculateFileDigest(targetPath);
      if (digest !== resolution.sourceDigest) {
        throw new Error(`Artifact runtime import digest mismatch at "${target.id}/${runtimeImport.name}".`);
      }
      runtimeImport.resolved = {
        path: relativePath,
        digest,
        providerPluginId: resolution.provider,
        providerVersion: resolution.providerVersion,
        source: resolution.source,
      };
    }
  }
  if (manifest.distributions?.agentSkills?.skills) {
    manifest.distributions.agentSkills.skills = './agent-skills/skills';
  }
  return manifest;
}

async function copySlashCommandAsset(
  pluginRoot: string,
  outputRoot: string,
  skillName: string,
  sourceRelativePath: string,
  generatedRelativePath: string,
): Promise<void> {
  const sourcePath = path.join(pluginRoot, sourceRelativePath);
  const targetPath = path.join(
    outputRoot,
    'codex',
    'skills',
    skillName,
    stripDotSlash(generatedRelativePath),
  );
  await fs.ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
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
  platform: PlatformName,
  relativePath: string | undefined,
  targetFiles: Set<string>,
): Promise<string | undefined> {
  if (!relativePath) return undefined;
  const root = stripDotSlash(relativePath);
  const dynamicSkillKeys = new Set(
    (plugin.manifest.artifacts?.targets ?? [])
      .filter((target) =>
        target.platform === platform &&
        (target.target === 'codex.skill' || target.target === 'claude.skill') &&
        target.skillKey)
      .map((target) => target.skillKey!),
  );
  const files = await collectFilesForPath(plugin.rootDir, relativePath);
  let added = false;
  for (const filePath of files) {
    const skillCollectionPath = path.posix.relative(
      root.split(path.sep).join('/'),
      filePath.split(path.sep).join('/'),
    );
    const [skillKey] = skillCollectionPath.split('/');
    if (
      !dynamicSkillKeys.has(skillKey ?? '') &&
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
  for (const target of plugin.manifest.artifacts?.targets ?? []) {
    if (
      (target.target !== 'codex.skill' && target.target !== 'claude.skill') ||
      !target.skillKey
    ) continue;
    const dynamicRoot = `skills/${target.skillKey}`;
    const dynamicRelative = relativePathInside(dynamicRoot, normalizedFile);
    if (dynamicRelative && isSkillAuthorOnlyPath(dynamicRelative)) return true;
    for (const sourceDir of target.sourceDirs ?? []) {
      const sourceRelative = relativePathInside(
        stripDotSlash(sourceDir).split(path.sep).join('/'),
        normalizedFile,
      );
      if (sourceRelative && isSkillAuthorOnlyPath(sourceRelative)) return true;
    }
  }
  return false;
}

function isDynamicSkillSourceFile(
  plugin: PluginMeta,
  platform: PlatformName,
  filePath: string,
): boolean {
  const normalizedFile = filePath.split(path.sep).join('/');
  return (plugin.manifest.artifacts?.targets ?? []).some((target) => {
    if (
      target.platform !== platform ||
      (target.target !== 'codex.skill' && target.target !== 'claude.skill') ||
      !target.skillKey
    ) return false;
    return relativePathInside(`skills/${target.skillKey}`, normalizedFile) !== null;
  });
}

async function addDeclaredLspServerFiles(
  plugin: PluginMeta,
  value: PlatformPluginManifest['lspServers'],
  targetFiles: Set<string>,
): Promise<PlatformPluginManifest['lspServers']> {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const normalized = normalizePluginRelativePath(plugin.rootDir, value, 'buildConfig.manifestOverrides.claude.lspServers');
    const files = await collectFilesForPath(plugin.rootDir, normalized);
    for (const filePath of files) {
      targetFiles.add(filePath);
    }
    return toPlatformRelativePath(normalized, 'claude');
  }

  if (Array.isArray(value)) {
    const rendered: Array<string | Record<string, unknown>> = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const normalized = normalizePluginRelativePath(plugin.rootDir, entry, 'buildConfig.manifestOverrides.claude.lspServers');
        const files = await collectFilesForPath(plugin.rootDir, normalized);
        for (const filePath of files) {
          targetFiles.add(filePath);
        }
        rendered.push(toPlatformRelativePath(normalized, 'claude'));
      } else {
        rendered.push(entry);
      }
    }
    return rendered;
  }

  return value;
}

function isNodeRuntimeEntry(entry: PluginLifecycleScriptEntry): boolean {
  return entry.runner === 'node' || (
    entry.runner === 'auto' &&
    NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase())
  );
}

function addLifecycleRuntimeEntries(
  plugin: PluginMeta,
  rootFiles: Set<string>,
  nodeEntries: Set<string>,
): void {
  const lifecycle = plugin.manifest.scripts?.lifecycle;
  if (!lifecycle) {
    return;
  }

  for (const selector of Object.values(lifecycle)) {
    if (!selector) {
      continue;
    }
    for (const entry of Object.values(selector)) {
      if (!entry) {
        continue;
      }
      const filePath = stripDotSlash(entry.path);
      rootFiles.add(filePath);
      if (isNodeRuntimeEntry(entry)) {
        nodeEntries.add(filePath);
      }
    }
  }
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
  });
  if (scan.errors.length > 0) {
    throw new Error(`Invalid scripts.node runtime imports:\n${scan.errors.join('\n')}`);
  }

  return scan.files;
}

async function collectAwRuntimeFiles(plugin: PluginMeta): Promise<string[]> {
  const rootFiles = new Set<string>();
  const nodeEntries = new Set<string>();
  addLifecycleRuntimeEntries(plugin, rootFiles, nodeEntries);
  addHelperRuntimeEntries(plugin, rootFiles, nodeEntries);
  addArtifactRendererRuntimeEntry(plugin, rootFiles, nodeEntries);

  for (const filePath of await collectRuntimeClosureFiles(plugin, [...nodeEntries])) {
    rootFiles.add(filePath);
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
    const roots: string[] = [];
    if (entry.platforms !== undefined || entry.distributions === undefined) {
      roots.push(path.join(plugin.rootDir, 'skills', entry.skill));
    }
    if (entry.distributions?.includes('agent-skills')) {
      const portableRoot = plugin.manifest.distributions?.agentSkills?.skills;
      if (!portableRoot) {
        throw new Error(`Invalid buildConfig.skillRuntimeFiles[${index}].distributions: agent-skills is not declared.`);
      }
      roots.push(path.join(plugin.rootDir, stripDotSlash(portableRoot), entry.skill));
    }
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
  supportedPlatforms: ReadonlySet<PlatformName>,
): Promise<void> {
  for (const [index, entry] of (plugin.manifest.buildConfig?.generatedSkillRuntimeFiles ?? []).entries()) {
    const surfaces: string[] = [];
    if (entry.distributions === undefined) {
      surfaces.push(...supportedPlatforms);
    }
    surfaces.push(...(entry.distributions ?? []));
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
  supportedPlatforms: ReadonlySet<PlatformName>;
  resolver?: CatalogRuntimeImportResolver;
}): Promise<SkillRuntimeFileProjection[]> {
  const projections: SkillRuntimeFileProjection[] = [];
  const claims = new Set<string>();
  for (const [index, entry] of (options.plugin.manifest.buildConfig?.skillRuntimeFiles ?? []).entries()) {
    const surfaces: Array<{ platform?: PlatformName; distribution?: DistributionName }> = [];
    if (entry.platforms !== undefined || entry.distributions === undefined) {
      surfaces.push(...(entry.platforms ?? [...options.supportedPlatforms]).map((platform) => ({ platform })));
    }
    surfaces.push(...(entry.distributions ?? []).map((distribution) => ({ distribution })));
    for (const surface of surfaces) {
      const { platform, distribution } = surface;
      if (platform) {
      if (!options.supportedPlatforms.has(platform)) {
        throw new Error(
          `Invalid buildConfig.skillRuntimeFiles[${index}].platforms: plugin does not support "${platform}".`,
        );
      }
      }
      const claim = `${platform ?? distribution}:${entry.skill}/${entry.target}`;
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
        platform ?? distribution!,
        'skills',
        entry.skill,
        ...entry.target.split('/'),
      );
      if (await fs.pathExists(targetPath)) {
        throw new Error(
          `Invalid buildConfig.skillRuntimeFiles: bundle target already exists at "${claim}".`,
        );
      }
      await fs.ensureDir(path.dirname(targetPath));
      await fs.copyFile(sourcePath, targetPath);
      const targetDigest = await calculateFileDigest(targetPath);
      if (sourceDigest !== targetDigest) {
        throw new Error(`Invalid buildConfig.skillRuntimeFiles: digest mismatch at "${claim}".`);
      }
      projections.push({
        bindingKey,
        canonicalSource,
        provenance: {
          ...runtimeProvenance,
          platform,
          distribution,
          skill: entry.skill,
          target: entry.target,
          targetDigest,
        },
      });
    }
  }
  return projections;
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
        return path.basename(source) !== 'node_modules'
          && !isMacOsMetadataName(path.basename(source));
      },
    });

    const sourceBuild = plugin.manifest.scripts?.node?.build;
    const declaredBuildImports = plugin.manifest.buildConfig?.buildImports ?? [];
    if (declaredBuildImports.length > 0 && !sourceBuild) {
      throw new Error(
        `Invalid plugin "${plugin.manifest.name}": buildConfig.buildImports requires scripts.node.build.`,
      );
    }
    const buildEnv: NodeJS.ProcessEnv = { ...process.env };
    const buildImportProvenance: RuntimeImportProvenance[] = [];
    const buildImportProjections: BuildImportProjection[] = [];
    for (const buildImport of declaredBuildImports) {
      if (!resolver) {
        throw new Error(
          `Cannot resolve buildConfig.buildImports for plugin "${plugin.manifest.name}": catalog runtime import resolver is required.`,
        );
      }
      if (Object.hasOwn(process.env, buildImport.env)) {
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
    & Pick<BundleLocalPluginOptions, 'runtimeResolver' | 'preparedRuntimeContext'>,
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

  return createStagedPlugin(plugin, options.stagingRunner, options.runtimeResolver);
}

export async function prepareLocalPluginBundleSource(
  plugin: PluginMeta,
  options: Pick<BundleLocalPluginOptions, 'buildMode' | 'stagingRunner' | 'runtimeResolver'> = {},
): Promise<{
  plugin: PluginMeta;
  runtimeContext: PreparedPluginRuntimeContext;
  cleanup(): Promise<void>;
}> {
  const buildOptions = {
    buildMode: options.buildMode ?? 'staging',
    stagingRunner: options.stagingRunner ?? defaultStagingRunner,
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

export async function bundleLocalPlugin(
  plugin: PluginMeta,
  outputRoot: string,
  options: BundleLocalPluginOptions = {},
): Promise<LocalPluginBundleResult> {
  const buildOptions = {
    buildMode: options.buildMode ?? 'build-free',
    stagingRunner: options.stagingRunner ?? defaultStagingRunner,
    runtimeResolver: options.runtimeResolver,
    preparedRuntimeContext: options.preparedRuntimeContext,
  };
  await fs.remove(outputRoot);
  const buildPlugin = await resolveBuildPlugin(plugin, buildOptions);

  try {
    plugin = buildPlugin.plugin;
    assertManifestPlatformSupport(plugin.manifest.name, plugin.manifest);
    await fs.ensureDir(outputRoot);
    const supportedPlatforms = resolveSupportedPlatforms(plugin.manifest);
    await assertSkillRuntimeProjectionTargets(plugin);
    const platformFiles: Partial<Record<PlatformName, Set<string>>> = {};
    const platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>> = {};
    const buildConfig = plugin.manifest.buildConfig;
    const templatePatterns = buildConfig?.templates?.include ?? [];
    const templateVars = buildConfig?.templates?.vars ?? {};
    const resolvedSlashCommands = await resolveSlashCommands(plugin.rootDir, plugin.manifest, {
      targetPlatforms: supportedPlatforms,
    });

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

    const codexManifest = platformManifests.codex;
    const codexFiles = platformFiles.codex;
    if (codexManifest && codexFiles) {
      codexManifest.apps = await addDeclaredPathFiles(plugin, 'codex', plugin.manifest.apps, codexFiles);
      const hooksArtifact = renderResolvedHooksArtifact(
        resolvePlatformHookDefinitions(plugin.manifest, 'codex'),
        'codex',
      );
      if (hooksArtifact) {
        codexManifest.hooks = hooksArtifact.content;
      }
    }

    const claudeManifest = platformManifests.claude;
    const claudeFiles = platformFiles.claude;
    if (claudeManifest && claudeFiles) {
      const claudeOverrides = buildConfig?.manifestOverrides?.claude;
      claudeManifest.outputStyles = await addDeclaredPathFiles(
        plugin,
        'claude',
        claudeOverrides?.outputStyles,
        claudeFiles,
      );
      claudeManifest.lspServers = await addDeclaredLspServerFiles(plugin, claudeOverrides?.lspServers, claudeFiles);
      claudeManifest.userConfig = claudeOverrides?.userConfig;
      claudeManifest.channels = claudeOverrides?.channels;

      const hooksArtifact = renderResolvedHooksArtifact(
        resolvePlatformHookDefinitions(plugin.manifest, 'claude'),
        'claude',
      );
      if (hooksArtifact) {
        const hooksPath = path.join(outputRoot, 'claude', 'hooks', 'hooks.json');
        await writeJsonFile(hooksPath, hooksArtifact.content);
        claudeManifest.hooks = './claude/hooks/hooks.json';
      }

      const claudeAgents = resolvePlatformEntries<AgentDefinition>(
        plugin.manifest.extensions?.agents,
        'claude',
      );
      if (claudeAgents.length > 0) {
        claudeManifest.agents = [];
        for (const agent of claudeAgents) {
          const generatedName = buildGeneratedName(plugin.manifest.name, agent.name);
          const relativePath = `./claude/agents/${generatedName}.md`;
          claudeManifest.agents.push(relativePath);
          await writeTextFile(
            path.join(outputRoot, stripDotSlash(relativePath)),
            renderClaudeAgentContent(agent),
          );
        }
      }
    }

    const sourceFiles = (await listFilesRecursively(plugin.rootDir)).filter(
      (filePath) => !isDeclaredSkillAuthorOnlyFile(plugin, filePath),
    );
    if (claudeFiles && buildConfig?.fileRules?.claude) {
      for (const filePath of applyFileRules(
        sourceFiles.filter((filePath) => !isDynamicSkillSourceFile(plugin, 'claude', filePath)),
        buildConfig.fileRules.claude.include,
        buildConfig.fileRules.claude.exclude,
      )) {
        if (
          resolvedSlashCommands &&
          filePath === stripDotSlash(resolvedSlashCommands.rootRelativePath)
        ) {
          continue;
        }
        if (
          resolvedSlashCommands &&
          filePath.startsWith(`${stripDotSlash(resolvedSlashCommands.rootRelativePath)}/`)
        ) {
          continue;
        }
        claudeFiles.add(filePath);
      }
    }
    if (codexFiles && buildConfig?.fileRules?.codex) {
      for (const filePath of applyFileRules(
        sourceFiles.filter((filePath) => !isDynamicSkillSourceFile(plugin, 'codex', filePath)),
        buildConfig.fileRules.codex.include,
        buildConfig.fileRules.codex.exclude,
      )) {
        if (
          resolvedSlashCommands &&
          filePath === stripDotSlash(resolvedSlashCommands.rootRelativePath)
        ) {
          continue;
        }
        if (
          resolvedSlashCommands &&
          filePath.startsWith(`${stripDotSlash(resolvedSlashCommands.rootRelativePath)}/`)
        ) {
          continue;
        }
        codexFiles.add(filePath);
      }
    }

    for (const platform of PLATFORM_ORDER) {
      const files = platformFiles[platform];
      if (!files) {
        continue;
      }
      for (const filePath of files) {
        await copyFileWithTemplateSupport(
          plugin.rootDir,
          outputRoot,
          filePath,
          platform,
          templatePatterns,
          templateVars,
        );
      }
    }

    if (resolvedSlashCommands) {
      if (claudeManifest) {
        claudeManifest.commands = './claude/commands';
      }
      if (codexManifest) {
        codexManifest.skills ??= './codex/skills';
      }

      for (const command of resolvedSlashCommands.commands) {
        if (claudeManifest && command.claude) {
          await writeTextFile(
            path.join(outputRoot, 'claude', 'commands', `${command.name}.md`),
            renderClaudeSlashCommand(command),
          );
        }
        if (codexManifest && command.codex) {
          await writeTextFile(
            path.join(outputRoot, 'codex', 'skills', command.name, 'SKILL.md'),
            renderCodexSlashCommandSkillMarkdown(command),
          );
          await writeTextFile(
            path.join(outputRoot, 'codex', 'skills', command.name, 'agents', 'openai.yaml'),
            renderCodexSlashCommandOpenAiYaml(command),
          );

          for (const asset of command.codex.assets) {
            await copySlashCommandAsset(
              plugin.rootDir,
              outputRoot,
              command.name,
              asset.sourceRelativePath,
              asset.generatedRelativePath,
            );
          }
        }
      }
    }

    const skillRuntimeFileProjections = await projectSkillRuntimeFiles({
      plugin,
      outputRoot,
      supportedPlatforms,
      resolver: buildPlugin.runtimeContext.resolver,
    });
    const skillRuntimeFiles = skillRuntimeFileProjections.map(({ provenance }) => provenance);
    const portableRuntimeFiles = skillRuntimeFiles
      .filter((entry) => entry.distribution === 'agent-skills')
      .map((entry) => ({
        skill: entry.skill,
        target: entry.target,
        path: `./agent-skills/skills/${entry.skill}/${entry.target}`,
        digest: entry.targetDigest,
        provider: entry.provider,
        providerVersion: entry.providerVersion,
        exportName: entry.name,
        source: entry.source,
        sourceDigest: entry.sourceDigest,
      }));

    await copyPortableStaticSkills(plugin, outputRoot);

    if (await fs.pathExists(path.join(plugin.rootDir, 'README.md'))) {
      await copyBundleRootFile(plugin.rootDir, outputRoot, 'README.md');
    }
    for (const filePath of await collectAwRuntimeFiles(plugin)) {
      await copyBundleRootFile(plugin.rootDir, outputRoot, filePath);
    }
    await copyArtifactSourceDirectories(plugin, outputRoot);
    await copyProductionPackageRoot(plugin, outputRoot);

    const bundleManifest = await resolveArtifactRuntimeImports({
      plugin,
      outputRoot,
      resolver: buildPlugin.runtimeContext.resolver,
    });
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

    await validateSkillRuntimeProjectionSources(skillRuntimeFileProjections);
    await validateSkillRuntimeProjectionFreshness(
      outputRoot,
      skillRuntimeFiles.filter((entry): entry is SkillRuntimeFileProvenance & { platform: PlatformName } =>
        entry.platform !== undefined),
    );
    await validateGeneratedSkillRuntimeFiles(plugin, outputRoot, supportedPlatforms);
    if ((options.runtimeSkillClosureValidation ?? 'current') === 'current') {
      for (const platform of PLATFORM_ORDER) {
        const skillsPath = platformManifests[platform]?.skills;
        if (!skillsPath) continue;
        await validateRuntimeSkillClosuresRoot(path.join(outputRoot, stripDotSlash(skillsPath)));
      }
      if (plugin.manifest.distributions?.agentSkills?.skills) {
        await validatePortableSkillDirectoriesRoot(path.join(outputRoot, 'agent-skills', 'skills'));
        await validateRuntimeSkillClosuresRoot(path.join(outputRoot, 'agent-skills', 'skills'));
      }
    }
    await validateBuildImportProjectionSources(
      preparedBuildImportProjections.get(buildPlugin.runtimeContext) ?? [],
    );

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
