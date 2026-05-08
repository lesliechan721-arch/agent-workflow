import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import fs from 'fs-extra';

import { applyFileRules } from '../utils/file-rules.js';
import { resolveAwProjectRoot } from '../utils/plugin-config.js';
import {
  createProjectArtifactSharedLocator,
  getProjectArtifactSharedIdentityPath,
} from './paths.js';

const execFileAsync = promisify(execFile);

const PRIVATE_STATE_PATTERNS = [
  '.claude/.agent-workflows/',
  '.codex/.agent-workflows/',
  '.agent-workflows/plugin-config.local/',
] as const;

const PROJECT_SHARED_CONFIG_PATTERN = '.agent-workflows/plugin-config/';
const PROJECT_ARTIFACTS_PATTERN = '.agent-workflows/project-artifacts/';

export type ProjectBoundaryReceiptCategory =
  | 'privateState'
  | 'ignoredState'
  | 'projectSharedConfig'
  | 'projectLocalConfig'
  | 'repoVisibleArtifacts';

export type ProjectPrivateStatePattern = typeof PRIVATE_STATE_PATTERNS[number];

export interface ProjectBoundaryPathClassification {
  path: string;
  repoRelativePath: string;
  category?: ProjectBoundaryReceiptCategory;
}

export interface ProjectBoundaryWarning {
  code: 'projectPrivateStateIgnoreNotEnsured';
  message: string;
  targetRelativePath: string;
  suggestedPatterns: string[];
}

export interface EnsureProjectPrivateStateIgnoreResult {
  status: 'alreadyIgnored' | 'added' | 'warning' | 'notApplicable';
  targetRelativePath: string;
  ignoreFilePath: string;
  pattern?: ProjectPrivateStatePattern;
  matchedPattern?: string;
  warning?: ProjectBoundaryWarning;
}

export class ProjectBoundaryVisibilityError extends Error {
  readonly code:
    | 'projectSharedConfigIgnored'
    | 'projectArtifactIdentityIgnored';
  readonly targetRelativePath: string;
  readonly matchedPattern?: string;
  readonly suggestedPatterns: string[];

  constructor(options: {
    code: ProjectBoundaryVisibilityError['code'];
    message: string;
    targetRelativePath: string;
    matchedPattern?: string;
    suggestedPatterns: string[];
  }) {
    super(options.message);
    this.name = 'ProjectBoundaryVisibilityError';
    this.code = options.code;
    this.targetRelativePath = options.targetRelativePath;
    this.matchedPattern = options.matchedPattern;
    this.suggestedPatterns = [...options.suggestedPatterns];
  }
}

interface GitIgnoreMatch {
  sourcePath?: string;
  sourceLine?: number;
  pattern?: string;
  relativePath: string;
}

function normalizeRepoRelativePath(repoRoot: string, targetPath: string): string {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedTargetPath = path.resolve(targetPath);
  const relativePath = path.relative(resolvedRepoRoot, resolvedTargetPath).split(path.sep).join('/');
  return relativePath === '' ? '.' : relativePath;
}

function matchesBoundaryPattern(relativePath: string, directoryPattern: string): boolean {
  const withoutTrailingSlash = directoryPattern.endsWith('/')
    ? directoryPattern.slice(0, -1)
    : directoryPattern;
  return applyFileRules(
    [relativePath],
    [withoutTrailingSlash, `${withoutTrailingSlash}/**`],
  ).length > 0;
}

function resolvePrivateStatePattern(relativePath: string): ProjectPrivateStatePattern | undefined {
  return PRIVATE_STATE_PATTERNS.find((pattern) => matchesBoundaryPattern(relativePath, pattern));
}

async function inspectGitIgnore(options: {
  repoRoot: string;
  relativePath: string;
}): Promise<GitIgnoreMatch | undefined> {
  try {
    const result = await execFileAsync(
      'git',
      ['check-ignore', '-v', options.relativePath],
      { cwd: options.repoRoot },
    );
    const firstLine = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .find((line) => line !== '');
    if (!firstLine) {
      return { relativePath: options.relativePath };
    }

    const match = /^(.*?):(\d+):([^\t]+)\t(.+)$/u.exec(firstLine);
    if (!match) {
      return { relativePath: options.relativePath };
    }

    return {
      sourcePath: match[1],
      sourceLine: Number(match[2]),
      pattern: match[3],
      relativePath: match[4],
    };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const errorCode = typeof candidate.code === 'number' ? String(candidate.code) : candidate.code;
    if (errorCode === '1') {
      return undefined;
    }
    if (errorCode === '128' || errorCode === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function buildPrivateStateIgnoreWarning(options: {
  targetRelativePath: string;
  pattern: ProjectPrivateStatePattern;
  reason: string;
}): ProjectBoundaryWarning {
  return {
    code: 'projectPrivateStateIgnoreNotEnsured',
    targetRelativePath: options.targetRelativePath,
    suggestedPatterns: [options.pattern],
    message:
      `无法自动确保 ${options.targetRelativePath} 的 project private state ignore 规则。` +
      `建议在 .gitignore 中追加 ${JSON.stringify(options.pattern)}。${options.reason}`,
  };
}

function createVisibilityError(options: {
  code: ProjectBoundaryVisibilityError['code'];
  targetRelativePath: string;
  matchedPattern?: string;
  subjectLabel: string;
  suggestedPatterns: string[];
  extraGuidance: string;
}): ProjectBoundaryVisibilityError {
  const matched = options.matchedPattern
    ? `命中的 ignore pattern：${JSON.stringify(options.matchedPattern)}。`
    : '该路径当前被 ignore 规则覆盖。';
  return new ProjectBoundaryVisibilityError({
    code: options.code,
    targetRelativePath: options.targetRelativePath,
    matchedPattern: options.matchedPattern,
    suggestedPatterns: options.suggestedPatterns,
    message:
      `${options.subjectLabel} ${options.targetRelativePath} 不能继续写入。` +
      `${matched}${options.extraGuidance}`,
  });
}

export function classifyProjectBoundaryPath(options: {
  repoRoot: string;
  path: string;
}): ProjectBoundaryPathClassification {
  const repoRelativePath = normalizeRepoRelativePath(options.repoRoot, options.path);
  if (repoRelativePath === '.gitignore') {
    return {
      path: options.path,
      repoRelativePath,
      category: 'ignoredState',
    };
  }
  if (resolvePrivateStatePattern(repoRelativePath)) {
    return {
      path: options.path,
      repoRelativePath,
      category: repoRelativePath.startsWith('.agent-workflows/plugin-config.local/')
        ? 'projectLocalConfig'
        : 'privateState',
    };
  }
  if (matchesBoundaryPattern(repoRelativePath, PROJECT_SHARED_CONFIG_PATTERN)) {
    return {
      path: options.path,
      repoRelativePath,
      category: 'projectSharedConfig',
    };
  }
  if (matchesBoundaryPattern(repoRelativePath, PROJECT_ARTIFACTS_PATTERN)) {
    return {
      path: options.path,
      repoRelativePath,
      category: 'repoVisibleArtifacts',
    };
  }
  return {
    path: options.path,
    repoRelativePath,
  };
}

export async function ensureProjectPrivateStateIgnore(options: {
  cwd: string;
  targetPath: string;
}): Promise<EnsureProjectPrivateStateIgnoreResult> {
  const repoRoot = resolveAwProjectRoot(options.cwd);
  const ignoreFilePath = path.join(repoRoot, '.gitignore');
  const targetRelativePath = normalizeRepoRelativePath(repoRoot, options.targetPath);
  const pattern = resolvePrivateStatePattern(targetRelativePath);
  if (!pattern) {
    return {
      status: 'notApplicable',
      targetRelativePath,
      ignoreFilePath,
    };
  }

  const currentMatch = await inspectGitIgnore({
    repoRoot,
    relativePath: targetRelativePath,
  });
  if (currentMatch?.pattern) {
    return {
      status: 'alreadyIgnored',
      targetRelativePath,
      ignoreFilePath,
      pattern,
      matchedPattern: currentMatch.pattern,
    };
  }

  try {
    const ignoreFileExists = await fs.pathExists(ignoreFilePath);
    if (ignoreFileExists) {
      const stats = await fs.stat(ignoreFilePath);
      if (!stats.isFile()) {
        return {
          status: 'warning',
          targetRelativePath,
          ignoreFilePath,
          pattern,
          warning: buildPrivateStateIgnoreWarning({
            targetRelativePath,
            pattern,
            reason: `当前 ${ignoreFilePath} 不是普通文件。`,
          }),
        };
      }
    }

    const existing = ignoreFileExists ? await fs.readFile(ignoreFilePath, 'utf8') : '';
    const next = existing === ''
      ? `${pattern}\n`
      : existing.endsWith('\n')
        ? `${existing}${pattern}\n`
        : `${existing}\n${pattern}\n`;
    await fs.writeFile(ignoreFilePath, next, 'utf8');
  } catch (error) {
    return {
      status: 'warning',
      targetRelativePath,
      ignoreFilePath,
      pattern,
      warning: buildPrivateStateIgnoreWarning({
        targetRelativePath,
        pattern,
        reason: error instanceof Error ? `失败原因：${error.message}` : `失败原因：${String(error)}`,
      }),
    };
  }

  const updatedMatch = await inspectGitIgnore({
    repoRoot,
    relativePath: targetRelativePath,
  });
  if (updatedMatch?.pattern) {
    return {
      status: 'added',
      targetRelativePath,
      ignoreFilePath,
      pattern,
      matchedPattern: updatedMatch.pattern,
    };
  }

  return {
    status: 'warning',
    targetRelativePath,
    ignoreFilePath,
    pattern,
    warning: buildPrivateStateIgnoreWarning({
      targetRelativePath,
      pattern,
      reason: '已尝试更新 .gitignore，但目标路径仍未被 ignore。',
    }),
  };
}

export async function assertProjectSharedConfigPathVisible(options: {
  cwd: string;
  pluginName: string;
}): Promise<void> {
  const repoRoot = resolveAwProjectRoot(options.cwd);
  const targetPath = path.join(
    repoRoot,
    '.agent-workflows',
    'plugin-config',
    options.pluginName,
    'config.json',
  );
  const targetRelativePath = normalizeRepoRelativePath(repoRoot, targetPath);
  const match = await inspectGitIgnore({
    repoRoot,
    relativePath: targetRelativePath,
  });
  if (!match?.pattern) {
    return;
  }

  throw createVisibilityError({
    code: 'projectSharedConfigIgnored',
    targetRelativePath,
    matchedPattern: match.pattern,
    subjectLabel: 'project shared config 路径',
    suggestedPatterns: ['!.agent-workflows/', '!/.agent-workflows/plugin-config/', '!.agent-workflows/plugin-config/'],
    extraGuidance: '请修正 ignore 规则，保留 .agent-workflows/plugin-config/ 可提交，或改用 `--scope project --local`。',
  });
}

export async function assertProjectArtifactIdentityPathVisible(options: {
  cwd: string;
  pluginName: string;
  platform: 'claude' | 'codex';
}): Promise<void> {
  const repoRoot = resolveAwProjectRoot(options.cwd);
  const locator = createProjectArtifactSharedLocator({
    plugin: options.pluginName,
    platform: options.platform,
    repoRoot,
    projectRoot: repoRoot,
  });
  const targetPath = getProjectArtifactSharedIdentityPath({
    repoRoot,
    locator,
  });
  const targetRelativePath = normalizeRepoRelativePath(repoRoot, targetPath);
  const match = await inspectGitIgnore({
    repoRoot,
    relativePath: targetRelativePath,
  });
  if (!match?.pattern) {
    return;
  }

  throw createVisibilityError({
    code: 'projectArtifactIdentityIgnored',
    targetRelativePath,
    matchedPattern: match.pattern,
    subjectLabel: 'project artifact shared identity 路径',
    suggestedPatterns: ['!.agent-workflows/', '!/.agent-workflows/project-artifacts/', '!.agent-workflows/project-artifacts/'],
    extraGuidance:
      '请修正 ignore 规则，保留 .agent-workflows/project-artifacts/ 可提交；本次不会写入任何共享 artifacts。',
  });
}
