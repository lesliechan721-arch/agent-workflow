import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { renderArtifactPlan, trimBlock } from './render-artifacts.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./render-artifacts.mjs', import.meta.url));
const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
const stagedArtifactSourcePath = fileURLToPath(
  new URL('../.agents-plugin/artifact-sources/codex/codex-explore-skill/0/', import.meta.url),
);
const stagedSubagentArtifactSourcePath = fileURLToPath(
  new URL(
    '../.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/',
    import.meta.url,
  ),
);
const artifactSourcePath = existsSync(stagedArtifactSourcePath)
  ? stagedArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-explore/', import.meta.url));
const subagentArtifactSourcePath = existsSync(stagedSubagentArtifactSourcePath)
  ? stagedSubagentArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-subagent-guide/', import.meta.url));

const expectedRoles = [
  {
    id: 'codex-explore-quick-role',
    key: 'codex-explore-quick',
    profileKey: 'quickProfile',
    model: 'gpt-5.6-luna',
    effort: 'medium',
  },
  {
    id: 'codex-explore-standard-role',
    key: 'codex-explore-standard',
    profileKey: 'standardProfile',
    model: 'gpt-5.6-luna',
    effort: 'high',
  },
  {
    id: 'codex-explore-deep-role',
    key: 'codex-explore-deep',
    profileKey: 'deepProfile',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  },
  {
    id: 'codex-explore-custom-role',
    key: 'codex-explore-custom',
  },
];

const exploreConfigKeys = [
  'quickProfile',
  'standardProfile',
  'deepProfile',
];

function createContext(overrides = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-enhance',
      version: '0.2.0',
    },
    requestedArtifactIds: [
      'codex-explore-skill',
      ...expectedRoles.map((role) => role.id),
      'codex-subagent-guide-skill',
      'codex-subagent-simple-role',
      'codex-subagent-general-role',
      'codex-subagent-complex-role',
      'codex-subagent-advanced-role',
    ],
    artifactSources: [
      {
        id: 'codex-explore-skill',
        target: 'codex.skill',
        sourceDirs: [artifactSourcePath],
      },
      {
        id: 'codex-subagent-guide-skill',
        target: 'codex.skill',
        sourceDirs: [subagentArtifactSourcePath],
      },
    ],
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values: {},
    },
    ...overrides,
  };
}

async function runRenderer(context) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-explore-render-'));
  const contextPath = path.join(tempDir, 'context.json');

  try {
    await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf8');
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        AW_PLUGIN_CONTEXT: contextPath,
      },
      cwd: path.dirname(scriptPath),
    });

    assert.equal(stderr, '');
    return JSON.parse(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function findArtifact(plan, id) {
  const artifact = plan.artifacts.find((entry) => entry.id === id);
  assert.ok(artifact, `Missing artifact ${id}`);
  return artifact;
}

function assertRoleArtifact(plan, expected) {
  const role = findArtifact(plan, expected.id);
  assert.equal(role.kind, 'codexRole');
  assert.equal(role.target, 'codex.agentRole');
  assert.equal(role.state, 'present');
  assert.equal(role.roleKey, expected.key);
  assert.deepEqual(role.refreshKeys, expected.profileKey ? [expected.profileKey] : []);
  assert.equal(role.content.roleFile.name, expected.key);
  assert.equal(role.content.roleFile.model, expected.model);
  assert.equal(role.content.roleFile.model_reasoning_effort, expected.effort);
  assert.equal(role.content.registration.description, role.content.roleFile.description);

  const instructions = role.content.roleFile.developer_instructions;
  assert.ok([...instructions].length <= 1_000);
  assert.ok(instructions.split('\n').length <= 30);
  // Static contract exception: role artifact 缺少只读、禁止未授权委派或敏感数据保护指令会取消子代理安全边界; behavior test is not suitable because 这些指令是模型消费的最终 artifact 安全合同，确定性 runner 无法证明模型行为.
  assert.match(instructions, /只读事实调查，不做最终判断、建议或修改/);
  assert.match(instructions, /不得读取或调用 `codex-explore` skill/);
  assert.match(instructions, /不得委派或管理代理/);
  assert.match(instructions, /保持只读/);
  assert.match(instructions, /不得向外部发送密钥、个人数据、私有代码或用户材料原文/);
  for (const status of [
    'Status: completed',
    'Status: blocked — <原因>',
    'Status: insufficient — <缺失证据>',
  ]) {
    assert.ok(instructions.includes(status));
  }
  for (const kind of ['[direct]', '[inference]', '[conflict]']) {
    assert.ok(instructions.includes(kind));
  }
  assert.match(instructions, /实际读取且可核验的来源定位/);
  assert.match(instructions, /inference 给出所依据的直接证据/);
  assert.match(instructions, /conflict 给出冲突双方/);
  assert.match(instructions, /时间敏感来源在定位后附来源时间/);
  assert.match(instructions, /只在确有[^\n]+时输出 `## Gaps`/);
  assert.match(instructions, /不要复述调查过程/);
  assert.ok(instructions.includes('`## Findings`'));
  assert.ok(instructions.includes('`- [kind] <claim> — <locator(s)>`'));
  assert.equal(instructions.includes('## Status'), false);
  for (const legacyField of [
    '**kind:**',
    '**claim:**',
    '**evidence:**',
    '**locator:**',
    '**support:**',
    '没有时写“无”',
  ]) {
    assert.equal(instructions.includes(legacyField), false);
  }
}

async function testRenderedArtifactsAndSkillContract() {
  const plan = await runRenderer(createContext());
  const skill = findArtifact(plan, 'codex-explore-skill');

  assert.equal(plan.version, 2);
  assert.equal(plan.artifacts.length, 10);
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.state, 'present');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, []);

  for (const role of expectedRoles) {
    assertRoleArtifact(plan, role);
  }
  assert.equal(
    new Set(
      expectedRoles.map(
        (role) => findArtifact(plan, role.id).content.roleFile.developer_instructions,
      ),
    ).size,
    1,
  );

  const custom = findArtifact(plan, 'codex-explore-custom-role');
  assert.equal('model' in custom.content.roleFile, false);
  assert.equal('model_reasoning_effort' in custom.content.roleFile, false);

  const text = skill.content.files['SKILL.md'];
  const openaiYaml = await readFile(path.join(artifactSourcePath, 'agents', 'openai.yaml'), 'utf8');
  assert.equal('agents/openai.yaml' in skill.content.files, false);
  assert.ok([...text].length <= 4_000);
  assert.ok(text.split('\n').length <= 80);
  for (const heading of ['## Gate', '## 委派', '## 不变量', '## 等待与整合']) {
    assert.match(text, new RegExp(heading));
  }
  // Static contract exception: Skill artifact 缺少权限边界、参数不可表达时 fail-closed 或敏感数据保护规则会允许不安全降级; behavior test is not suitable because 这些规则是模型消费的最终 artifact 安全合同，确定性 runner 无法证明模型行为.
  assert.match(text, /只读默认为行为约束/);
  assert.match(text, /确认父 turn 的有效权限边界对子代理生效时，才承诺权限隔离/);
  assert.match(text, /全部显式字段及其值受当前 schema 支持且可原样传递/);
  assert.match(text, /不省略、替换或降级/);
  assert.match(text, /不发送密钥、个人数据、私有代码或用户材料原文/);
  for (const toolName of [
    'close_agent',
    'followup_task',
    'send_input',
    'send_message',
    'resume_agent',
    'interrupt_agent',
    'list_agents',
  ]) {
    assert.equal(text.includes(toolName), false);
  }
  assert.equal(text.includes('{{'), false);
  assert.match(openaiYaml, /allow_implicit_invocation:\s*true/);
}

async function testConfigSourcesAndManifestDefaults() {
  const configured = await runRenderer(
    createContext({
      config: undefined,
      renderConfig: {
        values: {
          standardProfile: {
            model: 'configured-standard',
            reasoningEffort: 'max',
          },
        },
      },
    }),
  );
  const configuredSkill = findArtifact(configured, 'codex-explore-skill');
  const configuredStandard = findArtifact(configured, 'codex-explore-standard-role');
  const configuredQuick = findArtifact(configured, 'codex-explore-quick-role');
  assert.equal(configuredStandard.content.roleFile.model, 'configured-standard');
  assert.equal(configuredStandard.content.roleFile.model_reasoning_effort, 'max');
  assert.equal(configuredQuick.content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(configuredQuick.content.roleFile.model_reasoning_effort, 'medium');

  const defaults = await runRenderer(
    createContext({
      config: {
        mode: 'artifact-render',
        targetScope: 'project',
        values: {},
      },
    }),
  );
  const defaultSkill = findArtifact(defaults, 'codex-explore-skill');
  const defaultStandard = findArtifact(defaults, 'codex-explore-standard-role');
  assert.equal(configuredSkill.content.files['SKILL.md'], defaultSkill.content.files['SKILL.md']);
  assert.equal(defaultStandard.content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(defaultStandard.content.roleFile.model_reasoning_effort, 'high');
}

async function testDeliverySpecificRequests() {
  const nativePlan = await runRenderer(createContext({
    scope: 'project',
    requestedArtifactIds: ['codex-explore-skill'],
  }));
  assert.deepEqual(nativePlan.artifacts.map((artifact) => artifact.id), [
    'codex-explore-skill',
  ]);

  const roleIds = expectedRoles.map((role) => role.id);
  const awPlan = await runRenderer(createContext({
    scope: 'project',
    requestedArtifactIds: roleIds,
  }));
  assert.deepEqual(awPlan.artifacts.map((artifact) => artifact.id), roleIds);
  assert.equal(awPlan.artifacts.every((artifact) => artifact.target === 'codex.agentRole'), true);
}

async function testStaticManifestContract() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.name, 'codex-enhance');
  for (const key of exploreConfigKeys) {
    assert.ok(Object.hasOwn(manifest.config.fields, key), `Missing explore config key ${key}`);
  }
  for (const role of expectedRoles.filter((entry) => entry.profileKey)) {
    const profile = manifest.config.fields[role.profileKey];
    // Source reuse is declared by the public manifest; value validation belongs to AW.
    const shape = manifest.config.definitions?.agentProfile ?? profile;
    if (manifest.config.definitions) assert.equal(profile.$ref, '#/config/definitions/agentProfile');
    assert.equal(shape.type, 'object');
    assert.equal(profile.required, true);
    assert.equal(shape.additionalProperties, false);
    assert.deepEqual(profile.default, {
      model: role.model,
      reasoningEffort: role.effort,
    });
    assert.deepEqual(Object.keys(shape.properties), ['model', 'reasoningEffort']);
    assert.deepEqual(shape.properties.model, {
      type: 'string',
      required: true,
      validation: { minLength: 1 },
    });
    assert.equal(shape.properties.reasoningEffort.type, 'string');
    assert.equal(shape.properties.reasoningEffort.required, true);
    assert.equal(shape.properties.reasoningEffort.choices.allowCustom, false);
    assert.deepEqual(shape.properties.reasoningEffort.choices.presets.map((preset) => preset.value), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    assert.deepEqual(
      shape.properties.reasoningEffort.choices.presets,
      shape.properties.reasoningEffort.choices.presets.map(({ value }) => ({
        id: value,
        title: value,
        value,
      })),
    );
    assert.equal(Object.hasOwn(profile, 'choices'), false);
  }
  assert.equal(Object.hasOwn(manifest.config.fields, 'exploreMinimumInitialWaitMinutes'), false);
  assert.equal(Object.hasOwn(manifest.config.fields, 'subagentMinimumInitialWaitMinutes'), false);
  for (const profileKey of [
    'simpleTaskProfile',
    'generalTaskProfile',
    'complexTaskProfile',
    'advancedTaskProfile',
  ]) {
    assert.deepEqual(
      (manifest.config.definitions?.agentProfile ?? manifest.config.fields[profileKey]).properties.reasoningEffort.choices.presets.map(
        (preset) => preset.value,
      ),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    );
  }
  assert.deepEqual(
    manifest.config.presentation.groups.map((group) => ({
      id: group.id,
      fields: group.fields,
    })),
    [
      {
        id: 'codex-explore',
        fields: exploreConfigKeys,
      },
      {
        id: 'codex-subagent-guide',
        fields: [
          'simpleTaskProfile',
          'generalTaskProfile',
          'complexTaskProfile',
          'advancedTaskProfile',
        ],
      },
    ],
  );
  assert.deepEqual(manifest.marketplace.policy.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);

  for (const target of manifest.artifacts.targets.filter((entry) =>
    entry.target === 'codex.skill')) {
    assert.deepEqual(target.delivery, {
      mode: 'codex-native',
      identity: 'shared',
      renderProfile: 'user',
    });
  }
  for (const target of manifest.artifacts.targets.filter((entry) =>
    entry.target === 'codex.agentRole')) {
    assert.equal(target.delivery, undefined);
  }

  assert.deepEqual(
    manifest.artifacts.targets
      .filter((target) => target.id.startsWith('codex-explore-'))
      .map((target) => ({
        id: target.id,
        target: target.target,
        refreshKeys: target.refreshKeys,
        key: target.skillKey ?? target.roleKey,
      })),
    [
      {
        id: 'codex-explore-skill',
        target: 'codex.skill',
        refreshKeys: [],
        key: 'codex-explore',
      },
      ...expectedRoles.map((role) => ({
        id: role.id,
        target: 'codex.agentRole',
        refreshKeys: role.profileKey ? [role.profileKey] : [],
        key: role.key,
      })),
    ],
  );
}

async function testTrimBlockAndUnsupportedPlatform() {
  assert.equal(
    trimBlock(`
        第一行
          第二行

        - 列表项
    `),
    ['第一行', '  第二行', '', '- 列表项'].join('\n'),
  );
  await assert.rejects(
    () => renderArtifactPlan({ platform: 'claude' }),
    /Unsupported platform: claude/,
  );
}

async function main() {
  await testRenderedArtifactsAndSkillContract();
  await testConfigSourcesAndManifestDefaults();
  await testDeliverySpecificRequests();
  await testStaticManifestContract();
  await testTrimBlockAndUnsupportedPlatform();
  console.log('render-artifacts tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
