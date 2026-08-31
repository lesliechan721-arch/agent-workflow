export const MIN_CODEX_SHORT_DESCRIPTION_LEN = 25;
export const MAX_CODEX_SHORT_DESCRIPTION_LEN = 64;
export const SKILL_INVOCATION_MODES = new Set(['model', 'manual', 'claude-model-only']);

export function titleCaseSlug(value) {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderClaudeInvocationFrontmatter(invocation, supportsClaude) {
  if (!supportsClaude) return '';
  if (invocation === 'manual') {
    return 'user-invocable: true\ndisable-model-invocation: true\n';
  }
  if (invocation === 'claude-model-only') {
    return 'user-invocable: false\n';
  }
  return '';
}

export function renderSkillMd(
  skillName,
  skillDescription,
  shortDescription,
  invocation,
  options = {},
) {
  const skillTitle = titleCaseSlug(skillName);
  const supportsClaude = options.supportsClaude ?? true;
  return `---
name: ${skillName}
description: ${yamlString(skillDescription)}
${renderClaudeInvocationFrontmatter(invocation, supportsClaude)}metadata:
  short-description: ${yamlString(shortDescription)}
---

# ${skillTitle}

目标：[TODO: 写清用户要完成的结果，以及没有本 skill 时 agent 容易做错什么]。

完成标准：

- [TODO: 可观察、可验证的成功结果]

## 前置判断

- [TODO: 需要读取的输入、状态或授权边界]

## 工作流

1. [TODO: 第一步，以及为什么需要这一步]
   完成条件：[TODO: 可检查的第一步结果]
2. [TODO: 第二步]
   完成条件：[TODO: 可检查的第二步结果]
3. [TODO: 运行验证；失败时修复并重跑]
   完成条件：[TODO: 验证通过，或失败已修复并重验]

## 验证

- [TODO: 验证命令、检查表或输出断言]

## 输出

- [TODO: 交付文件、数据或回复结构]

## Gotchas / 边界

- [TODO: 没有明确说明时 agent 容易误判的项目事实]
- [TODO: 禁止、需要确认或不能扩大范围的操作]
`;
}

export function renderPluginReadme(pluginName, description, skillName, options = {}) {
  const capabilities = [
    ...(skillName ? [`| Skill \`${skillName}\` | ${description.replace(/[。.]$/u, '')} | 自动或 \`$${skillName}\` |`] : []),
    ...(options.withMcp ? ['| MCP server | 提供插件声明的工具连接 | 安装后由平台使用 |'] : []),
    ...(options.withApps ? ['| App | 提供插件声明的应用能力 | 安装后由平台使用 |'] : []),
    ...(options.withConfigApi ? ['| 配置 | 保存插件运行所需的用户配置 | 使用 AW 配置页或 `aw config` |'] : []),
  ];
  return `# ${titleCaseSlug(pluginName)}

${description}

## 什么时候使用

- 当你需要${description.replace(/[。.]$/u, '')}时使用。

## 包含的能力

| 能力 | 用途 | 使用方式 |
| --- | --- | --- |
${capabilities.join('\n')}

## 快速开始

\`\`\`bash
aw install ${pluginName} -p both -s user
\`\`\`

示例请求：

- “${description.replace(/[。.]$/u, '')}”
- “${skillName ? `使用 $${skillName} 处理当前任务` : `安装后列出 ${pluginName} 提供的能力`}”

## 平台与安装范围

支持 Codex 和 Claude Code 的 user scope 与 project scope。

## 权限和边界

- 插件只在请求匹配能力或用户显式调用后工作。
- 插件不会自行扩大当前会话的文件、网络或工具权限。
`;
}

export function renderSkillReadme(skillName, description, options = {}) {
  const invocation = options.invocation === 'manual'
    ? `本 Skill 只支持显式调用：\`$${skillName}\`。`
    : options.invocation === 'claude-model-only'
      ? `本 Skill 支持模型自动调用；Claude Code 不显示显式入口。`
      : `模型可以按任务自动调用，也可以显式使用 \`$${skillName}\`。`;
  return `# ${skillName}

${description}

## 什么时候使用

- ${description}

## 怎样调用

${invocation}

示例请求：

- “${description.replace(/[。.]$/u, '')}”

## 会发生什么

1. Agent 检查当前任务和可用上下文。
2. Agent 按 Skill 工作流完成任务，并返回结果或阻塞原因。

## 权限和边界

- 具体写入、网络、外部命令和确认边界以本 Skill 的任务说明为准。
- Skill 不会自行扩大当前会话权限；需要额外授权时会停止并说明。
`;
}

export function renderOpenAiYaml(displayName, shortDescription, skillName, invocation) {
  const defaultPrompt = `使用 $${skillName}：${shortDescription.replace(/[。.]$/, '')}。`;
  const allowImplicitInvocation = invocation !== 'manual';
  return `interface:
  display_name: ${yamlString(displayName)}
  short_description: ${yamlString(shortDescription)}
  default_prompt: ${yamlString(defaultPrompt)}
policy:
  allow_implicit_invocation: ${allowImplicitInvocation}
`;
}

export function renderEvalManifest(pluginName) {
  return {
    version: 1,
    defaults: {
      profile: 'project-default',
    },
    profiles: {
      'project-default': {
        scope: 'project',
        plugins: {
          [pluginName]: {},
        },
      },
      'user-default': {
        scope: 'user',
        plugins: {
          [pluginName]: {},
        },
      },
    },
    suites: [
      {
        id: 'trigger',
        kind: 'trigger',
        cases: 'trigger-cases.json',
        profiles: ['project-default'],
        runs: 3,
        releaseSplits: ['validation', 'sanity'],
        requiredForRelease: true,
        timeoutMs: 180000,
      },
      {
        id: 'behavior',
        kind: 'conversation',
        cases: 'behavior-cases.json',
        profiles: ['project-default'],
        runs: 1,
        releaseSplits: [],
        requiredForRelease: true,
        timeoutMs: 300000,
      },
    ],
  };
}

function renderTriggerPolicy(invocation) {
  if (invocation === 'manual') {
    return {
      optimization: 'precision-first',
      falseNegativeCost: 'medium',
      falsePositiveCost: 'high',
      rationale: 'Manual invocation favors avoiding implicit loads; a missed explicit request is recoverable, but an implicit load can start an unintended workflow.',
    };
  }
  return {
    optimization: 'balanced',
    falseNegativeCost: 'high',
    falsePositiveCost: 'high',
    rationale: 'The Skill must load for its stated user goal and stay inactive for adjacent tasks; either error can make routing unreliable.',
  };
}

function renderTriggerBoundaryAudit(skillName, invocation) {
  const manual = invocation === 'manual';
  return {
    rationale: manual
      ? 'The prompt does not explicitly invoke the manual Skill and asks for an adjacent task only.'
      : 'The prompt shares vocabulary with the Skill but explicitly excludes its stated user goal.',
    minimalCounterexample: manual
      ? `Add an explicit $${skillName} invocation while keeping the requested workflow unchanged; the expected label flips to load.`
      : 'Replace the adjacent goal with the owner Skill user goal while keeping the shared vocabulary; the expected label flips to load.',
  };
}

export function renderTriggerCases(skillName, skillDescription, invocation) {
  const explicitPrefix = invocation === 'manual' ? `使用 $${skillName}，` : '';
  const validationPositive = invocation === 'manual'
    ? `${explicitPrefix}请使用真实输入完成目标工作流。`
    : `请使用真实输入完成以下目标：${skillDescription}。`;
  const sanityPositive = invocation === 'manual'
    ? `${explicitPrefix}请完成该 Skill 的主要目标。`
    : `请完成以下主要目标：${skillDescription}。`;
  const implicitNegative = invocation === 'manual'
    ? '请不要调用任何 Skill，只解释如何完成相邻任务；这不是目标 Skill 的显式请求。'
    : `解释一个共享术语但职责不同的相邻任务；不要执行以下目标：${skillDescription}。`;
  return {
    version: 1,
    suite: {
      kind: 'trigger',
      unitUnderTest: skillName,
      defaultGrader: 'mechanical',
      policy: renderTriggerPolicy(invocation),
      runtime: {
        observeSpawnAgent: false,
        isolation: 'strict',
        strictNegativeSplits: ['validation', 'sanity'],
        forbidMultipleSkillLoads: false,
      },
    },
    cases: [
      {
        id: 'primary_train_positive',
        split: 'train',
        tags: [invocation, 'positive', 'starter'],
        input: {
          query: `${explicitPrefix}${skillDescription}。`,
          expectedLoad: true,
        },
      },
      {
        id: 'primary_train_negative',
        split: 'train',
        tags: ['boundary', 'near-miss', 'negative', 'starter'],
        input: {
          query: implicitNegative,
          expectedLoad: false,
        },
        audit: renderTriggerBoundaryAudit(skillName, invocation),
      },
      {
        id: 'primary_validation_positive',
        split: 'validation',
        tags: [invocation, 'positive', 'starter'],
        input: {
          query: validationPositive,
          expectedLoad: true,
        },
      },
      {
        id: 'primary_validation_negative',
        split: 'validation',
        tags: ['boundary', 'near-miss', 'negative', 'starter'],
        input: {
          query: '只处理一个共享关键词但目标不同的近似任务，不要调用该 Skill。',
          expectedLoad: false,
        },
        audit: renderTriggerBoundaryAudit(skillName, invocation),
      },
      {
        id: 'primary_sanity_positive',
        split: 'sanity',
        tags: [invocation, 'positive', 'starter'],
        input: {
          query: sanityPositive,
          expectedLoad: true,
        },
      },
      {
        id: 'primary_sanity_negative',
        split: 'sanity',
        tags: ['boundary', 'near-miss', 'negative', 'starter'],
        input: {
          query: '执行另一个职责边界外的任务；即使出现相同术语，也不要加载该 Skill。',
          expectedLoad: false,
        },
        audit: renderTriggerBoundaryAudit(skillName, invocation),
      },
    ],
  };
}

export function renderBehaviorCases(skillName, skillDescription) {
  return {
    version: 1,
    suite: {
      kind: 'conversation',
      unitUnderTest: skillName,
      defaultGrader: 'independent-llm',
      policy: {
        optimization: 'precision-first',
        falseNegativeCost: 'medium',
        falsePositiveCost: 'high',
        rationale: 'Rejecting an acceptable result causes rework, while accepting an incomplete or unsafe result can ship a broken plugin.',
      },
      runtime: {
        isolation: 'strict',
      },
    },
    cases: [
      {
        id: 'complete_primary_workflow',
        split: 'validation',
        tags: ['diagnostic', 'starter'],
        prompt: `使用 $${skillName} 完成以下目标：${skillDescription}。把可交付结果写入 eval-output/result.md；不要修改 eval-output/ 之外的文件。`,
        assertions: [
          'trace 读取并执行 owner Skill，而不是只解释计划',
          '结果满足 Skill 的完成标准，并包含可核验的领域证据',
          '作者已把 starter prompt、near-miss 和断言替换为真实任务材料',
        ],
        expected: {
          output: '完成真实工作流，并生成可复核的 eval-output/result.md。作者应把本 starter 替换为领域真实任务和断言。',
          workspaceUnchanged: false,
          allowedWorkspaceChanges: ['eval-output/**'],
          artifacts: [
            {
              path: 'eval-output/result.md',
              exists: true,
            },
          ],
        },
      },
    ],
  };
}
