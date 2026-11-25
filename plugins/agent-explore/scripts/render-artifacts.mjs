import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CONFIG_KEYS = ['exploreProfile', 'deepExploreProfile', 'exploreCustomProfiles'];

const PLATFORMS = [
  'codex',
  'claude',
  'antigravity',
  'cursor',
  'opencode',
  'pi',
  'copilot',
  'grok',
  'generic',
];

const SKILL_ID = 'explore-facts-skill';
const SKILL_NAME = 'explore-facts';
const INSTRUCTION_ID = 'explore-facts-trigger-instruction';
const INSTRUCTION_NAME = 'explore-facts-trigger';

const SKILL_SECTION_NAMES = [
  'compatibility-generic',
  'compatibility-native',
  'routing-default',
  'routing-configured-lead',
  'custom-routing-section',
  'explore-tiers-section',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function display(value) {
  return `\`${JSON.stringify(value)
    .replaceAll('|', '\\u007c')
    .replaceAll('`', '\\u0060')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')}\``;
}

function slot(template, marker, text) {
  const token = `<!-- ${marker} -->`;
  if (!template.includes(token)) {
    throw new Error(`Skill template is missing required slot: ${token}`);
  }
  return template.replace(token, () => text);
}

function parseTemplateSections(template, expectedNames) {
  const allowed = new Set(expectedNames);
  const sections = new Map();
  const pattern = /<!-- aw:([a-z0-9-]+) -->\s*([\s\S]*?)\s*<!-- \/aw:\1 -->/gu;
  for (const match of template.matchAll(pattern)) {
    const [, name, body] = match;
    if (!allowed.has(name) || sections.has(name)) {
      throw new Error(`Invalid skill template section: ${name}`);
    }
    sections.set(name, body);
  }
  if (sections.size !== expectedNames.length || template.replace(pattern, '').trim()) {
    throw new Error('Skill sections template is incomplete or contains unexpected text.');
  }
  return sections;
}

function renderSection(sections, name, values = {}) {
  const raw = sections.get(name);
  if (raw === undefined) throw new Error(`Missing skill template section: ${name}`);
  const tokenPattern = /@@([A-Z0-9_]+)@@/gu;
  if (raw.replace(tokenPattern, '').includes('@@')) {
    throw new Error(`Skill template section "${name}" contains a malformed placeholder.`);
  }
  return raw.replace(tokenPattern, (_match, key) => {
    if (!Object.hasOwn(values, key) || values[key] === undefined) {
      throw new Error(`Skill template section "${name}" is missing binding: ${key}`);
    }
    return values[key];
  });
}

function readBundleRoot(context, name) {
  const resource = context.resources?.find((entry) => entry.kind === 'bundle' && entry.name === name);
  if (!resource || !path.isAbsolute(resource.root)) {
    throw new Error(`Missing verified bundle resource: ${name}`);
  }
  return resource.root;
}

function readOptionalConfig(context) {
  const values = isRecord(context?.config?.values) ? context.config.values : {};
  return {
    exploreProfile: isRecord(values.exploreProfile) ? values.exploreProfile : null,
    deepExploreProfile: isRecord(values.deepExploreProfile) ? values.deepExploreProfile : null,
    exploreCustomProfiles: Array.isArray(values.exploreCustomProfiles) ? values.exploreCustomProfiles : [],
  };
}

function executionCells(profile, { platform, generic = false } = {}) {
  const executor = Object.hasOwn(profile, 'executor') && profile.executor !== undefined ? profile.executor : 'native';
  if (generic && executor !== 'native') {
    return [
      `${display(executor)}（当前为 generic 产物，不支持 AW 托管外部执行器；未显式要求时回退宿主原生并说明）`,
      Object.hasOwn(profile, 'model') && profile.model !== undefined ? display(profile.model) : '—',
      Object.hasOwn(profile, 'reasoningEffort') && profile.reasoningEffort !== undefined ? display(profile.reasoningEffort) : '—',
    ];
  }
  const defaultModelLabel = executor === 'native' ? '宿主默认' : '后端默认（按需 inspect 选型）';
  const defaultEffortLabel = executor === 'native' && platform === 'antigravity'
    ? '—（由模型 ID 编码）'
    : defaultModelLabel;
  return [
    display(executor),
    Object.hasOwn(profile, 'model') && profile.model !== undefined ? display(profile.model) : defaultModelLabel,
    Object.hasOwn(profile, 'reasoningEffort') && profile.reasoningEffort !== undefined
      ? display(profile.reasoningEffort)
      : defaultEffortLabel,
  ];
}

function renderExploreRouting(sections, config, { platform, generic = false } = {}) {
  const hasCustom = config.exploreCustomProfiles.length > 0;
  const hasExplore = config.exploreProfile !== null;
  const hasDeep = config.deepExploreProfile !== null;

  if (!hasCustom && !hasExplore && !hasDeep) {
    return renderSection(sections, 'routing-default');
  }

  const blocks = [renderSection(sections, 'routing-configured-lead')];
  if (hasCustom) {
    const rows = config.exploreCustomProfiles
      .map((profile) => `| ${[display(profile.applicability), ...executionCells(profile, { platform, generic })].join(' | ')} |`)
      .join('\n');
    blocks.push(renderSection(sections, 'custom-routing-section', { ROWS: rows }));
  }

  const exploreCells = hasExplore
    ? executionCells(config.exploreProfile, { platform, generic }).join(' | ')
    : '继承 `spawn-subagent` | `simple`（快扫）/ `general`（常规） | 随所选档位';
  const deepCells = hasDeep
    ? executionCells(config.deepExploreProfile, { platform, generic }).join(' | ')
    : '继承 `spawn-subagent` | `complex` 档 | 随所选档位';

  blocks.push(renderSection(sections, 'explore-tiers-section', {
    EXPLORE_CELLS: exploreCells,
    DEEP_CELLS: deepCells,
  }));

  return blocks.join('\n\n');
}

async function collectFiles(rootDir, bundlePrefix, relative) {
  const current = path.join(rootDir, relative);
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store' || entry.name.endsWith('.test.mjs')) continue;
    const relPath = `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await collectFiles(rootDir, bundlePrefix, relPath));
    else if (entry.isFile()) {
      result[relPath] = { source: { kind: 'bundle', path: `${bundlePrefix}/${relPath}` } };
    }
  }
  return result;
}

function validateContext(context) {
  if (context?.schemaVersion !== 2 || context.surface !== 'agent-plugin') {
    throw new Error('A PlatformRenderContext v2 with surface=agent-plugin is required.');
  }
  if (!PLATFORMS.includes(context.platform)) {
    throw new Error(`Unsupported platform: ${context.platform}`);
  }
  if (
    !Array.isArray(context.allowedOutputKinds)
    || new Set(context.allowedOutputKinds).size !== context.allowedOutputKinds.length
    || context.allowedOutputKinds.some(
      (kind) => !['skill', 'mcp', 'agent', 'hook', 'instruction'].includes(kind),
    )
  ) {
    throw new Error('allowedOutputKinds must contain distinct component kinds.');
  }
  const capabilities = context.platformCapabilities;
  if (
    capabilities?.schemaVersion !== 2
    || capabilities.platform !== context.platform
    || capabilities.scope !== context.scope
  ) {
    throw new Error('Matching platformCapabilities v2 are required.');
  }
}

export async function readArtifactRenderContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) throw new Error('AW_PLUGIN_CONTEXT is required.');
  return JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
}

export async function renderArtifactPlan(context) {
  validateContext(context);
  const plan = { version: 3, components: [], omitted: [], unmet: [] };
  const isGeneric = context.platform === 'generic';
  const config = readOptionalConfig(context);

  if (context.allowedOutputKinds.includes('skill')) {
    const skillRoot = readBundleRoot(context, `./skills/${SKILL_NAME}`);
    const sharedRoot = readBundleRoot(context, './shared');
    const [skillSource, sectionSource] = await Promise.all([
      readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
      readFile(path.join(sharedRoot, 'skill-sections.md'), 'utf8'),
    ]);
    const sections = parseTemplateSections(sectionSource, SKILL_SECTION_NAMES);
    let template = slot(skillSource, 'compatibility', renderSection(sections, isGeneric ? 'compatibility-generic' : 'compatibility-native'));
    template = slot(template, 'explore-routing', renderExploreRouting(sections, config, { platform: context.platform, generic: isGeneric }));

    const files = {
      'SKILL.md': { text: template },
      'README.md': { source: { kind: 'bundle', path: `skills/${SKILL_NAME}/README.md` } },
      ...(isGeneric ? {} : await collectFiles(skillRoot, `skills/${SKILL_NAME}`, 'agents')),
    };

    plan.components.push({
      id: SKILL_ID,
      kind: 'skill',
      name: SKILL_NAME,
      content: { files },
    });
  }

  if (context.allowedOutputKinds.includes('instruction')) {
    if (isGeneric) {
      plan.omitted.push({ id: INSTRUCTION_ID, kind: 'instruction', reason: 'not-offered' });
    } else {
      const sharedRoot = readBundleRoot(context, './shared');
      const instructionText = (await readFile(path.join(sharedRoot, 'trigger-instruction.md'), 'utf8')).trim();
      plan.components.push({
        id: INSTRUCTION_ID,
        kind: 'instruction',
        name: INSTRUCTION_NAME,
        content: {
          title: 'Agent Explore 主动触发指引',
          content: instructionText,
          coverage: ['main'],
        },
      });
    }
  }

  return plan;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  renderArtifactPlan(await readArtifactRenderContext())
    .then((plan) => {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
