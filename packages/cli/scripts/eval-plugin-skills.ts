import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import fs from 'fs-extra';

import type { PluginMeta } from '../src/types.js';
import { readPluginManifest } from '../src/utils/manifest.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import { runCodexConversationSuite } from './codex-eval-app-server.js';
import { assertCodexEvalKeychainWrapperAbsent } from './codex-eval-isolation.js';
import { resolveCodexEvalProcessManagement } from './codex-eval-process-management.js';
import {
  CODEX_EVAL_PROCESS_TREE_ID_ENV,
  createChildProcessTreeMonitor,
  createDirectChildProcessMonitor,
  type ChildProcessTreeMonitor,
  processTreeCleanupIsUnconfirmed,
  releaseChildProcessHandles,
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
  createRunLayout?: typeof createPluginEvalRunLayout;
}

interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  processTreeId: string;
}

const DEFAULT_MANAGED_PROCESS_EVIDENCE: PluginEvalProcessManagementEvidence = {
  mode: 'managed',
  inspectionAvailable: true,
  userAcknowledged: false,
  descendantCleanupGuaranteed: true,
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
    '  --run-id <id>                 Use an explicit unique report run id',
    '  --materialize-only            Do not start real Codex model sessions',
    '  --allow-environment-skips     Diagnostic only; release remains incomplete',
    '  --allow-unmanaged-processes   Confirm eval without descendant process tracking',
  ].join('\n');
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
    spawnChild?: (
      command: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcessWithoutNullStreams;
    createProcessTreeMonitor?: (
      child: ChildProcess,
      treeId: string,
    ) => ChildProcessTreeMonitor;
  },
): Promise<ChildResult> {
  assertCodexEvalCanStartWork();
  return new Promise((resolve, reject) => {
    const processTreeId = randomUUID();
    const processManagement = options.processManagement ?? DEFAULT_MANAGED_PROCESS_EVIDENCE;
    const managed = processManagement.mode === 'managed';
    const child = (options.spawnChild ?? spawn)(command, args, {
      cwd: options.cwd,
      env: managed
        ? { ...options.env, [CODEX_EVAL_PROCESS_TREE_ID_ENV]: processTreeId }
        : { ...options.env },
      shell: false,
      detached: managed && process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const processTreeMonitor = managed
      ? options.createProcessTreeMonitor
        ? options.createProcessTreeMonitor(child, processTreeId)
        : createChildProcessTreeMonitor(child, { treeId: processTreeId })
      : createDirectChildProcessMonitor(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let executionClosed = false;
    let settled = false;
    let closeResult: Pick<ChildResult, 'exitCode' | 'signal'> | undefined;
    let terminationPromise: Promise<string[]> | undefined;
    const terminateTree = (): Promise<string[]> => {
      terminationPromise ??= processTreeMonitor.terminate();
      return terminationPromise;
    };
    const unregisterSignalCleanup = registerCodexEvalSignalCleanup(async () => {
      try {
        const terminationDiagnostics = await terminateTree();
        if (terminationDiagnostics.length > 0) {
          stderr += `${terminationDiagnostics.join('\n')}\n`;
        }
      } catch (error) {
        stderr += `Failed to terminate command suite process tree during signal cleanup: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
      }
    });
    const timeoutTimer = setTimeout(() => {
      if (executionClosed) return;
      timedOut = true;
      const message = `Suite exceeded central timeout of ${options.timeoutMs}ms.`;
      stderr += `${message}\n`;
      void terminateTree().then((terminationDiagnostics) => {
        if (terminationDiagnostics.length > 0) {
          stderr += `${terminationDiagnostics.join('\n')}\n`;
        }
        releaseChildProcessHandles(child);
        finish(
          closeResult?.exitCode ?? child.exitCode,
          closeResult?.signal ?? child.signalCode ?? 'SIGKILL',
        );
      }, (error: unknown) => {
        stderr += `Failed to terminate command suite process tree: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
        releaseChildProcessHandles(child);
        finish(child.exitCode, child.signalCode ?? 'SIGKILL');
      });
    }, options.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      unregisterSignalCleanup();
    };
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const safeStdout = stdout.replaceAll(processTreeId, '[process-tree-id]');
      const safeStderr = stderr.replaceAll(processTreeId, '[process-tree-id]');
      if (safeStderr) {
        const rendered = options.redact ? options.redact(safeStderr) : safeStderr;
        options.stderr(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
      }
      resolve({
        exitCode,
        signal,
        stdout: safeStdout,
        stderr: safeStderr,
        timedOut,
        processTreeId,
      });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (timedOut) {
        stderr += `${error.message}\n`;
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      void terminateTree().then(
        () => reject(error),
        () => reject(error),
      );
    });
    child.once('close', (exitCode, signal) => {
      closeResult = { exitCode, signal };
      if (timedOut) return;
      executionClosed = true;
      clearTimeout(timeoutTimer);
      void terminateTree().then((terminationDiagnostics) => {
        if (timedOut) return;
        if (terminationDiagnostics.length > 0) {
          stderr += `${terminationDiagnostics.join('\n')}\n`;
        }
        finish(
          processTreeCleanupIsUnconfirmed(terminationDiagnostics) && exitCode === 0
            ? 1
            : exitCode,
          signal,
        );
      }, (error: unknown) => {
        if (timedOut) return;
        stderr += `Failed to terminate command suite process tree after close: ${
          error instanceof Error ? error.message : String(error)
        }\n`;
        finish(exitCode === 0 ? 1 : exitCode, signal);
      });
    });
  });
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
}): Promise<PluginEvalSuiteReport> {
  const sanitize = (report: PluginEvalSuiteReport): PluginEvalSuiteReport =>
    redactCodexEvalValue(report, options.codexRuntime);
  const reportName = [options.suite.id, options.split, options.profile]
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
    timeoutMs: options.suite.suiteTimeoutMs,
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
        `Suite exceeded central timeout of ${options.suite.suiteTimeoutMs}ms.`,
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
    await fs.writeJson(reportPath, report, { spaces: 2 });
    const complete = report.complete !== false;
    const passed = report.passed === true && result.exitCode === 0;
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
    for (const suite of selectedSuites(manifest, options.parsed)) {
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
          if (suite.kind === 'conversation') {
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
            const report = await runCodexConversationSuite({
              suiteId: suite.id,
              skillName: suite.skill,
              skillNames: suite.skills,
              casesPath: path.resolve(sourcePlugin.rootDir, suite.cases.replace(/^\.\//u, '')),
              subjectRoot,
              profile,
              runs: options.parsed.runs ?? suite.defaultRuns,
              caseId: options.parsed.caseId,
              codexBin: options.parsed.codexBin,
              model: options.parsed.model,
              codexRuntime: options.codexRuntime,
              timeoutMs: suite.perRunTimeoutMs,
              isolation: suite.isolation,
              sourceEnv: options.modelEnv,
              reportPath,
              processManagement: options.processManagement,
              workRoot: path.join(options.workRoot, 'conversation'),
            });
            report.reportPath = path.relative(outputRoot, reportPath).split(path.sep).join('/');
            reports.push(report);
          } else if (suite.kind === 'trigger') {
            const triggerSplit = split ?? 'all';
            const reportPath = path.join(
              outputRoot,
              'reports',
              `${suite.id}-${triggerSplit}-${profile}.json`,
            );
            const report = await runCodexTriggerSuite({
              suite,
              split: triggerSplit,
              subjectRoot,
              pluginRoot: sourcePlugin.rootDir,
              profile,
              runs: options.parsed.runs ?? suite.defaultRuns,
              caseId: options.parsed.caseId,
              codexBin: options.parsed.codexBin,
              model: options.parsed.model,
              codexRuntime: options.codexRuntime,
              sourceEnv: options.modelEnv,
              reportPath,
              stderr: options.stderr,
              processManagement: options.processManagement,
              workRoot: path.join(options.workRoot, 'trigger'),
            });
            report.reportPath = path.relative(outputRoot, reportPath).split(path.sep).join('/');
            reports.push(report);
          } else {
            reports.push(await runCommandSuite({
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
            }));
          }
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
        '.agents/skills/create-agent-workflows-plugin',
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
  };
}

async function writePublishedEvalReport(options: {
  layout: EvalRunLayout;
  bundle: PluginEvaluationBundle;
  sourceRevision: { gitHead: string | null; inScopeDirty: boolean };
  startedAt: string;
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
  await writeEvalRunJson(options.layout.reportRoot, 'run.json', {
    schemaVersion: 1,
    type: 'plugin-skill-eval',
    runId: options.layout.runId,
    plugin: options.bundle.plugin,
    skill: options.bundle.skill,
    status: 'completed',
    startedAt: options.startedAt,
    completedAt: new Date().toISOString(),
    outcome: options.bundle.outcome,
    processManagement,
    source: options.sourceRevision,
    rawDirectory: 'raw',
  });
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
      await assertCodexEvalKeychainWrapperAbsent({
        platform: options.platform,
        readUserKeychainSearchList: options.readUserKeychainSearchList,
      });
      processManagement = await resolveCodexEvalProcessManagement({
        allowUnmanaged: parsed.allowUnmanagedProcesses,
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
        '[plugin:eval] WARNING: Full Access process inspection is unavailable. ' +
        'This confirmed run does not track or verify descendant processes. ' +
        'Timeout and signal cleanup only target the direct child.\n',
      );
    }
  }
  let layout: EvalRunLayout;
  try {
    layout = await (options.createRunLayout ?? createPluginEvalRunLayout)({
      repoRoot,
      skillRoot: prepared.skillRoot,
      plugin: parsed.pluginName!,
      skill: parsed.skillName!,
      runId: parsed.runId,
    });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const startedAt = new Date().toISOString();
  const sourceRevision = await readSourceRevision({
    repoRoot,
    pluginNames: prepared.sourcePlugins.map((plugin) => plugin.manifest.name),
  });
  await writeEvalRunJson(layout.reportRoot, 'run.json', {
    schemaVersion: 1,
    type: 'plugin-skill-eval',
    runId: layout.runId,
    plugin: parsed.pluginName,
    skill: parsed.skillName,
    status: 'running',
    startedAt,
    processManagement: publicProcessManagement(processManagement),
    source: sourceRevision,
    rawDirectory: 'raw',
  });
  stderr(
    `[plugin:eval] run=${layout.runId} report=${path.relative(repoRoot, layout.reportRoot)}\n`,
  );
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
      stderr,
    });
    await runtimeCapsule?.cleanup();
    runtimeCapsule = undefined;
    await writePublishedEvalReport({
      layout,
      bundle,
      sourceRevision,
      startedAt,
    });
    stdout(`${JSON.stringify({
      schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
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
    await writeEvalRunJson(layout.reportRoot, 'run.json', {
      schemaVersion: 1,
      type: 'plugin-skill-eval',
      runId: layout.runId,
      plugin: parsed.pluginName,
      skill: parsed.skillName,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      processManagement: publicProcessManagement(processManagement),
      source: sourceRevision,
      rawDirectory: 'raw',
    });
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
