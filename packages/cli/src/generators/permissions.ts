import type { PermissionDefinition } from '../types.js';
import { buildGeneratedName, dedupe } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';
import { parsePermissionCommand } from '@lesliechan721/aw-plugin-core/manifest';

export { parsePermissionCommand } from '@lesliechan721/aw-plugin-core/manifest';

export interface ClaudePermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

function renderClaudeBashRule(value: string): string {
  const parsed = parsePermissionCommand(value);
  return `Bash(${parsed.tokens.join(' ')})`;
}

function renderCodexPrefixRule(value: string, decision: 'allow' | 'prompt' | 'forbidden'): string {
  const parsed = parsePermissionCommand(value);
  return `prefix_rule(pattern = ${JSON.stringify(parsed.tokens)}, decision = "${decision}")`;
}

export function mergeClaudePermissions(
  permissions: PermissionDefinition[],
): ClaudePermissions {
  return {
    allow: dedupe(permissions.flatMap((entry) => entry.allow ?? []).map(renderClaudeBashRule)),
    ask: dedupe(permissions.flatMap((entry) => entry.ask ?? []).map(renderClaudeBashRule)),
    deny: dedupe(permissions.flatMap((entry) => entry.deny ?? []).map(renderClaudeBashRule)),
  };
}

export function generateCodexPermissionArtifacts(
  pluginName: string,
  permissions: PermissionDefinition[],
): GeneratedTextArtifact[] {
  return permissions.map((permission) => {
    const generatedName = buildGeneratedName(pluginName, permission.name);
    const lines = [
      `# ${pluginName}/${permission.name}`,
      '',
      ...((permission.allow ?? []).map((entry) => renderCodexPrefixRule(entry, 'allow'))),
      ...((permission.ask ?? []).map((entry) => renderCodexPrefixRule(entry, 'prompt'))),
      ...((permission.deny ?? []).map((entry) => renderCodexPrefixRule(entry, 'forbidden'))),
      '',
    ];

    return {
      relativePath: `rules/${generatedName}.rules`,
      artifactKey: generatedName,
      content: lines.join('\n'),
    };
  });
}
