import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const enableName = 'AW_NATIVE_QUALIFICATION_MANAGED_TRACE';
const previousEnable = process.env[enableName];
delete process.env[enableName];
const { createManagedTraceRunner, createManagedPluginTraceRunner, createManagedTraceWriter, managedTraceConfiguration, managedTraceInstalled } =
  await import('./native-platform-managed-trace.mjs');
if (previousEnable !== undefined) process.env[enableName] = previousEnable;

const PUBLIC_MARKER = 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER';

function assertTracedInvocation(received, invocation) {
  assert.equal(typeof received.onSpawn, 'function');
  const { onSpawn, ...rest } = received;
  assert.deepEqual(rest, invocation);
}

// Test Value Gate: only the active fixture marker may cross the isolated script
// environment boundary; original options, backend, errors and privacy remain.
test('injects only the current public marker into each qualification script call', async () => {
  const env = { [PUBLIC_MARKER]: 'fixture-marker', PARENT_SECRET: 'private-parent' };
  const invocation = Object.freeze({ command: 'private-command', args: ['private-argument'], cwd: 'private-cwd',
    env: Object.freeze({ HOME: 'isolated-home', PATH: 'isolated-path' }), stdin: 'private-input' });
  const result = Object.freeze({ exitCode: 0, signal: null, stdout: 'private-output', stderr: 'private-stderr', timedOut: false });
  const records = [];
  let calls = 0;
  const options = Object.freeze({ timeoutMs: 1234, signal: new AbortController().signal, sensitiveValues: ['private-sensitive'],
    onSpawn({ pid }) { assert.equal(pid, 456); throw new Error('diagnostic callback failure'); } });
  const wrapped = createManagedPluginTraceRunner((received, receivedOptions) => {
    calls += 1;
    assert.deepEqual(received, { ...invocation, env: { ...invocation.env, [PUBLIC_MARKER]: env[PUBLIC_MARKER] } });
    assert.notEqual(received.env, invocation.env);
    const { onSpawn, ...rest } = receivedOptions;
    assert.deepEqual(rest, { timeoutMs: options.timeoutMs, signal: options.signal, sensitiveValues: options.sensitiveValues });
    assert.doesNotThrow(() => onSpawn({ pid: 456 }));
    return Promise.resolve(result);
  }, { env, emit: record => records.push(record) });
  assert.equal(await wrapped(invocation, options), result);
  env[PUBLIC_MARKER] = 'next-fixture-marker';
  assert.equal(await wrapped(invocation, options), result);
  assert.equal(calls, 2); assert.equal(invocation.env[PUBLIC_MARKER], undefined);
  assert.deepEqual(records.map(record => record.phase), ['start', 'spawn', 'finish', 'start', 'spawn', 'finish']);
  assert(records.every(record => record.role === 'plugin-script' && record.parentPid === process.pid && record.publicMarkerProvided));
  assert(records.filter(record => record.phase === 'spawn').every(record => record.childPid === 456));
  assert.notEqual(records[0].operationId, records[3].operationId);
  const encoded = JSON.stringify(records);
  for (const secret of ['fixture-marker', 'next-fixture-marker', 'private-', 'isolated-']) assert(!encoded.includes(secret));
  assert.throws(() => wrapped({ ...invocation, env: { [PUBLIC_MARKER]: 'other-lease' } }, options),
    /conflicting public process marker/);
  assert.equal(calls, 2);
  const unchangedOptions = Object.freeze({ timeoutMs: 456 });
  const unchanged = createManagedPluginTraceRunner((received, receivedOptions) => {
    assert.equal(received, invocation); assert.equal(receivedOptions, unchangedOptions); return Promise.resolve(result);
  }, { env: { PARENT_SECRET: 'private-parent' }, emit() { throw new Error('trace failure'); } });
  assert.equal(await unchanged(invocation, unchangedOptions), result);
});

// Exercise the public AW launcher with a real isolated renderer. The outer
// observer and the renderer must each retain their own exact launch marker.
test('supervises a Linux public AW renderer across its private environment', {
  skip: process.platform !== 'linux', timeout: 20_000,
}, async (t) => {
  const { executePublicAw, publicAwNodeLauncher } = await import('./native-platform-public-process.mjs');
  const { prepareEnvironment } = await import('./native-platform-runtime.mjs');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-component-marker-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const script = path.join(cwd, 'renderer.mjs');
  const launcher = path.join(cwd, 'launch.mjs');
  await fs.writeFile(script, `
    import { createHash } from 'node:crypto';
    const outer = process.env.AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER;
    const inner = process.env.AW_NATIVE_CLI_PROCESS_MARKER;
    if (!outer || !inner || outer === inner || process.env.PRIVATE_PARENT_VALUE !== undefined ||
        createHash('sha256').update(outer).digest('hex') !== process.argv[2]) process.exitCode = 1;
  `);
  const runtime = new URL('../../packages/cli/dist/src/utils/plugin-scripts.js', import.meta.url);
  await fs.writeFile(launcher, `
    import { createHash } from 'node:crypto';
    import { buildPluginScriptSpawnEnv, defaultPluginProcessRunner } from ${JSON.stringify(runtime.href)};
    const cwd = process.cwd();
    const env = buildPluginScriptSpawnEnv({ commandEnv: process.env, contextPath: '', tempDir: cwd,
      plugin: {name:'fixture', version:'1.0.0'}, event:'install', scope:'user', bundleRoot:cwd });
    const digest = createHash('sha256').update(process.env.AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER).digest('hex');
    const run = await defaultPluginProcessRunner.run({command:process.execPath, args:[process.argv[2], digest],
      cwd, env}, {timeoutMs:5000});
    process.exitCode = run.exitCode ?? 1;
  `);
  const env = { ...await prepareEnvironment(cwd), PRIVATE_PARENT_VALUE: 'fixture' };
  const traceFile = path.join(cwd, 'managed.jsonl');
  for (const trace of [false, true]) {
    const commandEnv = trace ? { ...env, GITHUB_ACTIONS: 'true', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
      AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'pi', AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: traceFile,
      AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([process.execPath]) } : env;
    const result = await executePublicAw(publicAwNodeLauncher(launcher, trace), [script], { cwd, env: commandEnv, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminationReason, 'complete');
  }
  const records = (await fs.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.filter(row => row.role === 'plugin-script').map(row => row.phase), ['start', 'spawn', 'finish']);
});

// Test Value Gate: a separately installed package owns its own runner singleton.
// Use a copy of the real runner and its relative imports, rather than substituting
// a runner mock or requiring the historical npm registry during harness tests.
test('forwards the outer marker to the bound historical AW runner only', {
  skip: !['linux', 'darwin'].includes(process.platform), timeout: 30_000,
}, async (t) => {
  const { prepareEnvironment } = await import('./native-platform-runtime.mjs');
  const { executePublicAw, publicAwNodeLauncher } = await import('./native-platform-public-process.mjs');
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-frozen-marker-')));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, 'frozen aw');
  const candidateRoot = new URL('../../packages/cli/', import.meta.url);
  const candidateRuntime = new URL('dist/src/utils/plugin-scripts.js', candidateRoot);
  const manifest = { name: '@lesliechan721/aw', version: '0.1.0-beta.85', type: 'module', bin: { aw: 'dist/index.js' } };
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await fs.cp(new URL('dist', candidateRoot), path.join(root, 'dist'), { recursive: true });
  await fs.symlink(fileURLToPath(new URL('node_modules', candidateRoot)), path.join(root, 'node_modules'), 'dir');
  const entry = path.join(root, 'dist/index.js');
  const script = path.join(cwd, 'renderer.mjs');
  await fs.writeFile(script, `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    const outer = process.env.AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER;
    const inner = process.env.AW_NATIVE_CLI_PROCESS_MARKER;
    assert(inner);
    if (process.argv[2] === 'unbound') assert.equal(outer, undefined);
    else {
      assert(outer && outer !== inner);
      assert.equal(createHash('sha256').update(outer).digest('hex'), process.argv[2]);
    }
    assert.equal(process.env.PRIVATE_PARENT_VALUE, undefined);
    assert.equal(process.env.AW_QUALIFICATION_FROZEN_CLI_ROOT, undefined);
  `);
  await fs.writeFile(entry, `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { defaultPluginProcessRunner as candidateRunner } from ${JSON.stringify(candidateRuntime.href)};
    import { buildPluginScriptSpawnEnv, defaultPluginProcessRunner } from './src/utils/plugin-scripts.js';
    assert.notEqual(candidateRunner, defaultPluginProcessRunner);
    const cwd = process.cwd();
    const env = buildPluginScriptSpawnEnv({ commandEnv: process.env, contextPath: '', tempDir: cwd,
      plugin: {name:'fixture', version:'1.0.0'}, event:'install', scope:'user', bundleRoot:cwd });
    const digest = createHash('sha256').update(process.env.AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER).digest('hex');
    const invocation = { command: process.execPath, args: [process.argv[2], digest], cwd, env };
    if (process.argv[3] === 'verify-candidate') {
      const unbound = await candidateRunner.run({ ...invocation, args: [process.argv[2], 'unbound'] }, {timeoutMs:5000});
      assert.equal(unbound.exitCode, 0, unbound.stderr);
    }
    const result = await defaultPluginProcessRunner.run(invocation, {timeoutMs:5000});
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(env.AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER, undefined);
    assert.throws(() => defaultPluginProcessRunner.run({ ...invocation,
      env: { ...env, AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER: 'conflicting-lease' } }, { timeoutMs: 5000 }),
      /conflicting public process marker/);
    console.log('historical renderer completed');
  `);
  const preload = new URL('./native-platform-public-plugin-marker.mjs', import.meta.url);
  preload.searchParams.set('frozenRoot', root);
  const env = { ...await prepareEnvironment(cwd), [PUBLIC_MARKER]: 'fixture-outer-marker',
    PRIVATE_PARENT_VALUE: 'private-parent', AW_QUALIFICATION_FROZEN_CLI_ROOT: root };
  const run = promisify(execFile);
  const launch = (entry) => run(process.execPath, ['--import', preload.href, entry, script, 'verify-candidate'],
    { cwd, env, timeout: 10_000 });
  assert.equal((await launch(entry)).stdout.trim(), 'historical renderer completed');

  // On the actual target platform, exercise the production launcher together
  // with the outer observation and its real cleanup gate.
  if (process.platform === 'linux') {
    const result = await executePublicAw(publicAwNodeLauncher(entry, false, root), [script],
      { cwd, env, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminationReason, 'complete');
  }

  const otherEntry = path.join(cwd, 'other.mjs');
  await fs.writeFile(otherEntry, 'console.log("should not launch")');
  assert.throws(() => publicAwNodeLauncher(otherEntry, false, root), /Historical AW entry does not match/);
  await assert.rejects(launch(otherEntry), error => error.stdout === '' && /Historical AW entry does not match/.test(error.stderr));
  await assert.rejects(run(process.execPath, ['--import', preload.href, '-e', 'console.log("should not launch")'],
    { cwd, env, timeout: 10_000 }), error => error.stdout === '' && /Historical AW preload requires its package entry/.test(error.stderr));
  for (const [invalid, expected] of [
    [{ ...manifest, name: '@example/aw' }, /@lesliechan721\/aw/],
    [{ ...manifest, version: '0.1.0-beta.86' }, /0\.1\.0-beta\.85/],
    [{ ...manifest, bin: { aw: '../other.mjs' } }, /Unexpected historical AW entry/],
  ]) {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(invalid));
    await assert.rejects(launch(entry), error => error.stdout === '' && expected.test(error.stderr));
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  const runner = path.join(root, 'dist/src/utils/plugin-scripts.js');
  const escapedRunner = path.join(cwd, 'outside-runner.js');
  await fs.rename(runner, escapedRunner);
  await fs.symlink(escapedRunner, runner);
  await assert.rejects(launch(entry), error => error.stdout === '' && /Historical AW package file is not contained/.test(error.stderr));
});

test('retains plugin errors and projects bounded snapshot timing without secrets', async () => {
  const diagnostics = Array.from({ length: 5 }, (_, index) => ({
    rootPid: 456, reason: 'marker-lookup-failed', stage: 'observation', markerLookupAttempts: 2,
    snapshotStartedAt: 100, snapshotDeadline: 2100,
    queries: [{ kind: 'marker', startedAt: 100, deadline: 2100, settledAt: 2100, callbackState: 'pending', completion: 'deadline' }],
    environment: 'private-environment', marker: 'private-marker', index,
  }));
  const error = Object.assign(new Error('private-error'), { stderr: 'private-stderr', processTreeDiagnostics: diagnostics,
    operationDiagnostic: { code: 'pluginProcessCleanupFailed', safeMessage: 'private-message' } });
  for (const synchronous of [false, true]) {
    const records = [];
    const wrapped = createManagedPluginTraceRunner(() => {
      if (synchronous) throw error;
      return Promise.reject(error);
    }, { env: { [PUBLIC_MARKER]: 'private-marker' }, emit: record => records.push(record) });
    if (synchronous) assert.throws(() => wrapped({ env: {} }, { timeoutMs: 1234 }), received => received === error);
    else await assert.rejects(wrapped({ env: {} }, { timeoutMs: 1234 }), received => received === error);
    const finish = records.at(-1);
    assert.equal(finish.failureCategory, 'cleanup-unconfirmed');
    assert.equal(finish.processTreeDiagnostics.length, 2);
    assert.deepEqual(finish.processTreeDiagnostics[0].queries, diagnostics[0].queries);
    assert.equal(finish.processTreeDiagnostics[0].snapshotDeadline, 2100);
    assert(!JSON.stringify(records).includes('private-'));
  }
  const wrapped = createManagedPluginTraceRunner(() => Promise.reject(error),
    { env: { [PUBLIC_MARKER]: 'private-marker' }, emit() { throw new Error('trace failure'); } });
  await assert.rejects(wrapped({ env: {} }, { timeoutMs: 1234 }), received => received === error);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-managed-trace-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'client-entry');
  const other = path.join(root, 'other-entry');
  await fs.writeFile(entry, 'fixture'); await fs.writeFile(other, 'fixture');
  await fs.mkdir(path.join(root, 'sub'));
  return { root, entry, other, alias: `${root}${path.sep}sub${path.sep}..${path.sep}client-entry` };
}

// Test Value Gate: time only the selected system executable while retaining the
// original Promise, errors, budget and nonselected-call privacy boundary.
test('samples completed Windows Codex PowerShell queries in the eight unmatched rows', async (t) => {
  const { root, entry, other } = await fixture(t);
  const system = path.join(root, 'system');
  const query = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.mkdir(path.dirname(query), { recursive: true }); await fs.writeFile(query, 'query-fixture');
  const invocation = Object.freeze({ command: query, args: ['private-encoded-command'], env: { private: 'not-recorded' }, timeoutMs: 1234 });
  for (const outcome of ['success', 'nonzero', 'reject', 'sync-throw']) {
    const records = []; const result = { exitCode: outcome === 'nonzero' ? 3 : 0, stdout: 'not-recorded', stderr: 'not-recorded' };
    const error = new Error('not-recorded');
    let settle; let reject;
    const original = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    let calls = 0;
    const wrapped = createManagedTraceRunner((received) => {
      calls += 1; assert.equal(received, invocation);
      if (outcome === 'sync-throw') throw error;
      return original;
    }, { entries: [entry], client: 'codex', platform: 'win32', env: { SystemRoot: system }, emit: record => records.push(record) });
    if (outcome === 'sync-throw') assert.throws(() => wrapped(invocation), received => received === error);
    else {
      const returned = wrapped(invocation); assert.equal(returned, original); assert.equal(records.length, 0);
      if (outcome === 'reject') { reject(error); await assert.rejects(returned, received => received === error); }
      else { settle(result); assert.equal(await returned, result); }
    }
    assert.equal(calls, 1); assert.equal(records.length, 1);
    const record = records[0]; assert.equal(record.phase, 'unmatched'); assert.equal(record.commandRole, 'windows-system-powershell');
    assert.equal(record.threw, ['reject','sync-throw'].includes(outcome));
    assert.equal(record.exitCode, ['reject','sync-throw'].includes(outcome) ? null : result.exitCode);
    assert(record.elapsedMs >= 0); assert.match(record.startTime, /^\d{4}-/u); assert.match(record.finishTime, /^\d{4}-/u);
    assert(!JSON.stringify(record).includes('not-recorded')); assert(!JSON.stringify(record).includes('private-encoded-command'));
  }
  for (const [client, platform, systemRoot, command, selected] of [
    ['codex','win32',system,query,true], ['pi','win32',system,query,false], ['codex','linux',system,query,false],
    ['codex','win32',path.join(root,'missing'),query,false], ['codex','win32',system,other,false],
  ]) {
    const records=[]; const original=Promise.resolve({exitCode:0});
    const wrapped=createManagedTraceRunner(() => original, { entries:[entry],client,platform,env:{SystemRoot:systemRoot},emit:record=>records.push(record) });
    for(let i=0;i<12;i++) { assert.equal(wrapped({command,args:[]}),original); await original; }
    assert.equal(records.length,8); assert.equal(records.every(record=>record.commandRole==='windows-system-powershell'),selected);
    if(!selected) assert(records.every(record=>Object.entries(record).every(([key,value])=>key==='phase'||typeof value==='boolean')));
  }
  const records = [];
  const wrapped = createManagedTraceRunner(() => Promise.resolve({ exitCode: 0 }), {
    entries: [entry], client: 'codex', platform: 'win32',
    env: { SystemRoot: system, AW_NATIVE_QUALIFICATION_CODEX_SHARED_TIMING: '1' }, emit: record => records.push(record),
  });
  for (let i = 0; i < 66; i++) {
    await wrapped({ command: other, args: [] });
    await wrapped(invocation);
  }
  assert.equal(records.filter(row => row.commandRole === 'windows-system-powershell').length, 64);
  assert.equal(records.length, 72);
  assert(!JSON.stringify(records).includes('private-encoded-command'));
});

// The component trace file must never receive invocation or result payloads.
test('records only completed Codex component command facts and preserves the original results', async (t) => {
  const { root, entry, other } = await fixture(t);
  const system = path.join(root, 'private-system');
  const command = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.writeFile(command, 'fixture');
  const shellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', 'private-script'];
  const records = [];
  const success = Object.freeze({ exitCode: 0, stdout: 'private-output', stderr: 'private-stderr' });
  const timeout = Object.assign(new Error('private-error'), { name: 'NativeCliError', reason: 'timeout', exitCode: 124,
    cleanupError: new Error('private-cleanup-error'), operationDiagnostic: { code: 'nativeCliTimedOut', safeMessage: 'private-message' } });
  const original = Promise.resolve(success);
  const originalError = Promise.reject(timeout);
  let calls = 0;
  const wrapped = createManagedTraceRunner(invocation => {
    calls++;
    assert.equal(invocation.env.SECRET, 'private-environment');
    return invocation.command === command ? originalError : original;
  }, { entries: [entry], client: 'codex', platform: 'win32', env: { SystemRoot: system },
    mode: 'codex-component-install', emit: record => records.push(record) });
  const env = { SECRET: 'private-environment' };
  assert.equal(wrapped({ command: entry, args: ['--version'], env }), original);
  await original;
  assert.equal(wrapped({ command: entry, args: ['plugin', 'list', '--marketplace', 'private-market', '--json'], env }), original);
  await original;
  assert.equal(wrapped({ command: entry, args: ['plugin', 'marketplace', 'list', '--json'], env }), original);
  await original;
  assert.equal(wrapped({ command: command, args: shellArgs, env }), originalError);
  await assert.rejects(originalError, error => error === timeout);
  assert.equal(wrapped({ command: other, args: ['--version'], env }), original);
  assert.equal(wrapped({ command: entry, args: ['plugin', 'add', 'private-selector'], env }), original);
  await original;
  assert.equal(calls, 6);
  assert.deepEqual(records.map(({ elapsedMs, ...record }) => record), [
    ...['codex-version', 'codex-plugin-list', 'codex-marketplace-list'].map(category => ({ phase: 'finish', category,
      threw: false, exitCode: 0, timedOut: false, cleanupUnconfirmed: false })),
    { phase: 'finish', category: 'windows-system-powershell', threw: true, exitCode: 124, timedOut: true,
      cleanupUnconfirmed: true, reason: 'timeout', errorCode: 'nativeCliTimedOut' },
  ]);
  assert(records.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0));
  assert(!JSON.stringify(records).includes('private-'));
  for (let index = 0; index < 70; index++) await assert.rejects(wrapped({ command, args: shellArgs, env }));
  assert.equal(records.filter(row => row.category === 'windows-system-powershell').length, 64);
});

// These two diagnostics must capture the original operations and conclusions
// at the runner boundary without forwarding any private invocation or output.
test('projects Windows Grok probes and Darwin Claude removal cleanup from the original native runner', async (t) => {
  const { entry, other } = await fixture(t);
  const sentinel = 'private-native-input';
  const nativeError = (message, reason = 'exit') => Object.assign(new Error(sentinel), { name: 'NativeCliError',
    cleanupError: message ? new Error(message) : undefined, reason, exitCode: reason === 'timeout' ? 124 : 1,
    stdout: sentinel, stderr: sentinel, invocation: { env: { SECRET: sentinel } } });
  const markerFailure = nativeError(`Process tree cleanup unconfirmed: POSIX process marker lookup failed (stage=termination-start, attempts=1, reason=callback-error, code=${sentinel}).`);
  const identityFailure = nativeError('Process tree cleanup unconfirmed: POSIX process identity lookup failed.');
  const cleanupTimeout = nativeError('Native CLI cleanup unconfirmed: cleanup timed out.');
  const unsafeFailure = nativeError(`Native CLI cleanup unconfirmed: could not signal process group ${sentinel}.`);
  const timeout = nativeError(undefined, 'timeout');
  const success = { exitCode: 0, stdout: sentinel, stderr: sentinel };
  for (const { client, platform, mode, calls } of [
    { client: 'grok', platform: 'win32', mode: 'grok-component-discovery', calls: [
      [process.execPath, [entry, '--version'], timeout, 'grok-version'],
      [process.execPath, [entry, 'plugin', '--help'], success, 'grok-plugin-help'],
      [process.execPath, [entry, 'plugin', 'list', '--help'], success, 'grok-plugin-list-help'],
      [entry, ['--version'], success, 'grok-version'],
      [process.execPath, [entry, 'plugin', 'list', '--json'], success],
      [other, [entry, '--version'], success],
      [other, ['--version'], success],
    ] },
    { client: 'claude', platform: 'darwin', mode: 'claude-component-remove', calls: [
      [entry, ['--version'], success, 'claude-version'],
      [entry, ['plugin', 'marketplace', 'list', '--json'], success, 'claude-marketplace-list'],
      [entry, ['plugin', 'disable', sentinel, '--scope', 'local'], markerFailure, 'claude-plugin-disable', 'marker-lookup'],
      [entry, ['plugin', 'list', '--json'], identityFailure, 'claude-plugin-list', 'identity-lookup'],
      [entry, ['plugin', 'uninstall', sentinel, '--scope', 'local'], cleanupTimeout, 'claude-plugin-uninstall', 'cleanup-deadline'],
      ...[
        ['could not signal process group SIGTERM.', 'process-group-sigterm'],
        ['could not signal process group SIGKILL.', 'process-group-sigkill'],
        ['could not verify process group exit.', 'process-group-exit-check'],
        ['child PID is unavailable.', 'child-pid-unavailable'],
      ].map(([message, kind]) => [entry, ['plugin', 'list', '--json'], nativeError(`Native CLI cleanup unconfirmed: ${message}`),
        'claude-plugin-list', kind]),
      [entry, ['plugin', 'list', '--json'], unsafeFailure, 'claude-plugin-list'],
      [entry, ['plugin', 'disable', sentinel, '--scope', 'user'], success],
    ] },
  ]) {
    const records = [];
    let expectedInvocation;
    let original;
    const wrapped = createManagedTraceRunner(invocation => {
      assert.equal(invocation, expectedInvocation);
      return original;
    }, { entries: [entry], client, platform, mode, emit: record => records.push(record) });
    for (const [command, args, value, category, cleanupKind] of calls) {
      expectedInvocation = { command, args, env: { SECRET: sentinel } };
      original = value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      const before = records.length;
      assert.equal(wrapped(expectedInvocation), original);
      if (value instanceof Error) await assert.rejects(original, error => error === value);
      else assert.equal(await original, value);
      if (!category) assert.equal(records.length, before);
      else {
        assert.equal(records.length, before + 1);
        const record = records.at(-1);
        assert.equal(record.category, category);
        assert.equal(record.exitCode, value.exitCode);
        assert.equal(record.timedOut, value === timeout);
        assert.equal(record.cleanupUnconfirmed, Boolean(value.cleanupError));
        assert.equal(record.cleanupKind, cleanupKind);
      }
    }
    assert(!JSON.stringify(records).includes(sentinel));
  }
});

// Test Value Gate: private diagnostics retain the invocation fields, including
// stdin exchange and cancellation, and return/reject the original native objects.
test('preserves native invocation fields and returns the same successful or nonzero result', async (t) => {
  const { entry } = await fixture(t);
  const input = Object.freeze({ initial: 'private input', onStdout() { return { end: true }; } });
  const invocation = Object.freeze({ command: entry, args: Object.freeze(['install', 'fixture']), input,
    env: Object.freeze({ [PUBLIC_MARKER]: 'public-value' }), signal: new AbortController().signal, timeoutMs: 1234 });
  for (const exitCode of [0, 7]) {
    const result = Object.freeze({ exitCode, stdout: 'private output', stderr: 'native stderr' });
    const records = [];
    let calls = 0;
    const wrapped = createManagedTraceRunner(async (received) => {
      calls += 1; assertTracedInvocation(received, invocation); assert.equal(received.input, input); return result;
    }, { entries: [entry], client: 'pi', env: { [PUBLIC_MARKER]: 'public-value' }, emit: (record) => records.push(record) });
    assert.equal(await wrapped(invocation), result); assert.equal(calls, 1);
    assert.deepEqual(records.map((record) => record.phase), ['start', 'finish']);
    assert.equal(records[0].parentPid, process.pid); assert.equal(records[0].operationId, records[1].operationId);
    assert.equal(records[0].startTime, records[1].startTime); assert.match(records[1].finishTime, /^\d{4}-/u);
    assert.equal(records[0].publicMarkerProvided, true); assert.equal(records[1].exitCode, exitCode);
    assert.equal(records[1].threw, false); assert(!('stdout' in records[1]));
    assert.equal('stderr' in records[1], exitCode !== 0);
    if (exitCode !== 0) assert.equal(records[1].stderr, result.stderr);
    assert(!('childPid' in records[0])); assert(!('nativeMarkerPresent' in records[0]));
    assert(!('env' in records[0])); assert(!('input' in records[0]));
  }
});

// Test Value Gate: the logical native operation must bind its actual spawn PID
// while keeping diagnostic callbacks separate from execution and marker facts.
test('associates a native spawn with one operation and preserves a failing callback', async (t) => {
  const { entry } = await fixture(t);
  const records = [];
  let callbacks = 0;
  const result = Object.freeze({ exitCode: 0, stdout: '', stderr: '' });
  const wrapped = createManagedTraceRunner(invocation => {
    assert.doesNotThrow(() => invocation.onSpawn({ pid: 123 }));
    return Promise.resolve(result);
  }, { entries: [entry], client: 'codex', env: {}, emit: record => records.push(record) });
  assert.equal(await wrapped({ command: entry, args: [], onSpawn({ pid }) {
    callbacks += 1; assert.equal(pid, 123); throw new Error('diagnostic callback failed');
  } }), result);
  assert.equal(callbacks, 1);
  assert.deepEqual(records.map(record => record.phase), ['start', 'spawn', 'finish']);
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(records[1].operationId, records[2].operationId);
  assert.equal(records[1].childPid, 123); assert.equal(records[2].childPid, 123);
  assert.equal(records[0].publicMarkerProvided, false);
});

// Test Value Gate: repeated real queries must leave room for the later native
// writes or the hosted report would lack evidence of which clients applied them.
test('retains both native installs after a query-heavy batch', async (t) => {
  const { root, entry: claude, other: pi } = await fixture(t);
  const file = path.join(root, 'mixed.jsonl');
  const writer = createManagedTraceWriter(file);
  let pid = 10;
  const runner = createManagedTraceRunner(async (invocation) => {
    invocation.onSpawn?.({ pid: ++pid });
    return { exitCode: 0 };
  }, { entries: [claude, pi], client: 'claude-pi', emit: writer.emit });
  try {
    for (let index = 0; index < 100; index++) {
      await runner({ command: claude, args: ['plugin', 'list', '--json'] });
      await runner({ command: process.execPath, args: [pi, 'list'] });
    }
    await runner({ command: claude, args: ['plugin', 'install', 'fixture'] });
    await runner({ command: process.execPath, args: [pi, 'install', '/fixture'] });
  } finally { writer.close(); }
  const records = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const installs = records.filter(record => record.nativeOperation === 'install');
  assert.equal(installs.length, 6);
  for (const client of ['claude', 'pi']) {
    const spawn = installs.find(record => record.nativeClient === client && record.phase === 'spawn');
    const finish = installs.find(record => record.operationId === spawn?.operationId && record.phase === 'finish');
    assert(Number.isFinite(Date.parse(spawn?.spawnTime)));
    assert.equal(finish?.exitCode, 0);
    assert(records.some(record => record.nativeClient === client && record.phase === 'spawn' && record.nativeOperation === 'list'));
  }
});

test('throws the original error and captures safe exit, timeout, and cleanup metadata only', async (t) => {
  const { entry } = await fixture(t);
  const invocation = { command: entry, args: ['install', 'fixture'] };
  for (const reason of ['exit', 'timeout', 'aborted']) {
    const cleanupError = new Error();
    Object.defineProperty(cleanupError, 'message', { get() { throw new Error('cleanup message must not be read'); } });
    const error = Object.assign(new Error(), { exitCode: 9, stderr: 'native failure', reason,
      cause: { code: 'ENOENT' }, cleanupError,
      operationDiagnostic: { code: 'nativeCliFailed', safeMessage: 'The platform CLI exited unsuccessfully.' } });
    Object.defineProperty(error, 'message', { get() { throw new Error('error message must not be read'); } });
    const records = [];
    const wrapped = createManagedTraceRunner(async (received) => { assertTracedInvocation(received, invocation); throw error; },
      { entries: [entry], client: 'codex', env: {}, emit: (record) => records.push(record) });
    await assert.rejects(wrapped(invocation), (received) => received === error);
    const finish = records[1];
    assert.equal(finish.threw, true); assert.equal(finish.exitCode, 9); assert.equal(finish.reason, reason);
    assert.deepEqual(finish.cause, { code: 'ENOENT' }); assert.deepEqual(finish.operationDiagnostic, error.operationDiagnostic);
    assert.equal(finish.cleanupError, true); assert.equal(finish.stderr, 'native failure'); assert(!('stdout' in finish));
    assert(!('message' in finish));
  }
});

test('matches only real whitelist files in command or args[0] and directly delegates other promises', async (t) => {
  const { entry, other, alias } = await fixture(t);
  const records = [];
  const result = { exitCode: 0, stdout: '', stderr: '' };
  const pending = Promise.resolve(result);
  let received;
  const wrapped = createManagedTraceRunner((invocation) => { received = invocation; return pending; },
    { entries: [entry], client: 'pi', env: {}, emit: (record) => records.push(record) });
  for (const { invocation, matched } of [
    { invocation: { command: entry, args: [] }, matched: true },
    { invocation: { command: alias, args: [] }, matched: true },
    { invocation: { command: process.execPath, args: [entry, '--version'] }, matched: true },
    { invocation: { command: other, args: [] }, matched: false },
    { invocation: { command: process.execPath, args: ['unrelated', entry] }, matched: false },
    { invocation: { command: entry, args: [1] }, matched: false },
    { invocation: { command: entry }, matched: false },
    ...(process.platform === 'win32' ? [{ invocation: { command: entry.toUpperCase(), args: [] }, matched: true }] : []),
  ]) {
    const count = records.length;
    const returned = wrapped(invocation);
    if (!matched) assert.equal(returned, pending);
    assert.equal(await returned, result);
    if (matched) assertTracedInvocation(received, invocation);
    else assert.equal(received, invocation);
    assert.equal(records.length - count, matched ? 2 : 1);
    if (!matched) {
      assert.equal(records.at(-1).phase, 'unmatched');
      assert(Object.entries(records.at(-1)).every(([key, value]) => key === 'phase' || typeof value === 'boolean'));
    }
  }
});

// Test Value Gate: missed selection must be distinguishable from an unused
// runner, without recording nonselected invocation data or changing promises.
test('bounds unmatched diagnostics to eight fixed metadata records', async (t) => {
  const { entry, other } = await fixture(t);
  const records = [];
  const pending = Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  const wrapped = createManagedTraceRunner(() => pending,
    { entries: [entry], client: 'codex', env: {}, emit: (record) => records.push(record) });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(wrapped({ command: other, args: ['private-argument'], env: { TOKEN: 'secret' } }), pending);
  }
  assert.equal(records.length, 8);
  assert.deepEqual(records[0], { phase: 'unmatched', commandAbsolute: true, commandResolved: true,
    firstArgumentAbsolute: false, firstArgumentResolved: false, commandCaseInsensitiveMatch: false,
    argumentCaseInsensitiveMatch: false, argumentsAreStrings: true });
  assert(!JSON.stringify(records).includes(other)); assert(!JSON.stringify(records).includes('secret'));
});

// Test Value Gate: retained logical argv and failure details must not expose
// markers, including UUIDs generated inside the native backend after this seam.
test('removes environment markers and unknown UUIDs before truncation without changing native data', async (t) => {
  const { entry } = await fixture(t);
  const hostName = 'AW_MANAGED_TRACE_TEST_MARKER';
  const previousHost = process.env[hostName];
  process.env[hostName] = 'host-secret-value';
  t.after(() => { if (previousHost === undefined) delete process.env[hostName]; else process.env[hostName] = previousHost; });
  const secrets = ['host-secret-value', 'preload-secret-value', 'initial-secret-value', 'option-secret-value',
    '12345678-abcd-4abc-9abc-0123456789ab', 'ABCDEF12-3456-7890-ABCD-1234567890AB'];
  const args = [secrets.join('/'), 'a'.repeat(1100), ...Array.from({ length: 20 }, (_, index) => `arg${index}`)];
  const invocation = Object.freeze({ command: entry, args: Object.freeze(args),
    env: Object.freeze({ [PUBLIC_MARKER]: secrets[1], some_marker: secrets[3] }) });
  const error = Object.freeze({ exitCode: 1, reason: `exit-${secrets[4]}`, stderr: `${secrets.join('/')}\n${'e'.repeat(5000)}`,
    cause: { code: `CUSTOM-${secrets[2]}` }, operationDiagnostic: { code: 'nativeCliFailed', safeMessage: secrets.join('/') } });
  const records = [];
  const wrapped = createManagedTraceRunner(async (received) => { assertTracedInvocation(received, invocation); throw error; },
    { entries: [entry], client: 'codex', env: { [PUBLIC_MARKER]: secrets[1], INITIAL_MARKER: secrets[2] },
      emit: (record) => records.push(record) });
  await assert.rejects(wrapped(invocation), (received) => received === error);
  assert.equal(records[0].args.length, 16); assert.equal(records[0].args[1].length, 1024);
  assert.equal(records[1].stderr.length, 4000); assert.equal(invocation.args.length, 22);
  const encoded = JSON.stringify(records);
  for (const secret of secrets) assert(!encoded.includes(secret));
});

test('captures bounded successful stdout only for exact Codex marketplace list', async (t) => {
  const { entry } = await fixture(t);
  for (const { client, command, args, capture, exitCode = 0 } of [
    { client: 'codex', command: entry, args: ['plugin', 'marketplace', 'list', '--json'], capture: true },
    { client: 'codex', command: process.execPath, args: [entry, 'plugin', 'marketplace', 'list', '--json'], capture: true },
    { client: 'codex', command: entry, args: ['plugin', 'list', '--json'], capture: false },
    { client: 'pi', command: entry, args: ['plugin', 'marketplace', 'list', '--json'], capture: false },
    { client: 'codex', command: entry, args: ['plugin', 'marketplace', 'list', '--json'], capture: false, exitCode: 7 },
  ]) {
    const records = [];
    const result = Object.freeze({ exitCode, stdout: `registry-output-secret${'r'.repeat(5000)}`, stderr: 'native stderr' });
    const wrapped = createManagedTraceRunner(async () => result,
      { entries: [entry], client, env: { REGISTRY_MARKER: 'registry-output-secret' }, emit: (record) => records.push(record) });
    assert.equal(await wrapped({ command, args }), result);
    assert.equal('stdout' in records[1], capture);
    if (capture) assert.equal(records[1].stdout, 'r'.repeat(4000));
    assert.equal('stderr' in records[1], exitCode !== 0); assert.equal(records[0].publicMarkerProvided, false);
  }
});

test('keeps successful results and original throws when emit fails', async (t) => {
  const { entry } = await fixture(t);
  const invocation = { command: entry, args: [] };
  const result = Object.freeze({ exitCode: 0, stdout: 'original', stderr: '' });
  const error = new Error('original failure');
  for (const thrown of [false, true]) {
    let calls = 0;
    const wrapped = createManagedTraceRunner((received) => {
      calls += 1; assertTracedInvocation(received, invocation);
      if (thrown) throw error;
      return Promise.resolve(result);
    }, { entries: [entry], client: 'pi', env: {}, emit() { throw new Error('emit failure'); } });
    if (thrown) await assert.rejects(wrapped(invocation), (received) => received === error);
    else assert.equal(await wrapped(invocation), result);
    assert.equal(calls, 1);
  }
});

// Test Value Gate: trace IO failure and exhaustion cannot overwrite existing
// files, exceed the private JSONL budget, or replace a real runner result.
test('owns a new private JSONL file and enforces record and byte limits', async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'count.jsonl');
  const writer = createManagedTraceWriter(file); t.after(writer.close);
  for (let index = 0; index < 260; index += 1) assert.equal(writer.emit({ index }), index < 256);
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 256); assert.equal(lines.at(-1).index, 255);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const byteFile = path.join(root, 'bytes.jsonl');
  const byteWriter = createManagedTraceWriter(byteFile); t.after(byteWriter.close);
  assert.equal(byteWriter.emit({ text: 'x'.repeat(256 * 1024) }), false);
  assert.equal(byteWriter.emit({ text: '界'.repeat(30000) }), true);
  assert.equal(byteWriter.emit({ text: '界'.repeat(30000) }), true);
  assert.equal(byteWriter.emit({ text: '界'.repeat(30000) }), false);
  const bytes = await fs.readFile(byteFile); assert(bytes.length <= 256 * 1024);
  assert.equal(bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line)).length, 2);
});

test('leaves existing content unchanged and keeps native results when the writer fails', async (t) => {
  const { root, entry } = await fixture(t);
  const existing = path.join(root, 'existing.jsonl'); await fs.writeFile(existing, 'foreign-content');
  const writer = createManagedTraceWriter(existing); t.after(writer.close);
  assert.equal(writer.emit({ phase: 'start' }), false); assert.equal(await fs.readFile(existing, 'utf8'), 'foreign-content');
  const unavailable = createManagedTraceWriter(path.join(root, 'missing-directory', 'trace.jsonl')); t.after(unavailable.close);
  const result = Object.freeze({ exitCode: 0, stdout: 'original', stderr: '' });
  const wrapped = createManagedTraceRunner(async () => result,
    { entries: [entry], client: 'pi', env: {}, emit: unavailable.emit });
  assert.equal(await wrapped({ command: entry, args: [] }), result);
});

test('does not install by default and requires every hosted guard', async (t) => {
  assert.equal(managedTraceInstalled, false); assert.equal(managedTraceConfiguration({}), undefined);
  const { root, entry } = await fixture(t);
  const valid = { GITHUB_ACTIONS: 'true', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
    AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'codex',
    AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([entry]),
    AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: path.join(root, 'trace.jsonl') };
  assert.deepEqual(managedTraceConfiguration(valid, 'linux'), { entries: [entry], client: 'codex', file: valid.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE });
  assert.equal(managedTraceConfiguration({ ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'pi' }, 'win32').client, 'pi');
  const antigravity = { ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'antigravity' };
  assert.equal(managedTraceConfiguration(antigravity, 'win32').client, 'antigravity');
  assert.equal(managedTraceConfiguration(antigravity, 'linux'), undefined);
  const grok = { ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'grok' };
  assert.equal(managedTraceConfiguration(grok, 'win32'), undefined);
  for (const [client, mode, host, otherHost] of [
    ['grok', 'grok-component-discovery', 'win32', 'darwin'],
    ['claude', 'claude-component-remove', 'darwin', 'win32'],
  ]) {
    const compact = { ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: client, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_MODE: mode };
    assert.equal(managedTraceConfiguration(compact, host).mode, mode);
    assert.equal(managedTraceConfiguration(compact, otherHost), undefined);
  }
  for (const name of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[name]; assert.equal(managedTraceConfiguration(missing, 'linux'), undefined);
  }
  for (const change of [
    { GITHUB_ACTIONS: 'false' }, { AW_NATIVE_QUALIFICATION_MANAGED_TRACE: 'true' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: 'grok' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: 'invalid-json' }, { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: '[]' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: '["relative-entry"]' },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([root]) },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([path.join(root, 'missing')]) },
    { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: 'relative-trace.jsonl' },
  ]) assert.equal(managedTraceConfiguration({ ...valid, ...change }, 'linux'), undefined);
  for (const client of ['claude', 'copilot']) {
    assert.equal(managedTraceConfiguration({ ...valid, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: client }, 'darwin').client, client);
  }
  assert.equal(managedTraceConfiguration(valid, 'freebsd'), undefined);
});

// A malformed trace must not prevent the original qualification result from being reported.
test('reads only ordinary, bounded managed trace files', async (t) => {
  const { readManagedTrace } = await import('./native-platform-runtime.mjs');
  const { root } = await fixture(t);
  const file = path.join(root, 'trace.jsonl');
  const record = { phase: 'finish' };
  const line = JSON.stringify(record) + '\n';
  assert.equal(await readManagedTrace(undefined), undefined);
  assert.deepEqual(await readManagedTrace(file), { state: 'not-created', records: [] });
  assert.deepEqual(await readManagedTrace(root), { state: 'unavailable', records: [] });

  await fs.writeFile(file, '');
  assert.deepEqual(await readManagedTrace(file), { state: 'captured', records: [] });
  await fs.writeFile(file, line + '{');
  assert.deepEqual(await readManagedTrace(file), { state: 'partial-or-invalid-jsonl', records: [record] });
  await fs.writeFile(file, line.repeat(257));
  assert.deepEqual(await readManagedTrace(file), { state: 'over-limit', records: [] });
  await fs.writeFile(file, ' '.repeat(256 * 1024 - line.length) + line);
  assert.deepEqual(await readManagedTrace(file), { state: 'captured', records: [record] });
  await fs.appendFile(file, ' ');
  assert.deepEqual(await readManagedTrace(file), { state: 'over-limit', records: [] });

  if (process.platform !== 'win32') {
    await fs.writeFile(file, line);
    const link = path.join(root, 'linked.jsonl');
    await fs.symlink(file, link);
    assert.deepEqual(await readManagedTrace(link), { state: 'unavailable', records: [] });

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const pipe = path.join(root, 'pipe.jsonl');
    await run('mkfifo', [pipe]);
    const runtime = new URL('./native-platform-runtime.mjs', import.meta.url).href;
    const probe = `import { readManagedTrace } from ${JSON.stringify(runtime)};
      process.stdout.write(JSON.stringify(await readManagedTrace(process.argv[1])));`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', probe, pipe], { timeout: 5000 });
    assert.deepEqual(JSON.parse(stdout), { state: 'unavailable', records: [] });
  }
});
