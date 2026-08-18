#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function evalCorpusDigest(casePaths) {
  const documents = await Promise.all(casePaths.map(async (casePath) => {
    const value = JSON.parse(await readFile(casePath, 'utf8'));
    return stable(value);
  }));
  documents.sort();
  return 'sha256:' + createHash('sha256').update(documents.join('\n')).digest('hex');
}

function parseArgs(argv) {
  const options = { cases: [], format: 'text', digestOnly: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--case') options.cases.push(path.resolve(argv[++index] ?? ''));
    else if (arg === '--format') options.format = argv[++index];
    else if (arg === '--digest-only') options.digestOnly = true;
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else positional.push(path.resolve(arg));
  }
  if (!['text', 'json'].includes(options.format)) throw new Error('--format must be text or json.');
  if (options.digestOnly) {
    if (positional.length > 0 || options.cases.length === 0) throw new Error('--digest-only requires one or more --case values.');
  } else if (positional.length !== 1) {
    throw new Error('Usage: validate-eval-audit-result.mjs <audit.json> [--case path] [--format text|json]');
  }
  return { ...options, auditPath: positional[0] };
}

async function schemaErrors(auditPath) {
  const validator = path.join(scriptRoot, 'validate-json-contract.mjs');
  const schemaCandidates = [
    path.join(scriptRoot, '..', 'schemas', 'eval-audit-result.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'eval-audit-result.schema.json'),
  ];
  let schemaPath;
  for (const candidate of schemaCandidates) {
    try { await readFile(candidate); schemaPath = candidate; break; } catch {}
  }
  if (!schemaPath) throw new Error('Cannot locate EvalAuditResult schema.');
  try {
    const { stdout } = await execFileAsync(process.execPath, [validator, schemaPath, auditPath, '--format', 'json'], { encoding: 'utf8' });
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout).errors;
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.digestOnly) {
    process.stdout.write(await evalCorpusDigest(options.cases) + '\n');
    return;
  }
  const errors = await schemaErrors(options.auditPath);
  let calculatedCorpusDigest = null;
  if (errors.length === 0) {
    const audit = JSON.parse(await readFile(options.auditPath, 'utf8'));
    const releaseCases = audit.cases.filter((entry) => entry.releaseRelevant);
    if (audit.mode === 'preflight' && audit.failureTriage.length > 0) errors.push('preflight audit must not contain failureTriage entries');
    if (audit.validity === 'pass') {
      if (!audit.independentContext) errors.push('validity=pass requires independentContext=true');
      if (audit.cases.length === 0) errors.push('validity=pass requires audited cases');
      if (releaseCases.some((entry) => entry.admission !== 'pass')) errors.push('validity=pass requires every release-relevant case to pass admission');
      if (audit.blockedCases.length > 0) errors.push('validity=pass requires no blocked cases');
    }
    if (audit.releaseEligible && (audit.validity !== 'pass' || releaseCases.length === 0)) {
      errors.push('releaseEligible=true requires a passing audit with release-relevant cases');
    }
    if (
      audit.recommendedAction === 'candidate-skill-fix'
      && !audit.failureTriage.some((entry) => entry.attribution === 'skill-defect')
    ) errors.push('candidate-skill-fix requires skill-defect triage evidence');
    if (options.cases.length > 0) {
      calculatedCorpusDigest = await evalCorpusDigest(options.cases);
      if (audit.corpusDigest !== calculatedCorpusDigest) errors.push('corpusDigest does not match the supplied Eval cases');
    }
  }
  const output = { valid: errors.length === 0, errors, calculatedCorpusDigest };
  process.stdout.write(options.format === 'json' ? JSON.stringify(output, null, 2) + '\n' : output.valid ? 'EvalAuditResult is valid.\n' : errors.join('\n') + '\n');
  if (!output.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
