import fs from 'fs-extra';

import type {
  EnvironmentDetection,
  PlatformDetection,
  PlatformName,
} from '../types.js';
import {
  resolveClaudePaths,
  resolveCodexPaths,
} from './paths.js';

async function detectFromPaths(
  envFlag: string | undefined,
  candidatePaths: string[],
  missingReason: string,
): Promise<PlatformDetection> {
  if (envFlag === '1') {
    return { available: true };
  }

  for (const candidatePath of candidatePaths) {
    if (await fs.pathExists(candidatePath)) {
      return { available: true };
    }
  }

  return {
    available: false,
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
      [
        claudeProjectPaths.configDir,
        claudeUserPaths.configDir,
        claudeProjectPaths.settingsPath,
        claudeUserPaths.settingsPath,
      ],
      'Claude config directory was not found.',
    ),
    detectFromPaths(
      env.AW_FORCE_CODEX_AVAILABLE,
      [
        codexProjectPaths.configDir,
        codexUserPaths.configDir,
        codexUserPaths.registryConfigPath,
      ],
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
