import os from 'node:os';
import path from 'node:path';

import {
  CLAUDE_MARKETPLACE_PATH,
  CODEX_MARKETPLACE_PATH,
} from '../constants.js';
import type { PlatformName, Scope } from '../types.js';

export interface ClaudePaths {
  platform: 'claude';
  scope: Scope;
  configDir: string;
  settingsPath: string;
  rulesDir: string;
  agentsDir: string;
  knownMarketplacesPath: string;
  marketplaceCacheDir: string;
  trackingDir: string;
}

export interface CodexPaths {
  platform: 'codex';
  scope: Scope;
  configDir: string;
  instructionsPath: string;
  rulesDir: string;
  agentsDir: string;
  hooksPath: string;
  trackingDir: string;
  registryConfigPath: string;
  registryScope: 'user';
}

export function getClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AW_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AW_CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function resolveClaudePaths(
  cwd: string,
  scope: Scope,
  env: NodeJS.ProcessEnv = process.env,
): ClaudePaths {
  const configDir = scope === 'project' ? path.join(cwd, '.claude') : getClaudeHome(env);
  return {
    platform: 'claude',
    scope,
    configDir,
    settingsPath: path.join(configDir, 'settings.json'),
    rulesDir: path.join(configDir, 'rules'),
    agentsDir: path.join(configDir, 'agents'),
    knownMarketplacesPath: path.join(configDir, 'plugins', 'known_marketplaces.json'),
    marketplaceCacheDir: path.join(configDir, 'plugins', 'marketplaces'),
    trackingDir: configDir,
  };
}

export function resolveCodexPaths(
  cwd: string,
  scope: Scope,
  env: NodeJS.ProcessEnv = process.env,
): CodexPaths {
  const configDir = scope === 'project' ? path.join(cwd, '.codex') : getCodexHome(env);
  return {
    platform: 'codex',
    scope,
    configDir,
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
  repoRoot: string,
  platform: PlatformName,
): string {
  return path.join(
    repoRoot,
    platform === 'codex' ? CODEX_MARKETPLACE_PATH : CLAUDE_MARKETPLACE_PATH,
  );
}

export function getMarketplaceManifestPaths(
  repoRoot: string,
): Record<PlatformName, string> {
  return {
    claude: getMarketplaceManifestPath(repoRoot, 'claude'),
    codex: getMarketplaceManifestPath(repoRoot, 'codex'),
  };
}
