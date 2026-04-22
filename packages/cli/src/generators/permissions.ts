import type { PermissionDefinition } from '../types.js';
import { buildGeneratedName, dedupe } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';

export interface ClaudePermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

export function mergeClaudePermissions(
  permissions: PermissionDefinition[],
): ClaudePermissions {
  return {
    allow: dedupe(permissions.flatMap((entry) => entry.allow ?? [])),
    ask: dedupe(permissions.flatMap((entry) => entry.ask ?? [])),
    deny: dedupe(permissions.flatMap((entry) => entry.deny ?? [])),
  };
}

export function generateCodexPermissionArtifacts(
  pluginName: string,
  permissions: PermissionDefinition[],
): GeneratedTextArtifact[] {
  return permissions.map((permission) => {
    const lines = [
      `# ${pluginName}/${permission.name}`,
      '',
      ...((permission.allow ?? []).map((entry) => `allow ${entry}`)),
      ...((permission.ask ?? []).map((entry) => `ask ${entry}`)),
      ...((permission.deny ?? []).map((entry) => `deny ${entry}`)),
      '',
    ];

    return {
      relativePath: `rules/${buildGeneratedName(pluginName, permission.name)}.rules`,
      content: lines.join('\n'),
    };
  });
}
