import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suggest } from './config-suggestions.mjs';

const request = { schemaVersion: 2, kind: 'scalar', provider: 'executor-models', profile: 'generic', platform: 'generic',
  dependencyValues: {}, providerConfigValues: {}, cwd: process.cwd() };
const objectRequest = { ...request, kind: 'object', provider: 'executor-model-profile', targets: ['model', 'reasoningEffort'] };
const frame = (models, extra) => ({ protocolVersion: 6, type: 'introspection', status: 'supported',
  environment: { status: 'available' }, models, ...extra });
const native = (platform, overrides = {}) => ({ ...objectRequest, profile: platform, platform, ...overrides });

// Resolve the observable two-level patches and recommendation marks; a
// single probe must supply every canonical hint for the caller's shared cache.
function recommendations(response) {
  const rows = response.items.flatMap((parent) => parent.children ? parent.children.items.map((child) => ({
    ...child, set: { ...parent.set, ...child.set }, unset: [...(parent.unset ?? []), ...(child.unset ?? [])],
  })) : [parent]);
  const result = {};
  for (const row of rows) {
    for (const hint of row.recommendedHints ?? []) {
      assert.ok(!Object.hasOwn(result, hint), 'Each hint recommends exactly one leaf');
      result[hint] = [row.set?.model, row.set?.reasoningEffort];
    }
  }
  return result;
}

test('native directory probes are limited to the three supported host profiles', async () => {
  for (const profile of ['common', 'generic', 'opencode', 'cursor', 'pi', 'copilot', 'grok']) {
    assert.equal((await suggest({ ...request, profile, platform: profile }, { probe: assert.fail })).status, 'no-probe');
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
  assert.deepEqual((await suggest(draft, opts)).items, [{ value: 'm', title: 'm', description: 'Local Reasoning efforts: high.',
    source: 'configured', recommended: true }]);
  assert.deepEqual((await suggest({ ...draft, provider: 'executor-efforts' }, opts)).items, [{ value: 'high', title: 'high', source: 'configured' }]);
  assert.equal((await suggest({ ...draft, providerConfigValues: {} }, opts)).status, 'unavailable');
});

test('invalid model defaults return an actionable diagnostic for all suggestion providers', async () => {
  const draft = { ...request, dependencyValues: { executor: 'draft' }, providerConfigValues: { subagentCommands: [
    { key: 'draft', adapter: 'custom', modelsPolicy: 'override', models: [
      { id: 'first', default: true }, { id: 'second', default: true },
    ] },
  ] } };
  for (const provider of ['executor-models', 'executor-efforts', 'executor-model-profile']) {
    const result = await suggest({ ...draft, provider, ...(provider === 'executor-model-profile' && { kind: 'object', targets: objectRequest.targets }) },
      { env: {}, probe: assert.fail });
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
  assert.equal((await suggest(native, options)).status, 'no-probe');
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
  assert.deepEqual(result.items, [{ value: 'manual', title: 'manual', source: 'configured', description: 'Reasoning effort support unknown.' }]);
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
  assert.deepEqual(result.items, [{ value: 'manual', title: 'manual', source: 'configured', description: 'Reasoning effort support unknown.' }]);
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['introspectionSpawnFailed']);
  assert.ok(!stdout.includes(cwd));
});

test('Codex recommends all five hints from the active generation, without auto-selecting ultra or specialist models', async () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const models = [
    { id: 'gpt-previous-luna', description: 'Legacy lightweight', efforts: levels, isDefault: true },
    { id: 'gpt-main', description: 'Everyday model', efforts: levels, defaultEffort: 'low' },
    { id: 'gpt-visual-pro', description: 'Most capable visual understanding and computer use', efforts: levels },
    { id: 'gpt-main-astra', description: 'Complex coding', efforts: levels },
    { id: 'gpt-new-luna', description: 'Affordable', efforts: levels },
  ];
  let probes = 0;
  const result = await suggest(native('codex', { hint: 'deep' }), { env: {}, probe: () => { probes++; return frame(models); } });
  assert.equal(probes, 1);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items[0], { title: '沿用宿主默认', unset: ['model', 'reasoningEffort'] });
  assert.deepEqual(recommendations(result), { fast: ['gpt-new-luna', 'low'], balanced: ['gpt-main', 'medium'],
    strong: ['gpt-main-astra', 'high'], deep: ['gpt-main-astra', 'xhigh'], max: ['gpt-main-astra', 'max'] });
  const strong = result.items.find((item) => item.set?.model === 'gpt-main-astra');
  assert.deepEqual(strong.children.items[0], { title: '沿用模型默认', source: 'dynamic', unset: ['reasoningEffort'] });
  assert.ok(strong.children.items.some((item) => item.set?.reasoningEffort === 'ultra' && !item.recommendedHints));
  assert.deepEqual(strong.children.items.filter((item) => item.recommended).map((item) => item.set.reasoningEffort), ['xhigh']);
  const renamed = await suggest(native('codex', { hint: 'unknown-hint' }), { env: {}, probe: () => frame([
    { id: 'renamed', description: 'Previous generation', efforts: ['ultra'], defaultEffort: 'ultra', isDefault: true },
  ]) });
  assert.deepEqual(Object.values(recommendations(renamed)), Array(5).fill(['renamed', undefined]));
  assert.equal(renamed.items[1].children.items[0].recommended, true);
});

test('Antigravity groups real families in directory order, suggests full IDs, and excludes orchestrator from recommendations', async () => {
  const models = [
    { id: 'gemini-pro-orchestrator', displayName: 'Gemini Pro Orchestrator', efforts: [] },
    ...['high', 'low', 'xhigh', 'medium'].map((effort) => ({ id: `gemini-main-${effort}`,
      displayName: `Gemini Main (${effort === 'xhigh' ? 'XHigh' : effort[0].toUpperCase() + effort.slice(1)})`, efforts: [] })),
    ...['medium', 'low', 'high'].map((effort) => ({ id: `gemini-flash-${effort}`,
      displayName: `Gemini Flash (${effort[0].toUpperCase() + effort.slice(1)})`, efforts: [] })),
    { id: 'single-medium', displayName: 'Single (Medium)', efforts: [] },
  ];
  const opts = { env: {}, probe: () => frame(models) };
  const result = await suggest(native('antigravity'), opts);
  assert.deepEqual(recommendations(result), { fast: ['gemini-flash-low', undefined], balanced: ['gemini-main-medium', undefined],
    strong: ['gemini-main-high', undefined], deep: ['gemini-main-xhigh', undefined], max: ['gemini-main-xhigh', undefined] });
  assert.deepEqual(result.items.map((item) => item.title), ['沿用宿主默认', 'Gemini Pro Orchestrator', 'Gemini Main', 'Gemini Flash', 'Single (Medium)']);
  assert.deepEqual(result.items[2].children.items.map((item) => [item.set.model, item.unset]), ['low', 'medium', 'high', 'xhigh']
    .map((effort) => [`gemini-main-${effort}`, ['reasoningEffort']]));
  assert.deepEqual(result.items[1].unset, ['reasoningEffort']);
  const modelOnly = await suggest(native('antigravity', { targets: ['model'] }), opts);
  assert.deepEqual(modelOnly.items[0].unset, ['model']);
  assert.ok(modelOnly.items[2].children.items.every((item) => !item.unset && Object.keys(item.set).join() === 'model'));
  const external = await suggest({ ...objectRequest, dependencyValues: { executor: 'agy' }, providerConfigValues: {
    subagentCommands: [{ key: 'agy', adapter: 'antigravity' }],
  } }, opts);
  assert.equal(external.items[0].title, '沿用后端默认');
  assert.deepEqual(recommendations(external), recommendations(result));
});

test('Claude recommendations use only the online alias directory and share the same offline policy across consumers', async () => {
  const models = ['opus', 'sonnet', 'haiku'].map((id) => ({ id, efforts: id === 'haiku' ? [] : ['low', 'medium', 'high', 'xhigh', 'max'] }));
  const online = { env: {}, probe: () => frame(models) };
  const result = await suggest(native('claude'), online);
  assert.ok(!result.items.some((item) => item.set?.model === 'fable'));
  assert.deepEqual(recommendations(result), { fast: ['haiku', undefined], balanced: ['sonnet', 'medium'],
    strong: ['opus', 'high'], deep: ['opus', 'xhigh'], max: ['opus', 'xhigh'] });
  const fastSeparate = await suggest(native('claude', { hint: 'fast' }), { env: {}, probe: () => frame([
    { id: 'HAIKU', efforts: ['medium'], defaultEffort: 'medium' },
  ]) });
  assert.deepEqual(recommendations(fastSeparate).fast, ['HAIKU', undefined]);
  assert.equal(fastSeparate.items[1].children.items[0].recommended, true);
  const unavailable = { env: {}, probe: () => frame([], { environment: { status: 'unavailable', code: 'notAuthenticated' } }) };
  const offline = await suggest(native('claude'), unavailable);
  assert.equal(offline.status, 'ok');
  assert.match(offline.message, /built-in Claude model aliases/);
  assert.equal(offline.diagnostics[0].code, 'notAuthenticated');
  assert.deepEqual(offline.items.slice(1).map((item) => [item.set.model, item.source]), ['haiku', 'sonnet', 'opus', 'fable']
    .map((id) => [id, 'builtin']));
  assert.deepEqual(recommendations(offline), { fast: ['haiku', undefined], balanced: ['sonnet', 'medium'],
    strong: ['opus', 'high'], deep: ['fable', 'xhigh'], max: ['fable', 'xhigh'] });
  assert.equal(offline.items[1].unset, undefined);
  const external = { ...objectRequest, consumer: { name: 'agent-advisor' }, dependencyValues: { executor: 'external' },
    providerConfigValues: { subagentCommands: [{ key: 'external', adapter: 'claude-code' }] } };
  assert.deepEqual(recommendations(await suggest(external, online)), recommendations(result));
  assert.deepEqual(recommendations(await suggest(external, unavailable)), recommendations(offline));
  const configured = { ...external, providerConfigValues: { subagentCommands: [
    { key: 'external', adapter: 'claude-code', models: [{ id: 'haiku', efforts: [] }, { id: 'manual' }] },
  ] } };
  const mixed = await suggest(configured, unavailable);
  assert.deepEqual(mixed.items.slice(1).map((item) => [item.set.model, item.source]), [
    ['haiku', 'configured'], ['manual', 'configured'], ['sonnet', 'builtin'], ['opus', 'builtin'], ['fable', 'builtin'],
  ]);
  assert.deepEqual(mixed.items[1].unset, ['reasoningEffort']);
  assert.equal((await suggest(native('claude'), { env: {}, probe: () => frame([]) })).items[4].set.model, 'fable');
});

test('a Claude override limits model, effort and profile suggestions to its configured directory', async () => {
  const directory = { dependencyValues: { executor: 'external' }, providerConfigValues: { subagentCommands: [
    { key: 'external', adapter: 'claude-code', modelsPolicy: 'override', models: [
      { id: 'first' }, { id: 'sonnet', default: true, efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ] },
  ] } };
  const options = { env: {}, probe: assert.fail };
  const models = await suggest({ ...request, ...directory }, options);
  assert.deepEqual(models.items.map(({ value, source }) => [value, source]), [['first', 'configured'], ['sonnet', 'configured']]);
  assert.equal(models.message, undefined);

  const profile = await suggest({ ...objectRequest, ...directory }, options);
  assert.deepEqual(profile.items.slice(1).map((item) => item.set.model), ['first', 'sonnet']);
  assert.deepEqual(recommendations(profile), { fast: ['sonnet', 'medium'], balanced: ['sonnet', 'medium'],
    strong: ['sonnet', 'medium'], deep: ['sonnet', 'medium'], max: ['sonnet', 'medium'] });
  assert.equal(profile.message, undefined);

  const efforts = { ...request, ...directory, provider: 'executor-efforts' };
  assert.deepEqual((await suggest(efforts, options)).items.map((item) => item.value), ['low', 'medium']);
  const excluded = await suggest({ ...efforts, dependencyValues: { ...directory.dependencyValues, model: 'opus' } }, options);
  assert.deepEqual(excluded.items, []);
});

test('custom profiles recommend a static default and preserve unknown effort while clearing explicitly unsupported effort', async () => {
  const req = { ...objectRequest, dependencyValues: { executor: 'custom' }, providerConfigValues: { subagentCommands: [
    { key: 'custom', adapter: 'custom', modelsPolicy: 'override', models: [
      { id: 'unknown' }, { id: 'none', efforts: [] }, { id: 'preferred', efforts: ['high'], default: true, defaultEffort: 'high' },
    ] },
  ] } };
  const result = await suggest(req, { env: {}, probe: assert.fail });
  assert.equal(result.items[0].title, '沿用后端默认');
  assert.equal(result.items[1].unset, undefined);
  assert.deepEqual(result.items[2].unset, ['reasoningEffort']);
  assert.deepEqual(Object.values(recommendations(result)), Array(5).fill(['preferred', 'high']));
  const agy = { ...req, providerConfigValues: { subagentCommands: [{
    key: 'custom', adapter: 'antigravity', modelsPolicy: 'override', models: [
      { id: 'gemini-orchestrator', default: true, efforts: [] }, { id: 'normal', efforts: [] },
    ],
  }] } };
  assert.deepEqual(Object.values(recommendations(await suggest(agy, { env: {}, probe: assert.fail }))), Array(5).fill(['normal', undefined]));
});

test('scalar suggestions distinguish explicitly unsupported, inherited, missing and failed effort menus', async () => {
  const models = [{ id: 'none', efforts: [] }, { id: 'own', efforts: ['medium'] }, { id: 'inherited' }];
  const opts = { env: {}, probe: () => frame(models, { supportedEfforts: ['high'] }) };
  const req = { ...request, profile: 'codex', platform: 'codex', provider: 'executor-efforts' };
  const select = (model) => ({ ...req, dependencyValues: { model } });
  assert.equal((await suggest(select('none'), opts)).status, 'not-applicable');
  assert.deepEqual((await suggest(select('own'), opts)).items.map((item) => item.value), ['medium']);
  assert.deepEqual((await suggest(select('inherited'), opts)).items.map((item) => item.value), ['high']);
  assert.equal((await suggest(select('inherited'), { env: {}, probe: () => frame(models) })).status, 'no-probe');
  assert.equal((await suggest(select('inherited'), { env: {}, probe: () => { throw new Error('fixture failure'); } })).status, 'unavailable');
  assert.equal((await suggest({ ...req, profile: 'antigravity', platform: 'antigravity' }, { env: {}, probe: assert.fail })).status, 'not-applicable');
  assert.equal((await suggest({ ...req, profile: 'claude', platform: 'claude', dependencyValues: { model: 'sonnet' } },
    { env: {}, probe: () => undefined })).items.every((item) => item.source === 'builtin'), true);
  const descriptions = (await suggest({ ...req, provider: 'executor-models' }, opts)).items.map((item) => item.description);
  assert.deepEqual(descriptions, ['No separate reasoning effort.', 'Reasoning efforts: medium.', 'Reasoning efforts: high.']);
});

test('large directories remain within the item limits without discarding an eligible late recommendation', async () => {
  const models = [
    ...Array.from({ length: 127 }, (_, i) => ({ id: `model-${i}` })),
    { id: 'last', isDefault: true, efforts: Array.from({ length: 64 }, (_, i) => `effort-${i}`), defaultEffort: 'effort-63' },
  ];
  const result = await suggest(native('codex'), { env: {}, probe: () => frame(models) });
  assert.equal(result.items.length, 128);
  const model = result.items.find((item) => item.set?.model === 'last');
  assert.equal(model.children.items.length, 32);
  assert.deepEqual(Object.values(recommendations(result)), Array(5).fill(['last', 'effort-63']));
  // An executor-wide menu is compact in Adapter v6, but each object-profile
  // model expands that same menu, potentially exceeding AW's byte limit.
  const menu = Array.from({ length: 128 }, (_, i) => `effort-${i}-${'x'.repeat(230)}`);
  const expanded = await suggest(native('codex'), { env: {}, probe: () => frame(
    models.map(({ id, isDefault }) => ({ id, isDefault })), { supportedEfforts: menu, defaultEffort: menu.at(-1) }) });
  assert.ok(Buffer.byteLength(JSON.stringify(expanded)) <= 1024 * 1024);
  assert.deepEqual(Object.values(recommendations(expanded)), Array(5).fill(['last', menu.at(-1)]));
});
