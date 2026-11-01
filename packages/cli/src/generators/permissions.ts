import type { PermissionDefinition } from '../types.js';
import { buildGeneratedName, dedupe } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';
import {
  isManagedCommandId,
  normalizeManagedCommandPermission,
  parsePermissionCommand,
  type ManagedCommandReference,
  type PermissionCommand,
} from '@lesliechan721/aw-plugin-core/manifest';

export { parsePermissionCommand } from '@lesliechan721/aw-plugin-core/manifest';

export interface ClaudePermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  excludedCommands?: string[];
}

export type CommandReferenceResolver = (reference: ManagedCommandReference) => string;

function permissionTokens(value: PermissionCommand, resolve?: CommandReferenceResolver): string[] {
  if (typeof value === 'string') return parsePermissionCommand(value).tokens;
  const permission = normalizeManagedCommandPermission(value);
  if (!resolve) throw new Error('commandReferenceInvalid: managed command permission requires a producer.');
  const id = resolve(permission.command);
  if (!isManagedCommandId(id)) throw new Error('commandReferenceInvalid: invalid resolved command ID.');
  return ['aw', 'command', 'run', id, '--', ...permission.argsPrefix];
}

function renderClaudeBashRule(value: PermissionCommand, resolve?: CommandReferenceResolver): string {
  const prefix = permissionTokens(value, resolve).join(' ');
  return `Bash(${prefix}${typeof value === 'string' ? '' : ' *'})`;
}

function renderCodexPrefixRule(
  value: PermissionCommand,
  decision: 'allow' | 'prompt' | 'forbidden',
  resolve?: CommandReferenceResolver,
): string {
  return `prefix_rule(pattern = ${JSON.stringify(permissionTokens(value, resolve))}, decision = "${decision}")`;
}

export function mergeClaudePermissions(
  permissions: PermissionDefinition[],
  resolve?: CommandReferenceResolver,
): ClaudePermissions {
  const excludedCommands = dedupe(permissions.flatMap((entry) => entry.sandbox?.excludedCommands ?? [])
    .map((entry) => `${permissionTokens(entry, resolve).join(' ')} *`)).sort();
  return {
    allow: dedupe(permissions.flatMap((entry) => entry.allow ?? []).map((entry) => renderClaudeBashRule(entry, resolve))),
    ask: dedupe(permissions.flatMap((entry) => entry.ask ?? []).map((entry) => renderClaudeBashRule(entry, resolve))),
    deny: dedupe(permissions.flatMap((entry) => entry.deny ?? []).map((entry) => renderClaudeBashRule(entry, resolve))),
    ...(excludedCommands.length ? { excludedCommands } : {}),
  };
}

export function generateCodexPermissionArtifacts(
  pluginName: string,
  permissions: PermissionDefinition[],
  resolve?: CommandReferenceResolver,
): GeneratedTextArtifact[] {
  return permissions.map((permission) => {
    const generatedName = buildGeneratedName(pluginName, permission.name);
    const lines = [
      `# ${pluginName}/${permission.name}`,
      '',
      ...dedupe((permission.allow ?? []).map((entry) => renderCodexPrefixRule(entry, 'allow', resolve))).sort(),
      ...dedupe((permission.ask ?? []).map((entry) => renderCodexPrefixRule(entry, 'prompt', resolve))).sort(),
      ...dedupe((permission.deny ?? []).map((entry) => renderCodexPrefixRule(entry, 'forbidden', resolve))).sort(),
      '',
    ];

    return {
      relativePath: `rules/${generatedName}.rules`,
      artifactKey: generatedName,
      content: lines.join('\n'),
    };
  });
}
