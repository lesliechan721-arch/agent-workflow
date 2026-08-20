#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return 'Usage: validate-review-input-bundle.mjs <bundle.json> [--handoff-root path] [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let handoffRoot = null;
  let format = 'text';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--handoff-root') handoffRoot = path.resolve(argv[++index] ?? '');
    else if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { bundlePath: positional[0], handoffRoot, format };
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

async function digest(filePath) {
  return `sha256:${createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')}`;
}

async function firstReadable(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next canonical or distributed copy.
    }
  }
  throw new Error('Cannot locate required schema.');
}

async function schemaErrors(schemaPath, valuePath) {
  const validator = path.join(scriptRoot, 'validate-json-contract.mjs');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [validator, schemaPath, valuePath, '--format', 'json'],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim())
      return JSON.parse(error.stdout).errors;
    throw error;
  }
}

const schemaByName = {
  EvalAuditResult: 'eval-audit-result.schema.json',
  ReferenceAuditResult: 'reference-audit-result.schema.json',
  ReviewResult: 'review-result.schema.json',
  EvalRunBundle: 'eval-run-bundle.schema.json',
};

function resultSubject(result) {
  return result.targetSkillDigest ?? result.target?.digest ?? result.targetDigest ?? null;
}

async function validateObject(schemaName, value, label, temporaryRoot) {
  const valuePath = path.join(temporaryRoot, `${label.replace(/[^A-Za-z0-9._-]/gu, '-')}.json`);
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', schemaName),
    path.join(scriptRoot, '..', 'assets', schemaName),
  ]);
  return (await schemaErrors(schemaPath, valuePath)).map((entry) => `${label}: ${entry}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const bundleSchema = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', 'review-input-bundle.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'review-input-bundle.schema.json'),
  ]);
  const errors = await schemaErrors(bundleSchema, options.bundlePath);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'review-bundle-validator-'));

  try {
    if (errors.length === 0) {
      const bundle = JSON.parse(await readFile(options.bundlePath, 'utf8'));
      const handoffRoot = await realpath(options.handoffRoot ?? path.dirname(options.bundlePath));
      const seen = new Set();
      const stageResults = new Map();

      for (const stage of bundle.orchestration.providedStages) {
        const key = [stage.id, stage.profile ?? '', stage.subjectDigest, stage.resultDigest].join(
          ':',
        );
        if (seen.has(key)) errors.push(`duplicate provided stage ${key}`);
        seen.add(key);

        const candidate = path.resolve(path.dirname(options.bundlePath), stage.resultPath);
        let actual;
        try {
          if ((await lstat(candidate)).isSymbolicLink()) throw new Error('symlink');
          actual = await realpath(candidate);
          if (!(await stat(actual)).isFile()) throw new Error('not a file');
        } catch {
          errors.push(`${stage.id} resultPath does not resolve to a regular file`);
          continue;
        }
        if (!isPathInside(handoffRoot, actual)) {
          errors.push(`${stage.id} resultPath leaves the handoff root`);
          continue;
        }
        if ((await digest(actual)) !== stage.resultDigest) {
          errors.push(`${stage.id} resultDigest does not match file content`);
        }

        const schemaName = schemaByName[stage.schema];
        const schemaPath = await firstReadable([
          path.join(scriptRoot, '..', 'schemas', schemaName),
          path.join(scriptRoot, '..', 'assets', schemaName),
        ]);
        errors.push(
          ...(await schemaErrors(schemaPath, actual)).map((entry) => `${stage.id}: ${entry}`),
        );

        let result;
        try {
          result = JSON.parse(await readFile(actual, 'utf8'));
        } catch {
          continue;
        }
        stageResults.set(stage.id, { stage, result });

        if (stage.id !== 'eval-execution' && stage.independentContext !== true) {
          errors.push(
            `${stage.id} provided review/audit stage must come from an independent context`,
          );
        }
        if (result.producer !== stage.producer)
          errors.push(`${stage.id} producer does not match result`);
        if (result.independentContext !== stage.independentContext) {
          errors.push(`${stage.id} independentContext does not match result`);
        }
        const subject = resultSubject(result);
        if (!subject) errors.push(`${stage.id} result does not expose a subject digest`);
        else if (subject !== stage.subjectDigest)
          errors.push(`${stage.id} subjectDigest does not match result target`);

        if (
          bundle.target.kind !== 'aw-plugin' &&
          stage.subjectDigest !== bundle.target.sourceDigest
        ) {
          errors.push(`${stage.id} subjectDigest does not match bundle target`);
        }
        const resultProfile = result.target?.profile ?? null;
        if (stage.profile !== null && resultProfile !== stage.profile) {
          errors.push(`${stage.id} profile does not match result target`);
        }
        if (
          bundle.target.kind !== 'aw-plugin' &&
          (stage.profile ?? null) !== (bundle.target.profile ?? null)
        ) {
          errors.push(`${stage.id} profile does not match bundle target`);
        }
      }

      if (bundle.evalAudit !== null) {
        errors.push(
          ...(await validateObject(
            'eval-audit-result.schema.json',
            bundle.evalAudit,
            'evalAudit',
            temporaryRoot,
          )),
        );
        if (
          bundle.target.kind !== 'aw-plugin' &&
          bundle.evalAudit.targetSkillDigest !== bundle.target.sourceDigest
        ) {
          errors.push('evalAudit targetSkillDigest does not match bundle target');
        }
      }

      const auditStage = stageResults.get('eval-audit');
      for (let index = 0; index < bundle.evalResults.length; index += 1) {
        const result = bundle.evalResults[index];
        errors.push(
          ...(await validateObject(
            'eval-run-bundle.schema.json',
            result,
            `evalResults-${index}`,
            temporaryRoot,
          )),
        );
        if (
          bundle.target.kind !== 'aw-plugin' &&
          result.targetSkillDigest !== bundle.target.sourceDigest
        ) {
          errors.push(`evalResults[${index}] targetSkillDigest does not match bundle target`);
        }
        if (bundle.evalAudit && result.caseCorpusDigest !== bundle.evalAudit.caseCorpusDigest) {
          errors.push(`evalResults[${index}] caseCorpusDigest does not match evalAudit`);
        }
        if (bundle.evalAudit && result.targetSkillDigest !== bundle.evalAudit.targetSkillDigest) {
          errors.push(`evalResults[${index}] targetSkillDigest does not match evalAudit`);
        }
        if (auditStage && result.preflightAuditDigest !== auditStage.stage.resultDigest) {
          errors.push(`evalResults[${index}] preflightAuditDigest does not match eval-audit stage`);
        }
      }
    }

    const output = { valid: errors.length === 0, errors };
    process.stdout.write(
      options.format === 'json'
        ? `${JSON.stringify(output, null, 2)}\n`
        : output.valid
          ? 'ReviewInputBundle is valid.\n'
          : `${errors.join('\n')}\n`,
    );
    if (!output.valid) process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exit(1);
});
