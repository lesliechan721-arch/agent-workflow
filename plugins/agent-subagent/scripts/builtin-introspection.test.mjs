import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';
import { resolveProbeExecutable, runProbeProcess } from '../commands/scripts/introspection/process.mjs';

const sourceScripts = guideRuntimeScripts(new URL('./', import.meta.url));
const packageModules = fileURLToPath(new URL('./node_modules', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-builtin-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const codexHome = path.join(root, '.codex');
  await fs.mkdir(bin);
  await fs.mkdir(codexHome);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^path$|^AW_(?:NATIVE|COMMAND|PLUGIN|SUBAGENT)_/i.test(name)));
  Object.assign(env, { PATH: bin, CODEX_HOME: codexHome, FIXTURE_ROOT: root });
  return { root, bin, codexHome, env };
}

async function stageRuntime(root) {
  if (process.env.AW_PLUGIN_EVENT === 'test') return sourceScripts;
  const scripts = path.join(root, 'scripts');
  await fs.cp(sourceScripts, scripts, { recursive: true });
  const profile = path.join(scripts, 'adapters/codex-profile.mjs');
  const bundle = await build({
    entryPoints: [path.join(sourceScripts, 'adapters/codex-profile.mjs')], nodePaths: [packageModules], bundle: true, platform: 'node',
    target: 'node22', format: 'esm', write: false, logLevel: 'silent',
  });
  await fs.writeFile(profile, bundle.outputFiles[0].contents);
  return scripts;
}

const verifiableShim = (target) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
].join('\r\n');

async function installShim(bin, name, packageName, body) {
  const directory = path.join(bin, 'node_modules', packageName);
  await fs.mkdir(directory, { recursive: true });
  const entry = path.join(directory, 'fixture.cjs');
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: packageName, bin: { [name]: 'fixture.cjs' } }));
  await fs.writeFile(entry, body);
  const shim = path.join(bin, `${name}.cmd`);
  await fs.writeFile(shim, verifiableShim(`node_modules\\${packageName.replaceAll('/', '\\')}\\fixture.cjs`));
  return { shim, entry, directory };
}

async function installCli(bin, name, packageName, body) {
  if (process.platform === 'win32') await installShim(bin, name, packageName, body);
  else await fs.writeFile(path.join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}

async function runAdapter(fixture, adapter, overrides, { scripts = sourceScripts, raw } = {}) {
  const invocation = { command: process.execPath, args: [path.join(scripts, 'adapters', `${adapter}-v6.mjs`)] };
  const request = { protocolVersion: 6, type: 'introspect', executor: 'fixture', workspace: fixture.root, args: [], ...overrides };
  const input = raw?.(request) ?? JSON.stringify(request) + '\n';
  return runProbeProcess(invocation, { cwd: fixture.root, env: fixture.env, input });
}

function startClaudeAdapter(t, state, { injectStreamFaults = false, collectOutput = true } = {}) {
  const preload = `
    process.channel.unref();
    process.stdin.on('newListener', (event) => {
      if (event === 'data') queueMicrotask(() => process.send('ready'));
    });
    process.on('message', (stream) => process[stream].emit('error', new Error('fixture stream failure')));
  `;
  const args = injectStreamFaults ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : [];
  const child = spawn(process.execPath, [...args, path.join(sourceScripts, 'adapters/claude-code-v6.mjs')], {
    cwd: state.root, env: state.env, stdio: ['pipe', 'pipe', 'pipe', ...(injectStreamFaults ? ['ipc'] : [])],
  });
  let stdout = '', stderr = '';
  if (collectOutput) child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  const exit = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
  const request = { protocolVersion: 6, type: 'introspect', executor: 'fixture', workspace: state.root, args: [] };
  return { child, exit, request };
}

// Test Value Gate: a worker can end or interrupt the connection before sending
// its first frame. The adapter must release stdin and terminate.
test('adapter exits on EOF or interrupted input before the first frame', { timeout: 6000 }, async (t) => {
  const state = await fixture(t);
  const eof = startClaudeAdapter(t, state);
  eof.child.stdin.end();
  assert.match((await eof.exit).stderr, /^protocolInvalid:/);
  if (process.platform === 'win32') return;
  const interrupted = startClaudeAdapter(t, state, { injectStreamFaults: true });
  const [ready] = await once(interrupted.child, 'message');
  assert.equal(ready, 'ready');
  const closed = once(interrupted.child, 'close', { signal: AbortSignal.timeout(2000) });
  interrupted.child.kill('SIGTERM');
  assert.deepEqual(await closed, [143, null]);
});

// Test Value Gate: interruption and failed streams must stop a live probe and
// suppress a response even after EOF has been accepted as the request delimiter.
test('adapter cancels introspection on stream errors and interruption', { timeout: 12000 }, async (t) => {
  const state = await fixture(t);
  const pidFile = path.join(state.root, 'probe.pid');
  await installCli(state.bin, 'claude', '@anthropic-ai/claude-code', `
    require('node:fs').writeFileSync('probe.pid', String(process.pid));
    setInterval(() => {}, 1000);
  `);
  let pid;
  t.after(() => { if (pid) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  for (const fault of process.platform === 'win32' ? ['stdin', 'stdout'] : ['stdin', 'stdout', 'SIGINT']) {
    const adapter = startClaudeAdapter(t, state, { injectStreamFaults: true });
    const markerDeadline = Date.now() + 4000;
    adapter.child.stdin.end(JSON.stringify(adapter.request) + '\n');
    while (Date.now() < markerDeadline && !pid) {
      try { pid = Number(await fs.readFile(pidFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10); }
    }
    assert.ok(pid, 'The backend probe must start before testing cancellation.');
    const closed = once(adapter.child, 'close', { signal: AbortSignal.timeout(2000) });
    if (fault === 'SIGINT') adapter.child.kill(fault);
    else adapter.child.send(fault);
    assert.deepEqual(await closed, [fault === 'SIGINT' ? 130 : 1, null]);
    assert.equal((await adapter.exit).stdout, '');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    pid = undefined;
    await fs.unlink(pidFile);
  }
});

// Test Value Gate: a JSON body of exactly 1 MiB leaves no space for LF. Build
// an ordinary Claude response that grows during bounded secret redaction.
test('introspection response counts LF in its wire size and preserves the overflow code', { timeout: 10000 }, async (t) => {
  const state = await fixture(t);
  const protectedValue = 'hideword';
  state.env.FIXTURE_SECRET = protectedValue;
  await installCli(state.bin, 'claude', '@anthropic-ai/claude-code', `
    process.stdin.once('data', () => process.stdout.write(require('node:fs').readFileSync('models.json')));
  `);
  const cap = 1024 * 1024;
  const efforts = Array.from({ length: 29 }, (_, i) => 'e'.repeat(254) + String(i).padStart(2, '0'));
  const description = '[redacted]'.repeat(51);
  for (const bodyBytes of [cap - 1, cap]) {
    const models = Array.from({ length: 128 }, (_, i) => ({ id: `model-${i}`, displayName: 'x', description, efforts }));
    const expected = { protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' }, models };
    let remaining = bodyBytes - Buffer.byteLength(JSON.stringify(expected));
    for (const model of models) {
      const padding = Math.min(remaining, 255);
      model.displayName += 'x'.repeat(padding);
      remaining -= padding;
    }
    assert.equal(remaining, 0, 'The supported model fields must fill the response to the chosen boundary.');
    const rawModels = models.map(({ id, displayName }) => ({ value: id, displayName, description: protectedValue.repeat(51), supportsEffort: true, supportedEffortLevels: efforts }));
    await fs.writeFile(path.join(state.root, 'models.json'), JSON.stringify({ type: 'control_response', response: {
      request_id: 'introspect-1', subtype: 'success', response: { models: rawModels },
    } }) + '\n');
    const adapter = startClaudeAdapter(t, state);
    adapter.child.stdin.end(JSON.stringify(adapter.request) + '\n');
    const result = await adapter.exit;
    if (bodyBytes === cap - 1) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(Buffer.byteLength(result.stdout), cap);
      assert.deepEqual(JSON.parse(result.stdout), expected);
      if (process.platform !== 'win32') {
        const blocked = startClaudeAdapter(t, state, { collectOutput: false });
        blocked.child.stdin.end(JSON.stringify(blocked.request) + '\n');
        try {
          await once(blocked.child.stdout, 'readable');
          const exited = once(blocked.child, 'exit', { signal: AbortSignal.timeout(2000) });
          blocked.child.kill('SIGTERM');
          assert.deepEqual(await exited, [143, null]);
        } finally { blocked.child.stdout.resume(); }
      }
    } else {
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^protocolTooLarge:/);
    }
  }
});

const testEnvironmentChecks = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  assert.equal(process.cwd(), process.env.FIXTURE_ROOT);
  assert.equal(process.env.AW_NATIVE_TOOL_CONTEXT, undefined);
  assert.equal(process.env.AW_SUBAGENT_PROCESS_TOKEN, undefined);
`;

// Test Value Gate: the listed models must reflect the startup settings without
// sending thread overrides or starting a thread.
test('Codex lists all model pages with effective launch settings and closes its backend', async (t) => {
  const state = await fixture(t);
  const scripts = await stageRuntime(state.root);
  const codex = { cliSource: 'cli', bypassHookTrust: false, profile: 'advanced' };
  await fs.writeFile(path.join(state.codexHome, 'advanced.config.toml'), [
    'model = "preferred"',
    'model_provider = "fixture"',
    'developer_instructions = "Thread-specific instructions"',
    '[features]',
    'hooks = false',
    'api_key_model_discovery = true',
    '[hooks.state."profile.config.toml:session_start:0:0"]',
    'enabled = false',
  ].join('\n'));
  await installCli(state.bin, 'codex', '@openai/codex', `
    ${testEnvironmentChecks}
    assert.equal(process.env.CODEX_HOME, path.join(process.cwd(), '.codex'));
    assert.deepEqual(process.argv.slice(2), [
      'app-server', '--strict-config', '-c', 'model_provider="fixture"',
      '-c', 'features={ api_key_model_discovery = true }', '-c', 'openai_base_url="https://fixture.invalid"',
    ]);
    fs.writeFileSync('codex.pid', String(process.pid));
    const steps = ['initialize', 'initialized', 'model/list', 'model/list'];
    const write = (frame) => console.log(JSON.stringify(frame));
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const frame = JSON.parse(line);
      assert.equal(frame.method, steps.shift());
      if (frame.method === 'initialize') {
        write({ id: frame.id, method: 'account/chatgptAuthTokens/refresh', params: {} });
        write({ id: frame.id, result: {} });
      }
      if (frame.method === 'model/list') {
        write({ id: frame.id, method: 'account/chatgptAuthTokens/refresh', params: {} });
        if (steps.length) {
          assert.equal(frame.params.cursor, undefined);
          write({ id: frame.id, result: { nextCursor: 'page-two', data: [
            { id: 'hidden', hidden: true, isDefault: true },
            { id: 'internal-id', model: 'visible', displayName: 'Visible', description: 'Model', isDefault: true,
              defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
          ] } });
        } else {
          assert.equal(frame.params.cursor, 'page-two');
          write({ id: frame.id, result: { nextCursor: null, data: [
            { id: 'visible', displayName: 'Duplicate model' }, { id: 'fallback' },
          ] } });
        }
      }
    });
    setInterval(() => {}, 1000);
  `);
  const args = ['--strict-config', '-c', 'model_reasoning_effort=high', '-c', 'compact_prompt="Thread-specific compact prompt"',
    '-c', 'openai_base_url="https://fixture.invalid"'];
  const result = await runAdapter(state, 'codex', { codex, args }, { scripts });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' },
    models: [
      { id: 'visible', displayName: 'Visible', description: 'Model', efforts: ['low', 'high'], defaultEffort: 'high', isDefault: true },
      { id: 'fallback' },
    ],
    defaultModel: 'visible', defaultEffort: 'high',
  });
  const backendPid = Number(await fs.readFile(path.join(state.root, 'codex.pid'), 'utf8'));
  assert.throws(() => process.kill(backendPid, 0), { code: 'ESRCH' });
});

// Test Value Gate: a repeated cursor must terminate without reporting a
// partial catalog as available or waiting for the process timeout.
test('Codex rejects a repeated model page cursor', async (t) => {
  const state = await fixture(t);
  const scripts = await stageRuntime(state.root);
  await installCli(state.bin, 'codex', '@openai/codex', `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      const frame = JSON.parse(line);
      if (frame.method === 'initialize') console.log(JSON.stringify({ id: frame.id, result: {} }));
      if (frame.method === 'model/list') {
        console.log(JSON.stringify({ id: frame.id, result: { data: [{ id: 'partial' }], nextCursor: 'repeated' } }));
      }
    });
  `);
  const codex = { cliSource: 'cli', bypassHookTrust: false };
  const result = await runAdapter(state, 'codex', { codex }, { scripts });
  assert.equal(result.code, 0);
  const reply = JSON.parse(result.stdout);
  assert.deepEqual(reply.environment, { status: 'unavailable', code: 'introspectionFailed' });
  assert.equal(reply.models, undefined);
});

// Test Value Gate: conflicts and user text would switch the CLI out of an
// initialize-only exchange. A second adapter frame must fail before launch.
test('Claude forwards settings and sends only initialize with no process token', async (t) => {
  const state = await fixture(t);
  await installCli(state.bin, 'claude', '@anthropic-ai/claude-code', `
    ${testEnvironmentChecks}
    assert.deepEqual(process.argv.slice(2), [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--settings', 'settings.json', '--add-dir', 'workspace', 'extra-directory', '--mcp-config={} ',
    ]);
    fs.writeFileSync('claude.started', '');
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      assert.deepEqual(JSON.parse(line), {
        type: 'control_request', request_id: 'introspect-1', request: { subtype: 'initialize' },
      });
      console.log(JSON.stringify({ type: 'control_response', response: {
        request_id: 'introspect-1', subtype: 'success', response: { models: [
          { value: 'default', displayName: 'Implicit default' },
          { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'gateway-sonnet', description: 'Safe model',
            supportsEffort: true, supportedEffortLevels: ['medium', 'high'] },
          { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
        ] },
      } }));
    });
    setInterval(() => {}, 1000);
  `);
  const args = [
    '--settings', 'settings.json', '--resume', 'old-session', '--model=skip',
    '--output-format', 'text', '-p', '--print', '--continue', '-c', '--input-format=text', '--verbose',
    '--effort', 'max', '--session-id=skip', '-r', 'other-session', '--add-dir', 'workspace', 'extra-directory',
    '--mcp-config={} ', 'a positional prompt', '--from-pr', 'link',
    '--system-prompt', '--add-dir=system-prompt-value', '-n', '--settings=short-option-value',
    '--tools', '--mcp-config=tool-list-value',
  ];
  const invalid = await runAdapter(state, 'claude-code', { args }, { raw: (request) => (JSON.stringify(request) + '\n').repeat(2) });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, '');
  await assert.rejects(fs.stat(path.join(state.root, 'claude.started')), { code: 'ENOENT' });
  const result = await runAdapter(state, 'claude-code', { args });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).models, [
    { id: 'sonnet', displayName: 'Sonnet (gateway-sonnet)', description: 'Safe model', efforts: ['medium', 'high'] },
    { id: 'haiku', displayName: 'Haiku', efforts: [] },
  ]);
});

// Test Value Gate: a status-only or nonzero listing must not be confused with
// a catalog. Real TSV output supplies the display label and known effort menu.
test('Antigravity checks agy and parses only model rows', async (t) => {
  const state = await fixture(t);
  await installCli(state.bin, 'agy', 'agy', `
    ${testEnvironmentChecks}
    const args = process.argv.slice(2);
    if (args[0] === '--version') { assert.equal(args.length, 1); console.log('1.5.15'); }
    else {
      assert.deepEqual(args, ['models']);
      console.log('Fetching available models...');
      if (!process.env.FIXTURE_EMPTY) console.log('agy-model\\tAgy Model');
    }
  `);
  const result = await runAdapter(state, 'antigravity', { args: ['--model', 'must-not-pass'] });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' },
    models: [{ id: 'agy-model', displayName: 'Agy Model' }], supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  });
  state.env.FIXTURE_EMPTY = '1';
  const empty = await runAdapter(state, 'antigravity');
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout).environment, { status: 'unavailable', code: 'introspectionFailed' });
});

// Test Value Gate: a batch path and a link must not become process commands.
// The Windows rules are exercised with the host file system and current Node
// binary so this case also runs when the test runner is outside Windows.
test('probe validates the Windows shim and passes its args directly to Node', async (t) => {
  const { root, bin, env } = await fixture(t);
  const { shim, directory } = await installShim(bin, 'fixture', 'fixture-cli', 'console.log(JSON.stringify(process.argv.slice(2)));');
  const options = { cwd: root, env, platform: 'win32' };
  const args = ['中文', '& echo injected > unwanted'];
  const invocation = await resolveProbeExecutable('fixture', args, options);
  assert.equal(invocation.command, process.execPath);
  const result = await runProbeProcess(invocation, options);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  await assert.rejects(fs.stat(path.join(root, 'unwanted')), { code: 'ENOENT' });

  const batch = path.join(bin, 'fixture.bat');
  await fs.copyFile(shim, batch);
  await assert.rejects(resolveProbeExecutable(batch, [], options), { code: 'executableShimUnsupported' });
  const moved = path.join(root, 'real-package');
  await fs.rename(directory, moved);
  await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveProbeExecutable(shim, [], options), { code: 'executableShimUnsupported' });
  await fs.appendFile(shim, 'echo injected > unwanted\r\n');
  await assert.rejects(resolveProbeExecutable(shim, [], options), { code: 'executableShimUnsupported' });
});

// Test Value Gate: a POSIX descendant can keep the probe pipe open after the
// launcher exits. The probe must still reach its deadline and release the pipe.
test('probe deadline applies after the child exits with inherited stdout open', {
  skip: process.platform === 'win32', timeout: 6000,
}, async (t) => {
  const { root } = await fixture(t);
  const pidFile = path.join(root, 'holder.pid');
  const command = process.execPath;
  const args = ['-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'],
      { stdio: ['ignore', 1, 'ignore'] });
    require('node:fs').writeFileSync(process.argv[1], String(child.pid));
    child.unref();
  `, pidFile];
  try {
    await assert.rejects(runProbeProcess({ command, args }, { cwd: root, signal: AbortSignal.timeout(2000) }), { code: 'introspectionTimeout' });
    assert.ok(Number(await fs.readFile(pidFile, 'utf8')) > 0);
  } finally {
    const pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => ''));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already finished. */ } }
  }
});

// Test Value Gate: managed inspect owns its POSIX group and reaches close
// even when a backend leaves a descendant holding the inherited pipe.
for (const timeout of [false, true]) {
  test(`inspect kills its POSIX descendants on ${timeout ? 'timeout' : 'normal exit'}`, {
    skip: process.platform === 'win32', timeout: 7000,
  }, async (t) => {
    const { root } = await fixture(t);
    const pidFile = path.join(root, 'owned.pid');
    const heartbeat = path.join(root, 'heartbeat');
    const command = process.execPath;
    const args = ['-e', `
      const script = 'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "x"), 40)';
      const child = require('node:child_process').spawn(process.execPath, ['-e', script, process.argv[2]], { stdio: ['ignore', 1, 'ignore'] });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      child.unref();
      if (${timeout}) setInterval(() => {}, 1000);
      else console.log('finished');
    `, pidFile, heartbeat];
    const outcome = runProbeProcess({ command, args }, {
      cwd: root, signal: AbortSignal.timeout(1500), containment: {},
    });
    try {
      if (timeout) await assert.rejects(outcome, { code: 'introspectionTimeout' });
      else {
        const result = await outcome;
        assert.equal(result.code, 0);
        assert.equal(result.stdout.trim(), 'finished');
      }
      const pid = Number(await fs.readFile(pidFile, 'utf8'));
      assert.ok(pid > 0);
      const heartbeatSize = () => fs.stat(heartbeat).then((stat) => stat.size, (error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      const size = await heartbeatSize();
      if (timeout) assert.ok(size > 0);
      await delay(200);
      assert.equal(await heartbeatSize(), size);
    } finally {
      const pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => ''));
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already finished. */ } }
    }
  });
}
