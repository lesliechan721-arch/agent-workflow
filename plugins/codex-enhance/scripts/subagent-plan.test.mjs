import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectExecution } from '../skills/codex-subagent-guide/scripts/runtime/plan.mjs';

const resourceRoot = fileURLToPath(new URL('../skills/codex-subagent-guide/', import.meta.url));

function select(command, request = {}) {
  return selectExecution({
    installedIdentity: { pluginName: 'codex-enhance' }, resourceRoot,
    effectiveValues: { subagentCommands: [{ key: 'selected', ...command }] },
  }, { executor: 'selected', ...request });
}

// Test Value Gate: observe the public execution plan consumed by the worker;
// omitted configuration must become explicit wire values without backend argv.
test('normalizes communication and Codex controls without changing backend args', () => {
  const defaults = select({ adapter: 'codex', args: ['--sandbox', 'workspace-write'] });
  assert.equal(defaults.communication, true);
  assert.deepEqual(defaults.codex, { cliSource: 'auto', bypassHookTrust: false });
  assert.deepEqual(defaults.executor.args, ['--sandbox', 'workspace-write']);
  for (const cliSource of ['auto', 'cli', 'app']) {
    for (const bypassHookTrust of [false, true]) {
      const plan = select({ adapter: 'codex', codexProfile: 'review',
        codexCliSource: cliSource, codexBypassHookTrust: bypassHookTrust, communication: false });
      assert.equal(plan.communication, false);
      assert.deepEqual(plan.codex, { cliSource, bypassHookTrust, profile: 'review' });
      assert.deepEqual(plan.executor.args, []);
    }
  }
  assert.deepEqual(select({ adapter: 'codex', codexBypassHookTrust: true,
    communication: false }).codex, { cliSource: 'auto', bypassHookTrust: true });
});

// Test Value Gate: every supported branch has a fixed installed entrypoint or
// retains its custom command; Codex-only options cannot leak to another backend.
test('plans all adapters with the installed communication choice', () => {
  for (const adapter of ['codex', 'claude-code', 'antigravity', 'oracle', 'custom']) {
    const command = adapter === 'custom'
      ? { adapter, mode: 'workspace', command: process.execPath } : { adapter };
    for (const communication of [undefined, false, true]) {
      const plan = select({ ...command, ...(communication === undefined ? {} : { communication }) });
      assert.equal(plan.communication, communication ?? true);
      assert.equal(plan.mode, adapter === 'oracle' ? 'bundle' : 'workspace');
      assert.equal(Object.hasOwn(plan, 'codex'), adapter === 'codex');
      if (adapter === 'antigravity') assert.equal(plan.entrypoint,
        path.join(resourceRoot, 'scripts/adapters/antigravity-v5.mjs'));
    }
  }
});

// Test Value Gate: malformed installed controls must fail before spawning a
// backend, including foreign controls that might otherwise bypass trust checks.
test('rejects invalid controls and duplicate dedicated/raw Codex profiles', () => {
  const invalid = [
    ...['false', 0, null].map((communication) => ({ adapter: 'codex', communication })),
    ...['path', '', false, null].map((codexCliSource) => ({ adapter: 'codex', codexCliSource })),
    ...['false', 0, null].map((codexBypassHookTrust) => ({ adapter: 'codex', codexBypassHookTrust })),
    { adapter: 'antigravity', mode: 'bundle' },
    ...['claude-code', 'antigravity', 'oracle', 'custom'].flatMap((adapter) =>
      ['codexProfile', 'codexCliSource', 'codexBypassHookTrust'].map((key) => ({
        adapter, ...(adapter === 'custom' ? { command: process.execPath, mode: 'workspace' } : {}),
        [key]: key === 'codexBypassHookTrust' ? false : key === 'codexCliSource' ? 'auto' : 'review',
      }))),
  ];
  for (const command of invalid) assert.throws(() => select(command), { code: 'executorInvalid' });
  for (const args of [['--profile', 'raw'], ['--profile=raw'], ['-p', 'raw'], ['-praw']]) {
    assert.throws(() => select({ adapter: 'codex', codexProfile: 'selected', args }),
      { code: 'adapterArgumentConflict' });
    assert.deepEqual(select({ adapter: 'codex', args }).executor.args, args);
  }
});

// Test Value Gate: installed permissions must survive into the execution plan,
// independent of communication, without adding controls to unrelated adapters.
test('normalizes permission modes only for the supported backend branches', () => {
  for (const adapter of ['codex', 'claude-code', 'antigravity']) {
    assert.equal(select({ adapter }).permissionMode, 'default');
    for (const permissionMode of ['default', 'auto', 'full-access']) {
      for (const communication of [false, true]) {
        const plan = select({ adapter, permissionMode, communication });
        assert.equal(plan.permissionMode, permissionMode);
        assert.equal(plan.communication, communication);
        assert.deepEqual(plan.executor.args, []);
      }
    }
    for (const permissionMode of ['skip', '', false, null]) {
      assert.throws(() => select({ adapter, permissionMode }), { code: 'executorInvalid' });
    }
  }
  for (const adapter of ['oracle', 'custom']) {
    const command = { adapter, ...(adapter === 'custom' ? { mode: 'workspace', command: process.execPath } : {}) };
    assert.equal(Object.hasOwn(select(command), 'permissionMode'), false);
    for (const permissionMode of ['default', 'auto', 'full-access']) {
      assert.throws(() => select({ ...command, permissionMode }), { code: 'executorInvalid' });
    }
  }
});
