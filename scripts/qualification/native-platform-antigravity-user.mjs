import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCommand, execute, hostInfo, prepareEnvironment, processManagementInfo, renderPackage, sha256, verifyCandidate } from './native-platform-runtime.mjs';
import { redact, runScope } from './native-platforms.mjs';
import { acquireAntigravityDistribution, getAntigravityDistribution } from './native-platform-antigravity-distributions.mjs';
import { probeAntigravityLocalManagement } from './native-platform-antigravity-management.mjs';

export function parseAntigravityUserArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--public-aw' && !Object.hasOwn(options, 'public-aw')) { options['public-aw'] = true; continue; }
    if (!['--candidate', '--report'].includes(flag) || Object.hasOwn(options, flag.slice(2)) || !args[index + 1]
      || args[index + 1].startsWith('--')) throw new Error('invalid-antigravity-user-arguments');
    options[flag.slice(2)] = args[++index];
  }
  if (!options.candidate || !options.report) throw new Error('invalid-antigravity-user-arguments');
  return options;
}

function commandEvidence(result) {
  return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    cancelled: result.cancelled, terminationReason: result.terminationReason, maxBufferExceeded: result.maxBufferExceeded,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    stdoutPreviewTruncated: (result.stdout ?? '').length > 4000, stderrPreviewTruncated: (result.stderr ?? '').length > 4000,
    processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
      descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } };
}

/** Keep raw native paths until the management and consumer-file oracles finish. */
export async function probeAntigravityUser(launcher, context, runCommand = execute, host = process) {
  const report = { scope: 'user', input: 'aw-projection-candidate', status: 'failed', checks: [], commands: [],
    observations: [{ id: 'skill-loading-and-model-adoption', status: 'unverified', reason: 'No session, prompt, model or Skill invocation was requested.' }] };
  let failed = false;
  const command = async (id, args, cwd) => {
    if (failed) throw new Error('native-command-after-failure');
    const record = { id, args, cwd, executable: launcher.executable, prefix: launcher.prefix, stdin: 'EOF', timeoutMs: 30_000 };
    try {
      const result = await runCommand(launcher, args, { cwd, env: context.env, stdin: '', timeoutMs: 30_000, nativeClient: 'antigravity' });
      Object.assign(record, commandEvidence(result));
      const strict = result.containmentMode === 'verified-observed' && result.gradingEvidenceAccepted === true
        && (host.platform !== 'win32' || result.descendantCleanupGuaranteed === true);
      record.status = strict && result.exitCode === 0 && result.signal === null && result.timedOut === false
        && result.cancelled === false && result.maxBufferExceeded === false && result.terminationReason === 'complete' ? 'observed' : 'failed';
      if (record.status === 'failed') record.reason = strict && result.exitCode !== 0 ? 'client-exit-nonzero' : 'process-contract-failed';
    } catch (error) {
      if (error?.result) Object.assign(record, commandEvidence(error.result));
      record.status = 'failed'; record.reason = 'process-or-cleanup-failed'; record.processFailure = error?.message;
      record.processDiagnostics = (error?.processTreeDiagnostics ?? []).slice(0, 2);
    }
    report.commands.push(record);
    failed ||= record.status === 'failed';
    return record;
  };
  const required = async (id, action) => {
    const check = { id, status: 'failed' }; report.checks.push(check);
    try { check.evidence = await action(); check.status = 'passed'; return check.evidence; }
    catch (error) { check.reason = error?.message; throw error; }
  };
  try {
    await required('fixed-client-version-and-interface', async () => {
      const version = await command('version', ['--version'], context.project);
      if (version.status !== 'observed' || !/(^|[^a-zA-Z0-9.])1\.3\.4($|[^a-zA-Z0-9.])/u.test(`${version.stdout}\n${version.stderr}`)) {
        throw new Error('client-version-unconfirmed');
      }
      const help = await command('plugin-help', ['plugin', '--help'], context.project);
      if (help.status !== 'observed' || !/Usage:\s+antigravity plugin <command>/u.test(`${help.stdout}\n${help.stderr}`)
        || !/^\s+list \[--json\]\s+List installed plugins\s*$/mu.test(`${help.stdout}\n${help.stderr}`)) throw new Error('plugin-json-interface-unconfirmed');
      return { version: '1.3.4' };
    });
    await required('fresh-empty-user-inventories', async () => {
      for (const [id, cwd] of [['initial-target-list', context.project], ['initial-neutral-list', context.neutral]]) {
        const record = await command(id, ['plugin', 'list', '--json'], cwd);
        if (record.status !== 'observed' || !Array.isArray(JSON.parse(record.stdout)) || JSON.parse(record.stdout).length !== 0) {
          throw new Error('initial-user-inventory-not-empty');
        }
      }
      return { target: 'absent', neutral: 'absent' };
    });
    const management = await required('user-install-version-and-same-version-refresh', async () => {
      const value = await probeAntigravityLocalManagement(context, command, renderPackage, { scopes: ['user'] });
      report.management = value;
      if (value.status !== 'observed' || value.scopes.length !== 1 || value.scopes[0].scope !== 'user') throw new Error(value.reason ?? 'user-management-unconfirmed');
      return value;
    });
    const user = management.scopes[0];
    await required('effective-user-scope-in-both-working-directories', async () => {
      if (user.scopeEvidence !== 'observed') throw new Error('user-scope-unconfirmed');
      return { target: 'enabled', neutral: 'enabled' };
    });
    await required('actual-native-consumer-bytes-for-all-three-revisions', async () => {
      if (user.revisions.length !== 3 || user.revisions.some(row => row.consumers.length !== 2 || row.consumers.some(consumer => !consumer.matches))) {
        throw new Error('native-consumer-content-unconfirmed');
      }
      return user.revisions.map(({ revision, version, consumers }) => ({ revision, version, consumers }));
    });
    await required('standard-aw-owner-copied-for-all-three-revisions', async () => {
      if (user.revisions.some(row => row.ownerMarkerPreserved !== true)) throw new Error('native-owner-marker-unconfirmed');
      return { revisions: user.revisions.map(row => row.revision) };
    });
    await required('uninstall-absent-in-both-working-directories', async () => {
      if (user.removed !== true) throw new Error('user-removal-unconfirmed');
      return { target: 'absent', neutral: 'absent' };
    });
    report.status = 'passed';
  } catch (error) { report.reason = error?.message ?? 'user-qualification-failed'; }
  return report;
}

function scopeProcessFailed(scope) {
  return scope.commands.some(command => Object.hasOwn(command, 'processFailure') || command.timedOut || command.cancelled
    || command.maxBufferExceeded || command.terminationReason && command.terminationReason !== 'complete'
    || command.reason === 'process-contract-failed' || command.reason === 'process-or-cleanup-failed');
}

/** Public AW uses runScope's separate home; the acquired launcher stays in its owned root. */
export async function qualifyAntigravityUserScopes(client, launcher, context, options = {}, runNativeCommand = execute, runPublicScope = runScope) {
  const direct = await probeAntigravityUser(launcher, context, runNativeCommand);
  client.scopes.push(direct);
  client.status = direct.status === 'passed' && !scopeProcessFailed(direct) ? 'passed' : 'failed';
  if (!options.publicAw) return;
  client.publicAw = [];
  if (client.status !== 'passed') return;
  const publicScope = await runPublicScope('antigravity', 'user', launcher,
    { publicAw: true, clientBin: path.join(context.root, 'public-client-bin') });
  client.publicAw.push(publicScope);
  if (publicScope.status !== 'passed' || publicScope.cleanup !== 'completed' || scopeProcessFailed(publicScope)) {
    client.status = 'failed';
    client.reason = publicScope.reason ?? 'public-aw-process-or-cleanup-unconfirmed';
  }
}

export async function runAntigravityUserQualification(options) {
  const publicAwRequested = options['public-aw'] === true;
  const client = { platform: 'antigravity', requiredVersion: '1.3.4', status: 'failed', scopes: [], cleanup: 'not-started' };
  const report = { schemaVersion: 2, kind: 'antigravity-user-native-qualification', status: 'failed', createdAt: new Date().toISOString(),
    acceptancePolicy: { id: 'management-content-scope-v1' }, environment: hostInfo(),
    run: { id: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, sha: process.env.GITHUB_SHA ?? null },
    boundary: { hostedOnly: true, credentials: 'empty temporary HOME/AW/Agent/XDG roots', modelRequests: 'none', sessions: 'none',
      scopes: ['user'], stdin: 'EOF', nativeCommandTimeoutMs: 30_000, productionQualificationChanged: false, publicAwRequested,
      runtimeNetwork: 'blocked proxies; not an OS firewall', acquisition: 'fixed official GitHub release asset; no npm or install scripts',
      processContract: 'direct Native uses existing strict execute; requested public AW uses its existing ordinary observation; actual command metadata and Windows helper evidence are recorded separately',
      uncovered: ['project', 'agents', 'other-kinds', 'model-adoption', 'invocation-controls', 'desktop', ...(publicAwRequested ? [] : ['public-aw'])] }, clients: [client] };
  let root;
  try {
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('hosted-runner-required');
    getAntigravityDistribution();
    report.candidate = await verifyCandidate(options.candidate);
    report.harnessSha256 = sha256(await fs.readFile(fileURLToPath(import.meta.url)));
    report.processManagement = await processManagementInfo();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-antigravity-user-')));
    const env = await prepareEnvironment(root);
    const acquired = await acquireAntigravityDistribution(root, env);
    Object.assign(client, { acquisition: acquired.acquisition, extraction: acquired.extraction, entries: [acquired.entry] });
    const project = path.join(root, 'target'), neutral = path.join(root, 'neutral');
    await fs.mkdir(project); await fs.mkdir(neutral);
    const setup = await execute({ executable: 'git', prefix: [] },
      ['init', '--quiet', '--template=', '--initial-branch=qualification', project],
      { cwd: root, env, stdin: '', timeoutMs: 30_000 });
    assertCommand(setup);
    client.projectSetup = commandEvidence(setup);
    await qualifyAntigravityUserScopes(client, acquired.launcher, { root, project, neutral, env, executable: acquired.entry.path },
      { publicAw: publicAwRequested });
  } catch (error) {
    client.status = 'failed'; client.reason = error?.code ?? error?.message ?? 'user-qualification-failed';
    if (error?.evidence) client.acquisition = error.evidence;
    if (error?.extractionFailure) client.extractionFailure = error.extractionFailure;
  } finally {
    if (root) {
      try { await fs.rm(root, { recursive: true, force: true }); client.cleanup = 'completed'; }
      catch (error) { client.status = 'failed'; client.cleanup = 'failed'; client.cleanupError = error?.code ?? 'cleanup-failed'; }
      for (const scope of client.scopes) {
        scope.cleanup = { status: client.cleanup, scopeRoot: 'isolated User home and scope directories' };
        scope.checks.push({ id: 'scope-and-acquisition-cleanup', status: client.cleanup === 'completed' ? 'passed' : 'failed' });
        if (client.cleanup !== 'completed') scope.status = 'failed';
      }
    }
  }
  report.status = client.status === 'passed' && client.cleanup === 'completed' ? 'passed' : 'failed';
  const publicReport = redact(report, root);
  await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
  await fs.writeFile(options.report, `${JSON.stringify(publicReport, null, 2)}\n`);
  return publicReport;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runAntigravityUserQualification(parseAntigravityUserArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ status: report.status, platform: 'antigravity', version: '1.3.4', scopes: ['user'] }));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch { console.error('Antigravity User qualification setup failed.'); process.exitCode = 1; }
}
