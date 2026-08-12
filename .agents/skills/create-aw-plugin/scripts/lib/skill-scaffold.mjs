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

export function renderPluginReadme(pluginName, description, skillName) {
  return `# ${titleCaseSlug(pluginName)}

${description}

${skillName ? `## Skill\n\n- \`${skillName}\`\n` : ''}
`;
}

export function renderSkillReadme(skillName, description, options = {}) {
  const evalText = options.includeEval === false
    ? '当前模型 eval 只支持 Codex；本 Skill 只运行确定性作者校验。'
    : '模型 eval 合同位于 `evals/`。';
  return `# ${skillName}

${description}

主要指令见 \`SKILL.md\`。${evalText}
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

export function renderEvalManifest(pluginName, skillName) {
  return {
    schemaVersion: 2,
    plugin: pluginName,
    skill: skillName,
    profiles: [
      {
        id: 'project-default',
        scope: 'project',
        plugins: [{ name: pluginName, config: {} }],
        runModel: true,
        requiredForRelease: true,
      },
      {
        id: 'user-default',
        scope: 'user',
        plugins: [{ name: pluginName, config: {} }],
        runModel: false,
        requiredForRelease: true,
      },
    ],
    suites: [
      {
        id: 'trigger',
        kind: 'trigger',
        skills: [skillName],
        cases: './trigger-cases.json',
        observeSpawnAgent: false,
        isolation: 'strict',
        strictNegativeSplits: ['validation', 'sanity'],
        profiles: ['project-default'],
        defaultRuns: 3,
        releaseSplits: ['validation', 'sanity'],
        requiredForRelease: true,
        perRunTimeoutMs: 180000,
      },
      {
        id: 'behavior',
        kind: 'conversation',
        skills: [skillName],
        cases: './evals.json',
        isolation: 'strict',
        profiles: ['project-default'],
        defaultRuns: 1,
        releaseSplits: [],
        requiredForRelease: true,
        perRunTimeoutMs: 300000,
      },
    ],
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
    schemaVersion: 1,
    skill: skillName,
    cases: [
      {
        id: 'primary_train_positive',
        split: 'train',
        query: `${explicitPrefix}${skillDescription}。`,
        should_load_skill: true,
        tags: [invocation, 'positive', 'starter'],
      },
      {
        id: 'primary_train_negative',
        split: 'train',
        query: implicitNegative,
        should_load_skill: false,
        tags: ['near-miss', 'negative', 'starter'],
      },
      {
        id: 'primary_validation_positive',
        split: 'validation',
        query: validationPositive,
        should_load_skill: true,
        tags: [invocation, 'positive', 'starter'],
      },
      {
        id: 'primary_validation_negative',
        split: 'validation',
        query: '只处理一个共享关键词但目标不同的近似任务，不要调用该 Skill。',
        should_load_skill: false,
        tags: ['near-miss', 'negative', 'starter'],
      },
      {
        id: 'primary_sanity_positive',
        split: 'sanity',
        query: sanityPositive,
        should_load_skill: true,
        tags: [invocation, 'positive', 'starter'],
      },
      {
        id: 'primary_sanity_negative',
        split: 'sanity',
        query: '执行另一个职责边界外的任务；即使出现相同术语，也不要加载该 Skill。',
        should_load_skill: false,
        tags: ['near-miss', 'negative', 'starter'],
      },
    ],
  };
}

export function renderBehaviorCases(skillName, skillDescription) {
  return {
    skill_name: skillName,
    evals: [
      {
        id: 'complete_primary_workflow',
        prompt: `使用 $${skillName} 完成以下目标：${skillDescription}。把可交付结果写入 eval-output/result.md；不要修改 eval-output/ 之外的文件。`,
        expected_output: '完成真实工作流，并生成可复核的 eval-output/result.md。作者应把本 starter 替换为领域真实任务和断言。',
        scripted_replies: [],
        sandbox: 'workspace-write',
        review: {
          workspace_unchanged: false,
          allowed_workspace_changes: ['eval-output/**'],
          artifacts: [
            {
              path: 'eval-output/result.md',
              exists: true,
            },
          ],
          checks: [
            'trace 读取并执行 owner Skill，而不是只解释计划',
            '结果满足 Skill 的完成标准，并包含可核验的领域证据',
            '作者已把 starter prompt、near-miss 和断言替换为真实任务材料',
          ],
        },
      },
    ],
  };
}
