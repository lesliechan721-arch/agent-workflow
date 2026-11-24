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
  const agentDelivery = { codex: 'managed-host-resource', pi: 'native-extension' }[platform] ?? 'native-package';
  return {
    schemaVersion: 2, surface: 'agent-plugin', platform, scope: 'user',
    plugin: { pluginId: 'fixture/agent-subagent' },
    allowedOutputKinds: ['skill', 'agent'],
    changedConfigKeys: [], previousComponents: [],
    resources: ['./shared', './skills/spawn-subagent'].map((name) =>
      ({ kind: 'bundle', name, root: path.join(root, name), digest: 'test-resource' })),
    platformCapabilities: {
      schemaVersion: 2, platform, scope: 'user', basis, deliveryFeatures: [],
      kinds: {
        skill: { status: 'supported', reasonCodes: [], delivery: [platform === 'generic' ? 'generic-files' : 'native-package'] },
        agent: unsupportedAgent
          ? { status: 'unsupported', reasonCodes: ['delivery-unavailable'], delivery: [] }
          : { status: 'supported', reasonCodes: [], delivery: [agentDelivery] },
      },
      features: {},
    },
    config: { values: { ...structuredClone(defaults), ...overrides } },
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
test('declares native defaults, an open executor registry and one shared command package', async () => {
  assert.deepEqual(manifest.platforms, [...nativePlatforms, 'generic']);
  assert.equal(manifest.config.platforms, undefined);
  const { definitions, fields } = manifest.config;
  for (const key of profileKeys) assert.deepEqual(fields[key].default, { executor: 'native' });
  assert.deepEqual(fields.taskCustomProfiles.default, []);
  assert.deepEqual(fields.subagentCommands.default, []);
  assert.equal(fields.subagentCommands.validation.uniqueBy, 'key');
  const executorField = definitions?.agentExecutor ?? fields.simpleTaskProfile.properties.executor;
  assert.deepEqual(executorField.valueRef, { field: 'subagentCommands', key: 'key', include: ['native'] });
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
  { id: 'native-custom', platform: 'codex', config: { advancedTaskProfile: { executor: 'native', model: 'fixture-native' } }, selection: true },
  { id: 'external-defaults', platform: 'claude', config: externalConfig, selection: true, external: true, collapsed: true },
  { id: 'generic-zero', platform: 'generic', config: externalConfig },
  { id: 'generic-inherited', platform: 'generic', config: customConfig, selection: true, disclosure: true },
];
for (const { id, platform, basis, config, selection = false, external = false, collapsed, disclosure } of scenarios) {
  test(`renders a closed Skill and eligible role for ${id}`, async () => {
    const { components, unmet } = await renderArtifactPlan(context(platform, config, basis));
    const [skill, role] = components;
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
    if (['generic', 'opencode'].includes(platform)) {
      assert.equal(role, undefined);
      assert.equal(unmet[0].id, 'subagent-role');
      assert.ok(unmet[0].requiredFeatures.some(({ feature }) => feature === 'component.kind.agent'));
    } else {
      assert.deepEqual(unmet, []);
      assert.equal(role.id, 'subagent-role');
      assert.equal(role.name, 'subagent');
      assert.equal(role.content.prompt, output['assets/task-instructions.md']);
      assert.equal(Object.hasOwn(role.content, 'model'), false);
      assert.ok(skillText.includes(['codex', 'pi'].includes(platform) ? '`aw-fixture-agent-subagent-subagent`' : '`subagent`'));
      if (platform === 'pi') assert.deepEqual(role.requires.at(-1), { feature: 'agent.declaration-protocol', values: ['aw.pi.agents.v1'] });
    }
    const invocations = Object.values(output).flatMap((body) =>
      [...body.matchAll(/^\{\{aw\.command\}\} ([a-z]+)([^\n]*)/gm)].map(([, action, args]) => [action, args]));
    if (external) {
      assert.deepEqual(new Set(invocations.map(([action]) => action)), new Set(['inspect', 'start', 'send', 'wait', 'result', 'stop']));
      assert.ok(invocations.every(([, args]) => !args.includes('--platform')));
      assert.ok(skillText.includes('`native`（宿主 `' + platform + '`）'));
      assert.match(output[selectionPath], /inspect --executor "<key>"/u);
      assert.match(output[selectionPath], /静态白名单[^\n]*`fixture-model`/u);
      assert.doesNotMatch(output[selectionPath], /PRIVATE_TOKEN|\/private\/adapter/u);
    } else {
      assert.ok(Object.values(output).every((body) => !body.includes('{{aw.command}}')));
    }
    if (platform === 'generic') assert.doesNotMatch(skillText.split('---')[1], /(?:description:).*外部执行器/u);
    if (collapsed) {
      assert.match(skillText, /当前未覆盖默认档位，直接采用 `native`[^\n]*无需读取选型文档/u);
      assert.doesNotMatch(output[selectionPath], /\| 档位 \|/u);
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

// Test Value Gate: role-only preparation must work without reading any Skill configuration.
test('prepares an independent role even when its consumer is absent', async () => {
  const input = context('pi');
  input.allowedOutputKinds = ['agent'];
  Object.defineProperty(input, 'config', { get() { throw new Error('role read config'); } });
  const withConsumer = await renderArtifactPlan(input);
  input.platformCapabilities.kinds.agent = { status: 'unsupported', reasonCodes: ['consumer-missing'], delivery: ['native-extension'] };
  input.platformCapabilities.features['agent.declaration-protocol'] = { status: 'unsupported', reasonCodes: ['consumer-missing'] };
  assert.deepEqual(await renderArtifactPlan(input), withConsumer);
  delete input.platformCapabilities.deliveryFeatures;
  assert.equal((await renderArtifactPlan(input)).unmet[0].reasonCode, 'consumer-missing');
  const incomplete = context();
  delete incomplete.config.values.generalTaskProfile;
  await assert.rejects(renderArtifactPlan(incomplete), /Missing resolved config value: generalTaskProfile/u);
  await assert.rejects(renderArtifactPlan({ ...context(), surface: 'agent-commands' }), /surface=agent-plugin/u);
});
