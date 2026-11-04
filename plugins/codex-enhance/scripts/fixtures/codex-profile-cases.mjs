import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseProfile, convertProfile, tomlValue, parseConfigArgument, mergeConfiguration, splitConfiguration, launchArguments } from '../../skills/codex-subagent-guide/scripts/adapters/codex-profile.mjs';
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
  assert.equal(launch.features.hooks, undefined);
  assert.equal(c.thread.config['features.hooks'], false);
  assert.equal(c.thread.config.features, undefined);
  assert.equal(c.thread.model, 'task-model');
  assert.equal(c.thread.config.model, undefined);
  assert.equal(c.thread.config.model_reasoning_effort, 'high');
  assert.equal(c.thread.config.model_provider, undefined);
  assert.equal(c.thread.config.bypass_hook_trust, false);
  assert.deepEqual(c.thread.config.mcp_servers['tools.with.dot'].args, ['space and quote "', '中文']);
  assert.equal(launch.plugins['name.with.dot'].enabled, true);
  assert.equal(c.thread.config.plugins, undefined);
  assert.equal(c.thread.cwd, root);
});

test('serializes actual TOML values rather than JSON objects', () => {
  for (const value of [{ 'a.b': { key: 'newline\nquote"' }, values: [1, true, '中文'] }, [], 'hello']) {
    assert.deepEqual(plain(parseProfile(`v=${tomlValue(value)}`).v), value);
  }
});

test('preserves complete native objects and sends unknown fields to startup', async (t) => {
  const f = await profile(t, `review_model="review"
plan_mode_reasoning_effort="medium"
future_value={nested=[1,2]}
include_future_context=true
mcp_oauth_credentials_store="file"
[features]
hooks=true
future_feature={enabled=true, extra="keep"}
[model_providers."provider.with.dot"]
auth={command="credential-secret",future="keep"}
aws={region="region"}
gateway_oauth={client="client"}
capabilities={future=true}
[mcp_servers."mcp.with.dot"]
url="https://localhost"
new_auth={kind="future"}
[permissions.dev]
future="keep"
filesystem={"relative-root"="read"}
[agents.research]
future="keep"
[skills]
future="keep"
[tools]
future={enabled=true}
`);
  const diagnostics = [];
  const c = await codexConfiguration(f.request, f.environment, diagnostics);
  const launch = Object.assign({}, ...c.argv.filter((_, index) => c.argv[index - 1] === '-c').map(parseConfigArgument));
  assert.equal(launch.review_model, 'review');
  assert.equal(launch.plan_mode_reasoning_effort, 'medium');
  assert.deepEqual(plain(launch.future_value), { nested: [1, 2] });
  assert.equal(launch.include_future_context, true);
  assert.equal(launch.mcp_oauth_credentials_store, 'file');
  assert.deepEqual(plain(launch.features.future_feature), { enabled: true, extra: 'keep' });
  assert.equal(c.thread.config['features.hooks'], true);
  assert.deepEqual(plain(launch.model_providers['provider.with.dot']), { auth: { command: 'credential-secret', future: 'keep' }, aws: { region: 'region' }, gateway_oauth: { client: 'client' }, capabilities: { future: true } });
  assert.deepEqual(c.thread.config.mcp_servers['mcp.with.dot'].new_auth, { kind: 'future' });
  assert.deepEqual(c.thread.config.permissions.dev, { future: 'keep', filesystem: { 'relative-root': 'read' } });
  assert.equal(c.thread.config.agents.research.future, 'keep');
  assert.equal(c.thread.config.skills.future, 'keep');
  assert.equal(c.thread.config.tools.future.enabled, true);
  assert.deepEqual(diagnostics, []);
  assert.equal(c.argv.includes('--strict-config'), false);
});

test('omits client-only and deprecated settings without changing profile files or sibling settings', async (t) => {
  // Test Value Gate: shared interactive profiles must still produce usable
  // backend configuration without forwarding inert settings or changing disk.
  const ignored = [
    'tui={}', 'desktop={}', 'file_opener="secret"',
    'js_repl_node_path="secret"', 'js_repl_node_module_dirs=["secret"]',
    'agents.job_max_runtime_seconds=30', 'orchestrator.skills=true',
    'ghost_snapshot.ignore_large_untracked_files=1', 'ghost_snapshot.ignore_untracked_files_over_bytes=1',
    'ghost_snapshot.ignore_large_untracked_dirs=1', 'ghost_snapshot.large_untracked_dir_warning_threshold=1',
    'ghost_snapshot.disable_warnings=true',
  ];
  const siblings = ['agents.research.future=true', 'orchestrator.mcp=true', 'ghost_snapshot.future="keep"'];
  const text = [...ignored, ...siblings].join('\n');
  const f = await profile(t, text);
  for (const input of [f.request, request([...ignored, ...siblings].flatMap((value) => ['-c', value]))]) {
    const diagnostics = [];
    const c = await codexConfiguration({ ...input, execution: { model: 'task-model', reasoningEffort: 'low' } }, f.environment, diagnostics);
    const launch = Object.assign({}, ...c.argv.filter((_, index) => c.argv[index - 1] === '-c').map(parseConfigArgument));
    assert.deepEqual(plain(launch), { orchestrator: { mcp: true }, ghost_snapshot: { future: 'keep' } });
    assert.deepEqual(c.thread.config, { agents: { research: { future: true } }, model_reasoning_effort: 'low', bypass_hook_trust: false });
    assert.equal(c.thread.model, 'task-model');
    assert.equal(c.turn.effort, 'low');
    assert.deepEqual(diagnostics, []);
  }
  assert.equal(await fs.readFile(f.file, 'utf8'), text);
});

test('rejects configuration identity changes and AW controls without exposing values', async (t) => {
  const forbidden = [
    ['allow_symlinked_codex_home', 'true'], ['profile', '"secret"'], ['profiles', '{secret={model="x"}}'],
  ];
  for (const [field, value] of forbidden) {
    for (const explicit of [false, true]) {
      const diagnostics = [];
      assert.throws(() => convertProfile(parseConfigArgument(`${field}=${value}`), { diagnostics, explicit }), { code: 'profileFieldUnsupported' });
      assert.equal(diagnostics[0].field, field);
      assert(!JSON.stringify(diagnostics).includes('secret'));
    }
  }
  for (const field of ['cwd', 'bypass_hook_trust']) assert.throws(() => convertProfile(parseConfigArgument(`${field}="secret"`)), { code: 'adapterArgumentsInvalid' });
  const f = await profile(t, 'profiles={secret={model="x"}}');
  f.request.args = ['-c', 'profiles={}'];
  await assert.rejects(codexConfiguration(f.request, f.environment), { code: 'profileFieldUnsupported' });
  await assert.rejects(codexConfiguration(request(['-c', 'profiles={secret={model="x"}}', '-c', 'profiles={}']), f.environment), { code: 'profileFieldUnsupported' });
  assert.equal(convertProfile(parseProfile('[agents.research]\nfuture=true')).agents.research.future, true);
  assert.equal(convertProfile(parseProfile('[orchestrator]\nmcp=true')).orchestrator.mcp, true);
});

test('keeps ordinary native validation with Codex and checks only consumed mappings', () => {
  for (const text of ['model=42', 'model=[1]']) assert.throws(() => convertProfile(parseProfile(text)), { code: 'profileValueInvalid' });
  assert.throws(() => convertProfile(parseProfile('mcp_servers=42')), { code: 'profileValueInvalid' });
  assert.throws(() => parseProfile('model=['), { code: 'profileValueInvalid' });
  const value = convertProfile(parseProfile('model_context_window=1.0\ntool_output_token_limit=-1\nfeatures="native-invalid"\napproval_policy={future=true}'));
  assert.equal(value.model_context_window, 1);
  assert.equal(value.tool_output_token_limit, -1n);
  assert.equal(value.features, 'native-invalid');
  assert.equal(value.approval_policy.future, true);
});

test('routes lossless numbers and explicitly rejects unpreservable TOML representations', () => {
  const value = convertProfile(parseProfile('model_context_window=9007199254740993\nproject_doc_max_bytes=1.0\ntool_output_token_limit=inf\n[agents.research]\nfuture=9007199254740993'));
  const split = splitConfiguration(value);
  assert.equal(split.thread.model_context_window, undefined);
  assert.equal(split.launch.model_context_window, 9007199254740993n);
  assert.equal(split.launch.tool_output_token_limit, Infinity);
  assert.equal(split.thread.project_doc_max_bytes, undefined);
  assert.equal(split.launch.project_doc_max_bytes, 1);
  assert.equal(split.launch.agents.research.future, 9007199254740993n);
  const launch = Object.assign({}, ...launchArguments(split.launch).filter((_, index, argv) => argv[index - 1] === '-c').map(parseConfigArgument));
  assert.equal(launch.model_context_window, 9007199254740993n);
  assert.equal(typeof launch.project_doc_max_bytes, 'number');
  assert.equal(launch.project_doc_max_bytes, 1);
  const diagnostics = [];
  const hooks = convertProfile(parseProfile('[[hooks.Stop]]\nhooks=[{type="command",command="secret",future=9007199254740993}]'));
  assert.throws(() => splitConfiguration(hooks, { diagnostics }), { code: 'profileConversionUnsupported' });
  assert(!JSON.stringify(diagnostics).includes('secret'));
  assert.throws(() => convertProfile({ unknown: null }), { code: 'profileConversionUnsupported' });
  assert.throws(() => convertProfile(parseProfile('future=-0.0')), { code: 'profileConversionUnsupported' });
  for (const value of ['1979-05-27T07:32:00Z', '1979-05-27T07:32:00.123456Z', '1979-05-27', '07:32:00']) {
    assert.throws(() => parseProfile(`future=${value}`), { code: 'profileConversionUnsupported' });
    assert.throws(() => parseConfigArgument(`future=${value}`), { code: 'profileConversionUnsupported' });
    assert.equal(parseProfile(`instructions=${tomlValue(value)}`).instructions, value);
  }
  assert.throws(() => tomlValue(new Date()), { code: 'profileConversionUnsupported' });
});

test('raw profile shares the read path; explicit duplicates and bypass aliases fail', async (t) => {
  const f = await profile(t, 'model="profile"\nmodel_reasoning_effort="low"');
  const raw = request(['-ptest'], { reasoningEffort: 'high' });
  const c = await codexConfiguration(raw, f.environment);
  assert.equal(c.thread.model, 'profile');
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

test('hook conversion preserves full objects and rejects known nonexecuting handlers', () => {
  for (const [event, type] of [['Stop', 'prompt'], ['PreToolUse', 'agent'], ['SessionEnd', 'mcp_tool']]) {
    const diagnostics = [];
    assert.throws(() => convertProfile(parseProfile(`[[hooks.${event}]]\nhooks=[{type="${type}",command="do-not-log"}]`), { diagnostics }), { code: 'profileFieldUnsupported' });
    assert.equal(diagnostics[0].field, `hooks.${event}[0].hooks[0].type`);
    assert(!JSON.stringify(diagnostics).includes('do-not-log'));
  }
  const value = convertProfile(parseProfile('[[hooks.Stop]]\nfuture="group"\nhooks=[{type="command",command="keep",command_windows="windows",timeout=-1,future={key="value"}}]'));
  assert.equal(value.hooks.Stop[0].future, 'group');
  assert.deepEqual(plain(value.hooks.Stop[0].hooks[0]), { type: 'command', command: 'keep', command_windows: 'windows', timeout: -1, future: { key: 'value' } });
  const diagnostics = [];
  assert.throws(() => convertProfile(parseProfile('[hooks.state."secret.path"]\nenabled="secret"'), { diagnostics }), { code: 'profileValueInvalid' });
  assert.equal(diagnostics[0].field, 'hooks.state[0].enabled');
  assert(!JSON.stringify(diagnostics).includes('secret'));
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

test('private MCP server cannot be replaced by any input or hidden by a later override', async (t) => {
  const f = await profile(t, `[mcp_servers.aw_parent_Ab_cd-0123A]\nenabled=false`);
  f.request.args = ['-c', 'mcp_servers={}'];
  await assert.rejects(codexConfiguration(f.request, f.environment), { code: 'adapterArgumentsInvalid' });
  const diagnostics = [];
  await assert.rejects(codexConfiguration(request(['-c', 'mcp_servers.aw_parent_Ab_cd-0123A.enabled=false', '-c', 'mcp_servers={}']), f.environment, diagnostics), { code: 'adapterArgumentsInvalid' });
  assert.equal(diagnostics[0].field, 'mcp_servers.<private>');
  assert(!JSON.stringify(diagnostics).includes('Ab_cd-0123A'));
  const sibling = await codexConfiguration(request(['-c', 'mcp_servers.aw_parent_unrelated.enabled=false']), f.environment);
  assert.equal(sibling.thread.config.mcp_servers.aw_parent_unrelated.enabled, false);
});

test('native aliases, shell representations, structured features and normalized keys preserve higher-layer meaning', () => {
  const base = parseProfile(`[agents]\nmax_concurrent_threads_per_session=2\n[agents.research]\nfuture=true\n[memories]\ndisable_on_external_context=false\n[shell_environment_policy]\nexclude=["LOWER"]\nset={KEEP="value"}\n[features]\ncode_mode={enabled=true,future="keep"}\nsleep_tool=false\n[permissions.dev.network.domains]\n" Example.COM.:443 "="allow"\n"[FE80::1%25EN0]:8080"="allow"\n[application.network.domains]\n"HOST."="allow"`);
  const raw = parseProfile(`[agents]\nmax_threads=5\n[memories]\nno_memories_if_mcp_or_web_search=true\n[shell_environment_policy]\nfilters={"TOKEN*"="drop"}\n[features]\ncode_mode=false\nsleep_tool={future="keep"}\n[permissions.dev.network.domains]\n"example.com"="deny"\n"fe80::1%en0"="deny"\n[application.network.domains]\n"host:80"="deny"`);
  const merged = mergeConfiguration(base, raw);
  assert.equal(merged.agents.max_concurrent_threads_per_session, 5n);
  assert.equal(merged.agents.max_threads, undefined);
  assert.equal(merged.agents.research.future, true);
  assert.equal(merged.memories.disable_on_external_context, true);
  assert.equal(merged.memories.no_memories_if_mcp_or_web_search, undefined);
  assert.deepEqual(plain(merged.shell_environment_policy), { set: { KEEP: 'value' }, filters: { 'token*': 'drop' } });
  assert.deepEqual(plain(merged.features.code_mode), { enabled: false, future: 'keep' });
  assert.deepEqual(plain(merged.features.sleep_tool), { enabled: false, future: 'keep' });
  assert.deepEqual(plain(merged.permissions.dev.network.domains), { 'example.com': 'deny', 'fe80::1%en0': 'deny' });
  assert.deepEqual(plain(merged.application.network.domains), { host: 'deny' });
  assert.equal(mergeConfiguration({}, parseProfile('[agents]\nmax_threads=1\nmax_concurrent_threads_per_session=3')).agents.max_concurrent_threads_per_session, 3n);
  const filters = mergeConfiguration(merged, parseProfile('[shell_environment_policy.filters]\n"token*"="keep"\n"ÜBER*"="drop"'));
  assert.deepEqual(plain(filters.shell_environment_policy.filters), { 'token*': 'keep', 'über*': 'drop' });
  const legacy = mergeConfiguration(filters, parseProfile('[shell_environment_policy]\ninclude_only=[]'));
  assert.equal(legacy.shell_environment_policy.filters, undefined);
  assert.deepEqual(legacy.shell_environment_policy.include_only, []);
  const empty = mergeConfiguration(legacy, parseProfile('[shell_environment_policy]\nfilters={}'));
  assert.equal(empty.shell_environment_policy.include_only, undefined);
  assert.deepEqual(plain(empty.shell_environment_policy.filters), {});
  const invalidSameLayer = mergeConfiguration(legacy, parseProfile('[shell_environment_policy]\nfilters={}\nexclude=[]'));
  assert.deepEqual(invalidSameLayer.shell_environment_policy.exclude, []);
  assert.deepEqual(plain(invalidSameLayer.shell_environment_policy.filters), {});
});

test('structured feature credential providers replace conflicting env sources on each platform', () => {
  const base = parseProfile(`[features.network_proxy]\nenabled=true\nfuture="keep"\n[features.network_proxy.credentials.old]\nenv=["TOKEN"]\nsecret_source="old"\n[features.network_proxy.credentials.shared]\nenv=["SHARED"]\nfuture="keep"`);
  const raw = parseProfile(`[features.network_proxy.credentials.new]\nenv=["TOKEN"]\nsecret_source="new"\n[features.network_proxy.credentials.shared]\nenv=["OTHER"]`);
  const merged = mergeConfiguration(base, raw);
  assert.equal(merged.features.network_proxy.credentials.old, undefined);
  assert.deepEqual(plain(merged.features.network_proxy.credentials.shared), { env: ['OTHER'], future: 'keep' });
  assert.equal(merged.features.network_proxy.credentials.new.secret_source, 'new');
  assert.equal(merged.features.network_proxy.future, 'keep');
  const lowerCase = parseProfile('[features.network_proxy.credentials.new]\nenv=["token"]');
  assert.equal(mergeConfiguration(base, lowerCase, { platform: 'win32' }).features.network_proxy.credentials.old, undefined);
  assert.equal(mergeConfiguration(base, lowerCase, { platform: 'linux' }).features.network_proxy.credentials.old.secret_source, 'old');
  const moved = parseProfile('[features.network_proxy.credentials.old]\nenv=["OTHER"]\n[features.network_proxy.credentials.new]\nenv=["TOKEN"]');
  assert.deepEqual(plain(mergeConfiguration(base, moved).features.network_proxy.credentials.old.env), ['OTHER']);
});

test('profile and raw paths keep their source bases while native cwd-based expressions stay unchanged', async (t) => {
  const f = await profile(t, `model_instructions_file="./instructions with space.md"\nexperimental_compact_prompt_file="missing/../compact.md"\nmodel_catalog_json="catalog.json"\nsqlite_home="state"\nlog_dir="logs"\n[sandbox_workspace_write]\nwritable_roots=["data"]\n[agents.research]\nconfig_file="agents/research.toml"\nfuture_path="untouched"\n[skills]\nconfig=[{path="skills/local",enabled=true}]\n[mcp_servers.local]\ncommand="./bin/server"\ncwd="relative-server"\nargs=["relative-argument"]\n[permissions.dev]\nworkspace_roots={"relative-root"=true}\nfilesystem={"relative-path"="read"}\n[otel.exporter.otlp-http.tls]\nca-certificate="certificates/ca.pem"`);
  f.request.args = ['-c', 'model_catalog_json="raw catalog.json"', '-c', 'agents.writer.config_file="agents/writer.toml"'];
  const c = await codexConfiguration(f.request, f.environment);
  const launch = Object.assign({}, ...c.argv.filter((_, index) => c.argv[index - 1] === '-c').map(parseConfigArgument));
  const home = path.dirname(f.file);
  assert.equal(c.thread.config.model_instructions_file, path.join(home, 'instructions with space.md'));
  assert.equal(c.thread.config.experimental_compact_prompt_file, path.join(home, 'compact.md'));
  assert.equal(launch.model_catalog_json, path.join(root, 'raw catalog.json'));
  assert.equal(launch.sqlite_home, path.join(home, 'state'));
  assert.equal(launch.log_dir, path.join(home, 'logs'));
  assert.deepEqual(c.thread.config.sandbox_workspace_write.writable_roots, [path.join(home, 'data')]);
  assert.equal(c.thread.config.agents.research.config_file, path.join(home, 'agents/research.toml'));
  assert.equal(c.thread.config.agents.writer.config_file, path.join(root, 'agents/writer.toml'));
  assert.equal(c.thread.config.agents.research.future_path, 'untouched');
  assert.equal(c.thread.config.skills.config[0].path, path.join(home, 'skills/local'));
  assert.equal(c.thread.config.mcp_servers.local.command, './bin/server');
  assert.equal(c.thread.config.mcp_servers.local.cwd, 'relative-server');
  assert.deepEqual(c.thread.config.permissions.dev.workspace_roots, { 'relative-root': true });
  assert.deepEqual(c.thread.config.permissions.dev.filesystem, { 'relative-path': 'read' });
  assert.equal(launch.otel.exporter['otlp-http'].tls['ca-certificate'], path.join(home, 'certificates/ca.pem'));
  const options = { platform: 'win32', baseDir: 'C:\\profiles\\nested', environment: { USERPROFILE: 'C:\\Users\\fixture' } };
  assert.equal(convertProfile({ model_instructions_file: '../with space.md' }, options).model_instructions_file, 'C:\\profiles\\with space.md');
  assert.equal(convertProfile({ model_instructions_file: '~\\docs\\instructions.md' }, options).model_instructions_file, 'C:\\Users\\fixture\\docs\\instructions.md');
  assert.equal(convertProfile({ model_instructions_file: '\\\\?\\C:\\docs\\instructions.md' }, options).model_instructions_file, 'C:\\docs\\instructions.md');
  const diagnostics = [];
  assert.throws(() => convertProfile({ agents: { 'private-name': { config_file: 'D:secret' } } }, { ...options, diagnostics }), { code: 'profileConversionUnsupported' });
  assert.equal(diagnostics[0].field, 'agents.<name>.config_file');
  assert(!JSON.stringify(diagnostics).includes('private-name'));
  assert(!JSON.stringify(diagnostics).includes('secret'));
});

test('hook state and future events preserve complete objects without guessing source trust', async (t) => {
  const f = await profile(t, '[[hooks.Stop]]\nfuture="group"\nhooks=[{type="command",command="fixture",future={integer=12}}]\n[[hooks.FutureEvent]]\nfuture="group"\nhooks=[{type="future",future={enabled=true}}]');
  const original = `${f.file}:stop:0:0`;
  await fs.appendFile(f.file, `\n[hooks.state.${tomlValue(original)}]\nenabled=false\nfuture={integer=7,items=[2]}\n[hooks.state.${tomlValue(` ${original} `)}]\nfuture={higher=true}\n`);
  f.request.args = ['-c', `hooks.state.${tomlValue(original)}={future={raw=true,items=[3]}}`];
  const c = await codexConfiguration(f.request, f.environment);
  mapHookState(c, { layers: [layer('user', { hooks: { state: { [original]: { future: { lower: true, items: [1] } } } } })] });
  const expected = { enabled: false, future: { lower: true, integer: 7, higher: true, raw: true, items: [3] } };
  assert.deepEqual(c.thread.config.hooks.state[original], expected);
  assert.deepEqual(c.thread.config.hooks.state[`${sessionHookSource()}:stop:0:0`], expected);
  assert.deepEqual(c.thread.config.hooks.Stop[0].hooks[0].future, { integer: 12 });
  assert.equal(c.thread.config.hooks.FutureEvent[0].hooks[0].type, 'future');
  assert.doesNotThrow(() => JSON.stringify(c.thread));
  const unmapped = await codexConfiguration(f.request, f.environment);
  assert.throws(() => mapHookState(unmapped, { layers: [layer('user', { hooks: { state: { [`${f.file}:future_event:0:0`]: { enabled: false, trusted_hash: 'do-not-log' } } } })] }), { code: 'profileHookMappingUnsupported' });
});

test('startup argv quotes literal root keys and enforces each platform budget', () => {
  const value = { 'future.with.dot': { 'header.with.dot': 'keep' } };
  const args = launchArguments(value);
  assert.deepEqual(plain(parseConfigArgument(args[2])), value);
  for (const [platform, length] of [['linux', 120000], ['win32', 14000]]) assert.throws(() => launchArguments({ future: 'x'.repeat(length) }, [], platform), { code: 'profileConversionUnsupported' });
});
