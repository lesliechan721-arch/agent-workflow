import type { Diagnostic } from '../output/public-result.js';
import { deliveryNoticeMessage, INVOCATION_POLICY_NOT_APPLIED, PERMISSION_ACTIONS, type PermissionAction } from '../output/component-delivery.js';
import type { PermissionDefinition } from '../types.js';
import { buildGeneratedName, dedupe } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';
import {
  isManagedCommandId,
  normalizeManagedCommandPermission,
  parsePermissionCommand,
  type ManagedCommandReference,
  type PermissionCommand,
  type ResolvedInvocationPolicy,
} from '@lesliechan721/aw-plugin-core/manifest';

export { parsePermissionCommand } from '@lesliechan721/aw-plugin-core/manifest';

/** Only rules the selected host can enforce may require a command binding. */
export function selectPlatformInvocationPolicy(policy: ResolvedInvocationPolicy, subject: Diagnostic['subject'],
  skippedProducer?: (reference: ManagedCommandReference) => string | undefined): { policy: ResolvedInvocationPolicy; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const warn = (field: string, reasonCode: string, skippedPermissionActions: PermissionAction[]) => {
    const detail = { reasonCode, skippedPermissionActions };
    diagnostics.push({ code: INVOCATION_POLICY_NOT_APPLIED, severity: 'warning', subject: { ...subject, field },
      detail, message: deliveryNoticeMessage(INVOCATION_POLICY_NOT_APPLIED, detail, field) });
  };
  const permissions = policy.permissions.flatMap((original) => {
    let permission = original;
    if (skippedProducer) {
      const skipped = new Map<string, { reasonCode: string; actions: Set<PermissionAction> }>();
      const keep = (action: PermissionAction) => (entry: PermissionCommand) => {
        if (typeof entry === 'string') return true;
        const reasonCode = skippedProducer(entry.command);
        if (!reasonCode) return true;
        const { set, key, variant } = entry.command;
        const field = `permissions.${original.name}.${set}.${key}.${variant}`;
        const earlier = skipped.get(field);
        if (earlier) earlier.actions.add(action);
        else skipped.set(field, { reasonCode, actions: new Set([action]) });
        return false;
      };
      const allow = original.allow?.filter(keep('allow'));
      const ask = original.ask?.filter(keep('ask'));
      const deny = original.deny?.filter(keep('deny'));
      const excludedCommands = original.sandbox?.excludedCommands.filter(keep('sandbox'));
      if (skipped.size) {
        for (const [field, { reasonCode, actions }] of skipped) warn(field, reasonCode, [...actions]);
        if (!allow?.length && !ask?.length && !deny?.length && !excludedCommands?.length) return [];
        permission = { name: original.name, allow, ask, deny, ...(excludedCommands?.length ? { sandbox: { excludedCommands } } : {}) };
      }
    }
    if (policy.platform === 'claude' || policy.platform === 'codex' && !permission.sandbox?.excludedCommands.length) {
      return [permission];
    }
    // Keep enforceable restrictions. A policy with unmapped controls supplies no new grants.
    const codex = policy.platform === 'codex';
    const skipped = (codex ? ['allow', 'sandbox'] as const : PERMISSION_ACTIONS)
      .filter((field) => field === 'sandbox' ? permission.sandbox?.excludedCommands.length : permission[field]?.length);
    if (skipped.length) warn(`permissions.${permission.name}`, 'delivery-unavailable', skipped);
    if (codex && (permission.ask?.length || permission.deny?.length)) {
      return [{ name: permission.name, ask: permission.ask, deny: permission.deny }];
    }
    return [];
  });
  return { policy: { ...policy, permissions }, diagnostics };
}

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
