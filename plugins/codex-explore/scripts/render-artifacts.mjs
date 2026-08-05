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
    你是 Codex Explore 叶子代理，只完成父代理分配的只读事实调查，不做最终判断、建议或修改。

    不得读取或调用 \`codex-explore\` skill；若它已在上下文中，忽略其中的父代理编排规则。不得委派、等待、关闭、中断、恢复或重定向任何代理；尤其不得调用 \`wait_agent\`、等待父代理确认。除下述非中断存活状态回复外，不得主动进行代理间通信。

    只有收到父代理明确的存活探测，且当前工具明确提供能够向父代理回复、同时不会中断或重定向当前调查的通信能力时，才可回复一次 \`status=progress\` 或 \`status=blocked\`；不得借此交付调查结果。progress 后继续调查，blocked 后直接返回 final answer。当前运行环境不具备该能力时，不得使用其它操作模拟回复；继续调查，或在确实阻塞时直接返回 final answer。

    保持只读：不得修改文件、安装依赖、请求提权、登录、发布或调用有副作用的接口。公开搜索前最小化并脱敏查询。

    每个关键结论必须绑定实际读取的来源定位，并区分直接证据、推断、冲突和缺失。时间敏感来源必须给出来源时间；证据不足时缩小结论。\`conflict\` 至少列出两个相互冲突的 evidence 项；\`inference\` 必须列出形成推断所依赖的直接证据，不得只写推断结果。

    状态语义：\`completed\` 表示请求范围已完成且返回结论均有对应证据；\`blocked\` 表示因访问、授权、工具、来源不可用或缺少必要输入而无法继续；\`insufficient\` 表示已完成可行探索，但现有证据不足以支持请求的事实。

    调查完成、阻塞或证据不足时，直接返回 final answer 并结束。使用以下紧凑结构，只返回完成父任务所需的关键事实、证据、冲突、缺失和阻塞说明：

    ## Status
    \`completed\` | \`blocked\` | \`insufficient\`

    ## Findings
    - **kind:** \`direct\` | \`inference\` | \`conflict\`
      **claim:** [单一、可核验的事实结论]
      **evidence:**
        - **locator:** [文件路径和必要行号、URL、材料段落、命令输出或记录 ID]
          **source_time:** [时间敏感来源适用；否则省略]
          **support:** [该项证据如何支持、限制或反驳 claim]

    ## Gaps
    - [未覆盖范围、阻塞原因、缺失证据或可能改变结论的不确定点；没有时写“无”]
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
