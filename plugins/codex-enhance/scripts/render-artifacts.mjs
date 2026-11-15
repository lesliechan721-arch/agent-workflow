import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SKILL_CONFIG_KEYS = {
  'codex-advisor': [
    'advisorGeneralProfile', 'advisorAdvancedProfile', 'advisorExpertProfile', 'advisorCustomProfiles',
  ],
  'codex-explore': ['quickProfile', 'standardProfile', 'deepProfile', 'exploreCustomProfiles'],
};
export const CONFIG_KEYS = [...new Set(Object.values(SKILL_CONFIG_KEYS).flat())];
const SKILLS = {
  'codex-explore-skill': 'codex-explore',
  'codex-advisor-skill': 'codex-advisor',
};
const INSTRUCTIONS = {
  'codex-advisor': 'assets/advisor-instructions.md',
  'codex-explore': 'assets/explore-instructions.md',
};
const ROLES = {
  'codex-explore-role': {
    key: 'codex-explore', skill: 'codex-explore',
    description: '只读事实调查与证据核验，直接完成分配的调查；不作最终判断或修改被查项目。',
    localInstructions: '你已经是本次调查的执行者。直接完成当前分配的调查，不要通过 codex-explore 将同一调查重新委派。这只限制重复父级调查编排，不禁止为不同有界子目标采用本次任务允许的协作方法。',
  },
  'codex-advisor-role': {
    key: 'codex-advisor', skill: 'codex-advisor',
    description: '只读技术第二意见，直接完成分配的咨询；不批准或修改被审项目。',
    localInstructions: '你已经是本次咨询的执行者。直接完成当前分配的咨询，不要通过 codex-advisor 将同一咨询重新委派。这只限制重复父级咨询编排，不禁止为不同有界子目标采用本次任务允许的协作方法。',
  },
};
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

function renderProfiles(template, key, config) {
  const [marker, profiles, customKey] = key === 'codex-explore'
      ? ['explore-profiles', EXPLORE_PROFILES, 'exploreCustomProfiles']
      : ['advisor-profiles', ADVISOR_PROFILES, 'advisorCustomProfiles'];
  return slot(template, marker, `${customProfiles(config[customKey])}${profileTable(profiles, config)}`);
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
    for (const [id, key] of Object.entries(SKILLS)) {
      // The scheduling method uses Codex model/effort profiles and the matching
      // spawn-subagent command closure. Role declarations have no such dependency.
      if (context.platform !== 'codex') {
        addGap(plan, id, 'skill', key, { requiredFeatures: [], reasonCode: 'dependency-unmet' });
        continue;
      }
      const gap = capabilityGap(context, 'skill', execution);
      if (gap) { addGap(plan, id, 'skill', key, gap); continue; }
      const config = resolveConfigValues(context, SKILL_CONFIG_KEYS[key]);
      const sourceRoot = readSkillSourceRoot(context, key);
      const template = await readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8');
      plan.components.push({ id, kind: 'skill', name: key, requires: execution,
        content: { files: {
          'SKILL.md': { text: renderProfiles(template, key, config) },
          'README.md': { source: { kind: 'bundle', path: `skills/${key}/README.md` } },
          ...(await runtimeResourceFiles(context, key, 'assets')),
          ...(await runtimeResourceFiles(context, key, 'agents')),
        } } });
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
