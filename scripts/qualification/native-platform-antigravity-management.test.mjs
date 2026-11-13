import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeAntigravityLocalManagement } from './native-platform-antigravity-management.mjs';
import { probeClientInterfaces } from './native-platform-interface-probes.mjs';
import { prepareEnvironment, renderPackage } from './native-platform-runtime.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agy-management-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), neutral = path.join(root, 'neutral');
  await fs.mkdir(project); await fs.mkdir(neutral);
  return { root, project, neutral, env: await prepareEnvironment(root) };
}
const result = stdout => ({ status: 'observed', stdout, exitCode: 0 });
async function nativeFixture(ctx, { projectVisible = true, staleDynamic = false } = {}) {
  let installed = false, installs = 0;
  const cache = path.join(ctx.env.HOME, '.gemini/config/plugins/aw-local-management-user');
  const projectDirectory = path.join(ctx.project, '.agents/plugins/aw-qualification-aw-local-management-project');
  const command = async (id, args, cwd) => {
    if (args[1] === 'validate') {
      const manifest = JSON.parse(await fs.readFile(path.join(args[2], '.antigravity-plugin/plugin.json'), 'utf8'));
      assert(['1.0.1', '1.0.2'].includes(manifest.version));
      assert((await fs.stat(path.join(args[2], 'skills/management-check/SKILL.md'))).isFile());
    }
    if (id.startsWith('user-install-')) {
      installs++;
      if (!(staleDynamic && installs === 3)) {
        await fs.rm(cache, { recursive: true, force: true });
        await fs.cp(args[2], cache, { recursive: true });
      }
      installed = true;
    }
    if (id === 'user-uninstall') { installed = false; await fs.rm(cache, { recursive: true }); }
    const present = await fs.stat(projectDirectory).then(() => true, () => false);
    if (args[0] === 'agents') return result(cwd === ctx.project && present ? 'management-observer (workspace plugin)' : 'Built-in agents only');
    const rows = [];
    if (installed) {
      const manifest = JSON.parse(await fs.readFile(path.join(cache, '.antigravity-plugin/plugin.json'), 'utf8'));
      rows.push({ name: 'aw-local-management-user', enabled: true, version: manifest.version, source: 'antigravity', path: cache });
    }
    if (projectVisible && cwd === ctx.project && present) rows.push({ name: 'aw-local-management-project', enabled: true });
    return result(JSON.stringify(rows));
  };
  return { command, cache, projectDirectory };
}

// Test Value Gate: current AW projection and scope layout must feed fresh native
// observations, and all three revisions must match actual consumer files.
test('checks version and same-version consumer bytes through fresh scope queries', async t => {
  const ctx = await fixture(t); const fake = await nativeFixture(ctx);
  const observed = await probeAntigravityLocalManagement(ctx, fake.command, renderPackage);
  assert.equal(observed.status, 'observed', JSON.stringify(observed));
  assert(observed.scopes.every(scope => scope.scopeEvidence === 'observed' && scope.removed));
  assert.deepEqual(observed.scopes[0].revisions.map(row => row.version), ['1.0.1', '1.0.2', '1.0.2']);
  assert(observed.scopes[0].revisions.every(row => row.consumers.every(consumer => consumer.matches)));
  assert.equal(observed.dynamicConsumerBytes, 'observed-at-native-inventory-path');
  assert.equal(observed.productionProfileChanged, false);
  await assert.rejects(fs.stat(fake.projectDirectory), { code: 'ENOENT' });
});

// Test Value Gate: process failure cannot be hidden by later successful queries.
test('stops immediately when the native process contract fails', async t => {
  const ctx = await fixture(t); const calls = [];
  const observed = await probeAntigravityLocalManagement(ctx, async id => {
    calls.push(id); return { status: 'failed', processFailure: 'cleanup-unconfirmed' };
  }, renderPackage);
  assert.deepEqual(calls, ['user-validate-1']);
  assert.equal(observed.status, 'unverified'); assert.match(observed.reason, /user-validate-1/u);
  assert.equal(observed.scopes.length, 1);
});

// Test Value Gate: neither successful publication nor raw agent output can
// silently turn an unconfirmed effective plugin scope into a qualified scope.
test('keeps a missing effective Project entry unverified', async t => {
  const ctx = await fixture(t); const fake = await nativeFixture(ctx, { projectVisible: false });
  const observed = await probeAntigravityLocalManagement(ctx, fake.command, renderPackage);
  assert.equal(observed.scopes[0].status, 'observed');
  assert.equal(observed.scopes[1].scopeEvidence, 'unverified');
  assert(observed.scopes[1].agentInventory, JSON.stringify(observed));
  assert.match(observed.scopes[1].agentInventory.target, /management-observer/u);
  assert.equal(observed.scopes[1].removed, true); assert.equal(observed.status, 'unverified');
});

// Test Value Gate: version metadata alone cannot hide an unchanged consumer copy.
test('rejects stale native bytes during a same-version refresh', async t => {
  const ctx = await fixture(t); const fake = await nativeFixture(ctx, { staleDynamic: true });
  const observed = await probeAntigravityLocalManagement(ctx, fake.command, renderPackage);
  assert.equal(observed.reason, 'native-consumer-content-mismatch');
  assert.equal(observed.scopes[0].revisions[2].version, '1.0.2');
  assert(observed.scopes[0].revisions[2].consumers.every(row => row.matches === false));
  assert.equal(observed.productionProfileChanged, false);
});

// Test Value Gate: report redaction must not destroy the native filesystem path
// before the real consumer oracle reads it; the returned report stays redacted.
test('reads raw native paths internally and redacts the completed management report', async t => {
  const ctx = await fixture(t); const fake = await nativeFixture(ctx); let installs = 0;
  const completed = stdout => ({ stdout, stderr: '', exitCode: 0, signal: null, timedOut: false,
    cancelled: false, maxBufferExceeded: false, terminationReason: 'complete',
    containmentMode: 'verified-observed', gradingEvidenceAccepted: true, descendantCleanupGuaranteed: false });
  const report = await probeClientInterfaces('antigravity', { executable: '/fixed/antigravity', prefix: [] }, ctx,
    async (launcher, args, options) => {
      if (args[0] === '--version') return completed('1.3.4');
      if (args[0] === '--help') return completed('Usage: antigravity [command]\nplugin');
      if (args.join(' ') === 'plugin --help') return completed('Usage: antigravity plugin <command> [arguments]\nCommands:\n  list [--json]          List installed plugins\n');
      const id = args[1] === 'install' ? `user-install-${++installs}`
        : args[1] === 'uninstall' ? 'user-uninstall' : args.join('-');
      const result = await fake.command(id, args, options.cwd);
      return completed(result.stdout);
    }, { localManagement: true });
  assert.equal(report.management.status, 'observed', JSON.stringify(report.management));
  assert.equal(report.management.scopes[0].revisions.length, 3);
  assert(!JSON.stringify(report).includes(ctx.root));
  assert.match(report.management.scopes[0].revisions[0].consumers[0].path, /<TEMP_ROOT>/u);
});
