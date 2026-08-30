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
  'AW_EVAL_AUDIT_VALIDATOR',
  'AW_EVAL_BUNDLE_VALIDATOR',
];

function usage() {
  return [
    'Usage: check-aw-plugin-release.mjs <plugin-root> --workspace-root <dir> [--review <review.json>]... --final <profile=path>... [--eval-plan path]... [--preflight-audit path]... [--run-bundle path]... [--triage-audit path]... [--profile name] [--output file] [--format json|text]',
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
  const evalPlans = [];
  const preflightAudits = [];
  const runBundles = [];
  const triageAudits = [];
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
    } else if (value === '--eval-plan') {
      evalPlans.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--preflight-audit') {
      preflightAudits.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--run-bundle') {
      runBundles.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--triage-audit') {
      triageAudits.push(path.resolve(valueAfter(argv, index, value)));
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
    evalPlans,
    preflightAudits,
    runBundles,
    triageAudits,
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
    ['Eval plan', options.evalPlans],
    ['preflight audit', options.preflightAudits],
    ['run bundle', options.runBundles],
    ['triage audit', options.triageAudits],
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

function auditKey(targetDigest, caseCorpusDigest) {
  return `${targetDigest ?? ''}\u0000${caseCorpusDigest ?? ''}`;
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

async function selectedPlanCases(planPath, plan) {
  const selected = [];
  for (const relativePath of plan?.cases?.paths ?? []) {
    const document = JSON.parse(await readFile(path.resolve(path.dirname(planPath), relativePath), 'utf8'));
    selected.push(...caseEntries(document));
  }
  return selected;
}

async function loadAuditEvidence(paths, expectedMode, validator, relatedEvidence) {
  const entries = [];
  const duplicates = [];
  const byKey = new Map();
  for (const evidencePath of paths) {
    const value = JSON.parse(await readFile(evidencePath, 'utf8'));
    const targetDigest = value?.targetSkillDigest;
    const validatorArgs = [evidencePath, '--format', 'json'];
    let key;
    if (expectedMode === 'preflight') {
      key = auditKey(targetDigest, value?.caseCorpusDigest);
      const plan = relatedEvidence?.get(key);
      if (plan) validatorArgs.push('--plan', plan.path);
    } else if (expectedMode === 'result-triage') {
      key = value?.runBundleDigest;
      const bundle = relatedEvidence?.get(key);
      if (bundle) validatorArgs.push('--run-bundle', bundle.path);
    }
    const validation = await runJson(validator, validatorArgs, true);
    const entry = {
      path: evidencePath,
      value,
      targetDigest,
      digest: await digestFile(evidencePath),
      validation,
      key,
    };
    entries.push(entry);
    if (value?.mode !== expectedMode) {
      validation.valid = false;
      validation.errors = [...(validation.errors ?? []), `audit mode must be ${expectedMode}`];
    }
    if (byKey.has(key)) duplicates.push(key);
    else byKey.set(key, entry);
  }
  return { entries, byKey, duplicates };
}

async function loadEvalPlans(paths) {
  const entries = [];
  const duplicates = [];
  const bySelection = new Map();
  const byAuditKey = new Map();
  for (const planPath of paths) {
    let validation;
    try {
      const { stdout } = await execFileAsync(
        'aw-skill-eval',
        ['plan', 'validate', planPath],
        { encoding: 'utf8', env: executionEnv() },
      );
      validation = JSON.parse(stdout);
    } catch (error) {
      if (typeof error?.stdout !== 'string' || !error.stdout.trim()) throw error;
      validation = JSON.parse(error.stdout);
    }
    const value = JSON.parse(await readFile(planPath, 'utf8'));
    const receiptPath = path.join(path.dirname(planPath), 'preparation.json');
    const receiptStats = await lstat(receiptPath).catch(() => null);
    const receipt = receiptStats?.isFile() && !receiptStats.isSymbolicLink()
      ? JSON.parse(await readFile(receiptPath, 'utf8'))
      : null;
    const targetDigest = validation.calculated?.targetSkillDigest ?? value?.target?.digest;
    const skillDigests = new Set(typeof targetDigest === 'string' ? [targetDigest] : []);
    for (const digest of Object.values(validation.calculated?.configurationSkillDigests ?? {})) {
      if (typeof digest === 'string') skillDigests.add(digest);
    }
    const entry = {
      path: planPath,
      value,
      targetDigest,
      skillDigests,
      digest: await digestFile(planPath),
      validation,
      receipt,
      selectedCases: validation.valid ? await selectedPlanCases(planPath, value) : [],
    };
    const receiptErrors = [];
    if (
      receipt?.schemaVersion !== 1
      || receipt?.command !== 'skill:eval:prepare'
      || typeof receipt?.plugin !== 'string'
      || typeof receipt?.skill !== 'string'
      || typeof receipt?.suite !== 'string'
      || typeof receipt?.profile !== 'string'
      || typeof receipt?.planPath !== 'string'
    ) {
      receiptErrors.push('adjacent preparation.json must be a skill:eval:prepare v1 receipt');
    } else if (path.resolve(path.dirname(receiptPath), receipt.planPath) !== path.resolve(planPath)) {
      receiptErrors.push('preparation receipt planPath does not identify this Eval plan');
    }
    if (receipt?.targetDigest !== targetDigest) {
      receiptErrors.push('preparation receipt targetDigest does not match the validated Eval plan');
    }
    if (receipt?.corpusDigest !== validation.calculated?.caseCorpusDigest) {
      receiptErrors.push('preparation receipt corpusDigest does not match the validated Eval plan');
    }
    if (receiptErrors.length > 0) {
      validation.valid = false;
      validation.errors = [...(validation.errors ?? []), ...receiptErrors];
    }
    entries.push(entry);
    const key = selectionKey(targetDigest, receipt?.profile, receipt?.suite);
    entry.selectionKey = key;
    if (bySelection.has(key)) duplicates.push(key);
    else bySelection.set(key, entry);
    for (const digest of skillDigests) {
      const key = auditKey(digest, validation.calculated?.caseCorpusDigest);
      if (!byAuditKey.has(key)) byAuditKey.set(key, entry);
    }
  }
  return { entries, bySelection, byAuditKey, duplicates };
}

async function loadRunBundles(paths, validator) {
  const entries = [];
  const duplicates = [];
  const byPlanDigest = new Map();
  const byDigest = new Map();
  for (const bundlePath of paths) {
    const value = JSON.parse(await readFile(bundlePath, 'utf8'));
    const validation = await runJson(validator, [bundlePath, '--format', 'json'], true);
    const entry = {
      path: bundlePath,
      value,
      targetDigest: value?.targetSkillDigest,
      digest: await digestFile(bundlePath),
      validation,
    };
    entries.push(entry);
    if (byPlanDigest.has(value?.planDigest)) duplicates.push(value?.planDigest);
    else byPlanDigest.set(value?.planDigest, entry);
    byDigest.set(entry.digest, entry);
  }
  return { entries, byPlanDigest, byDigest, duplicates };
}

async function evalRequirement(skillRoot, requiresEval = false, releaseProfile = null) {
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
  const required = manifest.requiredForRelease === true || requiredSuites.length > 0;
  const releaseScope = releaseProfile === null
    ? null
    : releaseProfile.endsWith('-project') ? 'project' : 'user';
  const requiredProfiles = Array.isArray(manifest.profiles)
    ? manifest.profiles.filter((profile) =>
      profile?.requiredForRelease === true
      && (releaseScope === null || profile.scope === releaseScope))
    : [];
  const chains = [];
  const unsupportedSuites = [];
  for (const suite of requiredSuites) {
    const suiteProfiles = requiredProfiles.filter((profile) => suite.profiles?.includes(profile.id));
    if (suiteProfiles.length === 0) continue;
    if (typeof suite.cases !== 'string') {
      unsupportedSuites.push(...suiteProfiles.map((profile) => `${profile.id}/${suite.id ?? '<unknown>'}`));
      continue;
    }
    const casePath = path.resolve(path.dirname(manifestPath), suite.cases);
    const document = JSON.parse(await readFile(casePath, 'utf8'));
    const suiteCases = caseEntries(document);
    const releaseSplits = Array.isArray(suite.releaseSplits) ? new Set(suite.releaseSplits) : new Set();
    const selectedCases = suiteCases.filter((entry) =>
      typeof entry?.id === 'string'
      && (releaseSplits.size === 0 || releaseSplits.has('all') || releaseSplits.has(entry.split)));
    const minimumRuns = Number.isInteger(suite.defaultRuns) && suite.defaultRuns > 0
      ? suite.defaultRuns
      : 1;
    for (const profile of suiteProfiles) {
      chains.push({
        plugin: manifest.plugin,
        skill: manifest.skill,
        profile: profile.id,
        suite: suite.id,
        suiteCases,
        selectedCases,
        releaseCases: selectedCases
          .map((entry) => ({ caseId: entry.id, minimumRuns }))
          .sort((left, right) => left.caseId.localeCompare(right.caseId)),
      });
    }
  }
  return {
    required: requiresEval || required,
    missingManifest: false,
    chains,
    releaseSuiteCount: chains.length,
    unsupportedSuites,
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
  await assertEvidenceFiles(options);
  const hasLeafInventory = sourceRoots.length > 0 || dynamicLeaves.length > 0
    || [...finalRootInventories.values()].some((roots) => roots.length > 0);
  const evidenceCount = options.reviews.length
    + options.evalPlans.length
    + options.preflightAudits.length
    + options.runBundles.length
    + options.triageAudits.length;
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
  const evalAuditValidator = await bundledScript('validate-eval-audit-result.mjs');
  const evalBundleValidator = await bundledScript('validate-eval-run-bundle.mjs');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aw-release-check-'));
  const reasons = [];
  const targets = [];
  const consumedReviewPaths = new Set();
  const consumedEvalPaths = new Set();
  try {
    const evalPlanEvidence = await loadEvalPlans(options.evalPlans);
    const runBundleEvidence = await loadRunBundles(options.runBundles, evalBundleValidator);
    const preflightEvidence = await loadAuditEvidence(
      options.preflightAudits,
      'preflight',
      evalAuditValidator,
      evalPlanEvidence.byAuditKey,
    );
    const triageEvidence = await loadAuditEvidence(
      options.triageAudits,
      'result-triage',
      evalAuditValidator,
      runBundleEvidence.byDigest,
    );
    for (const [label, evidence] of [
      ['Eval plan', evalPlanEvidence],
      ['preflight audit', preflightEvidence],
      ['run bundle', runBundleEvidence],
      ['triage audit', triageEvidence],
    ]) {
      for (const key of evidence.duplicates) reasons.push(`duplicate ${label} for Eval chain ${JSON.stringify(key)}`);
      for (const entry of evidence.entries) {
        if (!entry.validation.valid) {
          reasons.push(`${label} ${entry.path} is invalid: ${(entry.validation.errors ?? []).join('; ')}`);
        }
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
          const evalPlan = evalPlanEvidence.bySelection.get(
            selectionKey(check.target.digest, requirement.profile, requirement.suite),
          );
          const bundle = evalPlan ? runBundleEvidence.byPlanDigest.get(evalPlan.digest) : null;
          const triage = bundle ? triageEvidence.byKey.get(bundle.digest) : null;
          const expectedPreflightDigests = evalPlan ? [...evalPlan.skillDigests] : [];
          const corpusDigest = evalPlan?.validation.calculated?.caseCorpusDigest;
          const preflights = expectedPreflightDigests
            .map((digest) => preflightEvidence.byKey.get(auditKey(digest, corpusDigest)))
            .filter(Boolean);
          const preflight = preflightEvidence.byKey.get(auditKey(check.target.digest, corpusDigest));
          if (
            !evalPlan
            || !preflight
            || preflights.length !== expectedPreflightDigests.length
            || !bundle
            || !triage
          ) {
            reasons.push(
              `${kind}:${name}:${profile ?? 'source'} is missing complete Eval chain ${chainName} (Plan/preflight/run/triage)`,
            );
            chains.push({ profile: requirement.profile, suite: requirement.suite, valid: false });
            continue;
          }
          for (const entry of [evalPlan, ...preflights, bundle, triage]) consumedEvalPaths.add(entry.path);
          const chainErrors = [];
          if (!evalPlan.validation.valid) chainErrors.push('Eval plan is invalid');
          if (preflights.some((entry) => !entry.validation.valid)) chainErrors.push('a preflight audit is invalid');
          if (!bundle.validation.valid) chainErrors.push('run bundle is invalid');
          if (!triage.validation.valid) chainErrors.push('triage audit is invalid');
          if (preflights.some((entry) => entry.value.validity !== 'pass' || entry.value.releaseEligible !== true)) {
            chainErrors.push('a preflight audit is not release eligible');
          }
          if (triage.value.validity !== 'pass' || triage.value.releaseEligible !== true) {
            chainErrors.push('triage audit is not release eligible');
          }
          if (bundle.value.caseCorpusDigest !== preflight.value.caseCorpusDigest) {
            chainErrors.push('run bundle caseCorpusDigest does not match the preflight audit');
          }
          if (triage.value.caseCorpusDigest !== bundle.value.caseCorpusDigest) {
            chainErrors.push('triage caseCorpusDigest does not match the run bundle');
          }
          if (bundle.value.planDigest !== evalPlan.digest) {
            chainErrors.push('run bundle planDigest does not match the Eval plan bytes');
          }
          if (triage.value.runBundleDigest !== bundle.digest) {
            chainErrors.push('triage runBundleDigest does not match the run bundle bytes');
          }
          if (
            evalPlan.receipt.plugin !== requirement.plugin
            || evalPlan.receipt.skill !== requirement.skill
          ) {
            chainErrors.push('Eval plan preparation receipt does not match the current plugin/Skill');
          }
          const currentCaseById = new Map(requirement.suiteCases
            .filter((entry) => typeof entry?.id === 'string')
            .map((entry) => [entry.id, stableJson(entry)]));
          const actualCaseById = new Map(evalPlan.selectedCases
            .filter((entry) => typeof entry?.id === 'string')
            .map((entry) => [entry.id, stableJson(entry)]));
          if (
            actualCaseById.size !== evalPlan.selectedCases.length
            || [...actualCaseById].some(([caseId, value]) => currentCaseById.get(caseId) !== value)
            || requirement.releaseCases.some((entry) => !actualCaseById.has(entry.caseId))
          ) {
            chainErrors.push('Eval plan case corpus does not match the current required suite cases');
          }
          const preflightReleaseCases = preflight.value.cases
            .filter((entry) => entry.releaseRelevant)
            .map((entry) => entry.caseId)
            .sort();
          const triageReleaseCases = triage.value.cases
            .filter((entry) => entry.releaseRelevant)
            .map((entry) => entry.caseId)
            .sort();
          if (JSON.stringify(triageReleaseCases) !== JSON.stringify(preflightReleaseCases)) {
            chainErrors.push('triage audit release-relevant cases do not match the preflight audit');
          }
          if (
            requirement.releaseCases.length > 0
            && JSON.stringify(preflightReleaseCases) !== JSON.stringify(
              requirement.releaseCases.map((entry) => entry.caseId),
            )
          ) {
            chainErrors.push('preflight audit release-relevant cases do not match the current required suite cases');
          }
          const completedRuns = new Map();
          for (const run of bundle.value.runs) {
            if (
              run.status !== 'completed'
              || run.skillMode !== 'with-skill'
              || run.skillDigest !== check.target.digest
            ) continue;
            if (!completedRuns.has(run.caseId)) completedRuns.set(run.caseId, new Set());
            completedRuns.get(run.caseId).add(run.runIndex);
          }
          const insufficientCases = requirement.releaseCases
            .filter((entry) => (completedRuns.get(entry.caseId)?.size ?? 0) < entry.minimumRuns)
            .map((entry) => `${entry.caseId} (${completedRuns.get(entry.caseId)?.size ?? 0}/${entry.minimumRuns})`);
          if (insufficientCases.length > 0) {
            chainErrors.push(`run bundle lacks completed with-skill runs for required cases: ${insufficientCases.join(', ')}`);
          }
          if (chainErrors.length > 0) {
            reasons.push(`${kind}:${name}:${profile ?? 'source'} Eval chain ${chainName} is invalid: ${chainErrors.join('; ')}`);
          }
          chains.push({
            profile: requirement.profile,
            suite: requirement.suite,
            valid: chainErrors.length === 0,
            evidenceLevel: bundle.value.evidenceLevel ?? null,
            planDigest: evalPlan.digest,
            preflightAuditDigests: preflights.map((entry) => entry.digest).sort(),
            runBundleDigest: bundle.digest,
            triageAuditDigest: triage.digest,
          });
        }
        evalEvidence = {
          valid: chains.length === evalRequirementValue.chains.length
            && chains.every((entry) => entry.valid),
          evidenceLevel: chains.length > 0 && chains.every((entry) => entry.evidenceLevel === 'executed')
            ? 'executed'
            : null,
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
      const requirement = await evalRequirement(source.root);
      if (source.check !== null) {
        await evaluateTarget('source', name, null, source.root, source.check, requirement);
      }
      for (const profile of staticLeaf.profiles) {
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
      const requirement = await evalRequirement(leaf.sourceRoot, leaf.requiresEval, leaf.profile);
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
      ['Eval plan', evalPlanEvidence],
      ['preflight audit', preflightEvidence],
      ['run bundle', runBundleEvidence],
      ['triage audit', triageEvidence],
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
