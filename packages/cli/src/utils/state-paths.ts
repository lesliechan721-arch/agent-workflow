import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { assertTestWritablePath } from './test-path-fence.js';

function assertWritableHomePathForTests(
  targetPath: string,
  source: string,
  recommendedFix: string,
): string {
  return assertTestWritablePath(targetPath, source, recommendedFix);
}

function absoluteHomePath(value: string, source: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`scopeEnvironmentAmbiguous: ${source} must be absolute.`);
  }
  return value;
}

function actualHome(env: NodeJS.ProcessEnv): string {
  return absoluteHomePath(env.HOME || env.USERPROFILE || os.homedir(), 'HOME');
}

export function getClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = absoluteHomePath(
    env.AW_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || path.join(actualHome(env), '.claude'),
    env.AW_CLAUDE_HOME ? 'AW_CLAUDE_HOME' : env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR' : 'Claude home',
  );
  return assertWritableHomePathForTests(
    home,
    env.AW_CLAUDE_HOME ? 'AW_CLAUDE_HOME' : env.CLAUDE_CONFIG_DIR
      ? 'CLAUDE_CONFIG_DIR' : 'Claude home fallback (HOME)',
    '用 createIsolatedTestEnv() 生成默认 AW_CLAUDE_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 Claude home。',
  );
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = absoluteHomePath(
    env.AW_CODEX_HOME || env.CODEX_HOME || path.join(actualHome(env), '.codex'),
    env.AW_CODEX_HOME ? 'AW_CODEX_HOME' : env.CODEX_HOME ? 'CODEX_HOME' : 'Codex home',
  );
  const source = env.AW_CODEX_HOME
    ? 'AW_CODEX_HOME'
    : env.CODEX_HOME
      ? 'CODEX_HOME'
      : 'CODEX_HOME fallback (HOME)';
  return assertWritableHomePathForTests(
    home,
    source,
    '用 createIsolatedTestEnv() 生成默认 AW_CODEX_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 Codex home。',
  );
}

export function resolveAwHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = absoluteHomePath(env.AW_HOME || path.join(actualHome(env), '.aw'),
    env.AW_HOME ? 'AW_HOME' : 'AW_HOME fallback');
  return assertWritableHomePathForTests(
    home,
    env.AW_HOME ? 'AW_HOME' : 'AW_HOME fallback (HOME)',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 AW home。',
  );
}

export function canonicalizePathThroughExistingAncestorSync(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) throw error;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function canonicalizePathThroughExistingAncestor(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  let current = resolved;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) throw error;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function ensureRegularDirectoryPath(
  inputPath: string,
  label: string,
): Promise<void> {
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a regular directory path: ${current}`);
    }
  }
}

export async function resolveAwHomeCanonical(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return canonicalizePathThroughExistingAncestor(resolveAwHome(env));
}

export function resolveRepoRootSync(cwd: string): string {
  let currentDir = path.resolve(cwd);
  while (true) {
    if (
      fs.pathExistsSync(path.join(currentDir, '.git'))
      || fs.pathExistsSync(path.join(currentDir, 'pnpm-workspace.yaml'))
    ) {
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

export function createProjectLocationKey(projectKey: string): string {
  const readable = path.basename(projectKey)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const digest = crypto.createHash('sha256').update(projectKey).digest('hex').slice(0, 24);
  return `project-${readable || 'root'}-${digest}`;
}

export async function resolveCanonicalRepoProjectKey(cwd: string): Promise<string> {
  const repoRoot = await resolveRepoRoot(cwd);
  try {
    return await fs.realpath(repoRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return path.resolve(repoRoot);
  }
}

export async function resolveRequiredCanonicalRepoRoot(cwd: string): Promise<string> {
  const root = await resolveCanonicalRepoProjectKey(cwd);
  const markers = await Promise.all(['.git', 'pnpm-workspace.yaml'].map((name) =>
    fs.pathExists(path.join(root, name))));
  if (!markers.some(Boolean)) throw new Error('projectRootUnavailable: cwd is not inside a repository.');
  return root;
}

export function resolveAbsoluteAwHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveAwHome(env);
  if (!path.isAbsolute(home)) throw new Error('scopeEnvironmentAmbiguous: AW_HOME must be absolute.');
  return home;
}

export async function resolveClaudeProjectKey(cwd: string): Promise<string> {
  return canonicalizePathThroughExistingAncestor(cwd);
}

export async function resolveCodexProjectKey(cwd: string): Promise<string> {
  return canonicalizePathThroughExistingAncestor(await resolveRepoRoot(cwd));
}

export function codexProjectConfigAliasesUserHome(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const projectConfig = canonicalizePathThroughExistingAncestorSync(
    path.join(resolveRepoRootSync(cwd), '.codex'),
  );
  const userConfig = canonicalizePathThroughExistingAncestorSync(getCodexHome(env));
  return projectConfig === userConfig;
}
