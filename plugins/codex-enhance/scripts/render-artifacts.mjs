import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CODEX_EXPLORE_SKILL_ID = 'codex-explore-skill';
const CODEX_EXPLORE_SKILL_KEY = 'codex-explore';
const CODEX_SUBAGENT_GUIDE_SKILL_ID = 'codex-subagent-guide-skill';
const CODEX_SUBAGENT_GUIDE_SKILL_KEY = 'codex-subagent-guide';
const CODEX_EXPLORE_ROLES = [
  {
    id: 'codex-explore-quick-role',
    key: 'codex-explore-quick',
    description: '适用于问题明确、低歧义的大范围只读检索与证据定位。',
    profileKey: 'quickProfile',
  },
  {
    id: 'codex-explore-standard-role',
    key: 'codex-explore-standard',
    description: '适用于常规跨文件、跨模块或多来源追踪核对；不确定时选择此档。',
    profileKey: 'standardProfile',
  },
  {
    id: 'codex-explore-deep-role',
    key: 'codex-explore-deep',
    description: '适用于高歧义、强冲突、复杂因果或要求高完整性的深入只读探索。',
    profileKey: 'deepProfile',
  },
  {
    id: 'codex-explore-custom-role',
    key: 'codex-explore-custom',
    description:
      '仅用于用户显式指定 model 或 reasoning_effort 的只读探索；本 role 不锁定模型参数。',
  },
];
const CODEX_SUBAGENT_ROLES = [
  {
    id: 'codex-subagent-simple-role',
    key: 'codex-subagent-simple',
    description: '目标明确、依赖局部、方法已知，可直接或机械验证',
    profileKey: 'simpleTaskProfile',
  },
  {
    id: 'codex-subagent-general-role',
    key: 'codex-subagent-general',
    description: '需要局部判断和有限取舍，边界及验收方式清楚',
    profileKey: 'generalTaskProfile',
  },
  {
    id: 'codex-subagent-complex-role',
    key: 'codex-subagent-complex',
    description: '多处耦合、需要排查假设或较长因果链，需要跨边界验证',
    profileKey: 'complexTaskProfile',
  },
  {
    id: 'codex-subagent-advanced-role',
    key: 'codex-subagent-advanced',
    description:
      '全局或跨领域取舍、高歧义，关键遗漏难以排除或代价很高',
    profileKey: 'advancedTaskProfile',
  },
];
const CONFIGURED_ROLES = [...CODEX_EXPLORE_ROLES, ...CODEX_SUBAGENT_ROLES].filter(
  (role) => role.profileKey,
);
const SUBAGENT_ROLE_DEVELOPER_INSTRUCTIONS =
  '只执行父代理明确委派的任务，包括后续补充或修正；遵守目标、范围、约束和成功标准，不自行扩大范围。续接前核对当前产物与已完成进度，避免重复副作用。完成或无法继续时返回可整合结果，按需附证据、验证、阻塞和未解决项。';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, '..');
const manifestPath = path.resolve(pluginRoot, '.agents-plugin', 'plugin.json');

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
  const indentation = normalizedLines
    .filter((line) => line.trim() !== '')
    .map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0);
  const commonIndent = indentation.length === 0 ? 0 : Math.min(...indentation);

  return normalizedLines
    .map((line) => (line.trim() === '' ? '' : line.slice(commonIndent)))
    .join('\n');
}

async function readManifestDefaults() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const schema = isRecord(manifest?.config?.fields) ? manifest.config.fields : {};

  return {
    roles: Object.fromEntries(
      CONFIGURED_ROLES.map((role) => [
        role.key,
        isRecord(schema[role.profileKey]?.default) ? schema[role.profileKey].default : {},
      ]),
    ),
  };
}

function resolveConfigValues(context, defaults) {
  const candidates = [
    context?.config?.values,
    context?.renderConfig?.values,
    context?.artifactRenderConfig?.values,
    context?.configValues,
  ];
  const values = candidates.find(isRecord) ?? {};

  return {
    roles: Object.fromEntries(
      CONFIGURED_ROLES.map((role) => {
        const roleDefaults = defaults.roles[role.key] ?? {};
        const profile = isRecord(values[role.profileKey])
          ? values[role.profileKey]
          : roleDefaults;
        return [
          role.key,
          {
            model: profile.model,
            reasoningEffort: profile.reasoningEffort,
          },
        ];
      }),
    ),
  };
}

export function renderExploreRoleDeveloperInstructions() {
  return trimBlock(`
    你是 Codex Explore 叶子代理，只完成父代理分配的只读事实调查，不做最终判断、建议或修改。

    不得读取或调用 \`codex-explore\` skill；若它已在上下文中，忽略其中的父代理编排规则。不得委派或管理代理，也不主动进行代理间通信。

    保持只读：不得修改文件、安装依赖、请求提权、登录、发布或调用有副作用的接口。公开搜索前最小化并脱敏查询；不得向外部发送密钥、个人数据、私有代码或用户材料原文。

    每个影响父任务的关键结论必须绑定实际读取且可核验的来源定位。用 \`[direct]\`、\`[inference]\` 或 \`[conflict]\` 标记；inference 给出所依据的直接证据，conflict 给出冲突双方。时间敏感来源在定位后附来源时间。证据与结论的关系不明显时才补一句说明；证据不足时缩小结论。

    调查完成、阻塞或证据不足时直接返回 final answer。首行写 \`Status: completed\`、\`Status: blocked — <原因>\` 或 \`Status: insufficient — <缺失证据>\`。随后输出 \`## Findings\`，每个结论优先用一行：\`- [kind] <claim> — <locator(s)>\`。只在确有未覆盖范围、阻塞、缺失证据或会改变结论的不确定点时输出 \`## Gaps\`。只返回父任务需要的内容，不要复述调查过程。
  `);
}

export function renderSubagentRoleDeveloperInstructions() {
  return SUBAGENT_ROLE_DEVELOPER_INSTRUCTIONS;
}

function renderRoleArtifact(role, developerInstructions, config) {
  return {
    id: role.id,
    kind: 'codexRole',
    platform: 'codex',
    target: 'codex.agentRole',
    state: 'present',
    roleKey: role.key,
    refreshKeys: role.profileKey ? [role.profileKey] : [],
    content: {
      registration: { description: role.description },
      roleFile: {
        name: role.key,
        description: role.description,
        developer_instructions: developerInstructions,
        ...(config.model ? { model: config.model } : {}),
        ...(config.reasoningEffort ? { model_reasoning_effort: config.reasoningEffort } : {}),
      },
    },
  };
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

async function readSkillTemplate(context, skillId, skillKey) {
  const sourceDirs =
    context?.artifactSources?.find(
      (entry) => entry.id === skillId && entry.target === 'codex.skill',
    )?.sourceDirs ?? [];
  return readFirstExisting([
    ...sourceDirs.map((sourceDir) => path.join(sourceDir, 'SKILL.md')),
    path.resolve(pluginRoot, 'skills', skillKey, 'SKILL.md'),
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
  const platform = context?.platform ?? 'codex';
  if (platform !== 'codex') {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  if (!Array.isArray(context?.requestedArtifactIds) || context.requestedArtifactIds.length === 0) {
    throw new Error('requestedArtifactIds must be a non-empty array.');
  }
  const requestedArtifactIds = new Set(context.requestedArtifactIds);
  if (requestedArtifactIds.size !== context.requestedArtifactIds.length) {
    throw new Error('requestedArtifactIds must not contain duplicates.');
  }
  const knownArtifactIds = new Set([
    CODEX_EXPLORE_SKILL_ID,
    ...CODEX_EXPLORE_ROLES.map((role) => role.id),
    CODEX_SUBAGENT_GUIDE_SKILL_ID,
    ...CODEX_SUBAGENT_ROLES.map((role) => role.id),
  ]);
  for (const id of requestedArtifactIds) {
    if (!knownArtifactIds.has(id)) throw new Error(`Unknown requested artifact ID: ${id}`);
  }

  const defaults = await readManifestDefaults();
  const config = resolveConfigValues(context, defaults);
  const [exploreSkillTemplate, subagentSkillTemplate] = await Promise.all([
    requestedArtifactIds.has(CODEX_EXPLORE_SKILL_ID)
      ? readSkillTemplate(context, CODEX_EXPLORE_SKILL_ID, CODEX_EXPLORE_SKILL_KEY)
      : undefined,
    requestedArtifactIds.has(CODEX_SUBAGENT_GUIDE_SKILL_ID)
      ? readSkillTemplate(context, CODEX_SUBAGENT_GUIDE_SKILL_ID, CODEX_SUBAGENT_GUIDE_SKILL_KEY)
      : undefined,
  ]);
  const exploreDeveloperInstructions = renderExploreRoleDeveloperInstructions();
  const subagentDeveloperInstructions = renderSubagentRoleDeveloperInstructions();

  return {
    version: 2,
    artifacts: [
      ...(exploreSkillTemplate ? [{
        id: CODEX_EXPLORE_SKILL_ID,
        kind: 'skill',
        platform: 'codex',
        target: 'codex.skill',
        state: 'present',
        skillKey: CODEX_EXPLORE_SKILL_KEY,
        refreshKeys: [],
        content: {
          files: {
            'SKILL.md': exploreSkillTemplate,
          },
        },
      }] : []),
      ...CODEX_EXPLORE_ROLES.filter((role) => requestedArtifactIds.has(role.id)).map((role) =>
        renderRoleArtifact(role, exploreDeveloperInstructions, config.roles[role.key] ?? {}),
      ),
      ...(subagentSkillTemplate ? [{
        id: CODEX_SUBAGENT_GUIDE_SKILL_ID,
        kind: 'skill',
        platform: 'codex',
        target: 'codex.skill',
        state: 'present',
        skillKey: CODEX_SUBAGENT_GUIDE_SKILL_KEY,
        refreshKeys: [],
        content: {
          files: {
            'SKILL.md': subagentSkillTemplate,
          },
        },
      }] : []),
      ...CODEX_SUBAGENT_ROLES.filter((role) => requestedArtifactIds.has(role.id)).map((role) =>
        renderRoleArtifact(role, subagentDeveloperInstructions, config.roles[role.key] ?? {}),
      ),
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
