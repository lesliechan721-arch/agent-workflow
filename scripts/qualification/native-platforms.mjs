#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { clients, repoRoot, sha256, prepareEnvironment, execute, assertCommand,
  acquireClient, renderPackage, verifyCandidate, writeCandidate, hostInfo, processManagementInfo } from './native-platform-runtime.mjs';
import { qualifyClient } from './native-platform-clients.mjs';
import { qualifyPublicAw } from './native-platform-public-aw.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';

const usage = 'node scripts/qualification/native-platforms.mjs --candidate <manifest> --client <all|codex|pi|claude|gemini|copilot|grok> --report <file> (--install | --executable <absolute-path>) [--public-aw]';
class Unverified extends Error {}

export function parseArgs(args) {
  const options = {};
  const names = new Set(['candidate', 'client', 'report', 'executable', 'write-candidate', 'source-sha']);
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/u, '');
    if (!args[index].startsWith('--') || Object.hasOwn(options, key)) throw new Error('invalid-arguments');
    if (key === 'install' || key === 'public-aw') { options[key] = true; continue; }
    if (!names.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid-arguments');
    options[key] = args[++index];
  }
  if (options['write-candidate']) {
    if (Object.keys(options).length !== 2 || !options['source-sha']) throw new Error('invalid-arguments');
    return options;
  }
  if (!options.candidate || !options.report || !(options.client === 'all' || Object.hasOwn(clients, options.client))
    || Boolean(options.install) === Boolean(options.executable)
    || options.executable && (options.client === 'all' || !path.isAbsolute(options.executable))
    || Object.keys(options).some((key) => ['write-candidate', 'source-sha'].includes(key))) throw new Error('invalid-arguments');
  return options;
}

export function redact(value, root, clientBin) {
  const replace = (text) => {
    for (const [directory, label] of [[root, '<TEMP_ROOT>'], [clientBin, '<CLIENT_BIN>'], [os.homedir(), '<HOST_HOME>']]) {
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
    targets: list(value.data?.targetResults, 4).map((target) => ({
      ...fields(target, ['pluginId', 'target', 'scope', 'execution', 'observation', 'content']),
      blockerCodes: list(target?.blockerCodes, 8).filter((item) => typeof item === 'string'),
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

export async function runScope(platform, scope, launcher, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-qualification-')));
  const report = { scope, input: options.publicAw ? 'public-aw-cli' : 'aw-projection-candidate', status: 'failed', checks: [], commands: [], cleanup: 'pending' };
  try {
    const env = await prepareEnvironment(root);
    const project = path.join(root, 'project');
    const neutral = path.join(root, 'neutral');
    const marketplace = path.join(root, 'source');
    await fs.mkdir(project);
    assertCommand(await execute({ executable: 'git', prefix: [] },
      ['init', '--quiet', '--template=', '--initial-branch=qualification', project], { cwd: root, env }));
    await fs.mkdir(neutral);
    const ctx = { platform, scope, root, env, project, neutral, marketplace, launcher, clientBin: options.clientBin,
      pluginName: 'aw-qualification', skillName: 'aw-qualification', marketplaceName: 'aw-qualification-market',
      bundle: path.join(marketplace, 'plugins', 'aw-qualification'),
      async command(args, cwd = project, commandOptions = {}) {
        let result;
        try {
          result = await execute(launcher, args, { cwd, env, stdin: commandOptions.input,
            captureProcessNames: platform === 'copilot' });
        } catch (error) {
          report.commands.push(redact({ args, cwd, processFailure: error?.message,
            processDiagnostics: error?.processTreeDiagnostics ?? [],
            ...(error?.qualificationProcessNames?.length ? { processNames: error.qualificationProcessNames } : {}),
            ...(error?.result ? { exitCode: error.result.exitCode, signal: error.result.signal,
              terminationReason: error.result.terminationReason, timedOut: error.result.timedOut,
              cancelled: error.result.cancelled, stdout: error.result.stdout, stderr: error.result.stderr } : {}) }, root, options.clientBin));
          throw error;
        }
        report.commands.push(redact({ args, cwd, exitCode: result.exitCode, timedOut: result.timedOut,
          maxBufferExceeded: result.maxBufferExceeded, stdout: result.stdout, stderr: result.stderr }, root, options.clientBin));
        if (!commandOptions.allowFailure) assertCommand(result);
        return result;
      },
      async rpc(cwd = project) {
        let result;
        try {
          result = await execute({ executable: process.execPath, prefix: [path.join(repoRoot, 'scripts/qualification/native-platform-rpc.mjs')] }, [], {
            cwd, env, timeoutMs: 25_000, stdin: JSON.stringify({ platform, launcher, cwd }),
          });
        } catch (error) {
          report.commands.push(redact({ rpc: platform === 'codex' ? ['initialize', 'skills/list'] : ['get_commands', 'get_state'],
            cwd, processFailure: error?.message, processDiagnostics: error?.processTreeDiagnostics ?? [],
            ...(error?.result ? { exitCode: error.result.exitCode, signal: error.result.signal,
              terminationReason: error.result.terminationReason, timedOut: error.result.timedOut,
              cancelled: error.result.cancelled, stdout: error.result.stdout, stderr: error.result.stderr } : {}) }, root, options.clientBin));
          throw error;
        }
        report.commands.push(redact({ rpc: platform === 'codex' ? ['initialize', 'skills/list'] : ['get_commands', 'get_state'],
          cwd, exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr }, root, options.clientBin));
        assertCommand(result);
        return JSON.parse(result.stdout);
      },
      async aw(args, cwd = project) {
        let result;
        try {
          result = await executePublicAw({ executable: process.execPath, prefix: [path.join(repoRoot, 'packages/cli/dist/index.js')] },
            [...args, '--json'], { cwd, env, timeoutMs: 60_000 });
        } catch (error) {
          report.commands.push(redact({ aw: args, cwd, processFailure: error?.message,
            processDiagnostics: error?.publicAwProcessDiagnostics ?? [],
            ...(error?.publicAwProcessNames ? { processNames: error.publicAwProcessNames } : {}),
            ...(error?.result ? { exitCode: error.result.exitCode, terminationReason: error.result.terminationReason,
              stdout: error.result.stdout, stderr: error.result.stderr,
              failureSummary: publicAwFailureSummary(error.result.stdout) } : {}) }, root, options.clientBin));
          throw error;
        }
        report.commands.push(redact({ aw: args, cwd, exitCode: result.exitCode, timedOut: result.timedOut,
          maxBufferExceeded: result.maxBufferExceeded, stdout: result.stdout, stderr: result.stderr,
          ...(result.exitCode !== 0 || result.timedOut || result.maxBufferExceeded
            ? { failureSummary: publicAwFailureSummary(result.stdout) } : {}),
          processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
            descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } }, root, options.clientBin));
        assertCommand(result);
        const value = JSON.parse(result.stdout);
        if (value.schemaVersion !== 1 || value.status !== 'success') throw new Error('public-aw-command-not-successful');
        return value;
      },
      async check(id, action) {
        const check = { id, status: 'failed' }; report.checks.push(check);
        try {
          const evidence = await action() ?? {};
          check.evidence = redact(evidence, root, options.clientBin);
          check.status = 'passed';
          return evidence;
        }
        catch (error) { check.reason = redact(error?.message ?? 'check-failed', root, options.clientBin); throw error; }
      },
      async defer(reason) { throw new Unverified(reason); },
      async render(revision) {
        return revision === 1 ? renderPackage(ctx, revision)
          : ctx.check('aw-candidate-refresh-projection', () => renderPackage(ctx, revision));
      },
    };
    await ctx.check('client-version', async () => {
      const result = await ctx.command(['--version']);
      const actual = versionFrom(result.stdout);
      if (actual !== clients[platform].version) throw new Error('client-version-mismatch');
      return { version: actual };
    });
    if (options.publicAw) await qualifyPublicAw(ctx);
    else {
      await ctx.check('aw-candidate-projection', () => ctx.render(1));
      await qualifyClient(ctx);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = error instanceof Unverified ? 'unverified' : 'failed';
    report.reason = redact(error?.message ?? 'qualification-failed', root, options.clientBin);
    report.remaining = 'not-run-after-incomplete-scenario';
  } finally {
    try { await fs.rm(root, { recursive: true, force: true }); report.cleanup = 'completed'; }
    catch (error) {
      report.cleanup = 'failed'; report.status = 'failed';
      report.cleanupError = redact({ code: error?.code, syscall: error?.syscall, path: error?.path }, root, options.clientBin);
    }
  }
  return report;
}

export async function run(options) {
  const report = { schemaVersion: 1, kind: 'aw-native-hosted-qualification', status: 'failed',
    createdAt: new Date().toISOString(), environment: hostInfo(),
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    boundary: { credentials: 'not-provided', modelRequests: 'none', clients: 'real',
      input: 'current-aw-projection-candidate', productionQualificationChanged: false,
      publicAwRequested: Boolean(options['public-aw']),
      processNameDiagnostics: ['linux', 'darwin'].includes(process.platform) && process.env.GITHUB_ACTIONS === 'true'
        && process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES === '1' ? 'hosted-private-identity-ucomm' : 'disabled',
      publicAwProcessManagement: process.platform === 'win32' ? 'windows-job'
        : 'observed-marker-and-identity-audit-not-provider-grading-or-os-containment',
      runtimeNetwork: 'blocked-proxy-not-os-firewall', installNetwork: options.install ? 'public-npm' : 'none',
      processManagement: process.platform === 'win32'
        ? 'client-windows-job-download-bounded-child'
        : 'client-verified-observed-download-bounded-child-not-os-containment' },
    uncovered: ['public-aw-install-end-to-end', 'model-invocation', 'skill-invocation-controls', 'mcp-execution',
      'hook-execution', 'agents-execution', 'instructions-consumption', 'desktop', 'minimum-version-matrix',
      'antigravity', 'cursor', 'opencode'], clients: [],
    uncoveredReasons: { opencode: 'standalone-process-group-and-activation-readiness-not-qualified',
      cursor: 'tested-workspace-hook-requires-authentication',
      antigravity: 'fixed-distribution-and-unauthenticated-interface-not-verified' },
  };
  try {
    report.candidate = await verifyCandidate(options.candidate);
    report.processManagement = await processManagementInfo();
    report.harnessSha256 = sha256(await fs.readFile(fileURLToPath(import.meta.url)));
    for (const platform of options.client === 'all' ? Object.keys(clients) : [options.client]) {
      const result = { platform, requiredVersion: clients[platform].version, status: 'failed', scopes: [] };
      report.clients.push(result);
      if (platform === 'grok' && (process.platform === 'darwin' && process.arch === 'x64'
        || process.platform === 'win32' && process.arch === 'arm64')) {
        result.status = 'unverified'; result.reason = 'official-client-distribution-unavailable'; continue;
      }
      let installRoot;
      try {
        let launcher;
        let clientBin;
        if (options.install) {
          installRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-client-')));
          const acquired = await acquireClient(platform, installRoot);
          launcher = acquired.launcher; clientBin = acquired.binDirectory; result.acquisition = acquired.acquisition;
        } else {
          const entry = await fs.realpath(options.executable);
          launcher = { executable: entry, prefix: [] };
          result.acquisition = { method: 'provided-executable', entrySha256: sha256(await fs.readFile(entry)) };
        }
        for (const scope of ['user', 'project']) result.scopes.push(await runScope(platform, scope, launcher));
        if (options['public-aw']) {
          result.publicAw = [];
          for (const scope of ['user', 'project']) result.publicAw.push(await runScope(platform, scope, launcher, { publicAw: true, clientBin }));
        }
        const scopes = [...result.scopes, ...(result.publicAw ?? [])];
        result.status = scopes.every((scope) => scope.status === 'passed') ? 'passed'
          : scopes.some((scope) => scope.status === 'failed') ? 'failed' : 'unverified';
      } catch (error) {
        result.reason = /^[a-z][a-z-]+$/u.test(error?.message ?? '') ? error.message : 'client-acquisition-or-execution-failed';
        if (error.evidence && installRoot) result.evidence = redact(error.evidence, installRoot);
      } finally {
        if (installRoot) {
          try { await fs.rm(installRoot, { recursive: true, force: true }); result.acquisitionCleanup = 'completed'; }
          catch (error) {
            result.acquisitionCleanup = 'failed'; result.status = 'failed';
            result.acquisitionCleanupError = redact({ code: error?.code, syscall: error?.syscall, path: error?.path }, installRoot);
          }
        }
      }
    }
    report.status = report.clients.every((client) => client.status === 'passed') ? 'passed'
      : report.clients.some((client) => client.status === 'failed') ? 'failed' : 'unverified';
  } catch (error) {
    report.reason = /^[a-z][a-z-]+$/u.test(error?.message ?? '') ? error.message : 'candidate-or-harness-failed';
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
      console.log(JSON.stringify({ status: report.status, clients: report.clients.map(({ platform, status }) => ({ platform, status })) }));
      process.exitCode = report.status === 'passed' ? 0 : 1;
    }
  } catch (error) {
    console.error(`${error?.message === 'invalid-arguments' ? usage : 'Qualification setup failed.'}`);
    process.exitCode = 1;
  }
}
