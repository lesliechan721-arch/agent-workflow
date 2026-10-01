import path from 'node:path';

import type { ScopeContext } from '../intent/scope-context.js';
import { canonicalizePathThroughExistingAncestorSync, readEnvironmentValue, resolveUserHome } from '../utils/state-paths.js';

export type PortableAgent = 'codex' | 'cursor' | 'claude-code';

interface PortableLayoutEnvironment {
  platform?: NodeJS.Platform;
  systemHome?: string;
  canonicalizePath?: (value: string) => string;
}

/** skills@1.5.23 uses the canonical .agents root for Codex and Cursor copy installs. */
export function portableRecoveryLayout(context: ScopeContext, options: PortableLayoutEnvironment = {}): {
  cwd: string;
  scope: 'user' | 'project';
  generationRoot: string;
  lockPath: string;
  targetPath(agent: PortableAgent, skill: string): string;
  targetRoot(agent: PortableAgent): string;
} {
  const { scope, env, executionCwd, targetHomes } = context;
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const canonicalizePath = options.canonicalizePath ?? canonicalizePathThroughExistingAncestorSync;
  const absolute = (value: string): boolean => paths.isAbsolute(value)
    && (platform !== 'win32' || !/^[/\\](?![/\\])/u.test(value));
  const claudeOverride = readEnvironmentValue(env, 'CLAUDE_CONFIG_DIR', platform)?.trim();
  const xdgState = readEnvironmentValue(env, 'XDG_STATE_HOME', platform);
  if (scope !== 'user' && scope !== 'project') throw new Error('portableEnvironmentUnsupported');
  if (!absolute(executionCwd)) throw new Error('portableEnvironmentUnsupported');
  if (scope === 'user') {
    const sameHome = (value: string, expected: string): boolean => absolute(value)
      && canonicalizePath(value) === expected;
    if (!sameHome(resolveUserHome(env, platform, options.systemHome), targetHomes.home)
      || (claudeOverride && !absolute(claudeOverride))
      || (xdgState && !sameHome(xdgState, targetHomes.xdgState))) {
      throw new Error('portableEnvironmentUnsupported');
    }
  }
  const canonical = scope === 'user' ? paths.join(targetHomes.home, '.agents') : paths.join(executionCwd, '.agents');
  const claude = scope === 'user'
    ? claudeOverride ? canonicalizePath(claudeOverride) : paths.join(targetHomes.home, '.claude')
    : paths.join(executionCwd, '.claude');
  const targetRoot = (agent: PortableAgent): string => agent === 'claude-code' ? claude : canonical;
  const lockPath = scope === 'project' ? paths.join(executionCwd, 'skills-lock.json')
    : xdgState
      ? paths.join(targetHomes.xdgState, 'skills', '.skill-lock.json')
      : paths.join(canonical, '.skill-lock.json');
  return {
    cwd: executionCwd, scope, generationRoot: context.generationRoot, lockPath,
    targetRoot,
    targetPath: (agent, skill) => paths.join(targetRoot(agent), 'skills', skill),
  };
}
