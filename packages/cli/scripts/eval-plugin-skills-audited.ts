import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  computeSkillDigest,
  getSchema,
  validateJsonSchema,
} from '@lesliechan721/agent-skill-eval';

import {
  readPluginEvalManifest,
  resolvePluginSkillAuthorRoot,
  type PluginEvalSuite,
} from './plugin-eval-contract.js';
import {
  runPluginEvals,
  type PluginEvalRunnerOptions,
} from './eval-plugin-skills.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';

const REPO_ROOT_ENV = 'AW_PLUGIN_EVAL_REPO_ROOT';

interface GateArguments {
  forwarded: string[];
  auditPaths: string[];
  help: boolean;
  executionPlan: boolean;
  materializeOnly: boolean;
  pluginName: string | null;
  skillName: string | null;
  suiteId: string | null;
  split: string | null;
  caseId: string | null;
}

interface AuditCase {
  caseId: string;
  admission: 'pass' | 'unknown' | 'fail';
}

interface EvalAuditResult {
  schemaVersion: 3;
  producer: 'audit-agent-skill-evals';
  independentContext: boolean;
  mode: 'preflight' | 'result-triage';
  targetSkillDigest: string;
  caseCorpusDigest: string;
  runBundleDigest: string | null;
  validity: 'pass' | 'unknown' | 'fail';
  cases: AuditCase[];
  blockedCases: string[];
  failureTriage: unknown[];
}

export interface AuditedPluginEvalOptions extends PluginEvalRunnerOptions {
  delegate?: typeof runPluginEvals;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export async function computeAuditCaseCorpusDigest(casePaths: string[]): Promise<string> {
  const documents = await Promise.all(
    casePaths.map(async (casePath) => stable(JSON.parse(await readFile(casePath, 'utf8')))),
  );
  return sha256(documents.sort().join('\n'));
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseGateArguments(args: string[]): GateArguments {
  const forwarded: string[] = [];
  const auditPaths: string[] = [];
  const positional: string[] = [];
  let help = false;
  let executionPlan = false;
  let materializeOnly = false;
  let skillName: string | null = null;
  let suiteId: string | null = null;
  let split: string | null = null;
  let caseId: string | null = null;

  const valueFlags = new Set([
    '--skill',
    '--suite',
    '--profile',
    '--split',
    '--case',
    '--runs',
    '--model',
    '--model-provider',
    '--codex-config',
    '--codex-bin',
    '--batch-name',
    '--batch-id',
    '--run-id',
    '--execution-plan',
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--audit') {
      auditPaths.push(path.resolve(valueAfter(args, index, arg)));
      index += 1;
      continue;
    }
    forwarded.push(arg);
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--materialize-only') {
      materializeOnly = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = valueAfter(args, index, arg);
      forwarded.push(value);
      index += 1;
      if (arg === '--skill') skillName = value;
      else if (arg === '--suite') suiteId = value;
      else if (arg === '--split') split = value;
      else if (arg === '--case') caseId = value;
      else if (arg === '--execution-plan') executionPlan = true;
      continue;
    }
    if (!arg.startsWith('-') && arg !== '--') positional.push(arg);
  }

  return {
    forwarded,
    auditPaths,
    help,
    executionPlan,
    materializeOnly,
    pluginName: positional[0] ?? null,
    skillName,
    suiteId,
    split,
    caseId,
  };
}

function rowsFromCaseDocument(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
  if (value && typeof value === 'object') {
    const record = value as { cases?: unknown; evals?: unknown };
    const rows = Array.isArray(record.cases)
      ? record.cases
      : Array.isArray(record.evals)
        ? record.evals
        : null;
    if (rows) {
      return rows.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      );
    }
  }
  throw new Error('Eval case corpus must be an array or contain cases/evals.');
}

async function selectedCaseIds(
  casePath: string,
  split: string | null,
  caseId: string | null,
): Promise<string[]> {
  const rows = rowsFromCaseDocument(JSON.parse(await readFile(casePath, 'utf8')));
  const ids = rows.flatMap((row) => {
    const id = typeof row.id === 'string' ? row.id : null;
    if (!id) return [];
    if (caseId && id !== caseId) return [];
    if (split && split !== 'all' && typeof row.split === 'string' && row.split !== split) return [];
    return [id];
  });
  if (ids.length === 0) {
    throw new Error(caseId
      ? `Selected Eval case ${caseId} was not found in ${casePath}.`
      : `Selected Eval corpus is empty: ${casePath}.`);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate Eval case ids in ${casePath}.`);
  return ids;
}

async function loadAudit(auditPath: string): Promise<EvalAuditResult> {
  const value = JSON.parse(await readFile(auditPath, 'utf8')) as unknown;
  const errors = validateJsonSchema(await getSchema('eval-audit-result'), value);
  if (errors.length > 0) {
    throw new Error(`Invalid EvalAuditResult ${auditPath}: ${errors.join('; ')}`);
  }
  const audit = value as EvalAuditResult;
  if (audit.producer !== 'audit-agent-skill-evals') {
    throw new Error(`Audit ${auditPath} has an invalid producer.`);
  }
  if (audit.mode !== 'preflight') throw new Error(`Audit ${auditPath} is not preflight.`);
  if (audit.runBundleDigest !== null) {
    throw new Error(`Preflight Audit ${auditPath} must use runBundleDigest=null.`);
  }
  if (!audit.independentContext) {
    throw new Error(`Audit ${auditPath} did not come from an independent audit context.`);
  }
  if (audit.validity !== 'pass') {
    throw new Error(`Audit ${auditPath} validity is ${audit.validity}; model Eval is blocked.`);
  }
  if (audit.blockedCases.length > 0) {
    throw new Error(`Audit ${auditPath} contains blocked cases: ${audit.blockedCases.join(', ')}.`);
  }
  if (audit.failureTriage.length > 0) {
    throw new Error(`Preflight Audit ${auditPath} must not contain result triage.`);
  }
  return audit;
}

function casePathForSuite(pluginRoot: string, suite: PluginEvalSuite): string {
  if (!('cases' in suite) || !suite.cases) {
    throw new Error(
      `Suite ${suite.id} has no auditable case corpus; use a canonical EvalExecutionPlan.`,
    );
  }
  return path.resolve(pluginRoot, suite.cases.replace(/^\.\//u, ''));
}

async function enforceAuditGate(
  parsed: GateArguments,
  options: PluginEvalRunnerOptions,
): Promise<void> {
  if (!parsed.pluginName || !parsed.skillName) {
    throw new Error('Model-running plugin Eval requires <plugin> and --skill <name>.');
  }
  if (parsed.auditPaths.length === 0) {
    throw new Error(
      'Model-running plugin Eval requires --audit <EvalAuditResult.json> before execution.',
    );
  }

  const env = options.env ?? process.env;
  const repoRoot = path.resolve(
    options.repoRoot ?? env[REPO_ROOT_ENV] ?? path.resolve(resolveCliPackageRoot(), '..', '..'),
  );
  const pluginRoot = path.join(repoRoot, 'plugins', parsed.pluginName);
  const skillRoot = await resolvePluginSkillAuthorRoot(pluginRoot, parsed.skillName);
  const targetSkillDigest = await computeSkillDigest(skillRoot);
  const manifest = await readPluginEvalManifest(
    pluginRoot,
    parsed.skillName,
    parsed.pluginName,
  );
  const suites = parsed.suiteId
    ? manifest.suites.filter((suite) => suite.id === parsed.suiteId)
    : manifest.suites;
  if (suites.length === 0) throw new Error(`Unknown Eval suite: ${parsed.suiteId}.`);

  const audits = await Promise.all(parsed.auditPaths.map(loadAudit));
  const auditByBinding = new Map<string, EvalAuditResult>();
  for (const audit of audits) {
    const key = `${audit.targetSkillDigest}:${audit.caseCorpusDigest}`;
    if (auditByBinding.has(key)) throw new Error(`Duplicate Audit binding: ${key}.`);
    auditByBinding.set(key, audit);
  }

  for (const suite of suites) {
    const casePath = casePathForSuite(pluginRoot, suite);
    const corpusDigest = await computeAuditCaseCorpusDigest([casePath]);
    const audit = auditByBinding.get(`${targetSkillDigest}:${corpusDigest}`);
    if (!audit) {
      throw new Error(
        `Suite ${suite.id} has no passing Audit bound to Skill ${targetSkillDigest} ` +
          `and corpus ${corpusDigest}.`,
      );
    }
    const admissions = new Map(audit.cases.map((entry) => [entry.caseId, entry.admission]));
    for (const id of await selectedCaseIds(casePath, parsed.split, parsed.caseId)) {
      if (admissions.get(id) !== 'pass') {
        throw new Error(`Suite ${suite.id} case ${id} does not have passing Audit admission.`);
      }
    }
  }
}

export async function runAuditedPluginEvals(
  args: string[],
  options: AuditedPluginEvalOptions = {},
): Promise<number> {
  const { delegate = runPluginEvals, ...runnerOptions } = options;
  const stderr = runnerOptions.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const parsed = parseGateArguments(args);
    if (parsed.help) {
      const code = await delegate(parsed.forwarded, runnerOptions);
      const stdout = runnerOptions.stdout ?? ((text: string) => process.stdout.write(text));
      stdout(
        '\nAudit gate: model-running plugin Eval requires one or more ' +
          '`--audit <EvalAuditResult.json>` values. ' +
          '`--materialize-only` and `--execution-plan` are already gated separately.\n',
      );
      return code;
    }
    if (parsed.executionPlan) {
      if (parsed.auditPaths.length > 0) {
        throw new Error('--execution-plan already binds its Audit; do not also pass --audit.');
      }
      return await delegate(parsed.forwarded, runnerOptions);
    }
    if (parsed.materializeOnly) {
      return await delegate(parsed.forwarded, runnerOptions);
    }
    await enforceAuditGate(parsed, runnerOptions);
    return await delegate(parsed.forwarded, runnerOptions);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentEntryPath) {
  runAuditedPluginEvals(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
}
