import type { AgentDefinition, PlatformName } from '../types.js';
import { buildGeneratedName } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';

export function generateAgentArtifacts(
  pluginName: string,
  agents: AgentDefinition[],
  platform: PlatformName,
): GeneratedTextArtifact[] {
  return agents.map((agent) => {
    const generatedName = buildGeneratedName(pluginName, agent.name);
    if (platform === 'codex') {
      return {
        relativePath: `agents/${generatedName}.json`,
        content: JSON.stringify(
          {
            name: agent.name,
            description: agent.description,
            prompt: agent.prompt,
            tools: agent.tools ?? [],
          },
          null,
          2,
        ),
      };
    }

    const lines = [
      `# ${agent.name}`,
      '',
      agent.description.trim(),
      '',
      '## Prompt',
      '',
      agent.prompt.trim(),
      '',
    ];
    return {
      relativePath: `agents/${generatedName}.md`,
      content: lines.join('\n'),
    };
  });
}
