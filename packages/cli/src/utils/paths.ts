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

let embeddedPluginsRootOverride: string | null = null;
const validatedEmbeddedPluginRoots = new Set<string>();

export function resolveCliPackageRoot(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = fs.readJsonSync(packageJsonPath) as { name?: string };
      if (packageJson.name === '@yiliang/aw') {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('Unable to resolve @yiliang/aw package root.');
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
  trackingDir: string;
}

export interface CodexPaths {
  platform: 'codex';
  scope: Scope;
  configDir: string;
  configTomlPath: string;
  instructionsPath: string;
  rulesDir: string;
  agentsDir: string;
  hooksPath: string;
  trackingDir: string;
  registryConfigPath: string;
  registryScope: 'user';
}

export function setEmbeddedPluginsRootOverrideForTests(rootDir: string | null): void {
  embeddedPluginsRootOverride = rootDir;
  validatedEmbeddedPluginRoots.clear();
}

export function getClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AW_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AW_CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function resolveAwHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AW_HOME || path.join(os.homedir(), '.aw');
}

export async function resolveAwHomeCanonical(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return realpathOrResolved(resolveAwHome(env));
}

export function resolveClaudePluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getClaudeHome(env), 'plugins');
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
  const configDir = scope === 'project' ? path.join(cwd, '.claude') : getClaudeHome(env);
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
    trackingDir: configDir,
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
    hooksPath: path.join(configDir, 'hooks.json'),
    trackingDir: configDir,
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

async function realpathOrResolved(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export function resolveRepoRootSync(cwd: string): string {
  let currentDir = path.resolve(cwd);

  while (true) {
    const gitDir = path.join(currentDir, '.git');
    const workspaceFile = path.join(currentDir, 'pnpm-workspace.yaml');
    if (fs.pathExistsSync(gitDir) || fs.pathExistsSync(workspaceFile)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return path.resolve(cwd);
    }
    currentDir = parentDir;
  }
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  return resolveRepoRootSync(cwd);
}

export async function resolveClaudeProjectKey(cwd: string): Promise<string> {
  return realpathOrResolved(cwd);
}

export async function resolveCodexProjectKey(cwd: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(cwd);
  return realpathOrResolved(repoRoot);
}
