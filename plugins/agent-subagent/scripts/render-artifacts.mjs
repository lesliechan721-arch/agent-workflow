import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SKILL_CONFIG_KEYS = {
  'spawn-subagent': [
    'generalTaskProfile',
    'simpleTaskProfile',
    'complexTaskProfile',
    'advancedTaskProfile',
    'taskCustomProfiles',
    'subagentCommands',
  ],
};
export const CONFIG_KEYS = SKILL_CONFIG_KEYS['spawn-subagent'];

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
const GENERIC_PROFILES = [
  ['simpleTaskProfile', 'simple', '目标明确、依赖局部，可直接验证'],
  ['generalTaskProfile', 'general', '局部判断和有限取舍，边界及验收清楚'],
  ['complexTaskProfile', 'complex', '多处耦合、假设排查或跨边界验证'],
  ['advancedTaskProfile', 'advanced', '全局取舍、高歧义，关键遗漏代价高'],
];
const OPTIONAL_TIER_KEYS = ['simpleTaskProfile', 'complexTaskProfile', 'advancedTaskProfile'];

const NATIVE_SKILL_DESCRIPTION =
  'description: 需要实际委派、沟通、等待或续接子代理时使用，包括其它技能要求委派，或需按任务难度、指定模型/厂商/异构要求选择原生或外部执行器并准备隔离上下文的情况。已有完整调度与生命周期约定、仅讨论是否委派，或自身只需完成已分配任务时不使用。';
const NATIVE_SHORT_DESCRIPTION =
  '  short-description: 选定执行器与配置、组织隔离任务上下文并管理子代理生命周期';

const SKILL_SECTION_NAMES = [
  'compatibility-generic',
  'compatibility-native-only',
  'compatibility-with-external',
  'generic-description',
  'generic-short-description',
  'routing-generic-inline',
  'routing-generic-selection',
  'routing-native-inline',
  'routing-native-selection',
  'routing-external-uniform',
  'routing-external-full',
  'delegation-generic',
  'delegation-antigravity',
  'delegation-native',
  'delegation-external',
  'selection-intro-native',
  'selection-intro-external',
  'selection-router-native',
  'selection-router-external',
  'custom-profiles-section',
  'default-profiles-uniform-default',
  'default-profiles-uniform-baseline',
  'default-profiles-table',
  'introspection-section',
  'readme-lead-generic',
  'readme-lead-native',
  'readme-scope-generic',
  'readme-scope-external',
  'readme-scope-native-only',
  'readme-bullet-selection-external',
  'readme-bullet-selection-native',
  'readme-bullet-external',
  'readme-bullet-instructions-external',
  'readme-bullet-instructions-native',
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

function escapeTableText(value) {
  return String(value)
    .trim()
    .replace(/\r\n?|\n/gu, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\\', '&#92;')
    .replaceAll('|', '&#124;');
}

function inlineCode(value) {
  return /[`\r\n]/u.test(value) ? display(value) : `\`${value}\``;
}

function tableCode(value) {
  return value.includes('|') ? display(value) : inlineCode(value);
}

function slot(template, marker, text) {
  const token = `<!-- ${marker} -->`;
  if (!template.includes(token)) {
    throw new Error(`Skill template is missing required slot: ${token}`);
  }
  return template.replace(token, () => text);
}

function replaceExact(template, target, replacement, label) {
  if (!template.includes(target)) {
    throw new Error(`Skill template is missing expected ${label} block for adaptation.`);
  }
  return template.replace(target, () => replacement);
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

async function readTaskInstructions(context) {
  const sharedRoot = readBundleRoot(context, './shared');
  return readFile(path.join(sharedRoot, 'task-instructions.md'), 'utf8');
}

async function readSkillSections(context) {
  const sharedRoot = readBundleRoot(context, './shared');
  const template = await readFile(path.join(sharedRoot, 'skill-sections.md'), 'utf8');
  return parseTemplateSections(template, SKILL_SECTION_NAMES);
}

function normalizeProfile(profile, label) {
  if (!isRecord(profile)) throw new Error(`Invalid execution profile object: ${label}.`);
  const executor = Object.hasOwn(profile, 'executor') && profile.executor !== undefined ? profile.executor : 'native';
  return {
    executor,
    ...(Object.hasOwn(profile, 'model') && profile.model !== undefined ? { model: profile.model } : {}),
    ...(Object.hasOwn(profile, 'reasoningEffort') && profile.reasoningEffort !== undefined
      ? { reasoningEffort: profile.reasoningEffort }
      : {}),
  };
}

function sameProfile(left, right) {
  return left.executor === right.executor
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

function resolveConfigValues(context) {
  const values = context?.config?.values;
  if (!isRecord(values)) throw new Error('Resolved config.values is required.');
  if (!Object.hasOwn(values, 'generalTaskProfile') || values.generalTaskProfile === undefined) {
    throw new Error('Missing resolved config value: generalTaskProfile');
  }
  if (!Object.hasOwn(values, 'subagentCommands') || !Array.isArray(values.subagentCommands)) {
    throw new Error('Missing resolved config value: subagentCommands');
  }
  const generalTaskProfile = normalizeProfile(values.generalTaskProfile, 'generalTaskProfile');
  const inheritedTiers = new Set();
  const resolved = {
    generalTaskProfile,
    subagentCommands: values.subagentCommands,
    taskCustomProfiles: Array.isArray(values.taskCustomProfiles) ? values.taskCustomProfiles : [],
  };
  for (const key of OPTIONAL_TIER_KEYS) {
    if (!Object.hasOwn(values, key) || values[key] === undefined) {
      resolved[key] = generalTaskProfile;
      inheritedTiers.add(key);
    } else {
      resolved[key] = normalizeProfile(values[key], key);
    }
  }
  return { config: resolved, inheritedTiers };
}

function isDefaultNativeProfile(profile) {
  return profile.executor === 'native' && profile.model === undefined && profile.reasoningEffort === undefined;
}

function hasCustomProfiles(config) {
  return Array.isArray(config.taskCustomProfiles) && config.taskCustomProfiles.length > 0;
}

function isUniformBaseline(config) {
  if (hasCustomProfiles(config)) return false;
  return OPTIONAL_TIER_KEYS.every((key) => sameProfile(config[key], config.generalTaskProfile));
}

function formatInlineProfile(profile, { platform, generic = false, externalKeys = new Set() }) {
  const { executor, model, reasoningEffort } = profile;
  if (executor === 'native') {
    if (model === undefined && reasoningEffort === undefined) {
      return '`native`（宿主默认）';
    }
    const parts = [];
    if (model !== undefined) parts.push(`\`model\`: ${display(model)}`);
    if (reasoningEffort !== undefined) {
      parts.push(`\`reasoningEffort\`: ${display(reasoningEffort)}`);
    } else if (platform !== 'antigravity') {
      parts.push('`reasoningEffort`: 宿主默认');
    }
    return `\`native\`（${parts.join('，')}）`;
  }
  if (generic || !externalKeys.has(executor)) {
    return `${display(executor)}（当前平台不可用，未显式要求时回退宿主原生并说明）`;
  }
  const parts = [];
  parts.push(model !== undefined ? `\`model\`: ${display(model)}` : '`model`: 后端默认（按需 `inspect` 选型）');
  parts.push(
    reasoningEffort !== undefined
      ? `\`reasoningEffort\`: ${display(reasoningEffort)}`
      : '`reasoningEffort`: 后端默认（按需 `inspect` 选型）',
  );
  return `${display(executor)}（${parts.join('，')}）`;
}

function executionCells(profile, { platform, generic = false, externalKeys = new Set() } = {}) {
  if (!isRecord(profile)) throw new Error('Invalid execution profile object.');
  const executor = Object.hasOwn(profile, 'executor') && profile.executor !== undefined ? profile.executor : 'native';
  if (generic && executor !== 'native') {
    return [
      `${display(executor)}（当前平台不可用：generic 不支持 AW 托管外部执行器；未显式要求时回退宿主原生并说明）`,
      Object.hasOwn(profile, 'model') && profile.model !== undefined ? display(profile.model) : '—',
      Object.hasOwn(profile, 'reasoningEffort') && profile.reasoningEffort !== undefined ? display(profile.reasoningEffort) : '—',
    ];
  }
  if (!generic && executor !== 'native' && !externalKeys.has(executor)) {
    return [
      `${display(executor)}（当前平台未启用该外部执行器；未显式要求时回退宿主原生并说明）`,
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

function profileTable(profiles, config, inheritedTiers, options) {
  return [
    '| 档位 | 适用范围 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- | --- |',
    ...profiles.map(([key, name, description]) => {
      const label = inheritedTiers.has(key) ? `${name}（继承 general）` : name;
      return `| ${[label, description, ...executionCells(config[key], options)].join(' | ')} |`;
    }),
  ].join('\n');
}

function customProfilesSection(sections, profiles, options) {
  if (!Array.isArray(profiles) || profiles.length === 0) return '';
  const rows = profiles
    .map((profile) => `| ${[display(profile.applicability), ...executionCells(profile, options)].join(' | ')} |`)
    .join('\n');
  return `${renderSection(sections, 'custom-profiles-section', { ROWS: rows })}\n\n`;
}

function summarizeStaticModels(command) {
  if (!Array.isArray(command.models) || command.models.length === 0) return '';
  const ids = command.models
    .map((item) => (isRecord(item) && typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null))
    .filter(Boolean);
  if (ids.length === 0) return '';
  const label = command.modelsPolicy === 'override' ? '静态白名单' : '静态补充';
  const shown = ids.slice(0, 4).map(tableCode).join(', ');
  const suffix = ids.length > 4 ? ` 等 ${ids.length} 项` : '';
  return `${label}：${shown}${suffix}`;
}

function formatExecutorDescription(command) {
  const desc = typeof command.description === 'string' && command.description.trim()
    ? escapeTableText(command.description)
    : '';
  const modelHint = summarizeStaticModels(command);
  if (desc && modelHint) return `${desc}〔${modelHint}〕`;
  if (desc) return desc;
  if (modelHint) return `${modelHint}（运行 \`inspect\` 查看详情）`;
  return '动态自省（运行 `inspect` 查看可用模型与推理强度）';
}

function renderCompatibility(sections, context, hasExternalExecutors) {
  if (context.platform === 'generic') return renderSection(sections, 'compatibility-generic');
  return renderSection(sections, hasExternalExecutors ? 'compatibility-with-external' : 'compatibility-native-only');
}

function renderGenericSkillFrontmatter(sections, skillText) {
  let out = replaceExact(skillText, NATIVE_SKILL_DESCRIPTION, renderSection(sections, 'generic-description'), 'description');
  out = replaceExact(out, NATIVE_SHORT_DESCRIPTION, `  ${renderSection(sections, 'generic-short-description')}`, 'short-description');
  return out;
}

function formatCapabilitySummary(context, commands, hasExternalExecutors) {
  if (context.platform === 'generic') {
    return '当前为 `generic` 通用产物，仅支持宿主原生子代理，不包含 AW 托管外部执行器。';
  }
  const hostPart = `当前可用执行器：\`native\`（宿主 \`${context.platform}\`）`;
  if (!hasExternalExecutors) return `${hostPart}；当前无外部执行器。`;
  const externals = commands
    .map((command) => `${inlineCode(command.key)}（${inlineCode(command.adapter)}）`)
    .join('、');
  return `${hostPart}；外部：${externals}。`;
}

function renderExecutorRouting(
  sections,
  context,
  config,
  { includeSelectionFile, hasExternalExecutors, uniformBaseline, externalKeys },
) {
  const isGeneric = context.platform === 'generic';
  const summary = formatCapabilitySummary(context, config.subagentCommands, hasExternalExecutors);
  const baseline = config.generalTaskProfile;
  const baselineLabel = formatInlineProfile(baseline, {
    platform: context.platform,
    generic: isGeneric,
    externalKeys,
  });

  if (isGeneric) {
    if (!includeSelectionFile) {
      const defaultRule = isDefaultNativeProfile(baseline)
        ? '未指定时沿用当前宿主默认子代理配置。'
        : `全部难度档位共用基线 ${baselineLabel}，未指定时直接采用此基线进入下方原生委派分支。`;
      return renderSection(sections, 'routing-generic-inline', { SUMMARY: summary, DEFAULT_RULE: defaultRule });
    }
    return renderSection(sections, 'routing-generic-selection', { SUMMARY: summary });
  }

  if (!hasExternalExecutors) {
    if (!includeSelectionFile) {
      const defaultRule = isDefaultNativeProfile(baseline)
        ? '未指定时沿用当前宿主默认子代理配置。'
        : `全部难度档位共用基线 ${baselineLabel}，未指定时直接采用此基线进入下方 \`native\` 分支。`;
      return renderSection(sections, 'routing-native-inline', { SUMMARY: summary, DEFAULT_RULE: defaultRule });
    }
    return renderSection(sections, 'routing-native-selection', { SUMMARY: summary });
  }

  if (uniformBaseline && baseline.executor === 'native') {
    const directBaseline = isDefaultNativeProfile(baseline)
      ? '全部难度档位共用 `native`（宿主默认），直接进入下方 `native` 分支，无需读取选型文档。'
      : `全部难度档位共用基线 ${baselineLabel}，直接采用此基线进入下方 \`native\` 分支，无需读取选型文档。`;
    return renderSection(sections, 'routing-external-uniform', { SUMMARY: summary, DIRECT_BASELINE: directBaseline });
  }

  return renderSection(sections, 'routing-external-full', { SUMMARY: summary });
}

function renderDelegationBranches(sections, context, hasExternalExecutors) {
  if (context.platform === 'generic') return renderSection(sections, 'delegation-generic');

  const nativeBranch = context.platform === 'antigravity'
    ? renderSection(sections, 'delegation-antigravity')
    : renderSection(sections, 'delegation-native');

  if (!hasExternalExecutors) return nativeBranch;
  return `${nativeBranch}\n\n${renderSection(sections, 'delegation-external')}`;
}

function renderAvailableExecutors(context, commands, hasExternalExecutors) {
  const isGeneric = context.platform === 'generic';
  const rows = [
    '| executor | 类型 / adapter | 说明 |',
    '| --- | --- | --- |',
    isGeneric
      ? '| `native` | 宿主原生 | 当前宿主默认子代理 |'
      : `| \`native\` | 宿主原生（\`${context.platform}\`） | 当前会话默认宿主子代理 |`,
  ];
  if (hasExternalExecutors) {
    for (const command of commands) {
      rows.push(`| ${tableCode(command.key)} | ${tableCode(command.adapter)} | ${formatExecutorDescription(command)} |`);
    }
    return rows.join('\n');
  }
  const note = isGeneric
    ? '当前为 `generic` 通用产物，不包含 AW 托管外部执行器。'
    : '当前无可用外部执行器。';
  return `${rows.join('\n')}\n\n${note}`;
}

function renderDefaultProfiles(sections, config, inheritedTiers, { uniformBaseline, ...options }) {
  if (uniformBaseline) {
    const baseline = config.generalTaskProfile;
    if (isDefaultNativeProfile(baseline)) {
      return renderSection(sections, 'default-profiles-uniform-default');
    }
    if (baseline.executor === 'native' || (!options.generic && options.externalKeys.has(baseline.executor))) {
      return renderSection(sections, 'default-profiles-uniform-baseline', {
        LABEL: formatInlineProfile(baseline, options),
      });
    }
  }
  const customBlock = customProfilesSection(sections, config.taskCustomProfiles, options);
  const table = profileTable(GENERIC_PROFILES, config, inheritedTiers, options);
  if (customBlock) return `${customBlock}${table}`;
  return renderSection(sections, 'default-profiles-table', { TABLE: table });
}

function renderSkillReadme(sections, { isGeneric, includeSelectionFile, includeExternalFiles }) {
  const lead = renderSection(sections, isGeneric ? 'readme-lead-generic' : 'readme-lead-native');
  const scopeNote = renderSection(
    sections,
    isGeneric ? 'readme-scope-generic' : includeExternalFiles ? 'readme-scope-external' : 'readme-scope-native-only',
  );
  const bullets = [];
  if (includeSelectionFile) {
    bullets.push(renderSection(sections, includeExternalFiles ? 'readme-bullet-selection-external' : 'readme-bullet-selection-native'));
  }
  if (includeExternalFiles) {
    bullets.push(renderSection(sections, 'readme-bullet-external'));
  }
  bullets.push(renderSection(sections, includeExternalFiles ? 'readme-bullet-instructions-external' : 'readme-bullet-instructions-native'));
  return `# Spawn Subagent\n\n${lead}\n\n${scopeNote}\n\n${bullets.join('\n')}\n`;
}

async function collectFiles(rootDir, bundlePrefix, relative = '') {
  const current = relative ? path.join(rootDir, relative) : rootDir;
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
    const relPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await collectFiles(rootDir, bundlePrefix, relPath));
    else if (entry.isFile()) {
      result[relPath] = { source: { kind: 'bundle', path: `${bundlePrefix}/${relPath}` } };
    }
  }
  return result;
}

function validateContext(context) {
  if (context?.schemaVersion !== 3 || context.surface !== 'agent-plugin') {
    throw new Error('A PlatformRenderContext v3 with surface=agent-plugin is required.');
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
    capabilities?.schemaVersion !== 3
    || capabilities.platform !== context.platform
    || capabilities.scope !== context.scope
  ) {
    throw new Error('Matching platformCapabilities v3 are required.');
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

  if (context.allowedOutputKinds.includes('skill')) {
    const key = 'spawn-subagent';
    const id = 'spawn-subagent-skill';
    const { config, inheritedTiers } = resolveConfigValues(context);
    const commands = config.subagentCommands;
    const externalKeys = new Set(commands.map((command) => command.key));
    const hasExternalExecutors = !isGeneric && commands.length > 0;
    const uniformBaseline = isUniformBaseline(config);
    const baselineIsNative = config.generalTaskProfile.executor === 'native';
    const includeSelectionFile = hasExternalExecutors || !uniformBaseline || !baselineIsNative;
    const includeExternalFiles = hasExternalExecutors;

    const sourceRoot = readBundleRoot(context, `./skills/${key}`);
    const [instructions, sections] = await Promise.all([
      readTaskInstructions(context),
      readSkillSections(context),
    ]);

    let skillTemplate = await readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8');
    if (isGeneric) {
      skillTemplate = renderGenericSkillFrontmatter(sections, skillTemplate);
    }
    skillTemplate = slot(skillTemplate, 'compatibility', renderCompatibility(sections, context, hasExternalExecutors));
    skillTemplate = slot(
      skillTemplate,
      'executor-routing',
      renderExecutorRouting(sections, context, config, {
        includeSelectionFile,
        hasExternalExecutors,
        uniformBaseline,
        externalKeys,
      }),
    );
    skillTemplate = slot(
      skillTemplate,
      'delegation-branches',
      renderDelegationBranches(sections, context, hasExternalExecutors),
    );

    const files = {
      'SKILL.md': { text: skillTemplate },
      'README.md': (!isGeneric && includeSelectionFile && includeExternalFiles)
        ? { source: { kind: 'bundle', path: `skills/${key}/README.md` } }
        : { text: renderSkillReadme(sections, { isGeneric, includeSelectionFile, includeExternalFiles }) },
      'assets/task-instructions.md': { text: instructions },
      ...(isGeneric ? {} : await collectFiles(sourceRoot, `skills/${key}`, 'agents')),
    };

    if (includeSelectionFile) {
      const selectionRef = 'references/executor-selection.md';
      let selectionTemplate = await readFile(path.join(sourceRoot, selectionRef), 'utf8');
      selectionTemplate = slot(selectionTemplate, 'selection-title', hasExternalExecutors ? '选型与自省' : '执行器选型');
      selectionTemplate = slot(
        selectionTemplate,
        'selection-intro',
        renderSection(sections, isGeneric || !hasExternalExecutors ? 'selection-intro-native' : 'selection-intro-external'),
      );
      selectionTemplate = slot(
        selectionTemplate,
        'selection-router',
        renderSection(sections, isGeneric || !hasExternalExecutors ? 'selection-router-native' : 'selection-router-external'),
      );
      selectionTemplate = slot(
        selectionTemplate,
        'available-executors',
        renderAvailableExecutors(context, commands, hasExternalExecutors),
      );
      selectionTemplate = slot(
        selectionTemplate,
        'default-profiles',
        renderDefaultProfiles(sections, config, inheritedTiers, {
          platform: context.platform,
          generic: isGeneric,
          externalKeys,
          uniformBaseline,
        }),
      );
      selectionTemplate = slot(
        selectionTemplate,
        'introspection-section',
        hasExternalExecutors ? `\n\n${renderSection(sections, 'introspection-section')}` : '',
      );
      files[selectionRef] = { text: selectionTemplate };
    }

    if (includeExternalFiles) {
      files['references/external-execution.md'] = {
        source: { kind: 'bundle', path: `skills/${key}/references/external-execution.md` },
      };
      files['references/communication.md'] = {
        source: { kind: 'bundle', path: `skills/${key}/references/communication.md` },
      };
      Object.assign(files, await collectFiles(sourceRoot, `skills/${key}`, 'docs'));
    }

    plan.components.push({
      id,
      kind: 'skill',
      name: key,
      content: { files },
    });
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
