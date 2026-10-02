import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { combineRequiredChecks } from './role-evidence.mjs';
import { evaluationForCase, semanticChecks, verifyVisualPage } from './workflow-results.mjs';

const execFileAsync = promisify(execFile);
const INPUT_KEYS = ['attempt', 'case', 'paths', 'phase', 'variant', 'version'];
const WRITE_TOOLS = new Set(['apply_patch', 'write_file']);
const ROLE_DEFINITIONS = {
  'spec-reviewer': {
    description: '独立审查指定 Spec，并返回证据、问题和覆盖限制。',
    instructions: '你是本轮已分配的 Spec reviewer。读取真实需求和 Spec，直接完成审查并返回证据。',
  },
  'design-reviewer': {
    description: '审查需求与已接受设计符合度。',
    instructions: '你是本轮已分配的需求与设计符合度 reviewer。读取原始需求、Spec、设计和当前结果，直接完成本轴。',
  },
  'quality-reviewer': {
    description: '审查工程质量与项目标准。',
    instructions: '你是本轮已分配的工程质量 reviewer。读取当前代码、测试和项目规则，直接完成本轴。',
  },
  'prototype-builder': {
    description: '按现有 brief 构建并验证指定 Prototype artifact。',
    instructions: '你是本轮已分配的 Prototype builder。只完成 brief 指定的 artifact 和实际验证，并向协调者返回事实与限制。',
  },
  'breakdown-worker': {
    description: '从真实 Spec、设计和代码生成可独立派发的 Ticket。',
    instructions: '你只负责本轮 Breakdown。读取真实来源并将页面工作项写入 tickets/view.md。',
  },
  'implement-worker': {
    description: '在 fresh context 中实施 tickets/view.md。',
    instructions: '你只负责实施 tickets/view.md。读取该 Ticket 及其可达来源，只修改 public/index.html，并报告实际验证。',
  },
};

const CASE_ROLES = {
  'real-spec-clean-context-direct': ['spec-reviewer'],
  'real-author-to-spec-reviewer-leaf': ['spec-reviewer'],
  'real-forked-author-is-not-independent': ['spec-reviewer'],
  'real-code-author-two-axis-leaves': ['design-reviewer', 'quality-reviewer'],
  'real-code-independent-root-supplements-one-axis': ['design-reviewer', 'quality-reviewer'],
  'real-existing-axis-assignments-reused': ['design-reviewer', 'quality-reviewer'],
  'real-current-round-rereview-no-nesting': ['design-reviewer', 'quality-reviewer'],
  'real-continuation-vs-new-full-reassessment': ['spec-reviewer'],
  'real-prototype-builder-uses-skill-as-leaf': ['prototype-builder'],
  generated_ticket_clean_context_delivery: [
    'breakdown-worker',
    'implement-worker',
    'design-reviewer',
    'quality-reviewer',
  ],
};

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain only ${wanted.join(', ')}.`);
  }
}

export function safeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\\')
    || value.includes('\0')
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized relative POSIX path.`);
  return value;
}

function assertAttemptPath(value, expected, type, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  const attemptRoot = process.cwd();
  const relative = path.relative(attemptRoot, value);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the attempt root.`);
  }
  let current = attemptRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link.`);
    if (current !== value && !info.isDirectory()) {
      throw new Error(`${label} has a non-directory path component.`);
    }
  }
  const info = lstatSync(value);
  if (type === 'directory' ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${label} must be a regular ${type}.`);
  }
  if (realpathSync(value) !== value) throw new Error(`${label} must not traverse a symbolic link.`);
}

export function parseAdapterInput(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`stdin must contain one JSON object: ${error.message}`);
  }
  const input = record(value, 'CodexWorkflowAdapterInput');
  exactKeys(input, INPUT_KEYS, 'CodexWorkflowAdapterInput');
  if (input.version !== 1) throw new Error('CodexWorkflowAdapterInput.version must be 1.');
  if (!['prepare', 'grade'].includes(input.phase)) {
    throw new Error('CodexWorkflowAdapterInput.phase must be prepare or grade.');
  }
  if (!['current', 'without-skill', 'previous-version'].includes(input.variant)) {
    throw new Error('CodexWorkflowAdapterInput.variant is invalid.');
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('CodexWorkflowAdapterInput.attempt must be a positive safe integer.');
  }
  record(input.case, 'CodexWorkflowAdapterInput.case');
  const paths = record(input.paths, 'CodexWorkflowAdapterInput.paths');
  exactKeys(
    paths,
    input.phase === 'prepare'
      ? ['fixtures', 'output', 'workspace']
      : ['evidence', 'fixtures', 'modelOutput', 'output', 'workspace'],
    'CodexWorkflowAdapterInput.paths',
  );
  const attemptRoot = process.cwd();
  if (realpathSync(attemptRoot) !== attemptRoot || !lstatSync(attemptRoot).isDirectory()) {
    throw new Error('CodexWorkflowAdapterInput attempt root must be a regular directory.');
  }
  const expectedDirectories = {
    workspace: path.join(attemptRoot, 'workspace', 'subject'),
    fixtures: path.join(attemptRoot, 'workspace', 'eval'),
    output: path.join(attemptRoot, 'output'),
  };
  for (const key of ['workspace', 'fixtures', 'output']) {
    assertAttemptPath(paths[key], expectedDirectories[key], 'directory', `CodexWorkflowAdapterInput.paths.${key}`);
  }
  if (input.phase === 'grade') {
    assertAttemptPath(
      paths.evidence,
      path.join(attemptRoot, 'output', 'workflow-evidence.json'),
      'file',
      'CodexWorkflowAdapterInput.paths.evidence',
    );
    assertAttemptPath(
      paths.modelOutput,
      path.join(attemptRoot, 'output', 'model-output.txt'),
      'file',
      'CodexWorkflowAdapterInput.paths.modelOutput',
    );
  }
  return input;
}

function parseCase(selectedCase) {
  const id = typeof selectedCase.id === 'string' ? selectedCase.id : '';
  if (!Object.hasOwn(CASE_ROLES, id)) throw new Error(`Unsupported workflow case: ${id || '<missing>'}.`);
  const input = record(selectedCase.input, `${id}.input`);
  const workspaceFiles = record(input.workspaceFiles, `${id}.input.workspaceFiles`);
  for (const [relative, content] of Object.entries(workspaceFiles)) {
    safeRelativePath(relative, `${id}.input.workspaceFiles path`);
    if (typeof content !== 'string') throw new Error(`${id}.input.workspaceFiles.${relative} must be text.`);
  }
  if (typeof input.task !== 'string' || input.task.trim() === '') {
    throw new Error(`${id}.input.task must be non-empty text.`);
  }
  const expected = record(selectedCase.expected, `${id}.expected`);
  const criteria = expected.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error(`${id}.expected.criteria must be non-empty.`);
  return { id, input, workspaceFiles, roles: CASE_ROLES[id] };
}

export async function writeWorkspaceFiles(workspace, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
}

async function materializeRoles(workspace, roles) {
  const result = [];
  for (const name of roles) {
    const definition = ROLE_DEFINITIONS[name];
    const configFile = path.posix.join('.codex', 'agents', `${name}.toml`);
    const target = path.join(workspace, configFile);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(definition.description)}`,
      `developer_instructions = ${JSON.stringify(definition.instructions)}`,
      '',
    ].join('\n'), { flag: 'wx' });
    result.push({ name, description: definition.description, configFile });
  }
  return result;
}

function scenarioInstructions(id) {
  const scenarios = {
    'real-spec-clean-context-direct': [
      '你是未参与目标 Spec 起草的独立 root。直接使用 dev-review-spec 审查，不要为同一审查建立下级。',
    ],
    'real-author-to-spec-reviewer-leaf': [
      '先根据 requirements.md 真实起草 spec.md。然后以作者身份组织正式审查。',
      '使用 spec-reviewer 和 fork_turns="none" 建立一个干净 reviewer。等待其结果并汇总。',
    ],
    'real-forked-author-is-not-independent': [
      '先根据 requirements.md 真实起草 spec.md。',
      '先用 spec-reviewer 和 fork_turns="all" 建立继承作者历史的 reviewer。',
      '该 reviewer 必须说明独立性限制。由你决定再建立 fork_turns="none" 的干净 reviewer，或明确正式独立审查仍未完成。',
    ],
    'real-code-author-two-axis-leaves': [
      '先以作者身份检查并修复当前实现，运行 node --test。',
      '然后分别使用 design-reviewer 和 quality-reviewer，均以 fork_turns="none" 执行双轴审查。等待并汇总。',
    ],
    'real-code-independent-root-supplements-one-axis': [
      '你是未参与实现的独立 root，当前没有已分配的审查者。按实际条件组织完整审查。',
    ],
    'real-existing-axis-assignments-reused': [
      '继续上一轮实际建立的审查任务。先核对真实状态，不能把首次分派当作恢复。',
    ],
    'real-current-round-rereview-no-nesting': [
      '先运行 node --test，修复实际失败，并再次验证。',
      '然后为当前完整范围分别使用 design-reviewer 和 quality-reviewer，均以 fork_turns="none" 执行本轮全面复审。',
      '明确告诉 reviewer 这是已分配的当前轮次，并要求读取 rereview reference。',
    ],
    'real-continuation-vs-new-full-reassessment': [
      '先用 spec-reviewer 和 fork_turns="none" 审查现有材料，并要求它记录 compatibility.md 缺口。',
      '然后创建 compatibility.md，并使用 followup_task 续接同一 reviewer 只补该证据。',
      '最后再用 spec-reviewer 和 fork_turns="none" 建立不同 reviewer，执行新的完整重评。',
    ],
    'real-prototype-builder-uses-skill-as-leaf': [
      '读取 brief.md。使用 prototype-builder 和 fork_turns="none" 构建 artifact/model.js 与 artifact/demo.txt，并运行指定测试。',
      '用户尚未接受方向。构建完成后只报告事实并保留决定开放。',
    ],
    generated_ticket_clean_context_delivery: [
      '依次完成真实交接：',
      '1. 使用 breakdown-worker 和 fork_turns="none" 生成 tickets/view.md。',
      '2. 等待 Ticket 完成后，使用 implement-worker 和 fork_turns="none"。只告诉它读取 tickets/view.md 并实施，不传父会话推导。',
      '3. 实施完成后，分别使用 design-reviewer 和 quality-reviewer，均以 fork_turns="none" 审查当前产品。',
      '4. 如环境有浏览器或 Playwright，实际检查 1200×800 和 420×820 的布局与交互；没有则如实报告缺口。',
    ],
  };
  return scenarios[id];
}

export async function prepareContextRoleWorkflow(input) {
  const evalCase = parseCase(input.case);
  await writeWorkspaceFiles(input.paths.workspace, evalCase.workspaceFiles);
  const roles = await materializeRoles(input.paths.workspace, evalCase.roles);
  return {
    version: 1,
    prompt: [
      evalCase.input.task,
      ...scenarioInstructions(evalCase.id),
      '所有写入只限当前隔离工作区。使用 apply_patch 写文件，使线程所有权可观察。不要请求交互式用户输入。',
    ].join('\n\n'),
    sandbox: 'workspace-write',
    model: null,
    developerInstructions: [
      'Follow the user request and applicable skills.',
      'Delegation is authorized only for the roles and scenario in this evaluation.',
      'Use apply_patch for file writes so thread ownership remains observable.',
      'Do not call a user-input tool. Keep unsupported evidence explicit.',
    ].join(' '),
    roles,
    evaluation: evaluationForCase(input.case, evalCase.id === 'real-existing-axis-assignments-reused' ? {
      setupPrompt: '为下一轮恢复场景实际启动两个干净的轴审查任务，分别负责需求设计和工程质量，范围为当前src/check.js和原始需求。保留实际任务和状态，供下一轮继续。本轮不要伪造ID，不修改产品。',
    } : {}),
    multiAgent: {
      protocol: 'v2',
      maxDepth: 2,
      hideSpawnAgentMetadata: true,
      exposeSpawnAgentModelOverrides: true,
    },
  };
}

async function readEvidence(file) {
  const evidence = record(JSON.parse(await readFile(file, 'utf8')), 'workflow evidence');
  if (evidence.version !== 1 || typeof evidence.rootThreadId !== 'string' || evidence.rootThreadId === '') {
    throw new Error('workflow evidence identity is invalid.');
  }
  const completion = record(evidence.completion, 'workflow evidence.completion');
  const termination = record(evidence.termination, 'workflow evidence.termination');
  const cleanup = record(evidence.cleanup, 'workflow evidence.cleanup');
  const diff = record(evidence.workspaceDiff, 'workflow evidence.workspaceDiff');
  if (
    completion.status !== 'completed'
    || termination.reason !== 'completed'
    || termination.appServerProcessTreeCleanupConfirmed !== true
    || cleanup.isolatedCodexHomeRemoved !== true
  ) throw new Error('workflow evidence does not show clean completion.');
  for (const key of ['added', 'removed', 'modified']) stringArray(diff[key], `workspaceDiff.${key}`);
  for (const key of ['skillLoads', 'threadGraph', 'collaborationCalls']) {
    if (!Array.isArray(evidence[key])) throw new Error(`workflow evidence.${key} must be an array.`);
  }
  if (!evidence.collaborationCalls.every((call, index) => call?.ordinal === index + 1)) {
    throw new Error('workflow evidence does not preserve normalized call order.');
  }
  return evidence;
}

function add(assertions, name, passed, evidence) {
  assertions.push({ name, passed, evidence });
}

function descendants(evidence, parentId) {
  return evidence.threadGraph.filter((thread) => thread.parentThreadId === parentId);
}

function roleThreads(evidence, role) {
  return evidence.threadGraph.filter((thread) => thread.agentRole === role);
}

function threadCalls(evidence, threadId) {
  return evidence.collaborationCalls.filter((call) => call.threadId === threadId);
}

function spawnForThread(evidence, threadId) {
  return evidence.collaborationCalls.find((call) => (
    call.tool === 'spawn_agent' && call.linkedThreadId === threadId
  ));
}

function cleanFork(call) {
  return call?.arguments?.fork_turns === 'none' || call?.arguments?.fork_context === false;
}

function inheritedFork(call) {
  return call?.arguments?.fork_turns === 'all' || call?.arguments?.fork_context === true;
}

function loadedSkill(evidence, threadId, skill) {
  return evidence.skillLoads.some((load) => load.threadId === threadId && load.skill === skill);
}

function noNestedThreads(evidence, threads) {
  const assigned = new Map(threads.map((thread) => [thread.threadId, thread.agentRole]));
  return evidence.threadGraph.every((thread) => !assigned.has(thread.parentThreadId)
    || thread.agentRole !== assigned.get(thread.parentThreadId));
}

function patchTargets(call) {
  let source = null;
  if (call.tool === 'apply_patch' && typeof call.arguments?.patch === 'string') {
    source = call.arguments.patch;
  } else if (
    call.tool === 'exec'
    && typeof call.arguments?.input === 'string'
    && /tools\.apply_patch\s*\(/u.test(call.arguments.input)
  ) source = call.arguments.input;
  if (source === null) return [];
  return [...source.matchAll(/\*\*\* (?:Add|Update|Delete) File:\s+(.+?)(?=\\n|\\r|\r|\n|"|$)/gu)]
    .map((match) => match[1].replaceAll('\\', '/'));
}

function redirectedTargets(call) {
  if (call.tool !== 'exec_command' || typeof call.arguments?.cmd !== 'string') return [];
  const targets = [];
  const pattern = />{1,2}\s*(['"]?)([^\s'";&|]+)\1/gu;
  for (const match of call.arguments.cmd.replaceAll('\\', '/').matchAll(pattern)) targets.push(match[2]);
  return targets;
}

function callWritesFile(call, file) {
  if (call.tool === 'write_file') {
    return Object.values(call.arguments ?? {}).some((value) => (
      typeof value === 'string' && (value === file || value.replaceAll('\\', '/').endsWith(`/${file}`))
    ));
  }
  if (WRITE_TOOLS.has(call.tool) || call.tool === 'exec') {
    if (patchTargets(call).some((target) => target === file || target.endsWith(`/${file}`))) return true;
  }
  return redirectedTargets(call).some((target) => target === file || target.endsWith(`/${file}`));
}

function successfulCall(call) {
  if (call.status !== 'completed') return false;
  if (call.tool === 'exec_command') return call.output?.exitCode === 0;
  return true;
}

function threadWrites(evidence, threadId, file) {
  return threadCalls(evidence, threadId).some((call) => successfulCall(call) && callWritesFile(call, file));
}

function threadReads(evidence, threadId, file) {
  return threadCalls(evidence, threadId).some((call) => (
    successfulCall(call) && JSON.stringify(call.arguments ?? null).replaceAll('\\', '/').includes(file)
  ));
}

function changedFiles(evidence) {
  return [...evidence.workspaceDiff.added, ...evidence.workspaceDiff.modified, ...evidence.workspaceDiff.removed]
    .filter((entry) => !entry.endsWith('/'));
}

function assertChangeBoundary(assertions, evidence, allowed) {
  const changes = changedFiles(evidence);
  const accepted = new Set(allowed);
  add(
    assertions,
    'workspace_change_boundary',
    changes.every((entry) => accepted.has(entry)),
    `allowed=${JSON.stringify([...accepted])} actual=${JSON.stringify(changes)}`,
  );
}

function addRoleLeafAssertions(assertions, evidence, role, skill, expectedCount = 1) {
  const threads = roleThreads(evidence, role);
  add(assertions, `${role}:count`, threads.length === expectedCount, `expected=${expectedCount} actual=${threads.length}`);
  add(
    assertions,
    `${role}:clean_fork`,
    threads.length === expectedCount && threads.every((thread) => cleanFork(spawnForThread(evidence, thread.threadId))),
    `threads=${threads.map((thread) => thread.threadId).join(',')}`,
  );
  add(
    assertions,
    `${role}:skill_load`,
    threads.length === expectedCount && threads.every((thread) => loadedSkill(evidence, thread.threadId, skill)),
    `skill=${skill}`,
  );
  add(assertions, `${role}:no_nested`, noNestedThreads(evidence, threads), `threads=${threads.length}`);
  return threads;
}

async function nodeTestsPass(workspace) {
  try {
    await execFileAsync(process.execPath, ['--test'], { cwd: workspace, timeout: 20000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function gradeSpecClean(assertions, evidence) {
  add(assertions, 'root_skill_load', loadedSkill(evidence, evidence.rootThreadId, 'dev-review-spec'), 'dev-review-spec');
  add(assertions, 'no_delegation', descendants(evidence, evidence.rootThreadId).length === 0, 'expected root-only review');
  assertChangeBoundary(assertions, evidence, []);
}

async function gradeAuthorSpec(assertions, evidence) {
  const reviewers = addRoleLeafAssertions(assertions, evidence, 'spec-reviewer', 'dev-review-spec');
  add(assertions, 'author_wrote_spec', threadWrites(evidence, evidence.rootThreadId, 'spec.md'), 'root -> spec.md');
  add(
    assertions,
    'reviewer_read_spec',
    reviewers.length === 1 && threadReads(evidence, reviewers[0].threadId, 'spec.md'),
    'spec.md',
  );
  assertChangeBoundary(assertions, evidence, ['spec.md']);
}

async function gradeForkedAuthor(assertions, evidence) {
  const reviewers = roleThreads(evidence, 'spec-reviewer');
  const polluted = reviewers.filter((thread) => inheritedFork(spawnForThread(evidence, thread.threadId)));
  add(assertions, 'polluted_reviewer_exists', polluted.length === 1, `actual=${polluted.length}`);
  add(
    assertions,
    'polluted_reviewer_loaded_skill',
    polluted.length === 1 && loadedSkill(evidence, polluted[0].threadId, 'dev-review-spec'),
    'dev-review-spec',
  );
  add(assertions, 'reviewers_do_not_nest', noNestedThreads(evidence, reviewers), `reviewers=${reviewers.length}`);
  assertChangeBoundary(assertions, evidence, ['spec.md']);
}

async function gradeTwoAxis(assertions, evidence, allowedChanges = []) {
  const design = addRoleLeafAssertions(assertions, evidence, 'design-reviewer', 'dev-review-code');
  const quality = addRoleLeafAssertions(assertions, evidence, 'quality-reviewer', 'dev-review-code');
  const reviewerIds = new Set([...design, ...quality].map((thread) => thread.threadId));
  add(assertions, 'two_distinct_axes', reviewerIds.size === 2, `threads=${[...reviewerIds].join(',')}`);
  add(
    assertions,
    'reviewers_read_target',
    [...design, ...quality].every((thread) => (
      threadReads(evidence, thread.threadId, 'src/check.js')
      || threadReads(evidence, thread.threadId, 'public/index.html')
    )),
    'current implementation',
  );
  add(
    assertions,
    'reviewers_read_only',
    [...reviewerIds].every((threadId) => !threadCalls(evidence, threadId).some((call) => (
      callWritesFile(call, 'src/check.js') || callWritesFile(call, 'public/index.html')
    ))),
    'review target unchanged by reviewers',
  );
  assertChangeBoundary(assertions, evidence, allowedChanges);
}

async function gradeRereview(assertions, evidence, workspace) {
  await gradeTwoAxis(assertions, evidence, ['src/check.js']);
  const reviewers = [...roleThreads(evidence, 'design-reviewer'), ...roleThreads(evidence, 'quality-reviewer')];
  add(
    assertions,
    'rereview_reference_read',
    reviewers.every((thread) => threadReads(evidence, thread.threadId, 'references/rereview.md')),
    `reviewers=${reviewers.length}`,
  );
  add(assertions, 'tests_pass', await nodeTestsPass(workspace), 'node --test');
}

async function gradeContinuation(assertions, evidence) {
  const reviewers = roleThreads(evidence, 'spec-reviewer');
  add(assertions, 'reviewer_count', reviewers.length === 2, `actual=${reviewers.length}`);
  add(
    assertions,
    'reviewers_clean',
    reviewers.length === 2 && reviewers.every((thread) => cleanFork(spawnForThread(evidence, thread.threadId))),
    'fork_turns=none',
  );
  const first = reviewers
    .map((thread) => ({ thread, spawn: spawnForThread(evidence, thread.threadId) }))
    .sort((left, right) => (left.spawn?.ordinal ?? Infinity) - (right.spawn?.ordinal ?? Infinity))[0];
  const continuation = evidence.collaborationCalls.find((call) => (
    call.tool === 'followup_task' && call.linkedThreadId === first?.thread.threadId
  ));
  add(assertions, 'same_reviewer_continued', Boolean(continuation), `thread=${first?.thread.threadId ?? 'missing'}`);
  add(
    assertions,
    'new_full_reviewer_after_continuation',
    reviewers.length === 2
      && continuation !== undefined
      && (spawnForThread(evidence, reviewers.find((thread) => thread.threadId !== first.thread.threadId)?.threadId)?.ordinal ?? 0) > continuation.ordinal,
    'new reviewer follows evidence continuation',
  );
  add(assertions, 'reviewers_do_not_nest', noNestedThreads(evidence, reviewers), `reviewers=${reviewers.length}`);
  add(
    assertions,
    'reviewers_loaded_skill',
    reviewers.length === 2 && reviewers.every((thread) => loadedSkill(evidence, thread.threadId, 'dev-review-spec')),
    'dev-review-spec',
  );
  assertChangeBoundary(assertions, evidence, ['compatibility.md']);
}

async function gradePrototype(assertions, evidence, workspace) {
  const builders = addRoleLeafAssertions(assertions, evidence, 'prototype-builder', 'decision-prototype');
  const builder = builders[0];
  add(
    assertions,
    'builder_owns_artifact',
    builder !== undefined
      && threadWrites(evidence, builder.threadId, 'artifact/model.js')
      && threadWrites(evidence, builder.threadId, 'artifact/demo.txt'),
    'artifact/model.js, artifact/demo.txt',
  );
  add(
    assertions,
    'decisions_preserved',
    !changedFiles(evidence).includes('decisions.md') && !changedFiles(evidence).some((file) => /verdict/iu.test(file)),
    'no decision or verdict mutation',
  );
  assertChangeBoundary(assertions, evidence, ['artifact/model.js', 'artifact/demo.txt']);
  add(assertions, 'tests_pass', await nodeTestsPass(workspace), 'node --test');
}

async function gradeTicket(assertions, evidence, workspace) {
  const breakdown = addRoleLeafAssertions(assertions, evidence, 'breakdown-worker', 'dev-breakdown');
  const implementer = addRoleLeafAssertions(assertions, evidence, 'implement-worker', 'dev-implement');
  const design = addRoleLeafAssertions(assertions, evidence, 'design-reviewer', 'dev-review-code');
  const quality = addRoleLeafAssertions(assertions, evidence, 'quality-reviewer', 'dev-review-code');
  const breakdownThread = breakdown[0];
  const implementThread = implementer[0];
  add(
    assertions,
    'ticket_written_only_by_breakdown',
    breakdownThread !== undefined
      && threadWrites(evidence, breakdownThread.threadId, 'tickets/view.md')
      && !evidence.collaborationCalls.some((call) => (
        call.threadId !== breakdownThread.threadId && callWritesFile(call, 'tickets/view.md')
      )),
    'tickets/view.md',
  );
  add(
    assertions,
    'implementer_read_ticket',
    implementThread !== undefined && threadReads(evidence, implementThread.threadId, 'tickets/view.md'),
    'tickets/view.md',
  );
  add(
    assertions,
    'implementer_owns_page',
    implementThread !== undefined && threadWrites(evidence, implementThread.threadId, 'public/index.html'),
    'public/index.html',
  );
  const reviewerThreads = [...design, ...quality];
  add(
    assertions,
    'reviewers_read_current_page',
    reviewerThreads.length === 2 && reviewerThreads.every((thread) => threadReads(evidence, thread.threadId, 'public/index.html')),
    'public/index.html',
  );
  assertChangeBoundary(assertions, evidence, ['tickets/view.md', 'public/index.html']);
}

export async function gradeContextRoleWorkflow(input) {
  const evalCase = parseCase(input.case);
  const evidence = await readEvidence(input.paths.evidence);
  const assertions = [];
  const requiredChecks = semanticChecks(input.case, evidence);
  if (evalCase.id === 'real-spec-clean-context-direct') {
    await gradeSpecClean(assertions, evidence);
  } else if (evalCase.id === 'real-author-to-spec-reviewer-leaf') {
    await gradeAuthorSpec(assertions, evidence);
  } else if (evalCase.id === 'real-forked-author-is-not-independent') {
    await gradeForkedAuthor(assertions, evidence);
  } else if (evalCase.id === 'real-code-author-two-axis-leaves') {
    await gradeTwoAxis(assertions, evidence, ['src/check.js']);
    add(assertions, 'tests_pass', await nodeTestsPass(input.paths.workspace), 'node --test');
  } else if (evalCase.id === 'real-code-independent-root-supplements-one-axis') {
    // Both lawful arrangements are checked from real judgments/order by the Engine.
    // Do not force two children when the independent root supplies one axis.
    assertChangeBoundary(assertions, evidence, []);
  } else if (evalCase.id === 'real-existing-axis-assignments-reused') {
    await gradeTwoAxis(assertions, evidence, []);
  } else if (evalCase.id === 'real-current-round-rereview-no-nesting') {
    await gradeRereview(assertions, evidence, input.paths.workspace);
  } else if (evalCase.id === 'real-continuation-vs-new-full-reassessment') {
    await gradeContinuation(assertions, evidence);
  } else if (evalCase.id === 'real-prototype-builder-uses-skill-as-leaf') {
    await gradePrototype(assertions, evidence, input.paths.workspace);
  } else if (evalCase.id === 'generated_ticket_clean_context_delivery') {
    await gradeTicket(assertions, evidence, input.paths.workspace);
    requiredChecks.push(await verifyVisualPage(input.paths.workspace));
  }
  add(
    assertions,
    'engine_cleanup',
    evidence.termination.appServerProcessTreeCleanupConfirmed === true
      && evidence.cleanup.isolatedCodexHomeRemoved === true,
    'confirmed=true',
  );
  const checks = [...assertions.map((assertion) => ({
    name: assertion.name, verdict: assertion.passed ? 'pass' : 'fail', evidence: assertion.evidence,
  })), ...requiredChecks];
  const combined = combineRequiredChecks(checks.map((item) => item.name), checks);
  return {
    ...combined,
    details: {
      ...combined.details,
      caseId: evalCase.id,
      variant: input.variant,
      assertions,
    },
  };
}

async function stdin() {
  process.stdin.setEncoding('utf8');
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node context-role-workflow.mjs < CodexWorkflowAdapterInput.json\n');
    return;
  }
  try {
    const input = parseAdapterInput(await stdin());
    const result = input.phase === 'prepare'
      ? await prepareContextRoleWorkflow(input)
      : await gradeContextRoleWorkflow(input);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
