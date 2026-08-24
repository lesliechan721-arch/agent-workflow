#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  let format = 'text';
  let planPath = null;
  let pluginRoot = null;
  const evidence = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--format') format = argv[++index];
    else if (argv[index] === '--plan') planPath = path.resolve(argv[++index] ?? '');
    else if (argv[index] === '--plugin-root') pluginRoot = path.resolve(argv[++index] ?? '');
    else if (argv[index] === '--evidence') {
      const id = argv[++index];
      const resultPath = argv[++index];
      const bundlePath = argv[++index];
      if (!id || !resultPath || !bundlePath) {
        throw new Error('--evidence requires <id> <review-result.json> <review-input-bundle.json>.');
      }
      evidence.push({
        id,
        resultPath: path.resolve(resultPath),
        bundlePath: path.resolve(bundlePath),
      });
    }
    else if (argv[index].startsWith('-')) throw new Error('Unknown option: ' + argv[index]);
    else positional.push(path.resolve(argv[index]));
  }
  if (positional.length !== 1 || !planPath || !pluginRoot || evidence.length === 0 || !['text', 'json'].includes(format)) {
    throw new Error('Usage: validate-aw-review-summary.mjs <summary.json> --plan <target-plan.json> --plugin-root <plugin-root> --evidence <id> <review-result.json> <review-input-bundle.json>... [--format text|json]');
  }
  return { summaryPath: positional[0], planPath, pluginRoot, evidence, format };
}

async function schemaErrors(valuePath, schemaName) {
  const schemaCandidates = [
    path.join(scriptRoot, '..', 'schemas', schemaName),
    path.join(scriptRoot, '..', 'assets', schemaName),
  ];
  let schemaPath;
  for (const candidate of schemaCandidates) {
    try { await readFile(candidate); schemaPath = candidate; break; } catch {}
  }
  if (!schemaPath) throw new Error('Cannot locate AWReviewSummary schema.');
  const validatorCandidates = [
    path.resolve(scriptRoot, '../../../../plugins/agent-skill-toolkit/scripts/validate-json-contract.mjs'),
  ];
  let validator;
  for (const candidate of validatorCandidates) {
    try { await readFile(candidate); validator = candidate; break; } catch {}
  }
  if (!validator) throw new Error('Cannot locate JSON contract validator.');
  try {
    const { stdout } = await execFileAsync(process.execPath, [validator, schemaPath, valuePath, '--format', 'json'], { encoding: 'utf8' });
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout).errors;
    throw error;
  }
}

function reviewTargetKey(target) {
  return JSON.stringify([target.kind, target.targetName, target.profile ?? null]);
}

async function canonicalPlanErrors(plan, pluginRoot) {
  const errors = [];
  let planTool = null;
  for (const candidate of [
    path.join(scriptRoot, 'prepare-aw-review-target-plan.mjs'),
    path.join(
      scriptRoot,
      '..',
      'skills',
      'review-aw-plugin',
      'scripts',
      'prepare-aw-review-target-plan.mjs',
    ),
  ]) {
    try {
      await readFile(candidate);
      planTool = candidate;
      break;
    } catch {}
  }
  if (!planTool) return ['Cannot locate AWReviewTargetPlan source inspector.'];
  let source;
  try {
    const { describeReviewPlanSource } = await import(pathToFileURL(planTool).href);
    source = await describeReviewPlanSource(pluginRoot);
  } catch (error) {
    return ['Cannot inspect the canonical plugin target universe: ' + error.message];
  }
  if (plan.plugin !== source.manifest.name) {
    errors.push('target plan plugin does not match the canonical plugin manifest');
  }
  const profiles = plan.releaseScope.profiles;
  if (plan.releaseScope.kind === 'all-supported') {
    if (JSON.stringify(profiles) !== JSON.stringify(source.supportedProfiles)) {
      errors.push('all-supported release scope must include every supported profile');
    }
  } else if (plan.releaseScope.kind === 'explicit') {
    if (profiles.length === 0) errors.push('explicit release scope requires at least one profile');
    for (const profile of profiles) {
      if (!source.supportedProfiles.includes(profile)) {
        errors.push('explicit release scope contains an unsupported profile ' + profile);
      }
    }
  } else if (profiles.length !== 0) {
    errors.push('source-only release scope cannot contain profiles');
  }
  if (plan.mode === 'release-quality' && plan.releaseScope.kind === 'source-only') {
    errors.push('release-quality target plan cannot use source-only scope');
  }

  const expected = new Map();
  for (const skill of source.sources) {
    expected.set(reviewTargetKey({
      kind: 'aw-plugin-skill',
      targetName: skill.name,
      profile: null,
    }), {
      id: `aw-plugin-skill:${skill.name}`,
      digest: skill.digest,
      status: 'present',
    });
    for (const profile of profiles) {
      expected.set(reviewTargetKey({
        kind: 'materialized-skill',
        targetName: skill.name,
        profile,
      }), {
        id: `materialized-skill:${skill.name}:${profile}`,
        digest: null,
        status: null,
      });
    }
  }
  const actual = new Map();
  for (const target of plan.expectedTargets) {
    const key = reviewTargetKey(target);
    if (actual.has(key)) errors.push('target plan contains duplicate expected target ' + key);
    actual.set(key, target);
    const canonical = expected.get(key);
    if (!canonical) {
      errors.push('target plan contains unexpected target ' + key);
      continue;
    }
    if (target.id !== canonical.id) errors.push('target plan target id is not canonical ' + key);
    if (canonical.digest !== null && target.digest !== canonical.digest) {
      errors.push('target plan source digest does not match the canonical Skill ' + key);
    }
    if (canonical.status !== null && target.status !== canonical.status) {
      errors.push('target plan source target must be present ' + key);
    }
    if ((target.status === 'present') !== (target.digest !== null)) {
      errors.push('target plan status and digest are inconsistent ' + key);
    }
  }
  for (const key of expected.keys()) {
    if (!actual.has(key)) errors.push('target plan omits canonical target ' + key);
  }
  return errors;
}

function planErrors(summary, plan, planContent, evidenceById) {
  const errors = [];
  const digest = 'sha256:' + createHash('sha256').update(planContent).digest('hex');
  if (summary.targetPlanDigest !== digest) errors.push('targetPlanDigest does not match plan content');
  if (
    summary.target.plugin !== plan.plugin
    || summary.target.sourceDigest !== plan.pluginSourceDigest
  ) {
    errors.push('summary target does not match the review target plan');
  }
  const expected = new Map(plan.expectedTargets.map((target) => [reviewTargetKey(target), target]));
  const actual = new Map();
  const evidenceDigests = new Map();
  for (const review of summary.genericReviews) {
    const key = reviewTargetKey(review);
    if (actual.has(key)) {
      errors.push('genericReviews contains duplicate target ' + key);
      continue;
    }
    actual.set(key, review);
    const target = expected.get(key);
    if (!target) {
      errors.push('genericReviews contains unexpected target ' + key);
      continue;
    }
    if (target.status !== 'present' || target.digest !== review.digest) {
      errors.push('generic review digest does not match expected target ' + key);
    }
    const previousDigest = evidenceDigests.get(review.reviewEvidenceId);
    if (previousDigest !== undefined && previousDigest !== review.digest) {
      errors.push('reviewEvidenceId cannot be reused across different target digests');
    }
    evidenceDigests.set(review.reviewEvidenceId, review.digest);
    const evidence = evidenceById.get(review.reviewEvidenceId);
    if (!evidence) {
      errors.push('generic review has no validated evidence ' + review.reviewEvidenceId);
    } else {
      evidence.used = true;
      if (evidence.result.target.digest !== review.digest) {
        errors.push('generic review digest does not match validated evidence ' + review.reviewEvidenceId);
      }
      if (
        evidence.result.design !== review.design
        || evidence.result.releaseReadiness !== review.releaseReadiness
      ) {
        errors.push('generic review decision does not match validated evidence ' + review.reviewEvidenceId);
      }
      if (evidence.result.mode !== plan.mode) {
        errors.push('generic review mode does not match target plan ' + review.reviewEvidenceId);
      }
    }
  }
  const missing = [...expected.entries()].filter(([key, target]) =>
    target.status !== 'present' || !actual.has(key));
  if (missing.length > 0 && summary.projectGates['profile-coverage'].status !== 'fail') {
    errors.push('profile-coverage must fail when expected review targets are missing');
  }
  for (const [id, evidence] of evidenceById) {
    if (!evidence.used) errors.push('validated review evidence is not used by genericReviews ' + id);
  }
  return errors;
}

async function validatedEvidence(entries) {
  const errors = [];
  const evidenceById = new Map();
  let validator = null;
  for (const candidate of [path.join(scriptRoot, 'validate-review-result.mjs')]) {
    try {
      await readFile(candidate);
      validator = candidate;
      break;
    } catch {}
  }
  if (!validator) return { errors: ['Cannot locate ReviewResult validator.'], evidenceById };
  for (const entry of entries) {
    if (evidenceById.has(entry.id)) {
      errors.push('duplicate review evidence id ' + entry.id);
      continue;
    }
    try {
      await execFileAsync(process.execPath, [
        validator,
        entry.resultPath,
        '--bundle',
        entry.bundlePath,
        '--format',
        'json',
      ], { encoding: 'utf8' });
      evidenceById.set(entry.id, {
        result: JSON.parse(await readFile(entry.resultPath, 'utf8')),
        used: false,
      });
    } catch (error) {
      const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
      errors.push('review evidence ' + entry.id + ' is invalid' + (stdout ? ': ' + stdout : ''));
    }
  }
  return { errors, evidenceById };
}

export function expectedAwDecision(summary) {
  const gates = Object.values(summary.projectGates);
  const generic = summary.genericReviews;
  const p0Failed = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P0');
  const p1Failed = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P1');
  const genericDesigns = generic.map((entry) => entry.design);
  const design = p0Failed || genericDesigns.includes('fail')
    ? 'fail'
    : genericDesigns.includes('redesign')
      ? 'redesign'
      : p1Failed || genericDesigns.includes('needs-fixes')
        ? 'needs-fixes'
        : genericDesigns.includes('not-assessed')
          ? 'not-assessed'
          : 'pass';
  const blocked = p0Failed || p1Failed || generic.some((entry) => entry.releaseReadiness === 'blocked') || ['fail', 'redesign'].includes(design);
  const provisional = gates.some((gate) => gate.status === 'unknown')
    || generic.some((entry) => ['provisional', 'not-assessed'].includes(entry.releaseReadiness))
    || (summary.evalAudit !== null && (summary.evalAudit.validity !== 'pass' || !summary.evalAudit.releaseEligible));
  return {
    design,
    releaseReadiness: blocked ? 'blocked' : provisional ? 'provisional' : 'ready',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = [
    ...(await schemaErrors(options.summaryPath, 'aw-review-summary.schema.json')),
    ...(await schemaErrors(options.planPath, 'aw-review-target-plan.schema.json')).map(
      (entry) => 'plan: ' + entry,
    ),
  ];
  const evidence = await validatedEvidence(options.evidence);
  errors.push(...evidence.errors);
  if (errors.length === 0) {
    const [summary, planContent] = await Promise.all([
      readFile(options.summaryPath, 'utf8').then(JSON.parse),
      readFile(options.planPath),
    ]);
    const plan = JSON.parse(planContent.toString('utf8'));
    errors.push(...await canonicalPlanErrors(plan, options.pluginRoot));
    errors.push(...planErrors(summary, plan, planContent, evidence.evidenceById));
    for (const [gateId, gate] of Object.entries(summary.projectGates)) {
      if (gate.status === 'fail' && gate.findingIds.length === 0) {
        errors.push('failed project gate ' + gateId + ' must reference a finding');
      }
    }
    const expected = expectedAwDecision(summary);
    if (summary.design !== expected.design) errors.push('design must be ' + expected.design + ' for the supplied generic reviews and project gates');
    if (summary.releaseReadiness !== expected.releaseReadiness) errors.push('releaseReadiness must be ' + expected.releaseReadiness + ' for the supplied evidence');
  }
  const output = { valid: errors.length === 0, errors };
  process.stdout.write(options.format === 'json' ? JSON.stringify(output, null, 2) + '\n' : output.valid ? 'AWReviewSummary is valid.\n' : errors.join('\n') + '\n');
  if (!output.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
