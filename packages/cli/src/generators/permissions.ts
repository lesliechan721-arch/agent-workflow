import type { Diagnostic } from '../output/public-result.js';
import { COMMAND_ROUTE_UNREACHABLE, deliveryNoticeMessage, INVOCATION_POLICY_NOT_APPLIED, PERMISSION_ACTIONS, type PermissionAction } from '../output/component-delivery.js';
import type { PermissionClaim } from '../platforms/permission-sidecar.js';
import type { PermissionDefinition } from '../types.js';
import { buildGeneratedName, dedupe } from './shared.js';
import type { GeneratedTextArtifact } from './instructions.js';
import {
  normalizeCommandSelector,
  normalizeManagedCommandPermission,
  parsePermissionCommand,
  type CommandRoutes,
  type PermissionCommand,
  type ResolvedInvocationPolicy,
} from '@lesliechan721/aw-plugin-core/manifest';

export { parsePermissionCommand } from '@lesliechan721/aw-plugin-core/manifest';

export interface InactiveManagedCommandPermission {
  name: string;
  action: 'ask' | 'deny';
  argsPrefix: string[];
}

export function managedCommandRouteIsReachable(routes: CommandRoutes | null, argsPrefix: readonly string[]): boolean {
  const word = argsPrefix[0];
  return !!routes && (!!routes.fallback || routes.subcommands.some(({ name }) => word === undefined || word === name));
}

export function selectPlatformInvocationPolicy(policy: ResolvedInvocationPolicy, subject: Diagnostic['subject'],
  routes?: CommandRoutes | null, portable = false): {
  policy: ResolvedInvocationPolicy;
  diagnostics: Diagnostic[];
  inactivePermissions: InactiveManagedCommandPermission[];
} {
  const diagnostics: Diagnostic[] = [];
  const inactivePermissions: InactiveManagedCommandPermission[] = [];
  const warn = (field: string, reasonCode: string, skippedPermissionActions: PermissionAction[]) => {
    const detail = { reasonCode, skippedPermissionActions };
    diagnostics.push({ code: INVOCATION_POLICY_NOT_APPLIED, severity: 'warning', subject: { ...subject, field },
      detail, message: deliveryNoticeMessage(INVOCATION_POLICY_NOT_APPLIED, detail, field) });
  };
  const supported = policy.permissions.flatMap((permission) => {
    const shell = policy.platform === 'codex' || (policy.platform === 'opencode' || policy.platform === 'antigravity' || policy.platform === 'grok') && !portable;
    if (policy.platform === 'claude' || shell && !permission.sandbox?.excludedCommands.length) {
      return [permission];
    }
    // Keep enforceable restrictions. A policy with unmapped controls supplies no new grants.
    const skipped = (shell ? ['allow', 'sandbox'] as const : PERMISSION_ACTIONS)
      .filter((field) => field === 'sandbox' ? permission.sandbox?.excludedCommands.length : permission[field]?.length);
    if (skipped.length) warn(`permissions.${permission.name}`, 'delivery-unavailable', skipped);
    if (shell && (permission.ask?.length || permission.deny?.length)) {
      return [{ name: permission.name, ask: permission.ask, deny: permission.deny }];
    }
    return [];
  });
  const hasRoute = (entry: PermissionCommand): boolean => typeof entry === 'string' || routes === undefined
    || managedCommandRouteIsReachable(routes, entry.argsPrefix);
  const permissions = supported.flatMap((permission) => {
    const { name, ask, deny } = permission;
    const allow = permission.allow?.filter(hasRoute);
    const excludedCommands = permission.sandbox?.excludedCommands.filter(hasRoute);
    const skipped: PermissionAction[] = [];
    if (allow?.length !== permission.allow?.length) skipped.push('allow');
    if (excludedCommands?.length !== permission.sandbox?.excludedCommands.length) skipped.push('sandbox');
    if (skipped.length) warn(`permissions.${name}`, COMMAND_ROUTE_UNREACHABLE, skipped);
    for (const action of ['ask', 'deny'] as const) {
      for (const entry of permission[action] ?? []) {
        if (typeof entry !== 'string' && !hasRoute(entry)) inactivePermissions.push({ name, action, argsPrefix: [...entry.argsPrefix] });
      }
    }
    if (!allow?.length && !ask?.length && !deny?.length && !excludedCommands?.length) return [];
    return [{ name, allow, ask, deny, ...(excludedCommands?.length ? { sandbox: { excludedCommands } } : {}) }];
  });
  return { policy: { ...policy, permissions }, diagnostics, inactivePermissions };
}

export interface ClaudePermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  excludedCommands?: string[];
}

function permissionTokens(value: PermissionCommand, selector?: string): string[] {
  if (typeof value === 'string') return parsePermissionCommand(value).tokens;
  const permission = normalizeManagedCommandPermission(value);
  if (!selector) throw new Error('commandReferenceInvalid: managed command permission requires a verified selector.');
  normalizeCommandSelector(selector);
  return ['aw', 'command', 'run', selector, '--', ...permission.argsPrefix];
}

export function hostPermissionClaims(permissions: PermissionDefinition[], selector: string): PermissionClaim[] {
  return permissions.flatMap((permission) => (['allow', 'ask', 'deny'] as const).flatMap((effect) =>
    (permission[effect] ?? []).map((entry) => ({ name: permission.name, effect, tokens: permissionTokens(entry, selector) }))));
}

export function renderClaudeBashRule(tokens: readonly string[]): string {
  return `Bash(${tokens.join(' ')} *)`;
}

function renderCodexPrefixRule(
  value: PermissionCommand,
  decision: 'allow' | 'prompt' | 'forbidden',
  selector?: string,
): string {
  return `prefix_rule(pattern = ${JSON.stringify(permissionTokens(value, selector))}, decision = "${decision}")`;
}

export function mergeClaudePermissions(
  permissions: PermissionDefinition[],
  selector?: string,
): ClaudePermissions {
  const render = (entry: PermissionCommand) => renderClaudeBashRule(permissionTokens(entry, selector));
  const excludedCommands = dedupe(permissions.flatMap((entry) => entry.sandbox?.excludedCommands ?? [])
    .map((entry) => `${permissionTokens(entry, selector).join(' ')} *`)).sort();
  return {
    allow: dedupe(permissions.flatMap((entry) => entry.allow ?? []).map(render)),
    ask: dedupe(permissions.flatMap((entry) => entry.ask ?? []).map(render)),
    deny: dedupe(permissions.flatMap((entry) => entry.deny ?? []).map(render)),
    ...(excludedCommands.length ? { excludedCommands } : {}),
  };
}

export function generateCodexPermissionArtifacts(
  pluginName: string,
  permissions: PermissionDefinition[],
  selector?: string,
): GeneratedTextArtifact[] {
  return permissions.map((permission) => {
    const generatedName = buildGeneratedName(pluginName, permission.name);
    const lines = [
      `# ${pluginName}/${permission.name}`,
      '',
      ...dedupe((permission.allow ?? []).map((entry) => renderCodexPrefixRule(entry, 'allow', selector))).sort(),
      ...dedupe((permission.ask ?? []).map((entry) => renderCodexPrefixRule(entry, 'prompt', selector))).sort(),
      ...dedupe((permission.deny ?? []).map((entry) => renderCodexPrefixRule(entry, 'forbidden', selector))).sort(),
      '',
    ];

    return {
      relativePath: `rules/${generatedName}.rules`,
      artifactKey: generatedName,
      content: lines.join('\n'),
    };
  });
}
