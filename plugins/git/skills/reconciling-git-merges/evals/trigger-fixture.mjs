import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FIXTURES = new Set([
  'clean_main',
  'ambiguous_retention',
  'semantic_retry',
  'semantic_permissions',
  'commit_ready',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitEnvironment(context) {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(context.env.HOME, 'gitconfig'),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: path.join(context.env.HOME, 'disabled-hooks'),
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(root, args, env) {
  return execFileAsync('git', args, { cwd: root, env, encoding: 'utf8' });
}

async function writeProjectFiles(root) {
  await writeFile(
    path.join(root, '.gitignore'),
    '.agents/\n.codex/\n.agent-workflows/\n',
    'utf8',
  );
  await writeFile(path.join(root, 'README.md'), '# Merge trigger fixture\n', 'utf8');
  await writeFile(path.join(root, 'retention.py'), 'RETENTION_DAYS = 30\n', 'utf8');
  await writeFile(path.join(root, 'retry.py'), 'MAX_ATTEMPTS = 3\n', 'utf8');
  await writeFile(path.join(root, 'idempotency.py'), 'MODE = "legacy"\n', 'utf8');
  await writeFile(path.join(root, 'permission_source.py'), 'ROLE = "reader"\n', 'utf8');
  await writeFile(path.join(root, 'permission_consumer.py'), 'ALLOWED = {"reader"}\n', 'utf8');
  await writeFile(path.join(root, 'conflict.txt'), 'mode=base\n', 'utf8');
  await writeFile(path.join(root, 'change.txt'), 'state=before\n', 'utf8');
}

async function initializeRepository(root, env) {
  await rm(path.join(root, '.git'), { recursive: true, force: true });
  await writeProjectFiles(root);
  await git(root, ['init', '--quiet'], env);
  await git(root, ['branch', '-M', 'main'], env);
  await git(root, ['config', 'user.name', 'Merge Trigger Eval'], env);
  await git(root, ['config', 'user.email', 'merge-trigger-eval@example.invalid'], env);
  await git(root, [
    'add', '--', '.gitignore', 'README.md', 'retention.py', 'retry.py',
    'idempotency.py', 'permission_source.py', 'permission_consumer.py',
    'conflict.txt', 'change.txt',
  ], env);
  await git(root, ['commit', '--quiet', '-m', 'chore: initialize merge fixture'], env);
}

async function commitFile(root, env, file, content, message) {
  await writeFile(path.join(root, file), content, 'utf8');
  await git(root, ['add', '--', file], env);
  await git(root, ['commit', '--quiet', '-m', message], env);
}

async function setupAmbiguousRetention(root, env) {
  await git(root, ['switch', '--quiet', '-c', 'feature'], env);
  await commitFile(root, env, 'retention.py', 'RETENTION_DAYS = 90\n', 'feat: retain audit data');
  await git(root, ['switch', '--quiet', 'main'], env);
  await commitFile(root, env, 'retention.py', 'RETENTION_DAYS = 7\n', 'fix: enforce privacy retention');
  try {
    await git(root, ['merge', 'feature'], env);
  } catch {
    // The conflict is the fixture state.
  }
  const status = await git(root, ['status', '--porcelain=v1'], env);
  if (!status.stdout.includes('UU retention.py')) {
    throw new Error('ambiguous_retention did not produce the expected conflict.');
  }
}

async function setupSemanticRetry(root, env) {
  await git(root, ['switch', '--quiet', '-c', 'feature'], env);
  await commitFile(root, env, 'idempotency.py', 'MODE = "request-key"\n', 'feat: use request keys');
  await git(root, ['switch', '--quiet', 'main'], env);
  await commitFile(root, env, 'retry.py', 'MAX_ATTEMPTS = 5\n', 'feat: extend retry budget');
  await git(root, ['merge', '--no-commit', '--no-ff', 'feature'], env);
}

async function setupSemanticPermissions(root, env) {
  await git(root, ['switch', '--quiet', '-c', 'feature'], env);
  await writeFile(path.join(root, 'conflict.txt'), 'mode=feature\n', 'utf8');
  await writeFile(
    path.join(root, 'permission_consumer.py'),
    'ALLOWED = {"reader", "auditor"}\n',
    'utf8',
  );
  await git(root, ['add', '--', 'conflict.txt', 'permission_consumer.py'], env);
  await git(root, ['commit', '--quiet', '-m', 'feat: add auditor consumer'], env);
  await git(root, ['switch', '--quiet', 'main'], env);
  await writeFile(path.join(root, 'conflict.txt'), 'mode=main\n', 'utf8');
  await writeFile(path.join(root, 'permission_source.py'), 'ROLE = "member"\n', 'utf8');
  await git(root, ['add', '--', 'conflict.txt', 'permission_source.py'], env);
  await git(root, ['commit', '--quiet', '-m', 'refactor: rename reader role'], env);
  try {
    await git(root, ['merge', 'feature'], env);
  } catch {
    // The conflict plus producer-consumer changes are the fixture state.
  }
  const status = await git(root, ['status', '--porcelain=v1'], env);
  if (!status.stdout.includes('UU conflict.txt')) {
    throw new Error('semantic_permissions did not produce the expected conflict.');
  }
}

export async function setupTriggerWorkspace(context) {
  const fixture = context.evalCase.workspace_fixture ?? 'clean_main';
  if (!FIXTURES.has(fixture)) {
    throw new Error(`Unsupported merge trigger fixture: ${fixture}`);
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
  await initializeRepository(context.workspaceRoot, env);
  if (fixture === 'ambiguous_retention') {
    await setupAmbiguousRetention(context.workspaceRoot, env);
  } else if (fixture === 'semantic_retry') {
    await setupSemanticRetry(context.workspaceRoot, env);
  } else if (fixture === 'semantic_permissions') {
    await setupSemanticPermissions(context.workspaceRoot, env);
  } else if (fixture === 'commit_ready') {
    await writeFile(path.join(context.workspaceRoot, 'change.txt'), 'state=ready\n', 'utf8');
    await git(context.workspaceRoot, ['add', '--', 'change.txt'], env);
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
