import { spawn } from 'node:child_process';
import { access, appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCustomProcessMain } from './custom-process-protocol.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const providerId = 'git-reconcile-provider';
const providerVersion = 'manifest-v1';
const ATTACHMENT_CASES = new Set([
  'ambiguous_retention',
  'semantic_same_file',
  'semantic_cross_file',
  'analysis_only_dirty_worktree',
]);
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C', '-c', '--config-env', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
]);

async function readEvalResource(relativePath, encoding = 'utf8') {
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error(`Eval resource must stay inside evals/: ${relativePath}`);
  }
  return readFile(path.join(evalDir, normalized), encoding);
}

function execFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function unquoteShellToken(token) {
  if (
    token.length >= 2
    && ((token.startsWith('"') && token.endsWith('"'))
      || (token.startsWith("'") && token.endsWith("'")))
  ) return token.slice(1, -1);
  return token;
}

function shellTokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? []).map(unquoteShellToken);
}

function splitShellSegments(command) {
  const segments = [];
  let buffer = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    if (buffer.trim()) segments.push(buffer.trim());
    buffer = '';
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      buffer += character;
      escaped = false;
    } else if (quote) {
      buffer += character;
      if (character === '\\' && quote !== "'") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
      buffer += character;
    } else if (['&&', '||'].includes(command.slice(index, index + 2))) {
      push();
      index += 1;
    } else if (character === ';' || character === '|' || character === '\n') {
      push();
    } else {
      buffer += character;
    }
  }
  push();
  return segments;
}

function unwrapShellCommand(command) {
  const match = command.match(
    /^(?:\S*\/)?(?:bash|sh|zsh)\s+-(?:c|lc)\s+([\s\S]+)$/u,
  );
  return match ? unquoteShellToken(match[1]) : command;
}

function gitInvocations(command) {
  return splitShellSegments(unwrapShellCommand(command)).flatMap((segment) => {
    const tokens = shellTokens(segment).map((token) => token
      .replace(/^[({]+/u, '')
      .replace(/[)}]+$/u, ''));
    const gitIndex = tokens.findIndex((token) => path.basename(token) === 'git');
    if (gitIndex < 0) return [];
    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      if (tokens[index] === '--') {
        index += 1;
        break;
      }
      index += GIT_OPTIONS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
    }
    return index >= tokens.length
      ? []
      : [{ subcommand: tokens[index], args: tokens.slice(index + 1) }];
  });
}

const ALWAYS_MUTATING_GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'checkout-index',
  'cherry-pick',
  'clean',
  'commit',
  'commit-tree',
  'fetch',
  'gc',
  'init',
  'merge',
  'mv',
  'prune',
  'pull',
  'push',
  'read-tree',
  'rebase',
  'repack',
  'reset',
  'restore',
  'revert',
  'rm',
  'switch',
  'update-index',
  'update-ref',
  'write-tree',
]);
const BRANCH_VALUE_OPTIONS = new Set([
  '--abbrev',
  '--color',
  '--column',
  '--contains',
  '--format',
  '--merged',
  '--no-contains',
  '--no-merged',
  '--points-at',
  '--sort',
]);

function positionalArgs(args, optionsWithValue = new Set()) {
  const positionals = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (afterDoubleDash) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (token.startsWith('-')) {
      if (optionsWithValue.has(token)) index += 1;
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

function isMutatingGitInvocation(invocation) {
  const { subcommand, args } = invocation;
  if (args.includes('--help') || args.includes('-h')) return false;
  if (ALWAYS_MUTATING_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === 'stash') {
    const first = positionalArgs(args)[0];
    return first !== 'list' && first !== 'show';
  }
  if (subcommand === 'worktree') {
    return positionalArgs(args)[0] !== 'list';
  }
  if (subcommand === 'merge-tree') {
    if (args.includes('--write-tree')) return true;
    if (args.includes('--trivial-merge')) return false;
    return positionalArgs(args, new Set(['--merge-base'])).length === 2;
  }
  if (subcommand === 'hash-object') {
    return args.includes('-w');
  }
  if (subcommand === 'symbolic-ref') {
    return args.includes('-d') || args.includes('--delete') || positionalArgs(args).length >= 2;
  }
  if (subcommand === 'config') {
    if (args.some((arg) => ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section'].includes(arg))) {
      return true;
    }
    const isQuery = args.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch'].includes(arg));
    return !isQuery;
  }
  if (subcommand === 'branch') {
    if (args.some((arg) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'].includes(arg))) {
      return true;
    }
    if (args.some((arg) => ['-l', '--list', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'].includes(arg))) {
      return false;
    }
    return positionalArgs(args, BRANCH_VALUE_OPTIONS).length > 0;
  }
  if (subcommand === 'tag') {
    if (args.some((arg) => ['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m'].includes(arg))) {
      return true;
    }
    if (args.some((arg) => ['-l', '--list', '-v', '--verify', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'].includes(arg))) {
      return false;
    }
    return positionalArgs(args, BRANCH_VALUE_OPTIONS).length > 0;
  }
  return false;
}

export function inspectReconcileExecTrace(stdout) {
  const commands = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (
        ['item.started', 'item.completed', 'item.updated'].includes(event.type)
        && event.item?.type === 'command_execution'
        && typeof event.item.command === 'string'
        && !seen.has(event.item.command)
      ) {
        seen.add(event.item.command);
        commands.push(event.item.command);
      }
    } catch {
      // Codex JSONL can contain non-event diagnostics.
    }
  }
  const invocations = commands.flatMap(gitInvocations);
  const mutatingCommands = commands.filter(
    (command) => gitInvocations(command).some(isMutatingGitInvocation),
  );
  return {
    commands,
    mutating_git_commands: mutatingCommands,
    mutated_git: mutatingCommands.length > 0,
    pushed: invocations.some((invocation) => invocation.subcommand === 'push'),
    aborted_rebase: invocations.some(
      (invocation) => invocation.subcommand === 'rebase' && invocation.args.includes('--abort'),
    ),
    aborted_cherry_pick: invocations.some(
      (invocation) => invocation.subcommand === 'cherry-pick' && invocation.args.includes('--abort'),
    ),
    continued_rebase: invocations.some(
      (invocation) => invocation.subcommand === 'rebase' && invocation.args.includes('--continue'),
    ),
    continued_cherry_pick: invocations.some(
      (invocation) => invocation.subcommand === 'cherry-pick' && invocation.args.includes('--continue'),
    ),
    committed: invocations.some(
      (invocation) => invocation.subcommand === 'commit' && !invocation.args.includes('--amend'),
    ),
  };
}

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...env,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: nullDevice,
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_TERMINAL_PROMPT: '0',
  };
}

async function git(root, args, { allowFailure = false } = {}) {
  const result = await execFile('git', args, {
    cwd: root,
    env: isolatedGitEnv(),
  });
  if (!allowFailure && result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

export async function configureEvalExcludes(repo) {
  const infoDir = path.join(repo, '.git', 'info');
  await mkdir(infoDir, { recursive: true });
  await appendFile(
    path.join(infoDir, 'exclude'),
    '\n.agents/\n.codex/\n.agent-workflows/\n__pycache__/\n',
    'utf8',
  );
}

async function gitMetadataWritableArgs(repo, fixtureRoot) {
  const [root, absoluteGitDir, commonDir] = await Promise.all([
    realpath(fixtureRoot),
    git(repo, ['rev-parse', '--absolute-git-dir']),
    git(repo, ['rev-parse', '--git-common-dir']),
  ]);
  const roots = [];
  for (const candidate of [
    absoluteGitDir.stdout.trim(),
    path.isAbsolute(commonDir.stdout.trim())
      ? commonDir.stdout.trim()
      : path.resolve(repo, commonDir.stdout.trim()),
  ]) {
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Git metadata path escapes the eval fixture: ${resolved}`);
    }
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  return roots.flatMap((rootPath) => ['--add-dir', rootPath]);
}

export async function snapshot(root) {
  const [head, refs, index, status, diff, retentionContent] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['show-ref']),
    git(root, ['ls-files', '-s']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(root, ['diff', '--binary', 'HEAD']),
    readFile(path.join(root, 'retention.py'), 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  return {
    head: head.stdout,
    refs: refs.stdout,
    index: index.stdout,
    status: status.stdout,
    diff: diff.stdout,
    retentionContent,
  };
}

function finalMessage(stdout) {
  let message = '';
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        message = event.item.text ?? event.item.content ?? message;
      }
    } catch {
      // Codex JSONL can contain non-event diagnostics. Ignore them.
    }
  }
  return typeof message === 'string' ? message : JSON.stringify(message);
}

async function initializeEmptyGitRepo(repo) {
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '--quiet']);
  await git(repo, ['branch', '-M', 'main']);
  await git(repo, ['config', 'user.name', 'Reconcile Skill Eval']);
  await git(repo, ['config', 'user.email', 'reconcile-skill-eval@example.invalid']);
  await git(repo, ['config', 'commit.gpgSign', 'false']);
  await writeFile(path.join(repo, '.gitignore'), '.agents/\n.codex/\n.agent-workflows/\n__pycache__/\n', 'utf8');
}

export async function prepareRebaseConflictRepo(repo) {
  await initializeEmptyGitRepo(repo);
  await writeFile(path.join(repo, 'config.py'), [
    'DEFAULT_TIMEOUT_SECONDS = 30',
    'LEGACY_TLS_FALLBACK = True',
    '',
    '',
    'def build_client_options():',
    '    return {',
    '        "timeout_seconds": DEFAULT_TIMEOUT_SECONDS,',
    '        "legacy_tls_fallback": LEGACY_TLS_FALLBACK,',
    '    }',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_config.py'), [
    'import unittest',
    'from config import build_client_options',
    '',
    '',
    'class ConfigTest(unittest.TestCase):',
    '    def test_client_options(self):',
    '        opts = build_client_options()',
    '        self.assertEqual(opts["timeout_seconds"], 30)',
    '        self.assertIs(opts["legacy_tls_fallback"], True)',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await git(repo, ['add', '--', '.gitignore', 'config.py', 'test_config.py']);
  await git(repo, ['commit', '--quiet', '-m', 'chore: initialize client config']);

  await git(repo, ['switch', '--quiet', '-c', 'feature']);
  await writeFile(path.join(repo, 'config.py'), [
    'DEFAULT_TIMEOUT_SECONDS = 30',
    'LEGACY_TLS_FALLBACK = True',
    '',
    '',
    'def build_client_options():',
    '    return {',
    '        "timeout_seconds": DEFAULT_TIMEOUT_SECONDS,',
    '        "legacy_tls_fallback": LEGACY_TLS_FALLBACK,',
    '        "max_retries": 3,',
    '    }',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'summary.py'), [
    'from config import build_client_options',
    '',
    '',
    'def format_client_summary():',
    '    opts = build_client_options()',
    '    return f"timeout={opts[\'timeout_seconds\']}s retries={opts[\'max_retries\']}"',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_config.py'), [
    'import unittest',
    'from config import build_client_options',
    '',
    '',
    'class ConfigTest(unittest.TestCase):',
    '    def test_client_options(self):',
    '        opts = build_client_options()',
    '        self.assertEqual(opts["timeout_seconds"], 30)',
    '        self.assertIs(opts["legacy_tls_fallback"], True)',
    '        self.assertEqual(opts["max_retries"], 3)',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_summary.py'), [
    'import unittest',
    'from summary import format_client_summary',
    '',
    '',
    'class SummaryTest(unittest.TestCase):',
    '    def test_format_client_summary(self):',
    '        self.assertEqual(format_client_summary(), "timeout=30s retries=3")',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await git(repo, ['add', '--', 'config.py', 'summary.py', 'test_config.py', 'test_summary.py']);
  await git(repo, [
    'commit',
    '--quiet',
    '-m',
    'feat: add retry budget and client summary',
    '-m',
    'Add max_retries=3 to client options and format human-readable summary in seconds (timeout=30s retries=3).',
  ]);

  await git(repo, ['switch', '--quiet', 'main']);
  await writeFile(path.join(repo, 'config.py'), [
    'DEFAULT_TIMEOUT_MS = 30000',
    '',
    '',
    'def build_client_options():',
    '    return {',
    '        "timeout_ms": DEFAULT_TIMEOUT_MS,',
    '    }',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_config.py'), [
    'import unittest',
    'from config import build_client_options',
    '',
    '',
    'class ConfigTest(unittest.TestCase):',
    '    def test_client_options(self):',
    '        opts = build_client_options()',
    '        self.assertEqual(opts["timeout_ms"], 30000)',
    '        self.assertNotIn("timeout_seconds", opts)',
    '        self.assertNotIn("legacy_tls_fallback", opts)',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await git(repo, ['add', '--', 'config.py', 'test_config.py']);
  await git(repo, [
    'commit',
    '--quiet',
    '-m',
    'security: drop legacy TLS fallback and use millisecond timeouts',
    '-m',
    'Remove insecure LEGACY_TLS_FALLBACK / legacy_tls_fallback per security audit and replace timeout_seconds (30) with timeout_ms (30000).',
  ]);

  await git(repo, ['switch', '--quiet', 'feature']);
  const rebased = await git(repo, ['rebase', 'main'], { allowFailure: true });
  if (rebased.code === 0) throw new Error('rebase_conflict_reconcile did not produce a conflict.');
}

export async function prepareCherryPickConflictRepo(repo) {
  await initializeEmptyGitRepo(repo);
  await writeFile(path.join(repo, 'limiter.py'), [
    'DEFAULT_POLICY = {',
    '    "limit": 100,',
    '    "allow_anonymous_burst": True,',
    '}',
    '',
    '',
    'def check_allowed(current_count, policy=None):',
    '    active = policy or DEFAULT_POLICY',
    '    return current_count < active["limit"]',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_limiter.py'), [
    'import unittest',
    'from limiter import DEFAULT_POLICY, check_allowed',
    '',
    '',
    'class LimiterTest(unittest.TestCase):',
    '    def test_policy(self):',
    '        self.assertEqual(DEFAULT_POLICY["limit"], 100)',
    '        self.assertIs(DEFAULT_POLICY["allow_anonymous_burst"], True)',
    '        self.assertTrue(check_allowed(50))',
    '        self.assertFalse(check_allowed(100))',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await git(repo, ['add', '--', '.gitignore', 'limiter.py', 'test_limiter.py']);
  await git(repo, ['commit', '--quiet', '-m', 'chore: initialize rate limiter']);

  await git(repo, ['switch', '--quiet', '-c', 'hotfix']);
  await writeFile(path.join(repo, 'limiter.py'), [
    'DEFAULT_POLICY = {',
    '    "limit": 100,',
    '    "allow_anonymous_burst": True,',
    '    "alert_threshold": 80,',
    '}',
    '',
    '',
    'def check_allowed(current_count, policy=None):',
    '    active = policy or DEFAULT_POLICY',
    '    return current_count < active["limit"]',
    '',
    '',
    'def should_alert(current_count, policy=None):',
    '    active = policy or DEFAULT_POLICY',
    '    return current_count >= active["alert_threshold"]',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'quota_report.py'), [
    'from limiter import DEFAULT_POLICY, should_alert',
    '',
    '',
    'def build_quota_report(current_count):',
    '    remaining = max(0, DEFAULT_POLICY["limit"] - current_count)',
    '    return {',
    '        "remaining": remaining,',
    '        "alert": should_alert(current_count),',
    '    }',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_limiter.py'), [
    'import unittest',
    'from limiter import DEFAULT_POLICY, check_allowed, should_alert',
    '',
    '',
    'class LimiterTest(unittest.TestCase):',
    '    def test_policy(self):',
    '        self.assertEqual(DEFAULT_POLICY["limit"], 100)',
    '        self.assertIs(DEFAULT_POLICY["allow_anonymous_burst"], True)',
    '        self.assertEqual(DEFAULT_POLICY["alert_threshold"], 80)',
    '        self.assertTrue(check_allowed(50))',
    '        self.assertFalse(check_allowed(100))',
    '        self.assertFalse(should_alert(79))',
    '        self.assertTrue(should_alert(80))',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_quota_report.py'), [
    'import unittest',
    'from quota_report import build_quota_report',
    '',
    '',
    'class QuotaReportTest(unittest.TestCase):',
    '    def test_report(self):',
    '        self.assertEqual(build_quota_report(85), {"remaining": 15, "alert": True})',
    '        self.assertEqual(build_quota_report(20), {"remaining": 80, "alert": False})',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await git(repo, ['add', '--', 'limiter.py', 'quota_report.py', 'test_limiter.py', 'test_quota_report.py']);
  await git(repo, [
    'commit',
    '--quiet',
    '-m',
    'fix: add alert threshold and quota status report',
    '-m',
    'Add alert_threshold=80, should_alert helper, and quota_report.build_quota_report for operators.',
  ]);
  const hotfixCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  await git(repo, ['switch', '--quiet', 'main']);
  await writeFile(path.join(repo, 'limiter.py'), [
    'DEFAULT_POLICY = {',
    '    "max_requests": 100,',
    '}',
    '',
    '',
    'def check_allowed(current_count, policy=None):',
    '    active = policy or DEFAULT_POLICY',
    '    return current_count < active["max_requests"]',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(repo, 'test_limiter.py'), [
    'import unittest',
    'from limiter import DEFAULT_POLICY, check_allowed',
    '',
    '',
    'class LimiterTest(unittest.TestCase):',
    '    def test_policy(self):',
    '        self.assertEqual(DEFAULT_POLICY["max_requests"], 100)',
    '        self.assertNotIn("limit", DEFAULT_POLICY)',
    '        self.assertNotIn("allow_anonymous_burst", DEFAULT_POLICY)',
    '        self.assertTrue(check_allowed(50))',
    '        self.assertFalse(check_allowed(100))',
    '',
    '',
    'if __name__ == "__main__":',
    '    unittest.main()',
    '',
  ].join('\n'), 'utf8');
  await git(repo, ['add', '--', 'limiter.py', 'test_limiter.py']);
  await git(repo, [
    'commit',
    '--quiet',
    '-m',
    'refactor: drop anonymous burst flag and rename limit to max_requests',
    '-m',
    'Remove allow_anonymous_burst after abuse incident and rename DEFAULT_POLICY["limit"] to "max_requests".',
  ]);

  const picked = await git(repo, ['cherry-pick', hotfixCommit], { allowFailure: true });
  if (picked.code === 0) throw new Error('cherry_pick_conflict_reconcile did not produce a conflict.');
}

async function prepareWorkspace(evalCase, workspacePath) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-reconcile-eval-'));
  try {
    if (evalCase.id === 'rebase_conflict_reconcile') {
      const repo = path.join(root, 'repo');
      await prepareRebaseConflictRepo(repo);
      await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), { recursive: true });
      return { root, repo };
    }
    if (evalCase.id === 'cherry_pick_conflict_reconcile') {
      const repo = path.join(root, 'repo');
      await prepareCherryPickConflictRepo(repo);
      await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), { recursive: true });
      return { root, repo };
    }
    const fixtureName = evalCase.files[0].replace('evals/files/', '');
    if (fixtureName.endsWith('.bundle')) {
      const bundle = path.join(root, fixtureName);
      await writeFile(bundle, await readEvalResource(`files/${fixtureName}`, null));
      const repo = path.join(root, 'repo');
      const cloned = await execFile('git', ['clone', '--quiet', bundle, repo], {
        env: isolatedGitEnv(),
      });
      if (cloned.code !== 0) throw new Error(`git clone failed: ${cloned.stderr}`);
      await rm(bundle, { force: true });
      await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), { recursive: true });
      await git(repo, ['config', 'user.name', 'Reconcile Skill Eval']);
      await git(repo, ['config', 'user.email', 'reconcile-skill-eval@example.invalid']);
      await git(repo, ['config', 'commit.gpgSign', 'false']);
      await configureEvalExcludes(repo);
      return { root, repo };
    }
    const archive = path.join(root, fixtureName);
    await writeFile(archive, await readEvalResource(`files/${fixtureName}`, null));
    const extracted = await execFile('tar', ['-xzf', archive, '-C', root]);
    if (extracted.code !== 0) throw new Error(`tar extraction failed: ${extracted.stderr}`);
    await rm(archive, { force: true });
    const repo = path.join(root, 'analysis-only-dirty-worktree');
    await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), { recursive: true });
    await configureEvalExcludes(repo);
    return { root, repo };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCodex(repo, prompt, { allowGitWrites, evalRoot }) {
  const metadataArgs = allowGitWrites
    ? await gitMetadataWritableArgs(repo, evalRoot)
    : [];
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'workspace-write',
    ...metadataArgs,
    '--cd', repo,
    ...(process.env.AW_SKILL_EVAL_CODEX_MODEL ? ['--model', process.env.AW_SKILL_EVAL_CODEX_MODEL] : []),
    '--config', 'approval_policy="never"',
    '--config', 'skills.include_instructions=true', prompt,
  ];
  const child = spawn(process.env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex', args, {
    cwd: repo,
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    ...result,
    timedOut: false,
    stdout,
    stderr,
    final_message: finalMessage(stdout),
  };
}

export async function mergeCommitState(repo, beforeHead) {
  const [parents, count] = await Promise.all([
    git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']),
    git(repo, ['rev-list', '--first-parent', '--count', `${beforeHead}..HEAD`]),
  ]);
  return {
    mainlineCount: Number(count.stdout.trim()),
    parentCount: parents.stdout.trim().split(/\s+/).length - 1,
  };
}

export function analysisMessageChecks(message) {
  const text = typeof message === 'string' ? message : '';
  return [
    {
      name: 'identifies_unit_contract',
      passed: /(?:cents?|整数分|分值)/iu.test(text) && /(?:dollars?|invoice|元)/iu.test(text),
      evidence: text,
    },
    {
      name: 'proposes_boundary_conversion',
      passed: /(?:\/\s*(?:Decimal\s*\(\s*)?100\s*\)?|除以\s*100|乘以\s*0\.01|转换为元|convert\w*\s+(?:cents?\s+to\s+dollars?|to\s+dollars?))/iu.test(text),
      evidence: text,
    },
    {
      name: 'proposes_verification',
      passed: /(?:test|测试|unittest)/iu.test(text),
      evidence: text,
    },
  ];
}

export async function committedControlPaths(repo) {
  const result = await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.agents']);
  return result.stdout.trim().split('\n').filter(Boolean);
}

async function untrackedWorkFiles(repo) {
  const result = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  return result.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry
      && !entry.startsWith('.agents/')
      && !entry.startsWith('.codex/')
      && !entry.startsWith('.agent-workflows/')
      && !entry.startsWith('__pycache__/')
      && !entry.includes('/__pycache__/'));
}

export async function semanticReconcileOutcomeChecks(repo, caseId) {
  let program;
  if (caseId === 'semantic_same_file') {
    program = [
      'from logger import FilteredLogger, Logger',
      'base = Logger()',
      'def fail(_message):',
      "    raise AssertionError('base Logger.log_all must keep the batch fast path')",
      'base.log = fail',
      "base.log_all(['a', 'b'])",
      "assert base.entries == ['a', 'b']",
      'filtered = FilteredLogger()',
      "filtered.log_all(['ok', 'secret-token'])",
      "assert filtered.entries == ['ok']",
    ].join('\n');
  } else if (caseId === 'semantic_cross_file') {
    program = [
      'from invoice import render_total',
      'from pricing import subtotal',
      'value = subtotal([1.25, 2.25])',
      'assert value == 350',
      'assert isinstance(value, int)',
      "assert render_total([1.25, 2.25]) == '$3.50'",
    ].join('\n');
  } else if (caseId === 'rebase_conflict_reconcile') {
    program = [
      'import config',
      'from config import build_client_options',
      'from summary import format_client_summary',
      'opts = build_client_options()',
      "assert not hasattr(config, 'LEGACY_TLS_FALLBACK'), 'Deleted LEGACY_TLS_FALLBACK must not be resurrected'",
      "assert 'legacy_tls_fallback' not in opts, 'Deleted legacy_tls_fallback must not be resurrected'",
      "assert 'timeout_seconds' not in opts, 'Replaced timeout_seconds must stay removed'",
      "assert opts == {'timeout_ms': 30000, 'max_retries': 3}",
      "assert format_client_summary() == 'timeout=30s retries=3'",
    ].join('\n');
  } else if (caseId === 'cherry_pick_conflict_reconcile') {
    program = [
      'from limiter import DEFAULT_POLICY, check_allowed, should_alert',
      'from quota_report import build_quota_report',
      "assert 'allow_anonymous_burst' not in DEFAULT_POLICY, 'Deleted allow_anonymous_burst must not be resurrected'",
      "assert 'limit' not in DEFAULT_POLICY, 'Renamed limit must stay removed'",
      "assert DEFAULT_POLICY == {'max_requests': 100, 'alert_threshold': 80}",
      'assert check_allowed(99) is True',
      'assert check_allowed(100) is False',
      'assert should_alert(79) is False',
      'assert should_alert(80) is True',
      "assert build_quota_report(85) == {'remaining': 15, 'alert': True}",
      "assert build_quota_report(20) == {'remaining': 80, 'alert': False}",
    ].join('\n');
  } else {
    return [];
  }
  const result = await execFile('python3', ['-c', program], { cwd: repo, env: process.env });
  return [{
    name: 'preserves_composed_semantics',
    passed: result.code === 0,
    evidence: result.stderr || result.stdout,
  }];
}

function retentionConflictState(content) {
  if (typeof content !== 'string') {
    return { validMarkers: false, valuesPreserved: false, noAuthoredResolution: false };
  }
  const outsideLines = [];
  const oursLines = [];
  const theirsLines = [];
  let phase = 'outside';
  let sawStart = false;
  let sawSeparator = false;
  let sawEnd = false;
  for (const line of content.split('\n')) {
    if (/^<<<<<<< \S/u.test(line) && phase === 'outside' && !sawStart) {
      sawStart = true;
      phase = 'ours';
    } else if (/^=======$/u.test(line) && phase === 'ours' && !sawSeparator) {
      sawSeparator = true;
      phase = 'theirs';
    } else if (/^>>>>>>> \S/u.test(line) && phase === 'theirs' && !sawEnd) {
      sawEnd = true;
      phase = 'outside';
    } else if (phase === 'ours') {
      oursLines.push(line);
    } else if (phase === 'theirs') {
      theirsLines.push(line);
    } else {
      outsideLines.push(line);
    }
  }
  const ours = oursLines.join('\n');
  const theirs = theirsLines.join('\n');
  const hasSeven = (text) => /RETENTION_DAYS\s*=\s*7\b/u.test(text);
  const hasNinety = (text) => /RETENTION_DAYS\s*=\s*90\b/u.test(text);
  return {
    validMarkers: sawStart && sawSeparator && sawEnd && phase === 'outside',
    valuesPreserved: (hasSeven(ours) && hasNinety(theirs))
      || (hasNinety(ours) && hasSeven(theirs)),
    noAuthoredResolution: outsideLines.every((line) => line.trim() === ''),
  };
}

export function ambiguousRetentionChecks(content, message) {
  const conflict = retentionConflictState(content);
  return [
    {
      name: 'conflict_markers_preserved',
      passed: conflict.validMarkers,
      evidence: content,
    },
    {
      name: 'conflicting_policy_values_preserved',
      passed: conflict.valuesPreserved,
      evidence: content,
    },
    {
      name: 'no_authored_resolution',
      passed: conflict.noAuthoredResolution,
      evidence: content,
    },
    ...retentionDecisionChecks(message),
  ];
}

function hasInventedRetentionProposal(text) {
  const baseContextPattern = /(?:祖先|基线|原本|原有|原来|初始|原值|原为|最初|base|ancestor|original|initial|previous|prior)/iu;
  const proposalPattern = /(?:选择|采用|建议|折中|妥协|改为|设为|定为|改用|回退|方案|recommend|propose|suggest|compromise|choose|adopt|pick|use|set\s+to|fallback)/iu;
  const clauses = text.split(/[。！？；;\n.!?,，]+/u);
  for (const clause of clauses) {
    const matches = [...clause.matchAll(/(?:^|[^\d])(\d+)\s*(?:天|days?)(?![A-Za-z])/giu)];
    for (const match of matches) {
      const value = match[1];
      if (value === '7' || value === '90') continue;
      if (value === '30' && baseContextPattern.test(clause) && !proposalPattern.test(clause)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function retentionDecisionChecks(message) {
  const text = typeof message === 'string' ? message : '';
  const statesDecisionIsOpen = /(?:(?:产品)?需求.{0,20}(?:尚未确定|未确定|待定)|(?:仓库)?(?:证据不足|没有证据|无证据)|无法决定|不能决定|需要.{0,20}(?:决定|决策|裁决|优先级)|(?:need|require|pending|cannot|insufficient|unclear).{0,50}(?:decision|priority|evidence))/isu.test(text)
    || /请.{0,20}(?:明确|确认|选择|决定|裁决|提供|告知).{0,40}(?:7|七|90|九十|策略|方案|优先级|取舍)/su.test(text);
  return [
    {
      name: 'states_incompatible_windows',
      passed: /(?:7|七).*(?:90|九十)|(?:90|九十).*(?:7|七)/su.test(text),
      evidence: text,
    },
    {
      name: 'requires_product_decision',
      passed: statesDecisionIsOpen,
      evidence: text,
    },
    {
      name: 'does_not_invent_retention_value',
      passed: !hasInventedRetentionProposal(text),
      evidence: text,
    },
  ];
}

export async function evaluateCase(evalCase, repo, before, run) {
  const after = await snapshot(repo);
  const trace = inspectReconcileExecTrace(run.stdout ?? '');
  const checks = [];
  const add = (name, passed, evidence) => checks.push({ name, passed, evidence });
  add('model_completed', !run.timedOut && run.code === 0, `code=${run.code} signal=${run.signal ?? ''}`);
  add('push_not_run', !trace.pushed, JSON.stringify(trace.commands));
  if (evalCase.id === 'analysis_only_dirty_worktree') {
    add('repository_unchanged', JSON.stringify(after) === JSON.stringify(before), 'HEAD, refs, index, status, and diff');
    add('no_mutating_git_commands', !trace.mutated_git, JSON.stringify(trace.mutating_git_commands));
    checks.push(...analysisMessageChecks(run.final_message));
  } else if (evalCase.id === 'ambiguous_retention') {
    add('no_new_commit', after.head === before.head, `before=${before.head.trim()} after=${after.head.trim()}`);
    if (JSON.stringify(after) === JSON.stringify(before)) {
      add('repository_unchanged', true, 'Paused before merge; HEAD, refs, index and worktree are unchanged.');
      checks.push(...retentionDecisionChecks(run.final_message));
      return { passed: checks.every((check) => check.passed), checks, before, after, trace };
    }
    add('conflict_left_uncommitted', after.status.includes('UU retention.py'), after.status);
    const unmerged = await git(repo, ['ls-files', '--unmerged', '--', 'retention.py']);
    const stages = new Set(unmerged.stdout.trim().split('\n').filter(Boolean)
      .map((line) => line.split(/\s+/u)[2]));
    add(
      'unmerged_stages_preserved',
      ['1', '2', '3'].every((stage) => stages.has(stage)),
      unmerged.stdout,
    );
    checks.push(...ambiguousRetentionChecks(
      after.retentionContent,
      run.final_message,
    ));
  } else if (evalCase.id === 'rebase_conflict_reconcile') {
    const [rebaseMergePath, rebaseApplyPath, fullStatus, branch, ancestor, count, parents, staged, worktree, untracked] = await Promise.all([
      git(repo, ['rev-parse', '--git-path', 'rebase-merge']),
      git(repo, ['rev-parse', '--git-path', 'rebase-apply']),
      git(repo, ['status']),
      git(repo, ['branch', '--show-current']),
      git(repo, ['merge-base', '--is-ancestor', 'main', 'HEAD'], { allowFailure: true }),
      git(repo, ['rev-list', '--count', 'main..HEAD']),
      git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']),
      git(repo, ['diff', '--cached', '--quiet'], { allowFailure: true }),
      git(repo, ['diff', '--quiet'], { allowFailure: true }),
      untrackedWorkFiles(repo),
    ]);
    const pathExists = async (candidate) => {
      try {
        await access(path.resolve(repo, candidate.trim()));
        return true;
      } catch {
        return false;
      }
    };
    const [hasRebaseMerge, hasRebaseApply] = await Promise.all([
      pathExists(rebaseMergePath.stdout),
      pathExists(rebaseApplyPath.stdout),
    ]);
    const parentCount = parents.stdout.trim().split(/\s+/u).length - 1;
    add(
      'rebase_completed',
      !hasRebaseMerge && !hasRebaseApply && !/rebase in progress/iu.test(fullStatus.stdout) && branch.stdout.trim() === 'feature',
      `branch=${branch.stdout.trim()} status=${fullStatus.stdout}`,
    );
    add(
      'continued_original_rebase',
      !trace.aborted_rebase && trace.continued_rebase,
      JSON.stringify(trace.commands),
    );
    add('rebased_onto_main', ancestor.code === 0, ancestor.stderr || 'main is ancestor of HEAD');
    add(
      'one_linear_rebased_commit',
      Number(count.stdout.trim()) === 1 && parentCount === 1,
      `count=${count.stdout.trim()} parents=${parentCount}`,
    );
    add(
      'integration_changes_committed',
      staged.code === 0 && worktree.code === 0 && untracked.length === 0,
      JSON.stringify({ status: after.status, untracked }),
    );
    const tests = await execFile('python3', ['-m', 'unittest'], { cwd: repo, env: process.env });
    add('tests_pass', tests.code === 0, tests.stderr || tests.stdout);
    checks.push(...await semanticReconcileOutcomeChecks(repo, evalCase.id));
    const controlPaths = await committedControlPaths(repo);
    add('control_files_not_committed', controlPaths.length === 0, controlPaths.join('\n'));
  } else if (evalCase.id === 'cherry_pick_conflict_reconcile') {
    const [cherryPickHead, fullStatus, count, parents, staged, worktree, untracked] = await Promise.all([
      git(repo, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { allowFailure: true }),
      git(repo, ['status']),
      git(repo, ['rev-list', '--count', `${before.head.trim()}..HEAD`]),
      git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']),
      git(repo, ['diff', '--cached', '--quiet'], { allowFailure: true }),
      git(repo, ['diff', '--quiet'], { allowFailure: true }),
      untrackedWorkFiles(repo),
    ]);
    const parentCount = parents.stdout.trim().split(/\s+/u).length - 1;
    add(
      'cherry_pick_completed',
      cherryPickHead.code !== 0 && !/cherry-picking/iu.test(fullStatus.stdout),
      fullStatus.stdout,
    );
    add(
      'continued_original_cherry_pick',
      !trace.aborted_cherry_pick && (trace.continued_cherry_pick || trace.committed),
      JSON.stringify(trace.commands),
    );
    add(
      'one_new_commit',
      Number(count.stdout.trim()) === 1 && parentCount === 1,
      `count=${count.stdout.trim()} parents=${parentCount}`,
    );
    add(
      'integration_changes_committed',
      staged.code === 0 && worktree.code === 0 && untracked.length === 0,
      JSON.stringify({ status: after.status, untracked }),
    );
    const tests = await execFile('python3', ['-m', 'unittest'], { cwd: repo, env: process.env });
    add('tests_pass', tests.code === 0, tests.stderr || tests.stdout);
    checks.push(...await semanticReconcileOutcomeChecks(repo, evalCase.id));
    const controlPaths = await committedControlPaths(repo);
    add('control_files_not_committed', controlPaths.length === 0, controlPaths.join('\n'));
  } else {
    const commit = await mergeCommitState(repo, before.head.trim());
    add(
      'one_new_merge_commit',
      commit.mainlineCount === 1,
      `first_parent_count=${commit.mainlineCount}`,
    );
    add('merge_commit', commit.parentCount === 2, `parents=${commit.parentCount}`);
    const [staged, worktree, untracked] = await Promise.all([
      git(repo, ['diff', '--cached', '--quiet'], { allowFailure: true }),
      git(repo, ['diff', '--quiet'], { allowFailure: true }),
      untrackedWorkFiles(repo),
    ]);
    add(
      'integration_changes_committed',
      staged.code === 0 && worktree.code === 0 && untracked.length === 0,
      JSON.stringify({ status: after.status, untracked }),
    );
    // These fixtures start clean. A clean index, tracked worktree and absence of
    // stray untracked files bind both checks below to HEAD instead of accepting
    // an uncommitted integration fix or test file.
    const tests = await execFile('python3', ['-m', 'unittest'], { cwd: repo, env: process.env });
    add('tests_pass', tests.code === 0, tests.stderr || tests.stdout);
    checks.push(...await semanticReconcileOutcomeChecks(repo, evalCase.id));
    const controlPaths = await committedControlPaths(repo);
    add('control_files_not_committed', controlPaths.length === 0, controlPaths.join('\n'));
  }
  return { passed: checks.every((check) => check.passed), checks, before, after, trace };
}

function usageFromEvents(stdout) {
  let usage = null;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event?.usage && typeof event.usage === 'object' && !Array.isArray(event.usage)) {
        usage = event.usage;
      }
    } catch {
      // Codex JSONL can contain non-event diagnostics.
    }
  }
  return usage;
}

async function credentialValues() {
  const names = [
    'ALL_PROXY',
    'AW_SKILL_EVAL_CODEX_BIN',
    'AW_SKILL_EVAL_CODEX_MODEL',
    'CODEX_HOME',
    'HOME',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'NO_PROXY',
    'OPENAI_API_KEY',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
  ];
  return [...new Set(names.flatMap((name) => {
    const value = process.env[name];
    return value ? [value] : [];
  }))].sort((left, right) => right.length - left.length);
}

function redactText(value, secrets) {
  return secrets.reduce((text, secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return text
      .split(secret).join('[REDACTED]')
      .split(escaped).join('[REDACTED]');
  }, value);
}

function redactCredentialValues(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactCredentialValues(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, entry]) => [
        redactText(key, secrets),
        redactCredentialValues(entry, secrets),
      ]));
  }
  return value;
}

async function writeArtifacts(input, model, evaluation, secrets) {
  const reportPath = path.join(input.outputDir, 'provider-evidence.json');
  const tracePath = path.join(input.outputDir, 'codex-events.jsonl');
  const outputPath = path.join(input.outputDir, 'model-output.txt');
  const safeModel = redactCredentialValues(model, secrets);
  const safeEvaluation = redactCredentialValues(evaluation, secrets);
  await Promise.all([
    writeFile(reportPath, `${JSON.stringify({
      caseId: input.caseId,
      configuration: input.configuration,
      skillMode: input.skillMode,
      model: {
        exitCode: safeModel.code,
        signal: safeModel.signal,
        stderr: safeModel.stderr,
      },
      evaluation: safeEvaluation,
    }, null, 2)}\n`, 'utf8'),
    writeFile(tracePath, redactText(model.stdout, secrets), 'utf8'),
    writeFile(outputPath, `${redactText(model.final_message, secrets)}\n`, 'utf8'),
  ]);
  return [
    { path: path.basename(reportPath), role: 'report' },
    { path: path.basename(tracePath), role: 'trace' },
    { path: path.basename(outputPath), role: 'output' },
  ];
}

function validateCase(evalCase, caseId) {
  const requiresAttachment = ATTACHMENT_CASES.has(caseId);
  if (
    evalCase?.id !== caseId
    || typeof evalCase.prompt !== 'string'
    || typeof evalCase.expected_output !== 'string'
    || (requiresAttachment && (!Array.isArray(evalCase.files) || evalCase.files.length !== 1))
  ) throw new Error(`Reconcile provider received invalid case ${caseId}.`);
}

export async function runEvalProvider(input) {
  validateCase(input.case, input.caseId);
  const secrets = await credentialValues(input);
  const workspace = await prepareWorkspace(input.case, input.workspacePath);
  try {
    const before = await snapshot(workspace.repo);
    const model = await runCodex(workspace.repo, input.case.prompt, {
      allowGitWrites: true,
      evalRoot: workspace.root,
    });
    const evaluation = await evaluateCase(input.case, workspace.repo, before, model);
    return redactCredentialValues({
      schemaVersion: 1,
      provider: { id: providerId, version: providerVersion },
      usage: usageFromEvents(model.stdout),
      grading: {
        grader: { id: 'git-reconcile-mechanical', version: '1' },
        result: {
          caseId: input.caseId,
          configuration: input.configuration,
          passed: evaluation.passed,
          complete: model.code === 0,
          checks: evaluation.checks,
        },
      },
      artifacts: await writeArtifacts(input, model, evaluation, secrets),
    }, secrets);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}

await runCustomProcessMain(import.meta.url, runEvalProvider);
