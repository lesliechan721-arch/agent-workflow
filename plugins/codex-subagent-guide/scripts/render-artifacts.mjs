import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SKILL_ID = 'codex-subagent-guide-skill';
const SKILL_KEY = 'codex-subagent-guide';
const ROLE_DEVELOPER_INSTRUCTIONS = '只完成父代理在初始 message 中委派的任务，遵守其中的目标、范围、约束和成功标准；不得自行扩大任务或处理未委派工作。完成或无法继续时直接返回可整合的结果；适用时附关键证据、验证结果、阻塞原因和未解决项。';
const TASK_TYPES = [
  {
    id: 'simple',
    label: '简单',
    description: '低歧义、边界清晰、成功标准明确的只读探索、事实检索、信息整理、运行已有检查、简单代码及其他简单任务',
    roleId: 'codex-subagent-simple-role',
    roleKey: 'codex-subagent-simple',
    modelKey: 'simpleTaskModel',
    effortKey: 'simpleTaskReasoningEffort',
  },
  {
    id: 'general',
    label: '通用',
    description: '超出简单任务范围的常规代码或文档实现，以及写作、转换、协调等通用交付',
    roleId: 'codex-subagent-general-role',
    roleKey: 'codex-subagent-general',
    modelKey: 'generalTaskModel',
    effortKey: 'generalTaskReasoningEffort',
  },
  {
    id: 'complex',
    label: '复杂',
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

  return {
    minimumInitialWaitMinutes: schema.minimumInitialWaitMinutes?.default ?? 10,
    roles: Object.fromEntries(
      TASK_TYPES.map(({ id, modelKey, effortKey }) => [
        id,
        {
          model: optionalString(schema[modelKey]?.default),
          reasoningEffort: optionalString(schema[effortKey]?.default),
        },
      ]),
    ),
  };
}

function resolvePositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveConfig(context, defaults) {
  const values = isRecord(context?.config?.values) ? context.config.values : {};

  return {
    minimumInitialWaitMinutes: resolvePositiveNumber(
      values.minimumInitialWaitMinutes,
      defaults.minimumInitialWaitMinutes,
    ),
    roles: Object.fromEntries(
      TASK_TYPES.map(({ id, modelKey, effortKey }) => [
        id,
        {
          model: optionalString(values[modelKey]) ?? defaults.roles[id].model,
          reasoningEffort: optionalString(values[effortKey]) ?? defaults.roles[id].reasoningEffort,
        },
      ]),
    ),
  };
}

function minutesToMilliseconds(minutes) {
  return Math.round(minutes * 60_000);
}

function renderSpawnParameterGuidance() {
  const rows = TASK_TYPES.map(({ label, description, roleKey }) => {
    return `| ${label} | ${description} | \`${roleKey}\` |`;
  });

  return [
    '对每个子任务，显式指定 `model`、`reasoning_effort` 或 `agent_type` 时按其作用域作为自定义任务；否则按最终交付物选择 preset。计划或审核优先于前置探索，复杂实现或调试优先于通用。',
    '',
    '| 任务类型 | 适用范围 | `agent_type` |',
    '| --- | --- | --- |',
    ...rows,
    '',
    '- 只读不等于简单；按范围、歧义、冲突、因果推理和完整性要求判断复杂度。',
    '- preset 只传表中的 `agent_type`；role 不可用时停止，不改用动态 model override。',
    '- 自定义任务只传作用于该子任务、schema 公开且目标模型支持的显式字段；不可用或冲突时停止，不猜测、试探或降级。',
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
  const sourceDirs = context?.artifactSources?.find(
    (entry) => entry.id === SKILL_ID && entry.target === 'codex.skill',
  )?.sourceDirs ?? [];
  const skillTemplate = await readFirstExisting([
    ...sourceDirs.map((sourceDir) => path.join(sourceDir, 'SKILL.md')),
    ...skillTemplatePaths,
  ]);

  const roleArtifacts = TASK_TYPES.map(
    ({ id, description, roleId, roleKey, modelKey, effortKey }) => {
      const { model, reasoningEffort } = config.roles[id];
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
    version: 2,
    artifacts: [
      {
        id: SKILL_ID,
        kind: 'skill',
        platform: 'codex',
        target: 'codex.skill',
        state: 'present',
        skillKey: SKILL_KEY,
        refreshKeys: ['minimumInitialWaitMinutes'],
        content: {
          files: {
            'SKILL.md': renderTemplate(skillTemplate, {
              spawnParameterGuidance: renderSpawnParameterGuidance(),
              minimumInitialWaitMinutes: config.minimumInitialWaitMinutes,
              minimumInitialWaitTimeoutMs: minutesToMilliseconds(
                config.minimumInitialWaitMinutes,
              ),
            }),
          },
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
