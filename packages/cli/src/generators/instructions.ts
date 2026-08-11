import type { InstructionDefinition, PlatformName } from '../types.js';
import { buildGeneratedName } from './shared.js';

export interface GeneratedTextArtifact {
  relativePath: string;
  content: string;
  artifactKey?: string;
}

export interface CodexInstructionBundle {
  pluginName: string;
  instructions: InstructionDefinition[];
}

function renderClaudePathsFrontmatter(paths: string[] | undefined): string {
  if (!paths?.length) {
    return '';
  }

  const renderedPaths = paths.map((entry) => `  - ${entry}`).join('\n');
  return `---\npaths:\n${renderedPaths}\n---\n\n`;
}

function renderCodexInstructionSection(
  pluginName: string,
  instructions: InstructionDefinition[],
): string[] {
  const lines: string[] = [
    `## ${pluginName}`,
  ];

  for (const instruction of instructions) {
    lines.push('', `### ${instruction.title}`, '', instruction.content.trim());
    if (instruction.paths?.length) {
      lines.push('', `适用路径：${instruction.paths.join(', ')}`);
    }
  }

  return lines;
}

export function renderCodexManagedInstructionBlock(
  pluginName: string,
  instructions: InstructionDefinition[],
): string {
  return renderCodexInstructionSection(pluginName, instructions).join('\n').trim();
}

export function renderCodexInstructions(bundles: CodexInstructionBundle[]): string | null {
  const populatedBundles = bundles
    .filter((bundle) => bundle.instructions.length > 0)
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName));

  if (populatedBundles.length === 0) {
    return null;
  }

  const lines: string[] = [
    '# Agent Workflows',
    '',
    '以下内容由 `@lesliechan721/aw` 从中立指令模型生成。',
  ];

  for (const bundle of populatedBundles) {
    lines.push('', ...renderCodexInstructionSection(bundle.pluginName, bundle.instructions));
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
    const content = renderCodexInstructions([{ pluginName, instructions }]);
    if (!content) {
      return [];
    }

    return [
      {
        relativePath: 'AGENTS.md',
        content,
      },
    ];
  }

  return instructions.map((instruction) => {
    const generatedName = buildGeneratedName(pluginName, instruction.name);
    return {
      relativePath: `rules/${generatedName}.md`,
      artifactKey: generatedName,
      content:
        `${renderClaudePathsFrontmatter(instruction.paths)}# ${instruction.title}\n\n${instruction.content.trim()}\n`,
    };
  });
}
