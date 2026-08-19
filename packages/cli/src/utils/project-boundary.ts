import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import fs from 'fs-extra';

import { resolveAwProjectRoot } from './plugin-config.js';

const execFileAsync = promisify(execFile);
const LOCAL_CONFIG_PATTERN = '.agent-workflows/plugin-config.local/';

function isInsidePath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function assertCanonicalProjectManagedRoots(options: {
  cwd: string;
  rootNames: readonly ('.agents' | '.codex' | '.claude')[];
  managedPaths?: readonly string[];
}): Promise<string> {
  const resolvedRepoRoot = path.resolve(resolveAwProjectRoot(options.cwd));
  const canonicalRepoRoot = await fs.realpath(resolvedRepoRoot).catch(() => resolvedRepoRoot);

  const managedPaths = new Set<string>([
    ...options.rootNames,
    ...(options.managedPaths ?? []),
  ]);
  for (const relativeManagedPath of managedPaths) {
    if (
      path.isAbsolute(relativeManagedPath)
      || relativeManagedPath === '..'
      || relativeManagedPath.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`Project managed path 必须位于 repo 内：${relativeManagedPath}`);
    }
    const targetRoot = path.join(canonicalRepoRoot, relativeManagedPath);
    let current = canonicalRepoRoot;
    for (const segment of path.relative(canonicalRepoRoot, targetRoot).split(path.sep)) {
      current = path.join(current, segment);
      const stats = await fs.lstat(current).catch(() => null);
      if (stats?.isSymbolicLink()) {
        throw new Error(`Project managed path 不能包含符号链接：${current}`);
      }
      if (!stats) break;
    }
    const realTarget = await fs.realpath(targetRoot).catch(() => targetRoot);
    if (!isInsidePath(realTarget, canonicalRepoRoot)) {
      throw new Error(`Project managed root realpath 越界：${targetRoot}`);
    }
  }
  return canonicalRepoRoot;
}

export interface ProjectBoundaryWarning {
  code: 'projectPrivateStateIgnoreNotEnsured';
  message: string;
  targetRelativePath: string;
  suggestedPatterns: string[];
}

interface GitIgnoreMatch {
  pattern?: string;
}

function relativePath(repoRoot: string, targetPath: string): string {
  return path.relative(path.resolve(repoRoot), path.resolve(targetPath)).split(path.sep).join('/');
}

async function inspectGitIgnore(repoRoot: string, targetRelativePath: string): Promise<GitIgnoreMatch | undefined> {
  try {
    const result = await execFileAsync('git', ['check-ignore', '-v', targetRelativePath], { cwd: repoRoot });
    const line = result.stdout.split(/\r?\n/u).find((entry) => entry.trim() !== '');
    const match = line ? /^(.*?):(\d+):([^\t]+)\t(.+)$/u.exec(line) : null;
    return match ? { pattern: match[3] } : {};
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException & { code?: number | string }).code);
    if (code === '1' || code === '128' || code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function ensureProjectPrivateStateIgnore(options: {
  cwd: string;
  targetPath: string;
}): Promise<{ warning?: ProjectBoundaryWarning }> {
  const repoRoot = resolveAwProjectRoot(options.cwd);
  const targetRelativePath = relativePath(repoRoot, options.targetPath);
  if (!targetRelativePath.startsWith(LOCAL_CONFIG_PATTERN)) return {};
  if ((await inspectGitIgnore(repoRoot, targetRelativePath))?.pattern) return {};
  const ignoreFilePath = path.join(repoRoot, '.gitignore');
  try {
    const existing = await fs.readFile(ignoreFilePath, 'utf8').catch(() => '');
    const next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${LOCAL_CONFIG_PATTERN}\n`;
    await fs.writeFile(ignoreFilePath, next, 'utf8');
    if ((await inspectGitIgnore(repoRoot, targetRelativePath))?.pattern) return {};
  } catch {
    // Return one actionable warning below.
  }
  return {
    warning: {
      code: 'projectPrivateStateIgnoreNotEnsured',
      targetRelativePath,
      suggestedPatterns: [LOCAL_CONFIG_PATTERN],
      message: `无法确保 ${targetRelativePath} 已被 Git 忽略。请在 .gitignore 中加入 ${LOCAL_CONFIG_PATTERN}。`,
    },
  };
}

export async function assertProjectSharedConfigPathVisible(options: {
  cwd: string;
  targetPath: string;
}): Promise<void> {
  const repoRoot = resolveAwProjectRoot(options.cwd);
  const targetRelativePath = relativePath(repoRoot, options.targetPath);
  const match = await inspectGitIgnore(repoRoot, targetRelativePath);
  if (match?.pattern) {
    throw new Error(
      `project shared config 路径 ${targetRelativePath} 被 ignore 规则 ${JSON.stringify(match.pattern)} 覆盖。请修正规则，或使用 \`--scope project --local\`。`,
    );
  }
}
