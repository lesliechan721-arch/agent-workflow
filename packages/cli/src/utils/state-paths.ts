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

function absoluteHomePath(value: string, source: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(value) || (platform === 'win32' && /^[\\/](?![\\/])/u.test(value))) {
    throw new Error(`scopeEnvironmentAmbiguous: ${source} must be absolute.`);
  }
  return value;
}

/** Match Node's child environment key selection, including Windows duplicate keys. */
export function readEnvironmentValue(
  env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return env[key];
  const keys: string[] = [];
  for (const candidate in env) keys.push(candidate);
  const selected = keys.sort().find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  return selected === undefined ? undefined : env[selected];
}

export function resolveUserHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  systemHome?: string,
): string {
  const key = platform === 'win32' ? 'USERPROFILE' : 'HOME';
  // Match the child provider's os.homedir(), without consulting the parent's environment.
  return absoluteHomePath(readEnvironmentValue(env, key, platform) ?? systemHome ?? os.userInfo().homedir, key, platform);
}

export function getClaudeHome(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, systemHome?: string,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configured = readEnvironmentValue(env, 'CLAUDE_CONFIG_DIR', platform)?.trim();
  const home = absoluteHomePath(
    configured || paths.join(resolveUserHome(env, platform, systemHome), '.claude'),
    configured ? 'CLAUDE_CONFIG_DIR' : 'Claude home', platform,
  );
  return assertWritableHomePathForTests(
    home,
    configured ? 'CLAUDE_CONFIG_DIR' : 'Claude home fallback (HOME)',
    '用 createIsolatedTestEnv() 生成隔离 CLAUDE_CONFIG_DIR，或通过 registerWritableStateRoot() 登记显式覆盖的 Claude home。',
  );
}

export function getCodexHome(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, systemHome?: string,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configured = readEnvironmentValue(env, 'CODEX_HOME', platform)?.trim();
  const home = absoluteHomePath(
    configured || paths.join(resolveUserHome(env, platform, systemHome), '.codex'),
    configured ? 'CODEX_HOME' : 'Codex home', platform,
  );
  const source = configured ? 'CODEX_HOME' : 'CODEX_HOME fallback (HOME)';
  return assertWritableHomePathForTests(
    home,
    source,
    '用 createIsolatedTestEnv() 生成隔离 CODEX_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 Codex home。',
  );
}

export function resolveAwHome(
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, systemHome?: string,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configured = readEnvironmentValue(env, 'AW_HOME', platform);
  const home = absoluteHomePath(configured || paths.join(resolveUserHome(env, platform, systemHome), '.aw'),
    configured ? 'AW_HOME' : 'AW_HOME fallback', platform);
  return assertWritableHomePathForTests(
    home,
    configured ? 'AW_HOME' : 'AW_HOME fallback (HOME)',
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
