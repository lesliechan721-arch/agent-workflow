import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import {
  CLAUDE_MARKETPLACE_PATH,
  CODEX_MARKETPLACE_PATH,
} from '../constants.js';
import type { PlatformName, Scope } from '../types.js';
import { validateBundleLayout } from './bundle-layout.js';
import { assertTestWritablePath } from './test-path-fence.js';
import {
  getClaudeHome,
  getCodexHome,
  resolveRepoRootSync,
} from './state-paths.js';
export {
  canonicalizePathThroughExistingAncestor,
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  getClaudeHome,
  getCodexHome,
  resolveAwHome,
  resolveAwHomeCanonical,
  resolveCodexProjectKey,
  resolveRepoRoot,
  resolveRepoRootSync,
} from './state-paths.js';

export async function resolveClaudeProjectKey(cwd: string): Promise<string> {
  const repoRoot = resolveRepoRootSync(cwd);
  return fs.realpath(repoRoot).catch(() => path.resolve(repoRoot));
}

let embeddedPluginsRootOverride: string | null = null;
const validatedEmbeddedPluginRoots = new Set<string>();

function assertWritableHomePathForTests(
  targetPath: string,
  source: string,
  recommendedFix: string,
): string {
  return assertTestWritablePath(targetPath, source, recommendedFix);
}

function assertWritableTempPathForTests(
  targetPath: string,
  source: string,
): string {
  return assertTestWritablePath(
    targetPath,
    source,
    '用 createIsolatedTestEnv() 生成默认 TMPDIR，或通过 registerWritableStateRoot() 登记显式覆盖的临时目录根。',
  );
}

export function resolveCliPackageRoot(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = fs.readJsonSync(packageJsonPath) as { name?: string };
      if (packageJson.name === '@lesliechan721/aw') {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('Unable to resolve @lesliechan721/aw package root.');
    }
    currentDir = parentDir;
  }
}

export interface ClaudePaths {
  platform: 'claude';
  scope: Scope;
  configDir: string;
  settingsPath: string;
  rulesDir: string;
  agentsDir: string;
  knownMarketplacesPath: string;
  installedPluginsPath: string;
  marketplaceCacheDir: string;
}

export interface CodexPaths {
  platform: 'codex';
  scope: Scope;
  configDir: string;
  configTomlPath: string;
  instructionsPath: string;
  rulesDir: string;
  agentsDir: string;
  registryConfigPath: string;
  registryScope: 'user';
}

export function setEmbeddedPluginsRootOverrideForTests(rootDir: string | null): void {
  embeddedPluginsRootOverride = rootDir;
  validatedEmbeddedPluginRoots.clear();
}

export function getEmbeddedPluginsRootOverrideForTests(): string | null {
  return embeddedPluginsRootOverride;
}

export function resolveCliTempRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tempDir = env.TMPDIR || env.TEMP || env.TMP || os.tmpdir();
  const source = env.TMPDIR
    ? 'TMPDIR'
    : env.TEMP
      ? 'TEMP'
      : env.TMP
        ? 'TMP'
        : 'TMPDIR fallback (os.tmpdir())';
  return assertWritableTempPathForTests(
    path.join(assertWritableTempPathForTests(tempDir, source), 'aw-cli'),
    'CLI temporary state root',
  );
}

export function resolveClaudePluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return assertWritableHomePathForTests(
    path.join(getClaudeHome(env), 'plugins'),
    'Claude plugins root',
    '用 createIsolatedTestEnv() 生成默认 AW_CLAUDE_HOME，或通过 registerWritableStateRoot() 登记 Claude plugins 根。',
  );
}

export function getEmbeddedPluginsRootCandidate(): string {
  return embeddedPluginsRootOverride ?? path.join(resolveCliPackageRoot(), 'plugins-dist');
}

export async function resolveEmbeddedPluginsRoot(): Promise<string> {
  const candidate = getEmbeddedPluginsRootCandidate();
  if (validatedEmbeddedPluginRoots.has(candidate)) {
    return candidate;
  }

  try {
    await validateBundleLayout(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (embeddedPluginsRootOverride) {
      throw new Error(`Invalid embedded plugins root override: ${message}`);
    }
    throw new Error(`Embedded plugins root is unavailable; run \`pnpm build\` first. ${message}`);
  }

  validatedEmbeddedPluginRoots.add(candidate);
  return candidate;
}

export async function tryResolveEmbeddedPluginsRoot(): Promise<{
  root: string | null;
  error?: string;
}> {
  try {
    return {
      root: await resolveEmbeddedPluginsRoot(),
    };
  } catch (error) {
    return {
      root: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveClaudePaths(
  cwd: string,
  scope: Scope,
  env: NodeJS.ProcessEnv = process.env,
): ClaudePaths {
  const configDir = scope === 'project'
    ? path.join(fs.realpathSync(resolveRepoRootSync(cwd)), '.claude')
    : getClaudeHome(env);
  const pluginsDir = resolveClaudePluginsDir(env);
  return {
    platform: 'claude',
    scope,
    configDir,
    settingsPath: path.join(configDir, 'settings.json'),
    rulesDir: path.join(configDir, 'rules'),
    agentsDir: path.join(configDir, 'agents'),
    knownMarketplacesPath: path.join(pluginsDir, 'known_marketplaces.json'),
    installedPluginsPath: path.join(pluginsDir, 'installed_plugins.json'),
    marketplaceCacheDir: path.join(pluginsDir, 'marketplaces'),
  };
}

export function resolveCodexPaths(
  cwd: string,
  scope: Scope,
  env: NodeJS.ProcessEnv = process.env,
): CodexPaths {
  const configDir = scope === 'project'
    ? path.join(resolveRepoRootSync(cwd), '.codex')
    : getCodexHome(env);
  const configTomlPath = path.join(configDir, 'config.toml');
  return {
    platform: 'codex',
    scope,
    configDir,
    configTomlPath,
    instructionsPath: path.join(configDir, 'AGENTS.md'),
    rulesDir: path.join(configDir, 'rules'),
    agentsDir: path.join(configDir, 'agents'),
    registryConfigPath: path.join(getCodexHome(env), 'config.toml'),
    registryScope: 'user',
  };
}

export function getMarketplaceManifestPath(
  catalogRoot: string,
  platform: PlatformName,
): string {
  return path.join(
    catalogRoot,
    platform === 'codex' ? CODEX_MARKETPLACE_PATH : CLAUDE_MARKETPLACE_PATH,
  );
}

export function getMarketplaceManifestPaths(
  catalogRoot: string,
): Record<PlatformName, string> {
  return {
    claude: getMarketplaceManifestPath(catalogRoot, 'claude'),
    codex: getMarketplaceManifestPath(catalogRoot, 'codex'),
  };
}
