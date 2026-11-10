import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SKILL_CONFIG_KEYS = {
  'spawn-subagent': [
    'simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
    'taskCustomProfiles', 'subagentCommands', 'subagentRetentionHours',
  ],
};
export const CONFIG_KEYS = SKILL_CONFIG_KEYS['spawn-subagent'];
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

async function readInstructions(context, key) {
  const sourceRoot = readSkillSourceRoot(context, key);
  return readFile(path.join(sourceRoot, INSTRUCTIONS[key]), 'utf8');
}

function renderRoleComponent(id, role, instructions, requirements) {
  return {
    id, kind: 'agent', name: role.key,
    requires: requirements,
    content: {
      description: role.description,
      prompt: role.localInstructions
        ? `${instructions.trimEnd()}\n\n${role.localInstructions}\n` : instructions,
    },
  };
}

function resolveConfigValues(context, keys) {
  const values = context?.config?.values;
  if (!isRecord(values)) throw new Error('Resolved config.values is required.');
  return Object.fromEntries(keys.map((key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing resolved config value: ${key}`);
    return [key, values[key]];
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

function readSkillSourceRoot(context, key) {
  const name = `./skills/${key}`;
  const resource = context.resources?.find((entry) => entry.kind === 'bundle' && entry.name === name);
  if (!resource || !path.isAbsolute(resource.root)) {
    throw new Error(`Missing verified bundle resource: ${name}`);
  }
  return resource.root;
}

async function runtimeResourceFiles(context, key, relative) {
  const root = readSkillSourceRoot(context, key);
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await runtimeResourceFiles(context, key, name));
    else if (entry.isFile() && !entry.name.endsWith('.test.mjs')) {
      result[name] = { source: { kind: 'bundle', path: `skills/${key}/${name}` } };
    }
  }
  return result;
}

const PLATFORMS = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok', 'generic'];

function validateContext(context) {
  if (context?.schemaVersion !== 1 || context.surface !== 'agent-plugin') {
    throw new Error('A PlatformRenderContext v1 with surface=agent-plugin is required.');
  }
  if (!PLATFORMS.includes(context.platform)) throw new Error(`Unsupported platform: ${context.platform}`);
  if (!Array.isArray(context.allowedOutputKinds) || new Set(context.allowedOutputKinds).size !== context.allowedOutputKinds.length
      || context.allowedOutputKinds.some((kind) => !['skill', 'mcp', 'agent', 'hook', 'instruction'].includes(kind))) {
    throw new Error('allowedOutputKinds must contain distinct component kinds.');
  }
  const capabilities = context.platformCapabilities;
  if (capabilities?.schemaVersion !== 1 || capabilities.platform !== context.platform || capabilities.scope !== context.scope) {
    throw new Error('Matching platformCapabilities v1 are required.');
  }
}

function capabilityGap(context, kind, requirements) {
  const facts = context.platformCapabilities;
  const missing = requirements.filter(({ feature, values = [] }) => {
    const fact = facts.features[feature];
    return fact?.status !== 'supported' || values.some((value) => !fact.values?.includes(value));
  });
  const kindFact = facts.kinds[kind];
  if (kindFact?.status !== 'supported') missing.unshift({ feature: `component.kind.${kind}` });
  if (missing.length === 0) return null;
  const reasonFact = kindFact?.status !== 'supported' ? kindFact : facts.features[missing[0].feature];
  return { requiredFeatures: missing, reasonCode: reasonFact?.reasonCodes?.[0] ?? 'capability-unverified' };
}

function addGap(plan, id, kind, name, gap) {
  plan.unmet.push({ id, kind, name, ...gap });
}

export async function readArtifactRenderContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) throw new Error('AW_PLUGIN_CONTEXT is required.');
  return JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
}

export async function renderArtifactPlan(context) {
  validateContext(context);
  const plan = { version: 3, components: [], omitted: [], unmet: [] };
  const execution = [{ feature: 'agent.execution', values: ['isolated-context'] },
    { feature: 'agent.prompt-mode', values: ['host-default'] }];

  if (context.allowedOutputKinds.includes('skill')) {
    const id = context.platform === 'claude' ? 'spawn-subagent-claude-skill' : 'spawn-subagent-skill';
    const key = 'spawn-subagent';
    // This method needs a qualified managed-command and installed-runtime-config
    // closure before it can offer external execution on a host.
    if (!['codex', 'claude'].includes(context.platform)) {
      addGap(plan, id, 'skill', key, { requiredFeatures: [], reasonCode: 'dependency-unmet' });
    } else {
      const requirements = [...execution, { feature: 'skill.runtime-config', values: ['aw.installed-runtime-config.v2'] }];
      const gap = capabilityGap(context, 'skill', requirements);
      if (gap) addGap(plan, id, 'skill', key, gap);
      else {
        const config = resolveConfigValues(context, CONFIG_KEYS);
        const sourceRoot = readSkillSourceRoot(context, key);
        const files = {
          'SKILL.md': { source: { kind: 'bundle', path: `skills/${key}/SKILL.md` } },
          'README.md': { source: { kind: 'bundle', path: `skills/${key}/README.md` } },
          ...(await runtimeResourceFiles(context, key, 'references')),
          ...(await runtimeResourceFiles(context, key, 'assets')),
          ...(await runtimeResourceFiles(context, key, 'agents')),
          ...(await runtimeResourceFiles(context, key, 'scripts')),
          ...(await runtimeResourceFiles(context, key, 'docs')),
        };
        const profilesReference = 'references/execution-profiles.md';
        files[profilesReference] = { text: renderProfiles(await readFile(path.join(sourceRoot, profilesReference), 'utf8'), config) };
        const reference = 'references/external-delegation.md';
        files[reference] = { text: slot(await readFile(path.join(sourceRoot, reference), 'utf8'),
          'subagent-commands', commandTable(config.subagentCommands)) };
        if (context.platform === 'claude') {
          for (const name of Object.keys(files)) {
            if (!name.endsWith('.md')) continue;
            const body = files[name].text ?? await readFile(path.join(sourceRoot, name), 'utf8');
            files[name] = { text: body.replaceAll('aw.command:guide/', 'aw.command:guide-claude/')
              .replaceAll('aw.command:guide-communication/', 'aw.command:guide-communication-claude/') };
          }
        }
        plan.components.push({ id, kind: 'skill', name: key, requires: requirements,
          runtimeConfig: { keys: ['subagentCommands', 'subagentRetentionHours'] }, content: { files } });
      }
    }
  }
  if (context.allowedOutputKinds.includes('agent')) {
    const requirements = context.platform === 'pi'
      ? [...execution, { feature: 'agent.declaration-protocol', values: ['aw.pi.agents.v1'] }] : execution;
    for (const [id, role] of Object.entries(ROLES)) {
      const gap = capabilityGap(context, 'agent', requirements);
      if (gap) { addGap(plan, id, 'agent', role.key, gap); continue; }
      plan.components.push(renderRoleComponent(id, role, await readInstructions(context, role.skill), requirements));
    }
  }
  return plan;
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
