#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { reviewSkillLeafPlan, supportedProfiles } from './review-skill-leaf-plan.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = new Set(['codex-user', 'codex-project', 'claude-user', 'claude-project']);
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);
const EXECUTABLE_OVERRIDE_ENV = [
  'AW_PLUGIN_VALIDATOR_BIN',
  'AW_SKILL_VALIDATOR_BIN',
  'AW_SKILL_CHECK_BIN',
  'AW_REVIEW_LITE_VALIDATOR',
];

function usage() {
  return [
    'Usage: check-aw-plugin-release.mjs <plugin-root> --workspace-root <dir> [--review <review.json>]... --final <profile=path>... [--eval-spec path]... [--eval-audit path]... [--eval-result path]... [--profile name] [--output file] [--format json|text]',
    'Dynamic codex.skill and claude.skill targets require matching materialized final leaves for their declared profiles and scopes.',
  ].join('\n');
}

function parseNamedPath(value, flag) {
  const index = value.indexOf('=');
  if (index < 1 || index === value.length - 1) throw new Error(`${flag} requires profile=path.`);
  const profile = value.slice(0, index);
  if (!PROFILES.has(profile)) throw new Error('Unknown profile: ' + profile);
  return { profile, root: path.resolve(value.slice(index + 1)) };
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  const reviews = [];
  const finals = [];
  const profiles = [];
  const evalSpecs = [];
  const evalAudits = [];
  const evalResults = [];
  let output = null;
  let workspaceRoot = null;
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--workspace-root') {
      workspaceRoot = path.resolve(valueAfter(argv, index, value));
      index += 1;
    } else if (value === '--review') {
      reviews.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--final') {
      finals.push(parseNamedPath(valueAfter(argv, index, value), value));
      index += 1;
    } else if (value === '--eval-spec') {
      evalSpecs.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--eval-audit') {
      evalAudits.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--eval-result') {
      evalResults.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--profile') {
      const profile = valueAfter(argv, index, value);
      index += 1;
      if (!PROFILES.has(profile)) throw new Error('Unknown profile: ' + profile);
      profiles.push(profile);
    } else if (value === '--output') {
      output = path.resolve(valueAfter(argv, index, value));
      index += 1;
    } else if (value === '--format') {
      format = valueAfter(argv, index, value);
      index += 1;
    } else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1 || workspaceRoot === null) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  return {
    pluginRoot: positional[0],
    workspaceRoot,
    reviews,
    finals,
    profiles: [...new Set(profiles)],
    evalSpecs,
    evalAudits,
    evalResults,
    output,
    format,
  };
}

async function skillRoots(root) {
  const rootStats = await lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Skill collection root must be a regular directory: ' + root);
  }
  const roots = [];
  async function visit(directory) {
    const skillFile = path.join(directory, 'SKILL.md');
    const skillStats = await lstat(skillFile).catch(() => null);
    if (skillStats && (!skillStats.isFile() || skillStats.isSymbolicLink())) {
      throw new Error('SKILL.md must be a non-symlink regular file: ' + skillFile);
    }
    if (skillStats) {
      roots.push(directory);
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) throw new Error('Skill discovery cannot follow symlink: ' + entryPath);
      if (stats.isDirectory()) await visit(entryPath);
      else if (!stats.isFile()) throw new Error('Skill collection contains a non-regular node: ' + entryPath);
    }
  }
  await visit(root);
  return roots;
}

async function assertEvidenceFiles(options) {
  for (const [label, paths] of [
    ['Review', options.reviews],
    ['EvalSpec', options.evalSpecs],
    ['EvalAudit', options.evalAudits],
    ['EvalResult', options.evalResults],
  ]) {
    for (const filePath of paths) {
      const stats = await lstat(filePath).catch(() => null);
      if (!stats?.isFile() || stats.isSymbolicLink()) {
        throw new Error(`${label} evidence must be a non-symlink regular file: ${filePath}`);
      }
    }
  }
}

function pluginCollectionRoot(pluginRoot, relativePath) {
  const root = path.resolve(pluginRoot, relativePath);
  const relative = path.relative(pluginRoot, root);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Skill collection root must stay inside the plugin root: ' + root);
  }
  return root;
}

async function runJson(file, args, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [file, ...args], {
      encoding: 'utf8',
      env: executionEnv(),
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!allowFailure || typeof error?.stdout !== 'string' || !error.stdout.trim()) throw error;
    return JSON.parse(error.stdout);
  }
}

function executionEnv() {
  const env = { ...process.env };
  for (const name of EXECUTABLE_OVERRIDE_ENV) delete env[name];
  return env;
}

async function validatePluginSource(pluginRoot, workspaceRoot) {
  const args = [
    'plugin',
    'validate',
    pluginRoot,
    '--workspace-root',
    workspaceRoot,
    '--json',
  ];
  try {
    const { stdout } = await execFileAsync('aw', args, { encoding: 'utf8', env: executionEnv() });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      return JSON.parse(error.stdout);
    }
    return {
      ok: false,
      warnings: [],
      errors: [`Cannot run aw plugin validate: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function bundledScript(name) {
  const candidate = path.join(scriptRoot, name);
  if (path.dirname(candidate) !== scriptRoot) throw new Error('Bundled script path escaped the plugin bundle.');
  const stats = await lstat(candidate).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Bundled ${name} must be a regular file.`);
  }
  return candidate;
}

async function digestFile(filePath) {
  return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function selectionKey(targetDigest, profile, suite) {
  return `${targetDigest ?? ''}\u0000${profile ?? ''}\u0000${suite ?? ''}`;
}

function caseEntries(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.cases)) return document.cases;
  if (Array.isArray(document?.evals)) return document.evals;
  return [];
}

async function runEvalJson(args) {
  try {
    const { stdout } = await execFileAsync('aw-skill-eval', args, {
      encoding: 'utf8',
      env: executionEnv(),
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    return {
      valid: false,
      errors: [`Cannot validate Eval evidence: ${error instanceof Error ? error.message : String(error)}`],
      calculated: null,
    };
  }
}

async function loadEvalSpecs(paths) {
  const entries = [];
  const duplicates = [];
  const bySelection = new Map();
  const byDigest = new Map();
  for (const specPath of paths) {
    const validation = await runEvalJson(['spec', 'validate', specPath]);
    const value = JSON.parse(await readFile(specPath, 'utf8'));
    const digest = await digestFile(specPath);
    const targetDigest = value?.target?.digest;
    const selectedCases = validation.valid && validation.calculated?.paths?.cases
      ? JSON.parse(await readFile(validation.calculated.paths.cases, 'utf8'))
      : null;
    const entry = {
      path: specPath,
      value,
      targetDigest,
      digest,
      validation,
      selectedCases,
    };
    entries.push(entry);
    const key = selectionKey(targetDigest, value?.source?.profile, value?.source?.suite);
    entry.selectionKey = key;
    if (bySelection.has(key)) duplicates.push(key);
    else bySelection.set(key, entry);
    if (!byDigest.has(digest)) byDigest.set(digest, entry);
  }
  return { entries, bySelection, byDigest, duplicates };
}

async function loadDigestEvidence(paths, keyOf) {
  const entries = [];
  const duplicates = [];
  const byKey = new Map();
  for (const evidencePath of paths) {
    const value = JSON.parse(await readFile(evidencePath, 'utf8'));
    const digest = await digestFile(evidencePath);
    const entry = {
      path: evidencePath,
      value,
      digest,
    };
    entries.push(entry);
    const key = keyOf(entry);
    if (byKey.has(key)) duplicates.push(key);
    else byKey.set(key, entry);
  }
  return { entries, byKey, duplicates };
}

async function evalRequirement(
  skillRoot,
  pluginName,
  skillName,
  requiresEval = false,
  releaseProfile = null,
) {
  const manifestPath = path.join(skillRoot, 'evals', 'manifest.json');
  const content = await readFile(manifestPath, 'utf8').catch(() => null);
  if (content === null) {
    return {
      required: requiresEval,
      missingManifest: requiresEval,
      chains: [],
      releaseSuiteCount: 0,
      unsupportedSuites: [],
    };
  }
  const manifest = JSON.parse(content);
  const requiredSuites = Array.isArray(manifest.suites)
    ? manifest.suites.filter((suite) => suite?.requiredForRelease === true)
    : [];
  const releaseScope = releaseProfile === null
    ? null
    : releaseProfile.endsWith('-project') ? 'project' : 'user';
  const profiles = manifest.profiles && typeof manifest.profiles === 'object' && !Array.isArray(manifest.profiles)
    ? Object.entries(manifest.profiles).map(([id, profile]) => ({ id, ...profile }))
    : [];
  const chains = [];
  const unsupportedSuites = [];
  for (const suite of requiredSuites) {
    const supportedProfileIds = Array.isArray(suite.profiles)
      ? new Set(suite.profiles)
      : new Set(profiles.map((profile) => profile.id));
    const suiteProfiles = profiles.filter((profile) =>
      supportedProfileIds.has(profile.id)
      && (releaseScope === null || profile.scope === releaseScope));
    if (suiteProfiles.length === 0) continue;
    if (typeof suite.cases !== 'string') {
      unsupportedSuites.push(...suiteProfiles.map((profile) => `${profile.id}/${suite.id ?? '<unknown>'}`));
      continue;
    }
    const casePath = path.resolve(path.dirname(manifestPath), suite.cases);
    const document = JSON.parse(await readFile(casePath, 'utf8'));
    const suiteCases = caseEntries(document);
    const releaseSplits = Array.isArray(suite.releaseSplits) ? new Set(suite.releaseSplits) : new Set();
    const releaseCases = suiteCases.filter((entry) =>
      typeof entry?.id === 'string'
      && (releaseSplits.size === 0 || releaseSplits.has('all') || releaseSplits.has(entry.split)));
    const minimumRuns = Number.isInteger(suite.runs) && suite.runs > 0
      ? suite.runs
      : Number.isInteger(manifest.defaults?.runs) && manifest.defaults.runs > 0
        ? manifest.defaults.runs
      : 1;
    const minimumPassRate = typeof document?.suite?.runtime?.minimumPassRate === 'number'
      ? document.suite.runtime.minimumPassRate
      : 1;
    for (const profile of suiteProfiles) {
      chains.push({
        plugin: pluginName,
        skill: skillName,
        profile: profile.id,
        suite: suite.id,
        selectedCorpus: document,
        suiteCases,
        releaseCases: releaseCases
          .map((entry) => ({ caseId: entry.id, minimumRuns }))
          .sort((left, right) => left.caseId.localeCompare(right.caseId)),
        minimumPassRate,
        releaseProcessManagement: suite.releaseProcessManagement === 'allow-unmanaged-confirmed'
          ? 'allow-unmanaged-confirmed'
          : 'managed-only',
      });
    }
  }
  return {
    required: requiresEval || chains.length > 0,
    missingManifest: false,
    chains,
    releaseSuiteCount: chains.length,
    unsupportedSuites,
  };
}

function caseCorpusErrors(requirement, selectedDocument) {
  if (!selectedDocument || stableJson(selectedDocument.suite) !== stableJson(requirement.selectedCorpus.suite)) {
    return ['EvalSpec cases suite does not match the current manifest suite corpus'];
  }
  const currentCaseById = new Map(requirement.suiteCases.map((entry) => [entry.id, stableJson(entry)]));
  const actualCases = caseEntries(selectedDocument);
  const actualCaseById = new Map(actualCases.map((entry) => [entry?.id, stableJson(entry)]));
  const errors = [];
  if (
    actualCaseById.size !== actualCases.length
    || [...actualCaseById].some(([caseId, value]) => currentCaseById.get(caseId) !== value)
    || requirement.releaseCases.some((entry) => !actualCaseById.has(entry.caseId))
  ) {
    errors.push('EvalSpec cases content and case IDs do not match the current required suite corpus');
  }
  return errors;
}

function runFactErrors(requirement, spec, result) {
  const errors = [];
  const processMode = result.processManagement?.mode;
  if (
    requirement.releaseProcessManagement === 'managed-only'
    && processMode !== 'managed'
  ) {
    errors.push(
      `EvalResult process management mode ${String(processMode)} is not allowed by managed-only release policy`,
    );
  } else if (
    requirement.releaseProcessManagement === 'allow-unmanaged-confirmed'
    && processMode !== 'managed'
    && processMode !== 'unmanaged-confirmed'
  ) {
    errors.push(`EvalResult process management mode ${String(processMode)} is invalid`);
  }
  const requiredIds = new Set(requirement.releaseCases.map((entry) => entry.caseId));
  const currentRuns = result.runs.filter((run) => run.variant === 'current' && requiredIds.has(run.caseId));
  const currentAttempts = new Map();
  for (const run of currentRuns) {
    const key = `${run.caseId}\u0000${run.attempt}`;
    if (currentAttempts.has(key)) errors.push(`EvalResult repeats current attempt ${run.caseId}/${run.attempt}`);
    else currentAttempts.set(key, run);
  }
  const incompleteCurrent = currentRuns.filter((run) => run.status !== 'completed' || run.grade === null);
  if (incompleteCurrent.length > 0) errors.push('EvalResult has incomplete current runs for required cases');
  const insufficientCases = requirement.releaseCases
    .filter((entry) => [...currentAttempts.values()].filter((run) => run.caseId === entry.caseId).length < entry.minimumRuns)
    .map((entry) => {
      const actual = [...currentAttempts.values()].filter((run) => run.caseId === entry.caseId).length;
      return `${entry.caseId} (${actual}/${entry.minimumRuns})`;
    });
  if (insufficientCases.length > 0) {
    errors.push(`EvalResult lacks current runs for required cases: ${insufficientCases.join(', ')}`);
  }
  const completedCurrent = currentRuns.filter((run) => run.status === 'completed' && run.grade !== null);
  const currentPassed = completedCurrent.filter((run) => run.grade.passed).length;
  const currentPassRate = completedCurrent.length === 0 ? 0 : currentPassed / completedCurrent.length;
  if (currentPassRate < requirement.minimumPassRate) {
    errors.push(`current pass rate ${currentPassRate} is below minimumPassRate ${requirement.minimumPassRate}`);
  }

  let baseline = null;
  if (spec.baseline?.type !== 'none') {
    const variant = spec.baseline.type === 'previous-version' ? 'previous-version' : 'without-skill';
    const baselineRuns = result.runs.filter((run) => run.variant === variant && requiredIds.has(run.caseId));
    const baselineAttempts = new Map();
    for (const run of baselineRuns) {
      const key = `${run.caseId}\u0000${run.attempt}`;
      if (baselineAttempts.has(key)) errors.push(`EvalResult repeats ${variant} attempt ${run.caseId}/${run.attempt}`);
      else baselineAttempts.set(key, run);
    }
    const incompleteBaseline = baselineRuns.filter((run) => run.status !== 'completed' || run.grade === null);
    if (incompleteBaseline.length > 0) errors.push(`EvalResult has incomplete ${variant} runs for required cases`);
    const insufficientBaseline = requirement.releaseCases
      .filter((entry) => [...baselineAttempts.values()].filter((run) => run.caseId === entry.caseId).length < entry.minimumRuns)
      .map((entry) => entry.caseId);
    if (insufficientBaseline.length > 0) {
      errors.push(`EvalResult lacks ${variant} runs for required cases: ${insufficientBaseline.join(', ')}`);
    }
    const completedBaseline = baselineRuns.filter((run) => run.status === 'completed' && run.grade !== null);
    const baselinePassed = completedBaseline.filter((run) => run.grade.passed).length;
    const baselinePassRate = completedBaseline.length === 0 ? 0 : baselinePassed / completedBaseline.length;
    if (currentPassRate < baselinePassRate) {
      errors.push(`current pass rate ${currentPassRate} regresses from ${variant} ${baselinePassRate}`);
    } else if (
      currentPassRate === baselinePassRate
      && completedCurrent.length > 0
      && completedBaseline.length > 0
      && completedCurrent.every((run) => typeof run.grade.score === 'number')
      && completedBaseline.every((run) => typeof run.grade.score === 'number')
    ) {
      const currentMeanScore = completedCurrent.reduce((total, run) => total + run.grade.score, 0)
        / completedCurrent.length;
      const baselineMeanScore = completedBaseline.reduce((total, run) => total + run.grade.score, 0)
        / completedBaseline.length;
      if (currentMeanScore < baselineMeanScore) {
        errors.push(`current mean score ${currentMeanScore} regresses from ${variant} ${baselineMeanScore}`);
      }
    }
    baseline = { variant, runs: completedBaseline.length, passRate: baselinePassRate };
  }
  return {
    errors,
    facts: {
      minimumRuns: requirement.releaseCases[0]?.minimumRuns ?? 1,
      minimumPassRate: requirement.minimumPassRate,
      releaseProcessManagement: requirement.releaseProcessManagement,
      processManagementMode: processMode,
      current: { runs: completedCurrent.length, passRate: currentPassRate },
      baseline,
    },
  };
}

function renderText(result) {
  const lines = [
    `Plugin: ${result.plugin}`,
    `Release check: ${result.ready ? 'ready' : 'blocked'}`,
    `Profiles: ${result.profiles.join(', ') || 'none'}`,
  ];
  for (const reason of result.reasons) lines.push('- ' + reason);
  return lines.join('\n') + '\n';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const pluginStats = await lstat(options.pluginRoot).catch(() => null);
  const manifestDirectory = path.join(options.pluginRoot, '.agents-plugin');
  const manifestPath = path.join(manifestDirectory, 'plugin.json');
  const manifestDirectoryStats = await lstat(manifestDirectory).catch(() => null);
  const manifestStats = await lstat(manifestPath).catch(() => null);
  if (!pluginStats?.isDirectory() || pluginStats.isSymbolicLink()) {
    throw new Error('Plugin root must be a regular directory.');
  }
  if (!manifestDirectoryStats?.isDirectory() || manifestDirectoryStats.isSymbolicLink()) {
    throw new Error('.agents-plugin must be a regular directory.');
  }
  if (!manifestStats?.isFile() || manifestStats.isSymbolicLink()) {
    throw new Error('Plugin manifest must be a regular file.');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const allSupportedProfiles = supportedProfiles(manifest);
  const profiles = options.profiles.length > 0 ? options.profiles : allSupportedProfiles;
  for (const profile of profiles) {
    if (!allSupportedProfiles.includes(profile)) {
      throw new Error('Profile is not supported by the plugin: ' + profile);
    }
  }
  await assertEvidenceFiles(options);
  const pluginValidation = await validatePluginSource(options.pluginRoot, options.workspaceRoot);
  if (pluginValidation.ok !== true) {
    const result = {
      schemaVersion: 2,
      producer: 'check-aw-plugin-release',
      plugin: manifest.name,
      ready: false,
      pluginMachineCheck: 'fail',
      profiles,
      targets: [],
      reasons: [`plugin source validation failed: ${(pluginValidation.errors ?? []).join('; ')}`],
    };
    const json = JSON.stringify(result, null, 2) + '\n';
    if (options.output) await writeFile(options.output, json, 'utf8');
    process.stdout.write(options.format === 'json' ? json : renderText(result));
    process.exitCode = 1;
    return;
  }
  const finalRoots = new Map();
  const finalRootInventories = new Map();
  for (const entry of options.finals) {
    if (!allSupportedProfiles.includes(entry.profile)) {
      throw new Error('Final profile is not supported by the plugin: ' + entry.profile);
    }
    if (!profiles.includes(entry.profile)) {
      throw new Error('Final profile is outside the selected release scope: ' + entry.profile);
    }
    if (finalRoots.has(entry.profile)) throw new Error('Duplicate final profile: ' + entry.profile);
    finalRoots.set(entry.profile, entry.root);
    finalRootInventories.set(entry.profile, await skillRoots(entry.root));
  }
  const skillsRoot = typeof manifest.skills === 'string'
    ? pluginCollectionRoot(options.pluginRoot, manifest.skills)
    : null;
  const discoveredSourceRoots = skillsRoot === null ? [] : await skillRoots(skillsRoot);
  const sourceRootByName = new Map();
  for (const root of discoveredSourceRoots) {
    const name = path.basename(root);
    if (sourceRootByName.has(name)) throw new Error('Duplicate source Skill leaf name: ' + name);
    sourceRootByName.set(name, root);
  }
  const leafPlan = reviewSkillLeafPlan(manifest, sourceRootByName.keys(), profiles);
  const sourceRoots = leafPlan.staticLeaves.map((leaf) => sourceRootByName.get(leaf.name));
  const dynamicLeaves = leafPlan.dynamicLeaves.map((leaf) => ({
    ...leaf,
    sourceRoot: pluginCollectionRoot(options.pluginRoot, `./skills/${leaf.skillKey}`),
  }));
  const hasLeafInventory = sourceRoots.length > 0 || dynamicLeaves.length > 0
    || [...finalRootInventories.values()].some((roots) => roots.length > 0);
  const evidenceCount = options.reviews.length
    + options.evalSpecs.length
    + options.evalAudits.length
    + options.evalResults.length;
  if (!hasLeafInventory && evidenceCount > 0) {
    throw new Error('A plugin with an empty leaf inventory must not receive Review or Eval evidence.');
  }
  if (hasLeafInventory && options.reviews.length === 0) {
    throw new Error('A non-empty leaf inventory requires Review evidence.');
  }
  const reviews = [];
  for (const reviewPath of options.reviews) reviews.push({ path: reviewPath, value: JSON.parse(await readFile(reviewPath, 'utf8')) });
  const reviewByDigest = new Map();
  for (const review of reviews) {
    const digest = review.value?.target?.digest;
    if (reviewByDigest.has(digest)) throw new Error('Duplicate review for digest: ' + digest);
    reviewByDigest.set(digest, review);
  }

  const checker = await bundledScript('check-agent-skill.mjs');
  const validator = await bundledScript('validate-quality-review-result.mjs');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aw-release-check-'));
  const reasons = [];
  const targets = [];
  const consumedReviewPaths = new Set();
  const consumedEvalPaths = new Set();
  try {
    const evalSpecEvidence = await loadEvalSpecs(options.evalSpecs);
    const evalAuditEvidence = await loadDigestEvidence(options.evalAudits, (entry) => entry.digest);
    const evalResultEvidence = await loadDigestEvidence(options.evalResults, (entry) => entry.value?.specDigest);
    for (const [label, evidence] of [
      ['EvalSpec', evalSpecEvidence],
      ['EvalAudit', evalAuditEvidence],
      ['EvalResult', evalResultEvidence],
    ]) {
      for (const key of evidence.duplicates) reasons.push(`duplicate ${label} for Eval chain ${JSON.stringify(key)}`);
    }
    for (const entry of evalSpecEvidence.entries) {
      if (!entry.validation.valid) {
        reasons.push(`EvalSpec ${entry.path} is invalid: ${(entry.validation.errors ?? []).join('; ')}`);
      }
    }
    const sourceByName = new Map();
    for (const root of sourceRoots) {
      const name = path.basename(root);
      const check = manifest.scripts?.node?.build === undefined
        ? await runJson(checker, [root, '--root-kind', 'source', '--profile', 'aw-source', '--format', 'json'], true)
        : null;
      sourceByName.set(name, { root, check });
    }

    const finalByProfile = new Map();
    for (const profile of profiles) {
      const root = finalRoots.get(profile);
      const byName = new Map();
      if (root) {
        for (const skillRoot of finalRootInventories.get(profile)) {
          const check = await runJson(checker, [skillRoot, '--root-kind', 'materialized', '--profile', profile, '--format', 'json'], true);
          if (byName.has(check.target.name)) {
            throw new Error(`Duplicate materialized Skill ${check.target.name} for ${profile}`);
          }
          byName.set(check.target.name, { root: skillRoot, check });
        }
      }
      finalByProfile.set(profile, byName);
    }

    async function evaluateTarget(kind, name, profile, root, check, evalRequirementValue) {
      const evalRequired = evalRequirementValue.required;
      if (evalRequirementValue.missingManifest) {
        reasons.push(`${kind}:${name}:${profile ?? 'source'} requires evals/manifest.json bound by skillKey`);
      }
      const checkPath = path.join(temporary, `${kind}-${name}-${profile ?? 'source'}-check.json`);
      await writeFile(checkPath, JSON.stringify(check, null, 2) + '\n');
      const review = reviewByDigest.get(check.target.digest);
      let reviewDesign = null;
      let reviewMode = null;
      let reviewScoring = null;
      let validReview = false;
      if (!check.ok) reasons.push(`${kind}:${name}:${profile ?? 'source'} failed machine check`);
      if (!review) {
        reasons.push(`${kind}:${name}:${profile ?? 'source'} has no review for digest ${check.target.digest}`);
      } else {
        consumedReviewPaths.add(review.path);
        const validation = await runJson(validator, [review.path, '--check', checkPath, '--format', 'json'], true);
        validReview = validation.valid === true;
        reviewDesign = review.value.design ?? null;
        reviewMode = review.value.mode ?? null;
        reviewScoring = validation.scoring ?? null;
        if (!validReview) reasons.push(`${kind}:${name}:${profile ?? 'source'} review is invalid: ${validation.errors.join('; ')}`);
        else if (validation.effectiveDecision !== 'pass') reasons.push(`${kind}:${name}:${profile ?? 'source'} review decision is ${validation.effectiveDecision}`);
        else if (reviewMode !== 'full') {
          reasons.push(`${kind}:${name}:${profile ?? 'source'} release review must use mode=full`);
        } else if (
          reviewScoring?.coveragePercent !== 100
          || !['medium', 'high'].includes(reviewScoring?.confidence)
        ) {
          reasons.push(`${kind}:${name}:${profile ?? 'source'} release review requires complete medium/high-confidence scoring`);
        }
      }

      let evalEvidence = null;
      if (evalRequired) {
        if (evalRequirementValue.releaseSuiteCount === 0) {
          reasons.push(`${kind}:${name}:${profile ?? 'source'} requires at least one release-required Eval suite`);
        }
        if (evalRequirementValue.unsupportedSuites.length > 0) {
          reasons.push(
            `${kind}:${name}:${profile ?? 'source'} has required Eval suites without bindable case corpora: ${evalRequirementValue.unsupportedSuites.join(', ')}`,
          );
        }
        const chains = [];
        for (const requirement of evalRequirementValue.chains) {
          const chainName = `${requirement.profile}/${requirement.suite}`;
          const evalSpec = evalSpecEvidence.bySelection.get(
            selectionKey(check.target.digest, requirement.profile, requirement.suite),
          );
          const evalResult = evalSpec ? evalResultEvidence.byKey.get(evalSpec.digest) : null;
          const evalAudit = evalResult ? evalAuditEvidence.byKey.get(evalResult.value?.auditDigest) : null;
          if (!evalSpec || !evalAudit || !evalResult) {
            if (evalSpec) consumedEvalPaths.add(evalSpec.path);
            if (evalAudit) consumedEvalPaths.add(evalAudit.path);
            if (evalResult) consumedEvalPaths.add(evalResult.path);
            reasons.push(
              `${kind}:${name}:${profile ?? 'source'} is missing complete Eval chain ${chainName} (EvalSpec/EvalAudit/EvalResult)`,
            );
            chains.push({ profile: requirement.profile, suite: requirement.suite, valid: false });
            continue;
          }
          for (const entry of [evalSpec, evalAudit, evalResult]) consumedEvalPaths.add(entry.path);
          const chainErrors = [];
          if (!evalSpec.validation.valid) chainErrors.push('EvalSpec is invalid');
          if (
            evalSpec.value?.source?.plugin !== requirement.plugin
            || evalSpec.value?.source?.skill !== requirement.skill
            || evalSpec.value?.source?.suite !== requirement.suite
            || evalSpec.value?.source?.profile !== requirement.profile
          ) {
            chainErrors.push('EvalSpec source does not match the current plugin/Skill/suite/profile');
          }
          chainErrors.push(...caseCorpusErrors(requirement, evalSpec.selectedCases));

          let auditValidation = { valid: false, errors: ['EvalSpec is invalid'] };
          if (evalSpec.validation.valid) {
            auditValidation = await runEvalJson([
              'audit', 'validate', evalAudit.path, '--spec', evalSpec.path,
            ]);
          }
          if (!auditValidation.valid) {
            chainErrors.push(`EvalAudit is invalid: ${(auditValidation.errors ?? []).join('; ')}`);
          }

          let resultValidation = { valid: false, errors: ['EvalAudit is invalid'] };
          if (auditValidation.valid) {
            resultValidation = await runEvalJson([
              'result', 'validate', evalResult.path,
              '--spec', evalSpec.path,
              '--audit', evalAudit.path,
            ]);
          }
          if (!resultValidation.valid) {
            chainErrors.push(`EvalResult is invalid: ${(resultValidation.errors ?? []).join('; ')}`);
          }

          let facts = null;
          if (resultValidation.valid) {
            const checked = runFactErrors(requirement, evalSpec.value, evalResult.value);
            chainErrors.push(...checked.errors);
            facts = checked.facts;
          }
          if (chainErrors.length > 0) {
            reasons.push(`${kind}:${name}:${profile ?? 'source'} Eval chain ${chainName} is invalid: ${chainErrors.join('; ')}`);
          }
          chains.push({
            profile: requirement.profile,
            suite: requirement.suite,
            valid: chainErrors.length === 0,
            evalSpecDigest: evalSpec.digest,
            evalAuditDigest: evalAudit.digest,
            evalResultDigest: evalResult.digest,
            facts,
          });
        }
        evalEvidence = {
          valid: chains.length === evalRequirementValue.chains.length
            && chains.every((entry) => entry.valid),
          chains,
        };
      }
      targets.push({
        kind,
        name,
        profile,
        digest: check.target.digest,
        machineCheck: check.ok ? 'pass' : 'fail',
        reviewDesign,
        reviewMode,
        reviewScoring,
        validReview,
        evalRequired,
        evalEvidence,
      });
    }

    for (const [name, source] of sourceByName) {
      const staticLeaf = leafPlan.staticLeaves.find((leaf) => leaf.name === name);
      if (source.check !== null) {
        await evaluateTarget('source', name, null, source.root, source.check, {
          required: false,
          missingManifest: false,
          chains: [],
          releaseSuiteCount: 0,
          unsupportedSuites: [],
        });
      }
      for (const profile of staticLeaf.profiles) {
        const requirement = await evalRequirement(
          source.root,
          manifest.name,
          name,
          false,
          profile,
        );
        const final = finalByProfile.get(profile).get(name);
        if (!final) {
          reasons.push(`materialized:${name}:${profile} is missing`);
          targets.push({
            kind: 'materialized',
            name,
            profile,
            digest: null,
            machineCheck: 'missing',
            reviewDesign: null,
            reviewMode: null,
            reviewScoring: null,
            validReview: false,
            evalRequired: requirement.required,
            evalEvidence: null,
          });
        } else {
          await evaluateTarget('materialized', name, profile, final.root, final.check, requirement);
        }
      }
    }
    for (const leaf of dynamicLeaves) {
      const final = finalByProfile.get(leaf.profile).get(leaf.name);
      const requirement = await evalRequirement(
        leaf.sourceRoot,
        manifest.name,
        leaf.skillKey,
        leaf.requiresEval,
        leaf.profile,
      );
      if (!final) {
        reasons.push(`dynamic:${leaf.id}:${leaf.name}:${leaf.profile} is missing`);
        targets.push({
          kind: 'materialized',
          name: leaf.name,
          profile: leaf.profile,
          dynamicTargetId: leaf.id,
          digest: null,
          machineCheck: 'missing',
          reviewDesign: null,
          reviewMode: null,
          reviewScoring: null,
          validReview: false,
          evalRequired: requirement.required,
          evalEvidence: null,
        });
      } else {
        await evaluateTarget('materialized', leaf.name, leaf.profile, final.root, final.check, requirement);
        targets[targets.length - 1].dynamicTargetId = leaf.id;
      }
    }
    const expectedFinalNames = new Map(profiles.map((profile) => [profile, new Set()]));
    for (const leaf of leafPlan.finalLeaves) expectedFinalNames.get(leaf.profile).add(leaf.name);
    for (const [profile, byName] of finalByProfile) {
      for (const name of byName.keys()) {
        if (!expectedFinalNames.get(profile).has(name)) {
          reasons.push(`materialized:${name}:${profile} is not consumed by the release plan`);
        }
      }
    }
    for (const review of reviews) {
      if (!consumedReviewPaths.has(review.path)) {
        reasons.push(`Review evidence ${review.path} does not match any leaf target digest`);
      }
    }
    for (const [label, evidence] of [
      ['EvalSpec', evalSpecEvidence],
      ['EvalAudit', evalAuditEvidence],
      ['EvalResult', evalResultEvidence],
    ]) {
      for (const entry of evidence.entries) {
        if (!consumedEvalPaths.has(entry.path)) {
          reasons.push(`${label} ${entry.path} is not consumed by a required profile/suite Eval chain`);
        }
      }
    }

    const result = {
      schemaVersion: 2,
      producer: 'check-aw-plugin-release',
      plugin: manifest.name,
      ready: reasons.length === 0,
      pluginMachineCheck: pluginValidation.ok === true ? 'pass' : 'fail',
      profiles,
      targets,
      reasons,
      notes: targets.length === 0 ? ['empty leaf inventory: plugin declares no Skills'] : [],
    };
    const json = JSON.stringify(result, null, 2) + '\n';
    if (options.output) await writeFile(options.output, json, 'utf8');
    process.stdout.write(options.format === 'json' ? json : renderText(result));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(2);
});
