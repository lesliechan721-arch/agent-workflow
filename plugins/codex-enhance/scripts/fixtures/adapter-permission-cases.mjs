import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityArguments, antigravityFullAccess } from '../../skills/codex-subagent-guide/scripts/adapters/antigravity-arguments.mjs';
import { claudeArguments, negotiateClaude, executeClaude } from '../../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs';
import { checkCodexArguments, negotiateCodex, codexConfiguration } from '../../skills/codex-subagent-guide/scripts/adapters/codex-v5.mjs';
import { PassThrough } from 'node:stream';
import { deferred } from '../../skills/codex-subagent-guide/scripts/adapters/common.mjs';
import { negotiateAntigravity } from '../../skills/codex-subagent-guide/scripts/adapters/antigravity-v5.mjs';
import { negotiateOracle } from '../../skills/codex-subagent-guide/scripts/adapters/oracle-v5.mjs';
import { permissionModeFallback } from '../../skills/codex-subagent-guide/scripts/adapters/permission-mode.mjs';

// Test Value Gate: selected permissions must reach the native control surface,
// preserve profile/default values, and reject duplicate explicit controls before IO.
test('permission modes map precisely and default preserves explicit arguments', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'review.config.toml'), 'approval_policy="never"\napprovals_reviewer="user"\nsandbox_mode="read-only"\nmodel="kept-model"\n');
  const request = { args: [], execution: {}, workspace: root, run: { id: 'a'.repeat(32) }, codex: { cliSource: 'cli', bypassHookTrust: false, profile: 'review' } };
  const environment = { CODEX_HOME: root };
  const defaults = await codexConfiguration({ ...request, permissionMode: 'default' }, environment);
  assert.equal(defaults.thread.config.approval_policy, 'never');
  assert.equal(defaults.thread.config.approvals_reviewer, 'user');
  assert.equal(defaults.thread.config.sandbox_mode, 'read-only');
  const auto = await codexConfiguration({ ...request, permissionMode: 'auto', args: ['-sread-only'] }, environment);
  assert.equal(auto.thread.config.approval_policy, 'on-request');
  assert.equal(auto.thread.config.approvals_reviewer, 'auto_review');
  assert.equal(auto.thread.config.sandbox_mode, 'read-only');
  assert.equal(auto.thread.config.model, 'kept-model');
  assert.equal(auto.thread.config.bypass_hook_trust, false);
  const full = await codexConfiguration({ ...request, permissionMode: 'full-access' }, environment);
  assert.equal(full.thread.config.approval_policy, 'never');
  assert.equal(full.thread.config.sandbox_mode, 'danger-full-access');
  assert.equal(full.thread.config.bypass_hook_trust, false);
  for (const args of [['-c', '"approval_policy".granular.rules=false'], ['--config', '"approvals_reviewer".anything=false']]) await assert.rejects(codexConfiguration({ ...request, permissionMode: 'auto', args }, environment), { code: 'adapterArgumentConflict' });
  await assert.rejects(codexConfiguration({ ...request, permissionMode: 'full-access', args: ['-c', '"sandbox_mode".anything=false'] }, environment), { code: 'adapterArgumentConflict' });
  for (const [mode, claude, agy] of [['default', [], []], ['auto', ['--permission-mode', 'auto'], ['--mode', 'auto']], ['full-access', ['--dangerously-skip-permissions'], ['--dangerously-skip-permissions']]]) {
    const selected = { ...request, permissionMode: mode };
    assert.deepEqual(claudeArguments(selected).slice(7), claude);
    assert.deepEqual(antigravityArguments(selected).slice(6), agy);
  }
  const explicit = { ...request, permissionMode: 'default', args: ['--dangerously-skip-permissions'] };
  assert.ok(claudeArguments(explicit).includes('--dangerously-skip-permissions'));
  assert.ok(antigravityArguments(explicit).includes('--dangerously-skip-permissions'));
  assert.equal(antigravityFullAccess(explicit), true);
  assert.equal(antigravityFullAccess({ ...explicit, args: ['--dangerously-skip-permissions=false'] }), false);
});

test('nondefault modes reject same-control argv in every supported spelling', () => {
  for (const permissionMode of ['auto', 'full-access']) {
    const request = { permissionMode, args: [], execution: {} };
    for (const args of [['-aon-request'], ['-a', 'never'], ['--ask-for-approval=on-request'], ['--full-auto'], ['--dangerously-bypass-approvals-and-sandbox'], ['-capproval_policy="never"'], ['--config', 'approvals_reviewer="auto_review"'], ['-c', 'approval_policy.granular.rules=false']]) assert.throws(() => checkCodexArguments({ ...request, args }), { code: 'adapterArgumentConflict' });
    for (const args of [['--permission-mode=auto'], ['--permission-mode', 'auto'], ['--dangerously-skip-permissions']]) assert.throws(() => claudeArguments({ ...request, args }), { code: 'adapterArgumentConflict' });
    assert.doesNotThrow(() => claudeArguments({ ...request, args: ['--allow-dangerously-skip-permissions'] }));
    for (const args of [['--mode=auto'], ['--mode', 'auto'], ['--dangerously-skip-permissions=false']]) assert.throws(() => antigravityArguments({ ...request, args }), { code: 'adapterArgumentConflict' });
  }
  for (const args of [['-sread-only'], ['--sandbox=workspace-write'], ['-c', 'sandbox_mode="read-only"']]) {
    assert.throws(() => checkCodexArguments({ permissionMode: 'full-access', args, execution: {} }), { code: 'adapterArgumentConflict' });
    assert.doesNotThrow(() => checkCodexArguments({ permissionMode: 'auto', args, execution: {} }));
  }
  assert.equal(permissionModeFallback('warning: --mode auto is not available for this account; continuing in the default mode.'), true);
  assert.equal(permissionModeFallback('auto mode enabled'), false);
});

// Test Value Gate: every builtin must check the selected executable even with
// communication disabled. Missing and non-runnable entries stay distinct.
test('all builtin negotiations check and fix their executable with communication disabled', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-environment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, negotiate] of [['codex', negotiateCodex], ['claude', negotiateClaude], ['agy', negotiateAntigravity], ['oracle', negotiateOracle]]) {
    const context = () => ({ request: { args: [], execution: {}, workspace: root, communication: false, permissionMode: 'auto', fileSelectors: [], codex: { cliSource: 'cli', bypassHookTrust: false } }, environment: { PATH: root }, diagnostics: [] });
    const missing = context();
    await assert.rejects(negotiate(missing), { code: name === 'codex' ? 'codexExecutableNotFound' : 'executableNotFound' });
    assert.equal(missing.initialization.environment.status, 'unavailable');
    assert.deepEqual(missing.initialization.capabilities, {});
    const target = path.join(root, name);
    await fs.writeFile(target, '#!/bin/false\n', { mode: 0o600 });
    const denied = context();
    await assert.rejects(negotiate(denied), { code: 'executableNotRunnable' });
    assert.equal(denied.initialization.environment.status, 'unavailable');
    await fs.unlink(target);
    await fs.symlink(await fs.realpath(process.execPath), target);
    const available = context(), candidate = await negotiate(available);
    assert.deepEqual(candidate.environment, { status: 'available' });
    assert.equal(candidate.executable.command, await fs.realpath(process.execPath));
    available.environment.PATH = '';
    assert.equal(candidate.executable.command, await fs.realpath(process.execPath));
    await fs.unlink(target);
  }
});

// Native diagnostics establish a mode fallback. Model prose can discuss one
// without changing the mode of the actual backend process.
test('Claude auto preserves a successful answer that discusses unavailable auto modes', async () => {
  const stdout = new PassThrough(), done = deferred(), controller = new AbortController();
  const answer = 'Auto is not supported for this account; continuing in the default mode. This is quoted documentation.';
  let exited = false;
  const backend = {
    child: { stdout }, done: done.promise,
    get exited() { return exited; }, get exitCode() { return 0; },
    async write(value) {
      const emit = (frame) => stdout.write(`${JSON.stringify(frame)}\n`);
      emit({ type: 'system', subtype: 'init', session_id: 'fixture-session', permissionMode: 'auto' });
      emit({ type: 'user', uuid: value.uuid });
      emit({ type: 'assistant' });
      emit({ type: 'result', subtype: 'success', session_id: 'fixture-session', num_turns: 1, is_error: false, result: answer });
    },
    async end() { exited = true; done.resolve(); },
  };
  const context = {
    request: { args: [], permissionMode: 'auto', execution: {}, run: { id: 'a'.repeat(32) } }, executable: { command: '/fake/claude', args: [] },
    signal: controller.signal, stopped: deferred(), prompt: 'Explain permission modes.', generationStarted: false,
    abort(code) { this.errorCode = code; controller.abort(); done.resolve(); },
    async prepareCommunication() {}, async spawn() { return backend; }, async ready() {}, async beginClosing() {},
  };
  const result = await executeClaude(context);
  assert.equal(result.state, 'completed');
  assert.equal(result.text, answer);
});
