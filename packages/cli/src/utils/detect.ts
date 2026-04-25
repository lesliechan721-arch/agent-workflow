import path from 'node:path';

import fs from 'fs-extra';

import type {
  EnvironmentDetection,
  InstructionsSessionState,
  PlatformDetection,
  PlatformName,
  ProjectTrust,
  RepoManagedSessionStateReport,
  RepoManagedSessionVisibility,
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

export interface CodexProjectTrustOptions {
  applicable: boolean;
  lookupKeys: string[];
  trustLevels: Record<string, string | undefined>;
  hasProjectLayerArtifacts: boolean;
}

export interface CodexManagedArtifactPresence {
  instructions: boolean;
  rules: boolean;
  hooks: boolean;
  agents: boolean;
  agentRoleNames: string[];
}

export interface CodexHigherPrioritySessionState {
  developerInstructions: boolean;
  rules: boolean;
  hooks: boolean;
  agentRoleNames: string[];
}

export interface DetectCodexSessionStateOptions {
  scope: Scope;
  declarations: {
    instructions: boolean;
    permissions: boolean;
    hooks: boolean;
    agents: boolean;
  };
  managed: CodexManagedArtifactPresence;
  higherPriorityExternal: CodexHigherPrioritySessionState;
  projectLayerDeveloperInstructionsDefined: boolean;
  projectTrust: ProjectTrust;
}

function projectTrustToVisibility(
  projectTrust: ProjectTrust,
): Exclude<RepoManagedSessionVisibility, 'unknownByExternalLayer' | 'absent' | 'not_applicable'> {
  switch (projectTrust) {
    case 'trusted':
      return 'visible';
    case 'untrusted':
      return 'blockedByProjectTrust';
    case 'unknown':
    case 'not_applicable':
    default:
      return 'projectTrustUnknown';
  }
}

export function resolveCodexProjectTrust(
  options: CodexProjectTrustOptions,
): ProjectTrust {
  if (!options.applicable) {
    return 'not_applicable';
  }

  for (const lookupKey of options.lookupKeys) {
    const trustLevel = options.trustLevels[lookupKey];
    if (trustLevel === 'trusted') {
      return 'trusted';
    }
    if (trustLevel === 'untrusted') {
      return 'untrusted';
    }
  }

  return options.hasProjectLayerArtifacts ? 'unknown' : 'not_applicable';
}

function resolveProjectScopedInstructionsState(
  declared: boolean,
  managed: boolean,
  projectTrust: ProjectTrust,
): InstructionsSessionState {
  if (!declared) {
    return 'not_applicable';
  }
  if (!managed) {
    return 'absent';
  }
  return projectTrustToVisibility(projectTrust);
}

function resolveUserScopedInstructionsState(
  declared: boolean,
  managed: boolean,
  higherPriorityExternal: boolean,
  projectLayerDeveloperInstructionsDefined: boolean,
  projectTrust: ProjectTrust,
): InstructionsSessionState {
  if (!declared) {
    return 'not_applicable';
  }
  if (!managed) {
    return 'absent';
  }
  if (higherPriorityExternal) {
    return 'unknownByExternalLayer';
  }
  if (projectLayerDeveloperInstructionsDefined && projectTrust === 'trusted') {
    return 'shadowedByProjectDeveloperInstructions';
  }
  return 'visible';
}

function resolveProjectScopedArtifactVisibility(
  declared: boolean,
  managed: boolean,
  projectTrust: ProjectTrust,
): RepoManagedSessionVisibility {
  if (!declared) {
    return 'not_applicable';
  }
  if (!managed) {
    return 'absent';
  }
  return projectTrustToVisibility(projectTrust);
}

export function detectCodexSessionState(
  options: DetectCodexSessionStateOptions,
): RepoManagedSessionStateReport {
  const diagnostics: string[] = [];
  const instructions =
    options.scope === 'project'
      ? resolveProjectScopedInstructionsState(
          options.declarations.instructions,
          options.managed.instructions,
          options.projectTrust,
        )
      : resolveUserScopedInstructionsState(
          options.declarations.instructions,
          options.managed.instructions,
          options.higherPriorityExternal.developerInstructions,
          options.projectLayerDeveloperInstructionsDefined,
          options.projectTrust,
        );

  const rules =
    options.scope === 'project'
      ? resolveProjectScopedArtifactVisibility(
          options.declarations.permissions,
          options.managed.rules,
          options.projectTrust,
        )
      : !options.declarations.permissions
        ? 'not_applicable'
        : !options.managed.rules
          ? 'absent'
          : 'visible';

  const hooks =
    options.scope === 'project'
      ? resolveProjectScopedArtifactVisibility(
          options.declarations.hooks,
          options.managed.hooks,
          options.projectTrust,
        )
      : !options.declarations.hooks
        ? 'not_applicable'
        : !options.managed.hooks
          ? 'absent'
          : 'visible';

  let agents: RepoManagedSessionVisibility;
  if (!options.declarations.agents) {
    agents = 'not_applicable';
  } else if (!options.managed.agents) {
    agents = 'absent';
  } else if (options.scope === 'project') {
    agents = projectTrustToVisibility(options.projectTrust);
  } else {
    const higherPriorityAgentNames = new Set(options.higherPriorityExternal.agentRoleNames);
    agents = options.managed.agentRoleNames.some((roleName) => higherPriorityAgentNames.has(roleName))
      ? 'unknownByExternalLayer'
      : 'visible';
  }

  if (options.scope === 'user' && options.managed.rules && options.higherPriorityExternal.rules) {
    diagnostics.push('effective exec policy 还叠加了外部 layer 的 rules。');
  }
  if (options.scope === 'user' && options.managed.hooks && options.higherPriorityExternal.hooks) {
    diagnostics.push('effective hooks registry 还叠加了外部 layer 的 hooks。');
  }

  return {
    instructions,
    rules,
    hooks,
    agents,
    diagnostics,
  };
}
