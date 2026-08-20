#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isPathInside, pathsOverlap, runtimeSkillDigest } from './lib/runtime-skill.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return 'Usage: validate-eval-execution-plan.mjs <plan.json> [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let format = 'text';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { planPath: positional[0], format };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function safeSegment(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function casesFrom(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document.cases)) return document.cases;
  if (Array.isArray(document.evals)) return document.evals;
  throw new Error('case document must be an array or contain cases/evals');
}

async function fileDigest(filePath) {
  return sha256(await readFile(filePath));
}

async function caseDigest(paths) {
  const documents = await Promise.all(paths.map(async (filePath) => stable(JSON.parse(await readFile(filePath, 'utf8')))));
  documents.sort();
  return sha256(documents.join('\n'));
}

async function schemaErrors(schemaPath, valuePath) {
  const validator = path.join(root, 'scripts', 'validate-json-contract.mjs');
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [validator, schemaPath, valuePath, '--format', 'json'],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout).errors;
    throw error;
  }
}

export async function validatePlan(planPath) {
  const errors = await schemaErrors(path.join(root, 'schemas', 'eval-execution-plan.schema.json'), planPath);
  const calculated = {
    targetSkillDigest: null,
    caseCorpusDigest: null,
    auditDigest: null,
    capabilitiesDigest: null,
  };

  if (errors.length === 0) {
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const base = path.dirname(planPath);
    const target = path.resolve(base, plan.target.path);
    const casePaths = plan.cases.paths.map((entry) => path.resolve(base, entry));
    const auditPath = path.resolve(base, plan.audit.path);
    const capabilitiesPath = path.resolve(base, plan.provider.capabilitiesPath);
    const outputRoot = path.resolve(base, plan.outputRoot);
    const evalTypes = new Set();
    let capabilities = null;
    let canonicalTarget = null;

    if (!isPathInside(base, outputRoot) || outputRoot === base) {
      errors.push('outputRoot must be a non-root child path inside the plan directory');
    }
    if (new Set(plan.configurations.map((entry) => entry.id)).size !== plan.configurations.length) {
      errors.push('configuration ids must be unique');
    }
    if (plan.configurations.some((entry) => !safeSegment(entry.id))) {
      errors.push('configuration ids must be safe path segments');
    }

    try {
      const actual = await realpath(capabilitiesPath);
      if (!isPathInside(base, actual)) throw new Error('capabilities path leaves the plan directory');
      calculated.capabilitiesDigest = await fileDigest(actual);
      const capabilityErrors = await schemaErrors(path.join(root, 'schemas', 'eval-runtime-capabilities.schema.json'), actual);
      errors.push(...capabilityErrors.map((value) => `capabilities: ${value}`));
      capabilities = JSON.parse(await readFile(actual, 'utf8'));
      if (capabilities.provider !== plan.provider.id) errors.push('provider id does not match capability document');
      for (const configuration of plan.configurations) {
        if (configuration.skillMode === 'with-skill' && !capabilities.capabilities.skillPathExecution) {
          errors.push('provider does not support with-skill execution');
        }
        if (configuration.skillMode === 'without-skill' && !capabilities.capabilities.withoutSkillBaseline) {
          errors.push('provider does not support without-skill baseline');
        }
        if (configuration.skillMode === 'previous-version' && !capabilities.capabilities.previousVersionBaseline) {
          errors.push('provider does not support previous-version baseline');
        }
      }
      if (plan.capture.outputs !== true) errors.push('capture.outputs must be true for portable evidence');
      if (plan.capture.timing !== true) errors.push('capture.timing must be true for portable evidence');
      if (plan.capture.trace && !capabilities.capabilities.toolTrace) errors.push('provider does not support requested tool trace capture');
      if (plan.capture.usage && !capabilities.capabilities.tokenUsage) errors.push('provider does not support requested token usage capture');
    } catch (error) {
      errors.push(`provider capabilities are unavailable or invalid: ${error.message}`);
    }

    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('symlink');
      canonicalTarget = await realpath(target);
      calculated.targetSkillDigest = await runtimeSkillDigest(canonicalTarget);
      if (pathsOverlap(canonicalTarget, outputRoot)) {
        errors.push('outputRoot must not overlap the target Skill tree');
      }
    } catch (error) {
      errors.push(`target path is unavailable or unsafe: ${error.message}`);
    }

    const caseIds = new Set();
    try {
      for (const casePath of casePaths) {
        const actual = await realpath(casePath);
        if (!isPathInside(base, actual)) throw new Error('case path leaves the plan directory');
        const document = JSON.parse(await readFile(actual, 'utf8'));
        for (const evalCase of casesFrom(document)) {
          const id = String(evalCase.id ?? '');
          if (!safeSegment(id) || caseIds.has(id)) throw new Error('case ids must be unique safe path segments');
          caseIds.add(id);
          evalTypes.add(evalCase.eval_type ?? evalCase.type ?? 'unknown');
        }
      }
      calculated.caseCorpusDigest = await caseDigest(casePaths);
      if (evalTypes.has('trigger') && capabilities && !capabilities.capabilities.triggerDiscovery) {
        errors.push('provider does not support trigger discovery');
      }
    } catch (error) {
      errors.push(`case corpus is unavailable or invalid: ${error.message}`);
    }

    try {
      const actual = await realpath(auditPath);
      if (!isPathInside(base, actual)) throw new Error('audit path leaves the plan directory');
      calculated.auditDigest = await fileDigest(actual);
      const auditErrors = await schemaErrors(path.join(root, 'schemas', 'eval-audit-result.schema.json'), actual);
      errors.push(...auditErrors.map((value) => `audit: ${value}`));
      const audit = JSON.parse(await readFile(actual, 'utf8'));
      if (audit.validity !== 'pass') errors.push('audit validity must be pass');
      if (audit.targetSkillDigest !== plan.audit.targetSkillDigest || audit.targetSkillDigest !== plan.target.digest) {
        errors.push('audit targetSkillDigest does not bind the plan target');
      }
      if (audit.caseCorpusDigest !== plan.audit.caseCorpusDigest || audit.caseCorpusDigest !== plan.cases.corpusDigest) {
        errors.push('audit caseCorpusDigest does not bind the plan corpus');
      }
    } catch (error) {
      errors.push(`audit is unavailable or invalid: ${error.message}`);
    }

    if (calculated.targetSkillDigest && calculated.targetSkillDigest !== plan.target.digest) {
      errors.push('target digest does not match target content');
    }
    if (calculated.caseCorpusDigest && calculated.caseCorpusDigest !== plan.cases.corpusDigest) {
      errors.push('case corpus digest does not match case documents');
    }
    if (calculated.auditDigest && calculated.auditDigest !== plan.audit.digest) {
      errors.push('audit digest does not match audit document');
    }
    if (calculated.capabilitiesDigest && calculated.capabilitiesDigest !== plan.provider.capabilitiesDigest) {
      errors.push('capabilitiesDigest does not match capability document');
    }
    if (plan.provider.command.length === 0 || plan.provider.command.some((value) => typeof value !== 'string' || value.length === 0 || value.includes('\0'))) {
      errors.push('provider command contains invalid argv');
    }
    if (plan.provider.cwd !== null) {
      const providerCwd = path.resolve(base, plan.provider.cwd);
      if (!isPathInside(base, providerCwd)) errors.push('provider cwd must stay inside the plan directory');
      if (canonicalTarget && isPathInside(canonicalTarget, providerCwd)) {
        errors.push('provider cwd must not be inside the target Skill tree');
      }
    }
  }

  return { valid: errors.length === 0, errors, calculated };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await validatePlan(options.planPath);
  process.stdout.write(options.format === 'json'
    ? `${JSON.stringify(result, null, 2)}\n`
    : result.valid ? 'EvalExecutionPlan is valid.\n' : `${result.errors.join('\n')}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exit(1);
  });
}
