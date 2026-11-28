#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { clients, repoRoot, sha256, prepareEnvironment, execute, assertCommand,
  acquireClient, readManagedTrace, renderPackage, writeCandidate, hostInfo, processManagementInfo, fixedClientVersion } from './native-platform-runtime.mjs';
import { qualifyClient } from './native-platform-clients.mjs';
import { qualificationGroup } from './native-platform-qualification-group.mjs';
import { qualifyPublicAw, preparePublicClientEntry } from './native-platform-public-aw.mjs';
import { mixedNativeInstallIntervals, mixedNativePlatforms, qualifyMixedPublicAw } from './native-platform-public-batch.mjs';
import { executePublicAw, publicAwNodeLauncher } from './native-platform-public-process.mjs';
import { readPublicAwStages } from './native-platform-stage-evidence.mjs';

const usage = 'node scripts/qualification/native-platforms.mjs --candidate <manifest> --client <all|client[,client...]> --report <file> (--install | --executable <absolute-path>) [--public-aw] [--mixed-native-aw]'
  + `\nClients are ${Object.keys(clients).join(', ')}.`;
class Unverified extends Error {}

function selectPlatforms(selection) {
  if (selection === 'all') return Object.keys(clients);
  const platforms = selection?.split(',') ?? [];
  if (!platforms.length || platforms.some(platform => !Object.hasOwn(clients, platform))
    || new Set(platforms).size !== platforms.length) throw new Error('invalid-arguments');
  return platforms;
}

export function clientCacheIdentity(selection) {
  const manifest = selectPlatforms(selection).sort().map(platform => {
    const client = clients[platform];
    return [platform, client.package, client.version];
  });
  return sha256(JSON.stringify(manifest));
}

function distributionExcluded(platform, host) {
  return platform === 'grok' && (host.platform === 'darwin' && host.arch === 'x64'
    || host.platform === 'win32' && host.arch === 'arm64');
}

// Each acquisition is attached only after the fixed package and its entry have been resolved.
export function clientCacheComplete(selection, report, host = process) {
  const selected = selectPlatforms(selection);
  if (!Array.isArray(report?.clients) || report.clients.length !== selected.length
    || selected.every(platform => distributionExcluded(platform, host))) return false;
  return selected.every(platform => {
    const result = report.clients.find(item => item?.platform === platform);
    if (distributionExcluded(platform, host)) {
      return result?.status === 'excluded' && result.reason === 'official-client-distribution-unavailable';
    }
    const acquisition = result?.acquisition;
    return acquisition?.package === clients[platform].package && acquisition.version === clients[platform].version
      && acquisition.source === clients[platform].source && acquisition.download?.status === 'completed';
  });
}

export function parseArgs(args) {
  const options = {};
  const names = new Set(['candidate', 'client', 'report', 'executable', 'write-candidate', 'source-sha']);
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/u, '');
    if (!args[index].startsWith('--') || Object.hasOwn(options, key)) throw new Error('invalid-arguments');
    if (['install', 'public-aw', 'mixed-native-aw'].includes(key)) { options[key] = true; continue; }
    if (!names.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid-arguments');
    options[key] = args[++index];
  }
  if (options['write-candidate']) {
    if (Object.keys(options).length !== 2 || !options['source-sha']) throw new Error('invalid-arguments');
    return options;
  }
  const platforms = selectPlatforms(options.client);
  if (!options.candidate || !options.report
    || Boolean(options.install) === Boolean(options.executable)
    || options.executable && (platforms.length !== 1 || !path.isAbsolute(options.executable))
    || Object.keys(options).some((key) => ['write-candidate', 'source-sha'].includes(key))) throw new Error('invalid-arguments');
  if (options['mixed-native-aw'] && (!options.install || !options['public-aw']
    || !mixedNativePlatforms.every(platform => platforms.includes(platform)))) throw new Error('invalid-arguments');
  return options;
}

export function redact(value, root, clientBin) {
  const clientBins = Array.isArray(clientBin) ? clientBin : [clientBin];
  const replace = (text) => {
    for (const [directory, label] of [[root, '<TEMP_ROOT>'], ...clientBins.map(bin => [bin, '<CLIENT_BIN>']), [os.homedir(), '<HOST_HOME>']]) {
      if (!directory) continue;
      const escaped = JSON.stringify(directory).slice(1, -1);
      for (const spelling of [directory, directory.replaceAll('\\', '/'), escaped, JSON.stringify(escaped).slice(1, -1)]) {
        text = text.replaceAll(spelling, label);
      }
    }
    return text;
  };
  if (typeof value === 'string') return replace(value).slice(0, 4000);
  if (Array.isArray(value)) return value.map((item) => redact(item, root, clientBin));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, root, clientBin)]));
  return value;
}

export function versionFrom(output) {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?=$|\s|\(|\.(?:\s|$))/u.exec(output.trim())?.[1] ?? null;
}

export function aggregateQualificationStatus(statuses) {
  const required = statuses.filter(status => status !== 'excluded');
  if (!required.length) return statuses.length ? 'excluded' : 'unverified';
  if (required.some(status => status === 'failed')) return 'failed';
  return required.every(status => status === 'passed') ? 'passed' : 'unverified';
}

export function requiredPublicChecks(platform, scope) {
  if (scope === 'project') {
    return ['claude', 'pi', 'opencode'].includes(platform) ? [`public-${platform}-manual-skill`] : [];
  }
  return [`public-${platform}-manual-skill`, ...(platform === 'grok' ? [] : ['public-shipped-git-toolkit-install'])];
}

// Discovery observations do not grade management, consumer content or scope.
// Their commands retain the same process safety gates as required checks.
export async function observeQualification(report, id, action, root, clientBin) {
  const observation = { id, status: 'failed' };
  report.observations.push(observation);
  const start = report.commands.length;
  const processFailed = () => report.commands.slice(start).some(command =>
    Object.hasOwn(command, 'processFailure') || command.timedOut || command.maxBufferExceeded
    || command.cancelled || command.terminationReason && command.terminationReason !== 'complete');
  try {
    const evidence = await action() ?? {};
    if (processFailed()) throw new Error('observation-process-failed');
    observation.evidence = redact(evidence, root, clientBin);
    observation.status = 'observed';
    return { status: observation.status, evidence: observation.evidence };
  } catch (error) {
    observation.reason = redact(error?.message ?? 'observation-unverified', root, clientBin);
    if (processFailed() || error && typeof error === 'object'
      && ['processTreeDiagnostics', 'publicAwProcessDiagnostics'].some(key => Object.hasOwn(error, key))) {
      if (error instanceof Unverified) throw new Error('observation-process-failed', { cause: error });
      throw error;
    }
    observation.status = 'unverified';
    return { status: observation.status, reason: observation.reason };
  }
}

// The raw command preview remains bounded. Preserve selected failure facts from
// the complete public JSON before that preview truncates a deployment receipt.
export function publicAwFailureSummary(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return { state: 'invalid-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid-json' };
  const list = (items, limit) => Array.isArray(items) ? items.slice(0, limit) : [];
  const fields = (item, keys) => Object.fromEntries(keys.filter((key) => typeof item?.[key] === 'string')
    .map((key) => [key, item[key]]));
  const diagnostics = (items) => list(items, 8).map((item) => fields(item, ['code', 'severity', 'message']));
  return { state: 'parsed', ...fields(value, ['command', 'status']), diagnostics: diagnostics(value.diagnostics),
    ...(value.command === 'plugin.status' ? { counts: Object.fromEntries(['blocked', 'pending', 'unconfirmed', 'ready']
      .filter(key => Number.isSafeInteger(value.data?.counts?.[key])).map(key => [key, value.data.counts[key]])),
      allSatisfied: value.data?.allSatisfied === true || value.data?.allSatisfied === false ? value.data.allSatisfied : null,
      inSync: value.data?.inSync === true || value.data?.inSync === false ? value.data.inSync : null } : {}),
    targets: list(value.data?.targetResults ?? list(value.data?.inventory, 4)
      .flatMap((entry) => list(entry?.targetResults, 4)), 4).map((target) => ({
      ...fields(target, ['pluginId', 'target', 'scope', 'execution', 'observation', 'content']),
      blockerCodes: list(target?.blockerCodes, 8).filter((item) => typeof item === 'string'),
      ...(value.command === 'plugin.status' ? { deployments: list(target?.deploymentObservations, 4).map((item) => ({
        ...fields(item?.after, ['package', 'registration', 'ownership']),
        consumers: list(item?.after?.consumers, 4).map((consumer) => fields(consumer, ['activation', 'load'])),
      })) } : {}),
      receipts: list(target?.deploymentReceipts, 4).map((receipt) => ({
        after: { ...fields(receipt?.after, ['package', 'registration', 'ownership']),
          nativeIdentity: fields(receipt?.after?.nativeIdentity, ['route', 'packageId', 'registrationId', 'sourceLocation']) },
        diagnostics: diagnostics(receipt?.diagnostics),
        effects: list(receipt?.effects, 8).map((effect) => ({ ...fields(effect, ['id', 'status', 'mutation']),
          diagnostics: diagnostics(effect?.diagnostics) })),
      })),
    })),
  };
}

export function readPublicAwEnvelope(stdout, expectedStatus) {
  const value = JSON.parse(stdout);
  if (value?.schemaVersion !== 2 || value.status !== expectedStatus) throw new Error('public-aw-unexpected-envelope');
  return value;
}

// Observe only this isolated fixture's generated marketplace entry, using
// the same parser as ownership inspection. Never retain the complete config.
export async function readQualificationCodexSources(home) {
  const sources = [];
  if (typeof home !== 'string' || !path.isAbsolute(home)) return { state: 'invalid-path', sources };
  try {
    const file = path.join(home, 'config.toml');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'unavailable', sources };
    if (stat.size > 1024 * 1024) return { state: 'over-limit', sources };
    const { readCodexConfigFile } = await import('../../packages/cli/dist/src/utils/codex-config.js');
    const { snapshot } = await readCodexConfigFile(file);
    const name = 'aw-qualification';
    const value = snapshot.marketplaces[name];
    if (value) {
      const absolute = typeof value.source === 'string' && path.isAbsolute(value.source);
      sources.push({ name, source: absolute ? value.source.slice(0, 2048) : null,
        sourceFormat: absolute ? 'absolute' : typeof value.source === 'string' ? 'other' : 'absent',
        sourceType: typeof value.sourceType === 'string' ? value.sourceType.slice(0, 64) : null,
        sourcePointsToManifest: value.sourcePointsToManifest });
    }
    return { state: 'captured-parser-projection', sources, omitted: 0 };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unavailable', sources }; }
}

export async function runScope(platform, scope, launcher, options = {}) {
  let root;
  const runUnit = options.group?.runUnit ?? (action => action());
  const mixedClients = options.mixedClients;
  const report = { scope, product: 'cli', input: mixedClients ? 'public-aw-mixed-native-cli' : options.publicAw ? 'public-aw-cli' : 'aw-projection-candidate',
    status: 'failed', checks: [], observations: [], commands: [], cleanup: 'pending' };
  const privateClientPaths = mixedClients ? [...mixedClients.values()].map(({ installRoot }) => installRoot) : options.clientBin;
  const redactScope = value => redact(value, root, privateClientPaths);
  try {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-qualification-')));
    const env = options.grokBinary ? await runUnit(() => prepareEnvironment(root, options.grokBinary)) : await prepareEnvironment(root);
    const project = path.join(root, 'project');
    const neutral = path.join(root, 'neutral');
    const marketplace = path.join(root, 'source');
    await fs.mkdir(project);
    await runUnit(async () => assertCommand(await execute({ executable: 'git', prefix: [] },
      ['init', '--quiet', '--template=', '--initial-branch=qualification', project], { cwd: root, env })));
    await fs.mkdir(neutral);
    const ctx = { platform, scope, root, env, project, neutral, marketplace, launcher, clientBin: options.clientBin,
      preparedClient: options.preparedClient, group: options.group, grokBinary: options.grokBinary,
      pluginName: 'aw-qualification', skillName: 'aw-qualification', marketplaceName: 'aw-qualification-market',
      bundle: path.join(marketplace, 'plugins', 'aw-qualification'),
      recordCommand(command) { report.commands.push(redactScope(command)); },
      async command(args, cwd = project, commandOptions = {}) {
        const nativeClient = commandOptions.nativeClient ?? platform;
        // Only the default launcher of the acquired fixed distribution has
        // this version evidence. Provided or alternate entries stay strict.
        const nativeClientVersion = nativeClient === platform && !commandOptions.entry && !commandOptions.launcher
          ? options.nativeClientVersion : undefined;
        let result;
        try {
          result = await execute(commandOptions.entry ? { executable: commandOptions.entry, prefix: [] } : commandOptions.launcher ?? launcher, args,
            { cwd, env, stdin: commandOptions.input,
            nativeClient, nativeClientVersion, captureProcessNames: nativeClient === 'copilot' });
        } catch (error) {
          report.commands.push(redactScope({ args, cwd, ...(mixedClients ? { nativeClient } : {}), processFailure: error?.message,
            processDiagnostics: error?.processTreeDiagnostics ?? error?.publicAwProcessDiagnostics ?? [],
            ...(error?.qualificationProcessNames?.length || error?.publicAwProcessNames?.length
              ? { processNames: error.qualificationProcessNames ?? error.publicAwProcessNames } : {}),
            ...(error?.qualificationMarkerRows?.length ? { markerRows: error.qualificationMarkerRows } : {}),
            ...(error?.qualificationMarkerIdentityConfirmations ? { markerIdentityConfirmations: error.qualificationMarkerIdentityConfirmations } : {}),
            ...(error?.publicAwProcessQueryTimings ? { processQueryTimings: error.publicAwProcessQueryTimings } : {}),
            ...(error?.result ? { exitCode: error.result.exitCode, signal: error.result.signal,
              terminationReason: error.result.terminationReason, timedOut: error.result.timedOut,
              cancelled: error.result.cancelled, stdout: error.result.stdout, stderr: error.result.stderr } : {}) }));
          throw error;
        }
        report.commands.push(redactScope({ args, cwd, ...(commandOptions.entry ? { entry: commandOptions.entry } : {}),
          ...(mixedClients ? { nativeClient } : {}),
          exitCode: result.exitCode, timedOut: result.timedOut,
          ...(result.markerIdentityConfirmations ? { markerIdentityConfirmations: result.markerIdentityConfirmations } : {}),
          ...(result.processQueryTimings ? { processQueryTimings: result.processQueryTimings } : {}),
          cancelled: result.cancelled, terminationReason: result.terminationReason,
          maxBufferExceeded: result.maxBufferExceeded, stdout: result.stdout, stderr: result.stderr,
          processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
            descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } }));
        if (!commandOptions.allowFailure) assertCommand(result);
        if (mixedClients && (result.cancelled || result.terminationReason !== 'complete')) throw new Error('mixed-native-read-incomplete');
        return result;
      },
      async rpc(cwd = project, { platform: nativePlatform = platform, launcher: nativeLauncher = launcher } = {}) {
        let result;
        try {
          result = await execute({ executable: process.execPath, prefix: [path.join(repoRoot, 'scripts/qualification/native-platform-rpc.mjs')] }, [], {
            cwd, env, timeoutMs: 25_000, stdin: JSON.stringify({ platform: nativePlatform, launcher: nativeLauncher, cwd }),
          });
        } catch (error) {
          report.commands.push(redactScope({ rpc: nativePlatform === 'codex' ? ['initialize', 'skills/list'] : ['get_commands', 'get_state'],
            ...(mixedClients ? { nativeClient: nativePlatform } : {}),
            ...(error?.publicAwProcessQueryTimings ? { processQueryTimings: error.publicAwProcessQueryTimings } : {}),
            ...(error?.qualificationMarkerIdentityConfirmations ? { markerIdentityConfirmations: error.qualificationMarkerIdentityConfirmations } : {}),
            cwd, processFailure: error?.message, processDiagnostics: error?.processTreeDiagnostics ?? [],
            ...(error?.result ? { exitCode: error.result.exitCode, signal: error.result.signal,
              terminationReason: error.result.terminationReason, timedOut: error.result.timedOut,
              cancelled: error.result.cancelled, stdout: error.result.stdout, stderr: error.result.stderr } : {}) }));
          throw error;
        }
        report.commands.push(redactScope({ rpc: nativePlatform === 'codex' ? ['initialize', 'skills/list'] : ['get_commands', 'get_state'],
          ...(mixedClients ? { nativeClient: nativePlatform } : {}),
          ...(result.processQueryTimings ? { processQueryTimings: result.processQueryTimings } : {}),
          ...(result.markerIdentityConfirmations ? { markerIdentityConfirmations: result.markerIdentityConfirmations } : {}),
          cwd, exitCode: result.exitCode, timedOut: result.timedOut, maxBufferExceeded: result.maxBufferExceeded,
          cancelled: result.cancelled, terminationReason: result.terminationReason, stderr: result.stderr }));
        if (mixedClients && (result.cancelled || result.terminationReason !== 'complete')) throw new Error('mixed-native-rpc-incomplete');
        assertCommand(result);
        return JSON.parse(result.stdout);
      },
      async aw(args, cwd = project, commandOptions = {}) {
        const expectedExitCode = commandOptions.expectedExitCode ?? 0;
        const expectedStatus = commandOptions.expectedStatus ?? 'success';
        const timeoutMs = commandOptions.timeoutMs ?? 60_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new Error('public-aw-invalid-timeout');
        const bootstrapArgs = ['plugin', 'install', `qualification/${ctx.pluginName}`, '--scope', 'user', '--target', 'grok', '--yes'];
        const trustBootstrap = options.publicAw && platform === 'grok' && scope === 'user'
          && expectedExitCode === 4 && expectedStatus === 'partial'
          && args.length === bootstrapArgs.length && args.every((arg, index) => arg === bootstrapArgs[index]);
        const expectedIncompleteStatus = options.publicAw && args[0] === 'plugin' && args[1] === 'status'
          && (expectedExitCode === 3 && expectedStatus === 'blocked' || expectedExitCode === 4 && expectedStatus === 'partial');
        const grokSyncArgs = ['plugin', 'sync', `qualification/${ctx.pluginName}`, '--context', 'user', '--target', 'grok', '--yes'];
        const expectedGrokSafetyBlock = options.publicAw && platform === 'grok' && scope === 'user'
          && (expectedExitCode === 3 && expectedStatus === 'blocked' || expectedExitCode === 4 && expectedStatus === 'partial')
          && args.length === grokSyncArgs.length && args.every((arg, index) => arg === grokSyncArgs[index]);
        const expectedNonzero = trustBootstrap || expectedIncompleteStatus || expectedGrokSafetyBlock;
        if ((expectedExitCode !== 0 || expectedStatus !== 'success') && !expectedNonzero) {
          throw new Error('public-aw-unexpected-command-expectation');
        }
        const auditOpenCodeStatus = platform === 'opencode' && args[0] === 'plugin' && args[1] === 'status';
        const mixedInstall = mixedClients && args[0] === 'plugin' && args[1] === 'install';
        const trace = auditOpenCodeStatus || ['linux', 'darwin', 'win32'].includes(process.platform)
          && ['codex', 'pi', 'claude', 'copilot'].includes(platform)
          && (!mixedClients || args[0] === 'plugin')
          && process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE === '1';
        const traceFile = trace ? path.join(root, `managed-native-${report.commands.length}.jsonl`) : undefined;
        const sourceDiagnostic = trace && platform === 'codex' && process.platform === 'win32';
        const sharedArgs = ['plugin', 'install', `qualification/${ctx.pluginName}-dependent`, '--scope', 'project', '--target', 'codex', '--yes'];
        const stageLog = sourceDiagnostic && args.length === sharedArgs.length && args.every((arg, i) => arg === sharedArgs[i])
          ? path.join(root, `shared-provider-${report.commands.length}.log`) : undefined;
        const commandEnv = trace ? { ...env, GITHUB_ACTIONS: 'true', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
          ...(stageLog ? { AW_NATIVE_QUALIFICATION_CODEX_SHARED_TIMING: '1' } : {}),
          AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: mixedClients ? 'claude-pi' : platform,
          AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: traceFile,
          AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify(ctx.publicAdditionalClientEntries
            ?? [launcher.prefix[0] ?? launcher.executable, ctx.publicClientEntry, ctx.publicAlternateClientEntry].filter(Boolean)) } : env;
        let result;
        const startedAt = new Date().toISOString();
        const start = performance.now();
        const jobTiming = () => ({ startedAt, returnedAt: new Date().toISOString(), elapsedMs: performance.now() - start, timeoutMs });
        try {
          result = await executePublicAw(publicAwNodeLauncher(path.join(repoRoot, 'packages/cli/dist/index.js'), trace),
            [...args, '--json', ...(stageLog ? ['--debug', '--log-file', stageLog] : [])], { cwd, env: commandEnv, timeoutMs });
        } catch (error) {
          const nativeManagedTrace = await readManagedTrace(traceFile);
          report.commands.push(redactScope({ aw: args, cwd, processFailure: error?.message,
            ...(mixedClients ? { jobTiming: jobTiming() } : {}),
            ...(stageLog ? { jobTiming: jobTiming(), awStages: await readPublicAwStages(stageLog) } : {}),
            ...(trace ? { nativeManagedTrace } : {}),
            ...(mixedInstall && nativeManagedTrace ? { nativeInstallIntervals: mixedNativeInstallIntervals(nativeManagedTrace) } : {}),
            ...(sourceDiagnostic ? { nativeSourceConfiguration: await readQualificationCodexSources(env.CODEX_HOME) } : {}),
            processDiagnostics: error?.publicAwProcessDiagnostics ?? [],
            ...(error?.publicAwProcessNames ? { processNames: error.publicAwProcessNames } : {}),
            ...(error?.publicAwMarkerRows ? { markerRows: error.publicAwMarkerRows } : {}),
            ...(error?.publicAwProcessQueryTimings ? { processQueryTimings: error.publicAwProcessQueryTimings } : {}),
            ...(error?.qualificationMarkerIdentityConfirmations ? { markerIdentityConfirmations: error.qualificationMarkerIdentityConfirmations } : {}),
            ...(error?.result ? { exitCode: error.result.exitCode, terminationReason: error.result.terminationReason,
              stdout: error.result.stdout, stderr: error.result.stderr,
              failureSummary: publicAwFailureSummary(error.result.stdout) } : {}) }));
          throw error;
        }
        const timing = stageLog ? jobTiming() : undefined;
        const nativeManagedTrace = trace ? await readManagedTrace(traceFile) : undefined;
        report.commands.push(redactScope({ aw: args, cwd, exitCode: result.exitCode, timedOut: result.timedOut,
          ...(mixedClients ? { jobTiming: jobTiming() } : {}),
          ...(stageLog ? { jobTiming: timing, awStages: await readPublicAwStages(stageLog) } : {}),
          ...(result.processQueryTimings ? { processQueryTimings: result.processQueryTimings } : {}),
          ...(result.markerIdentityConfirmations ? { markerIdentityConfirmations: result.markerIdentityConfirmations } : {}),
          ...(trace ? { nativeManagedTrace } : {}),
          cancelled: result.cancelled, terminationReason: result.terminationReason,
          maxBufferExceeded: result.maxBufferExceeded, stdout: result.stdout, stderr: result.stderr,
          ...(args[0] === 'plugin' && args[1] === 'status' ? { statusSummary: publicAwFailureSummary(result.stdout) } : {}),
          ...(mixedInstall ? { installSummary: publicAwFailureSummary(result.stdout) } : {}),
          ...(mixedInstall && nativeManagedTrace ? { nativeInstallIntervals: mixedNativeInstallIntervals(nativeManagedTrace) } : {}),
          ...(result.exitCode !== 0 || result.timedOut || result.maxBufferExceeded
            ? { failureSummary: publicAwFailureSummary(result.stdout),
              ...(sourceDiagnostic ? { nativeSourceConfiguration: await readQualificationCodexSources(env.CODEX_HOME) } : {}) } : {}),
          processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
              descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } }));
        if (stageLog && result.timedOut) {
          // Each command records its own result. Inspect before the scenario
          // restores configuration, and keep the install timeout as its failure.
          await ctx.command(['plugin', 'list', '--json'], project, { entry: ctx.publicClientEntry }).catch(() => {});
          await ctx.aw(['plugin', 'status', `qualification/${ctx.pluginName}`, args[2], '--context', 'project'], project).catch(() => {});
        }
        if (expectedNonzero) {
          if (result.timedOut) throw new Error('command-timeout');
          if (result.maxBufferExceeded) throw new Error('command-output-limit');
          if (result.exitCode !== expectedExitCode) throw new Error('public-aw-unexpected-exit-code');
        } else assertCommand(result);
        if (result.cancelled || result.terminationReason !== 'complete') throw new Error('public-aw-command-incomplete');
        if (auditOpenCodeStatus) {
          const records = nativeManagedTrace?.records ?? [];
          const serviceQueries = records.filter(({ phase, args }) => phase === 'start'
            && (args?.[0] === 'serve' || args?.[0] === 'api'));
          const explicit = args.includes('--observe-native');
          if (nativeManagedTrace?.state !== 'captured' || !records.some(({ phase, state }) => phase === 'installation' && state === 'installed')
            || !records.some(({ phase, args }) => phase === 'finish' && args?.[0] === '--version')
            || (explicit ? serviceQueries.length !== 1 || serviceQueries[0].args[0] !== 'api' : serviceQueries.length !== 0)) {
            throw new Error('public-opencode-service-startup-evidence-mismatch');
          }
        }
        return readPublicAwEnvelope(result.stdout, expectedStatus);
      },
      async check(id, action) {
        const check = { id, status: 'failed' }; report.checks.push(check);
        try {
          const evidence = await action() ?? {};
          check.evidence = redactScope(evidence);
          check.status = 'passed';
          return evidence;
        }
        catch (error) {
          if (error instanceof Unverified) check.status = 'unverified';
          check.reason = redactScope(error?.message ?? 'check-failed');
          throw error;
        }
      },
      async observe(id, action) { return observeQualification(report, id, action, root, options.clientBin); },
      async defer(reason) { throw new Unverified(reason); },
      async render(revision) {
        return revision === 1 ? renderPackage(ctx, revision)
          : ctx.check('aw-candidate-refresh-projection', () => renderPackage(ctx, revision));
      },
    };
    if (mixedClients) await runUnit(() => qualifyMixedPublicAw(ctx, mixedClients));
    else {
      await runUnit(() => ctx.check('client-version', async () => {
        const result = await ctx.command(['--version']);
        const actual = versionFrom(result.stdout);
        if (actual !== fixedClientVersion(platform)) throw new Error('client-version-mismatch');
        return { version: actual };
      }));
      if (options.publicAw) {
        if (options.publicClientError) throw options.publicClientError;
        await qualifyPublicAw(ctx, { components: process.env.AW_QUALIFICATION_PUBLIC_COMPONENTS === '1' });
        for (const id of requiredPublicChecks(platform, scope)) {
          if (!report.checks.some(check => check.id === id && check.status === 'passed')) throw new Error(`missing-public-check:${id}`);
        }
      }
      else await runUnit(async () => {
        const initialProjection = await ctx.check('aw-candidate-projection', () => ctx.render(1));
        if (platform === 'opencode') ctx.initialProjection = initialProjection;
        await qualifyClient(ctx);
      });
    }
    report.status = 'passed';
  } catch (error) {
    report.status = error instanceof Unverified ? 'unverified' : 'failed';
    report.reason = redactScope(error?.message ?? 'qualification-failed');
    report.remaining = 'not-run-after-incomplete-scenario';
  } finally {
    try { if (root) await removeQualificationRoot(root); report.cleanup = 'completed'; }
    catch (error) {
      report.cleanup = 'failed'; report.status = 'failed';
      report.cleanupError = redactScope({ code: error?.code, syscall: error?.syscall, path: error?.path });
    }
  }
  return report;
}

export async function removeQualificationRoot(root) {
  // Windows can keep an executable mapped briefly after its Job has closed.
  // Bound retries for the entire fixture, including deeply nested packages.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rm(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt === 5 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay((attempt + 1) * 100);
    }
  }
}

async function cleanupClientAcquisition(installRoot, result) {
  try { await removeQualificationRoot(installRoot); result.acquisitionCleanup = 'completed'; }
  catch (error) {
    result.acquisitionCleanup = 'failed'; result.status = 'failed';
    result.acquisitionCleanupError = redact({ code: error?.code, syscall: error?.syscall, path: error?.path }, installRoot);
  }
}

export async function run(options, acquire = acquireClient) {
  const selectedPlatforms = selectPlatforms(options.client);
  const codexBehaviorRequested = options['public-aw'] && selectedPlatforms.includes('codex');
  const loopbackRequested = options['public-aw'] && selectedPlatforms.some(platform => ['codex', 'grok', 'copilot'].includes(platform));
  const mixedPublicAwRequested = Boolean(options['mixed-native-aw']);
  const mixedClients = new Map();
  const report = { schemaVersion: 2, kind: 'aw-native-hosted-qualification', status: 'failed',
    acceptancePolicy: { id: options['public-aw'] ? 'public-status-and-native-scope-v2' : 'management-content-scope-v1',
      required: ['management', 'dynamic-consumer-content', 'scope-isolation', 'process-safety', 'cleanup',
        ...(options['public-aw'] ? ['public-status', 'public-negative-scope-and-permission-cases'] : []),
        ...(options['public-aw'] ? ['public-manual-skill-policy-by-scope'] : []),
        ...(codexBehaviorRequested ? ['codex-manual-skill-and-native-role-resolution'] : []),
        ...(mixedPublicAwRequested ? ['mixed-native-aw-install-and-readback'] : [])],
      nonBlocking: ['skill-loading', 'model-adoption'],
      excluded: 'official-client-distribution-unavailable' },
    createdAt: new Date().toISOString(), environment: hostInfo(),
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    boundary: { fixtureTrust: 'hosted-only',
      host: process.platform, hosted: process.env.GITHUB_ACTIONS === 'true',
      credentials: 'not-provided', modelRequests: loopbackRequested ? 'loopback qualification fixtures only' : 'none', clients: 'real',
      input: 'current-aw-projection-candidate', productionQualificationChanged: false,
      publicAwRequested: Boolean(options['public-aw']),
      ...(mixedPublicAwRequested ? { mixedPublicAwRequested: true } : {}),
      processNameDiagnostics: ['linux', 'darwin'].includes(process.platform) && process.env.GITHUB_ACTIONS === 'true'
        && process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES === '1' ? 'hosted-private-identity-ucomm' : 'disabled',
      nativeCopilotDarwinObservation: process.platform === 'darwin'
        ? 'observed-marker-and-identity-audit-not-provider-grading-or-os-containment' : 'not-applicable',
      nativeOpenCodeObservation: process.platform === 'win32' ? 'existing-windows-job; actual-process-result-fields'
        : 'authorized-observed-marker-PID-start-deadline-descendant-exit-cleanup; not-provider-grading-or-os-containment',
      publicAwNativeTrace: ['linux', 'darwin', 'win32'].includes(process.platform) && process.env.GITHUB_ACTIONS === 'true'
        && process.env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE === '1'
        ? 'node-import-trace-of-selected-client-entries-not-uninstrumented-performance-evidence' : 'disabled',
      publicAwProcessManagement: process.platform === 'win32' ? 'windows-job'
        : 'observed-marker-and-identity-audit-not-provider-grading-or-os-containment',
      runtimeNetwork: 'blocked-proxy-not-os-firewall', installNetwork: options.install ? 'public-npm' : 'none',
      processManagement: process.platform === 'win32'
        ? 'client-windows-job-download-bounded-child'
        : 'client-verified-observed-download-bounded-child-not-os-containment' },
    uncovered: [...(options['public-aw'] ? [] : ['public-aw-install-end-to-end']),
      ...(options['public-aw'] ? ['invocation-controls-outside-tested-scenarios'] : ['skill-invocation-controls']),
      ...(codexBehaviorRequested ? ['agents-execution-outside-three-codex-user-roles'] : ['agents-execution']),
      'external-model-invocation', 'mcp-execution', 'hook-execution', 'instructions-consumption', 'desktop', 'minimum-version-matrix',
      'antigravity', 'cursor'], clients: [],
    uncoveredReasons: { cursor: 'separate-fixed-interface-probe',
      antigravity: 'public-user-scope-runs-through-dedicated-qualification' },
  };
  let group;
  try {
    group = await qualificationGroup({ manifest: options.candidate });
    report.candidate = group.candidate;
    report.processManagement = await processManagementInfo();
    report.harnessSha256 = sha256(await fs.readFile(fileURLToPath(import.meta.url)));
    await Promise.all(selectedPlatforms.map(async platform => {
      const result = { platform, requiredVersion: clients[platform].version, status: 'failed', scopes: [] };
      report.clients.push(result);
      if (distributionExcluded(platform, process)) {
        result.status = 'excluded'; result.reason = 'official-client-distribution-unavailable'; return;
      }
      let installRoot;
      try {
        let launcher;
        let grokBinary;
        let clientBin;
        let preparedClient;
        let publicClientError;
        if (options.install) {
          const acquired = await group.runUnit(async () => {
            installRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-client-')));
            return acquire(platform, installRoot);
          });
          grokBinary = acquired.grokBinary;
          launcher = acquired.launcher; clientBin = acquired.binDirectory; result.acquisition = acquired.acquisition;
          if (options['public-aw']) {
            try { preparedClient = await group.runUnit(() => preparePublicClientEntry({ root: installRoot, launcher, platform, clientBin })); }
            catch (error) { publicClientError = error; }
          }
          if (mixedPublicAwRequested && mixedNativePlatforms.includes(platform)) {
            mixedClients.set(platform, { ...acquired, installRoot, result });
          }
        } else {
          const entry = await fs.realpath(options.executable);
          launcher = { executable: entry, prefix: [] };
          result.acquisition = { method: 'provided-executable', entrySha256: sha256(await fs.readFile(entry)) };
        }
        const scopesToRun = ['user', 'project'];
        const [direct, publicAw] = await Promise.all([
          Promise.all(scopesToRun.map(scope => runScope(platform, scope, launcher, { group, grokBinary, nativeClientVersion: result.acquisition?.version }))),
          options['public-aw'] && Promise.all(scopesToRun.map(scope => runScope(platform, scope, launcher,
            { publicAw: true, clientBin, preparedClient, publicClientError, group, grokBinary, nativeClientVersion: result.acquisition?.version }))),
        ]);
        result.scopes = direct;
        if (publicAw) result.publicAw = publicAw;
        const scopes = [...result.scopes, ...(result.publicAw ?? [])];
        result.status = aggregateQualificationStatus(scopes.map(scope => scope.status));
      } catch (error) {
        result.reason = /^[a-z][a-z-]+$/u.test(error?.message ?? '') ? error.message : 'client-acquisition-or-execution-failed';
        if (error.evidence && installRoot) result.evidence = redact(error.evidence, installRoot);
      } finally {
        if (installRoot && !mixedClients.has(platform)) await cleanupClientAcquisition(installRoot, result);
      }
    }));
    if (mixedPublicAwRequested) {
      const platforms = mixedNativePlatforms.map((platform) => ({ platform, version: fixedClientVersion(platform) }));
      const unavailable = mixedNativePlatforms.filter((platform) => !mixedClients.has(platform));
      report.mixedPublicAw = unavailable.length
        ? { platforms, status: 'failed', scope: 'user', checks: [], reason: 'mixed-native-clients-unavailable', unavailable }
        : { platforms, ...await runScope(mixedNativePlatforms[0], 'user', mixedClients.get(mixedNativePlatforms[0]).launcher,
          { publicAw: true, mixedClients, group }) };
    }
    report.status = aggregateQualificationStatus([...report.clients.map(client => client.status),
      ...(mixedPublicAwRequested ? [report.mixedPublicAw.status] : [])]);
  } catch (error) {
    report.reason = /^[a-z][a-z-]+$/u.test(error?.message ?? '') ? error.message : 'candidate-or-harness-failed';
  } finally {
    for (const { installRoot, result } of mixedClients.values()) {
      await cleanupClientAcquisition(installRoot, result);
      if (result.acquisitionCleanup === 'failed') report.status = 'failed';
    }
    if (group) {
      try { await group.finish(); }
      catch (error) {
        report.status = 'failed';
        report.reason = /^[a-z][a-z-]+$/u.test(error?.message ?? '') ? error.message : 'candidate-final-verification-failed';
      }
    }
  }
  await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
  await fs.writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options['write-candidate']) await writeCandidate(options['write-candidate'], options['source-sha']);
    else {
      const report = await run(options);
      console.log(JSON.stringify({ status: report.status, clients: report.clients.map(({ platform, status }) => ({ platform, status })),
        ...(report.mixedPublicAw ? { mixedPublicAw: { status: report.mixedPublicAw.status, reason: report.mixedPublicAw.reason } } : {}) }));
      process.exitCode = ['passed', 'excluded'].includes(report.status) ? 0 : 1;
    }
  } catch (error) {
    console.error(`${error?.message === 'invalid-arguments' ? usage : 'Qualification setup failed.'}`);
    process.exitCode = 1;
  }
}
