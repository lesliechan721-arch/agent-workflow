import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');

export const CONFIG_KEYS = [
  'simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
  'quickProfile', 'standardProfile', 'deepProfile', 'advisorProfile',
  'advisorDesignProfile', 'advisorDebugProfile', 'advisorReviewProfile', 'subagentCommands',
];
export const SKILL_CONFIG_KEYS = {
  'codex-subagent-guide': CONFIG_KEYS,
  'codex-advisor': [
    'advisorProfile', 'advisorDesignProfile', 'advisorDebugProfile', 'advisorReviewProfile',
    'subagentCommands',
  ],
  'codex-explore': ['quickProfile', 'standardProfile', 'deepProfile', 'subagentCommands'],
};
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
    description: '只读事实调查与证据核验；不做最终判断、建议、修改或再次委派。',
  },
  'codex-subagent-role': {
    key: 'codex-subagent', skill: 'codex-subagent-guide',
    description: '直接完成有界任务，遵守实际授权和权限；未明确授权不再委派。',
  },
  'codex-advisor-role': {
    key: 'codex-advisor', skill: 'codex-advisor',
    description: '只读技术第二意见，提供依据和验证建议；不批准、修改或再次委派。',
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
  ['advisorProfile', 'general', '通用技术第二意见'],
  ['advisorDesignProfile', 'design', '设计和实施方案判断'],
  ['advisorDebugProfile', 'debug', '症状、原因与下一项诊断'],
  ['advisorReviewProfile', 'review', '对照要求审查当前产物'],
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
        name: role.key, description: role.description, developer_instructions: instructions,
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

function profileTable(profiles, config) {
  return [
    '| 档位 | 适用范围 | profile | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- | --- | --- |',
    ...profiles.filter(([key]) => Object.hasOwn(config, key)).map(([key, name, description]) => {
      const profile = config[key];
      const executor = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
      return `| ${name} | ${description} | ${display(key)} | ${display(executor)} | ${display(profile.model)} | ${display(profile.reasoningEffort)} |`;
    }),
  ].join('\n');
}

function commandTable(commands) {
  if (commands.length === 0) return '当前未配置外部执行器。需要外部执行时，先配置并 apply。';
  return [
    '| key | 名称 | mode | 独立指令 | read-only | workspace-write |',
    '| --- | --- | --- | --- | --- | --- |',
    ...commands.map((command) => `| ${[
      command.key, command.title, command.mode,
      command.supportsSystemInstructions === true,
      command.supportsReadOnly === true,
      command.mode === 'workspace' && command.supportsWorkspaceWrite === true,
    ].map(display).join(' | ')} |`),
  ].join('\n');
}

function renderSkill(template, key, config) {
  const [marker, profiles] = key === 'codex-subagent-guide'
    ? ['generic-profiles', GENERIC_PROFILES]
    : key === 'codex-explore'
      ? ['explore-profiles', EXPLORE_PROFILES]
      : ['advisor-profiles', ADVISOR_PROFILES];
  const table = profileTable(profiles, config);
  if (key !== 'codex-advisor') return slot(template, marker, table);
  const hasSpecialist = ADVISOR_PROFILES.slice(1).some(([profile]) => Object.hasOwn(config, profile));
  const selection = hasSpecialist
    ? '按本次问题选择下表中的专属配置，其它咨询使用 general；一次只选一项。'
    : '使用以下配置进行本次咨询。';
  return slot(template, marker, `${selection}\n\n${table}`);
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

async function runtimeScriptFiles(root, relative = 'scripts') {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await runtimeScriptFiles(root, name));
    else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
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
      'SKILL.md': renderSkill(template, key, config),
      [INSTRUCTIONS[key]]: await readFile(path.join(sourceRoot, INSTRUCTIONS[key]), 'utf8'),
      ...(key === 'codex-subagent-guide' ? await runtimeScriptFiles(sourceRoot) : {}),
    };
    if (key === 'codex-subagent-guide') {
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
