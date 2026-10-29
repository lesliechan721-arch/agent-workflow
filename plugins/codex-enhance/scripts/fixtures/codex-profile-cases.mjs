import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProfile, convertProfile, tomlValue, parseConfigArgument } from '../../skills/codex-subagent-guide/scripts/adapters/codex-profile.mjs';
import { codexConfiguration } from '../../skills/codex-subagent-guide/scripts/adapters/codex-v5.mjs';
import { mapHookState, sessionHookSource } from '../../skills/codex-subagent-guide/scripts/adapters/codex-hooks.mjs';

// Test Value Gate: use the delivered parser and adapter configuration boundary
// to protect priority, lossless values, trust provenance and secret-free errors.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-profile-cases-'));
test.after(() => fs.rm(root, { recursive: true, force: true }));
const plain = (value) => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? Number(item) : item));
const request = (args = [], execution = {}) => ({ args, execution, workspace: root, run: { id: 'Ab_cd-0123A' }, codex: { cliSource: 'cli', bypassHookTrust: false } });
async function profile(t, text) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(root, 'home-')));
  await fs.writeFile(path.join(home, 'test.config.toml'), text);
  return { environment: { CODEX_HOME: home, HOME: home }, request: { ...request(), codex: { ...request().codex, profile: 'test' } }, file: path.join(home, 'test.config.toml') };
}
const command = (text) => [{ hooks: [{ type: 'command', command: text }] }];
const layer = (type, config, extra = {}) => ({ name: { type, ...(type === 'user' ? { file: '/base.config.toml' } : {}) }, config, ...extra });

test('TOML conversion preserves quoted keys, arrays and startup/thread precedence', async (t) => {
  const f = await profile(t, `model = "profile-model"\nmodel_reasoning_effort = "low"\nmodel_catalog_json = "/catalog.json"\nmodel_provider = "provider.with.dot"\n[model_providers."provider.with.dot"]\nbase_url = "http://localhost"\nhttp_headers = { "X.Custom" = "secret" }\n[features]\nhooks = false\ncode_mode = { enabled = true }\n[mcp_servers."tools.with.dot"]\ncommand = "tool"\nargs = ["space and quote \\\"", "中文"]\n[plugins."name.with.dot"]\nenabled = true\n`);
  f.request.args = ['-c', 'model_reasoning_effort="high"', '-c', 'features.code_mode.enabled=false', '-c', 'model_providers."provider.with.dot".name="chosen"'];
  f.request.execution.model = 'task-model';
  const c = await codexConfiguration(f.request, f.environment, []);
  const overrides = c.argv.filter((_, index) => c.argv[index - 1] === '-c').map(parseConfigArgument);
  const launch = Object.assign({}, ...overrides);
  assert.equal(launch.model_provider, 'provider.with.dot');
  assert.equal(launch.model_providers['provider.with.dot'].name, 'chosen');
  assert.equal(launch.model_providers['provider.with.dot'].http_headers['X.Custom'], 'secret');
  assert.equal(launch.features.code_mode.enabled, false);
  assert.equal(launch.features.hooks, false);
  assert.equal(c.thread.config.model, 'task-model');
  assert.equal(c.thread.config.model_reasoning_effort, 'high');
  assert.equal(c.thread.config.model_provider, undefined);
  assert.equal(c.thread.config.bypass_hook_trust, false);
  assert.deepEqual(c.thread.config.mcp_servers['tools.with.dot'].args, ['space and quote "', '中文']);
  assert.equal(c.thread.config.plugins['name.with.dot'].enabled, true);
  assert.equal(c.thread.cwd, root);
});

test('serializes actual TOML values rather than JSON objects', () => {
  for (const value of [{ 'a.b': { key: 'newline\nquote"' }, values: [1, true, '中文'] }, [], 'hello']) {
    assert.deepEqual(plain(parseProfile(`v=${tomlValue(value)}`).v), value);
  }
});

test('ignores unsupported representations without losing supported siblings or exposing values', () => {
  const diagnostics = [];
  const result = convertProfile(parseProfile(`model="keep"\nmodel_instructions_file="relative-secret"\nreview_model="hidden"\nbypass_hook_trust=true\npermissions={secret="hidden"}\n[features]\nhooks=true\nfuture_secret=true\n[model_providers.bad]\nname="safe"\nauth={command="credential-secret"}\n`), { diagnostics });
  assert.equal(result.model, 'keep');
  assert.equal(result.model_instructions_file, undefined);
  assert.equal(result.features.hooks, true);
  assert.equal(result.model_providers.bad, undefined);
  assert(diagnostics.some((item) => item.code === 'profileFieldIrrelevant'));
  assert(diagnostics.some((item) => item.field === 'bypass_hook_trust'));
  assert(!JSON.stringify(diagnostics).includes('credential-secret'));
  assert(!JSON.stringify(diagnostics).includes('relative-secret'));
});

test('rejects invalid supported values and preserves unknown TOML values as ignored fields', () => {
  for (const text of ['model=42', 'model_context_window=9007199254740993', 'model_context_window=1.0', 'tool_output_token_limit=inf', 'model=1979-05-27T07:32:00Z', 'model=[1]']) {
    assert.throws(() => convertProfile(parseProfile(text)), { code: 'profileValueInvalid' });
  }
  assert.throws(() => parseProfile('model=['), { code: 'profileValueInvalid' });
  const diagnostics = [];
  assert.deepEqual(plain(convertProfile(parseProfile('future_date=1979-05-27T07:32:00Z\nmodel="ok"'), { diagnostics })), { model: 'ok' });
  assert.equal(diagnostics[0].code, 'profileFieldIgnored');
});

test('raw profile shares the read path; explicit duplicates and bypass aliases fail', async (t) => {
  const f = await profile(t, 'model="profile"\nmodel_reasoning_effort="low"');
  const raw = request(['-ptest'], { reasoningEffort: 'high' });
  const c = await codexConfiguration(raw, f.environment);
  assert.equal(c.thread.config.model, 'profile');
  assert.equal(c.thread.config.model_reasoning_effort, 'high');
  assert.equal(c.turn.effort, 'high');
  for (const args of [['--profile', 'test'], ['-c', 'bypass_hook_trust=true'], ['--dangerously-bypass-hook-trust']]) {
    await assert.rejects(codexConfiguration({ ...f.request, args }, f.environment));
  }
  await assert.rejects(codexConfiguration(request(['-c', 'model="raw"'], { model: 'explicit' }), f.environment));
  await assert.rejects(codexConfiguration(request(['-c', 'model_reasoning_effort="low"'], { reasoningEffort: 'high' }), f.environment));
  await assert.rejects(codexConfiguration({ ...f.request, codex: { ...f.request.codex, profile: '../test' } }, f.environment), { code: 'profileValueInvalid' });
  await assert.rejects(codexConfiguration({ ...f.request, codex: { ...f.request.codex, profile: 'missing' } }, f.environment), { code: 'profileUnreadable' });
});

test('hook conversion skips whole unsupported events and rejects malformed supported fields', () => {
  const diagnostics = [];
  const value = convertProfile(parseProfile(`[[hooks.SessionEnd]]\nhooks=[{type="command",command="do-not-log"},{type="mcp_tool",server="x",tool="y"}]\n[[hooks.Stop]]\nhooks=[{type="command",command="keep",command_windows="windows"}]\n[[hooks.PreToolUse]]\nmatcher="shell"\nhooks=[{type="agent"}]`), { diagnostics });
  assert.equal(value.hooks.SessionEnd, undefined);
  assert.equal(value.hooks.PreToolUse, undefined);
  assert.equal(value.hooks.Stop[0].hooks[0].command_windows, 'windows');
  assert.equal(diagnostics.length, 2);
  assert(!JSON.stringify(diagnostics).includes('do-not-log'));
  assert.throws(() => convertProfile(parseProfile('[[hooks.Stop]]\nhooks=[{type="command",command="x",timeout=-1}]')), { code: 'profileValueInvalid' });
  assert.throws(() => convertProfile(parseProfile('[[hooks.SessionEnd]]\nhooks=[{type="mcp_tool",server="x",tool="y"}]'), { explicit: true }), { code: 'parameterUnavailable' });
});

test('hook state uses user and session layers, includes disabled layers and maps before thread start', async (t) => {
  const f = await profile(t, '[[hooks.SessionStart]]\nhooks=[{type="command",command="fixture"}]');
  const c = await codexConfiguration(f.request, f.environment);
  const original = `${f.file}:session_start:0:0`;
  const target = `${sessionHookSource()}:session_start:0:0`;
  mapHookState(c, { layers: [
    layer('sessionFlags', { hooks: { state: { [original]: { trusted_hash: 'existing-digest' } } } }),
    layer('project', { hooks: { state: { [original]: { enabled: true, trusted_hash: 'project-cannot-trust' } } } }),
    layer('user', { hooks: { state: { [original]: { enabled: false } } } }, { disabledReason: 'disabled configuration layer' }),
  ] });
  assert.deepEqual(c.thread.config.hooks.state[target], { enabled: false, trusted_hash: 'existing-digest' });
  assert.deepEqual(c.thread.config.hooks.state[original], { enabled: false, trusted_hash: 'existing-digest' });
  assert.equal(c.argv.some((arg) => arg.includes('hooks=')), false);
});

test('raw hook arrays replace profile arrays without inheriting profile trust', async (t) => {
  const f = await profile(t, '[[hooks.Stop]]\nhooks=[{type="command",command="same"}]');
  f.request.args = ['-c', 'hooks.Stop=[{hooks=[{type="command",command="same"}]}]', '-c', `hooks.state.${tomlValue(`${f.file}:stop:0:0`)}={enabled=false,trusted_hash="explicit-original-digest"}`];
  const c = await codexConfiguration(f.request, f.environment);
  mapHookState(c, { layers: [layer('user', { hooks: { state: { [`${f.file}:stop:0:0`]: { trusted_hash: 'profile-digest' } } } })] });
  assert.equal(c.thread.config.hooks.state[`${sessionHookSource()}:stop:0:0`], undefined);
  assert.deepEqual(plain(c.thread.config.hooks.Stop), command('same'));
});

test('raw original hook state maps at its priority while explicit runtime state remains final', async (t) => {
  const f = await profile(t, '[[hooks.SessionStart]]\nhooks=[{type="command",command="fixture"}]');
  const original = `${f.file}:session_start:0:0`;
  const target = `${sessionHookSource()}:session_start:0:0`;
  await fs.appendFile(f.file, `\n[hooks.state.${tomlValue(original)}]\nenabled=true\ntrusted_hash="profile-digest"\n`);
  const layers = [layer('user', { hooks: { state: { [original]: { enabled: true, trusted_hash: 'base-digest' } } } })];
  for (const bypassHookTrust of [false, true]) {
    f.request.codex.bypassHookTrust = bypassHookTrust;
    f.request.args = ['-c', `hooks.state.${tomlValue(original)}={enabled=false,trusted_hash="explicit-original-digest"}`];
    const c = await codexConfiguration(f.request, f.environment);
    mapHookState(c, { layers });
    assert.deepEqual(c.thread.config.hooks.state[original], { enabled: false, trusted_hash: 'explicit-original-digest' });
    assert.deepEqual(c.thread.config.hooks.state[target], { enabled: false, trusted_hash: 'explicit-original-digest' });
    assert.equal(c.thread.config.bypass_hook_trust, bypassHookTrust);

    f.request.args.push('-c', `hooks.state.${tomlValue(target)}={enabled=true,trusted_hash="explicit-target-digest"}`);
    const explicitTarget = await codexConfiguration(f.request, f.environment);
    mapHookState(explicitTarget, { layers });
    assert.deepEqual(explicitTarget.thread.config.hooks.state[original], { enabled: false, trusted_hash: 'explicit-original-digest' });
    assert.deepEqual(explicitTarget.thread.config.hooks.state[target], { enabled: true, trusted_hash: 'explicit-target-digest' });

    const conflicting = await codexConfiguration(f.request, f.environment);
    assert.throws(() => mapHookState(conflicting, { layers: [layer('sessionFlags', { hooks: { SessionStart: command('different-handler'), state: { [target]: { trusted_hash: 'other-digest' } } } }), ...layers] }), { code: 'profileHookMappingUnsupported' });
  }
});

test('hook state unavailable and slot conflicts fail closed; bypass retains disabled state', async (t) => {
  const f = await profile(t, '[[hooks.Stop]]\nhooks=[{type="command",command="fixture"}]');
  const diagnostics = [];
  f.request.codex.bypassHookTrust = true;
  const c = await codexConfiguration(f.request, f.environment, diagnostics);
  const target = `${sessionHookSource()}:stop:0:0`;
  assert.throws(() => mapHookState(c, { config: {} }), { code: 'profileHookStateUnavailable' });
  assert.throws(() => mapHookState(c, { layers: [layer('sessionFlags', { hooks: { state: { [target]: { trusted_hash: 'other' } } } })] }), { code: 'profileHookMappingUnsupported' });
  mapHookState(c, { layers: [layer('user', { hooks: { state: { [`${f.file}:stop:0:0`]: { enabled: false } } } })] });
  assert.deepEqual(c.thread.config.hooks.state[target], { enabled: false });
  assert.equal(c.thread.config.bypass_hook_trust, true);
  assert.equal(diagnostics[0].code, 'hookTrustBypassed');
  assert.equal(sessionHookSource('win32'), 'C:\\<session-flags>\\config.toml');
});

test('private MCP server cannot be replaced by profile or explicit config', async (t) => {
  const f = await profile(t, `[mcp_servers.aw_parent_0123456789abcdef0123456789abcdef]\nenabled=false`);
  await assert.rejects(codexConfiguration(f.request, f.environment), { code: 'adapterArgumentsInvalid' });
});
