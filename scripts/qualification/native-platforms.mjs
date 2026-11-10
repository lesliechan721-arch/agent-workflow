#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { clients, repoRoot, sha256, prepareEnvironment, execute, assertCommand,
  acquireClient, renderPackage, verifyCandidate, writeCandidate, hostInfo, processManagementInfo } from './native-platform-runtime.mjs';
import { qualifyClient } from './native-platform-clients.mjs';

const usage = 'node scripts/qualification/native-platforms.mjs --candidate <manifest> --client <all|codex|pi|claude|gemini|copilot|grok> --report <file> (--install | --executable <absolute-path>)';
class Unverified extends Error {}

export function parseArgs(args) {
  const options = {};
  const names = new Set(['candidate', 'client', 'report', 'executable', 'write-candidate', 'source-sha']);
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/u, '');
    if (!args[index].startsWith('--') || Object.hasOwn(options, key)) throw new Error('invalid-arguments');
    if (key === 'install') { options.install = true; continue; }
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

function redact(value, root) {
  const replace = (text) => {
    for (const [directory, label] of [[root, '<TEMP_ROOT>'], [os.homedir(), '<HOST_HOME>']]) {
      for (const spelling of [directory, directory.replaceAll('\\', '/'), JSON.stringify(directory).slice(1, -1)]) {
        text = text.replaceAll(spelling, label);
      }
    }
    return text;
  };
  if (typeof value === 'string') return replace(value).slice(0, 4000);
  if (Array.isArray(value)) return value.map((item) => redact(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, root)]));
  return value;
}

export function versionFrom(output) {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?=$|\s|\(|\.(?:\s|$))/u.exec(output.trim())?.[1] ?? null;
}

export async function runScope(platform, scope, launcher) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-qualification-')));
  const report = { scope, status: 'failed', checks: [], commands: [], cleanup: 'pending' };
  try {
    const env = await prepareEnvironment(root);
    const project = path.join(root, 'project');
    const neutral = path.join(root, 'neutral');
    const marketplace = path.join(root, 'source');
    await fs.mkdir(project);
    assertCommand(await execute({ executable: 'git', prefix: [] },
      ['init', '--quiet', '--template=', '--initial-branch=qualification', project], { cwd: root, env }));
    await fs.mkdir(neutral);
    const ctx = { platform, scope, root, env, project, neutral, marketplace,
      pluginName: 'aw-qualification', skillName: 'aw-qualification', marketplaceName: 'aw-qualification-market',
      bundle: path.join(marketplace, 'plugins', 'aw-qualification'),
      async command(args, cwd = project, options = {}) {
        const result = await execute(launcher, args, { cwd, env, stdin: options.input });
        report.commands.push(redact({ args, cwd, exitCode: result.exitCode, timedOut: result.timedOut,
          maxBufferExceeded: result.maxBufferExceeded, stdout: result.stdout, stderr: result.stderr }, root));
        if (!options.allowFailure) assertCommand(result);
        return result;
      },
      async rpc(cwd = project) {
        const result = await execute({ executable: process.execPath, prefix: [path.join(repoRoot, 'scripts/qualification/native-platform-rpc.mjs')] }, [], {
          cwd, env, timeoutMs: 25_000, stdin: JSON.stringify({ platform, launcher, cwd }),
        });
        report.commands.push(redact({ rpc: platform === 'codex' ? ['initialize', 'skills/list'] : ['get_commands', 'get_state'],
          cwd, exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr }, root));
        assertCommand(result);
        return JSON.parse(result.stdout);
      },
      async check(id, action) {
        const check = { id, status: 'failed' }; report.checks.push(check);
        try { check.evidence = redact(await action() ?? {}, root); check.status = 'passed'; }
        catch (error) { check.reason = redact(error?.message ?? 'check-failed', root); throw error; }
      },
      async defer(reason) { throw new Unverified(reason); },
      async render(revision) { return renderPackage(ctx, revision); },
    };
    await ctx.check('client-version', async () => {
      const result = await ctx.command(['--version']);
      const actual = versionFrom(result.stdout);
      if (actual !== clients[platform].version) throw new Error('client-version-mismatch');
      return { version: actual };
    });
    await ctx.check('aw-candidate-projection', () => ctx.render(1));
    await qualifyClient(ctx);
    report.status = 'passed';
  } catch (error) {
    report.status = error instanceof Unverified ? 'unverified' : 'failed';
    report.reason = redact(error?.message ?? 'qualification-failed', root);
    report.remaining = 'not-run-after-incomplete-scenario';
  } finally {
    try { await fs.rm(root, { recursive: true, force: true }); report.cleanup = 'completed'; }
    catch { report.cleanup = 'failed'; report.status = 'failed'; }
  }
  return report;
}

export async function run(options) {
  const report = { schemaVersion: 1, kind: 'aw-native-hosted-qualification', status: 'failed',
    createdAt: new Date().toISOString(), environment: hostInfo(),
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    boundary: { credentials: 'not-provided', modelRequests: 'none', clients: 'real',
      input: 'current-aw-projection-candidate', productionQualificationChanged: false,
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
        if (options.install) {
          installRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-client-')));
          const acquired = await acquireClient(platform, installRoot);
          launcher = acquired.launcher; result.acquisition = acquired.acquisition;
        } else {
          const entry = await fs.realpath(options.executable);
          launcher = { executable: entry, prefix: [] };
          result.acquisition = { method: 'provided-executable', entrySha256: sha256(await fs.readFile(entry)) };
        }
        for (const scope of ['user', 'project']) result.scopes.push(await runScope(platform, scope, launcher));
        result.status = result.scopes.every((scope) => scope.status === 'passed') ? 'passed'
          : result.scopes.some((scope) => scope.status === 'failed') ? 'failed' : 'unverified';
      } catch (error) {
        result.reason = /^[a-z][a-z-]+$/u.test(error?.message ?? '') ? error.message : 'client-acquisition-or-execution-failed';
        if (error.evidence && installRoot) result.evidence = redact(error.evidence, installRoot);
      } finally {
        if (installRoot) {
          try { await fs.rm(installRoot, { recursive: true, force: true }); result.acquisitionCleanup = 'completed'; }
          catch { result.acquisitionCleanup = 'failed'; result.status = 'failed'; }
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
