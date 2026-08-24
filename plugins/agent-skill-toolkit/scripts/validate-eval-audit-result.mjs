#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateEvalRunBundle } from './validate-eval-run-bundle.mjs';
const execFileAsync = promisify(execFile),
  scriptRoot = path.dirname(fileURLToPath(import.meta.url));
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function evalCorpusDigest(casePaths) {
  const documents = await Promise.all(
    casePaths.map(async (casePath) => stable(JSON.parse(await readFile(casePath, 'utf8')))),
  );
  documents.sort();
  return 'sha256:' + createHash('sha256').update(documents.join('\n')).digest('hex');
}
function parseArgs(argv) {
  const options = { cases: [], format: 'text', digestOnly: false, targetSkillDigest: null, runBundle: null },
    positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--case') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--case requires a value.');
      options.cases.push(path.resolve(argv[++i]));
    } else if (arg === '--format') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--format requires a value.');
      options.format = argv[++i];
    } else if (arg === '--digest-only') options.digestOnly = true;
    else if (arg === '--target-skill-digest') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--target-skill-digest requires a value.');
      options.targetSkillDigest = argv[++i];
    } else if (arg === '--run-bundle') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('--run-bundle requires a value.');
      options.runBundle = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else positional.push(path.resolve(arg));
  }
  if (options.help) return options;
  if (!['text', 'json'].includes(options.format)) throw new Error('--format must be text or json.');
  if (options.digestOnly) {
    if (positional.length > 0 || options.cases.length === 0)
      throw new Error('--digest-only requires one or more --case values.');
  } else if (positional.length !== 1)
    throw new Error(
      'Usage: validate-eval-audit-result.mjs <audit.json> [--case path] [--target-skill-digest sha256:...] [--run-bundle bundle.json] [--format text|json]',
    );
  return { ...options, auditPath: positional[0] };
}
async function firstReadable(paths) {
  for (const candidate of paths) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Cannot locate EvalAuditResult schema.');
}
async function schemaErrors(auditPath) {
  const validator = path.join(scriptRoot, 'validate-json-contract.mjs'),
    schemaPath = await firstReadable([
      path.join(scriptRoot, '..', 'schemas', 'eval-audit-result.schema.json'),
      path.join(scriptRoot, '..', 'assets', 'eval-audit-result.schema.json'),
    ]);
  try {
    return JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [validator, schemaPath, auditPath, '--format', 'json'],
          { encoding: 'utf8' },
        )
      ).stdout,
    ).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim())
      return JSON.parse(error.stdout).errors;
    throw error;
  }
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      'Usage: validate-eval-audit-result.mjs <audit.json> [--case path] [--target-skill-digest sha256:...] [--run-bundle bundle.json] [--format text|json]\n',
    );
    return;
  }
  if (options.digestOnly) {
    process.stdout.write((await evalCorpusDigest(options.cases)) + '\n');
    return;
  }
  const errors = await schemaErrors(options.auditPath);
  let calculatedCaseCorpusDigest = null;
  let calculatedRunBundleDigest = null;
  if (errors.length === 0) {
    const audit = JSON.parse(await readFile(options.auditPath, 'utf8')),
      releaseCases = audit.cases.filter((entry) => entry.releaseRelevant);
    if (audit.mode === 'preflight' && audit.runBundleDigest !== null)
      errors.push('preflight audit requires runBundleDigest=null');
    if (
      audit.mode === 'result-triage' &&
      (typeof audit.runBundleDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(audit.runBundleDigest))
    )
      errors.push('result-triage audit requires a runBundleDigest');
    if (audit.mode === 'preflight' && audit.failureTriage.length > 0)
      errors.push('preflight audit must not contain failureTriage entries');
    if (audit.mode === 'preflight' && options.runBundle)
      errors.push('preflight audit must not be validated with --run-bundle');
    if (audit.mode === 'result-triage' && !options.runBundle)
      errors.push('result-triage audit requires --run-bundle');
    if (audit.validity === 'pass') {
      if (!audit.independentContext) errors.push('validity=pass requires independentContext=true');
      if (audit.cases.length === 0) errors.push('validity=pass requires audited cases');
      if (releaseCases.some((entry) => entry.admission !== 'pass'))
        errors.push('validity=pass requires every release-relevant case to pass admission');
      if (audit.blockedCases.length > 0) errors.push('validity=pass requires no blocked cases');
    }
    if (audit.releaseEligible && (audit.validity !== 'pass' || releaseCases.length === 0))
      errors.push('releaseEligible=true requires a passing audit with release-relevant cases');
    if (
      audit.recommendedAction === 'candidate-skill-fix' &&
      !audit.failureTriage.some((entry) => entry.attribution === 'skill-defect')
    )
      errors.push('candidate-skill-fix requires skill-defect triage evidence');
    if (options.cases.length > 0) {
      calculatedCaseCorpusDigest = await evalCorpusDigest(options.cases);
      if (audit.caseCorpusDigest !== calculatedCaseCorpusDigest)
        errors.push('caseCorpusDigest does not match the supplied Eval cases');
    }
    if (options.targetSkillDigest && audit.targetSkillDigest !== options.targetSkillDigest)
      errors.push('targetSkillDigest does not match the supplied Skill digest');
    if (audit.mode === 'result-triage' && options.runBundle) {
      const bundleValidation = await validateEvalRunBundle(options.runBundle);
      if (!bundleValidation.valid) {
        errors.push(...bundleValidation.errors.map((entry) => `run bundle: ${entry}`));
      } else {
        const bundle = JSON.parse(await readFile(options.runBundle, 'utf8'));
        calculatedRunBundleDigest = bundleValidation.calculated.bundleDigest;
        if (audit.runBundleDigest !== calculatedRunBundleDigest)
          errors.push('runBundleDigest does not match the supplied EvalRunBundle bytes');
        if (audit.targetSkillDigest !== bundle.targetSkillDigest)
          errors.push('targetSkillDigest does not match the supplied EvalRunBundle');
        if (audit.caseCorpusDigest !== bundle.caseCorpusDigest)
          errors.push('caseCorpusDigest does not match the supplied EvalRunBundle');
      }
    }
  }
  const output = {
    valid: errors.length === 0,
    errors,
    calculatedCaseCorpusDigest,
    calculatedRunBundleDigest,
  };
  process.stdout.write(
    options.format === 'json'
      ? JSON.stringify(output, null, 2) + '\n'
      : output.valid
        ? 'EvalAuditResult is valid.\n'
        : errors.join('\n') + '\n',
  );
  if (!output.valid) process.exitCode = 1;
}
main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
