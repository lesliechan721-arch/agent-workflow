import { describeNativeToolClosure, type NativeToolChange } from '../utils/native-tool-review.js';
import { renderPluginCapabilities, type PluginCapabilitiesResult } from '../commands/plugin-capabilities.js';
import { redactString } from './redact.js';

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  subject?: { pluginId?: string; sourceId?: string; target?: string; scope?: 'user' | 'project'; field?: string };
}
export type NextAction =
  | { kind: 'command'; argv: string[]; reason: string; requiresConfirmation: boolean }
  | { kind: 'manual'; message: string };
export interface Confirmation {
  required: boolean;
  provided: boolean;
  effects: Array<{ code: string; message: string; subject?: Diagnostic['subject']; impact: 'selected-scope' | 'user-wide' | 'shared' | 'unknown' }>;
}
export interface CommandResult<T extends object = Record<string, unknown>> {
  schemaVersion: 1;
  command: string | null;
  status: 'success' | 'partial' | 'blocked' | 'failed';
  data: T | Record<string, never>;
  diagnostics: Diagnostic[];
  nextActions: NextAction[];
}
export function commandResult<T extends object>(command: string | null, data: T | Record<string, never>, options: Partial<Pick<CommandResult<T>, 'status' | 'diagnostics' | 'nextActions'>> = {}): CommandResult<T> {
  return { schemaVersion: 1, command, status: options.status ?? 'success', data, diagnostics: options.diagnostics ?? [], nextActions: options.nextActions ?? [] };
}
export function publicExitCode(result: CommandResult<object>, argumentError = false): number {
  return result.status === 'success' ? 0 : result.status === 'partial' ? 4 : result.status === 'blocked' ? 3 : argumentError ? 2 : 1;
}
export function safePublicMessage(message: string, code = 'commandFailed'): string {
  const messages: Record<string, string> = { confirmationRequired: 'Repeat the command with --yes to confirm the listed effects.' };
  return messages[code] ?? redactString(message);
}
export function renderPublicResult(result: CommandResult<object>, verbose = false): string {
  const data = result.data as Record<string, unknown>;
  const lines = [`${result.status.toUpperCase()}  ${(result.command ?? 'Command').replaceAll('.', ' ')}`];
  const request = data.request as { plugins?: string[]; scope?: string; context?: string; targets?: string[]; mode?: string } | undefined;
  if (request) {
    if (request.plugins?.length) lines.push(`Plugins: ${request.plugins.join(', ')}`);
    if (request.scope) lines.push(`Scope: ${request.scope}`);
    if (request.context) lines.push(`Context: ${request.context}`);
    if (request.targets?.length) lines.push(`Targets: ${request.targets.join(', ')}`);
    if (request.mode === 'requirements-only') lines.push('Deployment: not requested');
    if (request.mode === 'outputs-only') lines.push('Requirements: kept', 'Configuration: kept', 'A later sync can deploy the outputs again.');
  }
  if (data.version) lines.push(`Version: ${String(data.version)}`);
  if (data.awVersion) lines.push(`AW version: ${String(data.awVersion)}`);
  if (result.command === 'dev.catalog.publish.plan' || result.command === 'dev.catalog.publish.apply') {
    for (const [key, label] of [['state', 'Publication state'], ['planDigest', 'Plan digest'], ['remote', 'Remote'], ['branch', 'Branch'], ['tag', 'Tag']] as const) {
      if (typeof data[key] === 'string') lines.push(`${label}: ${data[key]}`);
    }
  }
  if (result.command === 'dev.plugin.capabilities' && data.capabilities) lines.push(...renderPluginCapabilities(data as unknown as PluginCapabilitiesResult));
  else if (Array.isArray(data.capabilities)) lines.push(`Capabilities: ${data.capabilities.join(', ')}`);
  for (const key of ['pluginId', 'sourceId', 'scope', 'context', 'platform', 'catalogVersion', 'configWrite', 'outputRoot', 'out', 'sourceBindingPath', 'specDirectory', 'metadataPath', 'workspaceRoot', 'removed', 'deleted', 'resetDisposition', 'name', 'description', 'outcome', 'activeChanged']) {
    const value = data[key];
    if (value !== undefined && value !== null && typeof value !== 'object') lines.push(`${key}: ${String(value)}`);
  }
  if (typeof data.allSatisfied === 'boolean' || data.allSatisfied === null) lines.push(`All satisfied: ${data.allSatisfied === null ? 'unknown' : data.allSatisfied ? 'yes' : 'no'}`);
  if (data.counts && typeof data.counts === 'object') lines.push(`Status counts: ${Object.entries(data.counts).map(([key, value]) => `${key}=${String(value)}`).join(', ')}`);
  const coverage = data.coverage as { scopes?: string[]; currentProject?: boolean; otherProjects?: string } | undefined;
  if (coverage) lines.push(`Coverage: ${(coverage.scopes ?? []).join(', ')}; other projects ${coverage.otherProjects ?? 'unobserved'}`);
  const configFields = data.fields;
  if (Array.isArray(configFields)) for (const field of configFields as Array<{ key: string; valueState?: string; effectiveValue?: unknown; sourceLayer?: string; storedValue?: unknown; storedSourceLayer?: string }>) {
    const display = (value: unknown) => value === null || value === undefined ? '<unset>' : typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`${field.key}: ${field.valueState ?? 'unknown'} (source=${field.sourceLayer ?? 'none'}, effective=${display(field.effectiveValue)})`);
    if (field.storedValue !== undefined && field.storedSourceLayer) lines.push(`  stored=${field.storedSourceLayer} ${display(field.storedValue)}`);
  }
  else if (configFields && typeof configFields === 'object') for (const [key, field] of Object.entries(configFields as Record<string, { type?: string; title?: string; sensitive?: boolean; required?: boolean }>)) lines.push(`${key}: ${field.type ?? 'value'}${field.required ? ' (required)' : ''}${field.sensitive ? ' (sensitive)' : ''}${field.title ? ` — ${field.title}` : ''}`);
  const apply = data.apply as { state?: string; reason?: string; targetResults?: Array<{ state: string; target: { platform: string; scope: string } }> } | undefined;
  if (apply) { lines.push(`Apply: ${apply.state ?? 'unknown'}${apply.reason ? ` (${apply.reason})` : ''}`); for (const target of apply.targetResults ?? []) lines.push(`${target.target.platform}/${target.target.scope}: ${target.state}`); }

  const snapshot = data.snapshot as { state?: string; path?: string } | undefined;
  if (snapshot?.state) lines.push(`Snapshot: ${snapshot.state}${verbose && snapshot.path ? ` (${snapshot.path})` : ''}`);
  const policy = data.policy as { targets?: string[]; exclusions?: Array<{ plugin: string; target: string }> } | undefined;
  if (policy) { lines.push(`Targets: ${policy.targets?.join(', ') || 'none'}`); for (const entry of policy.exclusions ?? []) lines.push(`Excluded: ${entry.plugin} / ${entry.target}`); }
  if (Array.isArray(data.targets)) lines.push(`Supported targets: ${data.targets.join(', ')}`);
  if (Array.isArray(data.dependencies)) lines.push(`Dependencies: ${data.dependencies.join(', ') || 'none'}`);
  for (const change of (data.nativeToolChanges ?? []) as NativeToolChange[]) for (const phase of ['before', 'after'] as const) {
    const closure = change[phase];
    if (closure) for (const detail of describeNativeToolClosure(closure)) lines.push(`Native tool ${change.producer.sourceId}/${change.producer.pluginName} ${phase}: ${detail}`);
  }
  const changes = data.changes;
  if (changes && !Array.isArray(changes) && typeof changes === 'object') for (const [key, value] of Object.entries(changes)) if (value !== 'none') lines.push(`${key}: ${String(value)}`);
  for (const key of ['items', 'sources', 'entries', 'commands', 'packages', 'targetResults', 'checks', 'inventory', 'skills']) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;
    if (entries.length === 0) lines.push(`${key}: none`);
    for (const item of entries) {
      if (typeof item === 'string') { lines.push(item); continue; }
      const entry = item as Record<string, unknown>;
      lines.push([entry.pluginId ?? entry.id ?? entry.sourceId ?? entry.storeKey ?? entry.name ?? entry.skill ?? '', entry.target ?? '', entry.version ?? '', entry.execution ?? entry.availability ?? entry.status ?? entry.state ?? '', entry.summary ?? entry.description ?? ''].filter(Boolean).join('  '));
      if (entry.profile && typeof entry.profile === 'object') { const profile = entry.profile as { platform?: string; scope?: string }; lines.push(`  Profile: ${profile.platform ?? 'unknown'}/${profile.scope ?? 'unknown'}${entry.finalPath ? `; final: ${String(entry.finalPath)}` : ''}`); }
      const compatibility = entry.compatibility as { state?: string; requiredCapabilities?: string[]; missingCapabilities?: string[] } | undefined;
      if (compatibility?.state === 'unsupported') lines.push(`  Incompatible; required: ${compatibility.requiredCapabilities?.join(', ') ?? 'unknown'}; missing: ${compatibility.missingCapabilities?.join(', ') ?? 'unknown'}`);
      if ('activeReady' in entry) lines.push(`  Active: ${entry.active ? 'present' : 'absent'}; ready: ${entry.activeReady ? 'yes' : 'no'}`);
      if (verbose && entry.blockerCodes && Array.isArray(entry.blockerCodes)) lines.push(`  Blockers: ${entry.blockerCodes.join(', ')}`);
    }
  }
  if (data.preview === true || data.dryRun === true) lines.push('Preview only. No content was deleted.');
  const confirmation = data.confirmation as Confirmation | null | undefined;
  if (confirmation?.required) for (const effect of confirmation.effects) lines.push(`Effect: ${effect.message}`);
  if (verbose) for (const diagnostic of result.diagnostics.filter((entry) => entry.severity === 'info')) lines.push(`${diagnostic.code}: ${diagnostic.message}`);
  for (const action of result.nextActions) lines.push(action.kind === 'manual' ? `Next: ${action.message}` : `Next: ${action.argv.map((arg) => /\s/u.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`);
  return `${lines.join('\n')}\n`;
}
