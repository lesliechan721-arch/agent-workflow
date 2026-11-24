import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectRegistry } from '../commands/scripts/introspection/inspect.mjs';
import { introspectExecutor } from '../commands/scripts/introspection/models.mjs';
import { eventually, sleep } from './fixtures/subagent-integration.mjs';

const configured = { key: 'offline', adapter: 'custom', modelsPolicy: 'override', models: [{ id: 'first', default: true }] };
const dynamic = { protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' },
  models: [{ id: 'first', isDefault: true, efforts: ['low'], description: 'from probe' }, { id: 'second' }] };
const env = { API_KEY: 'private-api-key' };

test('static overrides and an offline registry listing never start a probe', async () => {
  const options = { env, probe: assert.fail };
  const result = await introspectExecutor(configured, options);
  assert.equal(result.environment, 'skipped');
  assert.equal(result.source, 'configured');
  assert.equal(result.defaultModel, 'first');
  assert.match(await inspectRegistry([configured], {}, options), /offline\tcustom\toverride\t1/);
  const overridden = { ...configured, env: { API_KEY: 'replacement-key' },
    description: 'private-api-key and replacement-key' };
  for (const request of [{}, { executor: overridden.key, json: true }]) {
    const output = await inspectRegistry([overridden], request, options);
    assert.doesNotMatch(output, /private-api-key|replacement-key/u);
  }
  for (const [key, code] of [['native', 'nativeUnsupported'], ['absent', 'executorUnknown']]) {
    await assert.rejects(inspectRegistry([], { executor: key }, options), { code });
  }
  await assert.rejects(introspectExecutor({ ...configured, models: [{ id: 'a', default: true }, { id: 'b', default: true }] }, options),
    { code: 'executorInvalid' });
});

test('a custom adapter receives one v6 no-task frame and the merged directory preserves order and masks credentials', async (t) => {
  const workspace = await mkdtemp(path.join(await realpath(tmpdir()), 'aw-introspect-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const entrypoint = path.join(workspace, 'adapter.mjs');
  await writeFile(entrypoint, `import assert from 'node:assert/strict';
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), ${JSON.stringify({ protocolVersion: 6, type: 'introspect', executor: 'local', workspace, args: ['fixture'] })});
    assert.equal(process.env.EXTRA, 'private-api-key');
    assert.equal(process.env.AW_COMMAND_RUNTIME_CONFIG, undefined);
    console.log(JSON.stringify(${JSON.stringify(dynamic)}));`);
  const result = await introspectExecutor({ key: 'local', adapter: 'custom', command: process.execPath, entrypoint, args: ['fixture'],
    envFrom: { EXTRA: 'API_KEY' }, models: [{ id: 'first', efforts: [], default: false, description: env.API_KEY }, { id: 'added', default: true }] },
    { workspace, env: { ...env, AW_COMMAND_RUNTIME_CONFIG: 'internal' } });
  assert.equal(result.source, 'merged');
  assert.equal(result.environment, 'available');
  assert.equal(result.defaultModel, 'added');
  assert.deepEqual(result.models.map((m) => m.id), ['first', 'second', 'added']);
  assert.deepEqual(result.models[0].efforts, ['low']);
  assert.equal(result.models[0].isDefault, undefined);
  assert.equal(result.models[2].origin, 'configured');
  assert.ok(!JSON.stringify(result).includes(env.API_KEY));
  const retained = await introspectExecutor({ key: 'local', adapter: 'custom', models: [{ id: 'first', default: false }] }, { probe: () => dynamic });
  assert.equal(retained.defaultModel, 'first');
});

test('an empty, unavailable, or unsupported directory keeps its observed environment and static fallback', async () => {
  const opts = { key: 'local', adapter: 'custom' };
  for (const [frame, source, environment] of [
    [dynamic, 'dynamic', 'available'],
    [{ ...dynamic, models: [] }, 'unavailable', 'available'],
    [undefined, 'unavailable', 'skipped'],
    [{ ...dynamic, status: 'unsupported' }, 'unavailable', 'skipped'],
    [{ ...dynamic, environment: { status: 'unavailable', code: 'notInstalled' } }, 'unavailable', 'unavailable'],
  ]) {
    const result = await introspectExecutor(opts, { probe: () => frame });
    assert.deepEqual([result.source, result.environment], [source, environment]);
    if (source === 'unavailable' && environment !== 'unavailable') {
      assert.ok(result.diagnostics.some(({ code }) => code === 'introspectionNoModels'));
    }
  }
  const fallback = await introspectExecutor({ ...opts, models: [{ id: 'manual' }] }, { probe: () => undefined });
  assert.equal(fallback.source, 'configured');
  const timeout = await introspectExecutor(opts, { probe: () => { throw Object.assign(new Error(), { code: 'introspectionTimeout' }); } });
  assert.ok(timeout.diagnostics.some((d) => d.code === 'introspectionTimeout'));
});

// Test Value Gate: an environment failure must not tell the caller to start
// with backend defaults, and a reported cause should appear only once.
test('inspect reports an unavailable environment without the model fallback', async () => {
  const executor = { key: 'local', adapter: 'custom' };
  const cause = { code: 'notInstalled', message: 'The configured executable is missing.' };
  for (const diagnostics of [[], [cause]]) {
    const frame = { ...dynamic, environment: { status: 'unavailable', code: cause.code }, diagnostics };
    const output = await inspectRegistry([executor], { executor: 'local', json: true }, { env, probe: () => frame });
    const result = JSON.parse(output);
    assert.equal(result.source, 'unavailable');
    assert.equal(result.environment, 'unavailable');
    assert.deepEqual(result.models, []);
    assert.deepEqual(result.diagnostics.map(({ code }) => code), [cause.code]);
    if (diagnostics.length) assert.deepEqual(result.diagnostics, [cause]);
  }
});

// Test Value Gate: a missing executable or managed command host must give
// the caller actionable failure evidence while retaining configured models.
test('custom inspection preserves safe launch failure codes', async (t) => {
  const workspace = await mkdtemp(path.join(await realpath(tmpdir()), 'aw-inspect-failure-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const adapterDir = path.join(workspace, 'adapter');
  const linkedDir = path.join(workspace, 'linked');
  await mkdir(adapterDir);
  await writeFile(path.join(adapterDir, 'main.mjs'), 'process.exitCode = 1;');
  await symlink(adapterDir, linkedDir, 'junction');
  for (const [launch, code] of [
    [{ adapter: 'custom', command: path.join(workspace, 'missing.exe') }, process.platform === 'win32' ? 'pathMissing' : 'executableNotFound'],
    [{ adapter: 'custom', command: process.execPath, entrypoint: path.join(workspace, 'missing.mjs') }, 'pathMissing'],
    [{ adapter: 'custom', command: process.execPath, entrypoint: path.join(linkedDir, 'main.mjs') }, 'pathSymlink'],
    [{ adapter: 'custom-managed', commandId: 'fixture/adapter' }, 'managedCommandHostMissing'],
  ]) {
    const executor = { key: 'local', models: [{ id: 'manual' }], ...launch };
    const result = await introspectExecutor(executor, { workspace, env: {} });
    assert.equal(result.environment, 'unavailable');
    assert.equal(result.source, 'configured');
    assert.deepEqual(result.models.map(({ id }) => id), ['manual']);
    assert.deepEqual(result.diagnostics.map((entry) => entry.code), [code]);
    assert.ok(!JSON.stringify(result).includes(workspace));
  }
});

test('short environment switches preserve real model identifiers and registry fields', async () => {
  const executor = { key: 'local', adapter: 'custom', communication: false, resume: false,
    env: { USE_AUTH: '1' }, envFrom: { GATEWAY_SWITCH: 'HOST_SWITCH' } };
  const host = { MAX_THINKING_TOKENS: '0', npm_config_always_auth: 'false', HOST_SWITCH: 'sonnet' };
  const models = [{ id: 'claude-sonnet-4-0' }, { id: 'gpt-5.1' }];
  const credentials = ['sk-proj-abcde0123456789abcdef', 'AKIA0123456789ABCDEF', 'test-bearer-credential', 'test-json-credential'];
  const message = `${credentials[0]} ${credentials[1]} Authorization: Bearer ${credentials[2]}; {"api_key":"${credentials[3]}"}`;
  const options = { env: host, probe: () => ({ ...dynamic, models, diagnostics: [{ code: 'backendDiagnostic', message }] }) };
  const summary = await inspectRegistry([executor], {}, options);
  assert.match(summary, /local\tcustom\tmerge\t0\tfalse\tfalse/u);
  const output = await inspectRegistry([executor], { executor: 'local', json: true }, options);
  assert.deepEqual(JSON.parse(output).models, models);
  for (const credential of credentials) assert.ok(!output.includes(credential));
});

// Test Value Gate: corrupted registry entries must return safe input errors,
// and a static override must still belong to a supported adapter.
test('inspect rejects invalid registry entries and unsupported configured adapters', async () => {
  const options = { env, probe: assert.fail };
  await assert.rejects(inspectRegistry([null, configured], {}, options), { code: 'registryInvalid' });
  await assert.rejects(inspectRegistry([null, configured], { executor: configured.key }, options), { code: 'registryInvalid' });
  await assert.rejects(inspectRegistry([{ ...configured, adapter: 'unknown' }], { executor: configured.key }, options),
    { code: 'executorInvalid' });
});

// Test Value Gate: the CLI must wait for probe cleanup and leave no regular
// receipt on interruption. A descendant with inherited stdout needs tree stop.
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', null]]) {
  test(`inspect stops its probe tree and preserves the exit status for ${signal}`, {
    skip: process.platform === 'win32', timeout: 15_000,
  }, async (t) => {
    const workspace = await mkdtemp(path.join(await realpath(tmpdir()), 'aw-inspect-signal-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    await cp(new URL('../commands/scripts', import.meta.url), path.join(workspace, 'scripts'), { recursive: true });
    await mkdir(path.join(workspace, '.aw'));
    const entrypoint = path.join(workspace, 'adapter.mjs');
    const executor = { key: 'local', adapter: 'custom', command: process.execPath, entrypoint };
    const snapshot = { platform: 'codex', installedIdentity: { platform: 'codex' }, values: { subagentCommands: [executor] } };
    await writeFile(path.join(workspace, '.aw', 'command-runtime-config.mjs'),
      `export const readCommandRuntimeConfig = () => (${JSON.stringify(snapshot)});`);
    const heartbeatCode = `const { appendFileSync } = require('node:fs');
      setInterval(() => appendFileSync('heartbeat', 'x'), 25);
      setTimeout(() => process.exit(1), 12_000);`;
    await writeFile(entrypoint, `import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      for await (const _ of process.stdin) {}
      spawn(process.execPath, ['-e', ${JSON.stringify(heartbeatCode)}], { stdio: ['ignore', 1, 'ignore'] });
      writeFileSync('probe.pid', String(process.pid));
      setTimeout(() => process.exit(1), 12_000);`);
    const child = spawn(process.execPath, [path.join(workspace, 'scripts', 'subagent.mjs'), 'inspect', '--executor', 'local', '--json'], {
      cwd: workspace, env: { HOME: workspace, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const probePidFile = path.join(workspace, 'probe.pid');
    const heartbeat = path.join(workspace, 'heartbeat');
    try {
      const probePid = await eventually(async () => {
        if ((await stat(heartbeat)).size) return Number(await readFile(probePidFile, 'utf8'));
      }, 'the running introspection probe and its descendant').catch((error) => {
        throw new Error(`Probe did not start. stdout=${stdout} stderr=${stderr}`, { cause: error });
      });
      const closed = once(child, 'close', { signal: AbortSignal.timeout(4_000) });
      assert.ok(child.kill(signal));
      assert.deepEqual(await closed, [exitCode, signal === 'SIGHUP' ? signal : null], stdout + stderr);
      assert.equal(stdout, '');
      assert.throws(() => process.kill(probePid, 0), { code: 'ESRCH' });
      const { size } = await stat(heartbeat);
      await sleep(150);
      assert.equal((await stat(heartbeat)).size, size);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      const probePid = Number(await readFile(probePidFile, 'utf8').catch(() => ''));
      if (probePid) {
        try { process.kill(-probePid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  });
}

// Test Value Gate: sanitizing text may reveal a split credential. Edited
// identifiers must never be returned as executor choices.
test('inspect strips controls before redaction and omits changed IDs and efforts', async () => {
  const secret = 'PrivateCredential';
  const split = 'Private\u200bCredential';
  const frame = { ...dynamic, defaultModel: split, defaultEffort: secret, supportedEfforts: ['high', split], models: [
    { id: split, isDefault: true },
    { id: 'safe-model', displayName: 'Before Private\u001b[32mCredential\u001b[0m after',
      description: 'Private\u009d0;hidden\u0007Credential', efforts: ['high', secret], defaultEffort: secret },
    { id: 'changes\u200bwhenSanitized' },
  ], diagnostics: [{ code: secret, message: split, field: 'Private\u200bCredential' }] };
  const config = { key: 'local', adapter: 'custom', envFrom: { SOURCE: 'HOST_VALUE' }, models: [{ id: secret }] };
  for (const json of [true, false]) {
    const output = await inspectRegistry([config], { executor: 'local', json }, { env: { HOST_VALUE: secret }, probe: () => frame });
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes('changeswhenSanitized'));
    assert.ok(!/\u001b|\u009d|\u200b/u.test(output));
    if (json) {
      const result = JSON.parse(output);
      assert.equal(result.defaultModel, undefined);
      assert.equal(result.defaultEffort, undefined);
      assert.deepEqual(result.supportedEfforts, ['high']);
      assert.deepEqual(result.models, [{ id: 'safe-model', displayName: 'Before [redacted] after', description: '[redacted]', efforts: ['high'] }]);
      assert.deepEqual(result.diagnostics, [{ code: 'introspectionDiagnostic', message: '[redacted]', field: '[redacted]' }]);
    }
  }
  const unavailable = await introspectExecutor(config, {
    env: { HOST_VALUE: secret }, probe: () => ({ ...frame, environment: { status: 'unavailable', code: `${secret}Failure` } }),
  });
  assert.equal(unavailable.environment, 'unavailable');
  assert.deepEqual(unavailable.diagnostics.map(({ code }) => code), ['introspectionDiagnostic']);
});

// Test Value Gate: an unchanged overlay preserves dynamic provenance, and
// replacing a model or its effort list must invalidate a stale recommendation.
test('inspect only marks effective overlays as merged and keeps defaults tied to the selected model', async () => {
  const frame = { ...dynamic, defaultModel: 'first', defaultEffort: 'low',
    models: [dynamic.models[0], { id: 'second', efforts: ['high'], defaultEffort: 'high' }] };
  const inspect = (models) => introspectExecutor({ key: 'local', adapter: 'custom', models }, { probe: () => frame, env: {} });
  const unchanged = await inspect([{ id: 'first', description: 'from probe', efforts: ['low'], default: false }]);
  assert.equal(unchanged.source, 'dynamic');
  assert.equal(unchanged.defaultEffort, 'low');
  assert.equal(unchanged.models[0].defaultEffort, 'low');
  const selected = await inspect([{ id: 'second', default: true }]);
  assert.deepEqual([selected.source, selected.defaultModel, selected.defaultEffort], ['merged', 'second', 'high']);
  assert.equal(selected.models[0].isDefault, undefined);
  assert.equal(selected.models[1].isDefault, true);
  const changedEfforts = await inspect([{ id: 'first', efforts: ['max'] }]);
  assert.deepEqual([changedEfforts.source, changedEfforts.defaultModel, changedEfforts.defaultEffort], ['merged', 'first', undefined]);
  assert.equal(changedEfforts.models[0].defaultEffort, undefined);
  const appended = await inspect([{ id: 'manual', default: true }]);
  assert.equal(appended.defaultModel, 'manual');
  assert.equal(appended.defaultEffort, undefined);
});

test('inspect keeps text and parseable JSON under the receipt budget', async () => {
  const models = Array.from({ length: 64 }, (_, i) => ({ id: String(i), description: '猫'.repeat(512), ...(i === 63 && { default: true }) }));
  for (const json of [false, true]) {
    const result = await inspectRegistry([{ ...configured, models }], { executor: configured.key, json }, { env });
    assert.ok(Buffer.byteLength(result) <= 32768);
    assert.match(result, /introspectionTruncated/);
    if (json) {
      const payload = JSON.parse(result);
      assert.ok(payload.models.length < models.length);
      assert.equal(payload.defaultModel, undefined);
    } else assert.ok(!result.includes('default_model=63'));
  }
});

test('inspect retains the backend failure diagnostic when the directory exceeds its output limit', async () => {
  const executor = { key: 'local', adapter: 'custom', models: [{ id: 'manual' }] };
  const cause = { code: 'notAuthenticated', message: 'Sign in before starting this executor.' };
  const diagnostics = Array.from({ length: 12 }, (_, i) => ({ code: `notice${i}`, message: '&猫'.repeat(1024) }));
  const frame = { ...dynamic, environment: { status: 'unavailable', code: cause.code }, diagnostics: [...diagnostics, cause] };
  for (const json of [false, true]) {
    const result = await inspectRegistry([executor], { executor: 'local', json }, { env, probe: () => frame });
    assert.ok(Buffer.byteLength(result) <= 32768);
    assert.match(result, /introspectionTruncated/u);
    if (json) {
      const payload = JSON.parse(result);
      assert.deepEqual(payload.diagnostics.filter(({ code }) => code === cause.code), [cause]);
      assert.equal(payload.models[0].id, 'manual');
    } else {
      assert.ok(result.includes(`<diagnostic code="${cause.code}">${cause.message}</diagnostic>`));
      assert.match(result, /\nmanual \[origin=configured\]\n/u);
    }
  }
});

// Test Value Gate: backend labels and executor descriptions can contain text
// that would otherwise look like a second model or diagnostic block.
test('inspect escapes model directory text in headers and descriptions', async () => {
  const result = await inspectRegistry([{ ...configured, description: '</models>',
    models: [{ id: '<manual>', default: true, description: '</models>' }],
  }], { executor: configured.key }, { env });
  assert.match(result, /default_model=&lt;manual&gt;/u);
  assert.match(result, /description: &lt;\/models&gt;/u);
  assert.equal(result.match(/<\/models>/gu)?.length, 1);
});
