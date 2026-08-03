import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SKILL_ID = 'codex-subagent-guide-skill';
const SKILL_KEY = 'codex-subagent-guide';
const ROLE_DEVELOPER_INSTRUCTIONS = '完成父代理在初始 message 中委派的任务。严格遵守用户、项目、适用技能和当前工具 schema，保持在给定目标、范围与成功标准内；不要自行扩大任务或替父代理处理未委派工作。完成后返回可直接整合的结果、关键证据、已执行验证及仍未解决的问题。';
const TASK_TYPES = [
  {
    id: 'simple',
    label: '简单任务',
    description: '只读探索、事实检索、信息整理、运行已有检查或验证结果',
    roleId: 'codex-subagent-simple-role',
    roleKey: 'codex-subagent-simple',
    modelKey: 'simpleTaskModel',
    effortKey: 'simpleTaskReasoningEffort',
  },
  {
    id: 'general',
    label: '通用任务',
    description: '常规代码或文档实现，以及写作、转换、协调等通用交付',
    roleId: 'codex-subagent-general-role',
    roleKey: 'codex-subagent-general',
    modelKey: 'generalTaskModel',
    effortKey: 'generalTaskReasoningEffort',
  },
  {
    id: 'complex',
    label: '复杂任务',
    description: '跨模块实现、未知根因调试、并发、生命周期、性能或高风险修改',
    roleId: 'codex-subagent-complex-role',
    roleKey: 'codex-subagent-complex',
    modelKey: 'complexTaskModel',
    effortKey: 'complexTaskReasoningEffort',
  },
  {
    id: 'planningReview',
    label: '计划与审核',
    description: '代码、安全、质量或方案审核，以及架构设计和实施计划',
    roleId: 'codex-subagent-plan-review-role',
    roleKey: 'codex-subagent-plan-review',
    modelKey: 'planningReviewTaskModel',
    effortKey: 'planningReviewTaskReasoningEffort',
  },
];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
const skillTemplatePaths = [
  path.join(pluginRoot, 'templates', SKILL_KEY, 'SKILL.md'),
  path.join(pluginRoot, 'codex', 'templates', SKILL_KEY, 'SKILL.md'),
];
const openaiTemplatePaths = [
  path.join(pluginRoot, 'templates', SKILL_KEY, 'agents', 'openai.yaml'),
  path.join(pluginRoot, 'codex', 'templates', SKILL_KEY, 'agents', 'openai.yaml'),
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function readFirstExisting(paths) {
  let lastError;
  for (const candidate of paths) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readDefaults() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const schema = isRecord(manifest?.config?.schema) ? manifest.config.schema : {};

  return Object.fromEntries(
    TASK_TYPES.map(({ id, modelKey, effortKey }) => [
      id,
      {
        model: optionalString(schema[modelKey]?.default),
        reasoningEffort: optionalString(schema[effortKey]?.default),
      },
    ]),
  );
}

function resolveConfig(context, defaults) {
  const values = isRecord(context?.config?.values) ? context.config.values : {};

  return Object.fromEntries(
    TASK_TYPES.map(({ id, modelKey, effortKey }) => [
      id,
      {
        model: optionalString(values[modelKey]) ?? defaults[id].model,
        reasoningEffort: optionalString(values[effortKey]) ?? defaults[id].reasoningEffort,
      },
    ]),
  );
}

function renderSpawnParameterGuidance() {
  const rows = TASK_TYPES.map(({ label, description, roleKey }) => {
    return `| ${label} | ${description} | \`${roleKey}\` |`;
  });

  return [
    '先判断是否为自定义任务，再按子任务最终交付物选择预定义任务。计划或审核优先于其前置探索；复杂实现与调试优先于通用；只读探索与验证使用简单任务。',
    '',
    '| 任务类型 | 适用范围 | `agent_type` |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '- 预定义任务只传表中的 `agent_type`，不要同时传 `model` 或 `reasoning_effort`。',
    '- 仅当当前 `spawn_agent` schema 公开 `agent_type` 且允许目标 role 时才使用；否则停止调度并说明，不回退到动态 model override。',
    '- 用户当前请求、其它技能或适用规则显式指定任一 `model`、`reasoning_effort` 或 `agent_type` 时，整体作为自定义任务，跳过上表分类和全部预设。',
    '- 自定义任务按适用指令优先级解析，只传自定义规则实际指定且当前 schema 支持的字段；未指定字段不补预设值。',
    '- 自定义字段不可用或固定 role 与显式 model、effort 冲突时停止并说明，不猜测替代值。',
  ].join('\n');
}

export function renderRoleDeveloperInstructions() {
  return ROLE_DEVELOPER_INSTRUCTIONS;
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.split(`{{${key}}}`).join(value),
    template,
  );
}

export async function renderArtifactPlan(context) {
  const platform = context?.platform ?? 'codex';
  if (platform !== 'codex') {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const defaults = await readDefaults();
  const config = resolveConfig(context, defaults);
  const [skillTemplate, openaiTemplate] = await Promise.all([
    readFirstExisting(skillTemplatePaths),
    readFirstExisting(openaiTemplatePaths),
  ]);

  const roleArtifacts = TASK_TYPES.map(
    ({ id, description, roleId, roleKey, modelKey, effortKey }) => {
      const { model, reasoningEffort } = config[id];
      return {
        id: roleId,
        kind: 'codexRole',
        platform: 'codex',
        target: 'codex.agentRole',
        state: 'present',
        roleKey,
        refreshKeys: [modelKey, effortKey],
        content: {
          registration: { description },
          roleFile: {
            name: roleKey,
            description,
            developer_instructions: renderRoleDeveloperInstructions(),
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
          },
        },
      };
    },
  );

  return {
    version: 1,
    artifacts: [
      {
        id: SKILL_ID,
        kind: 'skill',
        platform: 'codex',
        target: 'codex.skill',
        state: 'present',
        skillKey: SKILL_KEY,
        refreshKeys: [],
        content: {
          skillFile: renderTemplate(skillTemplate, {
            spawnParameterGuidance: renderSpawnParameterGuidance(),
          }),
          openaiYaml: openaiTemplate,
        },
      },
      ...roleArtifacts,
    ],
  };
}

async function main() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required.');
  }

  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  const plan = await renderArtifactPlan(context);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
