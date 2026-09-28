import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import type { Scope } from '../types.js';
import {
  canonicalizePathThroughExistingAncestor,
  createProjectLocationKey, ensureRegularDirectoryPath, getClaudeHome, getCodexHome,
  resolveAbsoluteAwHome, resolveRequiredCanonicalRepoRoot,
} from '../utils/state-paths.js';
import { assertTestWritablePath } from '../utils/test-path-fence.js';

export interface ScopeContext {
  scope: Scope;
  callerCwd: string;
  executionCwd: string;
  projectRoot?: string;
  projectKey?: string;
  configProfile: 'user' | 'project';
  generationRoot: string;
  awHome: string;
  targetHomes: {
    home: string;
    codex: string;
    claude: string;
    cursor: string;
    xdgState: string;
  };
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

export interface ScopeContextOptions {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  readOnly?: boolean;
}

function absolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`scopeEnvironmentAmbiguous: ${label} must be absolute.`);
  return path.resolve(value);
}

async function canonicalPath(value: string, label: string): Promise<string> {
  return canonicalizePathThroughExistingAncestor(absolutePath(value, label));
}

export async function assertNeutralAncestorChain(candidate: string): Promise<string> {
  const canonical = await canonicalPath(candidate, 'neutral cwd');
  let current = canonical;
  while (true) {
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`userNeutralCwdUnsafe: non-directory ancestor ${current}`);
    }
    // These markers can change backend configuration through upward discovery.
    for (const marker of ['.git', '.agent-workflows', '.aw-workspace.json', 'pnpm-workspace.yaml',
      '.codex', '.claude', '.cursor', 'AGENTS.md', 'CLAUDE.md']) {
      const markerPath = path.join(current, marker);
      const markerStat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (markerStat) throw new Error(`userNeutralCwdUnsafe: ancestor marker ${markerPath}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return canonical;
    current = parent;
  }
}

export async function createSafeNeutralCwd(env: NodeJS.ProcessEnv): Promise<{
  executionCwd: string;
  dispose(): Promise<void>;
}> {
  const candidates = [env.TMPDIR, env.TEMP, env.TMP, os.tmpdir(), '/tmp']
    .filter((value): value is string => Boolean(value));
  let lastError: unknown;
  for (const candidate of new Set(candidates)) {
    try {
      const parent = await assertNeutralAncestorChain(candidate);
      assertTestWritablePath(parent, 'neutral temporary root', '用隔离临时目录登记可写路径。');
      const executionCwd = await fs.mkdtemp(path.join(parent, 'aw-user-neutral-'));
      const created = await fs.lstat(executionCwd);
      try {
        await assertNeutralAncestorChain(executionCwd);
      } catch (error) {
        await fs.remove(executionCwd);
        throw error;
      }
      return {
        executionCwd,
        dispose: async () => {
          const stat = await fs.lstat(executionCwd).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (stat?.isDirectory() && !stat.isSymbolicLink()
            && stat.dev === created.dev && stat.ino === created.ino) {
            await fs.remove(executionCwd);
          }
        },
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`userNeutralCwdUnavailable: No safe neutral directory. ${String(lastError)}`);
}

export async function createScopeContext(options: ScopeContextOptions): Promise<ScopeContext> {
  const env = Object.freeze({ ...(options.env ?? process.env) });
  const callerCwd = await canonicalPath(options.cwd, 'caller cwd');
  const awHome = await canonicalPath(resolveAbsoluteAwHome(env), 'AW_HOME');
  const home = await canonicalPath(env.HOME || env.USERPROFILE || os.homedir(), 'HOME');
  const codex = await canonicalPath(getCodexHome(env), 'Codex home');
  const claude = await canonicalPath(getClaudeHome(env), 'Claude home');
  const cursor = await canonicalPath(path.join(home, '.cursor'), 'Cursor home');
  const xdgState = await canonicalPath(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'XDG_STATE_HOME');
  const targetHomes = Object.freeze({ home, codex, claude, cursor, xdgState });
  const distinctTargets = [awHome, codex, claude, cursor, xdgState];
  if (new Set(distinctTargets).size !== distinctTargets.length || awHome === home) {
    throw new Error('scopeEnvironmentConflict: configured state or target homes alias.');
  }
  if (options.scope === 'project') {
    const projectRoot = await resolveRequiredCanonicalRepoRoot(callerCwd);
    const projectKey = createProjectLocationKey(projectRoot);
    return {
      scope: 'project', callerCwd, executionCwd: projectRoot, projectRoot, projectKey,
      configProfile: 'project',
      generationRoot: path.join(projectRoot, '.agent-workflows', '.local', 'portable'),
      awHome, targetHomes, env, dispose: async () => undefined,
    };
  }
  const persistentCwd = path.join(awHome, 'runtime', 'user');
  if (!options.readOnly) {
    try {
      await assertNeutralAncestorChain(persistentCwd);
      assertTestWritablePath(persistentCwd, 'user neutral cwd', '用隔离 AW_HOME 登记可写路径。');
      await ensureRegularDirectoryPath(persistentCwd, 'User neutral cwd');
      const executionCwd = await assertNeutralAncestorChain(persistentCwd);
      return {
        scope: 'user', callerCwd, executionCwd, configProfile: 'user',
        generationRoot: path.join(awHome, 'portable', 'user'),
        awHome, targetHomes, env, dispose: async () => undefined,
      };
    } catch {
      // A poisoned AW_HOME requires an operation-owned neutral directory.
    }
  }
  const temporary = await createSafeNeutralCwd(env);
  return {
    scope: 'user', callerCwd, executionCwd: temporary.executionCwd,
    configProfile: 'user', generationRoot: path.join(awHome, 'portable', 'user'),
    awHome, targetHomes, env, dispose: temporary.dispose,
  };
}

export async function withScopeContext<T>(
  options: ScopeContextOptions, action: (context: ScopeContext) => Promise<T>,
): Promise<T> {
  const context = await createScopeContext(options);
  try { return await action(context); } finally { await context.dispose(); }
}
