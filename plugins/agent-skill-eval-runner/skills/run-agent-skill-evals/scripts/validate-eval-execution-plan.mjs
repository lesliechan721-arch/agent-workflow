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
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
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
  const documents = await Promise.all(
    paths.map(async (filePath) => stable(JSON.parse(await readFile(filePath, 'utf8')))),
  );
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
    if (typeof error?.stdout === 'string' && error.stdout.trim())
      return JSON.parse(error.stdout).errors;
    throw error;
  }
}

export async function validatePlan(planPath) {
  const errors = await schemaErrors(
    path.join(root, 'assets', 'eval-execution-plan.schema.json'),
    planPath,
  );
  const calculated = {
    targetSkillDigest: null,
    caseCorpusDigest: null,
    auditDigest: null,
    capabilitiesDigest: null,
    configurationSkillDigests: {},
  };

  if (errors.length === 0) {
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const base = await realpath(path.dirname(planPath));
    const target = path.resolve(base, plan.target.path);
    const casePaths = plan.cases.paths.map((entry) => path.resolve(base, entry));
    const auditPath = path.resolve(base, plan.audit.path);
    const capabilitiesPath = path.resolve(base, plan.provider.capabilitiesPath);
    const outputRoot = path.resolve(base, plan.outputRoot);
    const evalTypes = new Set();
    let capabilities = null;
    let canonicalTarget = null;
    const configurationRoots = new Map();

    if (!isPathInside(base, outputRoot) || outputRoot === base)
      errors.push('outputRoot must be a non-root child path inside the plan directory');
    if (new Set(plan.configurations.map((entry) => entry.id)).size !== plan.configurations.length)
      errors.push('configuration ids must be unique');
    if (plan.configurations.some((entry) => !safeSegment(entry.id)))
      errors.push('configuration ids must be safe path segments');
    const comparisonGroups = new Map();
    for (const configuration of plan.configurations) {
      if (configuration.comparisonId === null) continue;
      if (!comparisonGroups.has(configuration.comparisonId))
        comparisonGroups.set(configuration.comparisonId, []);
      comparisonGroups.get(configuration.comparisonId).push(configuration);
    }
    for (const [comparisonId, configurations] of comparisonGroups) {
      if (!configurations.some((entry) => entry.skillMode === 'with-skill'))
        errors.push(`${comparisonId} comparison requires a with-skill configuration`);
      if (!configurations.some((entry) => entry.skillMode !== 'with-skill'))
        errors.push(`${comparisonId} comparison requires a baseline configuration`);
    }

    try {
      const actual = await realpath(capabilitiesPath);
      if (!isPathInside(base, actual))
        throw new Error('capabilities path leaves the plan directory');
      calculated.capabilitiesDigest = await fileDigest(actual);
      const capabilityErrors = await schemaErrors(
        path.join(root, 'assets', 'eval-runtime-capabilities.schema.json'),
        actual,
      );
      errors.push(...capabilityErrors.map((value) => `capabilities: ${value}`));
      capabilities = JSON.parse(await readFile(actual, 'utf8'));
      if (capabilities.provider !== plan.provider.id)
        errors.push('provider id does not match capability document');
      for (const configuration of plan.configurations) {
        if (
          configuration.skillMode === 'with-skill' &&
          !capabilities.capabilities.skillPathExecution
        )
          errors.push('provider does not support with-skill execution');
        if (
          configuration.skillMode === 'without-skill' &&
          !capabilities.capabilities.withoutSkillBaseline
        )
          errors.push('provider does not support without-skill baseline');
        if (
          configuration.skillMode === 'previous-version' &&
          !capabilities.capabilities.previousVersionBaseline
        )
          errors.push('provider does not support previous-version baseline');
      }
      if (plan.capture.outputs !== true)
        errors.push('capture.outputs must be true for portable evidence');
      if (plan.capture.timing !== true)
        errors.push('capture.timing must be true for portable evidence');
      if (plan.capture.trace && !capabilities.capabilities.toolTrace)
        errors.push('provider does not support requested tool trace capture');
      if (plan.capture.usage && !capabilities.capabilities.tokenUsage)
        errors.push('provider does not support requested token usage capture');
    } catch (error) {
      errors.push(`provider capabilities are unavailable or invalid: ${error.message}`);
    }

    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('symlink');
      canonicalTarget = await realpath(target);
      calculated.targetSkillDigest = await runtimeSkillDigest(canonicalTarget);
      if (pathsOverlap(canonicalTarget, outputRoot))
        errors.push('outputRoot must not overlap the target Skill tree');
      configurationRoots.set('with-skill', canonicalTarget);
    } catch (error) {
      errors.push(`target path is unavailable or unsafe: ${error.message}`);
    }

    for (const configuration of plan.configurations) {
      if (configuration.skillMode === 'with-skill' || configuration.skillMode === 'without-skill') {
        if (configuration.skillPath !== undefined && configuration.skillPath !== null)
          errors.push(`${configuration.id} must not set skillPath for ${configuration.skillMode}`);
        if (configuration.skillDigest !== undefined && configuration.skillDigest !== null)
          errors.push(
            `${configuration.id} must not set skillDigest for ${configuration.skillMode}`,
          );
        calculated.configurationSkillDigests[configuration.id] =
          configuration.skillMode === 'with-skill' ? calculated.targetSkillDigest : null;
        continue;
      }
      if (!configuration.skillPath || !configuration.skillDigest) {
        errors.push(`${configuration.id} previous-version requires skillPath and skillDigest`);
        continue;
      }
      try {
        const previousPath = path.resolve(base, configuration.skillPath);
        if ((await lstat(previousPath)).isSymbolicLink()) throw new Error('symlink');
        const canonicalPrevious = await realpath(previousPath);
        if (!isPathInside(base, canonicalPrevious))
          throw new Error('previous-version path leaves the plan directory');
        if (pathsOverlap(canonicalPrevious, outputRoot))
          throw new Error('previous-version path overlaps outputRoot');
        const previousDigest = await runtimeSkillDigest(canonicalPrevious);
        calculated.configurationSkillDigests[configuration.id] = previousDigest;
        configurationRoots.set(configuration.id, canonicalPrevious);
        if (previousDigest !== configuration.skillDigest)
          errors.push(`${configuration.id} skillDigest does not match previous-version content`);
      } catch (error) {
        errors.push(
          `${configuration.id} previous-version path is unavailable or unsafe: ${error.message}`,
        );
      }
    }

    const caseIds = new Set();
    try {
      for (const casePath of casePaths) {
        const actual = await realpath(casePath);
        if (!isPathInside(base, actual)) throw new Error('case path leaves the plan directory');
        const document = JSON.parse(await readFile(actual, 'utf8'));
        for (const evalCase of casesFrom(document)) {
          const id = String(evalCase.id ?? '');
          if (!safeSegment(id) || caseIds.has(id))
            throw new Error('case ids must be unique safe path segments');
          caseIds.add(id);
          evalTypes.add(evalCase.eval_type ?? evalCase.type ?? 'unknown');
        }
      }
      if (caseIds.size === 0) throw new Error('case corpus must contain at least one case');
      calculated.caseCorpusDigest = await caseDigest(casePaths);
      if (evalTypes.has('trigger') && capabilities && !capabilities.capabilities.triggerDiscovery)
        errors.push('provider does not support trigger discovery');
    } catch (error) {
      errors.push(`case corpus is unavailable or invalid: ${error.message}`);
    }

    try {
      const actual = await realpath(auditPath);
      if (!isPathInside(base, actual)) throw new Error('audit path leaves the plan directory');
      calculated.auditDigest = await fileDigest(actual);
      const auditErrors = await schemaErrors(
        path.join(root, 'assets', 'eval-audit-result.schema.json'),
        actual,
      );
      errors.push(...auditErrors.map((value) => `audit: ${value}`));
      const audit = JSON.parse(await readFile(actual, 'utf8'));
      if (audit.validity !== 'pass') errors.push('audit validity must be pass');
      if (audit.mode !== 'preflight') errors.push('plan requires a preflight audit');
      if (!audit.independentContext)
        errors.push('audit validity=pass requires independentContext=true');
      if (audit.failureTriage.length > 0)
        errors.push('preflight audit must not contain failureTriage entries');
      if (audit.cases.length === 0) errors.push('audit validity=pass requires audited cases');
      const auditCases = new Map();
      for (const entry of audit.cases) {
        if (auditCases.has(entry.caseId)) errors.push(`audit case ${entry.caseId} is duplicated`);
        auditCases.set(entry.caseId, entry);
      }
      for (const caseId of caseIds) {
        if (auditCases.get(caseId)?.admission !== 'pass')
          errors.push(`plan case ${caseId} requires passing audit admission`);
      }
      if (
        audit.cases.some((entry) => entry.releaseRelevant && entry.admission !== 'pass')
      )
        errors.push('audit validity=pass requires every release-relevant case to pass admission');
      if (audit.blockedCases.length > 0)
        errors.push('audit validity=pass requires no blocked cases');
      if (
        audit.releaseEligible &&
        !audit.cases.some((entry) => entry.releaseRelevant)
      )
        errors.push('releaseEligible=true requires release-relevant cases');
      if (
        audit.recommendedAction === 'candidate-skill-fix' &&
        !audit.failureTriage.some((entry) => entry.attribution === 'skill-defect')
      )
        errors.push('candidate-skill-fix requires skill-defect triage evidence');
      if (
        audit.targetSkillDigest !== plan.audit.targetSkillDigest ||
        audit.targetSkillDigest !== plan.target.digest
      )
        errors.push('audit targetSkillDigest does not bind the plan target');
      if (
        audit.caseCorpusDigest !== plan.audit.caseCorpusDigest ||
        audit.caseCorpusDigest !== plan.cases.corpusDigest
      )
        errors.push('audit caseCorpusDigest does not bind the plan corpus');
    } catch (error) {
      errors.push(`audit is unavailable or invalid: ${error.message}`);
    }

    if (calculated.targetSkillDigest && calculated.targetSkillDigest !== plan.target.digest)
      errors.push('target digest does not match target content');
    if (calculated.caseCorpusDigest && calculated.caseCorpusDigest !== plan.cases.corpusDigest)
      errors.push('case corpus digest does not match case documents');
    if (calculated.auditDigest && calculated.auditDigest !== plan.audit.digest)
      errors.push('audit digest does not match audit document');
    if (
      calculated.capabilitiesDigest &&
      calculated.capabilitiesDigest !== plan.provider.capabilitiesDigest
    )
      errors.push('capabilitiesDigest does not match capability document');
    if (
      plan.provider.command.length === 0 ||
      plan.provider.command.some(
        (value) => typeof value !== 'string' || value.length === 0 || value.includes('\0'),
      )
    )
      errors.push('provider command contains invalid argv');
    if (plan.provider.cwd !== null) {
      const providerCwd = path.resolve(base, plan.provider.cwd);
      if (!isPathInside(base, providerCwd))
        errors.push('provider cwd must stay inside the plan directory');
      for (const [configurationId, skillRoot] of configurationRoots) {
        if (pathsOverlap(skillRoot, providerCwd))
          errors.push(`provider cwd must not overlap ${configurationId} Skill content`);
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
  process.stdout.write(
    options.format === 'json'
      ? `${JSON.stringify(result, null, 2)}\n`
      : result.valid
        ? 'EvalExecutionPlan is valid.\n'
        : `${result.errors.join('\n')}\n`,
  );
  if (!result.valid) process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exit(1);
  });
}
