import path from 'node:path';

import fs from 'fs-extra';

import type {
  MarketplaceManifest,
  PlatformName,
  PlatformPluginManifest,
  PluginLifecycleScriptEntry,
  PluginManifestSource,
} from '../types.js';
import { validatePluginManifest } from './manifest.js';
import { readJsonFile } from './json.js';
import { resolveSupportedPlatforms } from './platform-support.js';
import { validateRenderedClaudeHooksContent } from './rendered-contract.js';
import { scanNodeImportContract } from './plugin-script-contract.js';

const NODE_RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

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

  return resolved;
}

async function assertBundlePathExists(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
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
  const content = await assertJsonObjectFile(resolved, fieldName);
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
  const content = await assertJsonObjectFile(resolved, fieldName);
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
  const content = await assertJsonObjectFile(resolved, 'claude.hooks');
  validateRenderedClaudeHooksContent(content, 'claude.hooks');
}

async function validateClaudeManifest(
  pluginRoot: string,
  manifest: PlatformPluginManifest,
): Promise<void> {
  if (manifest.skills) {
    await assertBundlePathExists(pluginRoot, manifest.skills, 'claude.skills', './claude/');
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
): Promise<void> {
  if (manifest.skills) {
    await assertBundlePathExists(pluginRoot, manifest.skills, 'codex.skills', './codex/');
  }
  if (manifest.mcpServers) {
    await assertMcpArtifact(pluginRoot, manifest.mcpServers, 'codex.mcpServers', './codex/');
  }
  if (manifest.apps) {
    await assertAppsArtifact(pluginRoot, manifest.apps, 'codex.apps', './codex/');
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

  const packageRoot = manifest.scripts?.node?.packageRoot;
  if (packageRoot) {
    await assertBundlePathExists(pluginRoot, `${packageRoot}/package.json`, 'scripts.node.packageRoot.package.json', './');
    await assertBundlePathExists(pluginRoot, `${packageRoot}/pnpm-lock.yaml`, 'scripts.node.packageRoot.pnpm-lock.yaml', './');
    const nodeModulesPath = path.join(pluginRoot, stripDotSlash(packageRoot), 'node_modules');
    const nodeModulesStats = await fs.stat(nodeModulesPath).catch(() => null);
    if (!nodeModulesStats?.isDirectory()) {
      throw new Error('Invalid scripts.node.packageRoot: missing production node_modules in bundle.');
    }
  }

  if (nodeEntries.size === 0) {
    return;
  }

  const allFiles = await listFilesRecursively(pluginRoot);
  const jsFiles: Record<string, string> = {};
  await Promise.all(
    allFiles
      .filter((filePath) => NODE_RUNTIME_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase()))
      .map(async (filePath) => {
        jsFiles[filePath] = await fs.readFile(path.join(pluginRoot, filePath), 'utf8');
      }),
  );

  const { dependencies, devDependencies } = await readPackageRootDependencySets(pluginRoot, manifest);
  const scan = scanNodeImportContract({
    files: jsFiles,
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
  const manifest = await readJsonFile<unknown>(manifestPath);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid ${formatPlatformLabel(platform)} marketplace manifest: expected an object.`);
  }

  const marketplace = manifest as MarketplaceManifest;
  if (marketplace.name !== 'aw') {
    throw new Error(`Invalid ${formatPlatformLabel(platform)} marketplace manifest.name: expected "aw".`);
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(
      `Invalid ${formatPlatformLabel(platform)} marketplace manifest.plugins: expected an array.`,
    );
  }

  return marketplace;
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

export async function validateBundleLayout(rootDir: string): Promise<void> {
  const [claudeMarketplace, codexMarketplace, bundledPluginNames] = await Promise.all([
    readMarketplaceManifestFromBundle(rootDir, 'claude'),
    readMarketplaceManifestFromBundle(rootDir, 'codex'),
    listBundledPluginNames(rootDir),
  ]);
  const supportedPluginNamesByPlatform: Record<PlatformName, Set<string>> = {
    claude: new Set<string>(),
    codex: new Set<string>(),
  };

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
          await validateClaudeManifest(pluginRoot, platformManifest);
        } else {
          await validateCodexManifest(pluginRoot, platformManifest);
        }
        continue;
      }

      if ((await fs.pathExists(manifestDir)) || (await fs.pathExists(runtimeDir))) {
        throw new Error(
          `Invalid bundle layout: unexpected ${platformLabel} bundle files for unsupported platform in plugin "${pluginName}".`,
        );
      }
    }
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
