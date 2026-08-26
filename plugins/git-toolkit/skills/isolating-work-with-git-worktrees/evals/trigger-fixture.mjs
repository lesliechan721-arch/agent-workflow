import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKSPACE_FIXTURES = new Set([
  'clean_feature',
  'clean_main',
  'commit_ready',
  'dirty_feature',
  'dirty_main',
  'dirty_mixed_feature',
  'linked_dirty_feature',
  'linked_feature',
  'merge_conflict',
]);
const MATERIALIZED_ENTRIES = new Set(['.agent-workflows', '.agents', '.codex']);

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

async function writeInitialFiles(root) {
  await Promise.all([
    mkdir(path.join(root, 'docs'), { recursive: true }),
    mkdir(path.join(root, 'src'), { recursive: true }),
  ]);
  await writeFile(
    path.join(root, '.gitignore'),
    '.agents/\n.codex/\n.agent-workflows/\n',
    'utf8',
  );
  await writeFile(path.join(root, 'README.md'), '# Trigger eval repository\n', 'utf8');
  await writeFile(path.join(root, 'docs', 'draft.md'), '# Draft\n', 'utf8');
  await writeFile(
    path.join(root, 'src', 'button.ts'),
    "export const buttonLabel = 'Save';\n",
    'utf8',
  );
  await writeFile(
    path.join(root, 'src', 'conflict.ts'),
    "export const mode = 'base';\n",
    'utf8',
  );
  await writeFile(
    path.join(root, 'src', 'form.ts'),
    'export const paymentFormEnabled = false;\n',
    'utf8',
  );
  await writeFile(
    path.join(root, 'src', 'login.ts'),
    'export const loginTimeoutSeconds = 30;\n',
    'utf8',
  );
}

async function initializeRepository(root, env) {
  const originRoot = path.join(path.dirname(root), 'origin.git');
  await writeInitialFiles(root);
  await git(root, ['init', '--quiet'], env);
  await git(root, ['branch', '-M', 'main'], env);
  await git(root, ['config', 'user.name', 'Skill Eval'], env);
  await git(root, ['config', 'user.email', 'skill-eval@example.invalid'], env);
  await git(
    root,
    [
      'add',
      '--',
      '.gitignore',
      'README.md',
      'docs/draft.md',
      'src/button.ts',
      'src/conflict.ts',
      'src/form.ts',
      'src/login.ts',
    ],
    env,
  );
  await git(
    root,
    ['commit', '--quiet', '-m', 'chore: initialize eval repository'],
    env,
  );
  await git(root, ['branch', 'feature'], env);
  await git(root, ['branch', 'release/2.x'], env);
  await git(root, ['clone', '--quiet', '--bare', root, originRoot], env);
  await git(root, ['remote', 'add', 'origin', originRoot], env);
  await git(root, ['fetch', '--quiet', 'origin'], env);
}

async function setupLinkedWorktree(context, env) {
  const runRoot = path.dirname(context.workspaceRoot);
  const subjectFiles = path.join(runRoot, 'subject-files');
  const primaryRoot = path.join(runRoot, 'primary');
  await mkdir(subjectFiles, { recursive: true });
  for (const entry of await readdir(context.workspaceRoot)) {
    const source = path.join(context.workspaceRoot, entry);
    if (MATERIALIZED_ENTRIES.has(entry)) {
      await rename(source, path.join(subjectFiles, entry));
    } else {
      await rm(source, { recursive: true, force: true });
    }
  }
  await rm(context.workspaceRoot, { recursive: true, force: true });
  await mkdir(primaryRoot, { recursive: true });
  await initializeRepository(primaryRoot, env);
  await git(
    primaryRoot,
    ['worktree', 'add', '--quiet', context.workspaceRoot, 'feature'],
    env,
  );
  for (const entry of await readdir(subjectFiles)) {
    await rename(path.join(subjectFiles, entry), path.join(context.workspaceRoot, entry));
  }
  return primaryRoot;
}

async function makeDirty(root) {
  await writeFile(
    path.join(root, 'src', 'form.ts'),
    'export const paymentFormEnabled = true;\n',
    'utf8',
  );
}

async function makeMixedDirty(root, env) {
  await makeDirty(root);
  await writeFile(
    path.join(root, 'README.md'),
    '# Trigger eval repository\n\nStaged local notes.\n',
    'utf8',
  );
  await git(root, ['add', '--', 'README.md'], env);
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await writeFile(path.join(root, 'notes', 'local.txt'), 'untracked local notes\n', 'utf8');
}

async function setupNormalWorkspace(context, fixture, env) {
  await rm(path.join(context.workspaceRoot, '.git'), { recursive: true, force: true });
  await initializeRepository(context.workspaceRoot, env);
  if (fixture !== 'clean_main' && fixture !== 'dirty_main') {
    await git(context.workspaceRoot, ['switch', '--quiet', 'feature'], env);
  }
  if (fixture === 'dirty_main' || fixture === 'dirty_feature') {
    await makeDirty(context.workspaceRoot);
  } else if (fixture === 'dirty_mixed_feature') {
    await makeMixedDirty(context.workspaceRoot, env);
  } else if (fixture === 'commit_ready') {
    await writeFile(
      path.join(context.workspaceRoot, 'src', 'button.ts'),
      "export const buttonLabel = 'Submit';\n",
      'utf8',
    );
    await git(context.workspaceRoot, ['add', '--', 'src/button.ts'], env);
  }
}

async function setupMergeConflict(context, env) {
  const primaryRoot = await setupLinkedWorktree(context, env);
  await writeFile(
    path.join(context.workspaceRoot, 'src', 'conflict.ts'),
    "export const mode = 'feature';\n",
    'utf8',
  );
  await git(context.workspaceRoot, ['add', '--', 'src/conflict.ts'], env);
  await git(context.workspaceRoot, ['commit', '--quiet', '-m', 'feat: update mode'], env);
  await writeFile(
    path.join(primaryRoot, 'src', 'conflict.ts'),
    "export const mode = 'main';\n",
    'utf8',
  );
  await git(primaryRoot, ['add', '--', 'src/conflict.ts'], env);
  await git(primaryRoot, ['commit', '--quiet', '-m', 'fix: update mode'], env);
  let conflicted = false;
  try {
    await git(context.workspaceRoot, ['merge', 'main'], env);
  } catch {
    conflicted = true;
  }
  if (!conflicted) throw new Error('merge_conflict fixture did not produce a conflict');
}

export async function setupTriggerWorkspace(context) {
  const fixture = context.evalCase.workspace_fixture ?? 'clean_feature';
  if (!WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported worktree trigger fixture: ${fixture}`);
  }
  const environment = gitEnvironment(context);
  const env = { ...context.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  Object.assign(env, environment);
  await Promise.all([
    mkdir(path.join(context.env.HOME, 'disabled-hooks'), { recursive: true }),
    writeFile(path.join(context.env.HOME, 'gitconfig'), '', 'utf8'),
  ]);
  if (fixture === 'linked_feature' || fixture === 'linked_dirty_feature') {
    await setupLinkedWorktree(context, env);
    if (fixture === 'linked_dirty_feature') await makeDirty(context.workspaceRoot);
  } else if (fixture === 'merge_conflict') {
    await setupMergeConflict(context, env);
  } else {
    await setupNormalWorkspace(context, fixture, env);
  }
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
