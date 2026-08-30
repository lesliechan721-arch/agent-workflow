#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateEvalRunBundle } from './validate-eval-run-bundle.mjs';
import { computeCaseCorpusDigest } from './corpus-digest.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function usage() {
  return 'Usage: validate-eval-audit-result.mjs <audit.json> [--plan <plan.json>] [--run-bundle <bundle.json>] [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const positional = [];
  let format = 'text';
  let planPath = null;
  let runBundle = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const nextValue = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) throw new Error(`${value} requires a value.`);
      index += 1;
      return next;
    };
    if (value === '--format') format = nextValue();
    else if (value === '--plan') planPath = path.resolve(nextValue());
    else if (value === '--run-bundle') runBundle = path.resolve(nextValue());
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { auditPath: positional[0], format, planPath, runBundle };
}

async function firstReadable(paths) {
  for (const candidate of paths) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the distributed canonical schema.
    }
  }
  throw new Error('Cannot locate EvalAuditResult schema.');
}

async function schemaErrors(auditPath) {
  const validator = path.join(scriptRoot, 'validate-json-contract.mjs');
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'assets', 'eval-audit-result.schema.json'),
  ]);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [validator, schemaPath, auditPath, '--format', 'json'],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      return JSON.parse(error.stdout).errors;
    }
    throw error;
  }
}

async function validatePlan(planPath) {
  try {
    const { stdout } = await execFileAsync(
      'aw-skill-eval',
      ['plan', 'validate', planPath],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      const result = JSON.parse(error.stdout);
      return {
        ...result,
        valid: false,
        errors: [...(result.errors ?? []), 'canonical plan validator exited with a non-zero status'],
      };
    }
    throw error;
  }
}

function casesFrom(document) {
  if (Array.isArray(document)) return document;
  if (document && typeof document === 'object') {
    if (Array.isArray(document.cases)) return document.cases;
    if (Array.isArray(document.evals)) return document.evals;
  }
  throw new Error('case document must be an array or contain cases/evals');
}

async function validatedPlanEvidence(planPath, errors) {
  const planRawBeforeValidation = await readFile(planPath, 'utf8');
  const validation = await validatePlan(planPath);
  if (validation.valid !== true) {
    errors.push(...(validation.errors ?? ['canonical plan validation failed'])
      .map((entry) => `plan: ${entry}`));
    return null;
  }
  const calculated = validation.calculated;
  if (
    !calculated
    || !DIGEST.test(calculated.targetSkillDigest ?? '')
    || !DIGEST.test(calculated.caseCorpusDigest ?? '')
    || !DIGEST.test(calculated.capabilitiesDigest ?? '')
    || !calculated.runtimeInputDigests
    || typeof calculated.runtimeInputDigests !== 'object'
    || !calculated.configurationSkillDigests
    || typeof calculated.configurationSkillDigests !== 'object'
  ) {
    errors.push('canonical plan validation did not return complete calculated digests');
    return null;
  }
  const planRaw = await readFile(planPath, 'utf8');
  if (planRaw !== planRawBeforeValidation) {
    errors.push('plan bytes changed during canonical validation');
    return null;
  }
  const plan = JSON.parse(planRaw);
  if (plan.target?.digest !== calculated.targetSkillDigest) {
    errors.push('plan target digest does not match the recomputed target Skill digest');
  }
  if (plan.cases?.corpusDigest !== calculated.caseCorpusDigest) {
    errors.push('plan corpus digest does not match the recomputed case corpus digest');
  }
  if (plan.provider?.capabilitiesDigest !== calculated.capabilitiesDigest) {
    errors.push('plan capabilities digest does not match the recomputed provider capabilities digest');
  }
  for (const runtimeInput of plan.runtimeInputs ?? []) {
    if (!DIGEST.test(calculated.runtimeInputDigests[runtimeInput.id] ?? '')) {
      errors.push(`runtime input ${runtimeInput.id} did not produce a calculated digest`);
    }
  }
  const selectedCaseIds = [];
  const casePaths = [];
  for (const relativePath of plan.cases?.paths ?? []) {
    const casePath = path.resolve(path.dirname(planPath), relativePath);
    casePaths.push(casePath);
    const document = JSON.parse(await readFile(casePath, 'utf8'));
    for (const entry of casesFrom(document)) selectedCaseIds.push(String(entry.id ?? ''));
  }
  if (selectedCaseIds.some((caseId) => caseId.length === 0)) {
    errors.push('selected plan cases must have non-empty IDs');
  }
  if (new Set(selectedCaseIds).size !== selectedCaseIds.length) {
    errors.push('selected plan cases must have unique IDs');
  }
  const recomputedCaseCorpusDigest = await computeCaseCorpusDigest(casePaths);
  if (
    recomputedCaseCorpusDigest !== plan.cases.corpusDigest
    || recomputedCaseCorpusDigest !== calculated.caseCorpusDigest
  ) {
    errors.push('case corpus digest changed after canonical plan validation');
  }
  const skillDigests = new Set([calculated.targetSkillDigest]);
  for (const configuration of plan.configurations ?? []) {
    if (!['with-skill', 'previous-version'].includes(configuration.skillMode)) continue;
    const digest = calculated.configurationSkillDigests[configuration.id];
    if (!DIGEST.test(digest ?? '')) {
      errors.push(`configuration ${configuration.id} did not produce a current or previous Skill digest`);
    } else {
      skillDigests.add(digest);
    }
  }
  return {
    calculated,
    selectedCaseIds: [...selectedCaseIds].sort(),
    skillDigests,
  };
}

function validatePassingAdmission(audit, planEvidence, errors) {
  if (!audit.independentContext) errors.push('validity=pass requires independentContext=true');
  if (audit.blockedCases.length > 0) errors.push('validity=pass requires no blocked cases');
  if (!planEvidence) {
    errors.push('validity=pass requires a canonically validated --plan');
    return;
  }
  if (!planEvidence.skillDigests.has(audit.targetSkillDigest)) {
    errors.push('targetSkillDigest does not match a distinct current or previous Skill in the plan');
  }
  if (audit.caseCorpusDigest !== planEvidence.calculated.caseCorpusDigest) {
    errors.push('caseCorpusDigest does not match the validated plan corpus');
  }
  const auditCaseIds = audit.cases.map((entry) => entry.caseId);
  if (new Set(auditCaseIds).size !== auditCaseIds.length) {
    errors.push('validity=pass requires unique case admissions');
  }
  if (JSON.stringify([...auditCaseIds].sort()) !== JSON.stringify(planEvidence.selectedCaseIds)) {
    errors.push('validity=pass requires exact admission coverage of selected plan cases');
  }
  if (audit.cases.some((entry) => entry.admission !== 'pass')) {
    errors.push('validity=pass requires every selected case admission to pass');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const errors = await schemaErrors(options.auditPath);
  let calculatedRunBundleDigest = null;
  let planEvidence = null;
  if (errors.length === 0) {
    const audit = JSON.parse(await readFile(options.auditPath, 'utf8'));
    if (audit.mode === 'preflight' && options.runBundle) {
      errors.push('preflight audit must not be validated with --run-bundle');
    }
    if (audit.mode === 'preflight' && audit.runBundleDigest !== null) {
      errors.push('preflight audit requires runBundleDigest=null');
    }
    if (audit.mode === 'result-triage' && !options.runBundle) {
      errors.push('result-triage audit validation requires --run-bundle');
    }
    if (audit.mode === 'preflight' && audit.failureTriage.length > 0) {
      errors.push('preflight audit must not contain failureTriage entries');
    }
    if (options.planPath) planEvidence = await validatedPlanEvidence(options.planPath, errors);
    if (audit.validity === 'pass' && audit.mode === 'preflight') {
      validatePassingAdmission(audit, planEvidence, errors);
    }
    if (audit.validity === 'pass' && audit.mode === 'result-triage') {
      if (!audit.independentContext) errors.push('validity=pass requires independentContext=true');
      if (audit.blockedCases.length > 0) errors.push('validity=pass requires no blocked cases');
    }
    if (audit.releaseEligible && audit.validity !== 'pass') {
      errors.push('releaseEligible=true requires validity=pass');
    }
    if (
      audit.recommendedAction === 'candidate-skill-fix'
      && !audit.failureTriage.some((entry) => entry.attribution === 'skill-defect')
    ) {
      errors.push('candidate-skill-fix requires skill-defect triage evidence');
    }
    if (audit.mode === 'result-triage' && options.runBundle) {
      const bundleValidation = await validateEvalRunBundle(options.runBundle);
      if (!bundleValidation.valid) {
        errors.push(...bundleValidation.errors.map((entry) => `run bundle: ${entry}`));
      } else {
        const bundle = JSON.parse(await readFile(options.runBundle, 'utf8'));
        calculatedRunBundleDigest = bundleValidation.calculated.bundleDigest;
        if (audit.runBundleDigest !== calculatedRunBundleDigest) {
          errors.push('runBundleDigest does not match the supplied EvalRunBundle v4 bytes');
        }
        if (audit.targetSkillDigest !== bundle.targetSkillDigest) {
          errors.push('targetSkillDigest does not match the supplied EvalRunBundle');
        }
        if (audit.caseCorpusDigest !== bundle.caseCorpusDigest) {
          errors.push('caseCorpusDigest does not match the supplied EvalRunBundle');
        }
        if (audit.validity === 'pass') {
          const auditCaseIds = audit.cases.map((entry) => entry.caseId);
          const bundleCaseIds = [...new Set(bundle.runs.map((entry) => entry.caseId))].sort();
          if (
            new Set(auditCaseIds).size !== auditCaseIds.length
            || JSON.stringify([...auditCaseIds].sort()) !== JSON.stringify(bundleCaseIds)
          ) {
            errors.push('validity=pass requires exact admission coverage of EvalRunBundle cases');
          }
          if (audit.cases.some((entry) => entry.admission !== 'pass')) {
            errors.push('validity=pass requires every executed case admission to pass');
          }
        }
        if (bundle.evidenceRequirement?.satisfied === false) {
          if (audit.releaseEligible) {
            errors.push('releaseEligible=true requires the EvalRunBundle evidence requirement to be satisfied');
          }
          if (!['collect-more-data', 'runtime-issue'].includes(audit.recommendedAction)) {
            errors.push('an unmet EvalRunBundle evidence requirement requires recommendedAction=collect-more-data or runtime-issue');
          }
          if (audit.failureTriage.some((entry) => entry.action === 'candidate-skill-fix')) {
            errors.push('an unmet EvalRunBundle evidence requirement forbids candidate-skill-fix triage actions');
          }
        }
      }
    }
  }
  const output = {
    valid: errors.length === 0,
    errors,
    calculatedPlan: planEvidence?.calculated ?? null,
    selectedCaseIds: planEvidence?.selectedCaseIds ?? null,
    calculatedRunBundleDigest,
  };
  process.stdout.write(
    options.format === 'json'
      ? `${JSON.stringify(output, null, 2)}\n`
      : output.valid
        ? 'EvalAuditResult is valid.\n'
        : `${errors.join('\n')}\n`,
  );
  if (!output.valid) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() =>
  path.resolve(fileURLToPath(import.meta.url)),
);
if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exit(1);
  });
}
