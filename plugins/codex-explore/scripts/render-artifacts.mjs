import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CODEX_EXPLORE_SKILL_ID = 'codex-explore-skill';
const CODEX_EXPLORE_SKILL_KEY = 'codex-explore';
const CODEX_EXPLORE_ROLE_ID = 'codex-explore-agent-role';
const CODEX_EXPLORE_ROLE_KEY = 'codex-explore-agent';
const SKILL_REFRESH_KEYS = [
  'explorerModel',
  'modelReasoningEffort',
  'minimumInitialWaitMinutes',
  'convergenceWaitMinutes',
];
const ROLE_REFRESH_KEYS = [];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.resolve(pluginRoot, '.agents-plugin', 'plugin.json');
const skillTemplatePaths = [
  path.resolve(pluginRoot, 'templates', CODEX_EXPLORE_SKILL_KEY, 'SKILL.md'),
  path.resolve(pluginRoot, 'codex', 'templates', CODEX_EXPLORE_SKILL_KEY, 'SKILL.md'),
];
const openaiTemplatePaths = [
  path.resolve(pluginRoot, 'templates', CODEX_EXPLORE_SKILL_KEY, 'agents', 'openai.yaml'),
  path.resolve(pluginRoot, 'codex', 'templates', CODEX_EXPLORE_SKILL_KEY, 'agents', 'openai.yaml'),
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function trimBlock(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  if (lines.length === 0) {
    return '';
  }

  const normalizedLines = lines.map((line) => line.trimEnd());
  const indentation = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0);
  const commonIndent = indentation.length === 0 ? 0 : Math.min(...indentation);

  return normalizedLines
    .map((line) => {
      if (line.trim() === '') {
        return '';
      }
      return line.slice(commonIndent);
    })
    .join('\n');
}

async function readManifestDefaults() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const schema = isRecord(manifest?.config?.schema) ? manifest.config.schema : {};

  return {
    explorerModel:
      typeof schema.explorerModel?.default === 'string' &&
      schema.explorerModel.default.trim() !== ''
        ? schema.explorerModel.default
        : undefined,
    modelReasoningEffort: schema.modelReasoningEffort?.default,
    minimumInitialWaitMinutes: schema.minimumInitialWaitMinutes?.default ?? 10,
    convergenceWaitMinutes: schema.convergenceWaitMinutes?.default ?? 5,
  };
}

function resolvePositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function minutesToMilliseconds(minutes) {
  return Math.round(minutes * 60_000);
}

function resolveOptionalString(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback : undefined;
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
    explorerModel: resolveOptionalString(values.explorerModel, defaults.explorerModel),
    modelReasoningEffort: resolveOptionalString(
      values.modelReasoningEffort,
      defaults.modelReasoningEffort,
    ),
    minimumInitialWaitMinutes: resolvePositiveNumber(
      values.minimumInitialWaitMinutes,
      defaults.minimumInitialWaitMinutes,
    ),
    convergenceWaitMinutes: resolvePositiveNumber(
      values.convergenceWaitMinutes,
      defaults.convergenceWaitMinutes,
    ),
  };
}

function renderSpawnModelGuidance(explorerModel, modelReasoningEffort) {
  const configuredDefaults = [];
  if (explorerModel) {
    configuredDefaults.push(`- \`model\`: \`${explorerModel}\``);
  }
  if (modelReasoningEffort) {
    configuredDefaults.push(`- \`reasoning_effort\`: \`${modelReasoningEffort}\``);
  }

  return [
    '模型和推理强度按字段独立选择，优先级固定为：',
    '1. 用户在当前请求中显式指定的值。',
    '2. 下列插件默认值。',
    '3. 前两者都没有时不传对应参数，让 Codex 使用内建默认。',
    '',
    configuredDefaults.length > 0 ? '当前插件默认值：' : '当前没有配置插件默认值。',
    ...configuredDefaults,
    ...(configuredDefaults.length > 0 ? ['未列出的字段没有插件默认值。'] : []),
    '',
    '只在当前 `spawn_agent` schema 公开对应字段时传 `model` 或 `reasoning_effort`：',
    '- 用户显式指定的字段未公开时，不启动子代理，说明当前调度能力无法满足该指定。',
    '- 只有插件默认值的字段未公开时，省略该字段，向用户说明已降级为 Codex 内建默认，再继续调度。',
    '- 已传入的模型不可用、推理强度不受支持或其它非临时参数错误按启动失败处理；不要省略参数后静默重试。',
  ].join('\n');
}

export function renderRoleDeveloperInstructions() {
  return trimBlock(`
    你是 Codex Explore 的叶子探索子代理，只做只读调查。围绕主代理指定的问题和范围，读取必要的代码、文档、日志、网页或用户材料。完成标准是回答具体问题，并让每个关键结论都能由实际读取的证据核验。

    任务只能由你自己完成；不得调用任何子代理调度或管理工具，包括 \`spawn_agent\`、\`send_input\`、\`send_message\`、\`followup_task\`、\`wait_agent\`、\`resume_agent\`、\`close_agent\`、\`interrupt_agent\`、\`list_agents\`，也不得继续拆分。如果范围过大，只说明需要主代理缩小问题。

    保持只读：不得创建、编辑、移动、删除、格式化或回退文件；不得安装依赖、请求提权、登录账号、购买、发布、发送消息，或调用任何有副作用的外部接口。

    只引用实际读取的来源。每个关键结论紧跟可核验的来源定位，例如文件路径与必要行号、URL、用户材料的段落或行号、命令或工具名称及可识别的输出片段或记录 ID；时间敏感来源还要提供来源时间。明确标记直接证据与推断，报告来源冲突、证据缺失和会影响结论的不确定点。证据不足时缩小结论，不要猜测。

    向公开网页或外部搜索发送查询前，最小化并脱敏查询；不得包含密钥、个人数据、私有代码或用户材料原文。无法安全脱敏时，只使用本地或用户已提供的来源并报告限制。

    除非主代理另有输出要求，对每个关键结论使用以下模板：
    - 结论：
      - 类型：直接证据 | 推断
      - 证据：文件:行号 | URL（来源时间） | 可识别的命令输出或记录 ID
      - 冲突或缺口：
      - 建议补读：

    只返回关键结论和对应证据。避免展开无关材料，不要替主代理实现或修改。
  `);
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce((content, [key, value]) => {
    return content.split(`{{${key}}}`).join(value);
  }, template);
}

async function readFirstExisting(paths) {
  let lastError;
  for (const candidatePath of paths) {
    try {
      return await readFile(candidatePath, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function readSkillTemplates() {
  const [skillTemplate, openaiTemplate] = await Promise.all([
    readFirstExisting(skillTemplatePaths),
    readFirstExisting(openaiTemplatePaths),
  ]);

  return { skillTemplate, openaiTemplate };
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
  const {
    explorerModel,
    modelReasoningEffort,
    minimumInitialWaitMinutes,
    convergenceWaitMinutes,
  } = resolveConfigValues(context, defaults);
  const platform = context?.platform ?? 'codex';

  if (platform !== 'codex') {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const { skillTemplate, openaiTemplate } = await readSkillTemplates();
  const replacements = {
    explorerRoleKey: CODEX_EXPLORE_ROLE_KEY,
    spawnModelGuidance: renderSpawnModelGuidance(explorerModel, modelReasoningEffort),
    minimumInitialWaitMinutes,
    minimumInitialWaitTimeoutMs: minutesToMilliseconds(minimumInitialWaitMinutes),
    convergenceWaitMinutes,
    convergenceWaitTimeoutMs: minutesToMilliseconds(convergenceWaitMinutes),
  };
  const roleDescription = '只读探索代码、文档、网页、日志和大段材料，并整理关键证据。';

  return {
    version: 1,
    artifacts: [
      {
        id: CODEX_EXPLORE_SKILL_ID,
        kind: 'skill',
        platform: 'codex',
        target: 'codex.skill',
        state: 'present',
        skillKey: CODEX_EXPLORE_SKILL_KEY,
        refreshKeys: SKILL_REFRESH_KEYS,
        content: {
          skillFile: renderTemplate(skillTemplate, replacements),
          openaiYaml: renderTemplate(openaiTemplate, replacements),
        },
      },
      {
        id: CODEX_EXPLORE_ROLE_ID,
        kind: 'codexRole',
        platform: 'codex',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: CODEX_EXPLORE_ROLE_KEY,
        refreshKeys: ROLE_REFRESH_KEYS,
        content: {
          registration: {
            description: roleDescription,
          },
          roleFile: {
            name: CODEX_EXPLORE_ROLE_KEY,
            description: roleDescription,
            developer_instructions: renderRoleDeveloperInstructions(),
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
