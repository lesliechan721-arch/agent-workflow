import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function gitPath(repo, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repo,
    env: isolatedGitEnv(),
    encoding: 'utf8',
  });
  return stdout.trim();
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Git metadata path escapes the eval workspace: ${candidate}`);
}

export async function gitMetadataWritableRoots(repo, evalRoot) {
  const [realEvalRoot, absoluteGitDir, commonDir] = await Promise.all([
    realpath(evalRoot),
    gitPath(repo, ['rev-parse', '--absolute-git-dir']),
    gitPath(repo, ['rev-parse', '--git-common-dir']),
  ]);
  const candidates = [
    absoluteGitDir,
    path.isAbsolute(commonDir) ? commonDir : path.resolve(repo, commonDir),
  ];
  const roots = [];
  for (const candidate of candidates) {
    const resolved = await realpath(candidate);
    assertInside(realEvalRoot, resolved);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

export async function gitMetadataWritableArgs(repo, evalRoot) {
  return (await gitMetadataWritableRoots(repo, evalRoot))
    .flatMap((root) => ['--add-dir', root]);
}
