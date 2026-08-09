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

export function getClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AW_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  return assertWritableHomePathForTests(
    home,
    env.AW_CLAUDE_HOME ? 'AW_CLAUDE_HOME' : 'AW_CLAUDE_HOME fallback (os.homedir())',
    '用 createIsolatedTestEnv() 生成默认 AW_CLAUDE_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 Claude home。',
  );
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AW_CODEX_HOME || path.join(os.homedir(), '.codex');
  return assertWritableHomePathForTests(
    home,
    env.AW_CODEX_HOME ? 'AW_CODEX_HOME' : 'AW_CODEX_HOME fallback (os.homedir())',
    '用 createIsolatedTestEnv() 生成默认 AW_CODEX_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 Codex home。',
  );
}

export function resolveAwHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AW_HOME || path.join(os.homedir(), '.aw');
  return assertWritableHomePathForTests(
    home,
    env.AW_HOME ? 'AW_HOME' : 'AW_HOME fallback (os.homedir())',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或通过 registerWritableStateRoot() 登记显式覆盖的 AW home。',
  );
}

async function realpathOrResolved(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function resolveAwHomeCanonical(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return realpathOrResolved(resolveAwHome(env));
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

export async function resolveClaudeProjectKey(cwd: string): Promise<string> {
  return realpathOrResolved(cwd);
}

export async function resolveCodexProjectKey(cwd: string): Promise<string> {
  return realpathOrResolved(await resolveRepoRoot(cwd));
}
