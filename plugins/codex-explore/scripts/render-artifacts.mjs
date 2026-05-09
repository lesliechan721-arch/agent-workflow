import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CODEX_EXPLORE_SKILL_ID = 'codex-explore-skill';
const CODEX_EXPLORE_SKILL_KEY = 'codex-explore';
const SKILL_REFRESH_KEYS = ['explorerModel', 'modelReasoningEffort'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.resolve(pluginRoot, '.agents-plugin', 'plugin.json');
const skillTemplatePath = path.resolve(pluginRoot, 'skills', CODEX_EXPLORE_SKILL_KEY, 'SKILL.md');
const openaiTemplatePath = path.resolve(
  pluginRoot,
  'skills',
  CODEX_EXPLORE_SKILL_KEY,
  'agents',
  'openai.yaml',
);

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
    - \`agent_type\`: \`explorer\`
    - \`model\`: \`${explorerModel}\`
    - \`reasoning_effort\`: \`${modelReasoningEffort}\`
  `);
}

function renderTemplate(template, replacements) {
  return Object.entries(replacements).reduce((content, [key, value]) => {
    return content.split(`{{${key}}}`).join(value);
  }, template);
}

async function readSkillTemplates() {
  const [skillTemplate, openaiTemplate] = await Promise.all([
    readFile(skillTemplatePath, 'utf8'),
    readFile(openaiTemplatePath, 'utf8'),
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
    explorerModel,
    modelReasoningEffort,
  };

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
