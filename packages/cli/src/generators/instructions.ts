import type { InstructionDefinition, PlatformName } from '../types.js';
import { buildGeneratedName } from './shared.js';

export interface GeneratedTextArtifact {
  relativePath: string;
  content: string;
}

function renderClaudePathsFrontmatter(paths: string[] | undefined): string {
  if (!paths?.length) {
    return '';
  }

  const renderedPaths = paths.map((entry) => `  - ${entry}`).join('\n');
  return `---\npaths:\n${renderedPaths}\n---\n\n`;
}

export function renderCodexInstructions(
  pluginName: string,
  instructions: InstructionDefinition[],
): string {
  const lines: string[] = [
    `# ${pluginName}`,
    '',
    '以下内容由 `@yiliang/aw` 从中立指令模型生成。',
  ];

  for (const instruction of instructions) {
    lines.push('', `## ${instruction.title}`, '', instruction.content.trim());
    if (instruction.paths?.length) {
      lines.push('', `适用路径：${instruction.paths.join(', ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function generateInstructionArtifacts(
  pluginName: string,
  instructions: InstructionDefinition[],
  platform: PlatformName,
): GeneratedTextArtifact[] {
  if (instructions.length === 0) {
    return [];
  }

  if (platform === 'codex') {
    return [
      {
        relativePath: 'AGENTS.md',
        content: renderCodexInstructions(pluginName, instructions),
      },
    ];
  }

  return instructions.map((instruction) => ({
    relativePath: `rules/${buildGeneratedName(pluginName, instruction.name)}.md`,
    content:
      `${renderClaudePathsFrontmatter(instruction.paths)}# ${instruction.title}\n\n${instruction.content.trim()}\n`,
  }));
}
