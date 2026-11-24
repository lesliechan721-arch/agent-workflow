import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SKILL_CONFIG_KEYS = {
  'spawn-subagent': [
    'simpleTaskProfile',
    'generalTaskProfile',
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
const PREFIXED_ROLE_PLATFORMS = new Set(['codex', 'pi']);
const GENERIC_PROFILES = [
  ['simpleTaskProfile', 'simple', '目标明确、依赖局部，可直接验证'],
  ['generalTaskProfile', 'general', '局部判断和有限取舍，边界及验收清楚'],
  ['complexTaskProfile', 'complex', '多处耦合、假设排查或跨边界验证'],
  ['advancedTaskProfile', 'advanced', '全局取舍、高歧义，关键遗漏代价高'],
];

const NATIVE_SKILL_DESCRIPTION =
  'description: 需要实际委派、沟通、等待或续接子代理时使用，包括其它技能要求委派，或需按任务难度、指定模型/厂商/异构要求选择原生或外部执行器并准备隔离上下文的情况。已有完整调度与生命周期约定、仅讨论是否委派，或自身只需完成已分配任务时不使用。';
const GENERIC_SKILL_DESCRIPTION =
  'description: 需要实际委派、沟通、等待或续接子代理时使用，包括其它技能要求委派，或需确定执行配置、组织隔离上下文并管理等待与验收的情况。已有完整调度与生命周期约定、仅讨论是否委派，或自身只需完成已分配任务时不使用。';
const NATIVE_SHORT_DESCRIPTION =
  '  short-description: 选定执行器与配置、组织隔离任务上下文并管理子代理生命周期';
const GENERIC_SHORT_DESCRIPTION =
  '  short-description: 确定执行配置、组织隔离任务上下文并管理子代理生命周期';

const ROLES = {
  'subagent-role': {
    key: 'subagent',
    description: '完成有界任务，遵守实际任务授权和权限。',
  },
};

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

function resolveConfigValues(context, keys) {
  const values = context?.config?.values;
  if (!isRecord(values)) throw new Error('Resolved config.values is required.');
  return Object.fromEntries(keys.map((key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing resolved config value: ${key}`);
    return [key, values[key]];
  }));
}

function isDefaultNativeProfile(profile) {
  if (!isRecord(profile)) return false;
  const executor = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
  return executor === 'native' && !Object.hasOwn(profile, 'model') && !Object.hasOwn(profile, 'reasoningEffort');
}

function hasNonDefaultProfiles(config) {
  if (Array.isArray(config.taskCustomProfiles) && config.taskCustomProfiles.length > 0) return true;
  return GENERIC_PROFILES.some(([key]) => !isDefaultNativeProfile(config[key]));
}

function executionCells(profile, { generic = false, externalKeys = new Set() } = {}) {
  if (!isRecord(profile)) throw new Error('Invalid execution profile object.');
  const executor = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
  if (generic && executor !== 'native') {
    return [
      `${display(executor)}（当前平台不可用：generic 不支持 AW 托管外部执行器；未显式要求时回退宿主原生并说明）`,
      Object.hasOwn(profile, 'model') ? display(profile.model) : '—',
      Object.hasOwn(profile, 'reasoningEffort') ? display(profile.reasoningEffort) : '—',
    ];
  }
  if (!generic && executor !== 'native' && !externalKeys.has(executor)) {
    return [
      `${display(executor)}（当前平台不可用：未在 subagentCommands 配置；未显式要求时回退宿主原生并说明）`,
      Object.hasOwn(profile, 'model') ? display(profile.model) : '—',
      Object.hasOwn(profile, 'reasoningEffort') ? display(profile.reasoningEffort) : '—',
    ];
  }
  const defaultLabel = executor === 'native' ? '宿主默认' : '后端默认（按需 inspect 选型）';
  return [
    display(executor),
    Object.hasOwn(profile, 'model') ? display(profile.model) : defaultLabel,
    Object.hasOwn(profile, 'reasoningEffort') ? display(profile.reasoningEffort) : defaultLabel,
  ];
}

function profileTable(profiles, config, options) {
  return [
    '| 档位 | 适用范围 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- | --- |',
    ...profiles.map(([key, name, description]) =>
      `| ${[name, description, ...executionCells(config[key], options)].join(' | ')} |`),
  ].join('\n');
}

function customProfilesSection(profiles, options) {
  if (!Array.isArray(profiles) || profiles.length === 0) return '';
  return [
    '### 自定义配置',
    '',
    '按以下数组顺序匹配适用范围，采用第一个匹配项（可用于异构审查或专项场景）。',
    '',
    '| 适用范围 | executor | model | reasoningEffort |',
    '| --- | --- | --- | --- |',
    ...profiles.map((profile) =>
      `| ${[display(profile.applicability), ...executionCells(profile, options)].join(' | ')} |`),
    '',
    '### 内建档位',
    '',
    '仅在调用方未指定执行器、无厂商/异构约束且未命中上方自定义配置时采用；按歧义、耦合、验证难度和遗漏代价选择足够的最低档。',
    '',
    '',
  ].join('\n');
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

function projectedRoleName(context) {
  if (PREFIXED_ROLE_PLATFORMS.has(context.platform)) {
    return `aw-${context.plugin.pluginId.replace('/', '-')}-subagent`;
  }
  return 'subagent';
}

function supportsAgentDelivery(context) {
  if (context.platform === 'generic') return false;
  const delivery = context.platformCapabilities.kinds?.agent?.delivery;
  return Array.isArray(delivery) && delivery.length > 0;
}

function renderCompatibility(context, hasExternalExecutors) {
  if (context.platform === 'generic') {
    return '支持子代理委派的通用 Agent 宿主；本通用产物不包含 AW 托管外部执行器。';
  }
  if (!hasExternalExecutors) {
    return 'AW 支持的宿主；当前未配置外部执行器，仅启用宿主原生委派。';
  }
  return 'AW 支持的宿主及所选执行器；外部执行与自省需要支持托管命令的 AW、已应用的平台配置和对应后端。';
}

function renderGenericSkillFrontmatter(skillText) {
  let out = replaceExact(skillText, NATIVE_SKILL_DESCRIPTION, GENERIC_SKILL_DESCRIPTION, 'description');
  out = replaceExact(out, NATIVE_SHORT_DESCRIPTION, GENERIC_SHORT_DESCRIPTION, 'short-description');
  return out;
}

function formatCapabilitySummary(context, commands, hasExternalExecutors) {
  if (context.platform === 'generic') {
    return '当前为 `generic` 通用产物，仅支持宿主原生子代理，不包含 AW 托管外部执行器。';
  }
  const hostPart = `当前可用执行器：\`native\`（宿主 \`${context.platform}\`）`;
  if (!hasExternalExecutors) {
    return `${hostPart}；当前未配置外部执行器（如需外部执行，先在 \`subagentCommands\` 配置并 \`apply\`）。`;
  }
  const externals = commands
    .map((command) => `${inlineCode(command.key)}（${inlineCode(command.adapter)}）`)
    .join('、');
  return `${hostPart}；外部：${externals}。`;
}

function renderExecutorRouting(context, config, { includeSelectionFile, hasExternalExecutors, nonDefaultProfiles }) {
  const summary = formatCapabilitySummary(context, config.subagentCommands, hasExternalExecutors);
  const omitExecutorNote = '显式配置对象省略 `executor` 时按 `native` 解释（区别于自由文本仅提厂商或模型偏好）。';

  if (context.platform === 'generic') {
    if (!includeSelectionFile) {
      return [
        summary,
        '',
        `${omitExecutorNote}调用方已明确选定原生配置时直接复用；未指定时沿用当前宿主默认子代理配置。明确要求 AW 托管外部执行器或不可用硬约束时，停止并报告缺口。`,
      ].join('\n');
    }
    return [
      summary,
      '',
      `${omitExecutorNote}按当前已掌握信息分流：`,
      '- **调用方已明确选定原生配置**：跳过选型文档，直接进入下方原生委派分支。',
      '- **未指定配置**：先读取 执行器选型（`references/executor-selection.md`）选择档位，不省略选型步骤直接沿用默认。',
      '- **明确要求外部执行器或不可用硬约束**：停止并报告缺口，不私自切换执行器。',
    ].join('\n');
  }

  if (!hasExternalExecutors) {
    if (!includeSelectionFile) {
      return [
        summary,
        '',
        `${omitExecutorNote}调用方已明确选定原生配置时直接复用；未指定时沿用当前宿主默认子代理配置。明确要求外部执行器、特定外部厂商或不可用硬约束时，停止并报告缺口，不私自改派 \`native\`。`,
      ].join('\n');
    }
    return [
      summary,
      '',
      `${omitExecutorNote}按当前已掌握信息分流（**不要省略选型直接沿用默认**）：`,
      '- **调用方已确定 `native` 配置**：跳过选型文档，直接进入下方 `native` 分支。',
      '- **未指定配置**：先读取 执行器选型（`references/executor-selection.md`）选择档位后再委派。',
      '- **明确要求外部执行器、特定外部厂商或不可用硬约束**：停止并报告缺口，不私自切换执行器。',
    ].join('\n');
  }

  if (!nonDefaultProfiles) {
    return [
      summary,
      '',
      `${omitExecutorNote}按当前已掌握信息分流：`,
      '- **未指定执行器且无厂商、模型或异构约束**：当前未覆盖默认档位，直接采用 `native`（宿主默认）进入下方 `native` 分支，无需读取选型文档。',
      '- **已有可执行方案**：已确定 `native`，或已确定上方精确外部 `key` 且已定 `model`（未另要求按复杂度选推理强度）或明确沿用默认 → 跳过选型文档，直接进入下方对应执行分支。',
      '- **需要匹配或自省**：自由文本按厂商/平台/模型偏好指定、要求异构对比，或已定外部 `key` 但省略 `model`（或需按复杂度选推理强度）且未明说沿用默认 → 先读取 选型与自省（`references/executor-selection.md`），确定方案后再委派。',
      '- **要求无法满足**：明确指定了不可用的执行器、厂商或硬约束 → 停止并报告缺口，不私自切换执行器或材料目的地。',
    ].join('\n');
  }

  return [
    summary,
    '',
    `${omitExecutorNote}按当前已掌握信息分流（**不要省略选型直接沿用默认**）：`,
    '- **已有可执行方案**：已确定 `native`，或已确定上方精确外部 `key` 且已定 `model`（未另要求按复杂度选推理强度）或明确沿用默认 → 跳过选型文档，直接进入下方对应执行分支。',
    '- **需要选型、匹配或自省**：未指定配置、自由文本按厂商/平台/模型偏好指定、要求异构对比，或已定外部 `key` 但省略 `model`（或需按复杂度选推理强度）且未明说沿用默认 → 先读取 选型与自省（`references/executor-selection.md`），确定 `{ executor, model?, reasoningEffort? }` 后再委派。',
    '- **要求无法满足**：明确指定了不可用的执行器、厂商或硬约束 → 停止并报告缺口，不私自切换执行器或材料目的地。',
  ].join('\n');
}

function renderDelegationBranches(context, hasExternalExecutors) {
  const isGeneric = context.platform === 'generic';
  const lines = [];

  if (isGeneric) {
    lines.push('### 原生 / 宿主子代理');
    lines.push('');
    lines.push('- **配置与回退**：模型和推理强度按 `明确要求 > 配置偏好 > 宿主默认` 采用；配置偏好经实际报错确认不可用且允许回退时降级并说明实际值。');
    lines.push('- **角色与默认指令**：使用当前宿主可用的子代理机制；未指定角色时，将 任务指令（`assets/task-instructions.md`）的核心边界并入任务提示。');
    lines.push('- **缺口停止**：调用方指定的角色不可用、宿主无可用原生子代理能力或硬要求不受支持时，停止并报告缺口。');
    return lines.join('\n');
  }

  lines.push('### `native` 原生委派');
  lines.push('');
  lines.push('- **配置与回退**：使用宿主原生子代理工具，模型和推理强度按 `明确要求 > 配置偏好 > 宿主默认` 采用；配置偏好经实际报错确认不可用且允许回退时降级并说明实际值。');

  if (!supportsAgentDelivery(context)) {
    lines.push('- **角色与默认指令**：本平台未通过 AW 注册专属 `subagent` 角色，使用宿主默认角色；未指定角色时，将 任务指令（`assets/task-instructions.md`）的核心边界并入任务提示。');
    lines.push('- **缺口停止**：调用方指定的角色不可用、宿主无可用原生子代理工具或硬要求不受支持时，停止并报告缺口。');
  } else {
    const roleName = projectedRoleName(context);
    const piNote = context.platform === 'pi' ? '（Pi 需已启用兼容 subagent 扩展，如 `@tintinweb/pi-subagents`）' : '';
    lines.push(`- **角色与默认指令**：未指定角色时默认使用 \`${roleName}\` 角色${piNote}；当前会话未提供该角色时，回退宿主默认子代理并将 任务指令（\`assets/task-instructions.md\`）纳入任务提示。`);
    lines.push('- **缺口停止**：调用方指定的角色不可用、宿主无可用原生子代理工具或硬要求不受支持时，停止并报告缺口。');
  }

  if (hasExternalExecutors) {
    lines.push('');
    lines.push('### 非 `native` 外部委派');
    lines.push('');
    lines.push('- **启动、等待、取结果或停止**：读取 外部执行协议（`references/external-execution.md`），通过 AW 托管命令执行。');
    lines.push('- **向已有外部 `run` 发消息或终态恢复**：直接读取 通讯与恢复（`references/communication.md`）。');
  }

  return lines.join('\n');
}

function renderSelectionIntro(isGeneric, hasExternalExecutors) {
  if (isGeneric || !hasExternalExecutors) {
    return '本文件用于将未指定的调用意图解析为确定的 `{ executor, model?, reasoningEffort? }`。确定后回到 `SKILL.md` 按原生子代理分支委派。';
  }
  return '本文件用于将调用意图解析为确定的 `{ executor, model?, reasoningEffort? }`。确定后回到 `SKILL.md` 按 `native` 或 外部执行协议（`references/external-execution.md`）委派。';
}

function renderSelectionRouter(isGeneric, hasExternalExecutors) {
  if (isGeneric || !hasExternalExecutors) {
    return [
      '## 按调用意图分流',
      '',
      '- **调用方已明确选定原生配置**（含显式配置对象省略 `executor`）：直接复用，**禁止用“默认执行档位”覆盖已定执行器**。',
      '- **未指定配置**：先按“自定义配置”（若有）匹配适用范围，未命中再按“内建档位”选出足够完成任务的最低档。',
      '- **硬要求与继承回退**：调用方**显式要求**外部执行器或不可用硬约束时，停止并报告缺口，不私自切换执行器；仅未指定执行器而命中当前平台不可用的继承默认档位时，回退宿主原生 `native` 并在汇报中显式说明。',
    ].join('\n');
  }
  return [
    '## 按调用意图分流',
    '',
    '| 调用意图 | 动作 |',
    '| --- | --- |',
    '| **调用方已定 `native` 或精确外部 `key`** | **禁止用“默认执行档位”覆盖已定执行器**（显式配置对象省略 `executor` 按 `native` 解释）。已定 `native` 直接回 `SKILL.md` 执行；已定外部 `key` 且缺 `model`（或需按复杂度选推理强度）且未明说沿用默认时，直接跳至“外部执行器自省”运行 `inspect --executor "<key>"`；已定外部 `key` 与 `model` 且仅省略推理强度、未要求按复杂度挑强度时，可跳过 `inspect` 沿用默认。 |',
    '| **自由文本指定厂商、平台或模型偏好，或要求异构/不同厂商** | 先核对下方“自定义配置”（若有）是否命中对应适用范围，并查“可用执行器”筛选候选（异构时排除与 `native` 宿主同源者）；未定 `model`、需核实某模型归属或需按复杂度选推理强度时，运行 `inspect --executor "<key>"` 确认。 |',
    '| **未指定执行器与约束** | 先按“自定义配置”（若有）数组顺序匹配，未命中再按“内建档位”选出足够完成任务的最低档；若命中外部执行器且省略 `model`（或需按复杂度选推理强度），再运行 `inspect --executor "<key>"` 选型。 |',
    '',
    '调用方**显式要求**的执行器、厂商或硬约束无可用匹配时，停止并报告缺口，不私自切换执行器或材料目的地；仅在未指定执行器而命中当前平台不可用的继承默认档位时，回退宿主原生 `native` 并在汇报中显式说明。',
  ].join('\n');
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
    : '当前未配置外部执行器；如需外部执行，先在 `subagentCommands` 配置并 `apply`。';
  return `${rows.join('\n')}\n\n${note}`;
}

function renderDefaultProfiles(config, options) {
  if (!hasNonDefaultProfiles(config)) {
    return '当前未覆盖默认档位：无执行器、厂商或异构约束时，直接采用 `native`（宿主默认）。';
  }
  const customBlock = customProfilesSection(config.taskCustomProfiles, options);
  if (customBlock) {
    return `${customBlock}${profileTable(GENERIC_PROFILES, config, options)}`;
  }
  return [
    '仅在调用方未指定执行器且无厂商/异构约束时采用；按歧义、耦合、验证难度和遗漏代价选择足够的最低档。',
    '',
    profileTable(GENERIC_PROFILES, config, options),
  ].join('\n');
}

function renderIntrospectionSection(hasExternalExecutors) {
  if (!hasExternalExecutors) return '';
  return [
    '',
    '',
    '## 外部执行器自省（`inspect`）',
    '',
    '常规选型直接运行 `inspect --executor "<key>"`（上方“可用执行器”表已含已配置清单；无参 `inspect` 仅用于离线核对 `communication`/`resume` 等标志）：',
    '- **跳过**：已确定 `model` 且未要求按复杂度选推理强度（或两项均已确定）、用户明确要求沿用后端默认，或同会话内已获取过该执行器目录。',
    '- **调用**：仅确定外部 `key` 但省略 `model`、明确要求按复杂度选推理强度，或需在候选执行器中核实目标模型与 `efforts`。',
    '- **环境不可用（`environment=unavailable`）**：表示后端 CLI 缺失、未认证或配置非法；不要盲目继续 `start`，按 `<diagnostic>` 核对环境问题或停止并报告缺口。',
    '- **未探测环境（`environment=skipped`）**：表示按静态白名单（`modelsPolicy: "override"`）跳过探针，或第三方适配器不支持 `introspect`；若返回静态模型列表（`source=configured`）可直接按白名单发起 `start`，真实后端环境由 `start` 校验。',
    '- **仅目录不可用（`environment` 为 `available` 或 `skipped`、且 `source=unavailable`，无静态模型声明）**：省略 `--model` / `--reasoning-effort` 沿用后端默认并在汇报中说明；**严禁编造未验证的模型 ID**。',
    '',
    '```text',
    '{{aw.command}} inspect --executor "<key>"',
    '{{aw.command}} inspect',
    '```',
    '',
    '- 带 `--executor "<key>"`：按执行器 `modelsPolicy`（默认 `merge` 与动态探针融合；`override` 且静态 `models` 非空时直接采用静态白名单）返回 `source=dynamic|merged|configured|unavailable`、`environment=available|unavailable|skipped`、可用模型与支持的 `efforts`。结合任务复杂度与目录说明选定具体模型及推理强度。',
    '- 无 `--executor`：离线列出当前平台已配置外部执行器摘要（含 `communication`/`resume` 开关），不启动后端进程。',
  ].join('\n');
}

function renderSkillReadme({ isGeneric, includeSelectionFile, includeExternalFiles }) {
  const lead = isGeneric
    ? '本 Skill 用于**实际委派**：确定执行配置、准备隔离任务上下文、等待与续接，并亲自核验结果。核心方法见 [SKILL.md](SKILL.md)。'
    : '本 Skill 用于**实际委派**：选定原生或外部执行器与配置、准备隔离任务上下文、等待与续接，并亲自核验结果。核心方法见 [SKILL.md](SKILL.md)。';
  const scopeNote = isGeneric
    ? '当前为 `generic` 通用产物，仅包含宿主原生委派能力，不包含 AW 托管外部执行器分支：'
    : includeExternalFiles
      ? '按决策阶段按需读取资料，普通原生委派无需预读外部协议：'
      : '当前平台未配置外部执行器，已自动省略外部执行协议与通讯文档：';
  const bullets = [];
  if (includeSelectionFile) {
    bullets.push(includeExternalFiles
      ? '- 需要按任务难度选档、按厂商/平台/模型偏好匹配、筛选异构执行器或运行 `inspect` 自省选型时，读取 [选型与自省](references/executor-selection.md)。'
      : '- 未指定配置需按任务难度选档时，读取 [执行器选型](references/executor-selection.md)。');
  }
  if (includeExternalFiles) {
    bullets.push('- 选定非 `native` 外部执行器后，读取 [外部执行协议](references/external-execution.md)：`start`/`wait`/`result`/`stop`、共用回执格式、三态 `--instructions-file` 与预算边界。');
    bullets.push('- 向运行中外部代理发消息（`communication=true`）、恢复已结束任务（`resume=true`），或收到过程消息与投递缺口时，读取 [通讯与恢复](references/communication.md)。');
  }
  bullets.push(includeExternalFiles
    ? '- [任务指令](assets/task-instructions.md) 为中性默认角色正文，供无专属角色时的原生委派与省略 `--instructions-file` 的外部委派共用。'
    : '- [任务指令](assets/task-instructions.md) 为中性默认角色正文，在未指定角色且当前会话未提供专属角色时纳入任务提示。');
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

function capabilityGap(context, kind, requirements) {
  const facts = context.platformCapabilities;
  const missing = requirements.filter(({ feature, values = [] }) => {
    const fact = facts.features?.[feature];
    return fact?.status !== 'supported' || values.some((value) => !fact.values?.includes(value));
  });
  const kindFact = facts.kinds?.[kind];
  if (kindFact?.status !== 'supported') {
    missing.unshift({ feature: `component.kind.${kind}` });
  }
  if (missing.length === 0) return null;
  const reasonFact = kindFact?.status !== 'supported' ? kindFact : facts.features?.[missing[0].feature];
  return {
    requiredFeatures: missing,
    reasonCode: reasonFact?.reasonCodes?.[0] ?? 'capability-unverified',
  };
}

export async function readArtifactRenderContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) throw new Error('AW_PLUGIN_CONTEXT is required.');
  return JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
}

export async function renderArtifactPlan(context) {
  validateContext(context);
  const plan = { version: 3, components: [], omitted: [], unmet: [] };
  const isGeneric = context.platform === 'generic';
  const hasDeliveryProfile = context.platformCapabilities.deliveryFeatures !== undefined;
  const executionRequirements = [
    { feature: 'agent.execution', values: ['isolated-context'] },
    { feature: 'agent.prompt-mode', values: ['host-default'] },
  ];

  if (context.allowedOutputKinds.includes('skill')) {
    const key = 'spawn-subagent';
    const id = 'spawn-subagent-skill';
    const config = resolveConfigValues(context, CONFIG_KEYS);
    const commands = Array.isArray(config.subagentCommands) ? config.subagentCommands : [];
    const externalKeys = new Set(commands.map((command) => command.key));
    const hasExternalExecutors = !isGeneric && commands.length > 0;
    const nonDefaultProfiles = hasNonDefaultProfiles(config);
    const includeSelectionFile = hasExternalExecutors || nonDefaultProfiles;
    const includeExternalFiles = hasExternalExecutors;

    const sourceRoot = readBundleRoot(context, `./skills/${key}`);
    const instructions = await readTaskInstructions(context);

    let skillTemplate = await readFile(path.join(sourceRoot, 'SKILL.md'), 'utf8');
    if (isGeneric) {
      skillTemplate = renderGenericSkillFrontmatter(skillTemplate);
    }
    skillTemplate = slot(skillTemplate, 'compatibility', renderCompatibility(context, hasExternalExecutors));
    skillTemplate = slot(
      skillTemplate,
      'executor-routing',
      renderExecutorRouting(context, config, { includeSelectionFile, hasExternalExecutors, nonDefaultProfiles }),
    );
    skillTemplate = slot(
      skillTemplate,
      'delegation-branches',
      renderDelegationBranches(context, hasExternalExecutors),
    );

    const files = {
      'SKILL.md': { text: skillTemplate },
      'README.md': (!isGeneric && includeSelectionFile && includeExternalFiles)
        ? { source: { kind: 'bundle', path: `skills/${key}/README.md` } }
        : { text: renderSkillReadme({ isGeneric, includeSelectionFile, includeExternalFiles }) },
      'assets/task-instructions.md': { text: instructions },
      ...(isGeneric ? {} : await collectFiles(sourceRoot, `skills/${key}`, 'agents')),
    };

    if (includeSelectionFile) {
      const selectionRef = 'references/executor-selection.md';
      let selectionTemplate = await readFile(path.join(sourceRoot, selectionRef), 'utf8');
      selectionTemplate = slot(selectionTemplate, 'selection-title', hasExternalExecutors ? '选型与自省' : '执行器选型');
      selectionTemplate = slot(selectionTemplate, 'selection-intro', renderSelectionIntro(isGeneric, hasExternalExecutors));
      selectionTemplate = slot(selectionTemplate, 'selection-router', renderSelectionRouter(isGeneric, hasExternalExecutors));
      selectionTemplate = slot(
        selectionTemplate,
        'available-executors',
        renderAvailableExecutors(context, commands, hasExternalExecutors),
      );
      selectionTemplate = slot(
        selectionTemplate,
        'default-profiles',
        renderDefaultProfiles(config, { generic: isGeneric, externalKeys }),
      );
      selectionTemplate = slot(
        selectionTemplate,
        'introspection-section',
        renderIntrospectionSection(hasExternalExecutors),
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

  if (context.allowedOutputKinds.includes('agent')) {
    const requirements = context.platform === 'pi'
      ? [...executionRequirements, { feature: 'agent.declaration-protocol', values: ['aw.pi.agents.v1'] }]
      : executionRequirements;

    const noDelivery = !supportsAgentDelivery(context);
    const legacyGap = !hasDeliveryProfile && capabilityGap(context, 'agent', requirements);

    for (const [id, role] of Object.entries(ROLES)) {
      if (noDelivery) {
        const gap = capabilityGap(context, 'agent', requirements);
        plan.unmet.push({
          id,
          kind: 'agent',
          name: role.key,
          ...(gap ?? {
            requiredFeatures: [{ feature: 'component.kind.agent' }],
            reasonCode: 'delivery-unavailable',
          }),
        });
      } else if (legacyGap) {
        plan.unmet.push({ id, kind: 'agent', name: role.key, ...legacyGap });
      } else {
        plan.components.push({
          id,
          kind: 'agent',
          name: role.key,
          requires: requirements,
          content: {
            description: role.description,
            prompt: await readTaskInstructions(context),
          },
        });
      }
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
