import type { AgentDefinition, PlatformName } from '../types.js';
import { buildGeneratedName } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';

function renderTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('\n')) {
    const escaped = trimmed
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\\"\\"\\"');
    return `"""\n${escaped}\n"""`;
  }

  return JSON.stringify(trimmed);
}

export function generateAgentArtifacts(
  pluginName: string,
  agents: AgentDefinition[],
  platform: PlatformName,
): GeneratedTextArtifact[] {
  return agents.map((agent) => {
    const generatedName = buildGeneratedName(pluginName, agent.name);
    if (platform === 'codex') {
      return {
        relativePath: `agents/${generatedName}.toml`,
        artifactKey: generatedName,
        content: [
          `name = ${renderTomlString(agent.name)}`,
          `description = ${renderTomlString(agent.description)}`,
          `developer_instructions = ${renderTomlString(agent.prompt)}`,
          '',
        ].join('\n'),
      };
    }

    const lines = [
      '---',
      `name: ${JSON.stringify(agent.name)}`,
      `description: ${JSON.stringify(agent.description)}`,
      ...(agent.tools && agent.tools.length > 0
        ? ['tools:', ...agent.tools.map((tool) => `  - ${tool}`)]
        : []),
      '---',
      '',
      agent.prompt.trim(),
      '',
    ];
    return {
      relativePath: `agents/${generatedName}.md`,
      artifactKey: generatedName,
      content: lines.join('\n'),
    };
  });
}
