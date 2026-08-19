import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const QUALITY_GATE_CONFIG_KEY = 'qualityGateEnabled';
export const CODEX_QUALITY_GATE_ARTIFACT_ID = 'ask-me-quality-gate-codex';
export const CLAUDE_QUALITY_GATE_ARTIFACT_ID = 'ask-me-quality-gate-claude';
export const CLAUDE_QUALITY_GATE_SKILL_KEY = 'ask-me-quality-gate';

export const QUALITY_GATE_CONTENT = [
  '开始非平凡实现前，先依据当前对话和仓库检查需求。检查本身不要求加载 Skill；只有检查后仍存在多种合理理解，且选错会明显影响交付结果、功能范围或验收，或多项小歧义合起来会决定成品形态时，才使用 `requirements-clarifier`。',
  '',
  '能从现有上下文查明、有明确项目惯例、容易调整、只涉及内部实现或用户已授权采用默认值的事项不必追问；会影响用户预期的关键默认值应明确说明，不要静默假设。',
].join('\n');

const CLAUDE_QUALITY_GATE_SKILL = `---
name: ${CLAUDE_QUALITY_GATE_SKILL_KEY}
description: "在开始非平凡实现前检查当前对话和仓库是否仍有会明显影响交付结果、功能范围或验收的关键歧义；有此类歧义时使用 requirements-clarifier。纯分析、一次性评审、可查事实、明确惯例、可逆内部选择或已授权默认时不要使用。"
---

# Ask Me Quality Gate

${QUALITY_GATE_CONTENT}

完成检查后交还原任务。本 Skill 只判断是否需要进入 \`requirements-clarifier\`，不自行扩大需求、制作原型或开始实施。
`;

const CLAUDE_QUALITY_GATE_README = `# Ask Me Quality Gate

此 Skill 在 Claude Code 开始非平凡实现前检查需求是否仍有关键歧义。

发现会明显影响交付结果、功能范围或验收的歧义时，它会转入 \`requirements-clarifier\`。事实可查、有明确项目惯例、选择容易调整或用户已授权采用默认值时，它不会要求额外澄清。

此 Skill 只执行需求检查，不制作原型，也不开始实施。可以用 \`qualityGateEnabled\` 配置启用或停用它。
`;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveQualityGateEnabled(context) {
  const issues = Array.isArray(context?.config?.issues) ? context.config.issues : [];
  const issue = issues.find((entry) => isRecord(entry) && entry.key === QUALITY_GATE_CONFIG_KEY);
  if (issue) {
    throw new Error(`Cannot render quality gate: invalid config "${QUALITY_GATE_CONFIG_KEY}".`);
  }

  const values = isRecord(context?.config?.values) ? context.config.values : {};
  const value = values[QUALITY_GATE_CONFIG_KEY];
  if (typeof value !== 'boolean') {
    throw new Error(`Cannot render quality gate: config "${QUALITY_GATE_CONFIG_KEY}" must be boolean.`);
  }
  return value;
}

function disabledArtifact(base) {
  return {
    ...base,
    state: 'disabled',
    disabledReason: 'config',
  };
}

export function renderArtifactPlan(context) {
  const enabled = resolveQualityGateEnabled(context);
  const platform = context?.platform;

  if (platform === 'codex') {
    const base = {
      id: CODEX_QUALITY_GATE_ARTIFACT_ID,
      kind: 'instruction',
      platform: 'codex',
      target: 'codex.developerInstructionsBlock',
      refreshKeys: [QUALITY_GATE_CONFIG_KEY],
    };
    return {
      version: 2,
      artifacts: [enabled
        ? {
          ...base,
          state: 'present',
          content: `## 实施前需求检查\n\n${QUALITY_GATE_CONTENT}`,
        }
        : disabledArtifact(base)],
    };
  }

  if (platform === 'claude') {
    const base = {
      id: CLAUDE_QUALITY_GATE_ARTIFACT_ID,
      kind: 'skill',
      platform: 'claude',
      target: 'claude.skill',
      skillKey: CLAUDE_QUALITY_GATE_SKILL_KEY,
      refreshKeys: [QUALITY_GATE_CONFIG_KEY],
    };
    return {
      version: 2,
      artifacts: [enabled
        ? {
          ...base,
          state: 'present',
          content: {
            files: {
              'README.md': CLAUDE_QUALITY_GATE_README,
              'SKILL.md': CLAUDE_QUALITY_GATE_SKILL,
            },
          },
        }
        : disabledArtifact(base)],
    };
  }

  throw new Error(`Unsupported platform: ${String(platform)}.`);
}

export async function readArtifactRenderContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required.');
  }
  return JSON.parse(await readFile(contextPath, 'utf8'));
}

async function main() {
  const context = await readArtifactRenderContext();
  const plan = renderArtifactPlan(context);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
