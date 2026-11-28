import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { aggregateQualificationStatus, parseArgs, run, runScope, versionFrom, redact, publicAwFailureSummary, removeQualificationRoot,
  readPublicAwEnvelope, readQualificationCodexSources, observeQualification } from './native-platforms.mjs';
import { readPublicAwStages } from './native-platform-stage-evidence.mjs';
import { qualificationGroup, qualificationPool } from './native-platform-qualification-group.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { repoRoot, isolatedEnvironment, prepareEnvironment, renderPackage, execute, assertCommand, writeCandidate, verifyCandidate, usesCopilotInventoryObservation } from './native-platform-runtime.mjs';
import { waitForRpcGroupExit } from './native-platform-rpc.mjs';
import { observeNativeWorkingDirectory, readSkills as readPublicSkills } from './native-platform-public-aw.mjs';
import { assertMixedInstallReceipt, mixedNativeInstallIntervals } from './native-platform-public-batch.mjs';
import './native-platform-process-names.test.mjs';
import './native-platform-marker-confirmations.test.mjs';
import './native-platform-process-query-timings.test.mjs';
import './native-platform-acquisition.test.mjs';
import './native-platform-copilot-skills.test.mjs';
import './native-platform-copilot-grok-manual.test.mjs';
import './native-platform-linux-environment.test.mjs';
import './native-platform-grok-bootstrap.test.mjs';
import './native-platform-managed-trace.test.mjs';
import './native-platform-public-state.test.mjs';
import './native-platform-opencode.test.mjs';
import './native-platform-opencode-public.test.mjs';
import './native-platform-codex-behavior.test.mjs';

// A failed unit must release its slot, even when a sibling has not finished.
test('bounds active qualification units and drains independent work after a failure', async () => {
  for (const limit of [1, 2]) {
    const runUnit = qualificationPool(limit);
    const started = [];
    const cleaned = [];
    const first = Promise.withResolvers();
    const full = Promise.withResolvers();
    let active = 0;
    const units = [0, 1, 2].map(id => runUnit(async () => {
      started.push(id);
      assert(++active <= limit);
      if (active === limit) full.resolve();
      try {
        if (id === 0) await first.promise;
        if (id === 1) throw new Error('fixture-failure');
        return id;
      } finally { active--; cleaned.push(id); }
    }));
    const results = Promise.allSettled(units);
    await full.promise;
    first.resolve();
    const outcomes = await results;
    assert.deepEqual(started, [0, 1, 2]);
    assert.deepEqual(cleaned.sort(), [0, 1, 2]);
    assert.deepEqual(outcomes.map(outcome => outcome.value ?? outcome.reason.message), [0, 'fixture-failure', 2]);
  }
});

test('retains only fixed shared-provider stages before an interrupted debug record', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-stage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'stages');
  const time = '2026-11-19T00:00:00.000Z';
  const row = (name) => JSON.stringify({ time, event: { type: 'performance:stage', message: 'private',
    data: { name, phase: 'success', durationMs: 12, detail: 'private' } } });
  await fs.writeFile(file, [row('recovery.child.plan'), row('private'), '{"partial"'].join('\n'));
  assert.deepEqual(await readPublicAwStages(file), { state: 'partial', records: [
    { time, name: 'recovery.child.plan', phase: 'success', durationMs: 12 },
  ] });
});

// Test Value Gate: a timed-out batch can emit more than the bounded log window.
// Preserve its final fixed progress without copying arbitrary debug content.
test('retains the last fixed AW stages in a bounded batch debug log', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-batch-stage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'stages');
  const time = '2026-11-19T00:00:00.000Z';
  const row = name => JSON.stringify({ time, event: { type: 'performance:stage',
    message: 'private debug message', data: { name, phase: 'success', durationMs: 12, detail: 'private detail' } } });
  const noise = JSON.stringify({ unrelated: 'private'.repeat(100) }) + '\n';
  await fs.writeFile(file, row('recovery.plan') + '\n' + noise.repeat(500)
    + row('recovery.child.execute') + '\n' + '{"partial"');
  const evidence = await readPublicAwStages(file, { retainTail: true });
  assert.equal(evidence.state, 'limited');
  assert.deepEqual(evidence.records, [
    { time, name: 'recovery.plan', phase: 'success', durationMs: 12 },
    { time, name: 'recovery.child.execute', phase: 'success', durationMs: 12 },
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /private|partial"/u);
});

// Test Value Gate: a runner using different runtime schema bytes cannot produce
// evidence for the built candidate even when its compiled JavaScript matches.
test('binds actual runtime schema bytes to the candidate', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-candidate-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const relative of ['packages/cli/dist', 'packages/cli/plugins-dist', 'packages/plugin-core/dist',
    'packages/plugin-core/schemas', 'packages/agent-skill-eval/dist', 'scripts/qualification']) {
    await fs.mkdir(path.join(root, relative), { recursive: true });
  }
  const schema = path.join(root, 'packages/plugin-core/schemas/platform-capabilities-v3.json');
  const manifest = path.join(root, 'candidate.json');
  const sourceSha = process.env.GITHUB_SHA ?? 'a'.repeat(40);
  await fs.writeFile(schema, '{"type":"object"}\n');
  await writeCandidate(manifest, sourceSha, root);
  assert.equal((await verifyCandidate(manifest, root)).sourceSha, sourceSha);
  const group = await qualificationGroup({ manifest, candidateRoot: root });
  const standalone = await qualificationGroup({ candidateRoot: root });
  await fs.writeFile(path.join(root, 'scripts/qualification/harness.mjs'), 'changed harness');
  await assert.rejects(standalone.finish(), /candidate-content-mismatch/u);
  await fs.unlink(path.join(root, 'scripts/qualification/harness.mjs'));
  await fs.writeFile(schema, '{"type":"string"}\n');
  await assert.rejects(group.finish(), /candidate-content-mismatch/u);
  await assert.rejects(verifyCandidate(manifest, root), /candidate-content-mismatch/u);
});

// Test Value Gate: local discovery can be observed or unavailable without
// changing the result of required management and scope checks.
test('records redacted discovery observations separately from required checks', async () => {
  const root = '/isolated/qualification';
  const report = { checks: [{ id: 'scope', status: 'passed' }], observations: [], commands: [] };
  assert.deepEqual(await observeQualification(report, 'discovery', async () => ({ path: `${root}/skill` }), root),
    { status: 'observed', evidence: { path: '<TEMP_ROOT>/skill' } });
  assert.deepEqual(await observeQualification(report, 'loading', async () => {
    report.commands.push({ exitCode: 1 });
    throw new Error(`discovery unavailable in ${root}`);
  }, root), { status: 'unverified', reason: 'discovery unavailable in <TEMP_ROOT>' });
  assert.deepEqual(report.observations, [
    { id: 'discovery', status: 'observed', evidence: { path: '<TEMP_ROOT>/skill' } },
    { id: 'loading', status: 'unverified', reason: 'discovery unavailable in <TEMP_ROOT>' },
  ]);
  assert.deepEqual(report.checks, [{ id: 'scope', status: 'passed' }]);
});

// Test Value Gate: public observation must use the public revision and a fresh
// local command; disabled inventory cannot satisfy complete removal.
test('public Copilot reads use current Skill metadata and require absence after removal', async () => {
  const calls = [];
  let rows = [{ name: 'plugin/skill', description: 'AW public acceptance revision 2', enabled: true, path: '/fixture/SKILL.md' }];
  const ctx = { platform: 'copilot', pluginName: 'plugin', skillName: 'skill',
    async command(...args) { calls.push(args); return { stdout: JSON.stringify(rows) }; },
    async rpc() { assert.fail('Copilot Skill discovery must not open an RPC session.'); } };
  assert.equal((await readPublicSkills(ctx, '/project', 2, true)).description, 'AW public acceptance revision 2');
  await assert.rejects(readPublicSkills(ctx, '/project', 1, true), { code: 'ERR_ASSERTION' });
  rows = [{ ...rows[0], enabled: false }];
  assert.deepEqual(await readPublicSkills(ctx, '/neutral', 2, false),
    { level: 'fresh-process-skill-discovery', present: true, enabled: false });
  await assert.rejects(readPublicSkills(ctx, '/project', 2, false, { requireAbsent: true }), { code: 'ERR_ASSERTION' });
  rows = [];
  assert.deepEqual(await readPublicSkills(ctx, '/project', 2, false, { requireAbsent: true }),
    { level: 'fresh-process-skill-discovery', present: false, enabled: false });
  assert(calls.every(([args]) => JSON.stringify(args) === JSON.stringify(['skill', 'list', '--json'])));
  assert.equal(calls[2][1], '/neutral');
});

// Test Value Gate: diagnose only generated fixture marketplace sources, with
// production parsing and bounded output; credentials and other config stay out.
test('captures only bounded fixture Codex source configuration', async () => {
  await publicProcessFixture(async (options) => {
    const home = path.join(options.cwd, 'codex-sources'); await fs.mkdir(home);
    assert.equal((await readQualificationCodexSources(home)).state, 'missing');
    assert.equal((await readQualificationCodexSources('relative-home')).state, 'invalid-path');
    const source = path.join(options.cwd, 'marketplace');
    const name = 'aw-qualification';
    await fs.writeFile(path.join(home, 'config.toml'), [
      'api_key = "credential-must-not-appear"',
      '[marketplaces.foreign]', 'source = "https://user:password@example.com/repository"',
      '[marketplaces.aw-qualification-other]', 'source = "https://user:password@example.com/other"',
      `[marketplaces.${name}]`, `source = ${JSON.stringify(source)}`, 'source_type = "local"',
    ].join('\n'));
    const captured = await readQualificationCodexSources(home);
    assert.deepEqual(captured, { state: 'captured-parser-projection', sources: [{ name, source,
      sourceFormat: 'absolute', sourceType: 'local', sourcePointsToManifest: false }], omitted: 0 });
    assert(!JSON.stringify(captured).includes('credential')); assert(!JSON.stringify(captured).includes('password'));
    await fs.writeFile(path.join(home, 'config.toml'),
      `[marketplaces.${name}]\nsource = "https://user:password@example.com/private"\n`);
    const bounded = await readQualificationCodexSources(home);
    assert.deepEqual(bounded.sources, [{ name, source: null, sourceFormat: 'other', sourceType: null, sourcePointsToManifest: false }]);
    assert(!JSON.stringify(bounded).includes('password'));
    await fs.writeFile(path.join(home, 'config.toml'), 'x'.repeat(1024 * 1024 + 1));
    assert.equal((await readQualificationCodexSources(home)).state, 'over-limit');
  });
});

// Test Value Gate: failed public AW receipts must retain the error after a long
// plan while the existing preview cap and path redaction remain effective.
test('retains bounded public failure facts beyond the stdout preview', () => {
  const root = '/tmp/aw-private-fixture';
  const identity = { route: 'codex-marketplace', packageId: 'demo', sourceLocation: `${root}/native-source` };
  const receipt = { after: { ownership: 'foreign', registration: 'present', nativeIdentity: identity,
    prerequisites: { privateConfiguration: 'must-not-appear' } },
    effects: [{ id: 'register', status: 'unknown', mutation: 'possible', diagnostics: [{ code: 'nativeFailure',
      severity: 'error', message: `Expected ${root}/owned-source` }] }] };
  const stdout = JSON.stringify({ schemaVersion: 2, command: 'plugin.install', status: 'partial',
    data: { longPlan: 'x'.repeat(5000), targetResults: [{ target: 'codex', scope: 'user',
      blockerCodes: ['deploymentPostcheckFailed'], deploymentReceipts: [receipt] }] }, diagnostics: [] });
  const report = redact({ stdout, failureSummary: publicAwFailureSummary(stdout) }, root);
  assert.equal(report.stdout.length, 4000);
  assert.equal(report.failureSummary.targets[0].receipts[0].after.ownership, 'foreign');
  assert.equal(report.failureSummary.targets[0].receipts[0].after.nativeIdentity.sourceLocation, '<TEMP_ROOT>/native-source');
  assert.equal(report.failureSummary.targets[0].receipts[0].effects[0].diagnostics[0].message, 'Expected <TEMP_ROOT>/owned-source');
  assert(!JSON.stringify(report.failureSummary).includes('must-not-appear'));
  assert.equal(publicAwFailureSummary(stdout.slice(0, 4000)).state, 'invalid-json');
  assert.equal(publicAwFailureSummary('null').state, 'invalid-json');
  assert.doesNotThrow(() => publicAwFailureSummary(JSON.stringify({ data: { targetResults: [null,
    { deploymentReceipts: [null, { effects: [null], diagnostics: [null] }] }] }, diagnostics: [null] })));
  const many = publicAwFailureSummary(JSON.stringify({ data: { targetResults: Array(10).fill({
    deploymentReceipts: Array(10).fill({ effects: Array(10).fill({ diagnostics: Array(10).fill({ code: 'bounded' }) }) }),
  }) } }));
  assert.equal(many.targets.length, 4); assert.equal(many.targets[0].receipts.length, 4);
  assert.equal(many.targets[0].receipts[0].effects.length, 8);
  assert.equal(many.targets[0].receipts[0].effects[0].diagnostics.length, 8);
});

// Test Value Gate: the public harness must reject the old CLI contract and an unexpected
// v2 status even when the process exited with the anticipated exit code.
test('reads only v2 public AW envelopes with the expected status', () => {
  const value = { schemaVersion: 2, command: 'plugin.status', status: 'blocked' };
  assert.deepEqual(readPublicAwEnvelope(JSON.stringify(value), 'blocked'), value);
  assert.throws(() => readPublicAwEnvelope(JSON.stringify({ ...value, schemaVersion: 1 }), 'blocked'), /unexpected-envelope/u);
  assert.throws(() => readPublicAwEnvelope(JSON.stringify({ ...value, status: 'success' }), 'blocked'), /unexpected-envelope/u);
});

// Test Value Gate: qualification must not turn missing prerequisites into a
// passing report, inherit user credentials, or leave an isolated client home.
test('requires an explicit client acquisition mode and rejects ambiguous inputs', () => {
  const base = ['--candidate', 'candidate.json', '--client', 'codex', '--report', 'report.json'];
  assert.throws(() => parseArgs(base), /invalid-arguments/);
  assert.throws(() => parseArgs([...base, '--install', '--executable', '/client']), /invalid-arguments/);
  assert.throws(() => parseArgs([...base, '--install', '--client', 'pi']), /invalid-arguments/);
  assert.throws(() => parseArgs(['--write-candidate', 'file', '--source-sha', 'abc', '--install']), /invalid-arguments/);
  assert.equal(parseArgs([...base, '--install']).install, true);
  assert.equal(parseArgs([...base, '--install', '--public-aw'])['public-aw'], true);
  const all = ['--candidate', 'candidate.json', '--client', 'all', '--report', 'report.json', '--install'];
  assert.equal(parseArgs([...all, '--public-aw', '--mixed-native-aw'])['mixed-native-aw'], true);
  assert.throws(() => parseArgs([...all, '--mixed-native-aw']), /invalid-arguments/);
  assert.throws(() => parseArgs([...base, '--install', '--public-aw', '--mixed-native-aw']), /invalid-arguments/);
  assert.equal(parseArgs(['--candidate', 'candidate.json', '--client', 'opencode', '--report', 'report.json', '--install']).client, 'opencode');
  assert.throws(() => parseArgs([...base, '--install', '--public-aw', '--public-aw']), /invalid-arguments/);
  assert.throws(() => parseArgs(['--write-candidate', 'file', '--source-sha', 'abc', '--public-aw']), /invalid-arguments/);
  assert.equal(versionFrom('codex-cli 0.167.0\n'), '0.167.0');
  assert.equal(versionFrom('2.1.317 (Claude Code)'), '2.1.317');
  assert.equal(versionFrom('GitHub Copilot CLI 1.0.95.\nRun copilot update'), '1.0.95');
  assert.equal(versionFrom('opencode v2.2.6\n'), '2.2.6');
  assert.equal(versionFrom('opencode v2.2.6-preview'), null);
  assert.equal(versionFrom('unknown'), null);
});

// Test Value Gate: invalid group syntax must fail before any install, and the
// mixed scenario must never run with an executable or a missing native target.
test('accepts explicit client groups and rejects incomplete mixed qualification requests', () => {
  const options = (selection, ...flags) => ['--candidate', 'candidate.json', '--client', selection, '--report', 'report.json', ...flags];
  const mixed = ['--public-aw', '--mixed-native-aw'];
  assert.doesNotThrow(() => parseArgs(options('codex,pi,claude', '--install', ...mixed)));
  assert.doesNotThrow(() => parseArgs(options('copilot,grok,opencode', '--install', '--public-aw')));
  assert.doesNotThrow(() => parseArgs(options('codex', '--executable', path.resolve('client'))));
  for (const selection of ['', ',codex', 'codex,', 'codex,,pi', 'codex, pi', 'codex,codex', 'codex,unknown', 'codex,all', 'all,pi']) {
    assert.throws(() => parseArgs(options(selection, '--install')), /invalid-arguments/);
  }
  assert.throws(() => parseArgs(options('codex,pi', '--executable', path.resolve('client'))), /invalid-arguments/);
  assert.throws(() => parseArgs(options('all', '--executable', path.resolve('client'))), /invalid-arguments/);
  assert.throws(() => parseArgs(options('claude,pi', '--install', '--mixed-native-aw')), /invalid-arguments/);
  assert.throws(() => parseArgs(options('codex,claude', '--install', ...mixed)), /invalid-arguments/);
  assert.throws(() => parseArgs(options('codex,pi', '--install', ...mixed)), /invalid-arguments/);
});

// Test Value Gate: a group must keep trying selected clients after a download
// failure and report any missing mixed participant, even with a valid candidate.
test('qualifies the selected group with the same candidate and scope requirements', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-group-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate.json');
  const client = path.join(root, 'client.mjs');
  const reportPath = path.join(root, 'report.json');
  const sourceSha = process.env.GITHUB_SHA ?? 'a'.repeat(40);
  await writeCandidate(candidate, sourceSha);
  await fs.writeFile(client, 'console.log("0.0.0");\n');
  const acquired = [];
  const options = (selection, ...flags) => parseArgs(['--candidate', candidate, '--client', selection, '--report', reportPath,
    '--install', '--public-aw', ...flags]);
  const acquire = async (platform, installRoot) => {
    acquired.push({ platform, installRoot });
    if (platform !== 'pi') throw new Error('client-install-failed');
    const entry = path.join(installRoot, 'client.mjs');
    await fs.copyFile(client, entry);
    return { launcher: { executable: process.execPath, prefix: [entry] }, binDirectory: installRoot };
  };

  const report = await run(options('codex,pi,claude', '--mixed-native-aw'), acquire);
  assert.equal(report.candidate?.sourceSha, sourceSha);
  assert.deepEqual(report.clients.map(({ platform }) => platform), ['codex', 'pi', 'claude']);
  assert.deepEqual(acquired.map(({ platform }) => platform).sort(), ['claude', 'codex', 'pi']);
  assert.equal(report.status, 'failed');
  assert.equal(report.acceptancePolicy.required.includes('codex-manual-skill-and-native-role-resolution'), true);
  assert.equal(report.boundary.modelRequests, 'loopback qualification fixtures only');
  assert.equal(report.mixedPublicAw?.status, 'failed');
  assert.deepEqual(report.mixedPublicAw?.unavailable, ['claude']);
  const pi = report.clients.find(({ platform }) => platform === 'pi');
  assert.deepEqual(pi.scopes.map(({ scope }) => scope), ['user', 'project']);
  assert.deepEqual(pi.publicAw.map(({ scope }) => scope), ['user', 'project']);
  assert(report.clients.every(({ acquisitionCleanup }) => acquisitionCleanup === 'completed'));

  const second = await run(options('copilot,grok,opencode'), acquire);
  assert.equal(second.candidate?.manifestSha256, report.candidate.manifestSha256);
  const grokUnavailable = process.platform === 'darwin' && process.arch === 'x64'
    || process.platform === 'win32' && process.arch === 'arm64';
  assert.deepEqual(second.clients.map(({ platform, status }) => [platform, status]), [
    ['copilot', 'failed'], ['grok', grokUnavailable ? 'excluded' : 'failed'], ['opencode', 'failed'],
  ]);
  assert.deepEqual(acquired.slice(3).map(({ platform }) => platform).sort(), grokUnavailable ? ['copilot', 'opencode'] : ['copilot', 'grok', 'opencode']);
  assert.equal(second.status, 'failed');
  assert.equal(second.acceptancePolicy.required.includes('codex-manual-skill-and-native-role-resolution'), false);
  assert.equal(second.boundary.modelRequests, 'loopback qualification fixtures only');
  assert.equal(second.mixedPublicAw, undefined);

  await fs.writeFile(candidate, JSON.stringify({ schemaVersion: 1, sourceSha, files: {} }));
  const acquiredCount = acquired.length;
  const unbound = await run(options('claude,pi'), acquire);
  assert.equal(unbound.reason, 'candidate-content-mismatch');
  assert.equal(unbound.status, 'failed');
  assert.equal(unbound.boundary.modelRequests, 'none');
  assert.equal(acquired.length, acquiredCount);
  for (const { installRoot } of acquired) {
    assert.equal(await fs.stat(installRoot).then(() => false, error => error.code === 'ENOENT'), true);
  }
});

// Test Value Gate: a fixed unavailable distribution can be excluded, while a
// required client's missing evidence or failure must prevent a passing group.
test('preserves required failures and unknowns when aggregating client results', () => {
  assert.equal(aggregateQualificationStatus(['passed', 'excluded']), 'passed');
  assert.equal(aggregateQualificationStatus(['excluded', 'passed', 'unverified']), 'unverified');
  assert.equal(aggregateQualificationStatus(['unverified', 'excluded', 'failed', 'passed']), 'failed');
});

// Test Value Gate: a green AW envelope must not pass the two-client run when
// either client's target or its actual native registration is absent.
test('requires an applied native registration for both targets in one public batch', () => {
  const pluginId = 'qualification/aw-qualification';
  const target = platform => ({ pluginId, target: platform, scope: 'user', execution: 'applied', observation: 'verified', content: 'satisfied',
    deploymentPlans: [{ bindingId: platform, effects: [{ id: `register-${platform}`, kind: 'register' }] }],
    deploymentReceipts: [{ bindingId: platform, effects: [{ id: `register-${platform}`, status: 'applied', mutation: 'confirmed' }] }] });
  const fixture = () => ({ command: 'plugin.install', status: 'success', data: {
    request: { plugins: [pluginId], targets: ['claude', 'pi'], scope: 'user' },
    changes: { requirements: 'changed' }, targetResults: [target('claude'), target('pi')],
  } });
  assert.deepEqual(assertMixedInstallReceipt(fixture(), pluginId).map(item => item.platform), ['claude', 'pi']);
  const missing = fixture();
  missing.data.targetResults.pop();
  assert.throws(() => assertMixedInstallReceipt(missing, pluginId));
  const noMutation = fixture();
  noMutation.data.targetResults[1].deploymentReceipts[0].effects[0].mutation = 'none';
  assert.throws(() => assertMixedInstallReceipt(noMutation, pluginId), /pi must confirm its native mutation/u);
  const wrongBinding = fixture();
  wrongBinding.data.targetResults[1].deploymentReceipts[0].bindingId = 'claude';
  assert.throws(() => assertMixedInstallReceipt(wrongBinding, pluginId), /pi must apply its native registration/u);
});

// Test Value Gate: query overlap cannot become write-overlap evidence and an
// interrupted trace must preserve unknown overlap alongside any observed rows.
test('reports only complete native installation intervals when measuring the batch overlap', () => {
  const actual = (operationId, nativeClient, first, last, nativeOperation = 'install') => {
    const base = { operationId, nativeClient, nativeOperation, startTime: new Date(first).toISOString() };
    return [{ ...base, phase: 'start' }, { ...base, phase: 'finish', finishTime: new Date(last).toISOString(), exitCode: 0 }];
  };
  const claude = actual(1, 'claude', 100, 200);
  const pi = actual(2, 'pi', 150, 220);
  const list = actual(3, 'pi', 120, 240, 'list');
  const trace = { state: 'captured', records: [...claude, ...list, ...pi] };
  const result = mixedNativeInstallIntervals(trace);
  assert.equal(result.overlapMs, 50);
  assert.deepEqual(result.commands.map(command => command.operationId), [1, 2]);
  assert.equal(mixedNativeInstallIntervals({ ...trace, records: [...claude, ...list, ...actual(2, 'pi', 201, 220)] }).overlapMs, 0);
  const partial = mixedNativeInstallIntervals({ ...trace, records: trace.records.slice(0, -1) });
  assert.equal(partial.overlapMs, null);
  assert.equal(partial.commands[1].finishTime, null);
});

test('isolates configuration and does not pass arbitrary credentials or startup injection', () => {
  const before = process.env.AW_QUALIFICATION_TEST_SECRET;
  process.env.AW_QUALIFICATION_TEST_SECRET = 'private';
  try {
    const root = path.join(os.tmpdir(), 'qualification-env');
    const env = isolatedEnvironment(root);
    assert.equal(env.AW_QUALIFICATION_TEST_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.HOME, path.join(root, 'home'));
    assert.equal(env.COPILOT_HOME, path.join(root, 'copilot'));
    assert.equal(env.COPILOT_OFFLINE, 'true');
    assert.equal(env.COPILOT_AUTO_UPDATE, 'false');
    // The pinned Antigravity updater accepts the literal "true", not "1".
    // A background update would invalidate the fixed binary and process scope.
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
    assert.equal(isolatedEnvironment(root, true).GITHUB_TOKEN, undefined);
  } finally {
    if (before === undefined) delete process.env.AW_QUALIFICATION_TEST_SECRET;
    else process.env.AW_QUALIFICATION_TEST_SECRET = before;
  }
});

// Test Value Gate: RPC cleanup failures must retain response/exit ordering
// without placing response bodies or client environment values in diagnostics.
test('retains bounded RPC events for successful and rejected read-only responses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-rpc-events-'));
  try {
    for (const rejected of [false, true]) {
      const fixture = path.join(root, `client-${rejected}.cjs`);
      await fs.writeFile(fixture, `
const readline = require('node:readline');
setTimeout(() => process.exit(2), 10000).unref();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (request.id === 2) process.stdout.write(JSON.stringify(${rejected
    ? "{ id: 2, error: { code: -32000, message: 'private-rpc-body' } }"
    : "{ id: 2, result: { data: [], privateBody: 'private-rpc-body' } }"}) + '\\n');
});
`);
      const result = await execute({ executable: process.execPath,
        prefix: [path.resolve('scripts/qualification/native-platform-rpc.mjs')] }, [], {
        cwd: root, env: await prepareEnvironment(root), timeoutMs: 10_000,
        stdin: JSON.stringify({ platform: 'codex', cwd: root,
          launcher: { executable: process.execPath, prefix: [fixture] } }),
      });
      assert.equal(result.exitCode, rejected ? 1 : 0);
      if (!rejected) assert.deepEqual(JSON.parse(result.stdout), { data: [], privateBody: 'private-rpc-body' });
      const diagnostics = result.stderr.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(item => item?.kind === 'aw-native-rpc-diagnostics');
      assert(diagnostics, 'RPC response and termination events must survive the subprocess boundary.');
      assert(diagnostics.events.length > 0 && diagnostics.events.length <= 32);
      const response = diagnostics.events.findIndex(event => event.event === 'response' && event.id === 2);
      const signal = diagnostics.events.findIndex(event => event.event === 'signal' && event.signal === 'SIGTERM');
      const closed = diagnostics.events.findIndex(event => event.event === 'child-close');
      assert(response >= 0 && signal > response && closed > signal);
      assert(diagnostics.events.every(event => Number.isFinite(event.atMs)));
      assert.equal(JSON.stringify(diagnostics).includes('private-rpc-body'), false);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('uses actual AW projection bytes for both candidate revisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-projection-test-'));
  try {
    for (const platform of ['codex', 'pi', 'claude', 'copilot', 'grok', 'opencode']) {
      const current = path.join(root, platform); await fs.mkdir(current);
      const ctx = { root: current, platform, scope: 'user', project: current, env: await prepareEnvironment(current),
        pluginName: 'aw-qualification', skillName: 'aw-qualification', marketplaceName: 'aw-qualification-market',
        marketplace: path.join(current, 'source'), bundle: path.join(current, 'source/plugins/aw-qualification') };
      const first = await renderPackage(ctx, 1);
      const second = await renderPackage(ctx, 2);
      assert.notEqual(first.contentDigest, second.contentDigest);
      assert.match(await fs.readFile(path.join(ctx.bundle, 'skills/aw-qualification/SKILL.md'), 'utf8'), /revision 2/);
      const descriptor = { codex: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json',
        pi: 'package.json', copilot: 'plugin.json', grok: '.grok-plugin/plugin.json', opencode: 'package.json' }[platform];
      const manifest = JSON.parse(await fs.readFile(path.join(ctx.bundle, descriptor), 'utf8'));
      assert.equal(manifest.name, ctx.pluginName);
      assert.equal(manifest.version, platform === 'opencode' ? '0.1.1' : '1.0.2');
      if (platform === 'opencode') {
        const { readOpenCodeFixture } = await import('./native-platform-opencode.mjs');
        const before = await readOpenCodeFixture(ctx, second);
        const third = await readOpenCodeFixture(ctx, await renderPackage(ctx, 3));
        assert.equal(before.version, third.version);
        assert.notEqual(before.bodySha256, third.bodySha256);
        assert.notEqual(before.files['index.mjs'], third.files['index.mjs']);
        assert.equal(third.evidence.projectionInput.renderScope.kind, 'user');
        assert.equal(third.evidence.projectionInput.binding.route, 'opencode-directory');
      }
      if (platform === 'claude') {
        const market = JSON.parse(await fs.readFile(path.join(ctx.marketplace, '.claude-plugin/marketplace.json'), 'utf8'));
        assert.equal(market.plugins[0].version, '1.0.2');
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// A busy image in a private qualification root failed a Windows run after
// all 20 OpenCode Project checks passed. A persistent lock must still fail.
test('removes a Windows qualification executable only after its lock is released', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-locked-exe-'));
  const executable = path.join(root, 'client.exe');
  let child;
  let closed;
  let release;
  try {
    await fs.writeFile(executable, 'qualification fixture');
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Hold an actual non-delete-sharing handle. An executable image mapping alone can allow unlink on NTFS.
    const holdFile = "$ErrorActionPreference='Stop'; $file=[IO.File]::Open($env:AW_TEST_LOCK_FILE, 'Open', 'Read', 'Read'); "
      + "try { [Console]::Write('1'); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { $file.Dispose() }";
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', holdFile],
      { env: { ...isolatedEnvironment(root), AW_TEST_LOCK_FILE: executable }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    closed = once(child, 'close');
    const signal = AbortSignal.timeout(30_000);
    const ready = await Promise.race([once(child.stdout, 'data', { signal }), closed]);
    assert.ok(Buffer.isBuffer(ready[0]) && ready[0].toString() === '1', 'Expected confirmation that the fixture file is locked');
    await assert.rejects(removeQualificationRoot(root), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
    release = setTimeout(() => child.stdin.end(), 150);
    await removeQualificationRoot(root);
    assert.equal((await closed)[0], 0);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  } finally {
    clearTimeout(release);
    if (child?.exitCode === null) child.kill();
    await closed?.catch(() => {});
    await removeQualificationRoot(root);
  }
});

test('a real child version mismatch fails before public AW installation and cleans its temporary home', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-process-test-'));
  const observed = path.join(root, 'observed.json');
  const child = path.join(root, 'client.mjs');
  try {
    await fs.writeFile(child, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify({home:process.env.HOME,token:process.env.GITHUB_TOKEN,args:process.argv.slice(3)})); console.log('codex-cli 0.1.0');`);
    const report = await runScope('codex', 'project', { executable: process.execPath, prefix: [child, observed] }, { publicAw: true });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'client-version-mismatch');
    assert.equal(report.input, 'public-aw-cli');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].status, 'failed');
    assert.equal(report.cleanup, 'completed');
    const data = JSON.parse(await fs.readFile(observed, 'utf8'));
    assert.deepEqual(data.args, ['--version']);
    assert.equal(data.token, undefined);
    await assert.rejects(fs.stat(data.home), { code: 'ENOENT' });
    assert.equal(JSON.stringify(report).includes(data.home), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// Test Value Gate: public OpenCode execution must reject versions outside the
// finite record before any AW installation or native observation can begin.
test('OpenCode public AW rejects unqualified client versions before installation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-opencode-public-version-'));
  const child = path.join(root, 'version.mjs');
  try {
    for (const version of ['1.9.9', '2.0.1', '2.0.0-preview']) {
      await fs.writeFile(child, `console.log(${JSON.stringify(`opencode v${version}`)});\n`);
      const report = await runScope('opencode', 'user', { executable: process.execPath, prefix: [child] }, { publicAw: true });
      assert.equal(report.status, 'failed');
      assert.equal(report.reason, 'client-version-mismatch');
      assert.equal(report.cleanup, 'completed');
      assert.deepEqual(report.checks.map(check => [check.id, check.status]), [['client-version', 'failed']]);
      assert(report.commands.every(command => JSON.stringify(command.args) === JSON.stringify(['--version'])));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a stalled client is bounded and cannot count as a successful command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-timeout-test-'));
  try {
    const result = await execute({ executable: process.execPath, prefix: [] }, ['-e', 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)'],
      { cwd: root, env: await prepareEnvironment(root), timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.throws(() => assertCommand(result), /command-timeout/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('redacts Windows paths nested inside public JSON identity strings', () => {
  const root = 'C:\\qualification';
  const client = 'C:\\download\\tool';
  const stdout = JSON.stringify({ id: JSON.stringify(['pi', `${client}\\pi.cmd`, `${root}\\pi`]) });
  const result = JSON.parse(redact({ stdout }, root, client).stdout);
  assert.deepEqual(JSON.parse(result.id), ['pi', '<CLIENT_BIN>\\pi.cmd', '<TEMP_ROOT>\\pi']);
});

async function publicProcessFixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-process-test-'));
  try { await action({ cwd: root, env: await prepareEnvironment(root), timeoutMs: 8_000 }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const posixOnly = { skip: process.platform === 'win32', timeout: 30_000 };
const nodeLauncher = { executable: process.execPath, prefix: [] };

// Test Value Gate: the Hosted-only shape wrapper must be wired to the original
// marker query while a deliberately incorrect child marker remains a failure.
test('Linux private marker row evidence preserves a real missing-marker failure', {
  skip: process.platform !== 'linux', timeout: 30_000,
}, async () => {
  const saved = [process.env.GITHUB_ACTIONS, process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES];
  process.env.GITHUB_ACTIONS = 'true'; process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES = '1';
  try {
    await publicProcessFixture(async (options) => {
      const script = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1000)'],"
        + "{env:{...process.env,AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER:'deliberately-incorrect-marker'},stdio:'ignore'});"
        + 'setTimeout(()=>process.exit(0),1500);';
      await assert.rejects(executePublicAw(nodeLauncher, ['-e', script], options), (error) => {
        assert.match(error.message, /lost its process marker/);
        assert(error.publicAwMarkerRows?.length > 0);
        assert(error.publicAwMarkerRows.every((row) => row.markerMatches === false && row.commandForm));
        assert(!JSON.stringify(error.publicAwMarkerRows).includes('deliberately-incorrect-marker'));
        return true;
      });
    });
  } finally {
    for (const [index, key] of ['GITHUB_ACTIONS', 'AW_NATIVE_QUALIFICATION_PROCESS_NAMES'].entries()) {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    }
  }
});

// The actual public AW entry uses birth ticks throughout its lease. A child
// with a readable wrong marker must fail even when it exits before cleanup.
test('Linux public AW verifies the sentinel and rejects a real unmarked child with procfs', {
  skip: process.platform !== 'linux', timeout: 30_000,
}, async () => {
  await publicProcessFixture(async options => {
    const preload = path.join(options.cwd, 'wrong-marker.cjs');
    await fs.writeFile(preload, `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},1800)'], {
        env: { AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER: 'incorrect' }, stdio: 'ignore',
      });
    `);
    const launcher = { executable: process.execPath, prefix: ['--require', preload, path.join(repoRoot, 'packages/cli/dist/index.js')] };
    await assert.rejects(executePublicAw(launcher, ['--version'], options), error => {
      const first = error.publicAwProcessDiagnostics?.[0];
      assert.equal(first?.stage, 'observation');
      assert.match(first.sentinel.startTime, /^\d+$/u);
      assert.equal(first.sentinel.markerMatches, true);
      assert.match(error.message, /lost its process marker/);
      return true;
    });
  });
});

// Native Grok uses the same strict observer. Diagnostic wiring must retain
// an actual wrong-marker failure and must not expose the startup marker.
test('Linux native Grok diagnostics retain a strict missing-marker failure', {
  skip: process.platform !== 'linux', timeout: 30_000,
}, async () => {
  const keys = ['GITHUB_ACTIONS', 'AW_NATIVE_QUALIFICATION_PROCESS_NAMES'];
  const saved = keys.map(key => process.env[key]);
  process.env.GITHUB_ACTIONS = 'true'; process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES = '1';
  try {
    await publicProcessFixture(async (options) => {
      const script = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1000)'],"
        + "{env:{...process.env,AW_AGENT_SKILL_EVAL_PROCESS_MARKER:'deliberately-incorrect-marker'},stdio:'ignore'});"
        + 'setTimeout(()=>process.exit(0),1500);';
      await assert.rejects(execute(nodeLauncher, ['-e', script], { ...options, nativeClient: 'grok' }), error => {
        assert.match(error.message, /lost its process marker/);
        assert(error.qualificationMarkerRows?.length > 0);
        assert(error.qualificationMarkerRows.every(row => row.markerMatches === false && row.commandForm));
        assert(!JSON.stringify(error.qualificationMarkerRows).includes('deliberately-incorrect-marker'));
        return true;
      });
    });
  } finally {
    for (const [index, key] of keys.entries()) {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    }
  }
});

// Test Value Gate: Darwin direct/RPC execution must retain existing query
// timings on success and audit failure without changing process acceptance.
test('Darwin native execution retains query timing and strict marker failures', {
  skip: process.platform !== 'darwin', timeout: 30_000,
}, async () => {
  const keys = ['GITHUB_ACTIONS', 'AW_NATIVE_QUALIFICATION_PROCESS_NAMES'];
  const saved = keys.map(key => process.env[key]);
  process.env.GITHUB_ACTIONS = 'true'; process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES = '1';
  try {
    await publicProcessFixture(async options => {
      const success = await execute(nodeLauncher, ['-e', 'process.stdout.write("controlled output")'], options);
      assertCommand(success); assert.equal(success.stdout, 'controlled output');
      assert.equal(success.containmentMode, 'verified-observed');
      assert(success.processQueryTimings.records.some(record => record.queryKind === 'identity-ps'));
      const script = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000)'],"
        + "{env:{...process.env,AW_AGENT_SKILL_EVAL_PROCESS_MARKER:'deliberately-incorrect-marker'},stdio:'ignore'});"
        + 'setTimeout(()=>process.exit(0),7000);';
      await assert.rejects(execute(nodeLauncher, ['-e', script], options), error => {
        assert.match(error.message, /lost its process marker/);
        assert(error.publicAwProcessQueryTimings.records.some(record => record.queryKind === 'marker-ps'));
        assert(!JSON.stringify(error.publicAwProcessQueryTimings).includes('deliberately-incorrect-marker'));
        return true;
      });
    });
  } finally {
    for (const [index, key] of keys.entries()) {
      if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
    }
  }
});

// The Linux exception is fixed to the approved version and two exact
// inventory commands; neither a general client flag nor extra arguments suffice.
test('limits Linux Copilot inventory observation to the approved version and commands', () => {
  const options = { nativeClient: 'copilot', nativeClientVersion: '1.0.95' };
  for (const arch of ['x64', 'arm64']) {
    const host = { platform: 'linux', arch };
    for (const kind of ['plugin', 'skill']) assert(usesCopilotInventoryObservation([kind, 'list', '--json'], options, host));
    for (const args of [['plugin', 'list'], ['plugin', 'list', '--json', '--extra'], ['plugin', 'install', '--json'], ['skill', 'run', '--json'], ['--version']]) {
      assert.equal(usesCopilotInventoryObservation(args, options, host), false);
    }
    for (const patch of [{ nativeClient: 'pi' }, { nativeClientVersion: undefined }, { nativeClientVersion: '1.0.96' }]) {
      assert.equal(usesCopilotInventoryObservation(['skill', 'list', '--json'], { ...options, ...patch }, host), false);
    }
  }
  for (const platform of ['darwin', 'win32']) assert.equal(usesCopilotInventoryObservation(['plugin', 'list', '--json'], options, { platform }), false);
});

test('Linux approved Copilot inventory commands use ordinary observation without changing other commands', {
  skip: process.platform !== 'linux', timeout: 30_000,
}, async () => {
  await publicProcessFixture(async (options) => {
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
    const launcher = { executable: process.execPath, prefix: ['-e', script, '--'] };
    for (const args of [['plugin', 'list', '--json'], ['skill', 'list', '--json'], ['plugin', 'install', '--json']]) {
      const result = await execute(launcher, args, { ...options, nativeClient: 'copilot', nativeClientVersion: '1.0.95' });
      assertCommand(result);
      assert.deepEqual(JSON.parse(result.stdout), args);
      const inventory = args[1] === 'list';
      assert.equal(result.containmentMode, inventory ? 'observed' : 'verified-observed');
      assert.equal(result.gradingEvidenceAccepted, !inventory);
      if (inventory) assert.equal(result.descendantCleanupGuaranteed, false);
    }
  });
});

// Other native clients retain their existing qualification contract.
test('retains the existing Copilot Darwin native command observation', { timeout: 30_000 }, async () => {
  await publicProcessFixture(async (options) => {
    for (const nativeClient of ['copilot', 'pi']) {
      const result = await execute(nodeLauncher, ['-e', 'console.log("native observation fixture")'], { ...options, nativeClient });
      assertCommand(result);
      const ordinary = nativeClient === 'copilot' && process.platform === 'darwin';
      assert.equal(result.containmentMode, ordinary ? 'observed' : 'verified-observed');
      assert.equal(result.gradingEvidenceAccepted, !ordinary);
      if (ordinary) assert.equal(result.descendantCleanupGuaranteed, false);
    }
  });
});

// Test Value Gate: the private preload must retain the real CLI backend, including
// Windows helper admission, while recording a selected native failure safely.
test('loads a managed trace before a real native command on supported Hosted systems', {
  skip: !['linux', 'darwin', 'win32'].includes(process.platform), timeout: 30_000,
}, async () => {
  await publicProcessFixture(async (options) => {
    const nativeFile = path.join(options.cwd, 'selected-native.cjs');
    const nativeArgument = process.platform === 'win32' ? nativeFile.toUpperCase() : nativeFile;
    const invocationFile = path.join(options.cwd, 'invoke-native.mjs');
    const traceFile = path.join(options.cwd, 'managed.jsonl');
    const module = path.resolve('scripts/qualification/native-platform-managed-trace.mjs');
    const nativeCli = path.resolve('packages/cli/dist/src/utils/native-cli.js');
    await fs.writeFile(nativeFile, 'process.stderr.write(process.env.AW_NATIVE_CLI_PROCESS_MARKER); process.exitCode=7;');
    await fs.writeFile(invocationFile, `
      import assert from 'node:assert/strict';
      import { managedTraceInstalled } from ${JSON.stringify(pathToFileURL(module).href)};
      import { runNativeCli } from ${JSON.stringify(pathToFileURL(nativeCli).href)};
      assert.equal(managedTraceInstalled,true);
      let code;
      try { code=(await runNativeCli({command:process.execPath,args:[process.argv[2]],cwd:process.cwd(),env:process.env,timeoutMs:5000})).exitCode; }
      catch(error) { code=error.exitCode; }
      assert.equal(code,7); console.log('native failure preserved');
    `);
    const result = await new Promise((resolve, reject) => execFile(process.execPath, ['--import', pathToFileURL(module).href, invocationFile, nativeArgument], {
      cwd: options.cwd, env: { ...options.env, GITHUB_ACTIONS: 'true', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
        AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'pi', AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: traceFile,
        AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([nativeFile]),
        AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER: 'managed-trace-public-marker' },
      timeout: 12_000, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    assert.equal(result.stdout.trim(), 'native failure preserved');
    const rows = (await fs.readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.filter((row) => row.phase === 'installation').map((row) => row.state), ['loading-runner', 'installed']);
    const operations = rows.filter((row) => row.phase !== 'installation');
    assert.deepEqual(operations.map((row) => row.phase), ['start', 'spawn', 'finish']);
    assert.equal(operations[0].publicMarkerProvided, true);
    assert.equal(operations[2].exitCode, 7);
    assert.equal(operations[2].stderr, '');
    assert(!JSON.stringify(rows).includes('managed-trace-public-marker'));
    assert.equal(operations[0].childPid, undefined);
    assert(Number.isSafeInteger(operations[1].childPid) && operations[1].childPid > 0);
    assert.equal(operations[2].childPid, operations[1].childPid);
    assert(operations.every((row) => row.operationId === operations[0].operationId
      && row.parentPid === operations[0].parentPid));
    assert(Number.isSafeInteger(operations[0].parentPid) && operations[0].parentPid > 0);
  });
});

// Test Value Gate: report the cwd seen by an actual child of the default Native
// backend, rather than inferring it from the requested cwd or a fake runner.
test('observes the native child working directory in an isolated environment', { timeout: 15_000 }, async () => {
  await publicProcessFixture(async (options) => {
    const unicode = path.join(options.cwd, 'cwd space 项目'); await fs.mkdir(unicode);
    for (const project of [options.cwd, unicode]) {
      const observation = await observeNativeWorkingDirectory({ project, env: options.env });
      assert.equal(observation.requestedCwd, project);
      assert.equal(observation.requestedUtf16Length, project.length);
      const expected = await fs.stat(project, { bigint: true });
      for (const actual of [observation.cwd, observation.realpath]) {
        const identity = await fs.stat(actual, { bigint: true });
        assert(identity.isDirectory());
        assert.equal(identity.dev, expected.dev); assert.equal(identity.ino, expected.ino);
      }
      if (process.platform === 'win32') {
        assert(observation.requestedUtf16Length < 260, 'The fixture must exercise an ordinary short cwd.');
        assert.equal(observation.requestedNamespaced, false);
        assert.equal(observation.cwdNamespaced, false); assert.equal(observation.realpathNamespaced, false);
      }
    }
  });
});

// Test Value Gate: changing short cwd handling must preserve actual long cwd
// execution through the default Windows helper, not only a mocked path value.
test('retains a long native working directory on Windows', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async () => {
  await publicProcessFixture(async (options) => {
    const project = path.join(options.cwd, 'cwd space 项目', ...Array(12).fill('long-project-directory'));
    assert(project.length >= 260);
    await fs.mkdir(project, { recursive: true });
    const observation = await observeNativeWorkingDirectory({ project, env: options.env });
    assert.equal(observation.requestedUtf16Length, project.length);
    const expected = await fs.stat(project, { bigint: true });
    for (const actual of [observation.cwd, observation.realpath]) {
      const identity = await fs.stat(actual, { bigint: true });
      assert(identity.isDirectory()); assert.equal(identity.dev, expected.dev); assert.equal(identity.ino, expected.ino);
    }
  });
});

// Test Value Gate: a rejected trace configuration must leave AW running and
// produce only a fixed status; a disabled Hosted guard must create no file.
test('reports a rejected preload configuration only behind Hosted guards', {
  skip: !['linux', 'win32'].includes(process.platform), timeout: 15_000,
}, async () => {
  await publicProcessFixture(async (options) => {
    const module = pathToFileURL(path.resolve('scripts/qualification/native-platform-managed-trace.mjs')).href;
    for (const enabled of [true, false]) {
      const file = path.join(options.cwd, `rejected-${enabled}.jsonl`);
      const result = await new Promise((resolve, reject) => execFile(process.execPath,
        ['--import', module, '-e', 'console.log("continued")'], { cwd: options.cwd,
          env: { ...options.env, GITHUB_ACTIONS: enabled ? 'true' : 'false', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
            AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'codex', AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: file,
            AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: 'invalid-private-entry' }, timeout: 5000, maxBuffer: 8192,
        }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      assert.equal(result.trim(), 'continued');
      if (enabled) assert.deepEqual(JSON.parse((await fs.readFile(file, 'utf8')).trim()),
        { phase: 'installation', state: 'configuration-rejected' });
      else await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    }
  });
});

async function rpcDescendantFixture(options, source) {
  const finished = path.join(options.cwd, 'descendant-finished');
  const descendant = path.join(options.cwd, 'descendant.cjs');
  const client = path.join(options.cwd, 'rpc-client.cjs');
  await fs.writeFile(descendant, source);
  await fs.writeFile(client, `
    const {spawn}=require('node:child_process');
    spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'}).unref();
    setTimeout(()=>process.exit(2),10000).unref();
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);
      if(request.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
      if(request.id===2)setTimeout(()=>process.stdout.write(JSON.stringify({id:2,result:{data:[]}})+'\\n'),700);
    });
  `);
  return { finished, input: JSON.stringify({ platform: 'codex', cwd: options.cwd,
    launcher: { executable: process.execPath, prefix: [client, descendant, finished] } }) };
}

// Test Value Gate: a successful RPC response and direct child close must not
// let the helper complete while inherited, stdio-independent descendants live.
test('RPC waits for same-group descendants born during shutdown before returning JSON', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const { finished, input } = await rpcDescendantFixture(options, `
      const {spawn}=require('node:child_process');
      setTimeout(()=>{
        spawn(process.execPath,['-e',
          'setTimeout(()=>{require("node:fs").writeFileSync(process.argv[1],String(Date.now()));},1800)',
          process.argv[2]],{stdio:'ignore'}).unref();
      },1000);
      setTimeout(()=>process.exit(0),1300);
    `);
    const observed = path.join(options.cwd, 'stdout-observed');
    const observer = path.join(options.cwd, 'observe-stdout.mjs');
    await fs.writeFile(observer, `
      import fs from 'node:fs';
      const write=process.stdout.write.bind(process.stdout);
      process.stdout.write=(...args)=>{
        fs.writeFileSync(${JSON.stringify(observed)},String(Date.now()));
        return write(...args);
      };
    `);
    const result = await execute({ executable: process.execPath,
      prefix: ['--import', observer, path.resolve('scripts/qualification/native-platform-rpc.mjs')] }, [], {
      ...options, stdin: input,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { data: [] });
    assert(Number(await fs.readFile(finished, 'utf8')) <= Number(await fs.readFile(observed, 'utf8')));
  });
});

test('RPC waiting remains bounded and produces no JSON when descendants outlive the deadline', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const { input } = await rpcDescendantFixture(options, 'setTimeout(()=>process.exit(0),10000);');
    const result = await execute({ executable: process.execPath,
      prefix: [path.resolve('scripts/qualification/native-platform-rpc.mjs')] }, [], {
      ...options, timeoutMs: 2400, stdin: input,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, '');
    assert.throws(() => assertCommand(result), /command-timeout/);
  });
});

test('RPC group waiting does not permit an escaped descendant', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const { input } = await rpcDescendantFixture(options, `
      setTimeout(()=>{
        require('node:child_process').spawn(process.execPath,
          ['-e','setTimeout(()=>process.exit(0),5000)'],{detached:true,stdio:'ignore'}).unref();
      },1000);
      setTimeout(()=>process.exit(0),1300);
    `);
    await assert.rejects(execute({ executable: process.execPath,
      prefix: [path.resolve('scripts/qualification/native-platform-rpc.mjs')] }, [], {
      ...options, stdin: input,
    }), /left its initial process group/);
  });
});

// Test Value Gate: macOS can report a departing group member as unknown. A
// second, closed snapshot must prove absence; unknown itself never permits JSON.
test('RPC group waiting confirms one transient unknown state within its deadline', async () => {
  const self = `${process.pid} ${process.pid} S\n`;
  const events = [];
  let calls = 0;
  await waitForRpcGroupExit(performance.now() + 1000, event => events.push(event), (_command, _args, settings, done) => {
    const child = new EventEmitter(); child.pid = process.pid + 1;
    calls += 1;
    assert(settings.timeout <= 1000);
    setImmediate(() => {
      done(null, calls === 1 ? self + `${process.pid + 2} ${process.pid} ?\n` : self);
      child.emit('close', 0);
    });
    return child;
  });
  assert.equal(calls, 2);
  assert.equal(events.at(-1).event, 'group-wait-complete');
});

// Test Value Gate: only a valid owned-group snapshot after inspector close can
// permit JSON; failed or incomplete process queries cannot mean an empty group.
test('RPC group queries require inspector close, valid snapshots and the original deadline', async () => {
  const self = `${process.pid} ${process.pid} S\n`;
  const inspector = new EventEmitter();
  inspector.pid = process.pid + 1;
  let callback;
  let completed = false;
  const pending = waitForRpcGroupExit(performance.now() + 1000, () => {}, (_command, _args, _options, done) => {
    callback = done;
    return inspector;
  }).then(() => { completed = true; });
  callback(null, self + `${inspector.pid} ${process.pid} R\n`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  inspector.emit('close', 0);
  await pending;
  assert.equal(completed, true);

  // Test Value Gate: one safe classification must distinguish host query,
  // parse and group failures without exposing the original process output.
  const cases = [
    { output: '', reason: 'helper-row-missing', fields: { helperPid: process.pid, rows: 0 } },
    { output: 'private-inspection-output', reason: 'row-format-invalid' },
    { output: undefined, reason: 'query-output-invalid' },
    { output: `${process.pid} 0 S\n`, reason: 'helper-group-changed', fields: { helperPid: process.pid, pgid: 0 } },
    { output: self + `${process.pid} ${process.pid} S\n`, reason: 'pid-invalid-or-duplicate' },
    { output: self + `9007199254740992 1 S\n`, reason: 'pid-invalid-or-duplicate' },
    ...['helper', 'inspector', 'member'].map((role, index) => ({
      output: (index ? self : '') + `${process.pid + index} ${process.pid} ?\n`,
      reason: 'group-state-unknown', fields: { pid: process.pid + index, pgid: process.pid, role, stateCategory: 'unknown' },
    })),
    { output: self + `${process.pid + 2} ${process.pid} private-inspection-output\n`,
      reason: 'group-state-unknown', fields: { pid: process.pid + 2, pgid: process.pid, role: 'member', stateCategory: 'unsupported' } },
  ];
  for (const { output, reason, fields } of cases) {
    const events = [];
    await assert.rejects(waitForRpcGroupExit(performance.now() + 1000, event => events.push(event), (_command, _args, _options, done) => {
      const child = new EventEmitter(); child.pid = process.pid + 1;
      setImmediate(() => { done(null, output); child.emit('close', 0); });
      return child;
    }), /rpc-group-inspection-failed/);
    const failure = events.find(event => event.event === 'group-inspection-failed');
    assert(failure, `Missing inspection classification: ${reason}`);
    assert(Number.isFinite(failure.atMs));
    assert.deepEqual(failure, { atMs: failure.atMs, event: 'group-inspection-failed', reason, ...fields });
    assert.equal(JSON.stringify(events).includes('private-inspection-output'), false);
  }
  const syncEvents = [];
  await assert.rejects(waitForRpcGroupExit(performance.now() + 1000, event => syncEvents.push(event), () => {
    throw new Error('private-inspection-error');
  }), /^Error: rpc-group-inspection-failed$/);
  assert.equal(syncEvents.at(-1).reason, 'query-start-failed');
  assert.equal(JSON.stringify(syncEvents).includes('private-inspection-error'), false);
  for (const [details, fields] of [
    [{ code: 'EPERM' }, { exitCode: null, errorCode: 'EPERM', signal: null, queryKilled: false }],
    [{ code: 124, signal: 'SIGKILL', killed: true }, { exitCode: 124, errorCode: null, signal: 'SIGKILL', queryKilled: true }],
    [{ code: 'private-inspection-error', signal: 'private-signal', killed: true },
      { exitCode: null, errorCode: 'other', signal: null, queryKilled: true }],
  ]) {
    const events = [];
    await assert.rejects(waitForRpcGroupExit(performance.now() + 1000, event => events.push(event), (_command, _args, _options, done) => {
      const child = new EventEmitter(); child.pid = process.pid + 1;
      setImmediate(() => { done(Object.assign(new Error('private-inspection-error'), details), self); child.emit('close', 1); });
      return child;
    }), /^Error: rpc-group-inspection-failed$/);
    const failure = events.at(-1);
    assert.deepEqual(failure, { atMs: failure.atMs, event: 'group-inspection-failed', reason: 'query-failed', ...fields });
    assert.equal(JSON.stringify(events).includes('private-'), false);
  }
  await assert.rejects(waitForRpcGroupExit(performance.now() + 20, () => {}, (_command, _args, settings, done) => {
    assert(settings.timeout <= 20);
    const child = new EventEmitter(); child.pid = process.pid + 1;
    setTimeout(() => { done(null, self); child.emit('close', 0); }, 40);
    return child;
  }), /rpc-descendants-timeout/);
});

// Test Value Gate: public AW owns detached native-command groups; observation
// must accept clean completion while retaining marker and cleanup failures.
// Test Value Gate: process.title must not hide a retained startup marker from
// the actual macOS observer. Both a first-scan root and a later child rename.
test('macOS observes startup markers after root and child title changes', {
  skip: process.platform !== 'darwin', timeout: 30_000,
}, async () => {
  await publicProcessFixture(async (options) => {
    const child = path.join(options.cwd, 'title-child.cjs');
    const root = path.join(options.cwd, 'title-root.cjs');
    await fs.writeFile(child, `setTimeout(()=>{process.title='aw-title-child';},600);setTimeout(()=>process.exit(0),2400);`);
    await fs.writeFile(root, `
      process.title='aw-title-root';
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore'});
      child.on('exit',()=>console.log('title-child-completed'));
      setTimeout(()=>process.exit(2),6000).unref();
    `);
    const result = await executePublicAw({ executable: process.execPath, prefix: [root] }, [], options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'title-child-completed');
    assert.equal(result.containmentMode, 'observed');
    assert.equal(result.gradingEvidenceAccepted, false);
    assert.equal(result.descendantCleanupGuaranteed, false);
  });
});

test('public AW accepts independently grouped children only after their exit', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const result = await executePublicAw(nodeLauncher, ['-e', `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},1400)'],{detached:true,stdio:'ignore'});
      child.on('exit',()=>{console.log('completed');});
    `], options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'completed');
    assert.equal(result.containmentMode, 'observed');
    assert.equal(result.gradingEvidenceAccepted, false);
    assert.equal(result.descendantCleanupGuaranteed, false);
  });
});

test('public AW rejects a zero-exit root that leaves an independently grouped child', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', `
      const {spawn}=require('node:child_process');
      spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'}).unref();
      setTimeout(()=>process.exit(0),1400);
    `], options), error => {
      assert.match(error.message, /all provider descendants must exit before completion/);
      assert.equal(error.result?.exitCode, 0);
      assert.deepEqual(error.publicAwProcessFailure, { stage: 'process-execution', reason: 'process-cleanup-unconfirmed',
        processCleanup: 'unconfirmed', leaseCleanup: 'confirmed' });
      return true;
    });
  });
});

test('public AW rejects timeout, output limit and cancellation despite a zero exit', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', 'process.stdout.write("started");setTimeout(()=>{},10000)'],
      { ...options, timeoutMs: 500 }), (error) => {
      assert.match(error.message, /public-aw-process-timeout/);
      assert.equal(error.result.stdout, 'started');
      assert.equal(error.result.terminationReason, 'timeout');
      assert.deepEqual(error.publicAwProcessFailure, { stage: 'process-result', reason: 'process-result-rejected',
        processCleanup: 'confirmed', leaseCleanup: 'confirmed' });
      return true;
    });
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', 'process.stdout.write("x".repeat(3*1024*1024));setTimeout(()=>{},10000)'],
      options), /public-aw-process-max-buffer/);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('test-cancelled')), 1500);
    try {
      await assert.rejects(executePublicAw(nodeLauncher, ['-e',
        'process.on("SIGTERM",()=>process.exit(0));setTimeout(()=>{},10000)'],
      { ...options, signal: controller.signal }), /public-aw-process-abort/);
    } finally { clearTimeout(timer); }
  });
});

test('public AW inspection preflight failure prevents command launch', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const marker = path.join(options.cwd, 'launched');
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`],
      options, { execFile(_command, _args, _options, callback) { callback(new Error('inspection unavailable'), ''); } }),
    error => {
      assert.match(error.message, /process identity lookup failed|process marker lookup failed/);
      assert.equal(error.result, undefined);
      assert.deepEqual(error.publicAwProcessFailure, { stage: 'inspection-lease-acquire', reason: 'inspection-lease-acquisition-failed',
        processCleanup: 'not-needed', leaseCleanup: 'unconfirmed' });
      return true;
    });
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  });
});

test('public AW observation failure aborts and remains failed after cleanup', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const report = { observations: [], commands: [] };
    const marker = path.join(options.cwd, 'launched');
    let injected = false;
    await assert.rejects(observeQualification(report, 'discovery', () => executePublicAw(nodeLauncher, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');setTimeout(()=>{},10000)`], options, {
      execFile(command, args, settings, callback) {
        fs.stat(marker).then(() => {
          if (!injected) { injected = true; callback(new Error('inspection lost'), ''); }
          else execFile(command, args, settings, callback);
        }, () => execFile(command, args, settings, callback));
      },
    }), options.cwd), (error) => {
      assert.equal(injected, true);
      assert.equal(error.result?.cancelled, true);
      assert(error.publicAwProcessDiagnostics.length > 0);
      assert.equal(typeof error.publicAwProcessDiagnostics[0].rootPid, 'number');
      return true;
    });
    assert.equal(report.observations[0].status, 'failed');
  });
});

test('public AW lease release failure cannot become success', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', 'console.log("ok")'], options, {
      async createSentinel(name, marker) {
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'],
          { env: { PATH: process.env.PATH, [name]: marker }, stdio: 'ignore' });
        const closed = once(child, 'close');
        await once(child, 'spawn');
        return { pid: child.pid, async stop() { child.kill('SIGTERM'); await closed; throw new Error('release failed'); } };
      },
    }), error => {
      assert.match(error.message, /public-aw-inspection-lease-release-failed/);
      assert.equal(error.result?.exitCode, 0);
      assert.deepEqual(error.publicAwProcessFailure, { stage: 'inspection-lease-release', reason: 'inspection-lease-release-failed',
        processCleanup: 'confirmed', leaseCleanup: 'unconfirmed' });
      return true;
    });
  });
});
