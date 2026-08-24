import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  runProviderProcess,
  type ProcessLifecycleHooks,
  type ProcessTreeDependencies,
} from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';

import type { PluginMeta } from '../src/types.js';
import { readPluginManifest } from '../src/utils/manifest.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import { runCodexConversationSuite } from './codex-eval-app-server.js';
import { assertCodexEvalKeychainWrapperAbsent } from './codex-eval-isolation.js';
import { resolveCodexEvalProcessManagement } from './codex-eval-process-management.js';
import {
  CODEX_EVAL_PROCESS_TREE_ID_ENV,
  type ChildProcessTreeMonitor,
  createPosixProcessTreeMonitor,
  PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX,
  processTreeCleanupIsUnconfirmed,
  scrubProcessTreeId,
  terminatePosixProcessTree,
  terminateWindowsProcessTree,
} from './codex-eval-process-tree.js';
import {
  assertCodexEvalCanStartWork,
  createCodexEvalRuntimeCapsule,
  redactCodexEvalText,
  redactCodexEvalValue,
  registerCodexEvalSignalCleanup,
  resolveCodexEvalRuntimeConfig,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js';
import { runCodexTriggerSuite } from './codex-trigger-eval.js';
import {
  combinePluginEvalOutcome,
  PLUGIN_EVAL_SCHEMA_VERSION,
  readPluginEvalManifest,
  readPluginEvalTriggerCases,
  resolvePluginSkillAuthorRoot,
  validatePluginEvalConversationCaseDocument,
  type PluginEvaluationBundle,
  type PluginEvalCaseResult,
  type PluginEvalCommandCaseResult,
  type PluginEvalCommandSuite,
  type PluginEvalManifest,
  type PluginEvalOutcome,
  type PluginEvalProcessManagementEvidence,
  type PluginEvalSplit,
  type PluginEvalSuite,
  type PluginEvalSuiteReport,
} from './plugin-eval-contract.js';
import {
  createPluginEvalRunLayout,
  writeEvalRunJson,
  type EvalRunLayout,
} from './eval-run-layout.js';
import {
  materializePluginEvalSubjects,
  resolveMaterializedSubjectRoot,
} from './plugin-eval-materializer.js';
import { runAwSkillEvalExecutionPlan } from './aw-skill-eval-engine.js';
import {
  completeSkillEvalRun,
  computeAuthorSourceDigest,
  createSkillEvalTargetKey,
  createEnvironmentDigest,
  failSkillEvalRun,
  pluginReleaseTargets,
  publishEvalRunCheckpoint,
  publishEvalRunToBatch,
  resolveSkillEvalTargetPlan,
  validateSkillReportTargetSegment,
  type SkillEvalTargetSummary,
} from './skill-reporting.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT_ENV = 'AW_PLUGIN_EVAL_REPO_ROOT';

interface ParsedArgs {
  pluginName?: string;
  skillName?: string;
  suite?: string;
  profile?: string;
  split?: PluginEvalSplit;
  caseId?: string;
  runs?: number;
  model?: string;
  modelProvider?: string;
  codexConfig?: string;
  inheritCodexConfig: boolean;
  codexBin: string;
  batchName?: string;
  batchId?: string;
  runId?: string;
  materializeOnly: boolean;
  allowEnvironmentSkips: boolean;
  allowUnmanagedProcesses: boolean;
}

export interface PluginEvalRunnerOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  platform?: NodeJS.Platform;
  readUserKeychainSearchList?: () => Promise<string>;
  inspectProcessTree?: () => Promise<void>;
  evalProcessTree?: ProcessTreeDependencies;
  createRunLayout?: typeof createPluginEvalRunLayout;
}

interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  descendantCleanupGuaranteed: boolean;
  containmentLimitation?: string;
  processTreeId: string;
}

const DEFAULT_OBSERVED_PROCESS_EVIDENCE: PluginEvalProcessManagementEvidence = {
  mode: 'observed',
  inspectionAvailable: true,
  userAcknowledged: false,
  descendantCleanupGuaranteed: false,
  limitation:
    'Process-tree inspection observes and cleans known descendants but does not guarantee descendant cleanup.',
};

export { terminatePosixProcessTree, terminateWindowsProcessTree };

function resolveRepoRoot(): string {
  return path.resolve(resolveCliPackageRoot(), '..', '..');
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: pnpm plugin:eval <plugin> --skill <skill> [OPTIONS]',
    '       pnpm plugin:eval --aw-skill-eval-plan <plan.json>',
    '',
    'Options:',
    '  --skill <name>                Select exactly one Skill (required)',
    '  --suite <id>                  Run one suite',
    '  --profile <id>                Select one materialization profile',
    '  --split <train|validation|sanity|all>',
    '  --case <id>                   Run one case (requires --suite)',
    '  --runs <count>                Override repetitions per case',
    '  --model <model>               Parent Codex model (default: gpt-5.6-luna)',
    '  --model-provider <id>         Override the inherited Codex model provider',
    '  --codex-config <path>         Read model/provider config from this config.toml',
    '  --no-inherit-codex-config     Use a clean official Codex provider config',
    '  --codex-bin <path>            Codex executable (default: codex)',
    '  --batch-name <name>           Create a named report batch',
    '  --batch-id <id>               Append to an existing report batch',
    '  --run-id <id>                 Use an explicit unique report run id',
    '  --materialize-only            Do not start real Codex model sessions',
    '  --allow-environment-skips     Diagnostic only; release remains incomplete',
    '  --allow-unmanaged-processes   Confirm eval without descendant process tracking',
    '  --aw-skill-eval-plan <path>    Run one AwSkillEvalExecutionPlan with aw-skill-eval',
  ].join('\n');
}

function awSkillEvalExecutionPlanPath(args: string[]): string | undefined {
  const index = args.indexOf('--aw-skill-eval-plan');
  if (index < 0) return undefined;
  if (args.length !== 2 || index !== 0 || !args[1] || args[1].startsWith('-')) {
    throw new Error('--aw-skill-eval-plan requires exactly one plan path and no AW suite options.');
  }
  return path.resolve(args[1]);
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    codexBin: 'codex',
    inheritCodexConfig: true,
    materializeOnly: false,
    allowEnvironmentSkips: false,
    allowUnmanagedProcesses: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--materialize-only') {
      parsed.materializeOnly = true;
      continue;
    }
    if (arg === '--allow-environment-skips') {
      parsed.allowEnvironmentSkips = true;
      continue;
    }
    if (arg === '--allow-unmanaged-processes') {
      parsed.allowUnmanagedProcesses = true;
      continue;
    }
    if (arg === '--no-inherit-codex-config') {
      parsed.inheritCodexConfig = false;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      throw new Error(usage());
    }
    if (arg === '--skill') {
      parsed.skillName = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--suite') {
      parsed.suite = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--profile') {
      parsed.profile = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--split') {
      const value = optionValue(args, index, arg);
      if (!['train', 'validation', 'sanity', 'all'].includes(value)) {
        throw new Error('--split must be train, validation, sanity, or all.');
      }
      parsed.split = value as PluginEvalSplit;
      index += 1;
      continue;
    }
    if (arg === '--case') {
      parsed.caseId = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--runs') {
      parsed.runs = parsePositiveInteger(optionValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--model') {
      parsed.model = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--model-provider') {
      parsed.modelProvider = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--codex-config') {
      parsed.codexConfig = path.resolve(optionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--codex-bin') {
      parsed.codexBin = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--batch-name') {
      parsed.batchName = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--batch-id') {
      parsed.batchId = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--run-id') {
      parsed.runId = optionValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".\n\n${usage()}`);
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error(usage());
  }
  if (!parsed.skillName) {
    throw new Error('--skill is required.\n\n' + usage());
  }
  if (parsed.caseId && !parsed.suite) {
    throw new Error('--case requires --suite.');
  }
  if (parsed.caseId) {
    validateSkillReportTargetSegment(parsed.caseId, '--case');
  }
  if (!parsed.inheritCodexConfig && (parsed.codexConfig || parsed.modelProvider)) {
    throw new Error(
      '--no-inherit-codex-config cannot be combined with --codex-config or --model-provider.',
    );
  }
  if (
    parsed.materializeOnly &&
    (
      parsed.suite !== undefined ||
      parsed.split !== undefined ||
      parsed.caseId !== undefined ||
      parsed.runs !== undefined ||
      parsed.model !== undefined ||
      parsed.modelProvider !== undefined ||
      parsed.codexConfig !== undefined ||
      parsed.inheritCodexConfig === false ||
      parsed.allowEnvironmentSkips ||
      parsed.allowUnmanagedProcesses
    )
  ) {
    throw new Error(
      '--materialize-only supports target/profile selection, not suite model-run flags.',
    );
  }
  parsed.pluginName = positional[0];
  if (parsed.pluginName && !/^[a-z0-9][a-z0-9-]*$/u.test(parsed.pluginName)) {
    throw new Error('Plugin name must use lowercase kebab-case without path separators.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(parsed.skillName)) {
    throw new Error('Skill name must use lowercase kebab-case without path separators.');
  }
  return parsed;
}

export async function runChild(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stderr: (text: string) => void;
    redact?: (text: string) => string;
    timeoutMs: number;
    processManagement?: PluginEvalProcessManagementEvidence;
    createProcessTreeMonitor?: (pid: number, treeId: string) => ChildProcessTreeMonitor;
  },
): Promise<ChildResult> {
  assertCodexEvalCanStartWork();
  const processTreeId = randomUUID();
  const processManagement = options.processManagement ?? DEFAULT_OBSERVED_PROCESS_EVIDENCE;
  const observed = processManagement.mode === 'managed' || processManagement.mode === 'observed';
  if (!observed && (
    processManagement.mode !== 'unmanaged-confirmed' ||
    !processManagement.userAcknowledged
  )) {
    throw new Error('Unmanaged process execution requires explicit user confirmation.');
  }
  const abortController = new AbortController();
  let processTreeMonitor: ChildProcessTreeMonitor | undefined;
  let terminationPromise: Promise<string[]> | undefined;
  let cleanupDiagnostics: string[] = [];
  let cleanupDiagnostic = '';
  const terminateManagedTree = async (): Promise<{ confirmed: true }> => {
    if (!processTreeMonitor) return { confirmed: true };
    terminationPromise ??= processTreeMonitor.terminate().catch((error: unknown) => [
      `${PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
    cleanupDiagnostics = await terminationPromise;
    if (cleanupDiagnostics.length > 0) {
      cleanupDiagnostic = `${cleanupDiagnostics.join('\n')}\n`;
    }
    if (processTreeCleanupIsUnconfirmed(cleanupDiagnostics)) {
      throw new Error(cleanupDiagnostics.join('\n'));
    }
    return { confirmed: true };
  };
  const hooks: ProcessLifecycleHooks | undefined = observed
    ? {
        onSpawn: ({ pid }) => {
          processTreeMonitor = options.createProcessTreeMonitor
            ? options.createProcessTreeMonitor(pid, processTreeId)
            : createPosixProcessTreeMonitor(pid, { treeId: processTreeId });
        },
        terminateProcessTree: terminateManagedTree,
      }
    : undefined;
  const unregisterSignalCleanup = registerCodexEvalSignalCleanup(async () => {
    abortController.abort();
    if (observed) await terminateManagedTree();
  });
  try {
    const result = await runProviderProcess({
      executable: command,
      args,
      cwd: options.cwd,
      env: observed
        ? { ...options.env, [CODEX_EVAL_PROCESS_TREE_ID_ENV]: processTreeId }
        : { ...options.env },
      timeoutMs: options.timeoutMs,
      maxBufferBytes: 20 * 1024 * 1024,
      signal: abortController.signal,
    }, hooks, {
      containment: observed ? 'observed' : 'unmanaged-confirmed',
    });
    let stderr = result.stderr;
    if (result.timedOut) {
      stderr += `${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}` +
        `Suite exceeded central timeout of ${options.timeoutMs}ms.\n`;
    }
    stderr += cleanupDiagnostic;
    const safeStdout = result.stdout.replaceAll(processTreeId, '[process-tree-id]');
    const safeStderr = stderr.replaceAll(processTreeId, '[process-tree-id]');
    if (safeStderr) {
      const rendered = options.redact ? options.redact(safeStderr) : safeStderr;
      options.stderr(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    }
    return {
      ...result,
      exitCode:
        processTreeCleanupIsUnconfirmed(cleanupDiagnostics) &&
          result.exitCode === 0
          ? 1
          : result.exitCode,
      stdout: safeStdout,
      stderr: safeStderr,
      processTreeId,
    };
  } finally {
    unregisterSignalCleanup();
  }
}

function supports(
  suite: PluginEvalCommandSuite,
  capability: PluginEvalCommandSuite['supports'][number],
): boolean {
  return suite.supports.includes(capability);
}

function parseCommandReport(
  stdout: string,
  reportPath: string,
  processTreeId: string,
): Record<string, unknown> {
  let candidate = stdout.trim();
  if (fs.pathExistsSync(reportPath)) {
    candidate = fs.readFileSync(reportPath, 'utf8').trim();
  }
  candidate = candidate.replaceAll(processTreeId, '[process-tree-id]');
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The caller reports a structured incomplete result below.
  }
  throw new Error('Suite did not produce one JSON report.');
}

async function parseCommandCaseResults(
  report: Record<string, unknown>,
  options: {
    pluginRoot: string;
    suite: PluginEvalCommandSuite;
    caseId?: string;
  },
): Promise<PluginEvalCommandCaseResult[] | undefined> {
  if (!supports(options.suite, 'case')) return undefined;
  const expectedIds = options.caseId
    ? [options.caseId]
    : await readCommandSuiteCaseIds(options.pluginRoot, options.suite);
  if (!Array.isArray(report.case_results)) {
    throw new Error('Case-capable command suite must return case_results.');
  }
  const results = report.case_results.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`case_results[${index}] must be an object.`);
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || !/^[a-z0-9_]+$/u.test(row.id)) {
      throw new Error(`case_results[${index}].id must use lowercase snake_case.`);
    }
    if (!['passed', 'failed', 'needs_review', 'incomplete'].includes(String(row.outcome))) {
      throw new Error(`case_results[${index}].outcome is invalid.`);
    }
    if (typeof row.complete !== 'boolean' || typeof row.mechanical_passed !== 'boolean') {
      throw new Error(`case_results[${index}] must declare complete and mechanical_passed.`);
    }
    const summary = row.summary;
    const diagnostics = row.diagnostics;
    if (summary !== undefined && (!summary || typeof summary !== 'object' || Array.isArray(summary))) {
      throw new Error(`case_results[${index}].summary must be an object.`);
    }
    if (
      diagnostics !== undefined &&
      (!Array.isArray(diagnostics) || diagnostics.some((entry) => typeof entry !== 'string'))
    ) {
      throw new Error(`case_results[${index}].diagnostics must be a string array.`);
    }
    return {
      id: row.id,
      outcome: row.outcome as PluginEvalOutcome,
      complete: row.complete,
      mechanicalPassed: row.mechanical_passed,
      ...(summary ? { summary: summary as Record<string, unknown> } : {}),
      ...(diagnostics ? { diagnostics: diagnostics as string[] } : {}),
    };
  });
  const actualIds = results.map((result) => result.id).sort();
  if (
    new Set(actualIds).size !== actualIds.length ||
    JSON.stringify(actualIds) !== JSON.stringify([...expectedIds].sort())
  ) {
    throw new Error(
      `case_results must cover exactly ${JSON.stringify([...expectedIds].sort())}; ` +
      `received ${JSON.stringify(actualIds)}.`,
    );
  }
  return results;
}

async function runCommandSuite(options: {
  pluginName: string;
  suite: PluginEvalCommandSuite;
  split: PluginEvalSplit | null;
  profile: string;
  subjectRoot: string;
  pluginRoot: string;
  outputRoot: string;
  parsed: ParsedArgs;
  env: NodeJS.ProcessEnv;
  codexRuntime: CodexEvalRuntimeConfig;
  codexRuntimeHome: string;
  processManagement: PluginEvalProcessManagementEvidence;
  installedPluginNames: string[];
  workRoot: string;
  stderr: (text: string) => void;
  timeoutMs?: number;
}): Promise<PluginEvalSuiteReport> {
  const sanitize = (report: PluginEvalSuiteReport): PluginEvalSuiteReport =>
    redactCodexEvalValue(report, options.codexRuntime);
  const reportName = [
    options.suite.id,
    options.split,
    options.profile,
    options.parsed.caseId,
  ]
    .filter(Boolean)
    .join('-');
  const reportPath = path.join(options.outputRoot, 'reports', `${reportName}.json`);
  const rawReportPath = path.join(
    options.codexRuntimeHome,
    'command-reports',
    options.pluginName,
    `${reportName}.json`,
  );
  await fs.ensureDir(path.dirname(reportPath));
  await fs.ensureDir(path.dirname(rawReportPath));
  const commandWorkRoot = path.join(options.workRoot, 'command', reportName);
  await fs.ensureDir(commandWorkRoot);
  const args = [path.resolve(options.pluginRoot, options.suite.entry.replace(/^\.\//u, ''))];
  if (options.split && supports(options.suite, 'split')) {
    args.push('--split', options.split);
  }
  if (supports(options.suite, 'runs')) {
    args.push('--runs', String(options.parsed.runs ?? options.suite.defaultRuns));
  }
  if (options.parsed.caseId && supports(options.suite, 'case')) {
    args.push('--case', options.parsed.caseId);
  }
  if (options.parsed.model && supports(options.suite, 'model')) {
    args.push('--model', options.parsed.model);
  }
  if (options.parsed.codexBin !== 'codex' && supports(options.suite, 'codexBin')) {
    args.push('--codex-bin', options.parsed.codexBin);
  }
  if (supports(options.suite, 'timeout')) {
    args.push('--timeout-ms', String(options.suite.perRunTimeoutMs));
  }
  if (
    options.parsed.allowEnvironmentSkips &&
    supports(options.suite, 'allowEnvironmentSkips')
  ) {
    args.push('--allow-environment-skips');
  }
  args.push('--output', rawReportPath);

  const result = await runChild(process.execPath, args, {
    cwd: options.subjectRoot,
    env: {
      ...options.env,
      CODEX_HOME: options.codexRuntimeHome,
      AW_CODEX_EVAL_RUNTIME_HOME: options.codexRuntimeHome,
      AW_CODEX_EVAL_MODEL_PROVIDER: options.codexRuntime.modelProvider,
      AW_CODEX_EVAL_SENSITIVE_ENV_NAMES: JSON.stringify(
        options.codexRuntime.sensitiveEnvironmentNames,
      ),
      AW_PLUGIN_EVAL_PROJECT_ROOT: options.subjectRoot,
      AW_PLUGIN_EVAL_PROFILE: options.profile,
      AW_PLUGIN_EVAL_SKILL: options.parsed.skillName!,
      AW_PLUGIN_EVAL_OWNER_SKILL: options.parsed.skillName!,
      AW_PLUGIN_EVAL_PARTICIPANT_SKILLS: JSON.stringify(options.suite.skills),
      AW_PLUGIN_EVAL_INSTALLED_PLUGINS: JSON.stringify(options.installedPluginNames),
      AW_PLUGIN_EVAL_WORK_ROOT: commandWorkRoot,
      TMPDIR: commandWorkRoot,
      TEMP: commandWorkRoot,
      TMP: commandWorkRoot,
    },
    stderr: options.stderr,
    redact: (value) => redactCodexEvalText(value, options.codexRuntime),
    timeoutMs: options.timeoutMs ?? options.suite.suiteTimeoutMs,
    processManagement: options.processManagement,
  });
  if (result.timedOut) {
    return sanitize({
      id: options.suite.id,
      kind: 'command',
      skills: options.suite.skills,
      profile: options.profile,
      split: options.split,
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
      qualitativeReview: 'not_required',
      summary: {},
      diagnostics: [
        `Suite exceeded central timeout of ${options.timeoutMs ?? options.suite.suiteTimeoutMs}ms.`,
        `exitCode=${result.exitCode}, signal=${result.signal}`,
        ...(result.stderr.trim() ? [result.stderr.trim()] : []),
      ],
    });
  }
  try {
    const report = redactCodexEvalValue(
      scrubProcessTreeId(
        parseCommandReport(result.stdout, rawReportPath, result.processTreeId),
        result.processTreeId,
      ),
      options.codexRuntime,
    );
    const caseResults = await parseCommandCaseResults(report, {
      pluginRoot: options.pluginRoot,
      suite: options.suite,
      caseId: options.parsed.caseId,
    });
    await fs.writeJson(reportPath, report, { spaces: 2 });
    const complete = report.complete !== false &&
      (caseResults === undefined || caseResults.every((entry) => entry.complete));
    const passed = complete && report.passed === true && result.exitCode === 0;
    const outcome: PluginEvalOutcome = !complete
      ? 'incomplete'
      : passed
        ? 'passed'
        : 'failed';
    return sanitize({
      id: options.suite.id,
      kind: 'command',
      skills: options.suite.skills,
      profile: options.profile,
      split: options.split,
      outcome,
      complete,
      mechanicalPassed: passed,
      qualitativeReview: 'not_required',
      reportPath: path.relative(options.outputRoot, reportPath).split(path.sep).join('/'),
      ...(caseResults ? { caseResults } : {}),
      summary: report.summary && typeof report.summary === 'object'
        ? report.summary as Record<string, unknown>
        : {},
      diagnostics: [
        ...(result.signal ? [`Suite terminated by ${result.signal}.`] : []),
        ...(report.environment_error ? [String(report.environment_error)] : []),
      ],
    });
  } catch (error) {
    return sanitize({
      id: options.suite.id,
      kind: 'command',
      skills: options.suite.skills,
      profile: options.profile,
      split: options.split,
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
      qualitativeReview: 'not_required',
      summary: {},
      diagnostics: [
        error instanceof Error ? error.message : String(error),
        `exitCode=${result.exitCode}, signal=${result.signal}`,
        ...(result.stderr.trim() ? [result.stderr.trim()] : []),
      ],
    });
  }
}

function selectedSuites(manifest: PluginEvalManifest, parsed: ParsedArgs): PluginEvalSuite[] {
  const suites = parsed.suite
    ? manifest.suites.filter((suite) => suite.id === parsed.suite)
    : manifest.suites.filter((suite) => suite.requiredForRelease);
  if (suites.length === 0) {
    throw new Error(`Unknown or non-release suite: ${parsed.suite ?? '(none)'}`);
  }
  return suites;
}

function collectCoverageDiagnostics(
  manifest: PluginEvalManifest,
  parsed: ParsedArgs,
): string[] {
  const diagnostics: string[] = [];
  if (parsed.suite) {
    diagnostics.push('--suite selected a debug subset of release-required suites.');
  }
  if (parsed.profile) {
    diagnostics.push('--profile selected a debug subset of required materialization profiles.');
  }
  if (parsed.split) {
    diagnostics.push('--split selected a debug subset of release-required splits.');
  }
  if (parsed.caseId) {
    diagnostics.push('--case selected a debug subset of suite cases.');
  }
  if (parsed.runs !== undefined) {
    const reducedSuites = selectedSuites(manifest, parsed).filter(
      (suite) => parsed.runs! < suite.defaultRuns,
    );
    if (reducedSuites.length > 0) {
      diagnostics.push(
        `--runs is below the declared default for suites: ${reducedSuites.map((suite) => suite.id).join(', ')}.`,
      );
    }
  }
  return diagnostics;
}

function applyRunCountCoverage(
  report: PluginEvalSuiteReport,
  suite: PluginEvalSuite,
  parsed: ParsedArgs,
): PluginEvalSuiteReport {
  if (parsed.runs === undefined || parsed.runs >= suite.defaultRuns) return report;
  return {
    ...report,
    outcome: 'incomplete',
    complete: false,
    ...(report.caseResults ? {
      caseResults: report.caseResults.map((caseResult) => ({
        ...caseResult,
        outcome: 'incomplete',
        complete: false,
      })),
    } : {}),
    diagnostics: [
      ...report.diagnostics,
      `Requested runs ${parsed.runs} are below the declared default ${suite.defaultRuns}.`,
    ],
  };
}

function assertSuiteSupportsRequestedOptions(
  suite: PluginEvalSuite,
  parsed: ParsedArgs,
): void {
  if (suite.kind !== 'command') {
    if (suite.kind === 'conversation' && parsed.split) {
      throw new Error(`Conversation suite "${suite.id}" does not support --split.`);
    }
    if (parsed.allowEnvironmentSkips) {
      throw new Error(
        `${suite.kind === 'trigger' ? 'Trigger' : 'Conversation'} suite ` +
          `"${suite.id}" does not support --allow-environment-skips.`,
      );
    }
    return;
  }
  const requested: Array<[
    PluginEvalCommandSuite['supports'][number],
    boolean,
    string,
  ]> = [
    ['split', parsed.split !== undefined, '--split'],
    ['case', parsed.caseId !== undefined, '--case'],
    ['runs', parsed.runs !== undefined, '--runs'],
    ['model', parsed.model !== undefined, '--model'],
    ['codexBin', parsed.codexBin !== 'codex', '--codex-bin'],
    ['allowEnvironmentSkips', parsed.allowEnvironmentSkips, '--allow-environment-skips'],
  ];
  for (const [capability, enabled, flag] of requested) {
    if (enabled && !supports(suite, capability)) {
      throw new Error(`Suite "${suite.id}" does not support ${flag}.`);
    }
  }
}

function resolveSuiteProfiles(
  suite: PluginEvalSuite,
  parsed: ParsedArgs,
): string[] {
  if (!parsed.profile) {
    return suite.profiles;
  }
  if (!suite.profiles.includes(parsed.profile)) {
    throw new Error(`Suite "${suite.id}" does not support profile "${parsed.profile}".`);
  }
  return [parsed.profile];
}

function resolveSuiteSplits(suite: PluginEvalSuite, parsed: ParsedArgs): Array<PluginEvalSplit | null> {
  if (parsed.split) {
    if (suite.kind === 'trigger' || (suite.kind === 'command' && supports(suite, 'split'))) {
      return [parsed.split];
    }
    return [null];
  }
  if (parsed.caseId && suite.kind === 'trigger') {
    return ['all'];
  }
  return suite.releaseSplits.length > 0 ? suite.releaseSplits : [null];
}

interface PreparedPluginEval {
  sourcePlugin: PluginMeta;
  sourcePlugins: PluginMeta[];
  skillRoot: string;
  manifest: PluginEvalManifest;
}

async function readCommandSuiteCaseIds(
  pluginRoot: string,
  suite: PluginEvalCommandSuite,
): Promise<string[]> {
  if (!suite.cases) return [];
  const document = await fs.readJson(
    path.resolve(pluginRoot, suite.cases.replace(/^\.\//u, '')),
  ) as { evals?: Array<{ id?: unknown }> };
  return (document.evals ?? []).map((entry) => String(entry.id));
}

async function readSuiteCaseIds(options: {
  pluginRoot: string;
  manifestSkill: string;
  suite: PluginEvalSuite;
  split: PluginEvalSplit | null;
}): Promise<string[]> {
  if (options.suite.kind === 'command') {
    return options.suite.cases
      ? readCommandSuiteCaseIds(options.pluginRoot, options.suite)
      : [];
  }
  if (options.suite.kind === 'trigger') {
    const corpus = await readPluginEvalTriggerCases(options.pluginRoot, options.suite);
    return corpus.cases
      .filter((entry) =>
        !options.split || options.split === 'all' || entry.split === options.split)
      .map((entry) => entry.id);
  }
  const casesPath = path.resolve(
    options.pluginRoot,
    options.suite.cases.replace(/^\.\//u, ''),
  );
  return validatePluginEvalConversationCaseDocument(
    await fs.readJson(casesPath),
    options.manifestSkill,
    `conversation cases for suite "${options.suite.id}"`,
  ).map((entry) => String(entry.id));
}

async function releaseTargetCompositions(
  prepared: PreparedPluginEval,
): Promise<Record<string, string[]>> {
  const compositions: Record<string, string[]> = {};
  for (const suite of prepared.manifest.suites) {
    if (!suite.requiredForRelease || (suite.kind === 'command' && !suite.cases)) continue;
    for (const profile of suite.profiles) {
      const splits: PluginEvalSplit[] = suite.releaseSplits.length > 0
        ? suite.releaseSplits
        : ['all'];
      for (const split of splits) {
        const caseIds = await readSuiteCaseIds({
          pluginRoot: prepared.sourcePlugin.rootDir,
          manifestSkill: prepared.manifest.skill,
          suite,
          split,
        });
        const prefix = `${suite.kind}/${suite.id}/${profile}/${split}`;
        compositions[`${prefix}/all`] = caseIds.map((caseId) => `${prefix}/${caseId}`);
      }
    }
  }
  return compositions;
}

async function preparePluginEval(options: {
  repoRoot: string;
  pluginName: string;
  skillName: string;
  parsed: ParsedArgs;
}): Promise<PreparedPluginEval> {
  const sourcePlugin = await readPluginManifest(
    path.join(options.repoRoot, 'plugins', options.pluginName),
  );
  const skillRoot = await resolvePluginSkillAuthorRoot(
    sourcePlugin.rootDir,
    options.skillName,
  );
  const manifest = await readPluginEvalManifest(
    sourcePlugin.rootDir,
    options.skillName,
    sourcePlugin.manifest.name,
  );
  const pluginNames = [...new Set(manifest.profiles.flatMap((profile) =>
    profile.plugins.map((plugin) => plugin.name)))];
  const sourcePlugins: PluginMeta[] = [];
  for (const pluginName of pluginNames) {
    const plugin = pluginName === sourcePlugin.manifest.name
      ? sourcePlugin
      : await readPluginManifest(path.join(options.repoRoot, 'plugins', pluginName));
    if (plugin.manifest.name !== pluginName) {
      throw new Error(
        `Eval profile requested plugin "${pluginName}" but repo source declares ` +
        `"${plugin.manifest.name}".`,
      );
    }
    sourcePlugins.push(plugin);
  }

  const skillOwnersByPlugin = new Map<string, Set<string>>();
  for (const plugin of sourcePlugins) {
    const skills = new Set<string>();
    if (plugin.manifest.skills) {
      const staticRoot = path.resolve(
        plugin.rootDir,
        plugin.manifest.skills.replace(/^\.\//u, ''),
      );
      if (await fs.pathExists(staticRoot)) {
        for (const entry of await fs.readdir(staticRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) skills.add(entry.name);
        }
      }
    }
    for (const target of plugin.manifest.artifacts?.targets ?? []) {
      if (target.target === 'codex.skill' && target.skillKey) skills.add(target.skillKey);
    }
    skillOwnersByPlugin.set(plugin.manifest.name, skills);
  }
  for (const profile of manifest.profiles) {
    const owners = new Map<string, string>();
    for (const installation of profile.plugins) {
      for (const skill of skillOwnersByPlugin.get(installation.name) ?? []) {
        const existing = owners.get(skill);
        if (existing && existing !== installation.name) {
          throw new Error(
            `Profile "${profile.id}" installs duplicate Codex Skill key "${skill}" ` +
            `from plugins "${existing}" and "${installation.name}".`,
          );
        }
        owners.set(skill, installation.name);
      }
    }
    for (const suite of manifest.suites.filter((suite) => suite.profiles.includes(profile.id))) {
      for (const skill of suite.skills) {
        if (!owners.has(skill)) {
          throw new Error(
            `Suite "${suite.id}" requires Skill "${skill}", but profile ` +
            `"${profile.id}" does not install a plugin that declares it.`,
          );
        }
      }
    }
  }
  if (
    options.parsed.profile &&
    !manifest.profiles.some((profile) => profile.id === options.parsed.profile)
  ) {
    throw new Error(`Unknown profile "${options.parsed.profile}".`);
  }
  if (options.parsed.materializeOnly) {
    return { sourcePlugin, sourcePlugins, skillRoot, manifest };
  }
  for (const suite of selectedSuites(manifest, options.parsed)) {
    assertSuiteSupportsRequestedOptions(suite, options.parsed);
    resolveSuiteProfiles(suite, options.parsed);
    const splits = resolveSuiteSplits(suite, options.parsed);
    if (!options.parsed.caseId) continue;
    if (suite.kind === 'trigger') {
      const corpus = await readPluginEvalTriggerCases(sourcePlugin.rootDir, suite);
      const matchingSplit = splits[0];
      const match = corpus.cases.some((entry) =>
        entry.id === options.parsed.caseId &&
        (matchingSplit === null || matchingSplit === 'all' || entry.split === matchingSplit)
      );
      if (!match) {
        throw new Error(`Unknown trigger case: ${options.parsed.caseId}`);
      }
    } else if (suite.kind === 'conversation') {
      const casesPath = path.resolve(
        sourcePlugin.rootDir,
        suite.cases.replace(/^\.\//u, ''),
      );
      const cases = validatePluginEvalConversationCaseDocument(
        await fs.readJson(casesPath),
        manifest.skill,
        `conversation cases for suite "${suite.id}"`,
      );
      if (!cases.some((entry) => entry.id === options.parsed.caseId)) {
        throw new Error(`Unknown conversation case: ${options.parsed.caseId}`);
      }
    } else if (suite.cases) {
      const caseIds = await readCommandSuiteCaseIds(sourcePlugin.rootDir, suite);
      if (!caseIds.includes(options.parsed.caseId)) {
        throw new Error(`Unknown command case: ${options.parsed.caseId}`);
      }
    }
  }
  return { sourcePlugin, sourcePlugins, skillRoot, manifest };
}

async function readCodexVersion(codexBin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await execFileAsync(codexBin, ['--version'], {
      env,
      timeout: 10_000,
      encoding: 'utf8',
    });
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

function normalizedSuiteReportPath(
  reportPath: string | undefined,
  outputRoot: string,
): string | undefined {
  if (!reportPath) return undefined;
  const relative = path.isAbsolute(reportPath)
    ? path.relative(outputRoot, reportPath)
    : reportPath;
  return relative.split(path.sep).join('/');
}

function batchRawReportPath(runId: string, reportPath: string | null): string | undefined {
  return reportPath
    ? path.posix.join('evals', 'runs', runId, 'raw', reportPath)
    : undefined;
}

function targetSummaryCaseResult(target: SkillEvalTargetSummary): PluginEvalCaseResult {
  return {
    id: target.case,
    outcome: target.outcome,
    complete: target.complete,
    mechanicalPassed: target.mechanicalPassed,
    qualitativeReview: target.qualitativeReview as PluginEvalCaseResult['qualitativeReview'],
    ...(batchRawReportPath(target.runId, target.reportPath)
      ? { reportPath: batchRawReportPath(target.runId, target.reportPath) }
      : {}),
    sourceRunId: target.runId,
    reused: true,
    summary: target.summary,
    diagnostics: target.diagnostics,
  };
}

function effectiveCaseResultFromReport(
  caseId: string,
  report: PluginEvalSuiteReport,
): PluginEvalCaseResult {
  const source = report.caseResults?.find((entry) => entry.id === caseId);
  const complete = report.complete && (source?.complete ?? true);
  const outcome: PluginEvalOutcome = !complete ||
    report.outcome === 'incomplete' || source?.outcome === 'incomplete'
    ? 'incomplete'
    : report.outcome === 'failed' || source?.outcome === 'failed'
      ? 'failed'
      : report.outcome === 'needs_review' || source?.outcome === 'needs_review'
        ? 'needs_review'
        : 'passed';
  return {
    id: caseId,
    outcome,
    complete,
    mechanicalPassed: report.mechanicalPassed && (source?.mechanicalPassed ?? true),
    qualitativeReview: source?.qualitativeReview ?? report.qualitativeReview,
    summary: source?.summary ?? report.summary,
    diagnostics: [...new Set([
      ...(source?.diagnostics ?? []),
      ...report.diagnostics,
    ])],
  };
}

async function writeCaseEvidenceIndex(options: {
  outputRoot: string;
  suite: PluginEvalSuite;
  profile: string;
  split: PluginEvalSplit | null;
  cases: PluginEvalCaseResult[];
}): Promise<string> {
  const name = [options.suite.id, options.split, options.profile, 'case-index']
    .filter(Boolean)
    .join('-');
  const reportPath = path.join(options.outputRoot, 'reports', `${name}.json`);
  await fs.ensureDir(path.dirname(reportPath));
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeJson(temporary, {
    schema_version: 1,
    type: 'eval-case-index',
    generated_at: new Date().toISOString(),
    suite: options.suite.id,
    kind: options.suite.kind,
    profile: options.profile,
    split: options.split ?? 'all',
    cases: options.cases.map((entry) => ({
      id: entry.id,
      outcome: entry.outcome,
      complete: entry.complete,
      mechanical_passed: entry.mechanicalPassed,
      qualitative_review: entry.qualitativeReview ?? 'not_required',
      source_run_id: entry.sourceRunId ?? null,
      reused: entry.reused === true,
      report_path: entry.reportPath ?? null,
    })),
  }, { spaces: 2 });
  await fs.rename(temporary, reportPath);
  return path.relative(options.outputRoot, reportPath).split(path.sep).join('/');
}

function aggregateCaseSuiteReport(options: {
  suite: PluginEvalSuite;
  profile: string;
  split: PluginEvalSplit | null;
  expectedCaseIds: string[];
  cases: PluginEvalCaseResult[];
  reportPath: string;
}): PluginEvalSuiteReport {
  const byId = new Map(options.cases.map((entry) => [entry.id, entry]));
  const ordered = options.expectedCaseIds.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const missing = options.expectedCaseIds.filter((id) => !byId.has(id));
  const complete = missing.length === 0 && ordered.every((entry) => entry.complete);
  const outcome: PluginEvalOutcome = !complete || ordered.some((entry) =>
    entry.outcome === 'incomplete')
    ? 'incomplete'
    : ordered.some((entry) => entry.outcome === 'failed')
      ? 'failed'
      : ordered.some((entry) => entry.outcome === 'needs_review')
        ? 'needs_review'
        : 'passed';
  const qualitativeReview = options.suite.kind === 'conversation' || ordered.some((entry) =>
    entry.qualitativeReview === 'required')
    ? 'required'
    : 'not_required';
  return {
    id: options.suite.id,
    kind: options.suite.kind,
    skills: options.suite.skills,
    profile: options.profile,
    split: options.split,
    outcome,
    complete,
    mechanicalPassed: ordered.every((entry) => entry.mechanicalPassed),
    qualitativeReview,
    reportPath: options.reportPath,
    caseResults: ordered,
    summary: {
      cases: options.expectedCaseIds.length,
      completed: ordered.filter((entry) => entry.complete).length,
      passed: ordered.filter((entry) => entry.outcome === 'passed').length,
      failed: ordered.filter((entry) => entry.outcome === 'failed').length,
      needsReview: ordered.filter((entry) => entry.outcome === 'needs_review').length,
      incomplete: missing.length + ordered.filter((entry) => !entry.complete).length,
    },
    diagnostics: [
      ...(missing.length > 0 ? [`Missing case evidence: ${missing.join(', ')}.`] : []),
      ...ordered.flatMap((entry) => entry.diagnostics ?? []),
    ],
  };
}

function checkpointEvaluation(
  subjects: PluginEvaluationBundle['subjects'],
  report: PluginEvalSuiteReport,
): Parameters<typeof publishEvalRunCheckpoint>[0]['evaluation'] {
  return {
    generatedAt: new Date().toISOString(),
    outcome: report.outcome,
    complete: report.complete,
    mechanicalPassed: report.mechanicalPassed,
    subjects,
    suites: [report],
    diagnostics: report.diagnostics,
  };
}

async function runOnePlugin(options: {
  sourcePlugin: PluginMeta;
  sourcePlugins: PluginMeta[];
  manifest: PluginEvalManifest;
  parsed: ParsedArgs;
  outputRoot: string;
  workRoot: string;
  processManagement: PluginEvalProcessManagementEvidence;
  env: NodeJS.ProcessEnv;
  modelEnv: NodeJS.ProcessEnv;
  codexRuntime?: CodexEvalRuntimeConfig;
  codexRuntimeHome?: string;
  layout?: EvalRunLayout;
  stderr: (text: string) => void;
}): Promise<PluginEvaluationBundle> {
  assertCodexEvalCanStartWork();
  const { sourcePlugin, manifest } = options;
  const outputRoot = options.outputRoot;
  await fs.ensureDir(outputRoot);
  const selectedProfiles = options.parsed.profile
    ? new Set([options.parsed.profile])
    : undefined;
  assertCodexEvalCanStartWork();
  const subjects = await materializePluginEvalSubjects({
    plugin: sourcePlugin,
    plugins: options.sourcePlugins,
    manifest,
    outputRoot,
    workRoot: path.join(options.workRoot, 'materialize'),
    env: options.env,
    selectedProfiles,
  });
  const reports: PluginEvalSuiteReport[] = [];
  if (!options.parsed.materializeOnly) {
    if (!options.layout) throw new Error('Real model eval requires a report run layout.');
    suiteLoop: for (const suite of selectedSuites(manifest, options.parsed)) {
      assertCodexEvalCanStartWork();
      for (const profile of resolveSuiteProfiles(suite, options.parsed)) {
        const subject = subjects.find((entry) => entry.profile === profile);
        if (!subject) {
          throw new Error(`Profile "${profile}" was not materialized.`);
        }
        const subjectRoot = resolveMaterializedSubjectRoot(outputRoot, subject);
        for (const split of resolveSuiteSplits(suite, options.parsed)) {
          assertCodexEvalCanStartWork();
          options.stderr(
            `[plugin:eval] ${sourcePlugin.manifest.name}/${suite.id}` +
              `${split ? `/${split}` : ''} (${profile})\n`,
          );
          const declaredCaseIds = await readSuiteCaseIds({
            pluginRoot: sourcePlugin.rootDir,
            manifestSkill: manifest.skill,
            suite,
            split,
          });
          const expectedCaseIds = options.parsed.caseId
            ? declaredCaseIds.filter((id) => id === options.parsed.caseId)
            : declaredCaseIds;
          if (declaredCaseIds.length > 0 && expectedCaseIds.length === 0) {
            throw new Error(`Unknown ${suite.kind} case: ${options.parsed.caseId}`);
          }

          if (expectedCaseIds.length > 0) {
            const targets = expectedCaseIds.map((caseId) => createSkillEvalTargetKey([
              suite.kind,
              suite.id,
              profile,
              split ?? 'all',
              caseId,
            ]));
            const plan = await resolveSkillEvalTargetPlan({
              layout: options.layout,
              targets,
            });
            const targetByCase = new Map(targets.map((target, index) => [
              expectedCaseIds[index],
              target,
            ]));
            const caseResults = plan.reusable.map(targetSummaryCaseResult);
            const pendingCaseIds = expectedCaseIds.filter((caseId) =>
              plan.pending.includes(targetByCase.get(caseId)!));
            if (plan.reusable.length > 0) {
              options.stderr(
                `[plugin:eval] reuse=${plan.reusable.length} pending=${pendingCaseIds.length} ` +
                `suite=${suite.id} profile=${profile} split=${split ?? 'all'}\n`,
              );
            }

            const recordCase = async (
              caseId: string,
              rawReport: PluginEvalSuiteReport,
            ): Promise<PluginEvalSuiteReport> => {
              const report = applyRunCountCoverage({
                ...rawReport,
                reportPath: normalizedSuiteReportPath(rawReport.reportPath, outputRoot),
              }, suite, options.parsed);
              await publishEvalRunCheckpoint({
                layout: options.layout!,
                evaluation: checkpointEvaluation(subjects, report),
                caseId,
              });
              const effective = effectiveCaseResultFromReport(caseId, report);
              caseResults.push({
                ...effective,
                ...(report.reportPath ? {
                  reportPath: batchRawReportPath(options.layout!.runId, report.reportPath),
                } : {}),
                sourceRunId: options.layout!.runId,
                reused: false,
              });
              return report;
            };

            const recordedCaseCount = caseResults.length;
            let executionReport: PluginEvalSuiteReport | null = null;
            if (pendingCaseIds.length > 0 && suite.kind === 'conversation') {
              const skillPath = path.join(
                subjectRoot,
                '.agents',
                'skills',
                suite.skill,
                'SKILL.md',
              );
              if (!(await fs.pathExists(skillPath))) {
                throw new Error(
                  `Conversation suite "${suite.id}" could not find materialized skill ` +
                    `"${suite.skill}" in profile "${profile}".`,
                );
              }
              const reportPath = path.join(outputRoot, 'reports', `${suite.id}-${profile}.json`);
              executionReport = await runCodexConversationSuite({
                suiteId: suite.id,
                skillName: suite.skill,
                skillNames: suite.skills,
                casesPath: path.resolve(sourcePlugin.rootDir, suite.cases.replace(/^\.\//u, '')),
                subjectRoot,
                profile,
                runs: options.parsed.runs ?? suite.defaultRuns,
                caseIds: pendingCaseIds,
                codexBin: options.parsed.codexBin,
                model: options.parsed.model,
                codexRuntime: options.codexRuntime,
                timeoutMs: suite.perRunTimeoutMs,
                isolation: suite.isolation,
                sourceEnv: options.modelEnv,
                reportPath,
                processManagement: options.processManagement,
                forbiddenHostRoots: options.sourcePlugins.map((plugin) => plugin.rootDir),
                workRoot: path.join(options.workRoot, 'conversation'),
                stopOnIncomplete: true,
                onCaseCompleted: async (checkpoint) => {
                  await recordCase(checkpoint.caseId, checkpoint.report);
                },
              });
            } else if (pendingCaseIds.length > 0 && suite.kind === 'trigger') {
              const triggerSplit = split ?? 'all';
              const reportPath = path.join(
                outputRoot,
                'reports',
                `${suite.id}-${triggerSplit}-${profile}.json`,
              );
              executionReport = await runCodexTriggerSuite({
                suite,
                split: triggerSplit,
                subjectRoot,
                pluginRoot: sourcePlugin.rootDir,
                profile,
                runs: options.parsed.runs ?? suite.defaultRuns,
                caseIds: pendingCaseIds,
                codexBin: options.parsed.codexBin,
                model: options.parsed.model,
                codexRuntime: options.codexRuntime,
                sourceEnv: options.modelEnv,
                reportPath,
                stderr: options.stderr,
                processManagement: options.processManagement,
                workRoot: path.join(options.workRoot, 'trigger'),
                stopOnIncomplete: true,
                onCaseCompleted: async (checkpoint) => {
                  await recordCase(checkpoint.caseId, checkpoint.report);
                },
              });
            } else if (pendingCaseIds.length > 0 && suite.kind === 'command') {
              const deadline = Date.now() + suite.suiteTimeoutMs;
              for (const caseId of pendingCaseIds) {
                const remaining = Math.max(1, deadline - Date.now());
                const rawReport = await runCommandSuite({
                  pluginName: sourcePlugin.manifest.name,
                  suite,
                  split,
                  profile,
                  subjectRoot,
                  pluginRoot: sourcePlugin.rootDir,
                  outputRoot,
                  parsed: { ...options.parsed, caseId },
                  env: options.modelEnv,
                  codexRuntime: options.codexRuntime!,
                  codexRuntimeHome: options.codexRuntimeHome!,
                  processManagement: options.processManagement,
                  installedPluginNames: subject.installedPlugins.map((plugin) => plugin.name),
                  workRoot: options.workRoot,
                  stderr: options.stderr,
                  timeoutMs: remaining,
                });
                executionReport = await recordCase(caseId, rawReport);
                if (rawReport.outcome === 'incomplete') break;
              }
            }

            if (
              executionReport?.outcome === 'incomplete' &&
              caseResults.length === recordedCaseCount
            ) {
              const report = applyRunCountCoverage({
                ...executionReport,
                reportPath: normalizedSuiteReportPath(executionReport.reportPath, outputRoot),
              }, suite, options.parsed);
              await publishEvalRunCheckpoint({
                layout: options.layout,
                evaluation: checkpointEvaluation(subjects, report),
              });
              reports.push(report);
              break suiteLoop;
            }

            const indexPath = await writeCaseEvidenceIndex({
              outputRoot,
              suite,
              profile,
              split,
              cases: caseResults,
            });
            const report = aggregateCaseSuiteReport({
              suite,
              profile,
              split,
              expectedCaseIds,
              cases: caseResults,
              reportPath: indexPath,
            });
            reports.push(report);
            if (report.outcome === 'incomplete') break suiteLoop;
            continue;
          }

          const target = createSkillEvalTargetKey([
            suite.kind,
            suite.id,
            profile,
            split ?? 'all',
            'all',
          ]);
          const plan = await resolveSkillEvalTargetPlan({
            layout: options.layout,
            targets: [target],
          });
          if (plan.reusable.length > 0) {
            const reused = plan.reusable[0];
            const reference = targetSummaryCaseResult(reused);
            const reportPath = await writeCaseEvidenceIndex({
              outputRoot,
              suite,
              profile,
              split,
              cases: [reference],
            });
            reports.push({
              id: suite.id,
              kind: suite.kind,
              skills: suite.skills,
              profile,
              split,
              outcome: reused.outcome,
              complete: reused.complete,
              mechanicalPassed: reused.mechanicalPassed,
              qualitativeReview:
                reused.qualitativeReview as PluginEvalSuiteReport['qualitativeReview'],
              reportPath,
              summary: { ...reused.summary, reusedFromRun: reused.runId },
              diagnostics: reused.diagnostics,
            });
            continue;
          }
          if (suite.kind !== 'command') {
            throw new Error(`Suite "${suite.id}" did not expose its declared cases.`);
          }
          const report = applyRunCountCoverage(await runCommandSuite({
            pluginName: sourcePlugin.manifest.name,
            suite,
            split,
            profile,
            subjectRoot,
            pluginRoot: sourcePlugin.rootDir,
            outputRoot,
            parsed: options.parsed,
            env: options.modelEnv,
            codexRuntime: options.codexRuntime!,
            codexRuntimeHome: options.codexRuntimeHome!,
            processManagement: options.processManagement,
            installedPluginNames: subject.installedPlugins.map((plugin) => plugin.name),
            workRoot: options.workRoot,
            stderr: options.stderr,
          }), suite, options.parsed);
          await publishEvalRunCheckpoint({
            layout: options.layout,
            evaluation: checkpointEvaluation(subjects, report),
          });
          reports.push(report);
          if (report.outcome === 'incomplete') break suiteLoop;
        }
      }
    }
  }
  const reportOutcome = options.parsed.materializeOnly
    ? 'passed'
    : combinePluginEvalOutcome(reports);
  const coverageDiagnostics = collectCoverageDiagnostics(manifest, options.parsed);
  const coverageComplete = coverageDiagnostics.length === 0;
  const reportsComplete = options.parsed.materializeOnly ||
    reports.every((report) => report.complete);
  const unredactedBundle: PluginEvaluationBundle = {
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    plugin: sourcePlugin.manifest.name,
    skill: manifest.skill,
    pluginVersion: sourcePlugin.manifest.version,
    platform: 'codex',
    codexVersion: options.parsed.materializeOnly
      ? null
      : await readCodexVersion(options.parsed.codexBin, options.modelEnv),
    model: options.parsed.model ?? options.codexRuntime?.model ?? null,
    modelProvider: options.codexRuntime?.modelProvider ?? null,
    credentialSource: options.codexRuntime?.credentialSource ?? null,
    codexConfigDigest: options.codexRuntime?.evidenceDigest ?? null,
    processManagement: options.processManagement,
    outcome: coverageComplete ? reportOutcome : 'incomplete',
    complete: coverageComplete && reportsComplete,
    mechanicalPassed: options.parsed.materializeOnly || reports.every(
      (report) => report.mechanicalPassed,
    ),
    subjects,
    suites: reports,
    diagnostics: coverageDiagnostics,
  };
  const bundle = options.codexRuntime
    ? redactCodexEvalValue(unredactedBundle, options.codexRuntime)
    : unredactedBundle;
  await fs.writeJson(path.join(outputRoot, 'evaluation.json'), bundle, { spaces: 2 });
  return bundle;
}

export async function readSourceRevision(options: {
  repoRoot: string;
  pluginNames: string[];
}): Promise<{ gitHead: string | null; inScopeDirty: boolean }> {
  try {
    const pluginPaths = options.pluginNames.map((pluginName) => `plugins/${pluginName}`);
    const reportExclusions = options.pluginNames.map(
      (pluginName) => `:(exclude)plugins/${pluginName}/**/reports/**`,
    );
    const [head, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: options.repoRoot,
        encoding: 'utf8',
      }),
      execFileAsync('git', [
        'status',
        '--porcelain=v1',
        '--',
        ...pluginPaths,
        'packages/cli/scripts',
        'packages/cli/src',
        '.agents/skills/create-aw-plugin',
        '.agents/skills/skill-review',
        ...reportExclusions,
      ], {
        cwd: options.repoRoot,
        encoding: 'utf8',
      }),
    ]);
    return {
      gitHead: head.stdout.trim() || null,
      inScopeDirty: status.stdout.trim() !== '',
    };
  } catch {
    return { gitHead: null, inScopeDirty: true };
  }
}

function publicProcessManagement(
  value: PluginEvalProcessManagementEvidence,
): Omit<PluginEvalProcessManagementEvidence, 'diagnostic'> {
  return {
    mode: value.mode,
    inspectionAvailable: value.inspectionAvailable,
    userAcknowledged: value.userAcknowledged,
    descendantCleanupGuaranteed: value.descendantCleanupGuaranteed,
    ...(value.limitation ? { limitation: value.limitation } : {}),
  };
}

async function writePublishedEvalReport(options: {
  layout: EvalRunLayout;
  bundle: PluginEvaluationBundle;
  sourceRevision: { gitHead: string | null; inScopeDirty: boolean };
}): Promise<void> {
  const processManagement = publicProcessManagement(options.bundle.processManagement);
  const summary = {
    schemaVersion: 1,
    runId: options.layout.runId,
    plugin: options.bundle.plugin,
    skill: options.bundle.skill,
    generatedAt: options.bundle.generatedAt,
    outcome: options.bundle.outcome,
    complete: options.bundle.complete,
    mechanicalPassed: options.bundle.mechanicalPassed,
    codexVersion: options.bundle.codexVersion,
    model: options.bundle.model,
    modelProvider: options.bundle.modelProvider,
    codexConfigDigest: options.bundle.codexConfigDigest,
    processManagement,
    source: options.sourceRevision,
    subjects: options.bundle.subjects.map((subject) => ({
      profile: subject.profile,
      scope: subject.scope,
      configDigest: subject.configDigest,
      bundleDigest: subject.bundleDigest,
      installedPlugins: subject.installedPlugins,
      artifacts: subject.artifacts.map((artifact) => ({
        kind: artifact.kind,
        ...(artifact.key ? { key: artifact.key } : {}),
        contentDigest: artifact.contentDigest,
      })),
    })),
    suites: options.bundle.suites.map((suite) => ({
      id: suite.id,
      kind: suite.kind,
      skills: suite.skills,
      profile: suite.profile,
      split: suite.split,
      outcome: suite.outcome,
      complete: suite.complete,
      mechanicalPassed: suite.mechanicalPassed,
      qualitativeReview: suite.qualitativeReview,
      caseResults: suite.caseResults,
      summary: suite.summary,
    })),
    diagnostics: options.bundle.diagnostics,
  };
  await writeEvalRunJson(options.layout.reportRoot, 'summary.json', summary);
  const suiteRows = summary.suites.map((suite) =>
    `| ${suite.id} | ${suite.skills.join(', ')} | ${suite.profile} | ${suite.split ?? '-'} | ${suite.outcome} |`,
  );
  const report = [
    '# Plugin Skill Eval Report',
    '',
    `- Plugin: \`${summary.plugin}\``,
    `- Skill: \`${summary.skill}\``,
    `- Run: \`${summary.runId}\``,
    `- Outcome: \`${summary.outcome}\``,
    `- Complete: \`${summary.complete}\``,
    `- Process management: \`${processManagement.mode}\``,
    '',
    '| Suite | Skills | Profile | Split | Outcome |',
    '| --- | --- | --- | --- | --- |',
    ...suiteRows,
    '',
    '完整 subject、trace 和 suite 报告保存在同目录的 `raw/`。',
    '',
  ].join('\n');
  await fs.writeFile(path.join(options.layout.reportRoot, 'report.md'), report, 'utf8');
}

export async function runPluginEvals(
  args: string[],
  options: PluginEvalRunnerOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  if (args.includes('-h') || args.includes('--help')) {
    stdout(`${usage()}\n`);
    return 0;
  }
  try {
    const executionPlanPath = awSkillEvalExecutionPlanPath(args);
    if (executionPlanPath) {
      const result = await runAwSkillEvalExecutionPlan(executionPlanPath, {
        sourceEnv: options.env ?? process.env,
        platform: options.platform,
        processTree: options.evalProcessTree,
      });
      stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.requirementsMet ? 0 : 1;
    }
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const env = options.env ?? process.env;
  const repoRoot = path.resolve(
    options.repoRoot ?? env[REPO_ROOT_ENV] ?? resolveRepoRoot(),
  );
  let prepared: PreparedPluginEval;
  if ((parsed.batchName ? 1 : 0) + (parsed.batchId ? 1 : 0) !== 1) {
    if (options.createRunLayout && !parsed.batchName && !parsed.batchId) {
      parsed.batchName = 'test-batch';
    } else {
      stderr('Provide exactly one of --batch-name or --batch-id.\n');
      return 2;
    }
  }
  try {
    prepared = await preparePluginEval({
      repoRoot,
      pluginName: parsed.pluginName!,
      skillName: parsed.skillName!,
      parsed,
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let codexRuntime: CodexEvalRuntimeConfig | undefined;
  let processManagement: PluginEvalProcessManagementEvidence = {
    mode: 'not-applicable',
    inspectionAvailable: false,
    userAcknowledged: false,
    descendantCleanupGuaranteed: false,
  };
  if (!parsed.materializeOnly) {
    try {
      processManagement = await resolveCodexEvalProcessManagement({
        allowUnmanaged: parsed.allowUnmanagedProcesses,
        sourceEnv: env,
        preflight: () => assertCodexEvalKeychainWrapperAbsent({
          platform: options.platform,
          readUserKeychainSearchList: options.readUserKeychainSearchList,
        }),
        inspect: options.inspectProcessTree,
        platform: options.platform,
      });
      codexRuntime = await resolveCodexEvalRuntimeConfig({
        sourceEnv: env,
        inheritUserConfig: parsed.inheritCodexConfig,
        configPath: parsed.codexConfig,
        modelOverride: parsed.model,
        modelProviderOverride: parsed.modelProvider,
      });
    } catch (error) {
      stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    if (processManagement.mode === 'unmanaged-confirmed') {
      stderr(
        '[plugin:eval] WARNING: unmanaged process cleanup was explicitly confirmed. ' +
        'No process-tree inspection was used, and this run does not track or verify descendant cleanup. ' +
        'Timeout and signal cleanup only target the direct child.\n',
      );
    }
  }
  const sourceRevision = await readSourceRevision({
    repoRoot,
    pluginNames: prepared.sourcePlugins.map((plugin) => plugin.manifest.name),
  });
  const sourceDigest = await computeAuthorSourceDigest(
    prepared.sourcePlugins.map((plugin) => ({
      name: plugin.manifest.name,
      root: plugin.rootDir,
    })),
  );
  const environmentDigest = createEnvironmentDigest({
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  });
  const modelEnvironmentDigest = parsed.materializeOnly ? null : createEnvironmentDigest({
    model: parsed.model ?? codexRuntime?.model ?? null,
    modelProvider: codexRuntime?.modelProvider ?? null,
    codexConfigDigest: codexRuntime?.evidenceDigest ?? null,
    codexVersion: await readCodexVersion(parsed.codexBin, env),
    processManagement: publicProcessManagement(processManagement),
  });
  const harnessRepoRoot = resolveRepoRoot();
  const harnessDigest = await computeAuthorSourceDigest([
    { name: 'packages/cli/scripts', root: path.join(harnessRepoRoot, 'packages', 'cli', 'scripts') },
    { name: 'packages/cli/src', root: path.join(harnessRepoRoot, 'packages', 'cli', 'src') },
  ]);
  const requiredTargets = pluginReleaseTargets(prepared.manifest);
  const targetCompositions = await releaseTargetCompositions(prepared);
  let layout: EvalRunLayout;
  try {
    layout = await (options.createRunLayout ?? createPluginEvalRunLayout)({
      repoRoot,
      plugin: parsed.pluginName!,
      skill: parsed.skillName!,
      batchName: parsed.batchName,
      batchId: parsed.batchId,
      runId: parsed.runId,
      source: {
        digest: sourceDigest,
        gitHead: sourceRevision.gitHead,
        inScopeDirty: sourceRevision.inScopeDirty,
      },
      environmentDigest,
      modelEnvironmentDigest,
      harnessDigest,
      requiredTargets,
      targetCompositions,
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const startedAt = layout.startedAt;
  await writeEvalRunJson(layout.reportRoot, 'run.json', {
    schemaVersion: 1,
    type: 'plugin-skill-eval',
    runId: layout.runId,
    plugin: parsed.pluginName,
    skill: parsed.skillName,
    status: 'running',
    startedAt,
    pid: layout.pid,
    host: layout.host,
    processManagement: publicProcessManagement(processManagement),
    source: sourceRevision,
    rawDirectory: 'raw',
  });
  stderr(
    `[plugin:eval] run=${layout.runId} report=${path.relative(repoRoot, layout.reportRoot)}\n`,
  );
  if (!parsed.materializeOnly) {
    stderr(
      '[plugin:eval] Model evals can run for tens of minutes or hours. Keep this process ' +
        'session open and use the longest responsive wait that the tool allows. A wait timeout ' +
        'is not an eval failure. Do not start separate status-poll commands.\n',
    );
  }
  let runtimeCapsule: Awaited<ReturnType<typeof createCodexEvalRuntimeCapsule>> | undefined;
  let exitCode = 1;
  try {
    runtimeCapsule = codexRuntime
      ? await createCodexEvalRuntimeCapsule(codexRuntime, env, {
          allocate: () => fs.mkdtemp(path.join(layout.workRoot, 'runtime-')),
        })
      : undefined;
    assertCodexEvalCanStartWork();
    const bundle = await runOnePlugin({
      sourcePlugin: prepared.sourcePlugin,
      sourcePlugins: prepared.sourcePlugins,
      manifest: prepared.manifest,
      parsed,
      outputRoot: layout.rawRoot,
      workRoot: layout.workRoot,
      processManagement,
      env,
      modelEnv: runtimeCapsule?.env ?? env,
      codexRuntime,
      codexRuntimeHome: runtimeCapsule?.home,
      layout,
      stderr,
    });
    await runtimeCapsule?.cleanup();
    runtimeCapsule = undefined;
    await writePublishedEvalReport({
      layout,
      bundle,
      sourceRevision,
    });
    const batchSummary = parsed.materializeOnly
      ? await publishEvalRunToBatch({
          repoRoot,
          layout,
          evaluation: bundle,
          caseId: parsed.caseId,
          requiredTargets,
        })
      : await completeSkillEvalRun({ layout, evaluation: bundle });
    stdout(`${JSON.stringify({
      schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
      batchId: layout.batchId,
      batchDir: path.relative(repoRoot, layout.batchRoot).split(path.sep).join('/'),
      batchSummary,
      runId: layout.runId,
      reportDir: path.relative(repoRoot, layout.reportRoot).split(path.sep).join('/'),
      bundle,
    }, null, 2)}\n`);
    exitCode = bundle.outcome === 'failed' || bundle.outcome === 'incomplete' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const safeMessage = codexRuntime ? redactCodexEvalText(message, codexRuntime) : message;
    stderr(`${parsed.pluginName}: ${safeMessage}\n`);
    await fs.writeFile(path.join(layout.rawRoot, 'error.txt'), `${safeMessage}\n`, 'utf8');
    try {
      await failSkillEvalRun({
        layout,
        message: safeMessage,
      });
    } catch (refreshError) {
      stderr(`Failed to mark the report run as failed: ${
        refreshError instanceof Error ? refreshError.message : String(refreshError)
      }\n`);
    }
    exitCode = 1;
  } finally {
    try {
      await runtimeCapsule?.cleanup();
    } catch (error) {
      stderr(`Runtime capsule cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`);
      exitCode = 1;
    }
    try {
      await layout.cleanupWork();
    } catch (error) {
      stderr(`Eval work directory cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

const currentEntryPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentEntryPath) {
  runPluginEvals(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
