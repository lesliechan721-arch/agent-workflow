import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suggest } from './config-suggestions.mjs';

const request = { schemaVersion: 1, provider: 'executor-models', profile: 'generic', platform: 'generic',
  dependencyValues: {}, providerConfigValues: {}, cwd: process.cwd() };
test('native directory probes are limited to the three supported host profiles', async () => {
  for (const profile of ['common', 'generic', 'opencode', 'cursor', 'pi', 'copilot', 'grok']) {
    assert.equal((await suggest({ ...request, profile, platform: profile }, { probe: assert.fail })).status, 'unsupported');
  }
  for (const [platform, adapter] of [['codex', 'codex'], ['claude', 'claude-code'], ['antigravity', 'antigravity']]) {
    const result = await suggest({ ...request, profile: platform, platform }, { env: {}, probe: (e) => {
      assert.equal(e.adapter, adapter);
      return { protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' }, models: [{ id: 'sample' }] };
    } });
    assert.deepEqual(result.items.map((m) => m.value), ['sample']);
  }
});

test('model and effort suggestions use the same unsaved executor and its static override', async () => {
  const draft = { ...request, dependencyValues: { executor: 'draft', model: 'm' }, providerConfigValues: { subagentCommands: [
    { key: 'draft', adapter: 'custom', modelsPolicy: 'override', models: [{ id: 'm', default: true, description: 'Local', efforts: ['high'] }] },
  ] } };
  const opts = { env: {}, probe: assert.fail };
  assert.deepEqual((await suggest(draft, opts)).items, [{ value: 'm', title: 'm', description: 'Local', source: 'configured', recommended: true }]);
  assert.deepEqual((await suggest({ ...draft, provider: 'executor-efforts' }, opts)).items, [{ value: 'high', title: 'high', source: 'configured' }]);
  assert.equal((await suggest({ ...draft, providerConfigValues: {} }, opts)).status, 'unavailable');
});

test('invalid model defaults return an actionable diagnostic for both suggestion providers', async () => {
  const draft = { ...request, dependencyValues: { executor: 'draft' }, providerConfigValues: { subagentCommands: [
    { key: 'draft', adapter: 'custom', modelsPolicy: 'override', models: [
      { id: 'first', default: true }, { id: 'second', default: true },
    ] },
  ] } };
  for (const provider of ['executor-models', 'executor-efforts']) {
    const result = await suggest({ ...draft, provider }, { env: {}, probe: assert.fail });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.items, []);
    assert.equal(result.diagnostics[0].code, 'executorInvalid');
  }
});

test('the script honors longer AW deadlines and reserves time for its response', async (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const timeout = t.mock.method(AbortSignal, 'timeout');
  const probe = () => ({
    protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' },
    models: [{ id: 'sample' }],
  });
  const native = { ...request, platform: 'codex', profile: 'codex' };
  for (const [deadlineAt, expectedBudget] of [[undefined, 9700], [16000, 14700], [100000, 29700]]) {
    const result = await suggest({ ...native, deadlineAt }, { env: {}, probe });
    assert.equal(result.status, 'ok');
    assert.deepEqual(timeout.mock.calls.at(-1).arguments, [expectedBudget]);
  }
  const expired = await suggest({ ...native, deadlineAt: 1300 }, { env: {}, probe: assert.fail });
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.diagnostics[0].code, 'introspectionTimeout');
});

// Test Value Gate: a model catalog may be empty while the backend can still
// verify which effort levels a manually entered model supports.
test('effort suggestions use the general menu when the model catalog is empty', async () => {
  const options = { env: {}, probe: () => ({
    protocolVersion: 6, type: 'introspection', status: 'supported', environment: { status: 'available' },
    models: [], supportedEfforts: ['low', 'high'], defaultEffort: 'high',
  }) };
  const native = { ...request, profile: 'codex', platform: 'codex', dependencyValues: { model: 'manual' } };
  assert.equal((await suggest(native, options)).status, 'unsupported');
  assert.deepEqual((await suggest({ ...native, provider: 'executor-efforts' }, options)).items, [
    { value: 'low', title: 'low', source: 'dynamic' },
    { value: 'high', title: 'high', source: 'dynamic', recommended: true },
  ]);
});

// Test Value Gate: a real adapter can hold stdout open past the provider's
// budget. The selected static options must return while AW can still receive them.
test('a hanging custom probe returns static suggestions before the outer deadline', { timeout: 5000 }, async (t) => {
  const cwd = await mkdtemp(path.join(await realpath(tmpdir()), 'aw-suggestion-deadline-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const entrypoint = path.join(cwd, 'adapter.mjs');
  const started = path.join(cwd, 'started');
  await writeFile(entrypoint, `import { writeFileSync } from 'node:fs';
    writeFileSync('started', 'ready');
    setInterval(() => {}, 1000);
  `);
  const deadlineAt = Date.now() + 1200;
  const result = await suggest({
    ...request, cwd, deadlineAt, dependencyValues: { executor: 'local' }, providerConfigValues: { subagentCommands: [
      { key: 'local', adapter: 'custom', command: process.execPath, entrypoint, models: [{ id: 'manual' }] },
    ] },
  }, { env: process.env });
  assert.ok(Date.now() < deadlineAt);
  assert.equal(await readFile(started, 'utf8'), 'ready');
  assert.deepEqual(result.items, [{ value: 'manual', title: 'manual', source: 'configured' }]);
  assert.equal(result.diagnostics[0].code, 'introspectionTimeout');
});

// Test Value Gate: an executable can pass path validation and still fail to
// spawn. The suggestion script must return its JSON receipt with a usable fallback.
test('the suggestions entrypoint returns JSON after spawn fails without close', { timeout: 5000 }, async (t) => {
  const cwd = await mkdtemp(path.join(await realpath(tmpdir()), 'aw-suggestion-spawn-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = path.join(cwd, 'broken.exe');
  await writeFile(command, '#!/aw-missing-interpreter\n', { mode: 0o755 });
  const bootstrap = path.join(cwd, 'omit-close.mjs');
  // Exercise the real launch error at the boundary without relying on Node
  // and libuv always closing the pipes after a failed launch.
  await writeFile(bootstrap, `import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const { spawn } = childProcess;
    childProcess.spawn = (command, ...args) => {
      const child = spawn(command, ...args);
      if (command === ${JSON.stringify(command)}) {
        const { emit } = child;
        child.emit = (event, ...payload) => event === 'close' ? false : emit.call(child, event, ...payload);
      }
      return child;
    };
    syncBuiltinESMExports();
  `);
  const args = ['--import', pathToFileURL(bootstrap).href, fileURLToPath(new URL('./config-suggestions.mjs', import.meta.url))];
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, { cwd, timeout: 4000 }, (error, output) => {
      if (error) reject(error);
      else resolve(output);
    });
    child.stdin.end(JSON.stringify({
      ...request, cwd, dependencyValues: { executor: 'local' }, providerConfigValues: { subagentCommands: [
        { key: 'local', adapter: 'custom', command, models: [{ id: 'manual' }] },
      ] },
    }));
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items, [{ value: 'manual', title: 'manual', source: 'configured' }]);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['introspectionSpawnFailed']);
  assert.ok(!stdout.includes(cwd));
});
