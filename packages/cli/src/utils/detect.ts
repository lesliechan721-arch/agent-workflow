import fs from 'fs-extra';

import type {
  EnvironmentDetection,
  PlatformDetection,
  PlatformName,
  Scope,
} from '../types.js';
import {
  resolveClaudePaths,
  resolveCodexPaths,
} from './paths.js';

async function detectScopes(
  pathsByScope: Record<Scope, string[]>,
): Promise<Scope[]> {
  const scopes: Scope[] = [];

  for (const scope of ['project', 'user'] as const) {
    for (const candidatePath of pathsByScope[scope]) {
      if (await fs.pathExists(candidatePath)) {
        scopes.push(scope);
        break;
      }
    }
  }

  return scopes;
}

async function detectFromPaths(
  envFlag: string | undefined,
  pathsByScope: Record<Scope, string[]>,
  missingReason: string,
): Promise<PlatformDetection> {
  const scopes = await detectScopes(pathsByScope);

  if (envFlag === '1') {
    return {
      available: true,
      scopes,
      preferredScope: scopes[0],
    };
  }

  if (scopes.length > 0) {
    return {
      available: true,
      scopes,
      preferredScope: scopes[0],
    };
  }

  return {
    available: false,
    scopes: [],
    reason: missingReason,
  };
}

export async function detectEnvironment(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvironmentDetection> {
  const claudeProjectPaths = resolveClaudePaths(cwd, 'project', env);
  const claudeUserPaths = resolveClaudePaths(cwd, 'user', env);
  const codexProjectPaths = resolveCodexPaths(cwd, 'project', env);
  const codexUserPaths = resolveCodexPaths(cwd, 'user', env);

  const [claude, codex] = await Promise.all([
    detectFromPaths(
      env.AW_FORCE_CLAUDE_AVAILABLE,
      {
        project: [claudeProjectPaths.configDir, claudeProjectPaths.settingsPath],
        user: [claudeUserPaths.configDir, claudeUserPaths.settingsPath],
      },
      'Claude config directory was not found.',
    ),
    detectFromPaths(
      env.AW_FORCE_CODEX_AVAILABLE,
      {
        project: [
          codexProjectPaths.configDir,
          codexProjectPaths.instructionsPath,
          codexProjectPaths.hooksPath,
        ],
        user: [
          codexUserPaths.configDir,
          codexUserPaths.instructionsPath,
          codexUserPaths.hooksPath,
          codexUserPaths.registryConfigPath,
        ],
      },
      'Codex config directory was not found.',
    ),
  ]);

  return { claude, codex };
}

export function listDetectedPlatforms(detection: EnvironmentDetection): PlatformName[] {
  const platforms: PlatformName[] = [];
  if (detection.codex.available) {
    platforms.push('codex');
  }
  if (detection.claude.available) {
    platforms.push('claude');
  }
  return platforms;
}
