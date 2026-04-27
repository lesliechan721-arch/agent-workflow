import type { PermissionDefinition } from '../types.js';
import { buildGeneratedName, dedupe } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';

export interface ClaudePermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ParsedPermissionCommand {
  tokens: string[];
}

export function parsePermissionCommand(value: string, fieldName = 'permission'): ParsedPermissionCommand {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty command prefix.`);
  }
  if (/["'\\*;&|<>`$()]/.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: only plain token prefixes are supported; quotes, escapes, shell control characters and "*" are not allowed.`,
    );
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.some((token) => token.length === 0)) {
    throw new Error(`Invalid ${fieldName}: expected plain command tokens.`);
  }

  return { tokens };
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
    const lines = [
      `# ${pluginName}/${permission.name}`,
      '',
      ...((permission.allow ?? []).map((entry) => renderCodexPrefixRule(entry, 'allow'))),
      ...((permission.ask ?? []).map((entry) => renderCodexPrefixRule(entry, 'prompt'))),
      ...((permission.deny ?? []).map((entry) => renderCodexPrefixRule(entry, 'forbidden'))),
      '',
    ];

    return {
      relativePath: `rules/${buildGeneratedName(pluginName, permission.name)}.rules`,
      content: lines.join('\n'),
    };
  });
}
