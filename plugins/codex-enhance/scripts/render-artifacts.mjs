import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');

export const SKILL_CONFIG_KEYS = {
  'codex-subagent-guide': [
    'simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
    'taskCustomProfiles', 'subagentCommands',
  ],
  'codex-advisor': [
    'advisorGeneralProfile', 'advisorAdvancedProfile', 'advisorExpertProfile', 'advisorCustomProfiles',
  ],
  'codex-explore': ['quickProfile', 'standardProfile', 'deepProfile', 'exploreCustomProfiles'],
};
export const CONFIG_KEYS = [...new Set(Object.values(SKILL_CONFIG_KEYS).flat())];
const SKILLS = {
  'codex-explore-skill': 'codex-explore',
  'codex-subagent-guide-skill': 'codex-subagent-guide',
  'codex-advisor-skill': 'codex-advisor',
};
const INSTRUCTIONS = {
  'codex-subagent-guide': 'assets/task-instructions.md',
  'codex-advisor': 'assets/advisor-instructions.md',
  'codex-explore': 'assets/explore-instructions.md',
};
const ROLES = {
  'codex-explore-role': {
    key: 'codex-explore', skill: 'codex-explore',
    description: '只读事实调查与证据核验，直接完成分配的调查；不作最终判断或修改被查项目。',
    localInstructions: '你已经是本次调查的执行者。直接完成当前分配的调查，不要通过 codex-explore 将同一调查重新委派。这只限制重复父级调查编排，不禁止为不同有界子目标采用本次任务允许的协作方法。',
  },
  'codex-subagent-role': {
    key: 'codex-subagent', skill: 'codex-subagent-guide',
    description: '完成有界任务，遵守实际任务授权和权限。',
  },
  'codex-advisor-role': {
    key: 'codex-advisor', skill: 'codex-advisor',
    description: '只读技术第二意见，直接完成分配的咨询；不批准或修改被审项目。',
    localInstructions: '你已经是本次咨询的执行者。直接完成当前分配的咨询，不要通过 codex-advisor 将同一咨询重新委派。这只限制重复父级咨询编排，不禁止为不同有界子目标采用本次任务允许的协作方法。',
  },
};
const GENERIC_PROFILES = [
  ['simpleTaskProfile', 'simple', '目标明确、依赖局部，可直接验证'],
  ['generalTaskProfile', 'general', '局部判断和有限取舍，边界及验收清楚'],
  ['complexTaskProfile', 'complex', '多处耦合、假设排查或跨边界验证'],
  ['advancedTaskProfile', 'advanced', '全局取舍、高歧义，关键遗漏代价高'],
];
const EXPLORE_PROFILES = [
  ['quickProfile', 'quick', '明确、低歧义的检索定位'],
  ['standardProfile', 'standard', '常规跨文件或多来源核对；不确定时选此档'],
  ['deepProfile', 'deep', '高歧义、强冲突、复杂因果或高完整性要求'],
];
const ADVISOR_PROFILES = [
  ['advisorGeneralProfile', 'general', '问题和边界清楚，主要涉及局部判断或少量方案比较，可用直接证据核验'],
  ['advisorAdvancedProfile', 'advanced', '多模块耦合、多个相互影响的假设或约束，需要比较取舍并核验跨边界影响'],
  ['advisorExpertProfile', 'expert', '高歧义或关键遗漏代价高，涉及复杂系统行为、全局方案或需要深入论证的专业问题'],
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readInstructions(context, manifest, key) {
  const id = Object.keys(SKILLS).find((candidate) => SKILLS[candidate] === key);
  const sourceRoot = await readSkillSourceRoot(context, manifest, id);
  return readFile(path.join(sourceRoot, INSTRUCTIONS[key]), 'utf8');
}

function renderRoleArtifact(id, role, instructions) {
  return {
    id, kind: 'codexRole', platform: 'codex', target: 'codex.agentRole', state: 'present',
    roleKey: role.key, refreshKeys: [],
    content: {
      registration: { description: role.description },
      roleFile: {
        name: role.key, description: role.description,
        developer_instructions: role.localInstructions
          ? `${instructions.trimEnd()}\n\n${role.localInstructions}\n` : instructions,
      },
    },
  };
}

function resolveConfigValues(context, manifest, keys) {
  const candidates = [context?.config?.values, context?.renderConfig?.values,
    context?.artifactRenderConfig?.values, context?.configValues];
  const values = candidates.find(isRecord) ?? {};
  return Object.fromEntries(keys.flatMap((key) => {
    if (Object.hasOwn(values, key)) return [[key, values[key]]];
    const field = manifest.config.fields[key];
    return Object.hasOwn(field, 'default') ? [[key, field.default]] : [];
  }));
}

function display(value) {
  return `\`${JSON.stringify(value).replaceAll('|', '\\u007c').replaceAll('`', '\\u0060')
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\``;
}

function slot(template, marker, text) {
  const token = `<!-- ${marker} -->`;
  if (!template.includes(token)) throw new Error(`Skill is missing its ${marker} slot.`);
  return template.replace(token, () => text);
}

function executionCells(profile) {
  if (!isRecord(profile)) throw new Error('Invalid execution configuration.');
  const executor = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
  if (executor === 'native' && (typeof profile.model !== 'string'
      || typeof profile.reasoningEffort !== 'string')) throw new Error('Incomplete native execution configuration.');
  return [display(executor),
    Object.hasOwn(profile, 'model') ? display(profile.model) : '后端默认',
    Object.hasOwn(profile, 'reasoningEffort') ? display(profile.reasoningEffort) : '后端默认'];
}

function profileTable(profiles, config) {
  return [
    '| 档位 | 适用范围 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- | --- |',
    ...profiles.map(([key, name, description]) =>
      `| ${[name, description, ...executionCells(config[key])].join(' | ')} |`),
  ].join('\n');
}

function customProfiles(profiles) {
  if (profiles.length === 0) return '';
  return [
    '先按以下数组顺序匹配适用范围，采用第一个匹配项；没有匹配项时，再按内建档位选择。',
    '',
    '### 自定义配置',
    '',
    '| 适用范围 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- |',
    ...profiles.map((profile) => `| ${[display(profile.applicability), ...executionCells(profile)].join(' | ')} |`),
    '',
    '### 内建档位',
    '',
    '',
  ].join('\n');
}

function commandTable(commands) {
  if (commands.length === 0) return '当前未配置外部执行器。需要外部执行时，先配置并 apply。';
  return [
    '| key | mode |',
    '| --- | --- |',
    ...commands.map((command) => `| ${[
      command.key,
      command.adapter === 'oracle' ? 'bundle'
        : ['codex', 'claude-code', 'antigravity'].includes(command.adapter) ? 'workspace' : command.mode,
    ].map(display).join(' | ')} |`),
  ].join('\n');
}

function renderProfiles(template, key, config) {
  const [marker, profiles, customKey] = key === 'codex-subagent-guide'
    ? ['generic-profiles', GENERIC_PROFILES, 'taskCustomProfiles']
    : key === 'codex-explore'
      ? ['explore-profiles', EXPLORE_PROFILES, 'exploreCustomProfiles']
      : ['advisor-profiles', ADVISOR_PROFILES, 'advisorCustomProfiles'];
  return slot(template, marker, `${customProfiles(config[customKey])}${profileTable(profiles, config)}`);
}

async function readSkillSourceRoot(context, manifest, id) {
  const declaredSources = manifest.artifacts.targets.find((target) => target.id === id)?.sourceDirs ?? [];
  const sources = context?.artifactSources?.find((entry) => entry.id === id)?.sourceDirs
    ?? declaredSources.map((source) => path.resolve(pluginRoot, source));
  let lastError;
  for (const source of sources) {
    try {
      await readFile(path.join(source, 'SKILL.md'), 'utf8');
      return source;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error(`Skill ${id} has no declared source directory.`);
}

async function runtimeResourceFiles(root, relative) {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await runtimeResourceFiles(root, name));
    else if (entry.isFile() && !entry.name.endsWith('.test.mjs')) {
      result[name] = await readFile(path.join(root, name), 'utf8');
    }
  }
  return result;
}

export async function readArtifactRenderContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) throw new Error('AW_PLUGIN_CONTEXT is required.');
  return JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
}

export async function renderArtifactPlan(context) {
  const platform = context?.platform ?? 'codex';
  if (platform !== 'codex') throw new Error(`Unsupported platform: ${platform}`);
  const ids = context?.requestedArtifactIds;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error('requestedArtifactIds must be a non-empty array without duplicates.');
  }
  for (const id of ids) {
    if (!Object.hasOwn(SKILLS, id) && !Object.hasOwn(ROLES, id)) {
      throw new Error(`Unknown requested artifact: ${id}`);
    }
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const skillIds = ids.filter((id) => Object.hasOwn(SKILLS, id));
  let config;
  if (skillIds.length > 0) {
    const keys = [...new Set(skillIds.flatMap((id) => SKILL_CONFIG_KEYS[SKILLS[id]]))];
    config = resolveConfigValues(context, manifest, keys);
  }

  const artifacts = [];
  for (const id of ids) {
    if (Object.hasOwn(ROLES, id)) {
      const role = ROLES[id];
      artifacts.push(renderRoleArtifact(id, role, await readInstructions(context, manifest, role.skill)));
      continue;
    }
    const key = SKILLS[id];
    const sourceRoot = await readSkillSourceRoot(context, manifest, id);
    const template = await readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8');
    const files = {
      'SKILL.md': key === 'codex-subagent-guide' ? template : renderProfiles(template, key, config),
      [INSTRUCTIONS[key]]: await readFile(path.join(sourceRoot, INSTRUCTIONS[key]), 'utf8'),
      ...(await runtimeResourceFiles(sourceRoot, 'assets')),
      ...(await runtimeResourceFiles(sourceRoot, 'agents')),
      ...(key === 'codex-subagent-guide' ? {
        ...(await runtimeResourceFiles(sourceRoot, 'scripts')),
        ...(await runtimeResourceFiles(sourceRoot, 'references')),
        ...(await runtimeResourceFiles(sourceRoot, 'docs')),
      } : {}),
    };
    if (key === 'codex-subagent-guide') {
      const profilesReference = 'references/execution-profiles.md';
      files[profilesReference] = renderProfiles(
        await readFile(path.join(sourceRoot, profilesReference), 'utf8'), key, config);
      const reference = 'references/external-delegation.md';
      files[reference] = slot(await readFile(path.join(sourceRoot, reference), 'utf8'),
        'subagent-commands', commandTable(config.subagentCommands));
    }
    artifacts.push({
      id, kind: 'skill', platform: 'codex', target: 'codex.skill', state: 'present',
      skillKey: key, refreshKeys: [...SKILL_CONFIG_KEYS[key]], content: { files },
    });
  }
  return { version: 2, artifacts };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  renderArtifactPlan(await readArtifactRenderContext()).then((plan) => {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
