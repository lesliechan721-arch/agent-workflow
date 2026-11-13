import type { Scope, CatalogGenerationCandidateEvidence } from '../types.js';
import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import { commandResult, type CommandResult, type Confirmation } from '../output/public-result.js';
import { type LifecycleData, publicDiagnostic, receiptResult, mergeProducerResults } from './public-lifecycle-result.js';
import { addRequirements, intentRemove, intentReceipt } from './intent-command.js';
import { observeIntent } from '../intent/intent-store.js';
import { normalizeAgents, observePreferences } from '../intent/deployment-preferences.js';
import { resolveWorkContext } from '../intent/work-context.js';
import { prepareRecovery, executeRecovery, type RecoveryPlan, type RecoveryOptions } from '../recovery/coordinator.js';
import { prepareRetire, executeRetire, type RetirePlan } from '../recovery/retirement.js';
import type { RebuildCommandRuntime } from './rebuild-command.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import { resolvePartialCatalogOperationContext, type CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { calculateCatalogGenerationSetDigest } from '../utils/catalog-generation-resolver.js';
import { activateCatalogSourceGeneration, withCatalogSourceCandidate } from '../utils/catalog-generation-service.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { validateCatalogSnapshotComplete } from '../utils/catalog-snapshot.js';
import { deletePluginConfigStore } from '../utils/plugin-config.js';
import { parseScriptTimeoutMs } from './options.js';
import type { RecoveryReceipt } from '../recovery/receipt.js';
import { readJointDemand, deriveJointDemand } from '../recovery/joint-demand.js';
import { deploymentConfirmationEffects } from './deployment-confirmation.js';
import { geminiNativeConsentDiagnostic } from '../output/native-consent.js';

export type { LifecycleData } from './public-lifecycle-result.js';
export interface PublicLifecycleOptions {
  cwd: string; env?: NodeJS.ProcessEnv; cliVersion: string;
  scope?: string; context?: string; target?: string[]; targets?: string[];
  only?: string; yes?: boolean; nativeConsent?: boolean; force?: boolean; keepDependencies?: boolean; deleteConfig?: boolean;
  refresh?: boolean; rebuild?: boolean; all?: boolean; scriptTimeout?: number | string; scriptTimeoutMs?: number;
}

export function lifecycleArgumentError(command: string, code: string, message: string, field?: string): CommandResult<LifecycleData> {
  return commandResult<LifecycleData>(command, {} as Record<string, never>, { status: 'failed', diagnostics: [{ code, severity: 'error', message, ...(field ? { subject: { field } } : {}) }] });
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/u.test(code)) return code;
  const first = error instanceof Error ? error.message.split(':')[0] : '';
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(first ?? '') ? first! : 'lifecycleFailed';
}

export function effectsForPlan(plan: RecoveryPlan): Confirmation['effects'] {
  const effects: Confirmation['effects'] = [];
  if (plan.command !== 'cleanup' && plan.command !== 'uninstall') {
    // A temporary candidate can be blocked on generation preparation. Its scripts
    // are still known effects of the request and must be authorized before Active changes.
    for (const placement of plan.joint?.demand.placements ?? []) {
      if (!placement.plugin.manifest.scripts?.preApply || !plan.receipt.selection.agents.includes(placement.target)
        || !placement.contributions.some((entry) => plan.receipt.requestedRoots.includes(entry.root))) continue;
      effects.push({ code: 'runPreApply', message: 'Run the plugin preApply script.', impact: 'unknown', subject: { pluginId: placement.pluginId, target: placement.target, scope: placement.scope } });
    }
  }
  for (const child of plan.joint?.children ?? [plan]) {
    for (const authorization of [...child.preApplyAuthorization ?? [], ...child.nativeGroups.flatMap((group) => group.preview.preApplyAuthorization ?? [])]) {
      effects.push({ code: 'runPreApply', message: 'Run the plugin preApply script.', impact: 'unknown', subject: { pluginId: authorization.pluginId, target: authorization.platform, scope: authorization.scope } });
    }
    for (const group of child.nativeGroups) {
      for (const deployment of group.preview.operationPlan?.deploymentPlans ?? []) {
        effects.push(...deploymentConfirmationEffects(deployment));
      }
      for (const native of group.preview.codexReconcilePlans ?? []) if (native.review.requiresConfirmation) for (const pluginId of native.review.sharedImpact.pluginIds) {
        effects.push({ code: 'replaceSharedOutput', message: 'Replace shared native output used by other projects.', impact: 'shared', subject: { pluginId, target: 'codex', scope: child.options.scope } });
      }
      for (const action of group.preview.operationPlan?.actions ?? []) if (action.kind === 'removeOwnedArtifact' || action.kind === 'removeNativeRegistration' || action.kind === 'setActivation' && !action.enabled) {
        effects.push({ code: 'removeOwnedOutput', message: 'Remove owned output or its activation.', impact: 'selected-scope', subject: { pluginId: action.pluginId, ...(action.platform ? { target: action.platform } : {}), scope: action.scope } });
      }
    }
    if (child.command === 'cleanup' || child.command === 'uninstall' || child.command === 'reinstall') for (const target of child.receipt.requestedTargets) {
      effects.push({ code: 'removeOwnedOutput', message: 'Remove proven owned output in the selected scope.', impact: 'selected-scope', subject: { pluginId: target.pluginId, target: target.agent, scope: target.scope } });
    }
    for (const change of child.receipt.nativeToolChanges ?? []) effects.push({ code: 'changeNativeTools', message: 'Change the installed native tool declarations.', impact: change.producer.scope === 'user' ? 'user-wide' : 'selected-scope', subject: { pluginId: `${change.producer.sourceId}/${change.producer.pluginName}`, scope: change.producer.scope } });
    for (const prepared of child.portableGroups) for (const target of prepared.targets) if (target.disposition === 'remove' || target.observation === 'drifted') {
      effects.push({ code: 'removeOwnedOutput', message: 'Remove or replace existing owned Portable output.', impact: 'selected-scope', subject: { pluginId: target.providerPluginId, target: target.agent, scope: child.options.scope } });
    }
  }
  return [...new Map(effects.map((effect) => [JSON.stringify([effect.code, effect.subject, effect.impact]), effect])).values()];
}

type Candidate = { sourceId: string; candidate: CatalogGenerationCandidateEvidence; previousActive: Awaited<ReturnType<typeof readCatalogGenerationState>>['sources'][string]['active'] | null };
interface SourceFailure { sourceId: string; code: string }

/** Temporary candidates are read and disposed without publishing store entries or Active. */
async function withPreparedSources<T>(options: RecoveryOptions, plugins: string[], refresh: boolean, fetchMissing: boolean, runtime: RebuildCommandRuntime,
  action: (catalog: CatalogOperationContext, candidates: Candidate[], failures: SourceFailure[]) => Promise<T>): Promise<T> {
  const config = await readCatalogSourcesConfigSnapshot(options.env);
  const state = await readCatalogGenerationState(options.env);
  const catalog = await resolvePartialCatalogOperationContext({ env: options.env, configSnapshot: config, signal: options.signal });
  const selected = new Set<string>();
  for (const plugin of plugins) {
    const parsed = parsePluginId(plugin);
    if (parsed.sourceId) selected.add(parsed.sourceId);
    else {
      const matches = catalog.catalog.sources.filter((source) => source.resolution?.manifest.entries.some((entry) => entry.name === parsed.pluginName));
      if (matches.length === 1 && catalog.catalog.sources.every((source) => source.resolution)) selected.add(matches[0]!.sourceId);
      else if (config.config.sources.length === 1) selected.add(config.config.sources[0]!.id);
      else throw new Error('pluginSelectorAmbiguous');
    }
  }
  const failures: SourceFailure[] = [...selected].filter((id) => !config.config.sources.some((source) => source.id === id))
    .map((sourceId) => ({ sourceId, code: 'sourceMissing' }));
  if (failures.length && !refresh) throw new Error('sourceMissing');
  const missing = [...selected].filter((id) => !failures.some((failure) => failure.sourceId === id)
    && (refresh || fetchMissing && !state.sources[id]?.active));
  const visit = async (index: number, current: CatalogOperationContext, candidates: Candidate[]): Promise<T> => {
    const sourceId = missing[index];
    if (!sourceId) return action(current, candidates, failures);
    let entered = false;
    try { return await withCatalogSourceCandidate({ sourceId, cliVersion: options.cliVersion, env: options.env, signal: options.signal, runtime: runtime.catalogGenerationRuntime }, async ({ resolution, candidate }) => {
      entered = true;
      const previousActive = state.sources[sourceId]?.active ?? null;
      if (previousActive?.snapshotDigest === candidate.snapshotDigest && previousActive.sourceIdentity === candidate.sourceIdentity) return visit(index + 1, current, candidates);
      const sources = [...current.generationSet.sources.filter((source) => source.sourceId !== sourceId), { ...candidate, sourceId, storeKey: candidate.snapshotDigest, snapshotPath: resolution.rootDir, manifest: resolution.manifest }];
      const generationSetDigest = calculateCatalogGenerationSetDigest(config.digest, current.generationSet.primarySourceId, sources);
      const next: CatalogOperationContext = { generationSet: { ...current.generationSet, sources, generationSetDigest }, generationSetDigest,
        catalog: { ...current.catalog, compositeDigest: generationSetDigest, sources: [...current.catalog.sources.filter((source) => source.sourceId !== sourceId), { sourceId, resolution }] } };
      return visit(index + 1, next, [...candidates, { sourceId, candidate, previousActive }]);
    }); } catch (error) {
      // Failures after entry belong to the callback, not to this provider fetch.
      if (entered || !refresh) throw error;
      failures.push({ sourceId, code: codeOf(error) });
      return visit(index + 1, current, candidates);
    }
  };
  return visit(0, catalog, []);
}

export async function runPublicLifecycle(command: 'install' | 'remove' | 'sync', plugins: string[], options: PublicLifecycleOptions,
  input: CommandExecutionContextInput = {}): Promise<CommandResult<LifecycleData>> {
  const result = await runPublicLifecycleRequest(command, plugins, options, input);
  if (options.nativeConsent === true && 'request' in result.data) result.diagnostics.push(geminiNativeConsentDiagnostic());
  return result;
}

async function runPublicLifecycleRequest(command: 'install' | 'remove' | 'sync', plugins: string[], options: PublicLifecycleOptions,
  input: CommandExecutionContextInput): Promise<CommandResult<LifecycleData>> {
  const id = `plugin.${command}`;
  const invalid = (message: string, field?: string) => lifecycleArgumentError(id, 'invalidOptionValue', message, field);
  if (options.scope !== undefined && !['user', 'project'].includes(options.scope)) return invalid('Invalid scope. Expected user or project.', 'scope');
  if (options.context !== undefined && !['user', 'project'].includes(options.context)) return invalid('Invalid context. Expected user or project.', 'context');
  if (command !== 'sync' && !options.scope) return lifecycleArgumentError(id, 'missingRequiredOption', 'Specify --scope user or --scope project.', 'scope');
  if (command !== 'sync' && !plugins.length) return lifecycleArgumentError(id, 'missingArgument', 'Specify at least one plugin.');
  if (command !== 'sync' && options.all) return invalid('Install and remove require an explicit plugin list.', 'all');
  if (command === 'sync' && options.all && plugins.length) return invalid('Choose either explicit plugins or --all.', 'all');
  if (options.scope === 'project' && options.context === 'user') return invalid('Project scope requires project context.', 'context');
  if (options.only && !['requirements', 'outputs'].includes(options.only)) return invalid('Expected requirements or outputs.', 'only');
  if (options.only === 'outputs' && command !== 'remove' || command === 'sync' && options.only) return invalid('This effect mode is not supported by this command.', 'only');
  if (options.deleteConfig && (command !== 'remove' || options.only)) return invalid('--delete-config requires normal remove.', 'deleteConfig');
  if (options.force && (command !== 'remove' || options.only === 'requirements')) return invalid('--force requires normal remove or remove --only outputs.', 'force');
  if (options.keepDependencies && (command !== 'remove' || options.only)) return invalid('--keep-dependencies requires normal remove.', 'keepDependencies');
  if (options.nativeConsent && (command === 'remove' || options.only === 'requirements')) return invalid('--native-consent requires install or sync with deployment.', 'nativeConsent');
  const argumentsTargets = options.targets ?? options.target;
  if (options.only === 'requirements' && (argumentsTargets !== undefined || options.scriptTimeout !== undefined || options.scriptTimeoutMs !== undefined)) return invalid('Requirements-only does not accept target or script timeout options.');
  if (command === 'remove' && options.only !== 'outputs' && argumentsTargets !== undefined) return invalid('Use --only outputs to select removal targets.', 'target');
  if (options.only === 'outputs' && !argumentsTargets?.length) return invalid('Outputs-only requires at least one explicit target.', 'target');
  let selected: string[] | undefined;
  try { if (argumentsTargets) { selected = normalizeAgents(argumentsTargets); if (!selected.length) return invalid('Specify at least one target.', 'target'); } for (const plugin of plugins) parsePluginId(plugin); }
  catch { return invalid('Invalid plugin selector or target.'); }
  let timeout: number | undefined;
  try { if (options.scriptTimeoutMs !== undefined || options.scriptTimeout !== undefined) timeout = parseScriptTimeoutMs(options.scriptTimeoutMs ?? options.scriptTimeout); }
  catch { return invalid('Script timeout must be between 1000 and 1800000 milliseconds.', 'scriptTimeout'); }
  const context = createCommandExecutionContext({ ...input, env: options.env ?? input.env, interactive: false });
  const env = context.env;
  let work: Awaited<ReturnType<typeof resolveWorkContext>>;
  try { work = await resolveWorkContext({ cwd: options.cwd, scope: options.scope as Scope | undefined, context: options.context as Scope | undefined }); }
  catch (error) { return commandResult<LifecycleData>(id, {}, { status: 'blocked', diagnostics: [publicDiagnostic(codeOf(error))] }); }
  const scope = options.scope as Scope | undefined;
  const location = { cwd: work.projectRoot ?? options.cwd, scope: scope ?? work.context, env };
  const preferences = await observePreferences(location);
  if (!options.only && preferences.state !== 'valid' && preferences.state !== 'absent') return commandResult<LifecycleData>(id, {}, { status: 'blocked', diagnostics: [publicDiagnostic('deploymentPreferencesInvalid')] });
  const targets = options.only === 'requirements' ? [] : options.only === 'outputs' ? selected! : (preferences.state === 'valid' ? preferences.value.targets.filter((target) => !selected || selected.includes(target)) : []);
  const observation = await observeIntent(location);
  const data: LifecycleData = { request: { plugins: [...plugins], scope: scope ?? null, context: work.context, targets,
    targetOrigin: selected ? 'argument' : targets.length ? 'preference' : 'none', mode: options.only === 'requirements' ? 'requirements-only' : options.only === 'outputs' ? 'outputs-only' : 'apply', nativeConsent: options.nativeConsent === true },
    confirmation: null, changes: { requirements: 'none', preferences: 'none', config: 'none', sources: 'none', outputs: 'none' },
    requirements: { state: observation.state, ...('digest' in observation ? { digest: observation.digest } : {}), roots: observation.state === 'valid' ? observation.value.roots.map((root) => root.pluginId) : observation.state === 'absent' ? [] : null },
    targetResults: [], remainingTargets: [], coverage: { scopes: work.scopes, currentProject: work.context === 'project', otherProjects: 'unobserved' } };
  const blocked = (code: string) => commandResult(id, data, { status: Object.values(data.changes).some((value) => value !== 'none') ? 'partial' : 'blocked', diagnostics: [publicDiagnostic(code)] });
  const confirm = (effects: Confirmation['effects']): boolean => {
    data.confirmation = { required: effects.length > 0, provided: options.yes === true, effects };
    return !effects.length || options.yes === true;
  };
  const runtime: RebuildCommandRuntime = { ...context, directCli: true, nativeConsent: options.nativeConsent === true };
  const recovery: RecoveryOptions = { ...location, scope, context: work.context, signal: context.signal, cliVersion: options.cliVersion, targets: selected ? targets : undefined, yes: options.yes, force: options.force, keepDependencies: options.keepDependencies, scriptTimeoutMs: timeout, interactive: false };
  try {
    if (command === 'remove' && options.only === 'requirements') {
      if (plugins.some((plugin) => !parsePluginId(plugin).sourceId)) return lifecycleArgumentError(id, 'invalidArguments', 'Requirements-only removal requires source-qualified plugin IDs.');
      confirm([]);
      return receiptResult(id, data, await intentRemove({ ...location, selectors: plugins }));
    }
    if (options.only !== 'outputs' && options.only !== 'requirements' && preferences.state !== 'valid' && preferences.state !== 'absent') return blocked('deploymentPreferencesInvalid');
    if (command === 'install' && !options.only && !targets.length) {
      const result = blocked('noTargetsEnabled'); result.nextActions.push({ kind: 'command', argv: ['aw', 'target', 'set', '<target>'], reason: 'Enable deployment targets.', requiresConfirmation: false }); return result;
    }
    const applyPlan = async (plan: RecoveryPlan, extra: Confirmation['effects'] = []): Promise<CommandResult<LifecycleData>> => {
      if (!confirm([...effectsForPlan(plan), ...extra])) { const result = receiptResult(id, data, plan.receipt); result.status = Object.values(data.changes).some((value) => value !== 'none') ? 'partial' : 'blocked'; result.diagnostics.push(publicDiagnostic('confirmationRequired')); await plan.context.dispose(); return result; }
      receiptResult(id, data, plan.receipt);
      try {
        const receipt = await executeRecovery(plan, { yes: options.yes, runtime });
        return receiptResult(id, data, receipt);
      } catch (error) {
        const current = await observeIntent(location);
        if (current.state === 'valid') {
          if (current.digest !== data.requirements.digest) data.changes.requirements = 'changed';
          data.requirements = { state: 'valid', digest: current.digest, roots: current.value.roots.map((root) => root.pluginId) };
        } else if (current.state !== data.requirements.state) data.changes.requirements = 'unknown';
        if (!['operationReviewStale', 'awHomeMutationLocked', 'awHomeMutationLockTimeout'].includes(codeOf(error))) data.changes.outputs = 'unknown';
        return blocked(codeOf(error));
      }
    };
    if (options.only === 'outputs') return await applyPlan(await prepareRecovery('cleanup', plugins, { ...recovery, targets }, runtime));
    if (command === 'remove') {
      const catalog = await resolvePartialCatalogOperationContext({ env });
      let selectable = data.requirements.roots ?? [];
      if (plugins.some((selector) => !parsePluginId(selector).sourceId)) {
        const snapshot = await readJointDemand({ ...recovery, catalogOperationContext: catalog });
        const original = location.scope === 'project' ? snapshot.project! : snapshot.user;
        const demand = deriveJointDemand(snapshot);
        selectable = [...new Set([...(original.roots ?? []).map((root) => root.pluginId),
          ...demand.placements.filter((placement) => placement.scope === location.scope).map((placement) => placement.pluginId)])];
      }
      const exact: string[] = [];
      for (const selector of plugins) {
        const parsed = parsePluginId(selector);
        const matches = parsed.sourceId ? [selector] : selectable.filter((pluginId) => parsePluginId(pluginId).pluginName === parsed.pluginName);
        if (matches.length !== 1) return blocked('pluginSelectorAmbiguous');
        exact.push(matches[0]!);
      }
      const retired: string[] = []; const active: string[] = [];
      for (const plugin of exact) {
        const parsed = parsePluginId(plugin); const source = catalog.catalog.sources.find((entry) => entry.sourceId === parsed.sourceId)?.resolution;
        if (!source) return blocked('sourceActiveUnavailable');
        await validateCatalogSnapshotComplete(source.rootDir);
        (source.manifest.entries.some((entry) => entry.name === parsed.pluginName) ? active : retired).push(plugin);
      }
      const plans: Array<RecoveryPlan | RetirePlan> = [];
      let result: CommandResult<LifecycleData> = commandResult(id, data);
      const appendReceipt = (receipt: RecoveryReceipt) => {
        const previousTargets = [...data.targetResults]; const previousRemaining = [...data.remainingTargets];
        const previousProducers = { commandResults: data.commandResults, nativeToolChanges: data.nativeToolChanges };
        const previousDiagnostics = result.diagnostics;
        result = receiptResult(id, data, receipt);
        mergeProducerResults(previousProducers, data);
        data.targetResults = [...previousTargets, ...data.targetResults];
        data.remainingTargets = [...previousRemaining, ...data.remainingTargets];
        data.request.plugins = exact;
        result.diagnostics.unshift(...previousDiagnostics);
      };
      try {
        if (active.length) plans.push(await prepareRecovery('uninstall', active, recovery, runtime));
        for (const selector of retired) plans.push(await prepareRetire({ ...location, selector, signal: context.signal, cliVersion: options.cliVersion, yes: options.yes, deleteConfig: options.deleteConfig, preservePreferences: true }, runtime));
        const effects = plans.flatMap((plan) => 'command' in plan ? effectsForPlan(plan) : plan.receipt.targetResults.map((target) => ({ code: 'removeOwnedOutput', message: 'Remove proven owned output of a retired plugin.', impact: 'selected-scope' as const, subject: { pluginId: target.pluginId, target: target.agent, scope: target.scope } })));
        if (options.deleteConfig) effects.push(...exact.map((pluginId) => ({ code: 'deletePluginConfig', message: 'Delete all local common and platform configuration for this plugin.', impact: 'user-wide' as const, subject: { pluginId, scope: 'user' as const } })));
        const invalidPlan = plans.find((plan) => 'blockExecution' in plan
          ? plan.blockExecution || plan.receipt.targetResults.some((target) => target.blockers.length > 0)
          : plan.receipt.blockers.length > 0);
        if (invalidPlan || !confirm(effects)) {
          for (const plan of plans) appendReceipt(plan.receipt);
          result.status = 'blocked';
          if (!invalidPlan) result.diagnostics.push(publicDiagnostic('confirmationRequired'));
          return result;
        }
        return await withAwHomeMutationLock({ env, action: async (token) => {
          const receipts: RecoveryReceipt[] = [];
          for (let index = 0; index < plans.length; index++) {
            const plan = plans[index]!;
            // Previous removals in this same lock changed only the selected roots.
            // Retain all original output and ownership evidence for subsequent plans.
            if (index > 0 && !('command' in plan)) {
              const current = await observeIntent(location);
              plan.intentEvidence = `${current.state}:${'rawDigest' in current ? current.rawDigest ?? '' : ''}`;
            }
            try {
              const receipt = 'command' in plan ? await executeRecovery(plan, { yes: options.yes, runtime: { ...runtime, awHomeMutationToken: token } })
                : await executeRetire(plan, { yes: true, runtime: { ...runtime, awHomeMutationToken: token } });
              receipts.push(receipt); appendReceipt(receipt);
            } catch (error) {
              for (const remaining of plans.slice(index)) appendReceipt(remaining.receipt);
              const current = await observeIntent(location);
              if (current.state === 'valid') {
                if (observation.state !== 'valid' || current.digest !== observation.digest) data.changes.requirements = 'changed';
                data.requirements = { state: 'valid', digest: current.digest, roots: current.value.roots.map((root) => root.pluginId) };
              } else data.changes.requirements = 'unknown';
              data.changes.outputs = 'unknown'; result.status = 'partial'; result.diagnostics.push(publicDiagnostic(codeOf(error)));
              return result;
            }
          }
          data.request.plugins = exact;
          if (options.deleteConfig && receipts.every((receipt) => receipt.declarationChanged || receipt.ok)) for (const plugin of active) {
            const parsed = parsePluginId(plugin); const source = catalog.catalog.sources.find((entry) => entry.sourceId === parsed.sourceId)!.resolution!;
            const deleted = await deletePluginConfigStore({ ...location, scope: 'user', sourceId: parsed.sourceId, sourceIdentity: source.sourceIdentity, pluginName: parsed.pluginName });
            if (deleted.deleted) data.changes.config = 'changed';
          }
          if (receipts.some((receipt) => !receipt.ok)) result.status = Object.values(data.changes).some((value) => value !== 'none') ? 'partial' : 'blocked';
          return result;
        } });
      } catch (error) {
        result.status = Object.values(data.changes).some((value) => value !== 'none') ? 'partial' : 'blocked';
        result.diagnostics.push(publicDiagnostic(codeOf(error))); return result;
      } finally { await Promise.all(plans.map((plan) => plan.context.dispose())); }
    }
    let selectedPlugins = plugins;
    if (command === 'sync' && !plugins.length) {
      const intents = await Promise.all(work.scopes.map((scope) => observeIntent({ ...location, scope })));
      selectedPlugins = [...new Set(intents.flatMap((intent) => intent.state === 'valid' ? intent.value.roots.map((root) => root.pluginId) : []))];
    }
    return await withPreparedSources(recovery, selectedPlugins, command === 'sync' && options.refresh === true, command === 'install', runtime, async (catalog, candidates, failures) => {
      const belongsToFailedSource = (selector: string) => {
        const parsed = parsePluginId(selector);
        if (parsed.sourceId) return failures.some((failure) => failure.sourceId === parsed.sourceId);
        const sources = catalog.catalog.sources.filter((source) => source.resolution?.manifest.entries.some((entry) => entry.name === parsed.pluginName));
        return sources.length === 1 && failures.some((failure) => failure.sourceId === sources[0]!.sourceId);
      };
      const healthySelectors = () => selectedPlugins.filter((selector) => !belongsToFailedSource(selector));
      const withSourceFailures = async (result: CommandResult<LifecycleData>): Promise<CommandResult<LifecycleData>> => {
        if (!failures.length) return result;
        const validResults = result.status !== 'blocked' && data.targetResults.some((target) => !failures.some((failure) => failure.sourceId === parsePluginId(target.pluginId).sourceId)
          && ['applied', 'no-op'].includes(target.execution));
        const demand = deriveJointDemand(await readJointDemand(recovery));
        for (const failure of failures) {
          result.diagnostics.push(publicDiagnostic(failure.code, { sourceId: failure.sourceId }));
          for (const root of demand.roots.filter((root) => parsePluginId(root.pluginId).sourceId === failure.sourceId
            && targets.includes(root.target) && selectedPlugins.some((selector) => selector === root.pluginId
              || !selector.includes('/') && parsePluginId(root.pluginId).pluginName === selector))) {
            const subject = { pluginId: root.pluginId, sourceId: failure.sourceId, target: root.target, scope: root.scope };
            data.targetResults.push({ pluginId: root.pluginId, target: root.target, scope: root.scope, delivery: null,
              execution: 'not-run', observation: 'unknown', content: 'unknown', requiredBy: [root.pluginId],
              blockerCodes: [failure.code], relation: 'root', requirementScope: root.scope, satisfaction: 'unknown' });
            data.remainingTargets.push({ pluginId: root.pluginId, target: root.target, scope: root.scope });
            result.diagnostics.push(publicDiagnostic(failure.code, subject));
          }
          result.nextActions.push({ kind: 'command', argv: ['aw', 'source', 'sync', failure.sourceId],
            reason: 'Restore the failed source before retrying its selected plugin targets.', requiresConfirmation: true });
        }
        data.request.plugins = [...selectedPlugins];
        data.allSatisfied = null; data.inSync = null;
        result.status = validResults || Object.values(data.changes).some((value) => value !== 'none') ? 'partial' : 'blocked';
        return result;
      };
      const preparedOptions = { ...recovery, catalogOperationContext: catalog };
      const sourceEffects: Confirmation['effects'] = candidates.filter((candidate) => candidate.previousActive).map(({ sourceId }) => ({ code: 'changeSource', message: 'Activate a new Catalog generation for the selected source.', impact: 'shared', subject: { sourceId } }));
      let preview: RecoveryPlan | undefined;
      if (failures.length && !healthySelectors().length) {
        confirm([]);
        return withSourceFailures(commandResult(id, data));
      }
      if (options.only === 'requirements') {
        const proposed = await addRequirements({ ...location, selectors: plugins, installSelectors: true, dryRun: true, catalogOperationContext: catalog });
        if (proposed.errors.length) return receiptResult(id, data, await intentReceipt('install', location, { ...proposed, changed: false }));
        if (!confirm(sourceEffects)) return blocked('confirmationRequired');
      } else {
        preview = await prepareRecovery(command === 'sync' && options.rebuild ? 'reinstall' : command, healthySelectors(), preparedOptions, runtime);
        if (preview.blockExecution) { const result = receiptResult(id, data, preview.receipt); await preview.context.dispose(); return withSourceFailures(result); }
        if (!confirm([...effectsForPlan(preview), ...sourceEffects])) { const result = receiptResult(id, data, preview.receipt); result.status = 'blocked'; result.diagnostics.push(publicDiagnostic('confirmationRequired')); await preview.context.dispose(); return withSourceFailures(result); }
        receiptResult(id, data, preview.receipt);
      }
      try {
        for (const candidate of candidates) {
          try {
            const activated = await activateCatalogSourceGeneration({ ...candidate, expectedCandidate: candidate.candidate, expectedActive: candidate.previousActive, cliVersion: options.cliVersion, cwd: location.cwd, env, signal: context.signal, impactConfirmed: options.yes === true, runtime: runtime.catalogGenerationRuntime });
            if (activated.activeChanged) data.changes.sources = 'changed';
          } catch (error) {
            if (command !== 'sync' || !options.refresh) throw error;
            failures.push({ sourceId: candidate.sourceId, code: codeOf(error) });
            const state = await readCatalogGenerationState(env).catch(() => null);
            if (!state) data.changes.sources = 'unknown';
            else if (state.sources[candidate.sourceId]?.active?.snapshotDigest === candidate.candidate.snapshotDigest) data.changes.sources = 'changed';
          }
        }
        if (options.only === 'requirements') return receiptResult(id, data, await intentReceipt('install', location, await addRequirements({ ...location, selectors: plugins, installSelectors: true })));
        if (!candidates.length) return withSourceFailures(await applyPlan(preview!, sourceEffects));
        await preview!.context.dispose(); preview = undefined;
        data.targetResults = []; data.remainingTargets = [];
        if (!healthySelectors().length) return withSourceFailures(commandResult(id, data));
        return withSourceFailures(await applyPlan(await prepareRecovery(command === 'sync' && options.rebuild ? 'reinstall' : command, healthySelectors(), recovery, runtime), sourceEffects));
      } finally { await preview?.context.dispose(); }
    });
  } catch (error) { return blocked(codeOf(error)); }
}
