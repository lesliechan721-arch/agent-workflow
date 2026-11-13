import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeAntigravityLocalManagement } from './native-platform-antigravity-management.mjs';
import { prepareEnvironment, renderPackage } from './native-platform-runtime.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agy-management-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), neutral = path.join(root, 'neutral');
  await fs.mkdir(project); await fs.mkdir(neutral);
  return { root, project, neutral, env: await prepareEnvironment(root) };
}
const result = stdout => ({ status: 'observed', stdout, exitCode: 0 });

// Test Value Gate: the candidate must use real AW projection and scope layout,
// remove only its newly published Project copy, and keep update qualification open.
test('observes candidate-only initial management through projected packages and fresh scope queries', async t => {
  const ctx = await fixture(t);
  let user = false;
  const projectDirectory = path.join(ctx.project, '.agents/plugins/aw-qualification-aw-local-management-project');
  const observed = await probeAntigravityLocalManagement(ctx, async (id, args, cwd) => {
    if (args[1] === 'validate') {
      const manifest = JSON.parse(await fs.readFile(path.join(args[2], '.antigravity-plugin/plugin.json'), 'utf8'));
      assert.equal(manifest.version, '1.0.1');
      assert.match(await fs.readFile(path.join(args[2], 'skills/management-check/SKILL.md'), 'utf8'), /No model request/u);
    }
    if (id === 'user-install') user = true;
    if (id === 'user-uninstall') user = false;
    const rows = user ? [{ name: 'aw-local-management-user', enabled: true }] : [];
    if (cwd === ctx.project && await fs.stat(projectDirectory).then(() => true, () => false)) rows.push({ name: 'aw-local-management-project', enabled: true });
    return result(JSON.stringify(rows));
  }, renderPackage);
  assert.equal(observed.status, 'observed');
  assert(observed.scopes.every(scope => scope.scopeEvidence === 'observed' && scope.removed));
  assert.equal(observed.updates, 'not-tested'); assert.equal(observed.dynamicConsumerBytes, 'not-tested');
  assert.equal(observed.productionProfileChanged, false);
  await assert.rejects(fs.stat(projectDirectory), { code: 'ENOENT' });
});

// Test Value Gate: a failed native command cannot be hidden by later successful
// inventories or trigger additional client commands.
test('stops immediately when the native process contract fails', async t => {
  const ctx = await fixture(t); const calls = [];
  const observed = await probeAntigravityLocalManagement(ctx, async id => {
    calls.push(id); return { status: 'failed', processFailure: 'cleanup-unconfirmed' };
  }, renderPackage);
  assert.deepEqual(calls, ['user-validate']);
  assert.equal(observed.status, 'unverified'); assert.match(observed.reason, /user-validate/u);
  assert.equal(observed.scopes.length, 1);
});

// Test Value Gate: an inventory that omits Project content must remain a scope
// gap even when AW publication and removal succeed.
test('keeps a missing effective Project entry unverified', async t => {
  const ctx = await fixture(t); let user = false;
  const observed = await probeAntigravityLocalManagement(ctx, async id => {
    if (id === 'user-install') user = true;
    if (id === 'user-uninstall') user = false;
    return result(JSON.stringify(user ? [{ name: 'aw-local-management-user', enabled: true }] : []));
  }, renderPackage);
  assert.equal(observed.scopes[0].status, 'observed');
  assert.equal(observed.scopes[1].scopeEvidence, 'unverified');
  assert.equal(observed.scopes[1].removed, true); assert.equal(observed.status, 'unverified');
});
