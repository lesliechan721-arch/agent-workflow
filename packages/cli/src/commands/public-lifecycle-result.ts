import type { Scope, CommandProducerResult } from '../types.js';
import type { RecoveryReceipt, RecoveryTarget, RecoveryDiagnostic } from '../recovery/receipt.js';
import type { NativeToolChange } from '../utils/native-tool-review.js';
import type { CommandResult, Confirmation, Diagnostic } from '../output/public-result.js';
import { commandResult, safePublicMessage } from '../output/public-result.js';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';

export interface PublicTargetResult {
  pluginId: string;
  target: string;
  scope: Scope;
  delivery: RecoveryTarget['delivery'];
  execution: RecoveryTarget['execution'];
  observation: RecoveryTarget['observation'];
  content: NonNullable<RecoveryTarget['content']>;
  requiredBy: string[];
  blockerCodes: string[];
  relation?: RecoveryTarget['relation'];
  requirementScope?: Scope;
  providerScope?: Scope;
  satisfaction?: RecoveryTarget['satisfaction'];
}

export interface LifecycleData {
  request: { plugins: string[]; scope: Scope | null; context: Scope; targets: string[];
    targetOrigin: 'argument' | 'preference' | 'none'; mode: 'apply' | 'requirements-only' | 'outputs-only' };
  confirmation: Confirmation | null;
  changes: Record<'requirements' | 'preferences' | 'config' | 'sources' | 'outputs', 'none' | 'changed' | 'unknown'>;
  requirements: RecoveryReceipt['intent'];
  targetResults: PublicTargetResult[];
  remainingTargets: Array<{ pluginId: string; target: string; scope: Scope }>;
  coverage: { scopes: Scope[]; currentProject: boolean; otherProjects: 'unobserved' };
  allSatisfied?: boolean | null;
  inSync?: boolean | null;
  commandResults?: Array<Omit<CommandProducerResult, 'errors' | 'recoveryActions'> & { blockerCodes: string[] }>;
  nativeToolChanges?: NativeToolChange[];
}

const messages: Record<string, string> = {
  confirmationRequired: 'Repeat this request with --yes to confirm the listed effects.',
  noTargetsEnabled: 'No effective deployment targets are enabled. Set targets or choose --only requirements.',
  projectRootUnavailable: 'A valid project root is required for this request.',
  sourceActiveUnavailable: 'The selected source has no usable Active Catalog.',
  catalogSnapshotInvalid: 'The complete Active snapshot could not be verified. Requirements and outputs were retained.',
  pluginIntentStateInvalid: 'The requirements document is invalid or cannot be read.',
  operationReviewStale: 'The operation evidence changed. Review the current state and repeat the request.',
  pluginSelectorAmbiguous: 'The plugin name is ambiguous. Use a source-qualified plugin ID.',
  pluginUnavailable: 'The plugin is not available in the selected Active Catalog.',
  outputsRetainedRequirements: 'Requirements were retained. A later sync can deploy these outputs again.',
};

export function publicDiagnostic(value: RecoveryDiagnostic | string, subject?: Diagnostic['subject'], severity: Diagnostic['severity'] = 'error'): Diagnostic {
  const code = typeof value === 'string' ? value : value.code;
  const sourceMessage = typeof value === 'string' ? undefined : value.message;
  const publicMessage = sourceMessage && !/[\u3400-\u9fff]/u.test(sourceMessage)
    && !/(?:\/(?:Users|home|tmp|private|var)\/|[A-Za-z]:[\\/])/u.test(sourceMessage)
    ? safePublicMessage(sourceMessage, code) : undefined;
  return { code, severity, message: messages[code] ?? publicMessage ?? `The operation could not complete (${code}).`,
    ...(subject || typeof value !== 'string' && value.pluginId ? { subject: { ...(typeof value !== 'string' && value.pluginId ? { pluginId: value.pluginId } : {}), ...subject } } : {}) };
}

export function projectTarget(value: RecoveryTarget): PublicTargetResult {
  return { pluginId: value.pluginId, target: value.agent, scope: value.scope, delivery: value.delivery,
    execution: value.execution, observation: value.observation, content: value.content ?? 'unknown',
    requiredBy: [...value.requiredBy], blockerCodes: [...new Set(value.blockers.map((entry) => entry.code))],
    ...(value.relation ? { relation: value.relation } : {}),
    ...(value.requirementScope ? { requirementScope: value.requirementScope } : {}),
    ...(value.providerScope ? { providerScope: value.providerScope } : {}),
    ...(value.satisfaction ? { satisfaction: value.satisfaction } : {}) };
}

export function mergeProducerResults(previous: Pick<LifecycleData, 'commandResults' | 'nativeToolChanges'>, data: LifecycleData): void {
  const commands = new Map((previous.commandResults ?? []).map((entry) => [getCommandPackageId(entry.producer), entry]));
  for (const entry of data.commandResults ?? []) {
    const key = getCommandPackageId(entry.producer);
    const before = commands.get(key);
    commands.set(key, before ? { ...entry,
      state: before.state === 'completed' && entry.state === 'completed' ? 'completed'
        : before.state === 'failed' && entry.state === 'failed' ? 'failed' : 'partial',
      commandIds: [...new Set([...before.commandIds, ...entry.commandIds])],
      removedCommandIds: [...new Set([...before.removedCommandIds, ...entry.removedCommandIds])],
      blockerCodes: [...new Set([...before.blockerCodes, ...entry.blockerCodes])],
    } : entry);
  }
  const tools = new Map((previous.nativeToolChanges ?? []).map((entry) => [getCommandPackageId(entry.producer), entry]));
  for (const entry of data.nativeToolChanges ?? []) {
    const key = getCommandPackageId(entry.producer);
    const before = tools.get(key);
    tools.set(key, before ? { ...entry, before: before.before } : entry);
  }
  if (previous.commandResults || data.commandResults) data.commandResults = [...commands.values()];
  if (previous.nativeToolChanges || data.nativeToolChanges) data.nativeToolChanges = [...tools.values()];
}

export function receiptResult(command: string, data: LifecycleData, receipt: RecoveryReceipt): CommandResult<LifecycleData> {
  data.requirements = { ...receipt.intent, roots: receipt.intent.roots ? [...receipt.intent.roots] : null };
  data.request.plugins = [...receipt.requestedRoots];
  data.targetResults = receipt.targetResults.map(projectTarget);
  data.remainingTargets = receipt.remainingTargets.map(({ pluginId, agent, scope }) => ({ pluginId, target: agent, scope }));
  if (receipt.coverage) data.coverage = { scopes: [...receipt.coverage.scopes], currentProject: receipt.coverage.scopes.includes('project'), otherProjects: 'unobserved' };
  data.changes.requirements = receipt.declarationChanged ? 'changed' : data.changes.requirements;
  data.changes.preferences = receipt.preferencesChanged ? 'changed' : data.changes.preferences;
  data.changes.config = receipt.configChanged ? 'changed' : data.changes.config;
  if (receipt.outputsMayHaveChanged) data.changes.outputs = receipt.targetResults.some((target) => target.execution === 'applied' && target.observation !== 'unknown') ? 'changed' : 'unknown';
  // A started backend or script may have changed external state before it failed.
  if (data.changes.outputs === 'none' && receipt.targetResults.some((target) => ['failed', 'partial'].includes(target.execution))) data.changes.outputs = 'unknown';
  if (receipt.allSatisfied !== undefined) data.allSatisfied = receipt.allSatisfied;
  if (receipt.inSync !== undefined) data.inSync = receipt.inSync;
  if (receipt.commandResults) data.commandResults = receipt.commandResults.map(({ producer, state, commandIds, removedCommandIds, errors }) => ({ producer, state, commandIds, removedCommandIds, blockerCodes: errors.map((entry) => entry.code) }));
  if (receipt.nativeToolChanges) data.nativeToolChanges = receipt.nativeToolChanges.map(({ producer, before, after }) => ({ producer, before, after }));
  const diagnostics = [...receipt.blockers, ...receipt.errors].map((entry) => publicDiagnostic(entry));
  for (const target of receipt.targetResults) {
    const subject = { pluginId: target.pluginId, target: target.agent, scope: target.scope };
    diagnostics.push(...target.blockers.map((entry) => publicDiagnostic(entry, subject)));
    diagnostics.push(...(target.reasons ?? []).map((entry) => publicDiagnostic(entry, subject, 'warning')));
  }
  for (const result of receipt.commandResults ?? []) diagnostics.push(...result.errors.map((entry) => publicDiagnostic(entry,
    { pluginId: `${result.producer.sourceId}/${result.producer.pluginName}`, scope: result.producer.scope })));
  const changed = Object.values(data.changes).some((value) => value !== 'none');
  const status = receipt.ok ? 'success' : changed || receipt.targetResults.some((target) => ['applied', 'partial'].includes(target.execution)) ? 'partial' : 'blocked';
  const result = commandResult(command, data, { status, diagnostics: [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()] });
  if (data.request.mode === 'outputs-only') result.diagnostics.push(publicDiagnostic('outputsRetainedRequirements', undefined, 'info'));
  if (!receipt.ok) {
    if (command === 'plugin.remove') result.nextActions.push({ kind: 'manual', message: 'Review the remaining output ownership. Use --only requirements to cancel requirements or --only outputs with explicit targets to clean proven owned outputs.' });
    else for (const target of data.remainingTargets) result.nextActions.push({ kind: 'command', argv: ['aw', 'plugin', 'sync', target.pluginId, '--context', data.request.context, '--target', target.target], reason: 'Retry the selected incomplete target after resolving its diagnostics.', requiresConfirmation: true });
  }
  return result;
}
