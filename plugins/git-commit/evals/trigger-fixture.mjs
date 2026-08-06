import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitEnvironment(context) {
  const gitConfigPath = path.join(context.env.HOME, 'gitconfig');
  const disabledHooksDir = path.join(context.env.HOME, 'disabled-hooks');
  return {
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: disabledHooksDir,
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(root, args, env) {
  return execFileAsync('git', args, { cwd: root, env, encoding: 'utf8' });
}

export async function setupTriggerWorkspace(context) {
  const environment = gitEnvironment(context);
  const env = { ...context.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  Object.assign(env, environment);
  await Promise.all([
    rm(path.join(context.workspaceRoot, '.git'), { recursive: true, force: true }),
    mkdir(path.join(context.workspaceRoot, 'src'), { recursive: true }),
    mkdir(path.join(context.env.HOME, 'disabled-hooks'), { recursive: true }),
    writeFile(path.join(context.env.HOME, 'gitconfig'), '', 'utf8'),
  ]);
  await writeFile(
    path.join(context.workspaceRoot, '.gitignore'),
    '.agents/\n.codex/\n.agent-workflows/\n',
    'utf8',
  );
  await writeFile(path.join(context.workspaceRoot, 'README.md'), '# Eval repository\n', 'utf8');
  await writeFile(
    path.join(context.workspaceRoot, 'src', 'app.ts'),
    'export const enabled = false;\n',
    'utf8',
  );
  await git(context.workspaceRoot, ['init', '--quiet'], env);
  await git(context.workspaceRoot, ['branch', '-M', 'main'], env);
  await git(context.workspaceRoot, ['config', 'user.name', 'Skill Eval'], env);
  await git(context.workspaceRoot, ['config', 'user.email', 'skill-eval@example.invalid'], env);
  await git(
    context.workspaceRoot,
    ['add', '--', '.gitignore', 'README.md', 'src/app.ts'],
    env,
  );
  await git(
    context.workspaceRoot,
    ['commit', '--quiet', '-m', 'chore: initialize eval repository'],
    env,
  );
  await writeFile(
    path.join(context.workspaceRoot, 'README.md'),
    '# Eval repository\n\nStaged documentation update.\n',
    'utf8',
  );
  await git(context.workspaceRoot, ['add', '--', 'README.md'], env);
  await writeFile(
    path.join(context.workspaceRoot, 'src', 'app.ts'),
    'export const enabled = true;\n',
    'utf8',
  );
  await mkdir(path.join(context.workspaceRoot, 'docs'), { recursive: true });
  await writeFile(
    path.join(context.workspaceRoot, 'docs', 'notes.md'),
    '# Untracked notes\n',
    'utf8',
  );
  return { environment };
}

export async function captureTriggerWorkspaceState(context) {
  const commands = [
    ['rev-parse', 'HEAD'],
    ['for-each-ref', '--format=%(refname)%00%(objectname)'],
    ['config', '--local', '--null', '--list'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--'],
    ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--'],
  ];
  const results = await Promise.all(
    commands.map((args) => git(context.workspaceRoot, args, context.env)),
  );
  const untrackedPaths = results[3].stdout.split('\0').filter(Boolean);
  const untrackedFiles = await Promise.all(untrackedPaths.map(async (file) => [
    file,
    sha256(await readFile(path.join(context.workspaceRoot, file))),
  ]));
  return sha256(JSON.stringify({
    git: results.map((result) => result.stdout),
    untracked_files: untrackedFiles,
  }));
}
