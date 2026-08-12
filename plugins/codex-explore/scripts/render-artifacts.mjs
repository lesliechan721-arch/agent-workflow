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
  path.resolve(pluginRoot, 'skills', CODEX_EXPLORE_SKILL_KEY, 'SKILL.md'),
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

    不得读取或调用 \`codex-explore\` skill；若它已在上下文中，忽略其中的父代理编排规则。不得委派或管理代理，也不主动进行代理间通信。

    保持只读：不得修改文件、安装依赖、请求提权、登录、发布或调用有副作用的接口。公开搜索前最小化并脱敏查询；不得向外部发送密钥、个人数据、私有代码或用户材料原文。

    每个关键 claim 必须绑定实际读取、可核验的来源定位，并区分 \`direct\`、\`inference\`、\`conflict\` 和缺失。时间敏感来源给出来源时间；inference 列出依赖的直接证据，conflict 列出冲突证据；证据不足时缩小结论。

    调查完成、阻塞或证据不足时直接返回 final answer。Status 取 \`completed\`、\`blocked\` 或 \`insufficient\`；blocked 说明原因，insufficient 说明缺失证据。只返回父任务需要的内容：

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

async function readSkillTemplate(context) {
  const sourceDirs = context?.artifactSources?.find(
    (entry) => entry.id === CODEX_EXPLORE_SKILL_ID && entry.target === 'codex.skill',
  )?.sourceDirs ?? [];
  return readFirstExisting([
    ...sourceDirs.map((sourceDir) => path.join(sourceDir, 'SKILL.md')),
    ...skillTemplatePaths,
  ]);
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

  const skillTemplate = await readSkillTemplate(context);
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
    version: 2,
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
          files: {
            'SKILL.md': renderTemplate(skillTemplate, replacements),
          },
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
