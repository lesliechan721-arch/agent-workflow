import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CODEX_EXPLORE_SKILL_ID = 'codex-explore-skill';
const CODEX_EXPLORE_SKILL_KEY = 'codex-explore';
const CODEX_EXPLORE_ROLE_ID = 'codex-explore-agent-role';
const CODEX_EXPLORE_ROLE_KEY = 'codex-explore-agent';
const REFRESH_KEYS = ['explorerModel', 'modelReasoningEffort'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.resolve(pluginRoot, '.agents-plugin', 'plugin.json');
const skillTemplatePaths = [
  path.resolve(pluginRoot, 'skills', CODEX_EXPLORE_SKILL_KEY, 'SKILL.md'),
  path.resolve(pluginRoot, 'codex', 'skills', CODEX_EXPLORE_SKILL_KEY, 'SKILL.md'),
];
const openaiTemplatePaths = [
  path.resolve(pluginRoot, 'skills', CODEX_EXPLORE_SKILL_KEY, 'agents', 'openai.yaml'),
  path.resolve(pluginRoot, 'codex', 'skills', CODEX_EXPLORE_SKILL_KEY, 'agents', 'openai.yaml'),
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

export function renderDefaultExplorerConfig({ explorerModel, modelReasoningEffort }) {
  return trimBlock(`
    - \`agent_type\`: \`${CODEX_EXPLORE_ROLE_KEY}\`
    - role \`model\`: \`${explorerModel}\`
    - role \`model_reasoning_effort\`: \`${modelReasoningEffort}\`
  `);
}

export function renderRoleDeveloperInstructions() {
  return trimBlock(`
    你是 Codex Explore 的叶子探索子代理，只做只读调查。围绕主代理指定的问题和范围，读取必要的代码、文档、日志、网页或用户材料，并给出可核验的结论。

    任务只能由你自己完成；不得调用 \`spawn_agent\`、\`wait_agent\`、\`close_agent\`，也不得继续拆分。如果范围过大，只说明需要主代理缩小问题。

    保持只读：不得创建、编辑、移动、删除、格式化或回退文件；不得安装依赖、请求提权、登录账号、购买、发布、发送消息，或调用任何有副作用的外部接口。

    输出关键结论、证据路径或链接、必要行号、来源时间、不确定点，以及建议主代理下一步查看的少量内容。避免展开无关材料，不要替主代理实现或修改。
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
  const { explorerModel, modelReasoningEffort } = resolveConfigValues(context, defaults);
  const platform = context?.platform ?? 'codex';

  if (platform !== 'codex') {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const { skillTemplate, openaiTemplate } = await readSkillTemplates();
  const replacements = {
    defaultExplorerConfig: renderDefaultExplorerConfig({
      explorerModel,
      modelReasoningEffort,
    }),
    explorerRoleKey: CODEX_EXPLORE_ROLE_KEY,
    explorerModel,
    modelReasoningEffort,
  };
  const roleDescription = '只读探索代码、文档、网页和长上下文，并整理关键证据。';

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
        refreshKeys: REFRESH_KEYS,
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
        refreshKeys: REFRESH_KEYS,
        content: {
          registration: {
            description: roleDescription,
          },
          roleFile: {
            name: CODEX_EXPLORE_ROLE_KEY,
            description: roleDescription,
            developer_instructions: renderRoleDeveloperInstructions(),
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
