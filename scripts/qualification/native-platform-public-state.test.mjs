import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePublicClientPath } from './native-platform-public-aw.mjs';
import { verifyCodexSharedProviderRemoval } from './native-platform-public-cases.mjs';
import { assertPublicStatus, expectedOpenCodeObservation, readPublicRemovedNativeScope, readPublicNativeState, readDynamicConsumerContent } from './native-platform-public-state.mjs';
import { clients } from './native-platform-runtime.mjs';

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
  const ctx = { root, clientBin, platform: 'gemini', env: { PATH: '/unrelated/client-bin' },
    launcher: { executable: process.execPath, prefix: [entry] } };
  assert.equal(await preparePublicClientPath(ctx), entry);
  assert.deepEqual(ctx.env.PATH.split(path.delimiter), [clientBin, path.dirname(process.execPath),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.equal(await fs.realpath(path.join(clientBin, 'gemini')), entry);
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
