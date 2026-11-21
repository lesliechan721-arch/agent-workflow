import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseAntigravityUserArgs, probeAntigravityUser, qualifyAntigravityUserScopes, runAntigravityUserQualification } from './native-platform-antigravity-user.mjs';
import { prepareEnvironment, writeCandidate } from './native-platform-runtime.mjs';
import { redact } from './native-platforms.mjs';
import { qualifyPublicAw } from './native-platform-public-aw.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agy-user-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'target'), neutral = path.join(root, 'neutral');
  await fs.mkdir(project); await fs.mkdir(neutral);
  return { root, project, neutral, env: await prepareEnvironment(root) };
}

function completed(stdout = '', patch = {}) {
  return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false,
    terminationReason: 'complete', containmentMode: 'verified-observed', gradingEvidenceAccepted: true,
    descendantCleanupGuaranteed: process.platform === 'win32', ...patch };
}

function nativeFixture(context, { staleRefresh = false, program = process.platform === 'win32' ? 'antigravity.exe' : 'antigravity' } = {}) {
  let installed = false, installs = 0;
  const cache = path.join(context.env.HOME, '.gemini/config/plugins/aw-local-management-user');
  const calls = [];
  const run = async (launcher, args, options) => {
    calls.push({ args, options });
    assert.equal(options.stdin, ''); assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.nativeClient, 'antigravity'); assert.equal(options.antigravityAgentObservation, undefined);
    assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:1');
    assert.equal(options.env.HOME, context.env.HOME);
    if (args[0] === '--version') return completed('Antigravity 1.3.4\n');
    assert.equal(args[0], 'plugin');
    if (args[1] === '--help') return completed(`Usage: ${program} plugin <command> [arguments]\n  list [--json]          List installed plugins\n`);
    if (args[1] === 'validate') assert.equal((await fs.stat(path.join(args[2], 'skills/management-check/SKILL.md'))).isFile(), true);
    if (args[1] === 'install') {
      installs++;
      if (!staleRefresh || installs !== 3) {
        await fs.rm(cache, { recursive: true, force: true }); await fs.cp(args[2], cache, { recursive: true });
      }
      installed = true;
    }
    if (args[1] === 'uninstall') { await fs.rm(cache, { recursive: true }); installed = false; }
    const manifest = installed ? JSON.parse(await fs.readFile(path.join(cache, '.antigravity-plugin/plugin.json'), 'utf8')) : null;
    return completed(JSON.stringify(installed ? [{ name: 'aw-local-management-user', source: 'antigravity', path: cache,
      enabled: true, version: manifest.version, skills: ['management-check'] }] : []));
  };
  return { run, calls, cache };
}

// Test Value Gate: the independent runner must preserve raw native paths until
// all actual file oracles finish, then produce a bounded redacted report.
test('qualifies only User management with actual consumer bytes and unknown loading', async t => {
  const context = await fixture(t); const fake = nativeFixture(context);
  const client = { scopes: [], status: 'failed' };
  await qualifyAntigravityUserScopes(client, { executable: '/fixed/antigravity', prefix: [] }, context, {}, fake.run,
    async () => assert.fail('Default direct qualification must not request public AW.'));
  const observed = client.scopes[0];
  assert.equal(client.status, 'passed'); assert.equal(Object.hasOwn(client, 'publicAw'), false);
  assert.equal(observed.status, 'passed', JSON.stringify(observed));
  assert(observed.checks.every(check => check.status === 'passed'));
  assert.equal(observed.observations[0].status, 'unverified');
  assert.deepEqual(observed.management.scopes.map(scope => scope.scope), ['user']);
  assert.deepEqual(observed.management.scopes[0].revisions.map(row => row.version), ['1.0.1', '1.0.2', '1.0.2']);
  const revisions = observed.management.scopes[0].revisions;
  assert.notEqual(revisions[1].consumers[0].actualSha256, revisions[2].consumers[0].actualSha256);
  assert(revisions.every(row => row.consumers.length === 2 && row.consumers.every(item => item.matches) && row.ownerMarkerPreserved));
  assert(observed.commands.filter(command => command.args.join(' ') === 'plugin list --json')
    .some(command => JSON.parse(command.stdout).some(row => row.path === fake.cache)));
  assert(fake.calls.every(call => !call.args.includes('agents')));
  assert.equal(observed.commands[0].processManagement.mode, 'verified-observed');
  const publicReport = redact(observed, context.root);
  assert(!JSON.stringify(publicReport).includes(context.root));
  assert.match(publicReport.management.scopes[0].revisions[0].consumers[0].path, /<TEMP_ROOT>/u);
  await assert.rejects(fs.stat(fake.cache), { code: 'ENOENT' });
});

// Test Value Gate: the real Windows binary prints its .exe suffix; parser
// qualification must still retain the fixed version and JSON inventory checks.
test('accepts the observed Windows executable name in the fixed plugin help', async t => {
  const context = await fixture(t); const fake = nativeFixture(context, { program: 'antigravity.exe' });
  const observed = await probeAntigravityUser({ executable: '/fixed/antigravity.exe', prefix: [] }, context, fake.run);
  assert.equal(observed.status, 'passed', JSON.stringify(observed));
  assert.equal(observed.checks[0].status, 'passed');
  assert(observed.commands.some(command => command.args.join(' ') === 'plugin list --json'));
});

test('does not accept a successful same-version install with old native bytes', async t => {
  const context = await fixture(t); const fake = nativeFixture(context, { staleRefresh: true });
  const client = { scopes: [], status: 'failed' };
  await qualifyAntigravityUserScopes(client, { executable: '/fixed/antigravity', prefix: [] }, context, { publicAw: true }, fake.run,
    async () => assert.fail('Incomplete direct qualification must not reach public AW.'));
  const report = client.scopes[0];
  assert.equal(report.status, 'failed'); assert.equal(report.reason, 'native-consumer-content-mismatch');
  assert.equal(client.status, 'failed'); assert.deepEqual(client.publicAw, []);
  assert.equal(fake.calls.at(-1).args[1], 'list');
  assert(!fake.calls.some(call => call.args[1] === 'uninstall'));
});

// Test Value Gate: strict process failures stop immediately. Windows still
// reports the actual requested containment mode and requires its Job guarantee.
test('retains actual process failures and never continues into client management', async t => {
  const failures = [
    ['deadline', () => completed('1.3.4', { timedOut: true, terminationReason: 'timeout' })],
    ['cancelled', () => completed('1.3.4', { cancelled: true, terminationReason: 'abort' })],
    ['output limit', () => completed('1.3.4', { maxBufferExceeded: true })],
    ['nonzero', () => completed('', { exitCode: 7 })],
    ['ordinary observation', () => completed('1.3.4', { containmentMode: 'observed', gradingEvidenceAccepted: false })],
    ['cleanup failure', () => { throw Object.assign(new Error('cleanup-unconfirmed'), {
      result: completed('1.3.4'), processTreeDiagnostics: [{ code: 'marker-unreadable' }],
    }); }],
  ];
  for (const [name, fail] of failures) await t.test(name, async subtest => {
    const context = await fixture(subtest); let calls = 0;
    const client = { scopes: [], status: 'failed' };
    await qualifyAntigravityUserScopes(client, { executable: '/fixed/antigravity', prefix: [] }, context, { publicAw: true },
      async () => { calls++; return fail(); }, async () => assert.fail('Process failure must stop before public AW.'));
    const report = client.scopes[0];
    assert.equal(report.status, 'failed'); assert.equal(calls, 1); assert.equal(report.commands[0].status, 'failed');
    assert.equal(client.status, 'failed'); assert.deepEqual(client.publicAw, []);
    if (name === 'cleanup failure') {
      assert.equal(report.commands[0].stdout, '1.3.4');
      assert.equal(report.commands[0].processManagement.mode, 'verified-observed');
      assert.deepEqual(report.commands[0].processDiagnostics, [{ code: 'marker-unreadable' }]);
    }
  });
  const context = await fixture(t);
  const missingJob = await probeAntigravityUser({ executable: '/fixed/antigravity.exe', prefix: [] }, context,
    async () => completed('1.3.4', { descendantCleanupGuaranteed: false }), { platform: 'win32' });
  assert.equal(missingJob.status, 'failed');
  assert.equal(missingJob.commands[0].processManagement.mode, 'verified-observed');
  assert.equal(missingJob.commands[0].processManagement.descendantCleanupGuaranteed, false);
});

test('requires source-bound arguments and an explicit, non-duplicate public AW flag', () => {
  assert.deepEqual(parseAntigravityUserArgs(['--candidate', 'candidate.json', '--report', 'report.json']), { candidate: 'candidate.json', report: 'report.json' });
  assert.deepEqual(parseAntigravityUserArgs(['--public-aw', '--candidate', 'candidate.json', '--report', 'report.json']),
    { 'public-aw': true, candidate: 'candidate.json', report: 'report.json' });
  assert.deepEqual(parseAntigravityUserArgs(['--candidate', 'candidate.json', '--report', 'report.json', '--public-aw']),
    { candidate: 'candidate.json', report: 'report.json', 'public-aw': true });
  for (const args of [[], ['--report', 'report.json'], ['--candidate', 'one', '--candidate', 'two', '--report', 'out'],
    ['--candidate', 'one', '--report', 'out', '--scope', 'project'], ['--candidate', 'one', '--report', 'out', '--public-aw', '--public-aw'],
    ['--candidate', 'one', '--report', 'out', '--public-aw', 'false']]) assert.throws(() => parseAntigravityUserArgs(args), /invalid-antigravity-user-arguments/u);
});

// Test Value Gate: requested public work follows completed direct removal, uses
// a private acquired-client bin and keeps nonblocking unknown observations.
test('records one requested public User scope after the direct User scenario passes', async t => {
  const context = await fixture(t); const fake = nativeFixture(context);
  const launcher = { executable: '/fixed/antigravity', prefix: [] };
  const client = { scopes: [], status: 'failed' }; let calls = 0;
  const publicScope = { scope: 'user', input: 'public-aw-cli', status: 'passed', cleanup: 'completed', checks: [],
    commands: [{ exitCode: 3, terminationReason: 'complete', processManagement: { mode: 'observed', gradingEvidenceAccepted: false } }],
    observations: [{ id: 'status-and-loading', status: 'unverified' }] };
  await qualifyAntigravityUserScopes(client, launcher, context, { publicAw: true }, fake.run, async (...args) => {
    calls++;
    assert.deepEqual(args, ['antigravity', 'user', launcher, { publicAw: true, clientBin: path.join(context.root, 'public-client-bin') }]);
    await assert.rejects(fs.stat(fake.cache), { code: 'ENOENT' });
    return publicScope;
  });
  assert.equal(calls, 1); assert.equal(client.status, 'passed');
  assert.equal(client.scopes.length, 1); assert.deepEqual(client.publicAw, [publicScope]);
});

test('cannot hide incomplete public checks, cleanup or process failures behind direct success', async t => {
  for (const patch of [{ status: 'unverified', reason: 'production-profile-unverified' }, { cleanup: 'failed' },
    { commands: [{ exitCode: 0, processFailure: 'cleanup-unconfirmed' }] },
    { commands: [{ exitCode: 0, terminationReason: 'timeout', timedOut: true }] }]) await t.test(JSON.stringify(patch), async subtest => {
    const context = await fixture(subtest); const fake = nativeFixture(context); const client = { scopes: [], status: 'failed' };
    const publicScope = { scope: 'user', input: 'public-aw-cli', status: 'passed', cleanup: 'completed', checks: [], commands: [], ...patch };
    await qualifyAntigravityUserScopes(client, { executable: '/fixed/antigravity', prefix: [] }, context, { publicAw: true }, fake.run,
      async () => publicScope);
    assert.equal(client.scopes[0].status, 'passed'); assert.equal(client.status, 'failed');
    assert.deepEqual(client.publicAw, [publicScope]);
  });
});

test('retains Hosted User and actual production profile gates before public writes', async t => {
  const context = await fixture(t); const previous = process.env.GITHUB_ACTIONS;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous; });
  const defer = async reason => { throw new Error(reason); };
  for (const [scope, hosted] of [['project', 'true'], ['user', 'false']]) {
    process.env.GITHUB_ACTIONS = hosted;
    await assert.rejects(qualifyPublicAw({ platform: 'antigravity', scope, defer }), /antigravity-public-aw-limited-to-hosted-user/u);
  }
  process.env.GITHUB_ACTIONS = 'true';
  const { getQualifiedPlatformProfile, getQualifiedKindsForScope } = await import('../../packages/cli/dist/src/platforms/capabilities.js');
  const profile = getQualifiedPlatformProfile('antigravity');
  const qualified = getQualifiedKindsForScope(profile, 'user').skill.status === 'supported'
    && profile.qualifiedConsumers?.skill?.some(consumer => consumer.product === 'cli' && consumer.version === '1.3.4');
  const executable = path.join(context.root, `antigravity${process.platform === 'win32' ? '.exe' : ''}`);
  await fs.writeFile(executable, 'controlled acquired entry');
  const calls = [];
  const ctx = { ...context, platform: 'antigravity', scope: 'user', defer,
    launcher: { executable, prefix: [] }, clientBin: path.join(context.root, 'private-bin'),
    async check(id, action) { return action(); },
    async aw(args) {
      calls.push(args);
      assert.deepEqual(args, ['target', 'set', 'antigravity']);
      return { data: { availability: [{ id: 'antigravity', availability: 'available', installations: [{ product: 'cli', version: '1.3.5',
        entry: { kind: 'cli', executable } }] }] } };
    } };
  await assert.rejects(qualifyPublicAw(ctx), qualified ? /must discover the acquired fixed-version antigravity client/u : /public-aw-production-skill-profile-unverified/u);
  assert.equal(calls.length, qualified ? 1 : 0);
  if (!qualified) await assert.rejects(fs.stat(ctx.clientBin), { code: 'ENOENT' });
});

test('fails candidate verification before acquisition or any client execution', async t => {
  const context = await fixture(t); const previous = process.env.GITHUB_ACTIONS;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous; });
  process.env.GITHUB_ACTIONS = 'true';
  const report = await runAntigravityUserQualification({ candidate: path.join(context.root, 'missing-candidate.json'), report: path.join(context.root, 'report.json') });
  assert.equal(report.status, 'failed'); assert.equal(report.clients[0].reason, 'ENOENT');
  assert.equal(report.candidate, undefined); assert.deepEqual(report.clients[0].scopes, []);
  assert.equal(report.clients[0].acquisition, undefined); assert.equal(report.clients[0].cleanup, 'not-started');
});

async function runProjectSetupFixture(t, initializeProject) {
  const context = await fixture(t);
  const previous = process.env.GITHUB_ACTIONS;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous; });
  process.env.GITHUB_ACTIONS = 'true';
  const candidate = path.join(context.root, 'candidate.json');
  const reportPath = path.join(context.root, 'report.json');
  const candidateRoot = path.join(context.root, 'build');
  for (const directory of ['packages/cli/dist', 'packages/cli/plugins-dist', 'packages/plugin-core/dist',
    'packages/plugin-core/schemas', 'packages/agent-skill-eval/dist', 'scripts/qualification']) {
    await fs.mkdir(path.join(candidateRoot, directory), { recursive: true });
  }
  await fs.writeFile(path.join(candidateRoot, 'packages/cli/dist/index.js'), '// controlled candidate');
  await writeCandidate(candidate, process.env.GITHUB_SHA ?? 'a'.repeat(40), candidateRoot);
  let ownedRoot;
  const report = await runAntigravityUserQualification({ candidate, report: reportPath, 'public-aw': true }, {
    candidateRoot,
    async acquireDistribution(root) {
      ownedRoot = root;
      return { acquisition: {}, extraction: {}, entry: { path: path.join(root, 'antigravity'), sha256: 'a'.repeat(64) } };
    },
    async initializeProject(launcher, args, options) {
      assert.deepEqual(launcher, { executable: 'git', prefix: [] });
      assert.deepEqual(args, ['init', '--quiet', '--template=', '--initial-branch=qualification', path.join(ownedRoot, 'target')]);
      assert.equal(options.timeoutMs, 30_000);
      return initializeProject();
    },
  });
  return { report, written: await fs.readFile(reportPath, 'utf8'), ownedRoot };
}

// Test Value Gate: a cleanup failure during project setup must be identifiable
// in the public report without publishing any process command or output.
test('reports an unconfirmed Git setup even after the isolated root is removed', { skip: process.platform === 'win32' }, async t => {
  const privateData = 'private-process-fixture-value';
  const earlierDiagnostic = { stage: 'observation', reason: 'marker-lookup-failed', markerLookupSucceeded: null,
    lookupFailure: { reason: 'callback-error', code: 'EPERM', signal: 'SIGKILL', killed: true } };
  const diagnostic = { stage: 'termination-start', reason: 'marker-lookup-failed', markerLookupSucceeded: false,
    snapshotStartedAt: 100, snapshotDeadline: 2_100, markerLookupAttempts: 1, lookupFailure: { reason: 'deadline-exceeded' },
    queries: [{ kind: 'marker', startedAt: 100, deadline: 2_100, callbackState: 'pending', completion: 'deadline' }] };
  const trace = { sequence: 1, queryKind: 'marker-ps', startedAt: 100, timeoutMs: 2_000, status: 'pending' };
  const callback = { sequence: 2, queryKind: 'identity-ps', startedAt: 100, callbackAt: 2_100, status: 'callback-error', errorCategory: 'timeout' };
  const { report, written, ownedRoot } = await runProjectSetupFixture(t, () => {
    throw Object.assign(new Error(privateData), {
      result: completed(privateData, { stderr: privateData, gradingEvidenceAccepted: false }),
      processTreeDiagnostics: [earlierDiagnostic, { ...diagnostic, commands: [privateData],
        lookupFailure: { ...diagnostic.lookupFailure, code: privateData, signal: privateData, killed: 7 },
        queries: [{ ...diagnostic.queries[0], callbackAt: privateData, settledAt: 1.25, failureReason: privateData }] }],
      publicAwProcessQueryTimings: { clock: privateData, source: 'existing-observer-execFile-callbacks',
        records: [{ ...trace, environment: privateData, stdout: privateData, errorCategory: privateData }, callback], omitted: 0 },
    });
  });
  const client = report.clients[0];
  assert.equal(report.status, 'failed');
  assert.equal(client.reason, 'project-setup-process-unconfirmed');
  assert.equal(client.cleanup, 'completed');
  assert.deepEqual(client.scopes, []);
  assert.equal(client.publicAw, undefined);
  assert.equal(written.includes(privateData), false);
  assert.deepEqual(client.projectSetup, { stage: 'git-init', status: 'failed', timeoutMs: 30_000,
    exitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false, terminationReason: 'complete',
    processManagement: { mode: 'verified-observed', gradingEvidenceAccepted: false, descendantCleanupGuaranteed: false },
    processDiagnostics: [earlierDiagnostic, diagnostic],
    processQueryTimings: { source: 'existing-observer-execFile-callbacks', records: [trace, callback], omitted: 0 } });
  await assert.rejects(fs.stat(ownedRoot), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(written), report);
});

// Test Value Gate: the Windows helper's own failure exit cannot certify cleanup
// even when the process result initializes both evidence flags as true.
test('keeps Windows helper exit 250 unconfirmed in the Git setup report', { skip: process.platform === 'win32' }, async t => {
  const { written } = await runProjectSetupFixture(t, () => completed('', {
    exitCode: 250, gradingEvidenceAccepted: true, descendantCleanupGuaranteed: true,
  }));
  const diagnostic = JSON.parse(written);
  assert.equal(diagnostic.status, 'failed');
  const client = diagnostic.clients[0];
  assert.equal(client.reason, 'command-failed');
  assert.equal(client.projectSetup.stage, 'git-init');
  assert.equal(client.projectSetup.status, 'failed');
  assert.equal(client.projectSetup.exitCode, 250);
  assert.deepEqual(client.projectSetup.processManagement, { mode: 'verified-observed' });
  assert.deepEqual(client.scopes, []);
});
