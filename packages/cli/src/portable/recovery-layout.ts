import path from 'node:path';

import { isPortablePlatformTarget, type PortablePlatformTarget } from '@lesliechan721/aw-plugin-core';

import type { ScopeContext } from '../intent/scope-context.js';
import { canonicalizePathThroughExistingAncestorSync, resolveUserHome } from '../utils/state-paths.js';

export type PortableAgent = PortablePlatformTarget;

interface PortableLayoutEnvironment {
  platform?: NodeJS.Platform;
  systemHome?: string;
  canonicalizePath?: (value: string) => string;
}

/** Fixed consumer directories. Native targets never use this writer. */
export function portableRecoveryLayout(context: ScopeContext, options: PortableLayoutEnvironment = {}): {
  cwd: string;
  scope: 'user' | 'project';
  generationRoot: string;
  targetPath(agent: PortableAgent, skill: string): string;
  targetRoot(agent: PortableAgent): string;
} {
  const { scope, env, executionCwd, targetHomes } = context;
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const canonicalizePath = options.canonicalizePath ?? canonicalizePathThroughExistingAncestorSync;
  const absolute = (value: string): boolean => paths.isAbsolute(value)
    && (platform !== 'win32' || !/^[/\\](?![/\\])/u.test(value));
  if ((scope !== 'user' && scope !== 'project') || !absolute(executionCwd)
    || !absolute(targetHomes.home)) throw new Error('portableEnvironmentUnsupported');
  if (scope === 'user') {
    let home: string;
    try { home = resolveUserHome(env, platform, options.systemHome); }
    catch { throw new Error('portableEnvironmentUnsupported'); }
    if (!absolute(home) || canonicalizePath(home) !== targetHomes.home) {
      throw new Error('portableEnvironmentUnsupported');
    }
  }
  const targetRoot = (agent: PortableAgent): string => {
    if (agent !== 'generic' || !isPortablePlatformTarget(agent)) throw new Error('portableInvalidAgentSelection');
    return paths.join(scope === 'user' ? targetHomes.home : executionCwd, '.agents', 'skills');
  };
  return {
    cwd: executionCwd, scope, generationRoot: context.generationRoot, targetRoot,
    targetPath: (agent, skill) => {
      if (skill.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill)) {
        throw new Error('portableSkillInvalid');
      }
      return paths.join(targetRoot(agent), skill);
    },
  };
}
