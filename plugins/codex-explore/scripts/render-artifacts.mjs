import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CODEX_EXPLORE_SKILL_ID = 'codex-explore-skill';
const CODEX_EXPLORE_SKILL_KEY = 'codex-explore';
const SKILL_REFRESH_KEYS = [
  'minimumInitialWaitMinutes',
];
const CODEX_EXPLORE_ROLES = [
  {
    id: 'codex-explore-quick-role',
    key: 'codex-explore-quick',
    description: '适用于问题明确、低歧义的大范围只读检索与证据定位。',
    modelKey: 'quickModel',
    effortKey: 'quickReasoningEffort',
  },
  {
    id: 'codex-explore-standard-role',
    key: 'codex-explore-standard',
    description: '适用于常规跨文件、跨模块或多来源追踪核对；不确定时选择此档。',
    modelKey: 'standardModel',
    effortKey: 'standardReasoningEffort',
  },
  {
    id: 'codex-explore-deep-role',
    key: 'codex-explore-deep',
    description: '适用于高歧义、强冲突、复杂因果或要求高完整性的深入只读探索。',
    modelKey: 'deepModel',
    effortKey: 'deepReasoningEffort',
  },
  {
    id: 'codex-explore-custom-role',
    key: 'codex-explore-custom',
    description: '仅用于用户显式指定 model 或 reasoning_effort 的只读探索；本 role 不锁定模型参数。',
  },
];
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

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
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
    minimumInitialWaitMinutes: schema.minimumInitialWaitMinutes?.default ?? 10,
    roles: Object.fromEntries(
      CODEX_EXPLORE_ROLES.map((role) => [
        role.key,
        {
          model: role.modelKey ? optionalString(schema[role.modelKey]?.default) : undefined,
          reasoningEffort: role.effortKey
            ? optionalString(schema[role.effortKey]?.default)
            : undefined,
        },
      ]),
    ),
  };
}

function resolvePositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function minutesToMilliseconds(minutes) {
  return Math.round(minutes * 60_000);
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
    minimumInitialWaitMinutes: resolvePositiveNumber(
      values.minimumInitialWaitMinutes,
      defaults.minimumInitialWaitMinutes,
    ),
    roles: Object.fromEntries(
      CODEX_EXPLORE_ROLES.map((role) => {
        const roleDefaults = defaults.roles[role.key] ?? {};
        return [
          role.key,
          {
            model: role.modelKey
              ? optionalString(values[role.modelKey]) ?? roleDefaults.model
              : undefined,
            reasoningEffort: role.effortKey
              ? optionalString(values[role.effortKey]) ?? roleDefaults.reasoningEffort
              : undefined,
          },
        ];
      }),
    ),
  };
}

export function renderRoleDeveloperInstructions() {
  return trimBlock(`
    你是 Codex Explore 的叶子探索子代理，只做只读调查。围绕主代理指定的问题和范围，读取必要的代码、文档、日志、网页或用户材料。完成标准是回答具体问题，并让每个关键结论都能由实际读取的证据核验。

    任务只能由你自己完成；不得调用任何子代理调度或管理工具，也不得继续拆分。如果范围过大，只说明需要主代理缩小问题。

    不得主动或例行向父代理汇报。唯一例外是收到父代理显式存活探测后，可以只回复一次 \`status=progress\` 和必要进度，或 \`status=blocked\` 和阻塞原因。不得借此委派或要求其它代理工作；回复 progress 后继续原任务，不要为探测缩减范围、提前收敛或结束当前 turn。

    保持只读：不得创建、编辑、移动、删除、格式化或回退文件；不得安装依赖、请求提权、登录账号、购买、发布、向外部人员或服务发送消息，或调用任何有副作用的外部接口。

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

function renderRoleArtifact(role, developerInstructions, config) {
  return {
    id: role.id,
    kind: 'codexRole',
    platform: 'codex',
    target: 'codex.agentRole',
    state: 'present',
    roleKey: role.key,
    refreshKeys: [role.modelKey, role.effortKey].filter(Boolean),
    content: {
      registration: {
        description: role.description,
      },
      roleFile: {
        name: role.key,
        description: role.description,
        developer_instructions: developerInstructions,
        ...(config.model ? { model: config.model } : {}),
        ...(config.reasoningEffort
          ? { model_reasoning_effort: config.reasoningEffort }
          : {}),
      },
    },
  };
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
  const { minimumInitialWaitMinutes, roles } = resolveConfigValues(
    context,
    defaults,
  );
  const platform = context?.platform ?? 'codex';

  if (platform !== 'codex') {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const { skillTemplate, openaiTemplate } = await readSkillTemplates();
  const replacements = {
    quickRoleKey: CODEX_EXPLORE_ROLES[0].key,
    standardRoleKey: CODEX_EXPLORE_ROLES[1].key,
    deepRoleKey: CODEX_EXPLORE_ROLES[2].key,
    customRoleKey: CODEX_EXPLORE_ROLES[3].key,
    minimumInitialWaitMinutes,
    minimumInitialWaitTimeoutMs: minutesToMilliseconds(minimumInitialWaitMinutes),
  };
  const developerInstructions = renderRoleDeveloperInstructions();

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
      ...CODEX_EXPLORE_ROLES.map((role) =>
        renderRoleArtifact(role, developerInstructions, roles[role.key] ?? {})),
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
