import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
const defaults = Object.fromEntries(Object.entries(manifest.config.fields)
  .filter(([, field]) => Object.hasOwn(field, 'default')).map(([key, field]) => [key, field.default]));
const nativeBaseline = { executor: 'native' };
const nativePlatforms = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok'];
const profileKeys = ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile'];
const externalCommands = [
  { key: 'codex-local', adapter: 'codex', description: '复杂重构与排查' },
  { key: 'agy-local', adapter: 'antigravity', modelsPolicy: 'override', models: [{ id: 'fixture-model' }] },
  { key: 'local-custom', adapter: 'custom', command: '/private/adapter', envFrom: { TOKEN: 'PRIVATE_TOKEN' } },
];
const externalConfig = { subagentCommands: externalCommands };
const customConfig = {
  ...externalConfig,
  complexTaskProfile: { executor: 'codex-local' },
  advancedTaskProfile: { model: 'native-model', reasoningEffort: 'high' },
  taskCustomProfiles: [{ applicability: '数据库|锁`\n<details>', executor: 'agy-local' }, { applicability: '第二项' }],
};

// Profiles in this test exercise renderer inputs independently of native host qualification.
function context(platform = 'codex', overrides = {}, basis = 'local') {
  const unsupportedAgent = ['opencode', 'generic'].includes(platform);
  const agentNamingMode = unsupportedAgent ? 'unsupported' : platform === 'claude' ? 'host-plugin' : 'aw-prefix';
  const filePrefix = agentNamingMode === 'aw-prefix' ? 'aw-fixture-agent-subagent-' : '';
  const agentDelivery = { codex: 'managed-host-resource', pi: 'native-extension' }[platform] ?? 'native-package';
  return {
    schemaVersion: 3, surface: 'agent-plugin', platform, scope: 'user',
    plugin: { pluginId: 'fixture/agent-subagent' },
    agentNaming: { mode: agentNamingMode, filePrefix, invocationPrefix: agentNamingMode === 'host-plugin' ? 'agent-subagent:' : filePrefix },
    allowedOutputKinds: ['skill', 'agent'],
    changedConfigKeys: [], previousComponents: [],
    resources: ['./shared', './skills/spawn-subagent'].map((name) =>
      ({ kind: 'bundle', name, root: path.join(root, name), digest: 'test-resource' })),
    platformCapabilities: {
      schemaVersion: 3, platform, scope: 'user', basis, agentNamingMode,
      kinds: {
        skill: { status: 'supported', reasonCodes: [], delivery: [platform === 'generic' ? 'generic-files' : 'native-package'] },
        agent: unsupportedAgent
          ? { status: 'unsupported', reasonCodes: ['delivery-unavailable'], delivery: [] }
          : { status: 'supported', reasonCodes: [], delivery: [agentDelivery] },
      },
      features: {},
    },
    config: { values: {
      ...structuredClone(defaults),
      generalTaskProfile: platform === 'generic'
        ? structuredClone(manifest.config.platforms.generic.fields.generalTaskProfile.default)
        : structuredClone(nativeBaseline),
      ...overrides,
    } },
  };
}

async function materializedFiles(skill) {
  return Object.fromEntries(await Promise.all(Object.entries(skill.content.files).map(async ([name, value]) => [name,
    'text' in value ? value.text : await readFile(path.join(root, value.source.path), 'utf8')])));
}

function assertSkillClosure(output) {
  for (const [name, body] of Object.entries(output)) {
    assert.doesNotMatch(name, /(?:execution-profiles|external-delegation)\.md$/u);
    if (!name.endsWith('.md')) continue;
    assert.doesNotMatch(body, /execution-profiles\.md|external-delegation\.md|<!--/u, name);
    if (!name.startsWith('docs/')) assert.doesNotMatch(body, /@@[A-Z0-9_]+@@/u, name);
    for (const [, reference] of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/.test(reference) || reference.startsWith('#')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), reference.split('#', 1)[0]));
      assert.ok(Object.hasOwn(output, target), `${name} -> ${reference}`);
    }
    for (const [, reference] of body.matchAll(/`((?:references|assets)\/[\w.\/-]+\.md)`/g)) {
      assert.ok(Object.hasOwn(output, reference), `${name} -> ${reference}`);
    }
  }
}

// Test Value Gate: the declared platform coverage, routes and exact allow prefixes must agree.
test('declares one required platform baseline, optional overrides, an open registry and one shared command package', async () => {
  assert.deepEqual(manifest.platforms, [...nativePlatforms, 'generic']);
  assert.deepEqual(Object.keys(manifest.config.platforms), ['generic']);
  const genericBaseline = manifest.config.platforms.generic.fields.generalTaskProfile;
  assert.equal(genericBaseline.platformOnly, true);
  assert.deepEqual(genericBaseline.default, nativeBaseline);
  const { definitions, fields } = manifest.config;
  assert.equal(manifest.config.presentation.groups[0].fields[0], 'generalTaskProfile');
  for (const key of [...profileKeys, 'taskCustomProfiles']) {
    assert.equal(fields[key].platformOnly, true, key);
    assert.equal(fields[key].default, undefined, key);
    assert.equal(fields[key].required, key === 'generalTaskProfile' ? true : undefined, key);
  }
  assert.deepEqual(profileKeys.map((key) => fields[key].suggestions.hint), ['fast', 'balanced', 'strong', 'deep']);
  const { provider, dependsOn, targets } = definitions?.agentProfile.suggestions ?? fields.generalTaskProfile.suggestions;
  assert.deepEqual({ provider, dependsOn, targets }, {
    provider: 'executor-model-profile', dependsOn: ['executor'], targets: ['model', 'reasoningEffort'],
  });
  assert.equal(fields.subagentCommands.platformOnly, undefined);
  assert.deepEqual(fields.subagentCommands.default, []);
  assert.equal(fields.subagentCommands.validation.uniqueBy, 'key');
  const executorField = definitions?.agentExecutor ?? fields.simpleTaskProfile.properties.executor;
  assert.deepEqual(executorField.valueRef, { field: 'subagentCommands', key: 'key', include: ['native'] });
  assert.deepEqual(executorField.clearsOnChange, ['model', 'reasoningEffort']);
  const modelItem = definitions?.executorModelItem ?? fields.subagentCommands.items.properties.models.items;
  assert.equal(modelItem.properties.defaultEffort.type, 'string');
  assert.equal(fields.subagentRetentionHours.default, 24);
  assert.deepEqual(fields.subagentRetentionHours.validation, { integer: true, minimum: 0, maximum: 2501999792 });
  const { sourceDir, platforms, mode, runtimeConfig, routes } = manifest.command;
  assert.equal(mode, 'static');
  assert.deepEqual(platforms ?? manifest.platforms.filter((platform) => platform !== 'generic'), nativePlatforms);
  assert.deepEqual(runtimeConfig, { keys: ['subagentCommands', 'subagentRetentionHours'] });
  assert.equal(routes.fallback, undefined);
  const publicRoutes = ['start', 'send', 'wait', 'result', 'stop', 'inspect'];
  assert.deepEqual(routes.subcommands.map(({ name }) => name), [...publicRoutes, 'message']);
  assert.deepEqual(manifest.extensions.permissions, [{
    name: 'subagent-commands', allow: publicRoutes.map((route) => ({ argsPrefix: [route] })),
  }]);
  for (const route of routes.subcommands) {
    assert.ok(await readFile(path.join(root, sourceDir, route.entry)));
  }
  assert.deepEqual(manifest.nativeTools.consumers, [
    { kind: 'plugin-command', tools: [{ key: 'windows-job', platforms: ['win32'], policy: 'required' }] },
    { kind: 'plugin-test', key: 'node', tools: [{ key: 'windows-job', platforms: ['win32'], policy: 'required' }] },
  ]);
  const managed = fields.subagentCommands.items.variants.cases['custom-managed'];
  assert.equal(managed.properties.commandId.required, true);
  assert.equal(managed.properties.subcommand.required, undefined);
  const pattern = new RegExp(managed.properties.commandId.validation.pattern);
  for (const selector of ['fixture/adapter', 'fixture/adapter/pi', 'cmdu_4ba70354-0867-4ecb-a927-120c1933f514']) {
    assert.ok(pattern.test(selector), selector);
  }
  for (const selector of ['guide', 'fixture/adapter/generic', 'fixture/adapter/pi/extra']) {
    assert.equal(pattern.test(selector), false, selector);
  }
});

// Test Value Gate: every delivered Skill must link to the available commands and files for its host and config.
const scenarios = [
  ...nativePlatforms.map((platform) => ({ id: platform, platform, config: customConfig, selection: true, external: true })),
  ...['codex', 'pi'].map((platform) => ({ id: `${platform}-profile`, platform, basis: 'profile', config: customConfig, selection: true, external: true })),
  ...['codex', 'opencode'].map((platform) => ({ id: `${platform}-zero`, platform })),
  { id: 'codex-precise-baseline', platform: 'codex', config: { generalTaskProfile: { model: 'fixture-native', reasoningEffort: 'medium' } }, inlineModel: 'fixture-native' },
  { id: 'claude-identical-override', platform: 'claude', config: { generalTaskProfile: { model: 'sonnet' }, complexTaskProfile: { executor: 'native', model: 'sonnet' } }, inlineModel: 'sonnet' },
  { id: 'antigravity-precise-baseline', platform: 'antigravity', config: { generalTaskProfile: { model: 'gemini-4-neon-medium' } }, inlineModel: 'gemini-4-neon-medium' },
  { id: 'native-custom', platform: 'codex', config: { advancedTaskProfile: { executor: 'native', model: 'fixture-native' } }, selection: true },
  { id: 'native-unavailable', platform: 'codex', config: { complexTaskProfile: { executor: 'removed-executor' } }, selection: true, unavailable: true },
  { id: 'custom-only', platform: 'codex', config: { taskCustomProfiles: [{ applicability: '只读核验', model: 'fixture-review' }] }, selection: true },
  { id: 'antigravity-differentiated', platform: 'antigravity', config: { generalTaskProfile: { model: 'gemini-4-neon-medium' }, simpleTaskProfile: { model: 'gemini-3.8-flash-low' } }, selection: true },
  { id: 'external-defaults', platform: 'claude', config: externalConfig, selection: true, external: true, collapsed: true },
  { id: 'external-with-precise-baseline', platform: 'codex', config: { ...externalConfig, generalTaskProfile: { model: 'fixture-native', reasoningEffort: 'medium' } }, selection: true, external: true, collapsed: true, inlineModel: 'fixture-native' },
  { id: 'external-as-baseline', platform: 'codex', config: { ...externalConfig, generalTaskProfile: { executor: 'codex-local' } }, selection: true, external: true },
  { id: 'generic-zero', platform: 'generic', config: externalConfig },
  { id: 'generic-inherited', platform: 'generic', config: customConfig, selection: true, disclosure: true },
];
for (const { id, platform, basis, config, selection = false, external = false, collapsed, disclosure, inlineModel, unavailable } of scenarios) {
  test(`renders a closed Skill with zero agent components for ${id}`, async () => {
    const { components, omitted, unmet } = await renderArtifactPlan(context(platform, config, basis));
    assert.equal(components.length, 1);
    const [skill] = components;
    assert.deepEqual(omitted, []);
    assert.deepEqual(unmet, []);
    assert.equal(skill.id, 'spawn-subagent-skill');
    assert.equal(skill.requires, undefined);
    assert.equal(skill.runtimeConfig, undefined);
    const output = await materializedFiles(skill);
    assertSkillClosure(output);
    const skillText = output['SKILL.md'];
    const selectionPath = 'references/executor-selection.md';
    const executionPath = 'references/external-execution.md';
    assert.equal(Object.hasOwn(output, selectionPath), selection);
    assert.equal(Object.hasOwn(output, executionPath), external);
    assert.equal(Object.hasOwn(output, 'references/communication.md'), external);
    assert.equal(Object.keys(output).some((name) => name.startsWith('docs/')), external);
    assert.equal(Object.hasOwn(output, 'agents/openai.yaml'), platform !== 'generic');
    assert.equal(Object.keys(output).some((name) => name.startsWith('scripts/')), false);
    assert.match(skillText, /省略 `executor` 时按 `native` 解释/u);
    assert.match(skillText, /调用方指定的角色不可用[^\n]*停止并报告缺口/u);
    assert.match(output['assets/task-instructions.md'], /权限取本次授权与实际工具权限的交集/u);
    assert.doesNotMatch(skillText, /subagentCommands|`apply`|aw-fixture-agent-subagent-subagent|默认 `subagent`|Pi 需已启用兼容 subagent 扩展/u);
    const selectionText = output[selectionPath] ?? '';
    assert.doesNotMatch(selectionText, /subagentCommands|`apply`/u);
    if (inlineModel) assert.ok(skillText.includes(inlineModel));
    if (unavailable) assert.match(selectionText, /removed-executor[^\n]+当前平台未启用该外部执行器/u);
    if (selection && config?.complexTaskProfile === undefined && !collapsed && id !== 'external-as-baseline') {
      assert.match(selectionText, /complex（继承 general）/u);
    }
    if (platform === 'antigravity') {
      assert.match(skillText, /显式指示[^\n]*优先通过 `swarm`/u);
      assert.match(skillText, /完整模型 ID 或展示名[^\n]*不传裸基名或独立 `reasoningEffort`/u);
      for (const fragment of ['`brief`', '`kill`', 'no swarm yet; only the coordinator can start one', 'TypeName', 'invoke_subagent', '调用方指定 `TypeName` 或宿主默认角色', 'Model: "inherit"']) {
        assert.ok(skillText.includes(fragment), fragment);
      }
      assert.doesNotMatch(skillText, /\bswarm_wait\b|\bread_board\b|workspace: "inherit"/u);
      if (selection) assert.ok(selectionText.includes('—（由模型 ID 编码）'));
    } else {
      if (platform !== 'generic') {
        assert.match(skillText, /使用宿主默认角色[^\n]*assets\/task-instructions\.md/u);
      }
      // The adapter-author docs describe their own backend; runtime routes and
      // user-facing Skill README must not expose another host's native tools.
      for (const [name, body] of Object.entries(output)) {
        if (!name.startsWith('docs/')) assert.doesNotMatch(body, /\bswarm(?:_wait)?\b|\binvoke_subagent\b|@coordinator/u, name);
      }
    }
    const invocations = Object.values(output).flatMap((body) =>
      [...body.matchAll(/^\{\{aw\.command\}\} ([a-z]+)([^\n]*)/gm)].map(([, action, args]) => [action, args]));
    if (external) {
      assert.match(skillText, /不私自切换执行器或材料目的地/u);
      assert.deepEqual(new Set(invocations.map(([action]) => action)), new Set(['inspect', 'start', 'send', 'wait', 'result', 'stop']));
      assert.ok(invocations.every(([, args]) => !args.includes('--platform')));
      assert.ok(skillText.includes('`native`（宿主 `' + platform + '`）'));
      assert.match(output[selectionPath], /inspect --executor "<key>"/u);
      assert.match(output[selectionPath], /静态白名单[^\n]*`fixture-model`/u);
      assert.doesNotMatch(output[selectionPath], /PRIVATE_TOKEN|\/private\/adapter/u);
      assert.match(selectionText, /\[efforts=none\][^\n]*勿传 `--reasoning-effort`/u);
      assert.match(output[executionPath], /\[efforts=none\][^\n]*勿传 `--reasoning-effort`/u);
      assert.match(output[executionPath], /省略[^\n]+自动注入[^\n]+空字符串[^\n]+不注入任何角色指令[^\n]+文件路径[^\n]+读取/u);
    } else {
      assert.ok(Object.values(output).every((body) => !body.includes('{{aw.command}}')));
    }
    if (platform === 'generic') assert.doesNotMatch(skillText.split('---')[1], /(?:description:).*外部执行器/u);
    if (collapsed) {
      assert.match(skillText, /全部难度档位共用[^\n]*进入下方 `native` 分支，无需读取选型文档/u);
      assert.doesNotMatch(selectionText, /\| 档位 \|/u);
    }
    if (disclosure) assert.match(output[selectionPath], /codex-local[^\n]+当前平台不可用[^\n]+回退宿主原生并说明/u);
  });
}

// Test Value Gate: ordered custom profiles preserve escaped values and host/backend defaults.
test('renders profile cells without allowing a value to split the table', async () => {
  const plan = await renderArtifactPlan(context('codex', customConfig));
  const selection = plan.components[0].content.files['references/executor-selection.md'].text;
  const customRows = selection.split('\n').filter((line) => /^\| `"/u.test(line) && line.includes(' | `"agy-local"` |'));
  assert.equal(customRows.length, 1);
  const [, label, executor, model, effort] = customRows[0].split('|').map((cell) => cell.trim());
  assert.equal(JSON.parse(label.slice(1, -1)), customConfig.taskCustomProfiles[0].applicability);
  assert.equal(JSON.parse(executor.slice(1, -1)), 'agy-local');
  assert.match(model, /^后端默认/u);
  assert.match(effort, /^后端默认/u);
  assert.ok(selection.indexOf('第二项') > selection.indexOf(label));
  assert.match(selection, /\| advanced \|[^\n]+\| `"native"` \| `"native-model"` \| `"high"` \|/u);
});

// Test Value Gate: configured punctuation must survive Markdown projection.
test('preserves literal executor and model values without splitting the executor table', async () => {
  const command = {
    key: 'lab|local', adapter: 'custom', description: 'A\\|B\r<C> & D',
    models: [{ id: 'm`v2|a' }],
  };
  const { components: [skill] } = await renderArtifactPlan(context('codex', { subagentCommands: [command] }));
  const files = skill.content.files;
  assert.ok(files['SKILL.md'].text.includes('`lab|local`'));
  const selection = files['references/executor-selection.md'].text;
  const row = selection.split('\n').find((line) => line.includes(' | `custom` | '));
  const [, key, , description, end] = row.split('|');
  assert.equal(end, '');
  assert.equal(JSON.parse(key.trim().slice(1, -1)), command.key);
  assert.match(description, /A&#92;&#124;B &lt;C&gt; &amp; D/u);
  const model = description.match(/`([^`]+)`/u)[1];
  assert.equal(JSON.parse(model), command.models[0].id);
});

// Test Value Gate: non-skill output batches must return empty plans without reading Skill configuration.
test('returns an empty plan for non-skill output kinds across all platforms without reading config', async () => {
  for (const platform of [...nativePlatforms, 'generic']) {
    const input = context(platform);
    input.allowedOutputKinds = ['agent'];
    Object.defineProperty(input, 'config', { get() { throw new Error('non-skill read config'); } });
    assert.deepEqual(await renderArtifactPlan(input), { version: 3, components: [], omitted: [], unmet: [] }, platform);
  }
  const incomplete = context();
  delete incomplete.config.values.generalTaskProfile;
  await assert.rejects(renderArtifactPlan(incomplete), /Missing resolved config value: generalTaskProfile/u);
  await assert.rejects(renderArtifactPlan({ ...context(), surface: 'agent-commands' }), /surface=agent-plugin/u);
});
