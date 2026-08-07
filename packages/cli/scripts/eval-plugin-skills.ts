import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { discoverPlugins, readPluginManifest } from '../src/utils/manifest.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import { runCodexConversationSuite } from './codex-eval-app-server.js';
import {
  createCodexEvalRuntimeCapsule,
  redactCodexEvalText,
  redactCodexEvalValue,
  resolveCodexEvalRuntimeConfig,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js';
import { runCodexTriggerSuite } from './codex-trigger-eval.js';
import {
  combinePluginEvalOutcome,
  PLUGIN_EVAL_SCHEMA_VERSION,
  readPluginEvalManifest,
  type MaterializedPluginEvalSubject,
  type PluginEvaluationBundle,
  type PluginEvalCommandSuite,
  type PluginEvalManifest,
  type PluginEvalOutcome,
  type PluginEvalSplit,
  type PluginEvalSuite,
  type PluginEvalSuiteReport,
} from './plugin-eval-contract.js';
import {
  materializePluginEvalSubjects,
  resolveMaterializedSubjectRoot,
} from './plugin-eval-materializer.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT_ENV = 'AW_PLUGIN_EVAL_REPO_ROOT';

interface ParsedArgs {
  pluginName?: string;
  all: boolean;
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
  outputDir?: string;
  materializeOnly: boolean;
  allowEnvironmentSkips: boolean;
}

export interface PluginEvalRunnerOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const COMMAND_TIMEOUT_GRACE_MS = 1_000;

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
    'Usage: pnpm plugin:eval <plugin> | --all [OPTIONS]',
    '',
    'Options:',
    '  --suite <id>                  Run one suite',
    '  --profile <id>                Select one materialization profile',
    '  --split <train|validation|sanity|all>',
    '  --case <id>                   Run one case (requires --suite)',
    '  --runs <count>                Override repetitions per case',
    '  --model <model>               Override the parent Codex model',
    '  --model-provider <id>         Override the inherited Codex model provider',
    '  --codex-config <path>         Read model/provider config from this config.toml',
    '  --no-inherit-codex-config     Use a clean official Codex provider config',
    '  --codex-bin <path>            Codex executable (default: codex)',
    '  --output-dir <path>           Persist subjects and reports',
    '  --materialize-only            Do not start real Codex model sessions',
    '  --allow-environment-skips     Diagnostic only; release remains incomplete',
  ].join('\n');
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    all: false,
    codexBin: 'codex',
    inheritCodexConfig: true,
    materializeOnly: false,
    allowEnvironmentSkips: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--all') {
      parsed.all = true;
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
    if (arg === '--no-inherit-codex-config') {
      parsed.inheritCodexConfig = false;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      throw new Error(usage());
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
    if (arg === '--output-dir') {
      parsed.outputDir = path.resolve(optionValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".\n\n${usage()}`);
    }
    positional.push(arg);
  }
  if (parsed.all && positional.length > 0) {
    throw new Error('Use either <plugin> or --all, not both.');
  }
  if (!parsed.all && positional.length !== 1) {
    throw new Error(usage());
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
      parsed.allowEnvironmentSkips
    )
  ) {
    throw new Error(
      '--materialize-only supports target/profile/output selection, not suite model-run flags.',
    );
  }
  parsed.pluginName = positional[0];
  if (parsed.pluginName && !/^[a-z0-9][a-z0-9-]*$/u.test(parsed.pluginName)) {
    throw new Error('Plugin name must use lowercase kebab-case without path separators.');
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
  },
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      const message = `Suite exceeded central timeout of ${options.timeoutMs}ms.`;
      stderr += `${message}\n`;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, COMMAND_TIMEOUT_GRACE_MS);
      finalTimer = setTimeout(() => {
        finish(child.exitCode, child.signalCode ?? 'SIGKILL');
      }, COMMAND_TIMEOUT_GRACE_MS * 2);
    }, options.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finalTimer) clearTimeout(finalTimer);
    };
    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stderr) {
        const rendered = options.redact ? options.redact(stderr) : stderr;
        options.stderr(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
      }
      resolve({ exitCode, signal, stdout, stderr, timedOut });
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
        finish(child.exitCode, child.signalCode);
        return;
      }
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

function supports(
  suite: PluginEvalCommandSuite,
  capability: PluginEvalCommandSuite['supports'][number],
): boolean {
  return suite.supports.includes(capability);
}

function parseCommandReport(stdout: string, reportPath: string): Record<string, unknown> {
  let candidate = stdout.trim();
  if (fs.pathExistsSync(reportPath)) {
    candidate = fs.readFileSync(reportPath, 'utf8').trim();
  }
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
    `${reportName}.json`,
  );
  await fs.ensureDir(path.dirname(reportPath));
  await fs.ensureDir(path.dirname(rawReportPath));
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
    },
    stderr: options.stderr,
    redact: (value) => redactCodexEvalText(value, options.codexRuntime),
    timeoutMs: options.suite.suiteTimeoutMs,
  });
  if (result.timedOut) {
    return sanitize({
      id: options.suite.id,
      kind: 'command',
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
      parseCommandReport(result.stdout, rawReportPath),
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
  repoRoot: string;
  pluginName: string;
  parsed: ParsedArgs;
  rootOutput: string;
  env: NodeJS.ProcessEnv;
  modelEnv: NodeJS.ProcessEnv;
  codexRuntime?: CodexEvalRuntimeConfig;
  codexRuntimeHome?: string;
  stderr: (text: string) => void;
}): Promise<PluginEvaluationBundle> {
  const sourcePlugin = await readPluginManifest(
    path.join(options.repoRoot, 'plugins', options.pluginName),
  );
  const manifest = await readPluginEvalManifest(sourcePlugin.rootDir, sourcePlugin.manifest.name);
  const outputRoot = path.join(options.rootOutput, sourcePlugin.manifest.name);
  await fs.ensureDir(outputRoot);
  const selectedProfiles = options.parsed.profile
    ? new Set([options.parsed.profile])
    : undefined;
  if (
    options.parsed.profile &&
    !manifest.profiles.some((profile) => profile.id === options.parsed.profile)
  ) {
    throw new Error(`Unknown profile "${options.parsed.profile}".`);
  }
  const subjects = await materializePluginEvalSubjects({
    plugin: sourcePlugin,
    manifest,
    outputRoot,
    env: options.env,
    selectedProfiles,
  });
  const reports: PluginEvalSuiteReport[] = [];
  if (!options.parsed.materializeOnly) {
    for (const suite of selectedSuites(manifest, options.parsed)) {
      assertSuiteSupportsRequestedOptions(suite, options.parsed);
      for (const profile of resolveSuiteProfiles(suite, options.parsed)) {
        const subject = subjects.find((entry) => entry.profile === profile);
        if (!subject) {
          throw new Error(`Profile "${profile}" was not materialized.`);
        }
        const subjectRoot = resolveMaterializedSubjectRoot(outputRoot, subject);
        for (const split of resolveSuiteSplits(suite, options.parsed)) {
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
              casesPath: path.resolve(sourcePlugin.rootDir, suite.cases.replace(/^\.\//u, '')),
              subjectRoot,
              profile,
              runs: options.parsed.runs ?? suite.defaultRuns,
              caseId: options.parsed.caseId,
              codexBin: options.parsed.codexBin,
              model: options.parsed.model,
              codexRuntime: options.codexRuntime,
              timeoutMs: suite.perRunTimeoutMs,
              sourceEnv: options.modelEnv,
              reportPath,
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
            });
            report.reportPath = path.relative(outputRoot, reportPath).split(path.sep).join('/');
            reports.push(report);
          } else {
            reports.push(await runCommandSuite({
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
              stderr: options.stderr,
            }));
          }
        }
      }
    }
  }
  const outcome = options.parsed.materializeOnly ? 'passed' : combinePluginEvalOutcome(reports);
  const unredactedBundle: PluginEvaluationBundle = {
    schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    plugin: sourcePlugin.manifest.name,
    pluginVersion: sourcePlugin.manifest.version,
    platform: 'codex',
    codexVersion: options.parsed.materializeOnly
      ? null
      : await readCodexVersion(options.parsed.codexBin, options.modelEnv),
    model: options.parsed.model ?? options.codexRuntime?.model ?? null,
    modelProvider: options.codexRuntime?.modelProvider ?? null,
    credentialSource: options.codexRuntime?.credentialSource ?? null,
    codexConfigDigest: options.codexRuntime?.evidenceDigest ?? null,
    outcome,
    complete: options.parsed.materializeOnly || reports.every((report) => report.complete),
    mechanicalPassed: options.parsed.materializeOnly || reports.every(
      (report) => report.mechanicalPassed,
    ),
    subjects,
    suites: reports,
    diagnostics: [],
  };
  const bundle = options.codexRuntime
    ? redactCodexEvalValue(unredactedBundle, options.codexRuntime)
    : unredactedBundle;
  await fs.writeJson(path.join(outputRoot, 'evaluation.json'), bundle, { spaces: 2 });
  return bundle;
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
  const temporaryOutput = parsed.outputDir === undefined;
  const rootOutput = parsed.outputDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-'));
  let runtimeCapsule: Awaited<ReturnType<typeof createCodexEvalRuntimeCapsule>> | undefined;
  try {
    let codexRuntime: CodexEvalRuntimeConfig | undefined;
    try {
      codexRuntime = parsed.materializeOnly
        ? undefined
        : await resolveCodexEvalRuntimeConfig({
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
    runtimeCapsule = codexRuntime
      ? await createCodexEvalRuntimeCapsule(codexRuntime, env)
      : undefined;
    const pluginNames = parsed.all
      ? (await discoverPlugins(repoRoot)).map((plugin) => plugin.manifest.name)
      : [parsed.pluginName!];
    const bundles: PluginEvaluationBundle[] = [];
    let hadError = false;
    for (const pluginName of pluginNames) {
      try {
        bundles.push(await runOnePlugin({
          repoRoot,
          pluginName,
          parsed,
          rootOutput,
          env,
          modelEnv: runtimeCapsule?.env ?? env,
          codexRuntime,
          codexRuntimeHome: runtimeCapsule?.home,
          stderr,
        }));
      } catch (error) {
        hadError = true;
        stderr(`${pluginName}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      }
    }
    stdout(`${JSON.stringify({
      schemaVersion: PLUGIN_EVAL_SCHEMA_VERSION,
      outputDir: temporaryOutput ? null : rootOutput,
      bundles,
    }, null, 2)}\n`);
    if (hadError || bundles.some((bundle) =>
      bundle.outcome === 'failed' || bundle.outcome === 'incomplete')) {
      return 1;
    }
    return 0;
  } finally {
    await runtimeCapsule?.cleanup();
    if (temporaryOutput) {
      await fs.remove(rootOutput);
    }
  }
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
