#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = new Set(['codex-user', 'codex-project', 'claude-user', 'claude-project']);
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

function usage() {
  return 'Usage: check-aw-plugin-release.mjs <plugin-root> --review <review.json>... --final <profile=path>... [--preflight-audit path]... [--run-bundle path]... [--triage-audit path]... [--profile name] [--output file] [--format json|text]';
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
  const preflightAudits = [];
  const runBundles = [];
  const triageAudits = [];
  let output = null;
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--review') {
      reviews.push(path.resolve(valueAfter(argv, index, value)));
      index += 1;
    } else if (value === '--final') {
      finals.push(parseNamedPath(valueAfter(argv, index, value), value));
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
  if (positional.length !== 1 || reviews.length === 0) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  return {
    pluginRoot: positional[0],
    reviews,
    finals,
    profiles: [...new Set(profiles)],
    preflightAudits,
    runBundles,
    triageAudits,
    output,
    format,
  };
}

async function skillRoots(root) {
  const roots = [];
  async function visit(directory) {
    const skillFile = path.join(directory, 'SKILL.md');
    if ((await stat(skillFile).catch(() => null))?.isFile()) {
      roots.push(directory);
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Skill discovery cannot follow symlink: ' + entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return roots;
}

function supportedProfiles(manifest) {
  const products = Array.isArray(manifest.marketplace?.policy?.products) && manifest.marketplace.policy.products.length > 0
    ? manifest.marketplace.policy.products.map((value) => String(value).toUpperCase())
    : ['CODEX', 'CLAUDE'];
  return [...new Set(products.flatMap((product) => {
    if (product === 'CODEX') return ['codex-user', 'codex-project'];
    if (product === 'CLAUDE') return ['claude-user', 'claude-project'];
    return [];
  }))];
}

async function runJson(file, args, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [file, ...args], { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (error) {
    if (!allowFailure || typeof error?.stdout !== 'string' || !error.stdout.trim()) throw error;
    return JSON.parse(error.stdout);
  }
}

async function localCliEntry() {
  let current = scriptRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, 'packages', 'cli', 'dist', 'index.js');
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function validatePluginSource(pluginRoot) {
  const configured = process.env.AW_PLUGIN_VALIDATOR_BIN
    ? path.resolve(process.env.AW_PLUGIN_VALIDATOR_BIN)
    : await localCliEntry();
  const command = configured ? process.execPath : 'aw';
  const args = [
    ...(configured ? [configured] : []),
    'plugin',
    'validate',
    pluginRoot,
    '--json',
  ];
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' });
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

async function loadEvidence(paths, expectedMode, validator, bundleByDigest = null) {
  const entries = [];
  const duplicates = [];
  const byTarget = new Map();
  for (const evidencePath of paths) {
    const value = JSON.parse(await readFile(evidencePath, 'utf8'));
    const targetDigest = value?.targetSkillDigest;
    const validatorArgs = [evidencePath, '--format', 'json'];
    if (expectedMode === 'result-triage') {
      const bundle = bundleByDigest?.get(targetDigest);
      if (bundle) validatorArgs.push('--run-bundle', bundle.path);
    }
    const validation = await runJson(validator, validatorArgs, true);
    const entry = {
      path: evidencePath,
      value,
      digest: await digestFile(evidencePath),
      validation,
    };
    entries.push(entry);
    if (value?.mode !== expectedMode) {
      validation.valid = false;
      validation.errors = [...(validation.errors ?? []), `audit mode must be ${expectedMode}`];
    }
    if (byTarget.has(targetDigest)) duplicates.push(targetDigest);
    else byTarget.set(targetDigest, entry);
  }
  return { entries, byTarget, duplicates };
}

async function loadRunBundles(paths, validator) {
  const entries = [];
  const duplicates = [];
  const byTarget = new Map();
  for (const bundlePath of paths) {
    const value = JSON.parse(await readFile(bundlePath, 'utf8'));
    const validation = await runJson(validator, [bundlePath, '--format', 'json'], true);
    const entry = {
      path: bundlePath,
      value,
      digest: await digestFile(bundlePath),
      validation,
    };
    entries.push(entry);
    if (byTarget.has(value?.targetSkillDigest)) duplicates.push(value?.targetSkillDigest);
    else byTarget.set(value?.targetSkillDigest, entry);
  }
  return { entries, byTarget, duplicates };
}

async function evalRequirement(skillRoot) {
  const manifestPath = path.join(skillRoot, 'evals', 'manifest.json');
  const content = await readFile(manifestPath, 'utf8').catch(() => null);
  if (content === null) {
    return { required: false, corpusDigest: null, releaseCases: [], unsupportedSuites: [] };
  }
  const manifest = JSON.parse(content);
  const requiredSuites = Array.isArray(manifest.suites)
    ? manifest.suites.filter((suite) => suite?.requiredForRelease === true)
    : [];
  const required = manifest.requiredForRelease === true || requiredSuites.length > 0;
  const caseDocuments = [];
  const releaseCaseRuns = new Map();
  const unsupportedSuites = [];
  for (const suite of requiredSuites) {
    if (typeof suite.cases !== 'string') {
      unsupportedSuites.push(suite.id ?? '<unknown>');
      continue;
    }
    const casePath = path.resolve(path.dirname(manifestPath), suite.cases);
    const document = JSON.parse(await readFile(casePath, 'utf8'));
    caseDocuments.push(stableJson(document));
    const releaseSplits = Array.isArray(suite.releaseSplits) ? new Set(suite.releaseSplits) : new Set();
    for (const entry of document.cases ?? document.evals ?? []) {
      if (
        typeof entry?.id === 'string'
        && (releaseSplits.size === 0 || releaseSplits.has(entry.split))
      ) {
        const minimumRuns = Number.isInteger(suite.defaultRuns) && suite.defaultRuns > 0
          ? suite.defaultRuns
          : 1;
        releaseCaseRuns.set(
          entry.id,
          Math.max(releaseCaseRuns.get(entry.id) ?? 0, minimumRuns),
        );
      }
    }
  }
  caseDocuments.sort();
  const corpusDigest = caseDocuments.length === 0
    ? null
    : `sha256:${createHash('sha256').update(caseDocuments.join('\n')).digest('hex')}`;
  const releaseCases = [...releaseCaseRuns]
    .map(([caseId, minimumRuns]) => ({ caseId, minimumRuns }))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  return { required, corpusDigest, releaseCases, unsupportedSuites };
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
  const manifest = JSON.parse(await readFile(path.join(options.pluginRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  const profiles = options.profiles.length > 0 ? options.profiles : supportedProfiles(manifest);
  const finalRoots = new Map();
  for (const entry of options.finals) {
    if (finalRoots.has(entry.profile)) throw new Error('Duplicate final profile: ' + entry.profile);
    finalRoots.set(entry.profile, entry.root);
  }
  const reviews = [];
  for (const reviewPath of options.reviews) reviews.push({ path: reviewPath, value: JSON.parse(await readFile(reviewPath, 'utf8')) });
  const reviewByDigest = new Map();
  for (const review of reviews) {
    const digest = review.value?.target?.digest;
    if (reviewByDigest.has(digest)) throw new Error('Duplicate review for digest: ' + digest);
    reviewByDigest.set(digest, review);
  }

  const checker = process.env.AW_SKILL_CHECK_BIN
    ? path.resolve(process.env.AW_SKILL_CHECK_BIN)
    : path.join(scriptRoot, 'check-agent-skill.mjs');
  const validator = process.env.AW_QUALITY_REVIEW_VALIDATOR
    ? path.resolve(process.env.AW_QUALITY_REVIEW_VALIDATOR)
    : path.join(scriptRoot, 'validate-quality-review-result.mjs');
  const evalAuditValidator = process.env.AW_EVAL_AUDIT_VALIDATOR
    ? path.resolve(process.env.AW_EVAL_AUDIT_VALIDATOR)
    : path.join(scriptRoot, 'validate-eval-audit-result.mjs');
  const evalBundleValidator = process.env.AW_EVAL_BUNDLE_VALIDATOR
    ? path.resolve(process.env.AW_EVAL_BUNDLE_VALIDATOR)
    : path.join(scriptRoot, 'validate-eval-run-bundle.mjs');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aw-release-check-'));
  const reasons = [];
  const targets = [];
  try {
    const pluginValidation = await validatePluginSource(options.pluginRoot);
    if (pluginValidation.ok !== true) {
      reasons.push(`plugin source validation failed: ${(pluginValidation.errors ?? []).join('; ')}`);
    }
    const runBundleEvidence = await loadRunBundles(options.runBundles, evalBundleValidator);
    const preflightEvidence = await loadEvidence(
      options.preflightAudits,
      'preflight',
      evalAuditValidator,
    );
    const triageEvidence = await loadEvidence(
      options.triageAudits,
      'result-triage',
      evalAuditValidator,
      runBundleEvidence.byTarget,
    );
    for (const [label, evidence] of [
      ['preflight audit', preflightEvidence],
      ['run bundle', runBundleEvidence],
      ['triage audit', triageEvidence],
    ]) {
      for (const digest of evidence.duplicates) reasons.push(`duplicate ${label} for target ${digest}`);
      for (const entry of evidence.entries) {
        if (!entry.validation.valid) {
          reasons.push(`${label} ${entry.path} is invalid: ${(entry.validation.errors ?? []).join('; ')}`);
        }
      }
    }
    const skillsRoot = typeof manifest.skills === 'string'
      ? path.resolve(options.pluginRoot, manifest.skills)
      : path.join(options.pluginRoot, 'skills');
    const sourceRoots = await skillRoots(skillsRoot);
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
        for (const skillRoot of await skillRoots(root)) {
          const check = await runJson(checker, [skillRoot, '--root-kind', 'materialized', '--profile', profile, '--format', 'json'], true);
          byName.set(check.target.name, { root: skillRoot, check });
        }
      }
      finalByProfile.set(profile, byName);
    }

    async function evaluateTarget(kind, name, profile, root, check, evalRequirementValue) {
      const evalRequired = evalRequirementValue.required;
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
        if (evalRequirementValue.unsupportedSuites.length > 0) {
          reasons.push(
            `${kind}:${name}:${profile ?? 'source'} has required Eval suites without bindable case corpora: ${evalRequirementValue.unsupportedSuites.join(', ')}`,
          );
        }
        const preflight = preflightEvidence.byTarget.get(check.target.digest);
        const bundle = runBundleEvidence.byTarget.get(check.target.digest);
        const triage = triageEvidence.byTarget.get(check.target.digest);
        if (!preflight || !bundle || !triage) {
          reasons.push(`${kind}:${name}:${profile ?? 'source'} requires a complete preflight/run/triage Eval evidence chain`);
        } else {
          const chainErrors = [];
          if (!preflight.validation.valid) chainErrors.push('preflight audit is invalid');
          if (!bundle.validation.valid) chainErrors.push('run bundle is invalid');
          if (!triage.validation.valid) chainErrors.push('triage audit is invalid');
          if (preflight.value.validity !== 'pass' || preflight.value.releaseEligible !== true) {
            chainErrors.push('preflight audit is not release eligible');
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
          if (triage.value.runBundleDigest !== bundle.digest) {
            chainErrors.push('triage runBundleDigest does not match the run bundle bytes');
          }
          if (
            evalRequirementValue.corpusDigest !== null
            && preflight.value.caseCorpusDigest !== evalRequirementValue.corpusDigest
          ) {
            chainErrors.push('Eval evidence caseCorpusDigest does not match the current required suite corpus');
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
            evalRequirementValue.releaseCases.length > 0
            && JSON.stringify(preflightReleaseCases) !== JSON.stringify(
              evalRequirementValue.releaseCases.map((entry) => entry.caseId),
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
          const insufficientCases = evalRequirementValue.releaseCases
            .filter((entry) => (completedRuns.get(entry.caseId)?.size ?? 0) < entry.minimumRuns)
            .map((entry) => `${entry.caseId} (${completedRuns.get(entry.caseId)?.size ?? 0}/${entry.minimumRuns})`);
          if (insufficientCases.length > 0) {
            chainErrors.push(`run bundle lacks completed with-skill runs for required cases: ${insufficientCases.join(', ')}`);
          }
          if (chainErrors.length > 0) {
            reasons.push(`${kind}:${name}:${profile ?? 'source'} Eval evidence chain is invalid: ${chainErrors.join('; ')}`);
          }
          evalEvidence = {
            valid: chainErrors.length === 0,
            evidenceLevel: bundle.value.evidenceLevel ?? null,
            preflightAuditDigest: preflight.digest,
            runBundleDigest: bundle.digest,
            triageAuditDigest: triage.digest,
          };
        }
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
      const requirement = await evalRequirement(source.root);
      if (source.check !== null) {
        await evaluateTarget('source', name, null, source.root, source.check, requirement);
      }
      for (const profile of profiles) {
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
    for (const [profile, byName] of finalByProfile) {
      for (const name of byName.keys()) if (!sourceByName.has(name)) reasons.push(`materialized:${name}:${profile} has no source Skill`);
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
