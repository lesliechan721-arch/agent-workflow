import path from 'node:path';

import type { ScopeContext } from '../intent/scope-context.js';
import { canonicalizePathThroughExistingAncestorSync } from '../utils/state-paths.js';

export type PortableAgent = 'codex' | 'cursor' | 'claude-code';

/** Paths observed for skills@1.5.23 copy installs on Darwin arm64. */
export function portableRecoveryLayout(context: ScopeContext): {
  cwd: string;
  scope: 'user' | 'project';
  generationRoot: string;
  lockPath: string;
  targetPath(agent: PortableAgent, skill: string): string;
  targetRoot(agent: PortableAgent): string;
} {
  const { scope, env, executionCwd, targetHomes } = context;
  if (scope !== 'user' && scope !== 'project') throw new Error('portableEnvironmentUnsupported');
  if (scope === 'user') {
    const sameHome = (value: string, expected: string): boolean => path.isAbsolute(value)
      && canonicalizePathThroughExistingAncestorSync(value) === expected;
    if (process.platform !== 'darwin' || process.arch !== 'arm64'
      || !env.HOME || !sameHome(env.HOME, targetHomes.home)
      || (env.CLAUDE_CONFIG_DIR && !path.isAbsolute(env.CLAUDE_CONFIG_DIR))
      || (env.XDG_STATE_HOME && !sameHome(env.XDG_STATE_HOME, targetHomes.xdgState))) {
      throw new Error('portableEnvironmentUnsupported');
    }
  }
  const canonical = scope === 'user' ? path.join(targetHomes.home, '.agents') : path.join(executionCwd, '.agents');
  const claude = scope === 'user'
    ? env.CLAUDE_CONFIG_DIR ? canonicalizePathThroughExistingAncestorSync(env.CLAUDE_CONFIG_DIR)
      : path.join(targetHomes.home, '.claude')
    : path.join(executionCwd, '.claude');
  const targetRoot = (agent: PortableAgent): string => agent === 'claude-code' ? claude : canonical;
  const lockPath = scope === 'project' ? path.join(executionCwd, 'skills-lock.json')
    : env.XDG_STATE_HOME
      ? path.join(targetHomes.xdgState, 'skills', '.skill-lock.json')
      : path.join(canonical, '.skill-lock.json');
  return {
    cwd: executionCwd, scope, generationRoot: context.generationRoot, lockPath,
    targetRoot,
    targetPath: (agent, skill) => path.join(targetRoot(agent), 'skills', skill),
  };
}
