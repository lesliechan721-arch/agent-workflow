import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertCommand, execute, prepareEnvironment, renderPackage, sha256, verifyCandidate } from './native-platform-runtime.mjs';
import { probeAntigravityLocalManagement } from './native-platform-antigravity-management.mjs';

export const interfaceDistributions = Object.freeze({
  cursor: Object.freeze({ version: '2026.11.05-86047df',
    url: 'https://downloads.cursor.com/lab/2026.11.05-86047df/linux/x64/agent-cli-package.tar.gz',
    sha256: '170b77786cbf4c93064d64fff12b71a178b968730561c64afc2e8e752535442e',
    digestSource: 'local SHA-256 of the fixed official download; no publisher SHA-256 supplied',
    entries: ['dist-package/node', 'dist-package/index.js'] }),
  antigravity: Object.freeze({ version: '1.3.4',
    url: 'https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.4/agy_cli_linux_x64.tar.gz',
    sha256: 'db5e81e8dee72d282cb1fb5fcd98dc5a43680730d71e3d637a67c874ec077ad3',
    digestSource: 'local SHA-256 matched the fixed GitHub release asset digest',
    digestReference: 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/tags/1.3.4',
    entries: ['antigravity'] }),
});

const archiveByteLimit = 256 * 1024 * 1024;

function redactProbe(value, root) {
  if (typeof value === 'string') {
    let output = value;
    for (const [directory, replacement] of [[root, '<TEMP_ROOT>'], [os.homedir(), '<HOST_HOME>']]) {
      for (const spelling of [directory, JSON.stringify(directory).slice(1, -1)]) output = output.replaceAll(spelling, replacement);
    }
    return output.slice(0, 4000);
  }
  if (Array.isArray(value)) return value.map(item => redactProbe(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactProbe(item, root)]));
  return value;
}

const extractionScript = String.raw`
import json, os, shutil, sys, tarfile
root = sys.argv[2]
seen = set()
total = 0
count = 0
with tarfile.open(sys.argv[1], 'r|gz') as archive:
    for member in archive:
        parts = member.name.rstrip('/').split('/')
        if member.name.startswith('/') or '\\' in member.name or any(p in ('', '.', '..') for p in parts):
            raise ValueError('unsafe-archive-path')
        name = '/'.join(parts)
        if name in seen or not (member.isfile() or member.isdir()):
            raise ValueError('unsupported-or-duplicate-archive-entry')
        seen.add(name)
        count += 1
        total += member.size
        if count > 20000 or total > 768 * 1024 * 1024:
            raise ValueError('archive-expanded-limit')
        destination = os.path.join(root, *parts)
        if member.isdir():
            os.makedirs(destination, mode=0o700, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
            with archive.extractfile(member) as source, open(destination, 'xb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            os.chmod(destination, 0o600 | (member.mode & 0o111))
print(json.dumps({'archiveEntries': count, 'expandedBytes': total}))
`;

export async function downloadInterfaceArchive(distribution, file, fetchImpl = fetch) {
  const response = await fetchImpl(distribution.url, { signal: AbortSignal.timeout(180_000), redirect: 'follow',
    headers: { 'User-Agent': 'aw-native-interface-probe' } });
  if (!response.ok || !response.body || response.url && !response.url.startsWith('https://')) {
    await response.body?.cancel(); throw new Error('archive-download-failed');
  }
  if (Number(response.headers.get('content-length')) > archiveByteLimit) {
    await response.body.cancel(); throw new Error('archive-download-limit');
  }
  const output = await fs.open(file, 'wx', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > archiveByteLimit) throw new Error('archive-download-limit');
      digest.update(chunk);
      await output.writeFile(chunk);
    }
  } finally { await output.close(); }
  const actualSha256 = digest.digest('hex');
  const evidence = { url: distribution.url, expectedSha256: distribution.sha256, actualSha256,
    archiveBytes: bytes, digestSource: distribution.digestSource,
    ...(distribution.digestReference ? { digestReference: distribution.digestReference } : {}),
    downloadTimeoutMs: 180_000, archiveByteLimit };
  if (actualSha256 !== distribution.sha256) throw Object.assign(new Error('archive-sha256-mismatch'), { evidence });
  return evidence;
}

export async function extractInterfaceArchive(file, destination, env) {
  // A new owned directory, regular files/directories only, and bounded streaming
  // extraction avoid following archive links or writing archive owner metadata.
  await fs.mkdir(destination, { mode: 0o700 });
  let result;
  try {
    result = await promisify(execFile)('/usr/bin/python3', ['-c', extractionScript, file, destination], {
      cwd: path.dirname(destination), env, timeout: 60_000, maxBuffer: 16 * 1024,
      encoding: 'utf8', killSignal: 'SIGKILL',
    });
  } catch (cause) {
    throw Object.assign(new Error('archive-extraction-failed'), { extractionFailure: {
      exitCode: cause.code, signal: cause.signal, killed: cause.killed, stderr: cause.stderr,
      processManagement: 'bounded direct child; not client process-tree evidence',
    } });
  }
  return { ...JSON.parse(result.stdout), timeoutMs: 60_000, expandedByteLimit: 768 * 1024 * 1024,
    links: 'rejected', processManagement: 'bounded direct child; not client process-tree evidence' };
}

function commandEvidence(result) {
  return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    cancelled: result.cancelled, terminationReason: result.terminationReason,
    maxBufferExceeded: result.maxBufferExceeded, stdout: result.stdout, stderr: result.stderr,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    stdoutPreviewTruncated: (result.stdout ?? '').length > 4000,
    stderrPreviewTruncated: (result.stderr ?? '').length > 4000,
    processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
      descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } };
}

function interfaceConfirmed(commands) {
  const help = (id) => commands.find(command => command.id === id && command.status === 'observed');
  const text = (command) => command ? `${command.stdout}\n${command.stderr}` : '';
  // The pinned Go CLI documents list flags on plugin help and rejects
  // `plugin list --help`; do not require that unsupported parser path.
  const pluginHelp = text(help('plugin-help'));
  return /Usage:\s+antigravity plugin <command>/u.test(pluginHelp)
    && /^\s+list \[--json\]\s+List installed plugins\s*$/mu.test(pluginHelp);
}

export async function probeClientInterfaces(platform, launcher, context, runCommand = execute, options = {}) {
  const report = { platform, version: interfaceDistributions[platform].version, status: 'observed', commands: [],
    scope: { status: 'unverified', reason: 'No installation, update, dynamic content, or effective scope fixture was run.' },
    authentication: { status: 'unverified', credentials: 'none', login: 'not-requested' },
    nativeQualification: 'unverified; interface observations do not qualify Native support' };
  let processFailed = false;
  async function command(id, args, cwd = context.project) {
    const record = { id, args, cwd, executable: launcher.executable, prefix: launcher.prefix,
      stdin: 'EOF', timeoutMs: 30_000 };
    let result;
    try {
      result = await runCommand(launcher, args, { cwd, env: context.env, stdin: '', timeoutMs: 30_000,
        nativeClient: platform });
      Object.assign(record, commandEvidence(result));
      if (result.timedOut || result.cancelled || result.maxBufferExceeded || result.terminationReason !== 'complete'
        || result.containmentMode !== 'verified-observed' || result.gradingEvidenceAccepted !== true) {
        record.status = 'failed'; record.reason = 'process-contract-failed'; processFailed = true;
      } else if (result.exitCode !== 0) {
        record.status = 'failed'; record.reason = 'client-exit-nonzero';
        record.authenticationFailurePossible = /auth|sign.?in|log.?in|credential|token/iu.test(`${result.stdout}\n${result.stderr}`);
      } else record.status = 'observed';
      if (id === 'version' && record.status === 'observed') {
        record.versionMatched = new RegExp(`(^|[^a-zA-Z0-9.])${report.version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}($|[^a-zA-Z0-9.])`, 'u')
          .test(`${result.stdout}\n${result.stderr}`);
        if (!record.versionMatched) { record.status = 'failed'; record.reason = 'client-version-mismatch'; }
      }
    } catch (error) {
      record.status = 'failed'; record.reason = 'process-or-cleanup-failed'; processFailed = true;
      record.processFailure = error?.message;
      record.processDiagnostics = (error?.processTreeDiagnostics ?? []).slice(0, 2);
      if (error?.result) Object.assign(record, commandEvidence(error.result));
    }
    const evidence = redactProbe(record, context.root);
    report.commands.push(evidence);
    if (record.status === 'failed') report.status = 'failed';
    return record;
  }
  const commands = [['version', ['--version']], ['help', ['--help']], ['plugin-help', ['plugin', '--help']]];
  if (platform === 'cursor') commands.push(['plugin-marketplace-help', ['plugin', 'marketplace', '--help']]);
  for (const [id, args] of commands) {
    await command(id, args);
    if (processFailed) break;
  }
  if (platform === 'antigravity') {
    if (!processFailed && report.commands[0]?.versionMatched && interfaceConfirmed(report.commands)) {
      for (const [id, cwd] of [['target-plugin-list', context.project], ['neutral-plugin-list', context.neutral]]) {
        await command(id, ['plugin', 'list', '--json'], cwd);
        if (processFailed) break;
      }
    } else report.inventory = { status: 'unverified', reason: 'Fixed version and plugin list --json parser were not confirmed.' };
  } else report.inventory = { status: 'unverified', reason: 'Marketplace list is account-visible; no account query was requested.' };
  if (platform === 'antigravity' && options.localManagement && !processFailed && report.status === 'observed'
    && report.commands.filter(entry => entry.id.endsWith('-plugin-list')).length === 2
    && report.commands.filter(entry => entry.id.endsWith('-plugin-list')).every(entry => entry.stdout.trim() === '[]')) {
    report.management = await probeAntigravityLocalManagement({ ...context, executable: launcher.executable }, command, renderPackage);
    if (report.management.status !== 'observed') { report.status = 'failed'; report.reason = 'initial-management-or-scope-unverified'; }
  }
  report.authentication.failurePossible = report.commands.some(command => command.authenticationFailurePossible);
  report.processContract = processFailed ? 'failed' : 'verified-observed retained for every executed command';
  return redactProbe(report, context.root);
}

export function parseInterfaceProbeArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--candidate', '--report'].includes(name) || options[name.slice(2)] || !args[index + 1]
      || args[index + 1].startsWith('--')) throw new Error('invalid-interface-probe-arguments');
    options[name.slice(2)] = args[index + 1];
  }
  if (!options.candidate || !options.report) throw new Error('invalid-interface-probe-arguments');
  return options;
}

export async function runInterfaceProbes(options) {
  const report = { schemaVersion: 1, kind: 'native-platform-interface-probes', status: 'failed',
    createdAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch },
    run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA },
    boundary: { hostedOnly: true, host: 'ubuntu-24.04 x64', qualification: 'unverified', scope: 'unverified',
      credentials: 'empty temporary runtime whitelist', stdin: 'EOF', sessions: 'none', models: 'none',
      network: 'blocking HTTP(S)/ALL proxies for client commands; not an OS firewall',
      clientProcessContract: 'existing execute verified-observed; no independent-group exception',
      localManagement: 'Antigravity candidate-only User version/same-version refresh with native consumer bytes; Project directory and uninvoked agent inventory observations' }, clients: [] };
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || process.arch !== 'x64') throw new Error('hosted-linux-x64-required');
    report.candidate = await verifyCandidate(options.candidate);
    for (const [platform, distribution] of Object.entries(interfaceDistributions)) {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-interface-')));
      let client = { platform, version: distribution.version, status: 'failed', cleanup: 'pending',
        scope: { status: 'unverified' }, acquisition: { url: distribution.url, expectedSha256: distribution.sha256,
          digestSource: distribution.digestSource } };
      try {
        const env = await prepareEnvironment(root);
        const archive = path.join(root, 'client.tar.gz');
        client.acquisition = await downloadInterfaceArchive(distribution, archive);
        const directory = path.join(root, 'distribution');
        client.extraction = await extractInterfaceArchive(archive, directory, env);
        const entries = [];
        for (const relative of distribution.entries) {
          const file = path.join(directory, relative);
          if (!(await fs.lstat(file)).isFile()) throw new Error('client-entry-unavailable');
          entries.push({ path: file, sha256: sha256(await fs.readFile(file)) });
        }
        client.entries = entries;
        const launcher = { executable: entries[0].path, prefix: platform === 'cursor' ? [entries[1].path] : [] };
        if (platform === 'cursor') {
          env.CURSOR_INVOKED_AS = 'cursor-agent';
          env.NODE_COMPILE_CACHE = path.join(env.XDG_CACHE_HOME, 'cursor-compile-cache');
        }
        const project = path.join(root, 'project');
        const neutral = path.join(root, 'neutral');
        await fs.mkdir(project); await fs.mkdir(neutral);
        if (platform === 'antigravity') {
          const setup = await execute({ executable: 'git', prefix: [] }, ['init', '--quiet', '--template=', '--initial-branch=qualification', project], { cwd: root, env });
          assertCommand(setup);
          client.projectSetup = commandEvidence(setup);
        }
        Object.assign(client, await probeClientInterfaces(platform, launcher, { root, project, neutral, env }, execute, { localManagement: platform === 'antigravity' }));
      } catch (error) {
        client.status = 'failed'; client.reason = error?.message;
        if (error?.evidence) client.acquisition = error.evidence;
        if (error?.extractionFailure) client.extractionFailure = error.extractionFailure;
        if (error?.code) client.errorCode = error.code;
      } finally {
        try { await fs.rm(root, { recursive: true, force: true }); client.cleanup = 'completed'; }
        catch (error) { client.status = 'failed'; client.cleanup = 'failed'; client.cleanupError = error?.code ?? 'cleanup-failed'; }
        report.clients.push(redactProbe(client, root));
      }
    }
    report.status = report.clients.some(client => client.status === 'failed') ? 'failed' : 'observed';
  } catch (error) { report.reason = error?.message; }
  await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
  await fs.writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runInterfaceProbes(parseInterfaceProbeArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ status: report.status, qualification: 'unverified', scope: 'unverified' }));
    process.exitCode = report.status === 'observed' ? 0 : 1;
  } catch { console.error('Interface probe setup failed.'); process.exitCode = 1; }
}
