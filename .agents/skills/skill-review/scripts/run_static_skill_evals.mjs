#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import YAML from 'yaml';

const execFileAsync = promisify(execFile);
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_SKILL_ROOT = path.dirname(SCRIPT_ROOT);
const REPO_ROOT = path.resolve(REVIEW_SKILL_ROOT, '..', '..', '..');
const STATIC_SKILLS_ROOT = path.join(REPO_ROOT, '.agents', 'skills');
const SCHEMA_VERSION = 1;
const PROFILE = 'project-default';

function fail(message) {
  throw new Error(message);
}

function usage() {
  return `Usage:
  node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs <skill-name-or-dir> --validate-only
  node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs <skill-name-or-dir> [options] --output-dir <new-dir>

Options:
  --suite <id>                    Run one suite; default runs release-required suites
  --split <train|validation|sanity|all>
  --case <id>                     Run one case; requires --suite
  --runs <count>                  Override repetitions per case
  --model <model>                 Override the inherited Codex model
  --model-provider <id>           Override the inherited Codex model provider
  --codex-config <path>           Read model/provider config from this config.toml
  --no-inherit-codex-config       Use a clean official Codex provider config
  --codex-bin <path>              Codex executable; default: codex
  --output-dir <path>             New directory for subject, traces, and evaluation.json
  --validate-only                 Validate target, manifest, corpus, and workspace paths
  -h, --help                      Show this help

Model evals require a built CLI: pnpm build
`;
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} requires a positive integer.`);
  return parsed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    codexBin: 'codex',
    inheritCodexConfig: true,
    validateOnly: false,
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--validate-only') {
      options.validateOnly = true;
      continue;
    }
    if (arg === '--no-inherit-codex-config') {
      options.inheritCodexConfig = false;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const value = optionValue(args, index, arg);
    index += 1;
    if (arg === '--suite') options.suite = value;
    else if (arg === '--split') options.split = value;
    else if (arg === '--case') options.caseId = value;
    else if (arg === '--runs') options.runs = positiveInteger(value, arg);
    else if (arg === '--model') options.model = value;
    else if (arg === '--model-provider') options.modelProvider = value;
    else if (arg === '--codex-config') options.codexConfig = path.resolve(value);
    else if (arg === '--codex-bin') options.codexBin = value;
    else if (arg === '--output-dir') options.outputDir = path.resolve(value);
    else fail(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (positional.length !== 1) fail(usage());
  options.target = positional[0];
  if (options.split && !['train', 'validation', 'sanity', 'all'].includes(options.split)) {
    fail('--split must be train, validation, sanity, or all.');
  }
  if (options.caseId && !options.suite) fail('--case requires --suite.');
  if (!options.inheritCodexConfig && (options.codexConfig || options.modelProvider)) {
    fail('--no-inherit-codex-config cannot be combined with --codex-config or --model-provider.');
  }
  if (options.validateOnly) {
    if (
      options.outputDir || options.model || options.modelProvider || options.codexConfig ||
      !options.inheritCodexConfig || options.runs
    ) {
      fail('--validate-only does not accept output or model-run options.');
    }
  } else if (!options.outputDir) {
    fail('--output-dir is required unless --validate-only is used.');
  }
  return options;
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertRealPathInside(root, candidate, label) {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!isPathInside(realRoot, realCandidate)) fail(`${label} must stay inside ${root}.`);
}

async function resolveSkillRoot(target) {
  let candidate = target;
  if (!(await pathExists(candidate))) candidate = path.join(STATIC_SKILLS_ROOT, target);
  candidate = path.resolve(candidate);
  if ((await lstat(candidate)).isSymbolicLink()) fail('Static eval target cannot be a symlink.');
  if ((await stat(candidate)).isFile()) {
    if (path.basename(candidate) !== 'SKILL.md') fail('Static eval target file must be SKILL.md.');
    candidate = path.dirname(candidate);
  }
  if (!(await stat(candidate)).isDirectory()) fail(`Static eval target is not a directory: ${candidate}`);
  const [skillsRoot, realCandidate] = await Promise.all([
    realpath(STATIC_SKILLS_ROOT),
    realpath(candidate),
  ]);
  if (path.dirname(realCandidate) !== skillsRoot) {
    fail('Static eval target must be a direct .agents/skills/<name> directory.');
  }
  candidate = realCandidate;
  await assertNoSymlinks(candidate, 'Static eval target');
  if (!(await pathExists(path.join(candidate, 'SKILL.md')))) {
    fail(`Static eval target has no SKILL.md: ${candidate}`);
  }
  return candidate;
}

async function assertNoSymlinks(candidate, label) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) fail(`${label} cannot contain symlinks: ${candidate}`);
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(candidate, { withFileTypes: true })) {
    const child = path.join(candidate, entry.name);
    if (entry.isSymbolicLink()) fail(`${label} cannot contain symlinks: ${child}`);
    if (entry.isDirectory()) await assertNoSymlinks(child, label);
  }
}

async function readJson(candidate, label) {
  try {
    return JSON.parse(await readFile(candidate, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string.`);
  return value.trim();
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value;
}

function stringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`);
  }
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function relativeEvalPath(skillRoot, value, label) {
  const relative = nonEmptyString(value, label).replace(/^\.\//u, '');
  if (
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.split(/[\\/]/u).includes('..')
  ) {
    fail(`${label} must stay inside evals/.`);
  }
  const absolute = path.resolve(skillRoot, relative);
  if (!isPathInside(path.join(skillRoot, 'evals'), absolute) || !relative.startsWith('evals/')) {
    fail(`${label} must stay inside evals/.`);
  }
  return `./${relative.split(path.sep).join('/')}`;
}

async function validateEvalFile(skillRoot, value, label) {
  const relative = relativeEvalPath(skillRoot, value, label);
  const absolute = path.resolve(skillRoot, relative.replace(/^\.\//u, ''));
  if (!(await pathExists(absolute)) || !(await stat(absolute)).isFile()) {
    fail(`${label} does not reference a file: ${relative}`);
  }
  await assertRealPathInside(path.join(skillRoot, 'evals'), absolute, label);
  return relative;
}

async function validateSuite(skillRoot, value, index) {
  const row = record(value, `suites[${index}]`);
  const id = nonEmptyString(row.id, `suites[${index}].id`);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) fail(`suites[${index}].id must use kebab-case.`);
  if (row.kind !== 'trigger' && row.kind !== 'conversation') {
    fail(`suites[${index}].kind must be trigger or conversation.`);
  }
  const releaseSplits = row.releaseSplits === undefined
    ? []
    : stringArray(row.releaseSplits, `suites[${index}].releaseSplits`, { allowEmpty: true });
  for (const split of releaseSplits) {
    if (!['train', 'validation', 'sanity', 'all'].includes(split)) {
      fail(`suites[${index}] has unsupported release split ${JSON.stringify(split)}.`);
    }
  }
  const common = {
    id,
    kind: row.kind,
    skill: nonEmptyString(row.skill, `suites[${index}].skill`),
    cases: await validateEvalFile(skillRoot, row.cases, `suites[${index}].cases`),
    profiles: [PROFILE],
    defaultRuns: positiveInteger(row.defaultRuns, `suites[${index}].defaultRuns`),
    releaseSplits,
    requiredForRelease: boolean(row.requiredForRelease, `suites[${index}].requiredForRelease`),
    perRunTimeoutMs: positiveInteger(row.perRunTimeoutMs, `suites[${index}].perRunTimeoutMs`),
  };
  if (row.kind === 'conversation') return common;
  const isolation = row.isolation === undefined ? 'standard' : row.isolation;
  if (isolation !== 'standard' && isolation !== 'strict') {
    fail(`suites[${index}].isolation must be standard or strict.`);
  }
  const strictNegativeSplits = row.strictNegativeSplits === undefined
    ? []
    : stringArray(row.strictNegativeSplits, `suites[${index}].strictNegativeSplits`, { allowEmpty: true });
  if (strictNegativeSplits.some((split) => !['train', 'validation', 'sanity'].includes(split))) {
    fail(`suites[${index}].strictNegativeSplits contains an unsupported split.`);
  }
  const fixtureModule = row.fixtureModule === undefined
    ? undefined
    : await validateEvalFile(skillRoot, row.fixtureModule, `suites[${index}].fixtureModule`);
  if (fixtureModule && !fixtureModule.endsWith('.mjs')) {
    fail(`suites[${index}].fixtureModule must reference an .mjs file.`);
  }
  return {
    ...common,
    observeSpawnAgent: boolean(row.observeSpawnAgent, `suites[${index}].observeSpawnAgent`),
    isolation,
    strictNegativeSplits,
    ...(fixtureModule ? { fixtureModule } : {}),
  };
}

async function validateWorkspace(repoRoot, skillName, workspace) {
  if (workspace === undefined) return [];
  const row = record(workspace, 'workspace');
  if (!Array.isArray(row.copy)) fail('workspace.copy must be an array.');
  const copies = [];
  for (const [index, value] of row.copy.entries()) {
    const entry = record(value, `workspace.copy[${index}]`);
    const from = nonEmptyString(entry.from, `workspace.copy[${index}].from`);
    const to = nonEmptyString(entry.to, `workspace.copy[${index}].to`);
    if (path.isAbsolute(from) || path.win32.isAbsolute(from) || from.split(/[\\/]/u).includes('..')) {
      fail(`workspace.copy[${index}].from must be repo-root relative.`);
    }
    if (path.isAbsolute(to) || path.win32.isAbsolute(to) || to.split(/[\\/]/u).includes('..')) {
      fail(`workspace.copy[${index}].to must stay inside the subject.`);
    }
    const source = path.resolve(repoRoot, from);
    if (!(await pathExists(source))) fail(`workspace.copy[${index}].from does not exist: ${from}`);
    await assertRealPathInside(repoRoot, source, `workspace.copy[${index}].from`);
    await assertNoSymlinks(source, `workspace.copy[${index}].from`);
    const normalizedTarget = path.posix.normalize(to.replaceAll('\\', '/'))
      .replace(/^\.\//u, '');
    const protectedTargets = ['.codex', `.agents/skills/${skillName}`];
    const overlapsProtectedTarget = protectedTargets.some((protectedTarget) =>
      normalizedTarget === '.' ||
      normalizedTarget === protectedTarget ||
      normalizedTarget.startsWith(`${protectedTarget}/`) ||
      protectedTarget.startsWith(`${normalizedTarget}/`));
    if (overlapsProtectedTarget) {
      fail(`workspace.copy[${index}].to cannot replace Codex config or the target Skill.`);
    }
    copies.push({ from, to: normalizedTarget });
  }
  return copies;
}

function validateConversationReply(value, label) {
  if (typeof value === 'string') return;
  const reply = record(value, label);
  if (!Array.isArray(reply.answers_by_index) || reply.answers_by_index.some(
    (entry) => typeof entry !== 'string',
  )) {
    fail(`${label}.answers_by_index must be an array of strings.`);
  }
  if (
    reply.expected_question_count !== undefined &&
    (!Number.isInteger(reply.expected_question_count) || reply.expected_question_count < 0)
  ) {
    fail(`${label}.expected_question_count must be a non-negative integer.`);
  }
  nonEmptyString(reply.unexpected_question_answer, `${label}.unexpected_question_answer`);
}

async function validateLocalCases(skillRoot, suite) {
  const casesPath = path.resolve(skillRoot, suite.cases.replace(/^\.\//u, ''));
  const document = record(await readJson(casesPath, `${suite.id} cases`), `${suite.id} cases`);
  if (suite.kind === 'trigger') {
    if (document.schemaVersion !== SCHEMA_VERSION) fail(`${suite.id} cases must use schemaVersion 1.`);
    if (document.skill !== suite.skill) fail(`${suite.id} cases skill must match ${JSON.stringify(suite.skill)}.`);
    if (!Array.isArray(document.cases) || document.cases.length === 0) {
      fail(`${suite.id} cases must contain a non-empty cases array.`);
    }
    const ids = new Set();
    const splits = new Set();
    let hasWorkspaceFixture = false;
    for (const [index, value] of document.cases.entries()) {
      const row = record(value, `${suite.id}.cases[${index}]`);
      const id = nonEmptyString(row.id, `${suite.id}.cases[${index}].id`);
      if (!/^[a-z0-9][a-z0-9_]*$/u.test(id)) fail(`${suite.id}.cases[${index}].id must use snake_case.`);
      if (ids.has(id)) fail(`${suite.id} cases has duplicate id ${JSON.stringify(id)}.`);
      ids.add(id);
      const split = nonEmptyString(row.split, `${suite.id}.cases[${index}].split`);
      if (!['train', 'validation', 'sanity'].includes(split)) {
        fail(`${suite.id}.cases[${index}].split is invalid.`);
      }
      splits.add(split);
      nonEmptyString(row.query, `${suite.id}.cases[${index}].query`);
      boolean(row.should_load_skill, `${suite.id}.cases[${index}].should_load_skill`);
      if (suite.observeSpawnAgent && row.should_spawn_agent === undefined) {
        fail(`${suite.id}.cases[${index}].should_spawn_agent is required.`);
      }
      if (!suite.observeSpawnAgent && row.should_spawn_agent !== undefined) {
        fail(`${suite.id}.cases[${index}].should_spawn_agent requires observeSpawnAgent=true.`);
      }
      if (row.should_spawn_agent !== undefined) {
        boolean(row.should_spawn_agent, `${suite.id}.cases[${index}].should_spawn_agent`);
      }
      if (row.workspace_fixture !== undefined) {
        nonEmptyString(row.workspace_fixture, `${suite.id}.cases[${index}].workspace_fixture`);
        hasWorkspaceFixture = true;
      }
      if (row.use_project_rules !== undefined) {
        boolean(row.use_project_rules, `${suite.id}.cases[${index}].use_project_rules`);
      }
      if (row.tags !== undefined) stringArray(row.tags, `${suite.id}.cases[${index}].tags`);
    }
    if (hasWorkspaceFixture && !suite.fixtureModule) {
      fail(`${suite.id} cases require fixtureModule because workspace_fixture is used.`);
    }
    for (const split of suite.releaseSplits) {
      if (split !== 'all' && !splits.has(split)) fail(`${suite.id} has no cases for release split ${split}.`);
    }
    return;
  }

  if (document.skill_name !== suite.skill) {
    fail(`${suite.id} cases skill_name must match ${JSON.stringify(suite.skill)}.`);
  }
  if (!Array.isArray(document.evals) || document.evals.length === 0) {
    fail(`${suite.id} cases must contain a non-empty evals array.`);
  }
  const ids = new Set();
  for (const [index, value] of document.evals.entries()) {
    const row = record(value, `${suite.id}.evals[${index}]`);
    const id = nonEmptyString(row.id, `${suite.id}.evals[${index}].id`);
    if (ids.has(id)) fail(`${suite.id} cases has duplicate id ${JSON.stringify(id)}.`);
    ids.add(id);
    nonEmptyString(row.prompt, `${suite.id}.evals[${index}].prompt`);
    if (!Array.isArray(row.scripted_replies)) {
      fail(`${suite.id}.evals[${index}].scripted_replies must be an array.`);
    }
    row.scripted_replies.forEach((reply, replyIndex) =>
      validateConversationReply(reply, `${suite.id}.evals[${index}].scripted_replies[${replyIndex}]`));
    nonEmptyString(row.expected_output, `${suite.id}.evals[${index}].expected_output`);
    const review = record(row.review, `${suite.id}.evals[${index}].review`);
    stringArray(review.checks, `${suite.id}.evals[${index}].review.checks`);
    if (review.workspace_unchanged !== undefined) {
      boolean(review.workspace_unchanged, `${suite.id}.evals[${index}].review.workspace_unchanged`);
    }
  }
}

async function readManifest(skillRoot, skillName) {
  const manifestPath = path.join(skillRoot, 'evals', 'manifest.json');
  const document = record(await readJson(manifestPath, 'static eval manifest'), 'static eval manifest');
  if (document.schemaVersion !== SCHEMA_VERSION) fail(`manifest.schemaVersion must be ${SCHEMA_VERSION}.`);
  if (document.skill !== skillName) fail(`manifest.skill must match ${JSON.stringify(skillName)}.`);
  if (!Array.isArray(document.suites) || document.suites.length === 0) {
    fail('manifest.suites must be a non-empty array.');
  }
  const suites = await Promise.all(document.suites.map((suite, index) =>
    validateSuite(skillRoot, suite, index)));
  if (new Set(suites.map((suite) => suite.id)).size !== suites.length) fail('manifest has duplicate suite ids.');
  if (suites.some((suite) => suite.skill !== skillName)) fail('Every suite.skill must match manifest.skill.');
  await Promise.all(suites.map((suite) => validateLocalCases(skillRoot, suite)));
  return {
    path: manifestPath,
    skill: skillName,
    workspace: await validateWorkspace(REPO_ROOT, skillName, document.workspace),
    suites,
  };
}

export function parseSkillName(content, skillRoot) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/u);
  if (!match) fail(`SKILL.md has no valid frontmatter: ${skillRoot}`);
  let frontmatter;
  try {
    frontmatter = record(YAML.parse(match[1]), 'SKILL.md frontmatter');
  } catch (error) {
    fail(`SKILL.md has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  const name = nonEmptyString(frontmatter.name, 'SKILL.md frontmatter.name');
  if (name !== path.basename(skillRoot)) fail(`Skill name ${JSON.stringify(name)} must match its directory.`);
  return name;
}

async function listFiles(root) {
  const files = [];
  async function visit(current, prefix = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else if (entry.isSymbolicLink()) fail(`Static eval target cannot contain symlink: ${relative}`);
    }
  }
  await visit(root);
  return files;
}

async function digestTree(root) {
  const hash = createHash('sha256');
  for (const relative of await listFiles(root)) {
    hash.update(relative.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(path.join(root, relative)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function ensureNewDirectory(directory) {
  if (await pathExists(directory)) fail(`Output directory already exists: ${directory}`);
  await mkdir(directory, { recursive: true });
}

function assertOutputOutsideInputs(outputDir, skillRoot, manifest) {
  if (isPathInside(skillRoot, outputDir)) {
    fail('Output directory cannot be inside the evaluated Skill.');
  }
  for (const entry of manifest.workspace) {
    const source = path.resolve(REPO_ROOT, entry.from);
    if (isPathInside(source, outputDir)) {
      fail(`Output directory cannot be inside workspace source ${entry.from}.`);
    }
  }
}

async function prepareSubject(skillRoot, skillName, manifest, outputDir) {
  const subjectRoot = path.join(outputDir, 'subject');
  const target = path.join(subjectRoot, '.agents', 'skills', skillName);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skillRoot, target, { recursive: true, force: false, errorOnExist: true });
  await mkdir(path.join(subjectRoot, '.git'), { recursive: true });
  for (const entry of manifest.workspace) {
    const source = path.join(REPO_ROOT, entry.from);
    const destination = path.join(subjectRoot, entry.to);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  }
  return subjectRoot;
}

async function loadCentralDrivers() {
  const root = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'scripts');
  const files = {
    contract: path.join(root, 'plugin-eval-contract.js'),
    runtime: path.join(root, 'codex-eval-runtime-config.js'),
    trigger: path.join(root, 'codex-trigger-eval.js'),
    conversation: path.join(root, 'codex-eval-app-server.js'),
  };
  for (const file of Object.values(files)) {
    if (!(await pathExists(file))) fail(`Built eval driver not found: ${file}. Run pnpm build first.`);
  }
  const [contract, runtime, trigger, conversation] = await Promise.all(
    Object.values(files).map((file) => import(pathToFileURL(file).href)),
  );
  return { contract, runtime, trigger, conversation };
}

async function validateCentralContracts(drivers, skillRoot, manifest) {
  for (const suite of manifest.suites) {
    if (suite.kind === 'trigger') {
      await drivers.contract.readPluginEvalTriggerCases(skillRoot, suite);
    } else {
      const cases = await readJson(
        path.resolve(skillRoot, suite.cases.replace(/^\.\//u, '')),
        `${suite.id} cases`,
      );
      drivers.contract.validatePluginEvalConversationCaseDocument(cases, manifest.skill);
    }
  }
}

function selectedSuites(manifest, options) {
  const suites = options.suite
    ? manifest.suites.filter((suite) => suite.id === options.suite)
    : manifest.suites.filter((suite) => suite.requiredForRelease);
  if (suites.length === 0) fail(`Unknown or non-release suite: ${options.suite ?? '(none)'}`);
  return suites;
}

function selectedSplits(suite, options) {
  if (suite.kind !== 'trigger') return [null];
  if (options.split) return [options.split];
  if (options.caseId) return ['all'];
  return suite.releaseSplits.length > 0 ? suite.releaseSplits : ['all'];
}

async function codexVersion(codexBin, env) {
  try {
    const result = await execFileAsync(codexBin, ['--version'], {
      env,
      timeout: 10_000,
      encoding: 'utf8',
    });
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

async function run(options, skillRoot, skillName, manifest) {
  const drivers = await loadCentralDrivers();
  await validateCentralContracts(drivers, skillRoot, manifest);
  assertOutputOutsideInputs(options.outputDir, skillRoot, manifest);
  const sourceDigest = await digestTree(skillRoot);
  await ensureNewDirectory(options.outputDir);
  const subjectRoot = await prepareSubject(skillRoot, skillName, manifest, options.outputDir);
  const subjectSkillRoot = path.join(subjectRoot, '.agents', 'skills', skillName);
  const subjectPackageDigest = await digestTree(subjectSkillRoot);
  if (subjectPackageDigest !== sourceDigest) {
    fail('Materialized static Skill digest does not match its source package.');
  }
  const codexRuntime = await drivers.runtime.resolveCodexEvalRuntimeConfig({
    sourceEnv: process.env,
    inheritUserConfig: options.inheritCodexConfig,
    configPath: options.codexConfig,
    modelOverride: options.model,
    modelProviderOverride: options.modelProvider,
  });
  const runtimeCapsule = await drivers.runtime.createCodexEvalRuntimeCapsule(
    codexRuntime,
    process.env,
  );
  const reports = [];
  try {
    await mkdir(path.join(options.outputDir, 'reports'), { recursive: true });
    for (const suite of selectedSuites(manifest, options)) {
      for (const split of selectedSplits(suite, options)) {
        const reportName = [suite.id, split].filter(Boolean).join('-');
        const reportPath = path.join(options.outputDir, 'reports', `${reportName}.json`);
        process.stderr.write(`[skill:eval] ${skillName}/${reportName}\n`);
        let report;
        if (suite.kind === 'trigger') {
          report = await drivers.trigger.runCodexTriggerSuite({
            suite,
            split,
            subjectRoot,
            pluginRoot: skillRoot,
            profile: PROFILE,
            runs: options.runs ?? suite.defaultRuns,
            caseId: options.caseId,
            codexBin: options.codexBin,
            model: options.model,
            codexRuntime,
            sourceEnv: runtimeCapsule.env,
            reportPath,
            stderr: (message) => process.stderr.write(message),
          });
        } else {
          if (options.split) fail('--split only applies to trigger suites.');
          report = await drivers.conversation.runCodexConversationSuite({
            suiteId: suite.id,
            skillName,
            casesPath: path.resolve(skillRoot, suite.cases.replace(/^\.\//u, '')),
            subjectRoot,
            profile: PROFILE,
            runs: options.runs ?? suite.defaultRuns,
            caseId: options.caseId,
            codexBin: options.codexBin,
            model: options.model,
            codexRuntime,
            timeoutMs: suite.perRunTimeoutMs,
            sourceEnv: runtimeCapsule.env,
            reportPath,
          });
        }
        report.reportPath = path.relative(options.outputDir, reportPath).split(path.sep).join('/');
        reports.push(report);
      }
    }
    const sourceUnchanged = await digestTree(skillRoot) === sourceDigest;
    const subjectSkill = path.join(subjectRoot, '.agents', 'skills', skillName, 'SKILL.md');
    const subjectSkillDigest = `sha256:${createHash('sha256').update(await readFile(subjectSkill)).digest('hex')}`;
    const outcome = sourceUnchanged
      ? drivers.contract.combinePluginEvalOutcome(reports)
      : 'incomplete';
    const diagnostics = [
      ...reports.flatMap((report) => report.diagnostics),
      ...(sourceUnchanged ? [] : ['Static Skill source changed during evaluation.']),
    ];
    const unredactedEvaluation = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      target: { kind: 'static-skill', name: skillName, sourceDigest },
      platform: 'codex',
      codexVersion: await codexVersion(options.codexBin, runtimeCapsule.env),
      model: options.model ?? codexRuntime.model ?? null,
      modelProvider: codexRuntime.modelProvider,
      credentialSource: codexRuntime.credentialSource,
      codexConfigDigest: codexRuntime.evidenceDigest,
      outcome,
      complete: sourceUnchanged && reports.every((report) => report.complete),
      mechanicalPassed: sourceUnchanged && reports.every((report) => report.mechanicalPassed),
      subjects: [{
        profile: PROFILE,
        scope: 'project',
        modelExecution: true,
        evidenceLevel: 'runtime-project',
        root: 'subject',
        contentDigest: subjectPackageDigest,
        artifacts: [{
          kind: 'skill',
          key: skillName,
          path: `.agents/skills/${skillName}/SKILL.md`,
          contentDigest: subjectSkillDigest,
          packagePath: `.agents/skills/${skillName}`,
          packageContentDigest: subjectPackageDigest,
        }],
      }],
      suites: reports,
      diagnostics,
    };
    const evaluation = drivers.runtime.redactCodexEvalValue(
      unredactedEvaluation,
      codexRuntime,
    );
    const evaluationPath = path.join(options.outputDir, 'evaluation.json');
    await writeFile(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      ok: evaluation.complete && outcome !== 'failed' && outcome !== 'incomplete',
      outcome,
      evaluation: evaluationPath,
    }, null, 2)}\n`);
    if (outcome === 'failed' || outcome === 'incomplete') process.exitCode = 1;
  } finally {
    await runtimeCapsule.cleanup();
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const skillRoot = await resolveSkillRoot(options.target);
  const skillName = parseSkillName(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'), skillRoot);
  const manifest = await readManifest(skillRoot, skillName);
  let centralContract = false;
  try {
    const drivers = await loadCentralDrivers();
    await validateCentralContracts(drivers, skillRoot, manifest);
    centralContract = true;
  } catch (error) {
    if (!String(error?.message).includes('Built eval driver not found')) throw error;
  }
  if (options.validateOnly) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      skill: skillName,
      suites: manifest.suites.map((suite) => suite.id),
      centralContract,
    }, null, 2)}\n`);
    return;
  }
  await run(options, skillRoot, skillName, manifest);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, readManifest, resolveSkillRoot };
