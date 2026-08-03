import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./render-artifacts.mjs', import.meta.url));
const scriptModuleUrl = pathToFileURL(scriptPath).href;
const manifestPath = fileURLToPath(new URL('../.agents-plugin/plugin.json', import.meta.url));
const expectedRoles = [
  {
    id: 'codex-explore-quick-role',
    key: 'codex-explore-quick',
    model: 'gpt-5.6-luna',
    effort: 'medium',
  },
  {
    id: 'codex-explore-standard-role',
    key: 'codex-explore-standard',
    model: 'gpt-5.6-luna',
    effort: 'high',
  },
  {
    id: 'codex-explore-deep-role',
    key: 'codex-explore-deep',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
  },
  {
    id: 'codex-explore-custom-role',
    key: 'codex-explore-custom',
  },
];

function createContext(overrides = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-explore',
      version: '0.2.0',
    },
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values: {
        minimumInitialWaitMinutes: 12,
        convergenceWaitMinutes: 6,
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
  assert.deepEqual(role.refreshKeys, []);
  assert.equal(role.content.roleFile.name, expected.key);
  assert.equal(role.content.roleFile.model, expected.model);
  assert.equal(role.content.roleFile.model_reasoning_effort, expected.effort);
  assert.equal(role.content.registration.description, role.content.roleFile.description);
  assert.match(role.content.roleFile.developer_instructions, /叶子探索子代理/);
  assert.match(role.content.roleFile.developer_instructions, /不得调用任何子代理调度或管理工具/);
  assert.match(role.content.roleFile.developer_instructions, /保持只读/);
  assert.match(role.content.roleFile.developer_instructions, /只引用实际读取的来源/);
  assert.match(role.content.roleFile.developer_instructions, /最小化并脱敏查询/);
}

async function testRenderedArtifactsAndSkillContract() {
  const plan = await runRenderer(createContext());
  const skill = findArtifact(plan, 'codex-explore-skill');

  assert.equal(plan.version, 1);
  assert.equal(plan.artifacts.length, 5);
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.state, 'present');
  assert.equal(skill.skillKey, 'codex-explore');
  assert.deepEqual(skill.refreshKeys, [
    'minimumInitialWaitMinutes',
    'convergenceWaitMinutes',
  ]);

  for (const role of expectedRoles) {
    assertRoleArtifact(plan, role);
  }
  const custom = findArtifact(plan, 'codex-explore-custom-role');
  assert.equal('model' in custom.content.roleFile, false);
  assert.equal('model_reasoning_effort' in custom.content.roleFile, false);

  const text = skill.content.skillFile;
  assert.match(text, /也适用于代码 review、缺陷分析、质量判断、修改或实现任务中/);
  assert.match(text, /只负责事实探索，不负责最终判断、建议或写操作/);
  assert.match(text, /顶层任务是 review、缺陷分析、质量判断、修改或实现，不构成排除条件/);
  assert.match(text, /Gate 只判断拟委派的子任务/);
  assert.match(text, /拟委派的子任务本身要求缺陷判定/);
  assert.match(text, /选择优先级固定为/);
  assert.match(text, /无法明确分档时选择 standard/);
  assert.match(text, /`quick` → `codex-explore-quick`/);
  assert.match(text, /`standard` → `codex-explore-standard`/);
  assert.match(text, /`deep` → `codex-explore-deep`/);
  assert.match(text, /选择 `codex-explore-custom`/);
  assert.match(text, /`codex-explore-custom`.*永不自动选择/s);
  assert.match(text, /调用预设 role 时不得传 `model` 或 `reasoning_effort`/);
  assert.match(text, /只传用户实际指定且当前 schema 公开的字段/);
  assert.match(text, /不得删除字段、切换预设或静默重试/);
  assert.match(text, /探索深度：只写 `quick`、`standard` 或 `deep`/);
  assert.match(text, /公开 `fork_turns` 时，传 `"none"`/);
  assert.match(text, /首次最小等待为 `12` 分钟（`timeout_ms=720000`）/);
  assert.match(text, /催促后等待为 `6` 分钟（`timeout_ms=360000`）/);
  assert.match(text, /用户明确要求使用 `codex-explore` 或隔离探索上下文时.*不由主代理接管该范围/s);
  assert.match(text, /本工作流自动触发时.*做一次最小、只读且任务相关的回退/s);
  assert.match(text, /只有当前工具列表提供 `close_agent` 时/);
  assert.match(text, /不得包含密钥、个人数据、私有代码或用户材料原文/);
  assert.equal(text.includes('{{'), false);
  assert.equal(text.includes('codex-explore-agent'), false);
  assert.equal(text.includes('插件默认值'), false);

  assert.match(skill.content.openaiYaml, /allow_implicit_invocation:\s*true/);
  assert.match(skill.content.openaiYaml, /使用 \$codex-explore/);
}

async function testConfigSourcesAndManifestDefaults() {
  const configured = await runRenderer(
    createContext({
      config: undefined,
      renderConfig: {
        values: {
          minimumInitialWaitMinutes: 20,
          convergenceWaitMinutes: 8,
        },
      },
    }),
  );
  const configuredSkill = findArtifact(configured, 'codex-explore-skill');
  assert.match(configuredSkill.content.skillFile, /首次最小等待为 `20` 分钟（`timeout_ms=1200000`）/);
  assert.match(configuredSkill.content.skillFile, /催促后等待为 `8` 分钟（`timeout_ms=480000`）/);

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
  assert.match(defaultSkill.content.skillFile, /首次最小等待为 `10` 分钟（`timeout_ms=600000`）/);
  assert.match(defaultSkill.content.skillFile, /催促后等待为 `5` 分钟（`timeout_ms=300000`）/);
}

async function testStaticManifestContract() {
  const [manifestText, rendererSource] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(scriptPath, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.version, '0.2.0');
  assert.deepEqual(Object.keys(manifest.config.schema), [
    'minimumInitialWaitMinutes',
    'convergenceWaitMinutes',
  ]);
  assert.equal(manifest.config.schema.minimumInitialWaitMinutes.default, 10);
  assert.equal(manifest.config.schema.convergenceWaitMinutes.default, 5);
  assert.equal(manifest.skillTriggers['codex-explore'].defaultTrigger, 'auto');
  assert.equal(manifest.skillTriggers['codex-explore'].allowDynamicTrigger, true);
  assert.deepEqual(manifest.marketplace.policy.products, ['CODEX']);
  assert.equal(manifest.interface.capabilities.includes('Agents'), true);
  assert.match(manifest.extensions.instructions[0].content, /Gate 通过/);

  assert.deepEqual(
    manifest.artifacts.targets.map((target) => ({
      id: target.id,
      target: target.target,
      refreshKeys: target.refreshKeys,
      key: target.skillKey ?? target.roleKey,
    })),
    [
      {
        id: 'codex-explore-skill',
        target: 'codex.skill',
        refreshKeys: ['minimumInitialWaitMinutes', 'convergenceWaitMinutes'],
        key: 'codex-explore',
      },
      ...expectedRoles.map((role) => ({
        id: role.id,
        target: 'codex.agentRole',
        refreshKeys: [],
        key: role.key,
      })),
    ],
  );
  assert.equal(rendererSource.includes('explorerModel'), false);
  assert.equal(rendererSource.includes("'modelReasoningEffort'"), false);
}

async function testTrimBlockAndUnsupportedPlatform() {
  const { trimBlock, renderArtifactPlan } = await import(scriptModuleUrl);
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
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
