import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');

export const SKILL_CONFIG_KEYS = {
  'spawn-subagent': [
    'simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
    'taskCustomProfiles', 'subagentCommands', 'subagentRetentionHours',
  ],
};
export const CONFIG_KEYS = SKILL_CONFIG_KEYS['spawn-subagent'];
const SKILLS = { 'spawn-subagent-skill': 'spawn-subagent', 'spawn-subagent-claude-skill': 'spawn-subagent' };
const INSTRUCTIONS = { 'spawn-subagent': 'assets/task-instructions.md' };
const ROLES = { 'subagent-role': {
  key: 'subagent', skill: 'spawn-subagent',
  description: '完成有界任务，遵守实际任务授权和权限。',
} };
const GENERIC_PROFILES = [
  ['simpleTaskProfile', 'simple', '目标明确、依赖局部，可直接验证'],
  ['generalTaskProfile', 'general', '局部判断和有限取舍，边界及验收清楚'],
  ['complexTaskProfile', 'complex', '多处耦合、假设排查或跨边界验证'],
  ['advancedTaskProfile', 'advanced', '全局取舍、高歧义，关键遗漏代价高'],
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
  return [display(executor),
    Object.hasOwn(profile, 'model') ? display(profile.model) : executor === 'native' ? '宿主默认' : '后端默认',
    Object.hasOwn(profile, 'reasoningEffort') ? display(profile.reasoningEffort) : executor === 'native' ? '宿主默认' : '后端默认'];
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

function renderProfiles(template, config) {
  return slot(template, 'generic-profiles', `${customProfiles(config.taskCustomProfiles)}${profileTable(GENERIC_PROFILES, config)}`);
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
    // PE resources stay in sourceDirs, whose copy step preserves their bytes.
    else if (entry.isFile() && !entry.name.endsWith('.test.mjs') && !entry.name.endsWith('.exe')) {
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
  if (!['codex', 'claude'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const ids = context?.requestedArtifactIds;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error('requestedArtifactIds must be a non-empty array without duplicates.');
  }
  for (const id of ids) {
    const declared = (platform === 'codex' ? ['spawn-subagent-skill', 'subagent-role'] : ['spawn-subagent-claude-skill']).includes(id);
    if (!declared) {
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
      'SKILL.md': template,
      ...(await runtimeResourceFiles(sourceRoot, 'references')),
      ...{
        ...(await runtimeResourceFiles(sourceRoot, 'assets')),
        ...(await runtimeResourceFiles(sourceRoot, 'agents')),
        ...(await runtimeResourceFiles(sourceRoot, 'scripts')),
        ...(await runtimeResourceFiles(sourceRoot, 'docs')),
      },
    };
    const profilesReference = 'references/execution-profiles.md';
    files[profilesReference] = renderProfiles(await readFile(path.join(sourceRoot, profilesReference), 'utf8'), config);
    const reference = 'references/external-delegation.md';
    files[reference] = slot(await readFile(path.join(sourceRoot, reference), 'utf8'),
      'subagent-commands', commandTable(config.subagentCommands));
    if (platform === 'claude') {
      for (const [name, body] of Object.entries(files)) {
        if (name.endsWith('.md')) files[name] = body.replaceAll('aw.command:guide/', 'aw.command:guide-claude/')
          .replaceAll('aw.command:guide-communication/', 'aw.command:guide-communication-claude/');
      }
    }
    artifacts.push({
      id, kind: 'skill', platform, target: `${platform}.skill`, state: 'present',
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
