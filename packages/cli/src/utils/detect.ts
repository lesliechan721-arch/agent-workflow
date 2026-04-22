import path from 'node:path';

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

async function pathExistsAndExecutable(filePath: string): Promise<boolean> {
  if (!(await fs.pathExists(filePath))) {
    return false;
  }

  if (process.platform === 'win32') {
    return true;
  }

  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(
  commandNames: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const searchPath = env.PATH;
  if (!searchPath) {
    return undefined;
  }

  const pathEntries = searchPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [''];

  for (const directory of pathEntries) {
    for (const commandName of commandNames) {
      const candidates = process.platform === 'win32'
        ? extensions.map((extension) =>
            commandName.toLowerCase().endsWith(extension.toLowerCase())
              ? commandName
              : `${commandName}${extension}`,
          )
        : [commandName];

      for (const candidate of candidates) {
        const executablePath = path.join(directory, candidate);
        if (await pathExistsAndExecutable(executablePath)) {
          return executablePath;
        }
      }
    }
  }

  return undefined;
}

async function detectInstalledPlatform(
  envFlag: string | undefined,
  commandNames: string[],
  pathsByScope: Record<Scope, string[]>,
  missingReason: string,
  env: NodeJS.ProcessEnv,
): Promise<PlatformDetection> {
  const scopes = await detectScopes(pathsByScope);

  if (envFlag === '1') {
    return {
      available: true,
      scopes,
      preferredScope: scopes[0],
    };
  }

  if (await findExecutable(commandNames, env)) {
    return {
      available: true,
      scopes,
      preferredScope: scopes[0],
    };
  }

  return {
    available: false,
    scopes,
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
    detectInstalledPlatform(
      env.AW_FORCE_CLAUDE_AVAILABLE,
      ['claude'],
      {
        project: [claudeProjectPaths.configDir, claudeProjectPaths.settingsPath],
        user: [claudeUserPaths.configDir, claudeUserPaths.settingsPath],
      },
      'Claude executable was not found in PATH.',
      env,
    ),
    detectInstalledPlatform(
      env.AW_FORCE_CODEX_AVAILABLE,
      ['codex'],
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
      'Codex executable was not found in PATH.',
      env,
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
