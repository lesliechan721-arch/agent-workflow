import path from 'node:path';

import fs from 'fs-extra';

import type {
  MarketplaceManifest,
  PlatformName,
  PluginMeta,
  PlatformPluginManifest,
  PluginLifecycleScriptEntry,
  PluginManifestSource,
} from '../types.js';
import {
  assertActualNativePluginCapability,
  assertStrictSemVer,
  validatePluginManifest,
} from './manifest.js';
import { readJsonFile } from './json.js';
import { readMarketplaceManifestAtPath } from './marketplace.js';
import { resolveSupportedPlatforms } from './platform-support.js';
import {
  validateRenderedClaudeHooksContent,
  validateRenderedCodexHooksContent,
} from './rendered-contract.js';
import { scanNodeImportContract } from './plugin-script-contract.js';
import { getArtifactSourceBundleRelativePath } from './artifact-sources.js';
import {
  validatePortableSkillDirectoriesRoot,
  validateSkillDirectory,
} from './dynamic-skill-tree.js';
import { validateRuntimeSkillClosure } from './runtime-skill-closure.js';

const NODE_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
export const CATALOG_MANIFEST_FILENAME = 'catalog-manifest.json';

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertRelativeBundlePath(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): string {
  if (!relativePath.startsWith(expectedPrefix)) {
    throw new Error(`Invalid ${fieldName}: expected path to start with "${expectedPrefix}".`);
  }

  const resolved = path.resolve(pluginRoot, relativePath);
  const relativeToRoot = path.relative(pluginRoot, resolved);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Invalid ${fieldName}: path escapes plugin root.`);
  }

  const expectedRoot = path.resolve(pluginRoot, expectedPrefix);
  if (!isPathInsideOrEqual(expectedRoot, resolved)) {
    throw new Error(`Invalid ${fieldName}: path must stay inside "${expectedPrefix}".`);
  }

  return resolved;
}

async function assertRealBundlePath(
  pluginRoot: string,
  resolvedPath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<string> {
  const realPluginRoot = await fs.realpath(pluginRoot);

  let realResolvedPath: string;
  try {
    realResolvedPath = await fs.realpath(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${fieldName}: unable to resolve symlinks (${message}).`);
  }

  if (!isPathInsideOrEqual(realPluginRoot, realResolvedPath)) {
    throw new Error(`Invalid ${fieldName}: resolved target escapes plugin root.`);
  }

  const expectedRoot = path.resolve(realPluginRoot, stripDotSlash(expectedPrefix));
  if (!isPathInsideOrEqual(expectedRoot, realResolvedPath)) {
    throw new Error(`Invalid ${fieldName}: resolved target must stay inside "${expectedPrefix}".`);
  }

  return realResolvedPath;
}

async function assertBundlePathExists(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  await resolveExistingBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
}

async function resolveExistingBundlePath(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<string> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
  return assertRealBundlePath(pluginRoot, resolved, fieldName, expectedPrefix);
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

async function assertJsonObjectFile(filePath: string, fieldName: string): Promise<Record<string, unknown>> {
  let content: unknown;
  try {
    content = await fs.readJson(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${fieldName}: expected valid JSON (${message}).`);
  }

  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(`Invalid ${fieldName}: expected a JSON object.`);
  }

  return content as Record<string, unknown>;
}

async function assertMcpArtifact(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
  const realResolved = await assertRealBundlePath(pluginRoot, resolved, fieldName, expectedPrefix);
  const content = await assertJsonObjectFile(realResolved, fieldName);
  if (!content.mcpServers || typeof content.mcpServers !== 'object' || Array.isArray(content.mcpServers)) {
    throw new Error(`Invalid ${fieldName}: expected top-level "mcpServers" object.`);
  }
}

async function assertAppsArtifact(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
  const realResolved = await assertRealBundlePath(pluginRoot, resolved, fieldName, expectedPrefix);
  const content = await assertJsonObjectFile(realResolved, fieldName);
  if (!content.apps || typeof content.apps !== 'object' || Array.isArray(content.apps)) {
    throw new Error(`Invalid ${fieldName}: expected top-level "apps" object.`);
  }

  for (const [name, app] of Object.entries(content.apps as Record<string, unknown>)) {
    if (!app || typeof app !== 'object' || Array.isArray(app)) {
      throw new Error(`Invalid ${fieldName}.apps.${name}: expected an object.`);
    }
    const id = (app as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`Invalid ${fieldName}.apps.${name}.id: expected a non-empty string.`);
    }
  }
}

async function assertClaudeHooksArtifact(
  pluginRoot: string,
  relativePath: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, 'claude.hooks', './claude/');
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid claude.hooks: "${relativePath}" does not exist in bundle.`);
  }
  const realResolved = await assertRealBundlePath(pluginRoot, resolved, 'claude.hooks', './claude/');
  const content = await assertJsonObjectFile(realResolved, 'claude.hooks');
  validateRenderedClaudeHooksContent(content, 'claude.hooks');
}

async function validateClaudeManifest(
  pluginRoot: string,
  manifest: PlatformPluginManifest,
  ownerMarkerPolicy: 'reject' | 'ignore',
): Promise<void> {
  const input = manifest as unknown as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (![
      'name',
      'version',
      'description',
      'compatibility',
      'skills',
      'mcpServers',
      'interface',
      'agents',
      'hooks',
      'commands',
      'outputStyles',
      'lspServers',
      'userConfig',
      'channels',
    ].includes(key)) {
      throw new Error(`Invalid claude manifest: unknown field "${key}".`);
    }
  }
  assertStrictSemVer(manifest.version, 'claude manifest.version');
  assertStrictSemVer(manifest.compatibility.aw.minVersion, 'claude manifest.compatibility.aw.minVersion');

  if (manifest.skills) {
    await validateClaudeSkillsTree(pluginRoot, manifest.skills, ownerMarkerPolicy);
  }
  if (manifest.commands) {
    await assertBundlePathExists(pluginRoot, manifest.commands, 'claude.commands', './claude/');
  }
  if (manifest.hooks) {
    if (typeof manifest.hooks !== 'string') {
      throw new Error('Invalid claude.hooks: expected a bundle-local path string.');
    }
    await assertClaudeHooksArtifact(pluginRoot, manifest.hooks);
  }
  if (manifest.mcpServers) {
    await assertMcpArtifact(pluginRoot, manifest.mcpServers, 'claude.mcpServers', './claude/');
  }
  if (manifest.outputStyles) {
    await assertBundlePathExists(
      pluginRoot,
      manifest.outputStyles,
      'claude.outputStyles',
      './claude/',
    );
  }
  if (manifest.agents) {
    for (const [index, agentPath] of manifest.agents.entries()) {
      await assertBundlePathExists(
        pluginRoot,
        agentPath,
        `claude.agents[${index}]`,
        './claude/',
      );
    }
  }
  if (manifest.lspServers) {
    if (typeof manifest.lspServers === 'string') {
      await assertBundlePathExists(
        pluginRoot,
        manifest.lspServers,
        'claude.lspServers',
        './claude/',
      );
    } else if (Array.isArray(manifest.lspServers)) {
      for (const [index, entry] of manifest.lspServers.entries()) {
        if (typeof entry === 'string') {
          await assertBundlePathExists(
            pluginRoot,
            entry,
            `claude.lspServers[${index}]`,
            './claude/',
          );
        }
      }
    }
  }
}

async function validateCodexManifest(
  pluginRoot: string,
  manifest: PlatformPluginManifest,
  ownerMarkerPolicy: 'reject' | 'ignore',
): Promise<void> {
  const input = manifest as unknown as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (![
      'name',
      'version',
      'description',
      'compatibility',
      'skills',
      'mcpServers',
      'apps',
      'interface',
      'hooks',
    ].includes(key)) {
      throw new Error(`Invalid codex manifest: unknown field "${key}".`);
    }
  }
  assertStrictSemVer(manifest.version, 'codex manifest.version');
  assertStrictSemVer(manifest.compatibility.aw.minVersion, 'codex manifest.compatibility.aw.minVersion');

  if (manifest.skills) {
    await validateCodexSkillsTree(pluginRoot, manifest.skills, ownerMarkerPolicy);
  }
  if (manifest.mcpServers) {
    await assertMcpArtifact(pluginRoot, manifest.mcpServers, 'codex.mcpServers', './codex/');
  }
  if (manifest.apps) {
    await assertAppsArtifact(pluginRoot, manifest.apps, 'codex.apps', './codex/');
  }
  if (manifest.hooks) {
    if (typeof manifest.hooks === 'string') {
      throw new Error('Invalid codex.hooks: expected an inline hooks object.');
    }
    validateRenderedCodexHooksContent(manifest.hooks, 'codex.hooks');
  }
}

async function listSkillDirectories(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const symbolicLink = entries.find((entry) => entry.isSymbolicLink());
  if (symbolicLink) {
    throw new Error(
      `Invalid skills root: symbolic links are not supported: "${symbolicLink.name}".`,
    );
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function resolveSkillsCollectionRoot(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<string> {
  const lexicalRoot = assertRelativeBundlePath(
    pluginRoot,
    relativePath,
    fieldName,
    expectedPrefix,
  );
  let stats: fs.Stats;
  try {
    stats = await fs.lstat(lexicalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Invalid ${fieldName}: skills root must be a regular directory.`);
  }
  return assertRealBundlePath(pluginRoot, lexicalRoot, fieldName, expectedPrefix);
}

async function assertSkillEntryExists(
  skillRoot: string,
  skillName: string,
  relativePath: string,
  fieldName: string,
): Promise<void> {
  if (!(await fs.pathExists(path.join(skillRoot, relativePath)))) {
    throw new Error(`Invalid ${fieldName}: skill "${skillName}" is missing ${relativePath}.`);
  }
}

async function validateClaudeSkillsTree(
  pluginRoot: string,
  relativePath: string,
  ownerMarkerPolicy: 'reject' | 'ignore',
): Promise<void> {
  const skillsRoot = await resolveSkillsCollectionRoot(
    pluginRoot,
    relativePath,
    'claude.skills',
    './claude/',
  );
  for (const skillName of await listSkillDirectories(skillsRoot)) {
    const skillRoot = path.join(skillsRoot, skillName);
    await assertSkillEntryExists(skillRoot, skillName, 'SKILL.md', 'claude.skills');
    await validateRuntimeSkillClosure(skillRoot);
    await validateSkillDirectory(skillRoot, 'claude.skill', { ownerMarkerPolicy });
  }
}

async function validateCodexSkillsTree(
  pluginRoot: string,
  relativePath: string,
  ownerMarkerPolicy: 'reject' | 'ignore',
): Promise<void> {
  const skillsRoot = await resolveSkillsCollectionRoot(
    pluginRoot,
    relativePath,
    'codex.skills',
    './codex/',
  );
  for (const skillName of await listSkillDirectories(skillsRoot)) {
    const skillRoot = path.join(skillsRoot, skillName);
    await assertSkillEntryExists(skillRoot, skillName, 'SKILL.md', 'codex.skills');
    await assertSkillEntryExists(
      skillRoot,
      skillName,
      path.join('agents', 'openai.yaml'),
      'codex.skills',
    );
    await validateRuntimeSkillClosure(skillRoot);
    await validateSkillDirectory(skillRoot, 'codex.skill', { ownerMarkerPolicy });
  }
}

function isNodeRuntimeEntry(entry: PluginLifecycleScriptEntry): boolean {
  return entry.runner === 'node' || (
    entry.runner === 'auto' &&
    NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase())
  );
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
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

async function readJsonObject(filePath: string, fieldName: string): Promise<Record<string, unknown>> {
  const content = await assertJsonObjectFile(filePath, fieldName);
  return content;
}

function readDependencyNames(packageJson: Record<string, unknown>, fieldName: string): string[] {
  const dependencies = packageJson[fieldName];
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return [];
  }

  return Object.keys(dependencies as Record<string, unknown>).sort();
}

async function readPackageRootDependencySets(
  pluginRoot: string,
  manifest: PluginManifestSource,
): Promise<{ dependencies: string[]; devDependencies: string[] }> {
  const packageRoot = manifest.scripts?.node?.packageRoot;
  if (!packageRoot) {
    return { dependencies: [], devDependencies: [] };
  }

  const packageJson = await readJsonObject(
    path.join(pluginRoot, stripDotSlash(packageRoot), 'package.json'),
    'scripts.node.packageRoot.package.json',
  );
  return {
    dependencies: readDependencyNames(packageJson, 'dependencies'),
    devDependencies: readDependencyNames(packageJson, 'devDependencies'),
  };
}

async function validateRuntimeBareImportResolvesInBundle(
  pluginRoot: string,
  manifest: PluginManifestSource,
  bareSpecifiers: readonly string[],
): Promise<void> {
  const packageRoot = manifest.scripts?.node?.packageRoot;
  if (!packageRoot || bareSpecifiers.length === 0) {
    return;
  }

  const absolutePackageRoot = path.join(pluginRoot, stripDotSlash(packageRoot));
  const realPluginRoot = await fs.realpath(pluginRoot);
  for (const specifier of bareSpecifiers) {
    const packageDir = path.join(absolutePackageRoot, 'node_modules', ...specifier.split('/'));
    const realPackageDir = await fs.realpath(packageDir).catch(() => undefined);
    if (!realPackageDir) {
      throw new Error(`Invalid scripts.node runtime import "${specifier}": package is missing from bundle node_modules.`);
    }

    const relativeToPluginRoot = path.relative(realPluginRoot, realPackageDir);
    if (relativeToPluginRoot.startsWith('..') || path.isAbsolute(relativeToPluginRoot)) {
      throw new Error(`Invalid scripts.node runtime import "${specifier}": package resolves outside the bundle.`);
    }
  }
}

async function validateAwRuntimeLayout(
  pluginRoot: string,
  manifest: PluginManifestSource,
): Promise<void> {
  if (manifest.scripts?.tests) {
    throw new Error('Invalid bundle source manifest: scripts.tests must not be included in runtime bundle.');
  }
  if (manifest.scripts?.node?.build) {
    throw new Error('Invalid bundle source manifest: scripts.node.build must not be included in runtime bundle.');
  }

  const portableSkillsRoot = manifest.distributions?.agentSkills?.skills;
  if (portableSkillsRoot) {
    const resolvedRoot = await resolveExistingBundlePath(
      pluginRoot,
      portableSkillsRoot,
      'distributions.agentSkills.skills',
      './',
    );
    const stats = await fs.lstat(path.join(pluginRoot, stripDotSlash(portableSkillsRoot)));
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('Invalid distributions.agentSkills.skills: skills root must be a regular directory.');
    }
    const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    const invalidEntry = entries.find((entry) => entry.isSymbolicLink() || !entry.isDirectory());
    if (invalidEntry) {
      throw new Error(
        `Invalid distributions.agentSkills.skills: direct child ${JSON.stringify(invalidEntry.name)} must be a regular directory.`,
      );
    }
    const trees = await validatePortableSkillDirectoriesRoot(resolvedRoot);
    await Promise.all(trees.map((tree) =>
      validateRuntimeSkillClosure(path.join(resolvedRoot, tree.skillKey))));
  }

  const runtimeFiles = new Set<string>();
  const nodeEntries = new Set<string>();
  const lifecycle = manifest.scripts?.lifecycle;
  if (lifecycle) {
    for (const [event, selector] of Object.entries(lifecycle)) {
      if (!selector) {
        continue;
      }
      for (const [osSelector, entry] of Object.entries(selector)) {
        if (!entry) {
          continue;
        }
        const fieldName = `scripts.lifecycle.${event}.${osSelector}.path`;
        await assertBundlePathExists(pluginRoot, entry.path, fieldName, './');
        const filePath = stripDotSlash(entry.path);
        runtimeFiles.add(filePath);
        if (isNodeRuntimeEntry(entry)) {
          nodeEntries.add(filePath);
        }
      }
    }
  }

  const configHelper = manifest.scripts?.helpers?.config;
  if (configHelper) {
    await assertBundlePathExists(pluginRoot, configHelper, 'scripts.helpers.config', './');
    const filePath = stripDotSlash(configHelper);
    runtimeFiles.add(filePath);
    nodeEntries.add(filePath);
  }

  const artifactRenderer = manifest.scripts?.artifacts?.render;
  if (artifactRenderer) {
    await assertBundlePathExists(
      pluginRoot,
      artifactRenderer.path,
      'scripts.artifacts.render.path',
      './',
    );
    const filePath = stripDotSlash(artifactRenderer.path);
    runtimeFiles.add(filePath);
    nodeEntries.add(filePath);
  }

  for (const [targetIndex, target] of (manifest.artifacts?.targets ?? []).entries()) {
    for (const [sourceIndex] of (target.sourceDirs ?? []).entries()) {
      const relativePath = getArtifactSourceBundleRelativePath({
        platform: target.platform,
        distribution: target.distribution,
        artifactId: target.id,
        index: sourceIndex,
      });
      const stats = await fs.lstat(path.join(pluginRoot, relativePath)).catch(() => null);
      if (!stats?.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `Invalid artifacts.targets[${targetIndex}].sourceDirs[${sourceIndex}]: ` +
            `missing bundled artifact source directory "${relativePath}".`,
        );
      }
    }
  }

  const packageRoot = manifest.scripts?.node?.packageRoot;
  let packageRootDependencySets: { dependencies: string[]; devDependencies: string[] } = {
    dependencies: [],
    devDependencies: [],
  };
  if (packageRoot) {
    await assertBundlePathExists(pluginRoot, `${packageRoot}/package.json`, 'scripts.node.packageRoot.package.json', './');
    await assertBundlePathExists(pluginRoot, `${packageRoot}/pnpm-lock.yaml`, 'scripts.node.packageRoot.pnpm-lock.yaml', './');
    packageRootDependencySets = await readPackageRootDependencySets(pluginRoot, manifest);
    if (packageRootDependencySets.dependencies.length > 0) {
      const nodeModulesPath = path.join(pluginRoot, stripDotSlash(packageRoot), 'node_modules');
      const nodeModulesStats = await fs.stat(nodeModulesPath).catch(() => null);
      if (!nodeModulesStats?.isDirectory()) {
        throw new Error('Invalid scripts.node.packageRoot: missing production node_modules in bundle.');
      }
    }
  }

  if (nodeEntries.size === 0) {
    return;
  }

  const allFiles = await listFilesRecursively(pluginRoot);
  const scanFiles: Record<string, string> = {};
  await Promise.all(
    allFiles
      .filter((filePath) => (
        NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase())
        || path.posix.basename(filePath) === 'package.json'
      ))
      .map(async (filePath) => {
        scanFiles[filePath] = await fs.readFile(path.join(pluginRoot, filePath), 'utf8');
      }),
  );

  const { dependencies, devDependencies } = packageRootDependencySets;
  const scan = scanNodeImportContract({
    files: scanFiles,
    filePaths: allFiles,
    entryFiles: [...nodeEntries],
    dependencies,
    devDependencies,
  });
  if (scan.errors.length > 0) {
    throw new Error(`Invalid scripts.node runtime imports:\n${scan.errors.join('\n')}`);
  }
  for (const filePath of scan.files) {
    runtimeFiles.add(filePath);
    if (!(await fs.pathExists(path.join(pluginRoot, filePath)))) {
      throw new Error(`Invalid scripts.node runtime file: "${filePath}" does not exist in bundle.`);
    }
  }
  await validateRuntimeBareImportResolvesInBundle(pluginRoot, manifest, scan.bareSpecifiers);
}

function formatPlatformLabel(platform: PlatformName): string {
  return platform === 'claude' ? 'Claude' : 'Codex';
}

function formatPluginNameList(pluginNames: Iterable<string>): string {
  const sorted = [...new Set(pluginNames)].sort();
  return sorted.length > 0 ? sorted.join(', ') : '(none)';
}

async function readMarketplaceManifestFromBundle(
  rootDir: string,
  platform: PlatformName,
): Promise<MarketplaceManifest> {
  const manifestPath = path.join(
    rootDir,
    platform === 'claude'
      ? '.claude-plugin/marketplace.json'
      : '.agents/plugins/marketplace.json',
  );
  return readMarketplaceManifestAtPath(
    manifestPath,
    `${formatPlatformLabel(platform)} marketplace manifest`,
  );
}

async function listBundledPluginNames(rootDir: string): Promise<string[]> {
  const pluginsRoot = path.join(rootDir, 'plugins');
  const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function validateMarketplaceEntriesForPlatform(
  marketplace: MarketplaceManifest,
  platform: PlatformName,
  expectedPluginNames: ReadonlySet<string>,
): void {
  const platformLabel = formatPlatformLabel(platform);
  const marketplacePluginNames = new Set<string>();

  for (const pluginEntry of marketplace.plugins) {
    if (pluginEntry.source !== `./plugins/${pluginEntry.name}`) {
      throw new Error(
        `Invalid marketplace source for "${pluginEntry.name}": expected "./plugins/${pluginEntry.name}".`,
      );
    }
    if (marketplacePluginNames.has(pluginEntry.name)) {
      throw new Error(`Invalid ${platformLabel} marketplace entries: duplicate plugin "${pluginEntry.name}".`);
    }
    if (Object.hasOwn(pluginEntry as unknown as Record<string, unknown>, 'dependencies')) {
      throw new Error(`Invalid marketplace entry for "${pluginEntry.name}": unknown field "dependencies".`);
    }
    marketplacePluginNames.add(pluginEntry.name);
  }

  if (marketplacePluginNames.size !== expectedPluginNames.size) {
    throw new Error(
      `Invalid ${platformLabel} marketplace entries: expected supported plugins [${formatPluginNameList(expectedPluginNames)}], received [${formatPluginNameList(marketplacePluginNames)}].`,
    );
  }

  for (const pluginName of expectedPluginNames) {
    if (!marketplacePluginNames.has(pluginName)) {
      throw new Error(
        `Invalid ${platformLabel} marketplace entries: expected supported plugins [${formatPluginNameList(expectedPluginNames)}], received [${formatPluginNameList(marketplacePluginNames)}].`,
      );
    }
  }
}

export async function validateBundleLayout(
  rootDir: string,
  options?: { ownerMarkerPolicy?: 'reject' | 'ignore' },
): Promise<void> {
  const ownerMarkerPolicy = options?.ownerMarkerPolicy ?? 'reject';
  const [claudeMarketplace, codexMarketplace, bundledPluginNames] = await Promise.all([
    readMarketplaceManifestFromBundle(rootDir, 'claude'),
    readMarketplaceManifestFromBundle(rootDir, 'codex'),
    listBundledPluginNames(rootDir),
  ]);
  const supportedPluginNamesByPlatform: Record<PlatformName, Set<string>> = {
    claude: new Set<string>(),
    codex: new Set<string>(),
  };
  const pluginMetas: PluginMeta[] = [];

  for (const pluginName of bundledPluginNames) {
    const pluginRoot = path.join(rootDir, 'plugins', pluginName);
    const sourceManifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    if (!(await fs.pathExists(sourceManifestPath))) {
      throw new Error(
        `Invalid bundle layout: plugin "${pluginName}" is missing .agents-plugin/plugin.json.`,
      );
    }

    const sourceManifest = validatePluginManifest(
      pluginRoot,
      await readJsonFile<unknown>(sourceManifestPath),
    );
    pluginMetas.push({
      rootDir: pluginRoot,
      manifestPath: sourceManifestPath,
      manifest: sourceManifest,
    });
    await validateAwRuntimeLayout(pluginRoot, sourceManifest);

    const supportedPlatforms = resolveSupportedPlatforms(sourceManifest);
    for (const platform of ['claude', 'codex'] as const) {
      const platformLabel = formatPlatformLabel(platform);
      const manifestDir = path.join(pluginRoot, `.${platform}-plugin`);
      const manifestPath = path.join(manifestDir, 'plugin.json');
      const runtimeDir = path.join(pluginRoot, platform);

      if (supportedPlatforms.has(platform)) {
        supportedPluginNamesByPlatform[platform].add(pluginName);
        if (!(await fs.pathExists(manifestPath))) {
          throw new Error(
            `Invalid bundle layout: missing supported ${platformLabel} manifest for plugin "${pluginName}".`,
          );
        }

        const platformManifest = await readJsonFile<PlatformPluginManifest>(manifestPath);
        if (platform === 'claude') {
          await validateClaudeManifest(pluginRoot, platformManifest, ownerMarkerPolicy);
        } else {
          await validateCodexManifest(pluginRoot, platformManifest, ownerMarkerPolicy);
        }
        continue;
      }

      if ((await fs.pathExists(manifestDir)) || (await fs.pathExists(runtimeDir))) {
        throw new Error(
          `Invalid bundle layout: unexpected ${platformLabel} bundle files for unsupported platform in plugin "${pluginName}".`,
        );
      }
    }
    await assertActualNativePluginCapability(pluginRoot, sourceManifest, 'bundle');
  }

  validateMarketplaceEntriesForPlatform(
    claudeMarketplace,
    'claude',
    supportedPluginNamesByPlatform.claude,
  );
  validateMarketplaceEntriesForPlatform(
    codexMarketplace,
    'codex',
    supportedPluginNamesByPlatform.codex,
  );
}
