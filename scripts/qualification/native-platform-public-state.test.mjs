import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePublicClientPath, preparePublicClientPaths } from './native-platform-public-aw.mjs';
import { verifyCodexSharedProviderRemoval } from './native-platform-public-cases.mjs';
import { assertPublicStatus, expectedOpenCodeObservation, readPublicRemovedNativeScope, readPublicNativeState, readDynamicConsumerContent } from './native-platform-public-state.mjs';
import { grokTrustTargets, runComponentQualification } from './native-platform-public-components.mjs';
import { confirmedSharedRetention, verifyFixtureRemoval } from './native-platform-public-removal.mjs';
import { clients, prepareEnvironment } from './native-platform-runtime.mjs';

const publicResponse = (command, data) => ({
  exitCode: 0, terminationReason: 'complete', stderr: '',
  stdout: JSON.stringify({ schemaVersion: 2, command, status: 'success', data, diagnostics: [] }),
});

// A process can fail before its first observation or return a timed-out Windows Job result.
test('keeps the public command and actual scope when the process has no snapshots', async (t) => {
  const catalog = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-source-test-'));
  t.after(() => fs.rm(catalog, { recursive: true, force: true }));
  await fs.writeFile(path.join(catalog, 'catalog-manifest.json'), JSON.stringify({ entries: [] }));
  const helperFailures = { 'helper-failure': {}, 'helper-timeout': { timedOut: true }, 'helper-signal': { signal: 'SIGTERM' },
    'helper-max-buffer': { maxBufferExceeded: true }, 'helper-truncated': { stdoutTruncated: true }, 'helper-wrong-command': {} };
  for (const outcome of ['timeout', 'preflight', 'signal', 'invalid-output', ...Object.keys(helperFailures)]) {
    const command = outcome === 'preflight' ? 'source.add' : 'target.set';
    const privateMessage = 'private fixture output that must stay out of the report';
    const result = await runComponentQualification({ platform: 'generic', scope: 'project', suite: 'candidate', catalog }, {
      executeCommand: async () => ({ exitCode: 0 }),
      async executeAw(_launcher, args) {
        const called = args.slice(0, 2).join('.');
        if (called !== command) return publicResponse(called, { availability: [{ id: 'generic', installations: [] }] });
        if (outcome === 'preflight') throw new Error(privateMessage);
        if (outcome === 'signal') return { exitCode: null, signal: 'SIGTERM', terminationReason: 'complete', stdout: privateMessage };
        if (Object.hasOwn(helperFailures, outcome)) {
          const receipt = publicResponse(outcome === 'helper-wrong-command' ? 'plugin.status' : called, { raw: privateMessage });
          return { ...receipt, exitCode: 250, descendantCleanupGuaranteed: true, stderr: privateMessage, ...helperFailures[outcome] };
        }
        if (outcome === 'invalid-output') return { exitCode: 1, terminationReason: 'complete', stdout: privateMessage };
        return { exitCode: 124, timedOut: true, cancelled: false, terminationReason: 'timeout', descendantCleanupGuaranteed: true,
          stdout: privateMessage, stderr: privateMessage };
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.commandFailures?.length, 1);
    const [failure] = result.commandFailures;
    assert.equal(failure.command, command);
    if (command === 'target.set') {
      assert.equal(failure.scope, 'user');
    } else assert(!Object.hasOwn(failure, 'scope'));
    if (outcome === 'timeout') {
      assert.equal(failure.timedOut, true);
      assert.equal(failure.terminationReason, 'timeout');
      assert.equal(failure.descendantCleanupGuaranteed, true);
    } else if (outcome === 'signal') {
      assert.equal(failure.exitCode, null);
      assert.equal(failure.signal, 'SIGTERM');
    } else if (Object.hasOwn(helperFailures, outcome)) {
      assert.equal(failure.exitCode, 250);
      assert.equal(failure.stage, 'execute');
      assert(!Object.hasOwn(failure, 'descendantCleanupGuaranteed'));
      assert.deepEqual(failure.awReceipt, outcome === 'helper-failure' ? { status: 'success' } : undefined, outcome);
    } else if (outcome === 'invalid-output') {
      assert.equal(failure.exitCode, 1);
      assert.equal(failure.stage, 'response');
    }
    assert(!JSON.stringify(result).includes(privateMessage));
  }
});

// A plausible payload from another command, or a failed receipt with exit 0,
// must stop the qualification before its next command consumes the result.
test('binds component receipts to the requested command and public status and exit code', async (t) => {
  const catalog = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-component-receipt-test-'));
  t.after(() => fs.rm(catalog, { recursive: true, force: true }));
  await fs.writeFile(path.join(catalog, 'catalog-manifest.json'), JSON.stringify({ entries: ['agent-subagent', 'codex-enhance']
    .map(name => ({ name, dependencies: [], version: '1.0.0', artifactDigest: 'fixture-digest' })) }));
  const commands = ['target.set', 'source.add', 'source.sync', 'plugin.install', 'plugin.status'];
  for (const { request, command = request, status, exitCode, diagnostics = [], valid = false } of [
    { request: 'target.set', command: 'plugin.status', status: 'success', exitCode: 0 },
    { request: 'plugin.install', status: 'failed', exitCode: 0 },
    { request: 'plugin.status', status: 'failed', exitCode: 0 },
    { request: 'plugin.install', status: 'partial', exitCode: 1 },
    { request: 'target.set', status: 'success', exitCode: 0, diagnostics: [{ code: 'processCleanupUnconfirmed', severity: 'error' }] },
    { request: 'plugin.install', status: 'partial', exitCode: 4, valid: true },
    { request: 'plugin.install', status: 'partial', exitCode: 1, valid: true,
      diagnostics: [{ code: 'processCleanupUnconfirmed', severity: 'error' }] },
  ]) {
    const calls = [];
    const report = await runComponentQualification({ platform: 'generic', scope: 'project', suite: 'candidate', catalog }, {
      executeCommand: async () => ({ exitCode: 0 }),
      async executeAw(_launcher, args, { env }) {
        const called = args.slice(0, 2).join('.');
        calls.push(called);
        if (called === 'source.sync') await fs.writeFile(path.join(env.AW_HOME, 'catalog-state.json'), JSON.stringify({
          sources: { 'qualification-official': { active: { snapshotDigest: 'fixture-snapshot' } } },
        }));
        const data = called === 'target.set' ? { availability: [{ id: 'generic', installations: [] }] } : { targetResults: [] };
        const result = publicResponse(called, data);
        if (called !== request) return result;
        return { ...result, exitCode, stdout: JSON.stringify({ schemaVersion: 2, command, status, data, diagnostics }) };
      },
    });
    assert.equal(report.status, 'failed');
    assert.deepEqual(calls, valid ? commands : commands.slice(0, commands.indexOf(request) + 1));
    assert.equal(report.commandFailures.length, 1);
    const [failure] = report.commandFailures;
    assert.equal(failure.command, request);
    assert.equal(failure.exitCode, exitCode);
    assert.equal(failure.stage, valid ? 'command' : 'response');
    assert.equal(failure.awReceipt?.status, valid ? status : undefined);
  }
});

// Test Value Gate: published evidence must keep each independent Catalog failure and omit private command data.
test('records separate, redacted failures from the public component Catalog report', async (t) => {
  const catalog = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-component-catalog-test-'));
  t.after(() => fs.rm(catalog, { recursive: true, force: true }));
  const roleNames = { 'agent-subagent': ['subagent'], 'codex-enhance': ['codex-explore', 'codex-advisor'] };
  const staticPlugins = ['first-static', 'second-static', 'third-static'];
  const names = [...Object.keys(roleNames), ...staticPlugins];
  await fs.writeFile(path.join(catalog, 'catalog-manifest.json'), JSON.stringify({ entries: names.map(name => ({
    name, source: name, dependencies: [], version: '1.0.0', artifactDigest: 'fixture-digest',
  })) }));
  for (const name of staticPlugins) {
    const folder = path.join(catalog, name, '.agents-plugin');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'plugin.json'), JSON.stringify({ skills: 'skills' }));
  }
  const pluginId = name => `qualification-official/${name}`;
  const targets = Object.entries(roleNames).map(([name, roles]) => ({ pluginId: pluginId(name), scope: 'project',
    target: 'generic', blockerCodes: [], deploymentReceipts: [], componentGaps: roles.map(role => ({ id: `agent:${role}`,
      kind: 'agent', name: role, providerPluginId: pluginId(name), reasonCode: 'interface-unsupported', requiredFeatures: ['agent'] })) }));
  const privateValues = ['/host/private/profile', 'FAKE_ENVIRONMENT=private', 'secret-marker-value', 'fake-credential', 'raw invocation body', 'unsafeDiagnosticCode'];
  const privateText = privateValues.join(' ');
  const startTime = 'Sat Nov 21 09:01:02 2026';
  const affectedProcess = { pid: 43, ppid: 41, startTime, markerMatches: false };
  const first = { stage: 'observation', reason: 'known-process-marker-missing', rootPid: 41, affectedPids: [43],
    processes: [...Array.from({ length: 40 }, (_, index) => ({ pid: 100 + index })), { ...affectedProcess, command: privateText }] };
  const last = { ...first, stage: 'cleanup', reason: 'process-marker-unreadable' };

  const report = await runComponentQualification({ platform: 'generic', scope: 'project', suite: 'candidate', catalog }, {
    executeCommand: async () => ({ exitCode: 0 }),
    async executeAw(_launcher, args, { env }) {
      const command = args.slice(0, 2).join('.');
      if (command === 'target.set') return publicResponse(command, { availability: [{ id: 'generic', installations: [] }] });
      if (command === 'source.sync') await fs.writeFile(path.join(env.AW_HOME, 'catalog-state.json'), JSON.stringify({
        sources: { 'qualification-official': { active: { snapshotDigest: 'fixture-snapshot' } } },
      }));
      if (command === 'plugin.status') return publicResponse(command, { targetResults: targets, inSync: true,
        allSatisfied: true, counts: { pending: 0 } });
      if (args[2] === pluginId('first-static')) {
        throw Object.assign(new Error(privateText), { name: 'ProviderProcessCleanupError', env: { credentials: privateText },
          result: { ...publicResponse(command, {}), exitCode: 1, stdout: JSON.stringify({
            schemaVersion: 2, command, status: 'failed', data: { raw: privateText }, diagnostics: [
              { code: 'processCleanupUnconfirmed', severity: 'error', message: privateText,
                detail: { reasonCode: 'unsafeDiagnosticCode', path: privateText } },
              { code: 'unsafeDiagnosticCode', severity: 'error', message: privateText },
            ], nextActions: [{ argv: [privateText] }],
          }), stderr: privateText, timedOut: false },
          publicAwProcessDiagnostics: [first, { ...first, reason: 'intermediate' }, last],
          publicAwProcessNames: [{ pid: 43, processName: 'grok', startTime, source: 'identity-ps-ucomm', args: [privateText] }],
          publicAwMarkerRows: [{ pid: 43, queryId: 7, commandForm: 'parenthesized', markerMatches: false,
            command: privateText, startupEnvironment: { status: 'complete', environmentBytes: 58, environment: privateText } }],
          qualificationMarkerIdentityConfirmations: { source: 'observer-local-post-marker-identity-query', omitted: 0,
            records: [{ pid: 43, result: 'present', raw: privateText }] },
        });
      }
      if (args[2] === pluginId('second-static')) {
        throw Object.assign(new Error(privateText), { processTreeDiagnostics: [{ stage: 'cleanup', rootPid: 74,
          reason: 'root-marker-missing', affectedPids: [74], processes: [{ pid: 74, command: privateText }] }] });
      }
      if (args[2] === pluginId('third-static')) {
        return { ...publicResponse(command, {}), exitCode: 3, stderr: privateText, stdout: JSON.stringify({
          schemaVersion: 2, command, status: 'blocked', diagnostics: [], data: { targetResults: [{
            pluginId: pluginId('third-static'), target: 'generic', scope: 'project', execution: 'not-run',
            blockerCodes: ['operationPlanStale', 'unsafeDiagnosticCode'], componentGaps: [{ raw: privateText }],
          }] },
        }) };
      }
      return publicResponse(command, { targetResults: targets });
    },
  });
  assert.equal(report.status, 'failed');
  assert.match(report.reason, /Shipped plugin installation failed: first-static, second-static, third-static/u);
  const [cleanup, later, blocked] = report.commandFailures;
  assert.equal(report.commandFailures.length, 3);
  assert.deepEqual([cleanup.command, cleanup.stage, cleanup.scope, cleanup.pluginIds, cleanup.error],
    ['plugin.install', 'execute', 'project', [pluginId('first-static')], 'ProviderProcessCleanupError']);
  assert.equal(cleanup.exitCode, 1);
  assert.deepEqual(cleanup.awReceipt, { status: 'failed', diagnostics: [{ code: 'processCleanupUnconfirmed', severity: 'error' }] });
  assert.deepEqual(cleanup.processDiagnostics.map(row => row.reason), [first.reason, last.reason]);
  assert.equal(cleanup.processDiagnostics[0].processes.length, 32);
  assert.equal(cleanup.processDiagnostics[0].omittedProcesses, 9);
  assert.deepEqual(cleanup.processDiagnostics[0].processes.find(row => row.pid === 43), affectedProcess);
  assert.equal(cleanup.processNames[0].processName, 'grok');
  assert.equal(cleanup.markerRows[0].startupEnvironment.environmentBytes, 58);
  assert.equal(cleanup.markerIdentityConfirmations.records[0].result, 'present');
  assert.deepEqual([later.command, later.stage, later.pluginIds, later.processDiagnostics[0].rootPid],
    ['plugin.install', 'execute', [pluginId('second-static')], 74]);
  assert.equal(later.awReceipt, undefined);
  assert.deepEqual([blocked.command, blocked.stage, blocked.exitCode, blocked.awReceipt], ['plugin.install', 'command', 3,
    { status: 'blocked', targets: [{ pluginId: pluginId('third-static'), target: 'generic', scope: 'project',
      execution: 'not-run', blockerCodes: ['operationPlanStale'] }] }]);
  const published = JSON.stringify(report);
  for (const privateValue of privateValues) assert(!published.includes(privateValue));
});

// The failed installation must own its bounded native command evidence even
// when a later status read succeeds or trace output is unavailable.
test('scopes the Codex candidate native trace to the failing Project install', async (t) => {
  const catalog = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-component-codex-test-'));
  t.after(() => fs.rm(catalog, { recursive: true, force: true }));
  const pluginIds = ['agent-subagent', 'codex-enhance'].map(name => `qualification-official/${name}`);
  await fs.writeFile(path.join(catalog, 'catalog-manifest.json'), JSON.stringify({ entries: pluginIds.map(id => ({
    name: id.split('/')[1], dependencies: [], version: '1.0.0', artifactDigest: 'fixture-digest',
  })) }));
  const sentinel = 'private_candidate_payload';
  const outcome = { category: 'windows-system-powershell', elapsedMs: 29998, threw: true,
    exitCode: 124, timedOut: true, cleanupUnconfirmed: true, reason: 'timeout', errorCode: 'nativeCliTimedOut' };
  const staleMessage = 'operationPlanStale: deployment evidence changed after the ordinary observation.';
  for (const traced of [true, false]) {
    let traceFile;
    let statusCalls = 0;
    const report = await runComponentQualification({ platform: 'codex', scope: 'project', suite: 'candidate', catalog,
      clientPath: process.env.PATH, traceEntry: process.execPath }, {
      executeCommand: async () => ({ exitCode: 0 }),
      async executeAw(_launcher, args, { env }) {
        const command = args.slice(0, 2).join('.');
        if (command !== 'plugin.install') {
          assert.equal(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE, undefined);
          assert.equal(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_MODE, undefined);
        }
        if (command === 'target.set') return publicResponse(command, { availability: [{ id: 'codex', installations: [] }] });
        if (command === 'source.sync') await fs.writeFile(path.join(env.AW_HOME, 'catalog-state.json'), JSON.stringify({
          sources: { 'qualification-official': { active: { snapshotDigest: 'fixture-snapshot' } } },
        }));
        if (command === 'plugin.status') statusCalls++;
        if (command !== 'plugin.install') return publicResponse(command, {});
        assert.equal(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_MODE, 'codex-component-install');
        assert.deepEqual(JSON.parse(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES), [process.execPath]);
        traceFile = env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE;
        if (traced) await fs.writeFile(traceFile, [
          { phase: 'installation', state: 'installed' }, { phase: 'finish', ...outcome, argv: [sentinel], stdout: sentinel,
            stderr: sentinel, command: sentinel, env: { SECRET: sentinel }, causeCode: sentinel },
          { phase: 'finish', category: sentinel },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        return { ...publicResponse(command, {}), exitCode: 3, stderr: sentinel, stdout: JSON.stringify({
          schemaVersion: 2, command, status: 'blocked', diagnostics: [{ code: 'operationPlanStale', message: sentinel }],
          data: { targetResults: [
            { pluginId: pluginIds[0], target: 'codex', scope: 'user', execution: 'failed', blockerCodes: ['processCleanupUnconfirmed'],
              deploymentReceipts: [{ diagnostics: [{ code: 'processCleanupUnconfirmed', severity: 'error', message: sentinel }] }] },
            { pluginId: pluginIds[0], target: 'codex', scope: 'project', execution: 'not-run',
              blockerCodes: ['operationPlanStale'], componentGaps: [{ stdout: sentinel }], deploymentReceipts: [{
                diagnostics: [{ code: 'operationPlanStale', severity: 'error', message: staleMessage, detail: { path: sentinel } }],
              }] },
          ] },
        }) };
      },
    });
    assert.equal(report.status, 'failed');
    assert.equal(statusCalls, 1);
    assert.match(report.reason, /Shipped role plugin installation failed/u);
    assert.equal(report.commandFailures.length, 1);
    const [failure] = report.commandFailures;
    assert.deepEqual(failure.pluginIds, pluginIds);
    assert.deepEqual(failure.awReceipt.targets.map(({ scope }) => scope), ['project']);
    assert.deepEqual(failure.awReceipt.targets[0].diagnostics, [{ code: 'operationPlanStale', severity: 'error', reason: staleMessage }]);
    assert.deepEqual(failure.nativeCommandTrace, traced ? { state: 'captured', installation: 'installed', records: [outcome] }
      : { state: 'not-created', records: [] });
    assert(!JSON.stringify(report).includes(sentinel));
    await assert.rejects(fs.stat(traceFile), { code: 'ENOENT' });
  }
});

// Test Value Gate: optional runtime failure cannot be reported as observed or assigned to a different scope.
test('requires OpenCode explicit observation to report a scoped runtime outcome', () => {
  const ctx = { scope: 'project' };
  const pluginId = 'qualification/fixture';
  const diagnostic = { code: 'opencodePluginLoadFailed', severity: 'warning', subject: { target: 'opencode', pluginId, scope: 'project' } };
  assert.deepEqual(expectedOpenCodeObservation({ diagnostics: [] }, ctx, pluginId), { activation: 'enabled', load: 'observed' });
  assert.deepEqual(expectedOpenCodeObservation({ diagnostics: [diagnostic] }, ctx, pluginId), { activation: 'unknown', load: 'not-observed' });
  diagnostic.code = 'opencodeNativeObservationFailed';
  assert.deepEqual(expectedOpenCodeObservation({ diagnostics: [diagnostic] }, ctx, pluginId), { activation: 'unknown', load: 'unknown' });
  diagnostic.subject.scope = 'user';
  assert.throws(() => expectedOpenCodeObservation({ diagnostics: [diagnostic] }, ctx, pluginId));
});

// Test Value Gate: the grader must fail when a status from the real runner
// calls an installed but disabled target ready, or omits its installed facts.
test('grades v2 disabled status separately from native installation facts', () => {
  const ctx = { platform: 'antigravity', scope: 'user', pluginName: 'fixture', skillName: 'fixture' };
  const pluginId = 'qualification/fixture';
  const target = { pluginId, target: 'antigravity', scope: 'user', delivery: { kind: 'native', platform: 'antigravity' },
    content: 'drifted', satisfaction: 'pending', blockerCodes: [], deploymentObservations: [{ products: [{ id: 'cli', product: 'cli', version: '1.3.4' }],
      after: { package: 'present', registration: 'present', ownership: 'aw', nativeIdentity: { packageId: 'fixture' },
        components: [{ id: 'skill:fixture', presence: 'present', reasonCodes: [] }], consumers: [{ productId: 'cli', activation: 'disabled' }] } }] };
  const result = { schemaVersion: 2, command: 'plugin.status', status: 'success', diagnostics: [],
    nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'sync', pluginId, '--context', 'user', '--target', 'antigravity'] }],
    data: { context: 'user',
    coverage: { scopes: ['user'] }, allSatisfied: false, inSync: false, counts: { blocked: 0, pending: 1, unconfirmed: 0, ready: 0 },
    inventory: [{ pluginId, sourceState: 'ready', blockerCodes: [], targetResults: [target] }] } };
  const expected = { content: 'drifted', activation: 'disabled' };
  assert.equal(assertPublicStatus(result, ctx, pluginId, expected).deployment.registration, 'present');
  target.content = 'satisfied';
  assert.throws(() => assertPublicStatus(result, ctx, pluginId, expected), { code: 'ERR_ASSERTION' });
  target.content = 'drifted';
  target.deploymentObservations[0].after.registration = 'unknown';
  assert.throws(() => assertPublicStatus(result, ctx, pluginId, expected), { code: 'ERR_ASSERTION' });
});

// Test Value Gate: Antigravity's inventory path, rather than the AW staging
// file or version alone, must prove the rendered body in both fresh scopes.
test('checks Antigravity effective User scope and actual dynamic installed bytes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-antigravity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginName = 'fixture'; const skillName = 'fixture-skill'; const installed = path.join(root, 'native-copy');
  const file = path.join(installed, 'skills', skillName, 'SKILL.md');
  const expected = path.join(root, 'rendered-SKILL.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(expected, 'current rendered revision 3'); await fs.writeFile(file, 'stale revision 2');
  const row = { name: pluginName, version: '0.1.1', enabled: true, source: 'antigravity', path: installed };
  const calls = []; const ctx = { root, platform: 'antigravity', scope: 'user', pluginName, skillName,
    publicSkillFile: expected, project: path.join(root, 'target'), neutral: path.join(root, 'neutral'),
    async command(args, cwd) { calls.push({ args, cwd }); return { stdout: JSON.stringify([row]) }; } };
  for (const cwd of [ctx.project, ctx.neutral]) {
    assert.equal((await readPublicNativeState(ctx, cwd, 3, { active: true })).active, true);
    await assert.rejects(readDynamicConsumerContent(ctx, cwd, 3), /dynamic-consumer-content-mismatch/u);
  }
  await fs.copyFile(expected, file);
  for (const cwd of [ctx.project, ctx.neutral]) {
    assert.equal((await readDynamicConsumerContent(ctx, cwd, 3)).path, file);
  }
  row.enabled = false;
  await assert.rejects(readPublicNativeState(ctx, ctx.neutral, 3, { active: true }), /native-management-scope-mismatch/u);
  row.enabled = true; row.version = '0.1.0';
  await assert.rejects(readPublicNativeState(ctx, ctx.project, 3, { active: true }), /native-management-version-mismatch/u);
  assert(calls.every(call => call.args.join(' ') === 'plugin list --json'));
  assert(calls.some(call => call.cwd === ctx.project) && calls.some(call => call.cwd === ctx.neutral));
});

test('exposes the fixed Antigravity entry as agy in the isolated public PATH', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-agy-bin-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'antigravity'); await fs.writeFile(entry, 'fixed entry fixture');
  const ctx = { root, platform: 'antigravity', env: {}, launcher: { executable: entry, prefix: [] } };
  assert.equal(await preparePublicClientPath(ctx), entry);
  assert.equal(await fs.realpath(path.join(root, 'client-bin', 'agy')), entry);
});

// Test Value Gate: the isolated public PATH must expose POSIX system helpers
// required by the real client without inheriting user or unrelated client bins.
test('prepares an isolated POSIX client PATH with system administration helpers', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-client-path-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'acquired-entry');
  await fs.writeFile(entry, 'isolated client fixture');
  const clientBin = path.join(root, 'private-bin');
  const ctx = { root, clientBin, platform: 'claude', env: { PATH: '/unrelated/client-bin' },
    launcher: { executable: process.execPath, prefix: [entry] } };
  assert.equal(await preparePublicClientPath(ctx), entry);
  assert.deepEqual(ctx.env.PATH.split(path.delimiter), [clientBin, path.dirname(process.execPath),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.equal(await fs.realpath(path.join(clientBin, 'claude')), entry);
});

// Test Value Gate: batch discovery must preserve both acquisition prefixes,
// including the npm package behind the Windows Pi shim when the runner's
// temporary directory and the resolved package entry have different spellings.
test('exposes both acquired clients in one isolated public PATH', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-batch-path-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claudeBin = path.join(root, 'claude-tool');
  const piBin = path.join(root, 'pi-tool');
  const piBinAlias = path.join(root, 'pi-bin-alias');
  const piPackage = path.join(piBin, 'node_modules', ...clients.pi.package.split('/'));
  const piEntry = path.join(piPackage, 'cli.js');
  const claudeEntry = path.join(root, 'acquired-claude');
  const runnerGit = path.join(root, 'runner-git');
  const unrelated = path.join(root, 'unrelated');
  await fs.mkdir(piPackage, { recursive: true });
  await fs.symlink(piBin, piBinAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(runnerGit);
  await fs.writeFile(path.join(runnerGit, 'git.exe'), 'Git fixture');
  await fs.writeFile(claudeEntry, 'Claude fixture');
  await fs.writeFile(piEntry, '#!/usr/bin/env node\n');
  await fs.writeFile(path.join(piPackage, 'package.json'), JSON.stringify({ name: clients.pi.package, bin: { pi: 'cli.js' } }));
  const env = { PATH: [unrelated, runnerGit].join(path.delimiter), PATHEXT: '.exe;.cmd', SystemRoot: root };
  const base = { root, env, project: root };
  const [claude, pi] = await preparePublicClientPaths([
    { ...base, platform: 'claude', clientBin: claudeBin, launcher: { executable: claudeEntry, prefix: [] } },
    { ...base, platform: 'pi', clientBin: piBinAlias, launcher: { executable: process.execPath, prefix: [piEntry] } },
  ]);
  const directories = env.PATH.split(path.delimiter);
  assert.deepEqual(directories.slice(0, 2), [claudeBin, piBinAlias]);
  assert(!directories.includes(unrelated));
  assert.deepEqual(await fs.readFile(claude), await fs.readFile(claudeEntry));
  if (process.platform === 'win32') {
    const { resolveWindowsPathCommand, resolveWindowsNpmCommand } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
    assert.equal(await fs.realpath(await resolveWindowsPathCommand('claude', root, env)), claude);
    const launcher = await resolveWindowsNpmCommand({ command: 'pi', binName: 'pi', packageName: clients.pi.package, cwd: root, env });
    assert.deepEqual(launcher, { command: process.execPath, argsPrefix: [await fs.realpath(piEntry)] });
  } else assert.equal(pi, await fs.realpath(piEntry));
});

test('Grok only offers trust recovery for a fully explained dependency chain', () => {
  const row = (pluginId, blocker) => ({ pluginId, scope: 'user', target: 'grok', blockerCodes: [blocker] });
  const parent = row('official/agent-subagent', 'nativeTrustRequired');
  const child = row('official/codex-enhance', 'dependencyInstallFailed');
  const grandchild = row('official/consumer', 'dependencyInstallFailed');
  const value = { data: { targetResults: [grandchild, child, parent] }, diagnostics: [] };
  const edges = new Map([[parent.pluginId, []], [child.pluginId, [parent.pluginId]], [grandchild.pluginId, [child.pluginId]]]);
  assert.deepEqual(grokTrustTargets(value, edges, new Set()), [parent]);
  const propagated = { ...child, execution: 'not-run', blockerCodes: ['dependencyInstallFailed', 'nativeTrustRequired'] };
  const mixed = { ...value, data: { targetResults: [grandchild, propagated, parent] } };
  assert.deepEqual(grokTrustTargets(mixed, edges, new Set()), [parent]);
  assert.deepEqual(grokTrustTargets(mixed, new Map([...edges, [child.pluginId, []]]), new Set()), []);
  assert.deepEqual(grokTrustTargets({ ...mixed, data: { targetResults: [{ ...propagated, execution: 'partial' }, parent] } }, edges, new Set()), []);
  assert.deepEqual(grokTrustTargets(value, edges, new Set([parent.pluginId])), []);
  assert.deepEqual(grokTrustTargets(value, new Map([...edges, [child.pluginId, []]]), new Set()), []);
  value.data.targetResults.push(row('official/unrelated', 'operationPlanStale'));
  assert.deepEqual(grokTrustTargets(value, edges, new Set()), []);
  value.data.targetResults.pop();
  value.diagnostics.push({ code: 'preApplyFailed', severity: 'error' });
  assert.deepEqual(grokTrustTargets(value, edges, new Set()), []);
});

function removalFixture(platform = 'codex', scope = 'user', {
  root = path.join(os.tmpdir(), 'aw-public-state-fixture'), pluginName = 'aw-qualification', version = '0.1.1',
} = {}) {
  const pluginId = `qualification/${pluginName}`;
  const project = path.join(root, 'project');
  const neutral = path.join(root, 'neutral');
  const calls = [];
  const row = { name: pluginName, pluginId: `${pluginName}@fixture`, installed: true,
    version, enabled: false };
  const rows = new Map([[project, [structuredClone(row)]], [neutral, [structuredClone(row)]]]);
  const ctx = { platform, scope, pluginName, project, neutral, async command(args, cwd) {
    calls.push({ args, cwd });
    const current = rows.get(cwd);
    assert(current, 'Removal must read a fresh target or neutral scope.');
    return { stdout: JSON.stringify(platform === 'codex' ? { installed: current } : current) };
  } };
  const bindingId = 'fixture-binding';
  const physicalKey = 'fixture-physical';
  const activationKey = `fixture-activation-${scope}`;
  const product = { id: `${platform}-cli`, product: 'cli', version: clients[platform].version };
  const effect = { id: 'fixture-deactivate', kind: 'deactivate', physicalKey, activationKey };
  const plan = { bindingId, physicalKey, products: [product], expected: { components: [], omitted: [], unmet: [] },
    effects: [effect], sharedReferences: 'unknown' };
  const subject = { pluginId, target: platform, scope };
  const receipt = { bindingId, products: [product], after: { physicalKey, package: 'present',
    registration: 'present', ownership: 'aw',
    consumers: [{ productId: product.id, activationKey, activation: 'disabled', trust: 'unknown', load: 'unknown' }],
    nativeIdentity: { route: `${platform}-marketplace`, packageId: pluginName } },
  effects: [{ id: effect.id, status: 'applied', mutation: 'confirmed', diagnostics: [] }], unmet: [],
  diagnostics: [{ code: 'sharedReferenceUnknown', severity: 'warning', subject }] };
  const target = { pluginId, target: platform, scope, delivery: { kind: 'native', platform },
    execution: 'applied', observation: 'unknown', content: 'unknown', blockerCodes: [],
    deploymentPlans: [plan], deploymentReceipts: [receipt] };
  const result = { command: 'plugin.remove', status: 'success', data: {
    request: { plugins: [pluginId], targets: [platform], scope }, targetResults: [target] } };
  return { ctx, pluginId, result, plan, receipt, target, rows, calls };
}

// Test Value Gate: a successful removal and a disabled native inventory cannot
// establish that the independent Project activation and declaration are gone,
// or that the previously shared User provider still satisfies its requirement.
test('requires fresh cleanup and surviving provider evidence for Codex Project dependent removal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-shared-provider-removal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dependent = removalFixture('codex', 'project', { root, pluginName: 'aw-qualification-dependent', version: '0.1.0' });
  const pluginName = 'aw-qualification';
  const pluginId = `qualification/${pluginName}`;
  const skillName = pluginName;
  const dependentId = dependent.pluginId;
  const registrationId = `${dependent.ctx.pluginName}@fixture`;
  dependent.receipt.after.nativeIdentity.registrationId = registrationId;
  const removal = dependent.result;
  removal.data.changes = { requirements: 'changed' };
  removal.data.requirements = { state: 'valid', roots: [] };
  const userProvider = {
    products: dependent.plan.products,
    after: { physicalKey: 'provider-physical', package: 'present', registration: 'present', ownership: 'aw',
      nativeIdentity: { packageId: pluginName }, components: [{ id: `skill:${skillName}`, presence: 'present', reasonCodes: [] }],
      consumers: [{ productId: 'codex-cli', activation: 'enabled', activationKey: 'user-provider-activation' }] },
  };
  const providerTarget = { pluginId, scope: 'user', target: 'codex', delivery: dependent.target.delivery, blockerCodes: [],
    observation: 'verified', content: 'satisfied', satisfaction: 'installed', deploymentObservations: [structuredClone(userProvider)] };
  const declarations = [{ scope: 'user', state: 'valid', roots: [pluginId] }, { scope: 'project', state: 'valid', roots: [] }];
  const ctx = { ...dependent.ctx, scope: 'user', pluginName, skillName, async aw(args) {
    assert.deepEqual(args, ['plugin', 'status', '--context', 'project']);
    return { data: { requirements: { declarations },
      inventory: [{ pluginId, sourceState: 'ready', blockerCodes: [], targetResults: [providerTarget] }] } };
  } };
  const verify = () => verifyCodexSharedProviderRemoval(ctx,
    { pluginId, dependentId, userProvider, dependentDeployment: dependent.receipt, removal });
  assert.equal((await verify()).native.retainedRegistration, true);
  declarations[1].roots.push(dependentId);
  await assert.rejects(verify, { code: 'ERR_ASSERTION' });
  declarations[1].roots.pop();
  providerTarget.deploymentObservations[0].after.physicalKey = 'replacement-physical';
  await assert.rejects(verify, { code: 'ERR_ASSERTION' });
  providerTarget.deploymentObservations[0].after.physicalKey = userProvider.after.physicalKey;
  const config = path.join(ctx.project, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, `[plugins."${registrationId}"]\nenabled = false\n`);
  await assert.rejects(verify, { code: 'ERR_ASSERTION' });
});

// Test Value Gate: a successful shared-retention remove may leave its exact
// disabled registration, but both fresh working directories must be off.
test('accepts shared retention only with matching removal evidence and fresh disabled scopes', async (t) => {
  for (const platform of ['codex', 'copilot']) for (const scope of ['user', 'project']) {
    await t.test(`${platform} ${scope}`, async () => {
      const fixture = removalFixture(platform, scope);
      const observed = await readPublicRemovedNativeScope(fixture.ctx, 3, fixture.result, fixture.pluginId);
      assert.equal(observed.retainedRegistration, true);
      assert.deepEqual(observed.target, { level: 'native-management-state', active: false,
        present: true, version: '0.1.1' });
      assert.deepEqual(observed.neutral, observed.target);
      assert.deepEqual(fixture.calls, [fixture.ctx.project, fixture.ctx.neutral].map((cwd) => ({
        args: ['plugin', 'list', '--json'], cwd,
      })));
    });
  }
  const fixture = removalFixture();
  fixture.plan.sharedReferences = 'present';
  fixture.receipt.diagnostics[0].code = 'sharedPackageRetained';
  assert.equal((await readPublicRemovedNativeScope(fixture.ctx, 3, fixture.result, fixture.pluginId)).retainedRegistration, true);
});

test('requires native absence for an exclusive removal', async () => {
  const fixture = removalFixture();
  fixture.plan.sharedReferences = 'none';
  fixture.plan.effects = [{ id: 'fixture-unregister', kind: 'unregister' }];
  fixture.receipt.after.package = 'absent';
  fixture.receipt.after.registration = 'absent';
  await assert.rejects(readPublicRemovedNativeScope(fixture.ctx, 3, fixture.result, fixture.pluginId), { code: 'ERR_ASSERTION' });
  fixture.rows.set(fixture.ctx.project, []);
  fixture.rows.set(fixture.ctx.neutral, []);
  assert.deepEqual(await readPublicRemovedNativeScope(fixture.ctx, 3, fixture.result, fixture.pluginId), {
    retainedRegistration: false,
    target: { level: 'native-management-state', active: false, present: false },
    neutral: { level: 'native-management-state', active: false, present: false },
  });
});

// A retained native package and a removed Codex role may coexist in one receipt.
test('binds retained marketplace bytes to this package and its separately removed contribution', () => {
  const { ctx, pluginId, plan, target, receipt } = removalFixture('codex', 'project');
  const directory = path.join(ctx.project, 'marketplace', 'plugins', ctx.pluginName);
  const role = path.join(ctx.project, '.codex', 'agents', 'fixture.toml');
  const before = { physicalKey: plan.physicalKey, directory, contributions: new Set([role]) };
  const matches = input => confirmedSharedRetention({ ...ctx, id: pluginId }, input, before);
  receipt.after.nativeIdentity.sourceLocation = directory;
  plan.effects.push({ id: 'role', kind: 'remove-owned', destination: role });
  receipt.effects.push({ id: 'role', status: 'applied', mutation: 'confirmed' });
  assert(matches(target));
  for (const change of [
    row => { row.deploymentPlans[0].sharedReferences = 'none'; },
    row => { row.deploymentReceipts[0].after.ownership = 'foreign'; },
    row => { row.deploymentReceipts[0].after.nativeIdentity.sourceLocation += '-other'; },
    row => { row.deploymentReceipts[0].after.consumers[0].activation = 'enabled'; },
    row => { row.deploymentReceipts[0].effects[0].mutation = 'possible'; },
    row => { row.deploymentReceipts[0].diagnostics = []; },
    row => { row.deploymentPlans[0].effects[1].destination = directory; },
    row => { row.deploymentReceipts[0].effects[1].status = 'skipped'; },
  ]) {
    const altered = structuredClone(target);
    change(altered);
    assert.equal(matches(altered), false);
  }
});

// Test Value Gate: the component removal harness must launch the Copilot npm
// entry through Windows Job and read a fresh inventory in both directories.
test('reads retained Copilot components through the isolated client launcher', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-copilot-removal-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { ctx, pluginId, result, receipt, target } = removalFixture('copilot', 'project', { root });
  const directory = path.join(root, 'marketplace', ctx.pluginName);
  const component = path.join(directory, 'component.md');
  const content = 'Retained component.\n';
  await fs.mkdir(ctx.project);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(component, content);
  receipt.after.nativeIdentity.sourceLocation = directory;
  target.deploymentObservations = [{ after: receipt.after }];
  Object.assign(result.data, { requirements: { roots: [] }, remainingTargets: [] });
  result.diagnostics = [];

  const clientBin = path.join(root, 'npm prefix');
  const packageRoot = path.join(clientBin, 'node_modules', ...clients.copilot.package.split('/'));
  const entry = path.join(packageRoot, 'cli.js');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: clients.copilot.package, bin: { copilot: 'cli.js' } }));
  const disabled = [{ name: ctx.pluginName, version: '0.1.1', enabled: false }];
  await fs.writeFile(entry, ['#!/usr/bin/env node',
    "require('node:assert/strict').deepEqual(process.argv.slice(2), ['plugin', 'list', '--json']);",
    "const directory = require('node:path').basename(process.cwd());",
    "if (!['project', 'neutral-removal'].includes(directory)) process.exit(2);",
    `console.log(JSON.stringify(directory === 'project' ? ${JSON.stringify(disabled)} : []));`,
  ].join('\n'), { mode: 0o755 });
  const env = await prepareEnvironment(root);
  await preparePublicClientPath({ ...ctx, root, env, clientBin, launcher: { executable: process.execPath, prefix: [entry] } });
  const report = { removals: [], updated: { id: 'another-fixture' } };
  await verifyFixtureRemoval({ ...ctx, root, env, result: async () => ({ exitCode: 0, value: result }) }, report, result,
    { id: pluginId, installed: [{ path: path.relative(root, component), kind: 'agent',
      sha256: createHash('sha256').update(content).digest('hex') }] }, new Set(), []);
  assert.deepEqual(report.removals[0].activeAfter, {
    target: { level: 'native-management-state', active: false, present: true, version: '0.1.1' },
    neutral: { level: 'native-management-state', active: false, present: false },
  });
});

test('rejects retained registrations without the successful shared removal boundary', async (t) => {
  const changes = [
    ['foreign package', ({ receipt }) => { receipt.after.ownership = 'foreign'; }],
    ['unconfirmed deactivation', ({ receipt }) => { receipt.effects[0].mutation = 'possible'; }],
    ['another activation', ({ receipt }) => { receipt.after.consumers[0].activationKey = 'other-activation'; }],
    ['active receipt', ({ receipt }) => { receipt.after.consumers[0].activation = 'enabled'; }],
    ['unregister effect', ({ plan }) => { plan.effects.push({ id: 'unregister', kind: 'unregister' }); }],
    ['package deletion effect', ({ plan }) => { plan.effects.push({ id: 'remove', kind: 'remove-owned' }); }],
    ['missing retention warning', ({ receipt }) => { receipt.diagnostics = []; }],
    ['another scope', ({ target }) => { target.scope = 'project'; }],
    ['failed command', ({ result }) => { result.status = 'partial'; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const fixture = removalFixture();
    change(fixture);
    await assert.rejects(readPublicRemovedNativeScope(fixture.ctx, 3, fixture.result, fixture.pluginId), { code: 'ERR_ASSERTION' });
  });
});

test('rejects an enabled or stale registration in either fresh scope after shared removal', async (t) => {
  for (const directory of ['project', 'neutral']) for (const state of ['enabled', 'stale']) {
    await t.test(`${directory} ${state}`, async () => {
      const fixture = removalFixture('copilot', 'project');
      const row = fixture.rows.get(fixture.ctx[directory])[0];
      if (state === 'enabled') row.enabled = true;
      else row.version = '0.1.0';
      await assert.rejects(readPublicRemovedNativeScope(fixture.ctx, 3, fixture.result, fixture.pluginId), { code: 'ERR_ASSERTION' });
    });
  }
});
