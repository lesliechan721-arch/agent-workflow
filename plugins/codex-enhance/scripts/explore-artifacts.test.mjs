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
    modelKey: 'quickModel',
    effortKey: 'quickReasoningEffort',
    model: 'gpt-5.6-luna',
    effort: 'medium',
  },
  {
    id: 'codex-explore-standard-role',
    key: 'codex-explore-standard',
    modelKey: 'standardModel',
    effortKey: 'standardReasoningEffort',
    model: 'gpt-5.6-luna',
    effort: 'high',
  },
  {
    id: 'codex-explore-deep-role',
    key: 'codex-explore-deep',
    modelKey: 'deepModel',
    effortKey: 'deepReasoningEffort',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  },
  {
    id: 'codex-explore-custom-role',
    key: 'codex-explore-custom',
  },
];

const exploreConfigKeys = [
  'quickModel',
  'quickReasoningEffort',
  'standardModel',
  'standardReasoningEffort',
  'deepModel',
  'deepReasoningEffort',
  'exploreMinimumInitialWaitMinutes',
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
      values: {
        exploreMinimumInitialWaitMinutes: 12,
      },
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
  assert.deepEqual(
    role.refreshKeys,
    expected.modelKey ? [expected.modelKey, expected.effortKey] : [],
  );
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
  assert.deepEqual(skill.refreshKeys, ['exploreMinimumInitialWaitMinutes']);

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
  assert.match(text, /父 turn 可写时只能提供行为只读，不得描述为权限隔离/);
  assert.match(text, /任一字段无法原样传递时立即停止/);
  assert.match(text, /不得删除字段或改用预设 role/);
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
          exploreMinimumInitialWaitMinutes: 20,
          standardModel: 'configured-standard',
          standardReasoningEffort: 'max',
        },
      },
    }),
  );
  const configuredSkill = findArtifact(configured, 'codex-explore-skill');
  const configuredStandard = findArtifact(configured, 'codex-explore-standard-role');
  const configuredQuick = findArtifact(configured, 'codex-explore-quick-role');
  assert.match(configuredSkill.content.files['SKILL.md'], /至少 `20` 分钟的单次窗口/);
  assert.match(configuredSkill.content.files['SKILL.md'], /即 `timeout_ms=1200000`/);
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
  assert.match(defaultSkill.content.files['SKILL.md'], /至少 `10` 分钟的单次窗口/);
  assert.match(defaultSkill.content.files['SKILL.md'], /即 `timeout_ms=600000`/);
  assert.equal(defaultStandard.content.roleFile.model, 'gpt-5.6-luna');
  assert.equal(defaultStandard.content.roleFile.model_reasoning_effort, 'high');
}

async function testStaticManifestContract() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assert.equal(manifest.name, 'codex-enhance');
  for (const key of exploreConfigKeys) {
    assert.ok(Object.hasOwn(manifest.config.fields, key), `Missing explore config key ${key}`);
  }
  for (const role of expectedRoles.filter((entry) => entry.modelKey)) {
    assert.equal(manifest.config.fields[role.modelKey].default, role.model);
    assert.equal(manifest.config.fields[role.effortKey].default, role.effort);
    assert.deepEqual(manifest.config.fields[role.effortKey].choices.presets.map((preset) => preset.value), [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  }
  assert.equal(manifest.config.fields.exploreMinimumInitialWaitMinutes.default, 10);
  assert.equal(manifest.config.fields.subagentMinimumInitialWaitMinutes.default, 10);
  assert.equal(Object.hasOwn(manifest.config.fields, 'minimumInitialWaitMinutes'), false);
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
          'simpleTaskModel',
          'simpleTaskReasoningEffort',
          'generalTaskModel',
          'generalTaskReasoningEffort',
          'complexTaskModel',
          'complexTaskReasoningEffort',
          'advancedTaskModel',
          'advancedTaskReasoningEffort',
          'subagentMinimumInitialWaitMinutes',
        ],
      },
    ],
  );
  assert.deepEqual(manifest.marketplace.policy.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);

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
        refreshKeys: ['exploreMinimumInitialWaitMinutes'],
        key: 'codex-explore',
      },
      ...expectedRoles.map((role) => ({
        id: role.id,
        target: 'codex.agentRole',
        refreshKeys: role.modelKey ? [role.modelKey, role.effortKey] : [],
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
  await testStaticManifestContract();
  await testTrimBlockAndUnsupportedPlatform();
  console.log('render-artifacts tests passed');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
