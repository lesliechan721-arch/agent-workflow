import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCustomProcessMain } from './custom-process-protocol.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const providerId = 'git-merge-provider';
const providerVersion = 'manifest-v1';

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

async function prepareWorkspace(evalCase, workspacePath) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reconciling-git-merges-eval-'));
  const fixtureName = evalCase.files[0].replace('evals/files/', '');
  try {
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
      await git(repo, ['config', 'user.name', 'Merge Skill Eval']);
      await git(repo, ['config', 'user.email', 'merge-skill-eval@example.invalid']);
      return { root, repo };
    }
    const archive = path.join(root, fixtureName);
    await writeFile(archive, await readEvalResource(`files/${fixtureName}`, null));
    const extracted = await execFile('tar', ['-xzf', archive, '-C', root]);
    if (extracted.code !== 0) throw new Error(`tar extraction failed: ${extracted.stderr}`);
    await rm(archive, { force: true });
    const repo = path.join(root, 'analysis-only-dirty-worktree');
    await cp(path.join(workspacePath, '.agents'), path.join(repo, '.agents'), { recursive: true });
    return { root, repo };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function runtimePrompt(evalCase) {
  if (evalCase.id === 'ambiguous_retention') {
    return '当前仓库已检出 main。合并 origin/feature。只解决仓库证据支持的内容；不要发明新的数据保留策略。';
  }
  if (evalCase.id === 'semantic_same_file') {
    return '当前仓库已检出 main。合并 origin/feature。Git 应能 clean merge。保留 main 中基础 Logger 的批量 fast path，以及 feature 中 FilteredLogger hook 的语义；运行测试并完成合并。';
  }
  if (evalCase.id === 'semantic_cross_file') {
    return '当前仓库已检出 main。合并 origin/feature。Main 已把 subtotal 改为返回整数分值，feature 新增的 invoice renderer 仍按元处理。保留双方意图，验证并完成合并。';
  }
  return '只分析将 origin/feature 合并到 main 的文本和语义风险；不要执行 merge，也不要改变 refs、暂存区或工作树内容。报告契约交互、建议的最小修复和验证方案。';
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
    env: process.env,
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

export async function semanticMergeOutcomeChecks(repo, caseId) {
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

function retentionDecisionChecks(message) {
  const text = typeof message === 'string' ? message : '';
  const statesDecisionIsOpen = /(?:(?:产品)?需求.{0,20}(?:尚未确定|未确定|待定)|(?:仓库)?(?:证据不足|没有证据|无证据)|无法决定|不能决定|需要.{0,20}(?:决定|决策|裁决|优先级)|(?:need|require|pending|cannot|insufficient|unclear).{0,50}(?:decision|priority|evidence))/isu.test(text)
    || /请.{0,20}(?:明确|确认|选择|决定|裁决|提供|告知).{0,40}(?:7|七|90|九十|策略|方案|优先级|取舍)/su.test(text);
  const retentionValues = [...text.matchAll(/(?:^|[^\d])(\d+)\s*(?:天|days?)(?![A-Za-z])/giu)]
    .map((match) => match[1]);
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
      passed: retentionValues.every((value) => value === '7' || value === '90'),
      evidence: text,
    },
  ];
}

export async function evaluateCase(evalCase, repo, before, run) {
  const after = await snapshot(repo);
  const checks = [];
  const add = (name, passed, evidence) => checks.push({ name, passed, evidence });
  add('model_completed', !run.timedOut && run.code === 0, `code=${run.code} signal=${run.signal ?? ''}`);
  if (evalCase.id === 'analysis_only_dirty_worktree') {
    add('repository_unchanged', JSON.stringify(after) === JSON.stringify(before), 'HEAD, refs, index, status, and diff');
    checks.push(...analysisMessageChecks(run.final_message));
  } else if (evalCase.id === 'ambiguous_retention') {
    add('no_new_commit', after.head === before.head, `before=${before.head.trim()} after=${after.head.trim()}`);
    if (JSON.stringify(after) === JSON.stringify(before)) {
      add('repository_unchanged', true, 'Paused before merge; HEAD, refs, index and worktree are unchanged.');
      checks.push(...retentionDecisionChecks(run.final_message));
      return { passed: checks.every((check) => check.passed), checks, before, after };
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
  } else {
    const commit = await mergeCommitState(repo, before.head.trim());
    add(
      'one_new_merge_commit',
      commit.mainlineCount === 1,
      `first_parent_count=${commit.mainlineCount}`,
    );
    add('merge_commit', commit.parentCount === 2, `parents=${commit.parentCount}`);
    const staged = await git(repo, ['diff', '--cached', '--quiet'], { allowFailure: true });
    const worktree = await git(repo, ['diff', '--quiet'], { allowFailure: true });
    add(
      'integration_changes_committed',
      staged.code === 0 && worktree.code === 0,
      after.status,
    );
    // These fixtures start clean. A clean index and tracked worktree bind both
    // checks below to HEAD instead of accepting an uncommitted integration fix.
    const tests = await execFile('python3', ['-m', 'unittest'], { cwd: repo, env: process.env });
    add('tests_pass', tests.code === 0, tests.stderr || tests.stdout);
    checks.push(...await semanticMergeOutcomeChecks(repo, evalCase.id));
    const controlPaths = await committedControlPaths(repo);
    add('control_files_not_committed', controlPaths.length === 0, controlPaths.join('\n'));
  }
  return { passed: checks.every((check) => check.passed), checks, before, after };
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
  if (
    evalCase?.id !== caseId
    || typeof evalCase.prompt !== 'string'
    || typeof evalCase.expected_output !== 'string'
    || !Array.isArray(evalCase.files)
    || evalCase.files.length !== 1
  ) throw new Error(`Merge provider received invalid case ${caseId}.`);
}

export async function runEvalProvider(input) {
  validateCase(input.case, input.caseId);
  const secrets = await credentialValues(input);
  const workspace = await prepareWorkspace(input.case, input.workspacePath);
  try {
    const before = await snapshot(workspace.repo);
    const model = await runCodex(workspace.repo, runtimePrompt(input.case), {
      allowGitWrites: input.caseId !== 'analysis_only_dirty_worktree',
      evalRoot: workspace.root,
    });
    const evaluation = await evaluateCase(input.case, workspace.repo, before, model);
    return redactCredentialValues({
      schemaVersion: 1,
      provider: { id: providerId, version: providerVersion },
      usage: usageFromEvents(model.stdout),
      grading: {
        grader: { id: 'git-merge-mechanical', version: '1' },
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
