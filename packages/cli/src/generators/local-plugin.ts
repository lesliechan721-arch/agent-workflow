import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import { renderResolvedHooksArtifact } from './hooks.js';
import { buildGeneratedName } from './shared.js';
import { applyFileRules } from '../utils/file-rules.js';
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
import {
  renderClaudeSlashCommand,
  renderCodexSlashCommandOpenAiYaml,
  renderCodexSlashCommandSkillMarkdown,
  resolveSlashCommands,
} from '../utils/slash-commands.js';
import type {
  AgentDefinition,
  PluginLifecycleScriptEntry,
  PlatformName,
  PlatformPluginManifest,
  PluginMeta,
} from '../types.js';

const execFileAsync = promisify(execFile);
const NODE_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const INSTALL_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const PLATFORM_ORDER: readonly PlatformName[] = ['claude', 'codex'];
const PLATFORM_MANIFEST_DIRS: Readonly<Record<PlatformName, string>> = {
  claude: '.claude-plugin',
  codex: '.codex-plugin',
};

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
  }): Promise<void>;
}

export interface BundleLocalPluginOptions {
  buildMode?: PluginBundleBuildMode;
  stagingRunner?: PluginStagingRunner;
}

const defaultStagingRunner: PluginStagingRunner = {
  async installPackageRoot(packageRoot) {
    await execFileAsync('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: packageRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
  },
  async runNodeBuild({ pluginRoot, scriptPath, args }) {
    await execFileAsync(process.execPath, [path.join(pluginRoot, stripDotSlash(scriptPath)), ...args], {
      cwd: pluginRoot,
      env: process.env,
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

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
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
    if (entry.name === 'node_modules' || entry.name === '.git') {
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
          artifactId: target.id,
          index: sourceIndex,
        })),
        {
          overwrite: true,
          dereference: false,
          filter: (source) => !isSkillAuthorOnlyPath(path.relative(sourcePath, source)),
        },
      );
    }
  }
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
  const files = await collectFilesForPath(plugin.rootDir, relativePath);
  for (const filePath of files) {
    const skillCollectionPath = path.posix.relative(
      root.split(path.sep).join('/'),
      filePath.split(path.sep).join('/'),
    );
    if (!isSkillCollectionAuthorOnlyPath(skillCollectionPath)) {
      targetFiles.add(filePath);
    }
  }
  return toPlatformRelativePath(relativePath, platform);
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
  if (plugin.manifest.skills) {
    const staticRoot = stripDotSlash(plugin.manifest.skills).split(path.sep).join('/');
    const staticRelative = relativePathInside(staticRoot, normalizedFile);
    if (staticRelative && isSkillCollectionAuthorOnlyPath(staticRelative)) return true;
  }
  for (const target of plugin.manifest.artifacts?.targets ?? []) {
    if (target.target !== 'codex.skill') continue;
    for (const sourceDir of target.sourceDirs ?? []) {
      const dynamicRoot = stripDotSlash(sourceDir).split(path.sep).join('/');
      const dynamicRelative = relativePathInside(dynamicRoot, normalizedFile);
      if (dynamicRelative && isSkillAuthorOnlyPath(dynamicRelative)) return true;
    }
  }
  return false;
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
  const jsFiles: Record<string, string> = {};
  await Promise.all(
    allFiles
      .filter((filePath) => NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase()))
      .map(async (filePath) => {
        jsFiles[filePath] = await fs.readFile(path.join(plugin.rootDir, filePath), 'utf8');
      }),
  );

  const { dependencies, devDependencies } = await readPackageRootDependencySets(plugin);
  const scan = scanNodeImportContract({
    files: jsFiles,
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
  packageName: string;
  packageDir: string;
  packageJson: Record<string, unknown>;
}

async function collectInstalledDependencyClosure(
  packageRoot: string,
  rootDependencies: string[],
): Promise<InstalledDependencyPackage[]> {
  const queue = rootDependencies.map((dependencyName) => ({
    packageName: dependencyName,
    importerDir: packageRoot,
  }));
  const visited = new Set<string>();
  const packages: InstalledDependencyPackage[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }

    const dependencyDir = await findInstalledPackageDir(packageRoot, next.importerDir, next.packageName);
    if (!dependencyDir) {
      throw new Error(`Invalid scripts.node.packageRoot: missing production dependency "${next.packageName}" in node_modules.`);
    }
    if (visited.has(dependencyDir)) {
      continue;
    }
    visited.add(dependencyDir);

    const packageJson = await readJsonObject(
      path.join(dependencyDir, 'package.json'),
      `${next.packageName} package.json`,
    );
    packages.push({
      packageName: next.packageName,
      packageDir: dependencyDir,
      packageJson,
    });

    for (const childDependency of readDependencyNames(packageJson, 'dependencies')) {
      queue.push({
        packageName: childDependency,
        importerDir: dependencyDir,
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

function resolvePnpmPackageInstanceRoot(
  sourceNodeModules: string,
  packageDir: string,
): { source: string; targetRelativePath: string } | undefined {
  const relativePath = path.relative(sourceNodeModules, packageDir);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const segments = relativePath.split(path.sep);
  if (segments[0] !== '.pnpm' || !segments[1] || segments[2] !== 'node_modules') {
    return undefined;
  }

  return {
    source: path.join(sourceNodeModules, '.pnpm', segments[1]),
    targetRelativePath: path.join('.pnpm', segments[1]),
  };
}

async function copyProductionDependencyClosure(
  sourcePackageRoot: string,
  targetPackageRoot: string,
): Promise<void> {
  const sourceNodeModules = path.join(sourcePackageRoot, 'node_modules');
  const targetNodeModules = path.join(targetPackageRoot, 'node_modules');
  const sourceNodeModulesReal = await fs.realpath(sourceNodeModules);
  const productionDependencies = await readProductionDependencyClosure(sourcePackageRoot);
  const copiedPnpmInstances = new Set<string>();

  await fs.remove(targetNodeModules);
  await fs.ensureDir(targetNodeModules);

  for (const dependency of productionDependencies) {
    const pnpmInstanceRoot = resolvePnpmPackageInstanceRoot(
      sourceNodeModulesReal,
      dependency.packageDir,
    );
    if (pnpmInstanceRoot && !copiedPnpmInstances.has(pnpmInstanceRoot.source)) {
      copiedPnpmInstances.add(pnpmInstanceRoot.source);
      await fs.copy(
        pnpmInstanceRoot.source,
        path.join(targetNodeModules, pnpmInstanceRoot.targetRelativePath),
        { dereference: false },
      );
    }

    const sourceTopLevelPackage = path.join(sourceNodeModules, ...dependency.packageName.split('/'));
    const sourceTopLevelReal = await fs.realpath(sourceTopLevelPackage).catch(() => undefined);
    if (sourceTopLevelReal !== dependency.packageDir) {
      continue;
    }

    const targetTopLevelPackage = path.join(targetNodeModules, ...dependency.packageName.split('/'));
    await fs.ensureDir(path.dirname(targetTopLevelPackage));
    await fs.copy(sourceTopLevelPackage, targetTopLevelPackage, { dereference: false });
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

async function createStagedPlugin(
  plugin: PluginMeta,
  runner: PluginStagingRunner,
): Promise<{ plugin: PluginMeta; cleanup(): Promise<void> }> {
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
        return path.basename(source) !== 'node_modules';
      },
    });

    const sourceBuild = plugin.manifest.scripts?.node?.build;
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
      });
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

    return {
      plugin: stagedPlugin,
      cleanup: () => fs.remove(stagingRoot),
    };
  } catch (error) {
    await fs.remove(stagingRoot);
    throw error;
  }
}

async function resolveBuildPlugin(
  plugin: PluginMeta,
  options: Required<Pick<BundleLocalPluginOptions, 'buildMode' | 'stagingRunner'>>,
): Promise<{ plugin: PluginMeta; cleanup(): Promise<void> }> {
  if (options.buildMode === 'prepared') {
    return { plugin, cleanup: async () => {} };
  }

  if (options.buildMode === 'build-free') {
    if (plugin.manifest.scripts?.node) {
      throw new Error(
        `Cannot bundle plugin "${plugin.manifest.name}" in build-free mode because scripts.node requires staging build mode.`,
      );
    }
    return { plugin, cleanup: async () => {} };
  }

  return createStagedPlugin(plugin, options.stagingRunner);
}

export async function prepareLocalPluginBundleSource(
  plugin: PluginMeta,
  options: Pick<BundleLocalPluginOptions, 'buildMode' | 'stagingRunner'> = {},
): Promise<{ plugin: PluginMeta; cleanup(): Promise<void> }> {
  const buildOptions = {
    buildMode: options.buildMode ?? 'staging',
    stagingRunner: options.stagingRunner ?? defaultStagingRunner,
  };
  return resolveBuildPlugin(plugin, buildOptions);
}

export interface LocalPluginBundleResult {
  outputRoot: string;
  plugin: PluginMeta;
  platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>>;
}

export async function bundleLocalPlugin(
  plugin: PluginMeta,
  outputRoot: string,
  options: BundleLocalPluginOptions = {},
): Promise<LocalPluginBundleResult> {
  const buildOptions = {
    buildMode: options.buildMode ?? 'build-free',
    stagingRunner: options.stagingRunner ?? defaultStagingRunner,
  };
  const buildPlugin = await resolveBuildPlugin(plugin, buildOptions);
  plugin = buildPlugin.plugin;
  assertManifestPlatformSupport(plugin.manifest.name, plugin.manifest);

  await fs.remove(outputRoot);
  await fs.ensureDir(outputRoot);

  try {
    const supportedPlatforms = resolveSupportedPlatforms(plugin.manifest);
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
        sourceFiles,
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
        sourceFiles,
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

    for (const filePath of await collectAwRuntimeFiles(plugin)) {
      await copyBundleRootFile(plugin.rootDir, outputRoot, filePath);
    }
    await copyArtifactSourceDirectories(plugin, outputRoot);
    await copyProductionPackageRoot(plugin, outputRoot);

    await writeJsonFile(
      path.join(outputRoot, '.agents-plugin', 'plugin.json'),
      createBundleSourceManifest(plugin),
    );
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

    return {
      outputRoot,
      plugin,
      platformManifests,
    };
  } finally {
    await buildPlugin.cleanup();
  }
}
