import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LIGHTWEIGHT_INSTRUCTION_ID = 'lightweight-instruction';
const CODEX_EXPLORER_ROLE_ID = 'codex-explorer-role';
const CODEX_EXPLORER_ROLE_KEY = 'codex-explorer';
const ROLE_DESCRIPTION = 'Read-only codebase exploration role for Codex Explore.';
const LIGHTWEIGHT_REFRESH_KEYS = [
  'enableLightweightInstruction',
  'explorerModel',
  'modelReasoningEffort',
];
const ROLE_REFRESH_KEYS = ['explorerModel', 'modelReasoningEffort'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimBlock(text) {
  return text
    .trim()
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

async function readManifestDefaults() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(scriptDir, '..', '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const schema = isRecord(manifest?.config?.schema) ? manifest.config.schema : {};

  return {
    enableLightweightInstruction: schema.enableLightweightInstruction?.default ?? true,
    explorerModel: schema.explorerModel?.default ?? 'gpt-5.4-mini',
    modelReasoningEffort: schema.modelReasoningEffort?.default ?? 'medium',
  };
}

function resolveConfigValues(context, defaults) {
  const candidates = [
    context?.config?.values,
    context?.renderConfig?.values,
    context?.artifactRenderConfig?.values,
    context?.configValues,
  ];

  let values = {};
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      values = candidate;
      break;
    }
  }

  return {
    enableLightweightInstruction:
      typeof values.enableLightweightInstruction === 'boolean'
        ? values.enableLightweightInstruction
        : defaults.enableLightweightInstruction,
    explorerModel:
      typeof values.explorerModel === 'string' && values.explorerModel.trim() !== ''
        ? values.explorerModel
        : defaults.explorerModel,
    modelReasoningEffort:
      typeof values.modelReasoningEffort === 'string' && values.modelReasoningEffort.trim() !== ''
        ? values.modelReasoningEffort
        : defaults.modelReasoningEffort,
  };
}

function renderLightweightInstruction({ explorerModel, modelReasoningEffort }) {
  return trimBlock(`
    你可以使用 Codex 内置 \`explorer\` role 来加速代码库探索。该 workflow 只用于边界不清、跨模块、需要比较既有模式、或能和你本地调查并行推进的只读探索问题。

    已知单个文件、单个符号、或 2 到 3 个文件内的小搜索，优先自己用本地工具完成。不要把实现、修改、格式化、提交或需要立即决策的问题交给 explorer。

    使用 explorer 时，默认只启动 1 个。只有多个问题互不重叠且能并行推进时才启动 2 到 3 个；极少数复杂场景最多 4 个。

    默认调用参数：
    - \`agent_type\`: \`explorer\`
    - \`model\`: \`${explorerModel}\`
    - \`reasoning_effort\`: \`${modelReasoningEffort}\`

    如果用户显式指定其它模型，或 Codex runtime 报告 \`${explorerModel}\` 不可用，先向用户说明当前 workflow 默认模型不可用或已被用户指令覆盖，再按用户最新指示处理，不要静默改用其它模型。

    给每个 explorer 的任务必须写清楚：具体问题、范围、探索深度（\`quick\` / \`medium\` / \`very thorough\`）、只读要求和期望输出。提醒它不要创建、编辑、移动、删除、格式化或回退文件，不要安装依赖，不要运行破坏性命令。

    explorer 运行时，继续做不重叠的本地调查。已经启动 explorer 后，必须等待并读取它的结果，不能因为暂时没有返回就关闭 explorer、再由主 agent 自己完成同一个探索问题。整合结果时只保留关键结论、文件路径、必要行号和不确定点；必要时补读少量代码验证。读取并整合结果后，立即关闭本次启动的 explorer。
  `);
}

function renderRoleInstructions() {
  return trimBlock(`
    你是 Codex Explore 的专用只读探索角色，只回答主 agent 明确交给你的代码库问题。

    只读边界：
    - 不要创建、编辑、移动、删除、格式化或回退文件。
    - 不要安装依赖，不要运行破坏性命令。
    - 不要产出实现计划，不要替主 agent 做修改决策。

    输出要围绕主 agent 的具体问题，摘录保持很短，不要搬运大段源码。固定使用下面结构：

    结论
    - ...

    证据
    - 路径 + 必要行号

    不确定点
    - ...

    建议主 agent 下一步查看
    - ...
  `);
}

export async function readArtifactRenderContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required.');
  }

  return JSON.parse(await readFile(contextPath, 'utf8'));
}

export async function renderArtifactPlan(context) {
  const defaults = await readManifestDefaults();
  const { enableLightweightInstruction, explorerModel, modelReasoningEffort } = resolveConfigValues(
    context,
    defaults,
  );
  const platform = context?.platform ?? 'codex';

  if (platform !== 'codex') {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return {
    version: 1,
    artifacts: [
      enableLightweightInstruction
        ? {
            id: LIGHTWEIGHT_INSTRUCTION_ID,
            kind: 'instruction',
            platform: 'codex',
            target: 'codex.developerInstructionsBlock',
            state: 'present',
            refreshKeys: LIGHTWEIGHT_REFRESH_KEYS,
            content: renderLightweightInstruction({
              explorerModel,
              modelReasoningEffort,
            }),
          }
        : {
            id: LIGHTWEIGHT_INSTRUCTION_ID,
            kind: 'instruction',
            platform: 'codex',
            target: 'codex.developerInstructionsBlock',
            state: 'disabled',
            disabledReason: 'config',
            refreshKeys: LIGHTWEIGHT_REFRESH_KEYS,
          },
      {
        id: CODEX_EXPLORER_ROLE_ID,
        kind: 'codexRole',
        platform: 'codex',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: CODEX_EXPLORER_ROLE_KEY,
        refreshKeys: ROLE_REFRESH_KEYS,
        content: {
          registration: {
            description: ROLE_DESCRIPTION,
          },
          roleFile: {
            name: CODEX_EXPLORER_ROLE_KEY,
            description: ROLE_DESCRIPTION,
            developer_instructions: renderRoleInstructions(),
            model: explorerModel,
            model_reasoning_effort: modelReasoningEffort,
          },
        },
      },
    ],
  };
}

async function main() {
  const context = await readArtifactRenderContext();
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
