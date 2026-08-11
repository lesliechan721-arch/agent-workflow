#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..', '..', '..');
const requireFromCli = createRequire(path.join(repositoryRoot, 'packages', 'cli', 'package.json'));
const { minimatch } = requireFromCli('minimatch');
const { parseTOML } = requireFromCli('toml-eslint-parser');

const CONTROL_MARKERS = [
  '只有', '仅当', '否则', '如果', '若', '之后', '然后', '直到', '同时最多',
  '不得', '必须', '继续', '停止', '重试', '恢复', '等待', '超时', '关闭',
  'only if', 'unless', 'otherwise', 'after', 'until', 'at most', 'must not',
  'retry', 'resume', 'wait', 'timeout', 'close', 'pending',
];
const LIFECYCLE_MARKERS = [
  '状态', '终态', '运行中', '活动通知', '完成通知', '超时', '等待窗口', '探测',
  '未决', '阻塞', '恢复额度', '重试', 'follow-up', '关闭', '后代', '取消',
  'status', 'terminal', 'running', 'timeout', 'probe', 'pending', 'blocked',
  'retry', 'followup', 'close', 'descendant', 'cancel',
];
const PROTOCOL_MARKERS = [
  'status=progress', 'status=blocked', 'send_message', 'send_input', 'wait_agent',
  'followup_task', 'close_agent', 'interrupt_agent', 'spawn_agent',
];
const POINTER_CONDITION_PATTERNS = [
  /(?:^|[\s|：；;])(?:当|若|如果|仅在|只在)/u,
  /计分前/u,
  /(?:quick|full|release|delta)(?:\s*\/\s*(?:quick|full|release|delta))*\s*模式/iu,
  /skill\s+(?:包含|含)/iu,
  /有上一版/u,
  /明确要求/u,
  /当前仓库的\s+aw\s+插件/iu,
  /\b(?:when|if|only when|before|after)\b/iu,
  /\bbranch\b/iu,
];
const WEAK_POINTER_PATTERNS = [
  /(?:详见|参见|查看)\s*(?:相关|上述|以下)?(?:参考资料|资料|文档)?[^\n]*references\//iu,
  /\b(?:see|refer to|read|check)\b[^\n]*\breferences\//iu,
];
const POINTER_TARGET_PREFIXES = ['references/'];
const TEXT_SUFFIXES = new Set([
  '.md', '.txt', '.py', '.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.json', '.toml', '.yaml', '.yml', '.csv', '.tsv', '.rb',
]);
const INTERACTIVE_PATTERNS = [
  /\binput\s*\(/u,
  /\bread\s+-p\b/u,
  /\bselect\s+\w+\s+in\b/u,
  /\bgetpass\s*\(/u,
  /\bprompt\s*\(/u,
];
const ABSOLUTE_PATH_PATTERNS = [
  /(?<![A-Za-z0-9_])\/(?:home|Users|mnt|tmp|var|opt)\/[^\s'"`]+/gu,
  /\b[A-Za-z]:\\\\[^\s'"`]+/gu,
];
const RESOURCE_PATTERN =
  /(?<![\w./-])((?:scripts|references|assets)\/[A-Za-z0-9_.()/-]+)/gu;
const EVAL_RESOURCE_PATTERN =
  /(?<![\w./-])(evals\/[A-Za-z0-9_.()/-]+)/gu;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__']);

function isSkillAuthorOnlyPath(relativePath) {
  const [topLevel] = normalizeRelative(relativePath).split('/').filter(Boolean);
  return topLevel === 'evals' || topLevel === 'reports';
}

function isSkillReportPath(relativePath) {
  const parts = normalizeRelative(relativePath).split('/').filter(Boolean);
  return parts[0] === 'reports' || (
    ['skills', 'templates'].includes(parts[0]) && parts[2] === 'reports'
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function digestDirectoryTree(root) {
  const hash = createHash('sha256');
  async function visit(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.join(prefix, entry.name);
      if (isSkillAuthorOnlyPath(relative)) continue;
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        hash.update(normalizeRelative(relative));
        hash.update('\0');
        hash.update(await readFile(absolute));
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Skill package cannot contain symlink: ${normalizeRelative(relative)}`);
      }
    }
  }
  await visit(root);
  return `sha256:${hash.digest('hex')}`;
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function countOccurrences(text, terms) {
  const lower = text.toLowerCase();
  return terms.reduce((total, term) => total + lower.split(term.toLowerCase()).length - 1, 0);
}

function repeatedParagraphCount(text) {
  const counts = new Map();
  for (const raw of text.split(/\n\s*\n/u)) {
    const normalized = raw.trim().replace(/\s+/gu, ' ').toLowerCase();
    if (normalized.length < 80) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function stateMachineRisk(control, lifecycle, protocol) {
  if (lifecycle >= 10 && control >= 18 && protocol >= 2) return 'high';
  if (
    (lifecycle >= 8 && control >= 15 && protocol >= 1) ||
    (lifecycle >= 16 && control >= 25)
  ) return 'medium';
  return 'low';
}

function textMetrics(text) {
  const control = countOccurrences(text, CONTROL_MARKERS);
  const lifecycle = countOccurrences(text, LIFECYCLE_MARKERS);
  const protocol = countOccurrences(text, PROTOCOL_MARKERS);
  const bytes = Buffer.byteLength(text, 'utf8');
  return {
    lines: text.split('\n').length,
    characters: Array.from(text).length,
    bytes,
    estimated_tokens: Math.max(1, Math.ceil(bytes / 4)),
    headings: [...text.matchAll(/^#{1,6}\s+/gmu)].length,
    control_markers: control,
    lifecycle_markers: lifecycle,
    protocol_markers: protocol,
    backtick_terms: [...text.matchAll(/`([^`\n]+)`/gu)].length,
    repeated_paragraphs: repeatedParagraphCount(text),
    state_machine_risk: stateMachineRisk(control, lifecycle, protocol),
  };
}

function parseArgs(argv) {
  const options = {
    target: undefined,
    evaluation: undefined,
    previous: undefined,
    related: [],
    format: 'text',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--evaluation', '--previous', '--related', '--format'].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      if (arg === '--evaluation') options.evaluation = path.resolve(value);
      else if (arg === '--previous') options.previous = path.resolve(value);
      else if (arg === '--related') options.related.push(value);
      else options.format = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.target) {
      options.target = arg;
    } else {
      throw new Error('Only one review target may be supplied.');
    }
  }
  if (!options.target) {
    throw new Error(
      'Usage: inspect_skill_target.mjs <plugin-or-skill-name-or-dir> ' +
      '[--evaluation evaluation.json] [--previous SKILL.md] ' +
      '[--related path-or-glob] [--format text|json]',
    );
  }
  if (!['text', 'json'].includes(options.format)) {
    throw new Error('--format must be text or json.');
  }
  return options;
}

async function classifyTarget(candidate) {
  const resolved = path.resolve(candidate);
  if (await isFile(resolved)) {
    return path.basename(resolved) === 'SKILL.md'
      ? { kind: 'static-skill', root: path.dirname(resolved) }
      : null;
  }
  if (await isFile(path.join(resolved, '.agents-plugin', 'plugin.json'))) {
    return { kind: 'aw-plugin', root: resolved };
  }
  if (await isFile(path.join(resolved, 'SKILL.md'))) {
    return { kind: 'static-skill', root: resolved };
  }
  return null;
}

async function resolveReviewTarget(target) {
  for (const candidate of [
    target,
    path.join('plugins', target),
    path.join('.agents', 'skills', target),
  ]) {
    const resolved = await classifyTarget(candidate);
    if (resolved) return resolved;
  }
  throw new Error(`Skill review target not found: ${target}`);
}

async function walkFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    if (entry.isFile() && entry.name.endsWith('.pyc')) continue;
    const next = path.join(relative, entry.name);
    if (isSkillReportPath(next)) continue;
    if (entry.isDirectory()) files.push(...await walkFiles(root, next));
    else if (entry.isFile()) files.push(normalizeRelative(next));
  }
  return files;
}

async function safeReadText(candidate) {
  if (path.basename(candidate) !== 'SKILL.md' && !TEXT_SUFFIXES.has(path.extname(candidate).toLowerCase())) {
    return null;
  }
  try {
    return await readFile(candidate, 'utf8');
  } catch {
    return null;
  }
}

async function inventory(root) {
  const files = [];
  for (const relative of await walkFiles(root)) {
    const absolute = path.join(root, relative);
    const fileStat = await stat(absolute);
    files.push({
      path: relative,
      bytes: fileStat.size,
      category: relative.includes('/') ? relative.split('/', 1)[0] : 'root',
      text: await safeReadText(absolute) !== null,
    });
  }
  return files;
}

function splitSkill(content, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(content);
  if (!match) throw new Error(`${label} must start with valid YAML frontmatter.`);
  const frontmatter = YAML.parse(match[1]);
  if (!isRecord(frontmatter)) throw new Error(`${label} frontmatter must be an object.`);
  return { frontmatter, body: content.slice(match[0].length) };
}

function issue(level, code, message, issuePath = undefined) {
  return { level, code, message, ...(issuePath ? { path: issuePath } : {}) };
}

function validateFrontmatter(frontmatter, skillRoot) {
  const issues = [];
  const name = frontmatter.name;
  const description = frontmatter.description;
  const compatibility = frontmatter.compatibility;
  const metadata = frontmatter.metadata;
  const allowedTools = frontmatter['allowed-tools'];

  if (typeof name !== 'string' || name.length === 0) {
    issues.push(issue('error', 'frontmatter.name', 'name is required and must be a non-empty string.'));
  } else {
    if (Array.from(name).length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      issues.push(issue('error', 'frontmatter.name-format', 'name must be <=64 characters and use lowercase alphanumerics separated by single hyphens.'));
    }
    if (path.basename(skillRoot) !== name) {
      issues.push(issue('error', 'frontmatter.directory-name', `directory name '${path.basename(skillRoot)}' does not match skill name '${name}'.`));
    }
  }
  if (typeof description !== 'string' || description.trim() === '') {
    issues.push(issue('error', 'frontmatter.description', 'description is required and must be non-empty.'));
  } else if (Array.from(description).length > 1024) {
    issues.push(issue('error', 'frontmatter.description-length', `description has ${Array.from(description).length} characters; maximum is 1024.`));
  }
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string') {
      issues.push(issue('error', 'frontmatter.compatibility', 'compatibility must be a string.'));
    } else if (Array.from(compatibility).length < 1 || Array.from(compatibility).length > 500) {
      issues.push(issue('error', 'frontmatter.compatibility-length', `compatibility has ${Array.from(compatibility).length} characters; allowed range is 1-500.`));
    }
  }
  if (metadata !== undefined) {
    if (!isRecord(metadata)) {
      issues.push(issue('error', 'frontmatter.metadata', 'metadata must be a mapping.'));
    } else if (Object.entries(metadata).some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) {
      issues.push(issue('error', 'frontmatter.metadata-values', 'metadata keys and values must be strings.'));
    }
  }
  if (allowedTools !== undefined && typeof allowedTools !== 'string') {
    issues.push(issue('error', 'frontmatter.allowed-tools', 'allowed-tools must be a space-separated string.'));
  }
  return issues;
}

function extractResourceRefs(text, options = {}) {
  const matches = [...text.matchAll(RESOURCE_PATTERN)];
  if (options.includeEvals) matches.push(...text.matchAll(EVAL_RESOURCE_PATTERN));
  return [...new Set(matches.map((match) =>
    match[1].replace(/[.,;:!?)>\]}'"]+$/gu, ''),
  ))].sort();
}

function pointerDiagnostics(body) {
  const entries = [];
  for (const [index, rawLine] of body.split('\n').entries()) {
    const targets = extractResourceRefs(rawLine)
      .filter((ref) => POINTER_TARGET_PREFIXES.some((prefix) => ref.startsWith(prefix)));
    if (targets.length === 0) continue;
    const conditional = POINTER_CONDITION_PATTERNS.some((pattern) => pattern.test(rawLine));
    const structuredTableRow = /^\s*\|.*\|\s*$/u.test(rawLine);
    const weak = !conditional && !structuredTableRow &&
      WEAK_POINTER_PATTERNS.some((pattern) => pattern.test(rawLine));
    entries.push({
      line: index + 1,
      targets,
      conditional_signal: conditional,
      weak_signal: weak,
      text: rawLine.trim(),
    });
  }
  return {
    entries,
    total: entries.length,
    conditional_signals: entries.filter((entry) => entry.conditional_signal).length,
    weak_signal_lines: entries
      .filter((entry) => entry.weak_signal)
      .map((entry) => entry.line),
    note:
      'Weak pointer hints require an explicit weak phrase without a branch signal. ' +
      'Structured routing tables and always-needed workflow references are not flagged.',
  };
}

async function buildReferenceGraph(skillRoot, files) {
  const textFiles = new Set(files.filter((entry) => entry.text).map((entry) => entry.path));
  const graph = {};
  const missing = [];
  for (const relative of [...textFiles].sort()) {
    const text = await safeReadText(path.join(skillRoot, relative));
    if (text === null) continue;
    const refs = extractResourceRefs(text, { includeEvals: relative === 'SKILL.md' });
    graph[relative] = refs;
    for (const ref of refs) {
      if (!(await pathExists(path.join(skillRoot, ref)))) {
        missing.push({ source: relative, target: ref });
      }
    }
  }

  const reachable = new Set(['SKILL.md']);
  const depths = { 'SKILL.md': 0 };
  const queue = ['SKILL.md'];
  while (queue.length > 0) {
    const source = queue.shift();
    for (const target of graph[source] ?? []) {
      if (!(await pathExists(path.join(skillRoot, target))) || reachable.has(target)) continue;
      reachable.add(target);
      depths[target] = depths[source] + 1;
      if (graph[target]) queue.push(target);
    }
  }
  const runtimeResources = new Set(files
    .map((entry) => entry.path)
    .filter((relative) => relative.startsWith('scripts/') || relative.startsWith('references/') || relative.startsWith('assets/')));
  return {
    graph,
    missing,
    reachable: [...reachable].sort(),
    unreachable_runtime_resources: [...runtimeResources].filter((relative) => !reachable.has(relative)).sort(),
    deep_reference_paths: Object.entries(depths).filter(([, depth]) => depth > 1).map(([relative]) => relative).sort(),
    depths,
  };
}

async function scriptDiagnostics(skillRoot, files) {
  const results = [];
  for (const entry of files.filter((file) => file.path.startsWith('scripts/'))) {
    const absolute = path.join(skillRoot, entry.path);
    const text = await safeReadText(absolute);
    const mode = (await stat(absolute)).mode;
    const result = {
      path: entry.path,
      bytes: entry.bytes,
      executable: Boolean(mode & 0o100),
      text_readable: text !== null,
    };
    if (text !== null) {
      const lower = text.toLowerCase();
      result.has_shebang = text.startsWith('#!');
      result.interactive_signals = INTERACTIVE_PATTERNS.filter((pattern) => pattern.test(text)).length;
      result.help_signals = ['argparse', '--help', 'getopts', 'typer', 'click.command', 'usage:']
        .some((token) => lower.includes(token));
      result.structured_output_signals = ['json.stringify', 'json.dumps', 'json.dump', 'csv.writer', 'to_csv', 'application/json']
        .some((token) => lower.includes(token));
      result.stderr_signals = ['file=sys.stderr', '>&2', 'console.error', 'process.stderr']
        .some((token) => lower.includes(token));
      result.dependency_declaration_signals = ['# /// script', 'requirements', 'package.json', 'bundler/inline', 'npm:', 'jsr:']
        .some((token) => lower.includes(token));
      result.dry_run_signals = lower.includes('dry-run') || lower.includes('dry_run');
      result.absolute_path_signals = ABSOLUTE_PATH_PATTERNS.reduce(
        (total, pattern) => total + [...text.matchAll(pattern)].length,
        0,
      );
    }
    results.push(result);
  }
  return { files: results, count: results.length, executed: false };
}

async function evalDiagnostics(skillRoot, files) {
  const parsed = [];
  const errors = [];
  let triggerTotal = 0;
  let triggerPositive = 0;
  let triggerNegative = 0;
  let conversationCases = 0;
  let portableBehaviorSpecs = 0;
  let scoringCases = 0;
  for (const entry of files.filter((file) =>
    file.path.startsWith('evals/') &&
    !file.path.startsWith('evals/workspace/') &&
    file.path.endsWith('.json'))) {
    try {
      const data = JSON.parse(await readFile(path.join(skillRoot, entry.path), 'utf8'));
      if (isRecord(data) && typeof data.skill_name === 'string' && Array.isArray(data.evals)) {
        parsed.push({
          path: entry.path,
          kind: 'agent-skill',
          evidence_level: 'executable-conversation',
          cases: data.evals.length,
        });
        conversationCases += data.evals.length;
        continue;
      }
      if (
        isRecord(data) &&
        data.schemaVersion === 1 &&
        typeof data.skill === 'string' &&
        Array.isArray(data.cases)
      ) {
        const cases = data.cases.filter(isRecord);
        if (cases.length !== data.cases.length || cases.some((item) => {
          const hasLegacyExpectation = typeof item.should_load_skill === 'boolean';
          const hasRouteExpectation = Array.isArray(item.expected_loaded_skills) &&
            item.expected_loaded_skills.every((skillName) => typeof skillName === 'string');
          return typeof item.query !== 'string' || hasLegacyExpectation === hasRouteExpectation;
        })) {
          throw new Error('trigger case document contains invalid cases');
        }
        parsed.push({ path: entry.path, kind: 'trigger', cases: cases.length });
        triggerTotal += cases.length;
        triggerPositive += cases.filter((item) => item.should_load_skill === true || (
          Array.isArray(item.expected_loaded_skills) && item.expected_loaded_skills.includes(data.skill)
        )).length;
        triggerNegative += cases.filter((item) => item.should_load_skill === false || (
          Array.isArray(item.expected_loaded_skills) && !item.expected_loaded_skills.includes(data.skill)
        )).length;
        continue;
      }
      if (
        isRecord(data) &&
        [1, 2].includes(data.schemaVersion) &&
        typeof data.skill === 'string' &&
        Array.isArray(data.suites)
      ) {
        parsed.push({ path: entry.path, kind: 'manifest', cases: data.suites.length });
        continue;
      }
      if (!Array.isArray(data)) throw new Error('top-level JSON must be a list or an Agent Skill eval document');
      let kind = 'unknown';
      if (data.length > 0 && data.every((item) => isRecord(item) && 'query' in item && 'should_trigger' in item)) {
        kind = 'trigger';
        triggerTotal += data.length;
        triggerPositive += data.filter((item) => item.should_trigger === true).length;
        triggerNegative += data.filter((item) => item.should_trigger === false).length;
      } else if (data.length > 0 && data.every((item) => isRecord(item) && 'assertions' in item)) {
        kind = 'behavior';
        portableBehaviorSpecs += data.length;
      } else if (entry.path.includes('scoring')) {
        kind = 'scoring';
        scoringCases += data.length;
      }
      parsed.push({
        path: entry.path,
        kind,
        ...(kind === 'behavior' ? { evidence_level: 'portable-spec' } : {}),
        cases: data.length,
      });
    } catch (error) {
      errors.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    files: parsed,
    parse_errors: errors,
    trigger: { total: triggerTotal, positive: triggerPositive, negative: triggerNegative },
    behavior_cases: conversationCases,
    conversation_cases: conversationCases,
    portable_behavior_specs: portableBehaviorSpecs,
    behavior_evidence_note:
      'Portable behavior specs are design and calibration inputs, not executable release evidence.',
    scoring_cases: scoringCases,
  };
}

function tomlKeySegments(key) {
  return key.keys.map((segment) => segment.type === 'TOMLBare' ? segment.name : segment.value);
}

function readTopLevelTomlString(table, keyName) {
  const entry = table.body.find((node) =>
    node.type === 'TOMLKeyValue' &&
    tomlKeySegments(node.key).length === 1 &&
    tomlKeySegments(node.key)[0] === keyName
  );
  return entry?.value?.type === 'TOMLValue' && entry.value.kind === 'string'
    ? entry.value.value
    : undefined;
}

async function expandGlobPattern(patternValue, skillRoot) {
  const candidates = [
    path.isAbsolute(patternValue) ? patternValue : path.resolve(patternValue),
    path.isAbsolute(patternValue) ? patternValue : path.resolve(skillRoot, patternValue),
  ];
  const results = new Set();
  for (const pattern of candidates) {
    if (!/[*?[\]]/u.test(pattern)) {
      if (await isFile(pattern)) results.add(path.resolve(pattern));
      continue;
    }
    const firstMagic = pattern.search(/[*?[\]]/u);
    const prefix = pattern.slice(0, firstMagic);
    let searchRoot = prefix.endsWith(path.sep) ? prefix.slice(0, -1) : path.dirname(prefix);
    while (searchRoot && !(await pathExists(searchRoot))) {
      const parent = path.dirname(searchRoot);
      if (parent === searchRoot) break;
      searchRoot = parent;
    }
    if (!searchRoot || !(await pathExists(searchRoot))) continue;
    for (const relative of await walkFiles(searchRoot)) {
      const absolute = path.join(searchRoot, relative);
      if (minimatch(normalizeRelative(absolute), normalizeRelative(pattern), { dot: true })) {
        results.add(path.resolve(absolute));
      }
    }
  }
  return [...results];
}

async function expandRelated(patterns, skillRoot) {
  if (patterns.length === 0) {
    return (await readdir(skillRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
      .map((entry) => path.join(skillRoot, entry.name))
      .sort();
  }
  const paths = new Set();
  for (const patternValue of patterns) {
    for (const candidate of await expandGlobPattern(patternValue, skillRoot)) paths.add(candidate);
  }
  return [...paths].sort();
}

async function inspectRoles(paths) {
  const parsed = [];
  const errors = [];
  const instructionGroups = new Map();
  const protocolFiles = [];
  for (const rolePath of [...new Set(paths)].filter((candidate) => candidate.endsWith('.toml')).sort()) {
    try {
      const content = await readFile(rolePath, 'utf8');
      const ast = parseTOML(content);
      const topLevel = ast.body[0];
      const instruction = readTopLevelTomlString(topLevel, 'developer_instructions');
      if (typeof instruction === 'string') {
        const digest = sha256(instruction).slice('sha256:'.length, 'sha256:'.length + 12);
        const group = instructionGroups.get(digest) ?? [];
        group.push(path.basename(rolePath));
        instructionGroups.set(digest, group);
        if (countOccurrences(instruction, PROTOCOL_MARKERS) > 0) protocolFiles.push(path.basename(rolePath));
      }
      parsed.push({
        file: path.basename(rolePath),
        path: rolePath,
        name: readTopLevelTomlString(topLevel, 'name') ?? null,
        description: readTopLevelTomlString(topLevel, 'description') ?? null,
        model: readTopLevelTomlString(topLevel, 'model') ?? null,
        reasoning_effort: readTopLevelTomlString(topLevel, 'model_reasoning_effort') ?? null,
        developer_instruction_chars: typeof instruction === 'string' ? Array.from(instruction).length : null,
        developer_instruction_metrics: typeof instruction === 'string' ? textMetrics(instruction) : null,
      });
    } catch (error) {
      errors.push({ file: rolePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    files: parsed,
    parse_errors: errors,
    identical_instruction_groups: [...instructionGroups.values()].filter((files) => files.length >= 2),
    roles_with_protocol_markers: protocolFiles,
  };
}

async function comparePrevious(previousPath, currentBody) {
  if (!previousPath) return null;
  const oldContent = await readFile(previousPath, 'utf8');
  let oldBody = oldContent;
  try {
    oldBody = splitSkill(oldContent, previousPath).body;
  } catch {
    // A plain Markdown baseline still provides useful text metrics.
  }
  const oldMetrics = textMetrics(oldBody);
  const newMetrics = textMetrics(currentBody);
  return {
    previous: path.resolve(previousPath),
    delta: {
      lines: newMetrics.lines - oldMetrics.lines,
      characters: newMetrics.characters - oldMetrics.characters,
      bytes: newMetrics.bytes - oldMetrics.bytes,
      estimated_tokens: newMetrics.estimated_tokens - oldMetrics.estimated_tokens,
      control_markers: newMetrics.control_markers - oldMetrics.control_markers,
      lifecycle_markers: newMetrics.lifecycle_markers - oldMetrics.lifecycle_markers,
      protocol_markers: newMetrics.protocol_markers - oldMetrics.protocol_markers,
      repeated_paragraphs: newMetrics.repeated_paragraphs - oldMetrics.repeated_paragraphs,
    },
    previous_metrics: oldMetrics,
  };
}

async function inspectCodexMetadata(skillRoot) {
  const metadataPath = path.join(skillRoot, 'agents', 'openai.yaml');
  if (!(await isFile(metadataPath))) return null;
  const content = await readFile(metadataPath, 'utf8');
  const parsed = YAML.parse(content);
  if (!isRecord(parsed)) throw new Error('agents/openai.yaml must contain a YAML object.');
  return {
    path: 'agents/openai.yaml',
    digest: sha256(content),
    display_name: parsed.interface?.display_name ?? null,
    short_description: parsed.interface?.short_description ?? null,
    default_prompt: parsed.interface?.default_prompt ?? null,
    allow_implicit_invocation: parsed.policy?.allow_implicit_invocation ?? null,
  };
}

function deriveIssues({
  skillRoot,
  frontmatter,
  metrics,
  references,
  pointers,
  scripts,
  evals,
  roles,
  previous,
  codexMetadata,
}) {
  const issues = validateFrontmatter(frontmatter, skillRoot);
  if (metrics.lines > 500) issues.push(issue('warning', 'body.lines', `SKILL.md body has ${metrics.lines} lines; recommended maximum is 500.`));
  if (metrics.estimated_tokens > 5000) issues.push(issue('warning', 'body.tokens', `Estimated SKILL.md body size is ${metrics.estimated_tokens} tokens; recommended maximum is 5000.`));
  if (metrics.state_machine_risk === 'high') issues.push(issue('warning', 'architecture.state-machine', 'High heuristic natural-language state-machine risk; review ownership before adding more prose.'));
  else if (metrics.state_machine_risk === 'medium') issues.push(issue('info', 'architecture.state-machine', 'Moderate lifecycle/control-flow density; check whether rules belong in runtime, scripts, or evals.'));
  if (metrics.repeated_paragraphs > 0) issues.push(issue('info', 'body.repetition', `Detected ${metrics.repeated_paragraphs} repeated long paragraph(s).`));
  for (const missing of references.missing) {
    const level = missing.source === 'SKILL.md' ? 'error' : 'info';
    const code = missing.source === 'SKILL.md' ? 'reference.missing' : 'reference.nested-missing';
    issues.push(issue(level, code, `Referenced file does not exist: ${missing.target} (from ${missing.source}).`, missing.source));
  }
  if (references.deep_reference_paths.length > 0) issues.push(issue('warning', 'reference.deep-chain', `Resources are only reachable through nested references: ${references.deep_reference_paths.join(', ')}`));
  if (references.unreachable_runtime_resources.length > 0) issues.push(issue('info', 'resource.unreachable', `Runtime resources not reachable from SKILL.md: ${references.unreachable_runtime_resources.join(', ')}`));
  if (pointers.weak_signal_lines.length > 0) {
    issues.push(issue(
      'info',
      'pointer.weak-signal',
      'Reference/asset pointers without an obvious condition marker appear on SKILL.md body lines: ' +
        `${pointers.weak_signal_lines.join(', ')}. Review semantically; always-needed workflow references may be valid.`,
      'SKILL.md',
    ));
  }
  for (const script of scripts.files) {
    if (!script.text_readable) continue;
    if (script.interactive_signals > 0) issues.push(issue('warning', 'script.interactive', 'Possible interactive prompt in agent-facing script.', script.path));
    if (!script.help_signals) issues.push(issue('info', 'script.help', 'No clear --help/usage signal detected; verify interface manually.', script.path));
    if (script.absolute_path_signals > 0) issues.push(issue('warning', 'script.absolute-path', 'Possible hard-coded absolute path detected.', script.path));
  }
  for (const error of evals.parse_errors) issues.push(issue('error', 'eval.parse', error.error, error.path));
  if (evals.trigger.total > 0 && (evals.trigger.positive === 0 || evals.trigger.negative === 0)) issues.push(issue('warning', 'eval.trigger-balance', 'Trigger eval lacks positive or negative cases.'));
  if (evals.trigger.total > 0 && evals.trigger.total < 16) issues.push(issue('info', 'eval.trigger-size', `Trigger eval has ${evals.trigger.total} cases; around 20 realistic cases is a useful target.`));
  for (const error of roles.parse_errors) issues.push(issue('error', 'role.parse', error.error, error.file));
  if (roles.roles_with_protocol_markers.length >= 2) issues.push(issue('warning', 'roles.protocol-coupling', `Lifecycle/protocol terms appear in multiple role instructions: ${roles.roles_with_protocol_markers.join(', ')}`));
  if (previous?.delta.characters > 0 && previous.delta.control_markers > 0 && previous.delta.lifecycle_markers > 0) issues.push(issue('warning', 'delta.control-growth', 'Revision increased text size, control-flow markers, and lifecycle markers; require behavior evidence for the growth.'));
  if (codexMetadata) {
    if (typeof codexMetadata.allow_implicit_invocation !== 'boolean') issues.push(issue('error', 'codex.policy', 'agents/openai.yaml must set policy.allow_implicit_invocation to a boolean.', codexMetadata.path));
    if (typeof codexMetadata.display_name !== 'string' || codexMetadata.display_name.trim() === '' || Array.from(codexMetadata.display_name).length > 64) issues.push(issue('error', 'codex.display-name', 'interface.display_name must be a non-empty string up to 64 characters.', codexMetadata.path));
    const shortLength = typeof codexMetadata.short_description === 'string' ? Array.from(codexMetadata.short_description.trim()).length : 0;
    if (shortLength < 25 || shortLength > 64) issues.push(issue('error', 'codex.short-description', 'interface.short_description must contain 25-64 characters.', codexMetadata.path));
    if (typeof codexMetadata.default_prompt !== 'string' || !codexMetadata.default_prompt.includes(`$${frontmatter.name}`)) issues.push(issue('error', 'codex.default-prompt', `interface.default_prompt must explicitly reference $${frontmatter.name}.`, codexMetadata.path));
  }
  return issues;
}

async function inspectStaticSkill(skillRoot, options = {}) {
  const skillFile = path.join(skillRoot, 'SKILL.md');
  const content = await readFile(skillFile, 'utf8');
  const { frontmatter, body } = splitSkill(content, skillFile);
  const files = await inventory(skillRoot);
  const references = await buildReferenceGraph(skillRoot, files);
  const pointers = pointerDiagnostics(body);
  const scripts = await scriptDiagnostics(skillRoot, files);
  const evals = await evalDiagnostics(skillRoot, files);
  const relatedPaths = await expandRelated(options.related ?? [], skillRoot);
  const roles = await inspectRoles(relatedPaths);
  const previous = await comparePrevious(options.previous, body);
  const codexMetadata = await inspectCodexMetadata(skillRoot);
  const metrics = textMetrics(body);
  const issues = deriveIssues({
    skillRoot,
    frontmatter,
    metrics,
    references,
    pointers,
    scripts,
    evals,
    roles,
    previous,
    codexMetadata,
  });
  const categorySizes = {};
  for (const entry of files) {
    categorySizes[entry.category] ??= { files: 0, bytes: 0 };
    categorySizes[entry.category].files += 1;
    categorySizes[entry.category].bytes += entry.bytes;
  }
  return {
    skill: {
      directory: path.resolve(skillRoot),
      file: path.resolve(skillFile),
      frontmatter,
      body_metrics: metrics,
      codex_metadata: codexMetadata,
    },
    package: {
      files,
      category_sizes: categorySizes,
      total_files: files.length,
      total_bytes: files.reduce((total, entry) => total + entry.bytes, 0),
      content_digest: await digestDirectoryTree(skillRoot),
    },
    references,
    pointers,
    scripts,
    evals,
    related_toml: roles,
    previous_comparison: previous,
    issues,
    note:
      'Static and heuristic diagnostics require reviewer judgment; reviewed scripts were not ' +
      'executed and pointer quality was not semantically graded.',
  };
}

async function readJson(candidate, label) {
  try {
    return JSON.parse(await readFile(candidate, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function inspectEvaluation(evaluationPath, expectedTarget) {
  if (!evaluationPath) return { evaluation: null, issues: [], finalSkillTargets: [], rolePaths: [] };
  const value = await readJson(evaluationPath, 'EvaluationBundle');
  if (!isRecord(value) || ![1, 2].includes(value.schemaVersion) || value.platform !== 'codex') {
    throw new Error('EvaluationBundle must use schemaVersion=1|2 and platform=codex.');
  }
  const issues = [];
  const evaluationTarget = isRecord(value.target)
    ? { kind: value.target.kind, name: value.target.name }
    : { kind: 'aw-plugin', name: value.plugin };
  if (
    evaluationTarget.kind !== expectedTarget.kind ||
    evaluationTarget.name !== expectedTarget.name
  ) {
    issues.push(issue(
      'error',
      'evaluation.target-mismatch',
      `EvaluationBundle target '${String(evaluationTarget.kind)}:${String(evaluationTarget.name)}' ` +
        `does not match '${expectedTarget.kind}:${expectedTarget.name}'.`,
      evaluationPath,
    ));
  }
  if (
    expectedTarget.kind === 'static-skill' &&
    expectedTarget.sourceDigest &&
    isRecord(value.target) &&
    value.target.sourceDigest !== expectedTarget.sourceDigest
  ) {
    issues.push(issue(
      'error',
      'evaluation.source-digest',
      'EvaluationBundle source digest does not match the current static Skill package.',
      evaluationPath,
    ));
  }
  if (value.outcome === 'incomplete' || value.complete !== true) {
    issues.push(issue('warning', 'evaluation.incomplete', 'EvaluationBundle is incomplete.', evaluationPath));
  }
  if (value.outcome === 'failed' || value.mechanicalPassed === false) {
    issues.push(issue('error', 'evaluation.failed', 'EvaluationBundle reports a failed evaluation.', evaluationPath));
  }
  const finalSkillTargets = [];
  const rolePaths = [];
  const subjects = [];
  for (const subject of Array.isArray(value.subjects) ? value.subjects.filter(isRecord) : []) {
    const evaluationRoot = path.dirname(evaluationPath);
    const resolvedRoot = typeof subject.root === 'string' && !path.isAbsolute(subject.root)
      ? path.resolve(evaluationRoot, subject.root)
      : null;
    const root = resolvedRoot && isPathInside(evaluationRoot, resolvedRoot)
      ? resolvedRoot
      : null;
    const artifacts = [];
    if (!root || !(await pathExists(root))) {
      issues.push(issue('error', 'evaluation.subject-root', `Materialized subject root is missing for profile '${subject.profile}'.`, evaluationPath));
    }
    for (const artifact of Array.isArray(subject.artifacts) ? subject.artifacts.filter(isRecord) : []) {
      const absolute = root && typeof artifact.path === 'string'
        ? path.resolve(root, artifact.path)
        : null;
      let exists = false;
      let digestMatches = null;
      if (absolute && isPathInside(root, absolute)) {
        exists = await isFile(absolute);
        if (exists && typeof artifact.contentDigest === 'string') {
          digestMatches = sha256(await readFile(absolute)) === artifact.contentDigest;
        }
      }
      if (!exists) {
        issues.push(issue('error', 'evaluation.artifact-missing', `Artifact '${artifact.path}' is missing for profile '${subject.profile}'.`, evaluationPath));
      } else if (digestMatches === false) {
        issues.push(issue('error', 'evaluation.artifact-digest', `Artifact '${artifact.path}' digest differs for profile '${subject.profile}'.`, evaluationPath));
      }
      let packageDigestMatches = null;
      if (
        root &&
        typeof artifact.packagePath === 'string' &&
        typeof artifact.packageContentDigest === 'string'
      ) {
        const packageRoot = path.resolve(root, artifact.packagePath);
        if (!isPathInside(root, packageRoot) || !(await pathExists(packageRoot))) {
          packageDigestMatches = false;
        } else {
          packageDigestMatches = await digestDirectoryTree(packageRoot) === artifact.packageContentDigest;
        }
        if (!packageDigestMatches) {
          issues.push(issue('error', 'evaluation.package-digest', `Skill package digest differs for profile '${subject.profile}'.`, evaluationPath));
        }
      }
      const normalized = {
        kind: artifact.kind,
        key: artifact.key ?? null,
        path: artifact.path,
        absolute_path: absolute,
        content_digest: artifact.contentDigest,
        exists,
        digest_matches: digestMatches,
        package_path: artifact.packagePath ?? null,
        package_content_digest: artifact.packageContentDigest ?? null,
        package_digest_matches: packageDigestMatches,
      };
      artifacts.push(normalized);
      if (exists && artifact.kind === 'skill' && path.basename(artifact.path) === 'SKILL.md') {
        finalSkillTargets.push({ profile: subject.profile, scope: subject.scope, artifact: normalized });
      }
      if (exists && artifact.kind === 'agent' && artifact.path.endsWith('.toml')) rolePaths.push(absolute);
    }
    subjects.push({
      profile: subject.profile,
      scope: subject.scope,
      model_execution: subject.modelExecution,
      evidence_level: subject.evidenceLevel,
      root,
      config_digest: subject.configDigest,
      bundle_digest: subject.bundleDigest,
      artifacts,
    });
  }
  const rawSuites = Array.isArray(value.suites) ? value.suites : [];
  const suites = rawSuites.filter(isRecord).map((suite) => ({
    id: suite.id,
    kind: suite.kind,
    profile: suite.profile,
    split: suite.split,
    outcome: suite.outcome,
    complete: suite.complete,
    mechanical_passed: suite.mechanicalPassed,
    qualitative_review: suite.qualitativeReview,
    summary: suite.summary,
    diagnostics: suite.diagnostics,
  }));
  if (expectedTarget.kind === 'static-skill') {
    const staticSubjects = subjects.filter((subject) =>
      subject.scope === 'project' && subject.model_execution === true);
    if (staticSubjects.length === 0) {
      issues.push(issue(
        'error',
        'evaluation.static-subject',
        'Static Skill evaluation must contain a project subject with model execution evidence.',
        evaluationPath,
      ));
    }
    const expectedArtifactPath = `.agents/skills/${expectedTarget.name}/SKILL.md`;
    const matchingArtifacts = staticSubjects.flatMap((subject) => subject.artifacts).filter(
      (artifact) =>
        artifact.kind === 'skill' &&
        artifact.key === expectedTarget.name &&
        artifact.path === expectedArtifactPath,
    );
    if (
      matchingArtifacts.length === 0 ||
      matchingArtifacts.some((artifact) =>
        artifact.exists !== true ||
        artifact.digest_matches !== true ||
        artifact.package_path !== `.agents/skills/${expectedTarget.name}` ||
        typeof artifact.package_content_digest !== 'string' ||
        artifact.package_digest_matches !== true)
    ) {
      issues.push(issue(
        'error',
        'evaluation.static-package-evidence',
        'Static Skill evaluation is missing verified Skill artifact and package digest evidence.',
        evaluationPath,
      ));
    }
    if (suites.length === 0) {
      issues.push(issue(
        'error',
        'evaluation.suites-missing',
        'Static Skill evaluation must contain at least one suite result.',
        evaluationPath,
      ));
    }
    const validOutcomes = new Set(['passed', 'failed', 'needs_review', 'incomplete']);
    const validQualitative = new Set(['not_required', 'required', 'passed', 'failed']);
    const invalidSuites = suites.filter((suite) => {
      if (
        typeof suite.id !== 'string' || suite.id.trim() === '' ||
        !['trigger', 'conversation'].includes(suite.kind) ||
        suite.profile !== 'project-default' ||
        !(suite.split === null || ['train', 'validation', 'sanity', 'all'].includes(suite.split)) ||
        !validOutcomes.has(suite.outcome) ||
        typeof suite.complete !== 'boolean' ||
        typeof suite.mechanical_passed !== 'boolean' ||
        !validQualitative.has(suite.qualitative_review) ||
        !isRecord(suite.summary) ||
        !Array.isArray(suite.diagnostics) ||
        suite.diagnostics.some((entry) => typeof entry !== 'string')
      ) {
        return true;
      }
      if (suite.outcome === 'passed') {
        return suite.complete !== true || suite.mechanical_passed !== true ||
          !['not_required', 'passed'].includes(suite.qualitative_review);
      }
      if (suite.outcome === 'needs_review') {
        return suite.complete !== true || suite.mechanical_passed !== true ||
          suite.qualitative_review !== 'required';
      }
      if (suite.outcome === 'failed') {
        return suite.complete !== true || suite.mechanical_passed !== false ||
          suite.qualitative_review === 'passed';
      }
      return suite.complete !== false || suite.mechanical_passed !== false ||
        ['passed', 'failed'].includes(suite.qualitative_review);
    });
    if (rawSuites.length !== suites.length || invalidSuites.length > 0) {
      issues.push(issue(
        'error',
        'evaluation.suite-contract',
        'Static Skill evaluation contains an invalid suite report.',
        evaluationPath,
      ));
    }
    const suiteOutcomes = suites.map((suite) => suite.outcome);
    const combinedOutcome = suiteOutcomes.includes('incomplete')
      ? 'incomplete'
      : suiteOutcomes.includes('failed')
        ? 'failed'
        : suiteOutcomes.includes('needs_review')
          ? 'needs_review'
          : 'passed';
    if (
      suites.length > 0 &&
      (
        !validOutcomes.has(value.outcome) ||
        typeof value.complete !== 'boolean' ||
        typeof value.mechanicalPassed !== 'boolean' ||
        (value.outcome !== combinedOutcome && value.outcome !== 'incomplete') ||
        (value.complete === true && suites.some((suite) => suite.complete !== true)) ||
        (value.mechanicalPassed === true && suites.some(
          (suite) => suite.mechanical_passed !== true,
        ))
      )
    ) {
      issues.push(issue(
        'error',
        'evaluation.suite-summary',
        'EvaluationBundle top-level result is inconsistent with its suite reports.',
        evaluationPath,
      ));
    }
    const suiteContracts = expectedTarget.suiteContracts ?? [];
    const contractById = new Map(suiteContracts.map((suite) => [suite.id, suite]));
    if (suites.some((suite) => {
      const contract = contractById.get(suite.id);
      return !contract || contract.kind !== suite.kind;
    })) {
      issues.push(issue(
        'error',
        'evaluation.suite-manifest',
        'EvaluationBundle suite id/kind does not match the static eval manifest.',
        evaluationPath,
      ));
    }
    const suiteIds = new Set(suites.map((suite) => suite.id));
    const missingRequiredSuites = suiteContracts.filter(
      (suite) => suite.requiredForRelease && !suiteIds.has(suite.id),
    );
    if (missingRequiredSuites.length > 0) {
      issues.push(issue(
        'warning',
        'evaluation.required-suites',
        `EvaluationBundle is missing required suites: ${missingRequiredSuites.map((suite) => suite.id).join(', ')}.`,
        evaluationPath,
      ));
    }
  }
  if (suites.some((suite) => suite.qualitative_review === 'required')) {
    issues.push(issue('warning', 'evaluation.qualitative-review', 'One or more suites require qualitative trace review.', evaluationPath));
  }
  return {
    evaluation: {
      path: evaluationPath,
      target: evaluationTarget,
      plugin: value.plugin ?? null,
      skill: value.skill ?? null,
      version: value.pluginVersion,
      outcome: value.outcome,
      complete: value.complete,
      mechanical_passed: value.mechanicalPassed,
      codex_version: value.codexVersion ?? null,
      model: value.model ?? null,
      model_provider: value.modelProvider ?? null,
      credential_source: value.credentialSource ?? null,
      codex_config_digest: value.codexConfigDigest ?? null,
      profiles: subjects,
      suites,
    },
    issues,
    finalSkillTargets,
    rolePaths,
  };
}

function pluginSourceSkillPaths(files, manifest) {
  let staticRoot = null;
  if (typeof manifest.skills === 'string') {
    staticRoot = normalizeRelative(path.normalize(
      manifest.skills.replace(/^\.\//u, ''),
    )).replace(/\/$/u, '');
  }
  const dynamicRoots = new Set(
    (Array.isArray(manifest.artifacts?.targets) ? manifest.artifacts.targets : [])
      .filter((target) => isRecord(target) && target.target === 'codex.skill')
      .flatMap((target) => Array.isArray(target.sourceDirs) ? target.sourceDirs : [])
      .filter((sourceDir) => typeof sourceDir === 'string' && sourceDir.trim() !== '')
      .map((sourceDir) => normalizeRelative(path.normalize(
        sourceDir.replace(/^\.\//u, ''),
      )).replace(/\/$/u, '')),
  );
  return files.filter((relative) => {
    if (path.basename(relative) !== 'SKILL.md') return false;
    if (dynamicRoots.has(path.posix.dirname(relative))) return true;
    if (!staticRoot || !relative.startsWith(`${staticRoot}/`)) return false;
    return relative.slice(staticRoot.length + 1).split('/').length === 2;
  });
}

function prefixNestedIssues(entries, prefix, location) {
  return entries.map((entry) => ({
    ...entry,
    code: `${prefix}.${entry.code}`,
    path: entry.path ? `${location}:${entry.path}` : location,
  }));
}

async function inspectPlugin(root, options) {
  const manifestPath = path.join(root, '.agents-plugin', 'plugin.json');
  const manifest = await readJson(manifestPath, 'plugin manifest');
  if (!isRecord(manifest)) throw new Error('plugin manifest must contain an object.');
  const files = await walkFiles(root);
  const sourceSkills = [];
  const issues = [];
  for (const relative of pluginSourceSkillPaths(files, manifest)) {
    try {
      const report = await inspectStaticSkill(path.dirname(path.join(root, relative)));
      sourceSkills.push({ path: relative, report });
      issues.push(...prefixNestedIssues(report.issues, 'source', relative));
    } catch (error) {
      issues.push(issue('error', 'source.skill-invalid', error instanceof Error ? error.message : String(error), relative));
    }
  }
  if (sourceSkills.length === 0) {
    issues.push(issue('error', 'source.skill-missing', 'No plugin source Skill was found.', manifestPath));
  }

  const inspectedEvaluation = await inspectEvaluation(options.evaluation, {
    kind: 'aw-plugin',
    name: manifest.name,
  });
  issues.push(...inspectedEvaluation.issues);
  const evalManifests = [];
  for (const sourceSkill of sourceSkills) {
    const skillRoot = path.dirname(path.join(root, sourceSkill.path));
    const evalManifestPath = path.join(skillRoot, 'evals', 'manifest.json');
    if (!(await pathExists(evalManifestPath))) continue;
    evalManifests.push({
      skill: sourceSkill.report.skill.frontmatter.name,
      path: normalizeRelative(path.relative(root, evalManifestPath)),
      manifest: await readJson(evalManifestPath, 'eval manifest'),
    });
  }
  if (evalManifests.length === 0) {
    issues.push(issue(
      'warning',
      'eval.manifest-missing',
      'Plugin source Skills have no evaluation manifest.',
      root,
    ));
  }
  const selectedEvalManifest = evalManifests.find(
    (entry) => entry.skill === inspectedEvaluation.evaluation?.skill,
  ) ?? evalManifests[0] ?? null;
  const finalSkills = [];
  for (const target of inspectedEvaluation.finalSkillTargets) {
    try {
      const report = await inspectStaticSkill(path.dirname(target.artifact.absolute_path));
      finalSkills.push({ profile: target.profile, scope: target.scope, path: target.artifact.path, report });
      issues.push(...prefixNestedIssues(report.issues, 'final', `${target.profile}:${target.artifact.path}`));
    } catch (error) {
      issues.push(issue('error', 'final.skill-invalid', error instanceof Error ? error.message : String(error), `${target.profile}:${target.artifact.path}`));
    }
  }
  const explicitRelated = await expandRelated(options.related, root);
  const relatedToml = await inspectRoles([...explicitRelated, ...inspectedEvaluation.rolePaths]);
  for (const roleIssue of relatedToml.parse_errors) {
    issues.push(issue('error', 'role.parse', roleIssue.error, roleIssue.file));
  }
  return {
    schema_version: 1,
    target: {
      kind: 'aw-plugin',
      root: path.resolve(root),
      name: manifest.name ?? null,
      version: manifest.version ?? null,
    },
    plugin: {
      manifest: manifestPath,
      products: manifest.marketplace?.policy?.products ?? ['CODEX', 'CLAUDE'],
      static_skills_root: manifest.skills ?? null,
      dynamic_targets: manifest.artifacts?.targets ?? [],
    },
    package: {
      total_files: files.length,
      files,
    },
    source_skills: sourceSkills,
    eval_manifest: selectedEvalManifest?.manifest ?? null,
    eval_manifests: evalManifests,
    evaluation: inspectedEvaluation.evaluation,
    final_skills: finalSkills,
    related_toml: relatedToml,
    issues,
    note: 'AW plugin review keeps source diagnostics separate from materialized final artifacts and model evidence.',
  };
}

async function buildReport(options) {
  const resolved = await resolveReviewTarget(options.target);
  if (resolved.kind === 'aw-plugin') return inspectPlugin(resolved.root, options);
  const report = await inspectStaticSkill(resolved.root, options);
  const targetName = report.skill.frontmatter.name ?? path.basename(resolved.root);
  const evalManifestPath = path.join(resolved.root, 'evals', 'manifest.json');
  let suiteContracts = [];
  if (await pathExists(evalManifestPath)) {
    const evalManifest = await readJson(evalManifestPath, 'static eval manifest');
    if (isRecord(evalManifest) && Array.isArray(evalManifest.suites)) {
      suiteContracts = evalManifest.suites.filter(
        (suite) =>
          isRecord(suite) &&
          typeof suite.id === 'string' &&
          ['trigger', 'conversation'].includes(suite.kind) &&
          typeof suite.requiredForRelease === 'boolean',
      ).map((suite) => ({
        id: suite.id,
        kind: suite.kind,
        requiredForRelease: suite.requiredForRelease,
      }));
    }
  }
  const inspectedEvaluation = await inspectEvaluation(options.evaluation, {
    kind: 'static-skill',
    name: targetName,
    sourceDigest: report.package.content_digest,
    suiteContracts,
  });
  return {
    schema_version: 1,
    target: {
      kind: 'static-skill',
      root: path.resolve(resolved.root),
      name: targetName,
      version: null,
    },
    ...report,
    evaluation: inspectedEvaluation.evaluation,
    issues: [...report.issues, ...inspectedEvaluation.issues],
  };
}

function renderText(report) {
  if (report.target.kind === 'aw-plugin') {
    return [
      `Target: AW plugin ${report.target.name}`,
      `Source Skills: ${report.source_skills.length}`,
      `Dynamic targets: ${report.plugin.dynamic_targets.length}`,
      `Evaluation: ${report.evaluation?.outcome ?? 'not supplied'}`,
      `Materialized final Skills: ${report.final_skills.length}`,
      `Issues: ${report.issues.length}`,
      ...report.issues.map((entry) => `  [${entry.level}] ${entry.code}${entry.path ? ` (${entry.path})` : ''}: ${entry.message}`),
    ].join('\n');
  }
  const metrics = report.skill.body_metrics;
  const lines = [
    `Skill: ${report.skill.file}`,
    `Name: ${report.skill.frontmatter.name}`,
    `Package: ${report.package.total_files} files, ${report.package.total_bytes} bytes`,
    `Body: ${metrics.lines} lines, ${metrics.characters} chars, ~${metrics.estimated_tokens} tokens`,
    `Control/lifecycle/protocol markers: ${metrics.control_markers}/${metrics.lifecycle_markers}/${metrics.protocol_markers}`,
    `Natural-language state-machine risk: ${metrics.state_machine_risk}`,
    `References: ${report.references.reachable.length - 1} reachable, ${report.references.missing.length} missing, ${report.references.unreachable_runtime_resources.length} unreachable`,
    `Pointer hints: ${report.pointers.total} entries, ${report.pointers.weak_signal_lines.length} without an obvious condition marker`,
    `Scripts: ${report.scripts.count} (not executed)`,
    `Trigger eval cases: ${report.evals.trigger.total} (${report.evals.trigger.positive} positive / ${report.evals.trigger.negative} negative)`,
    `Behavior conversation cases: ${report.evals.conversation_cases}`,
    `Portable behavior specs: ${report.evals.portable_behavior_specs} (not release evidence)`,
    `Evaluation: ${report.evaluation?.outcome ?? 'not supplied'}`,
  ];
  if (report.previous_comparison) {
    const delta = report.previous_comparison.delta;
    lines.push(`Delta: lines ${delta.lines >= 0 ? '+' : ''}${delta.lines}, chars ${delta.characters >= 0 ? '+' : ''}${delta.characters}, tokens ${delta.estimated_tokens >= 0 ? '+' : ''}${delta.estimated_tokens}, control ${delta.control_markers >= 0 ? '+' : ''}${delta.control_markers}, lifecycle ${delta.lifecycle_markers >= 0 ? '+' : ''}${delta.lifecycle_markers}`);
  }
  if (report.related_toml.identical_instruction_groups.length > 0) {
    lines.push('Identical role instruction groups:');
    for (const group of report.related_toml.identical_instruction_groups) lines.push(`  - ${group.join(', ')}`);
  }
  lines.push('Issues:');
  if (report.issues.length === 0) lines.push('  none');
  else for (const entry of report.issues) lines.push(`  [${entry.level}] ${entry.code}${entry.path ? ` (${entry.path})` : ''}: ${entry.message}`);
  lines.push('Note: scripts were not executed; pointer and architecture hints are not automatic defects.');
  return lines.join('\n');
}

async function main() {
  try {
    if (process.argv.slice(2).includes('--help')) {
      process.stdout.write(
        'Usage: inspect_skill_target.mjs <plugin-or-skill-name-or-dir> ' +
        '[--evaluation evaluation.json] [--previous SKILL.md] ' +
        '[--related path-or-glob] [--format text|json]\n',
      );
      return;
    }
    const options = parseArgs(process.argv.slice(2));
    const report = await buildReport(options);
    process.stdout.write(options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
    if (report.issues.some((entry) => entry.level === 'error')) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

export { buildReport, textMetrics };
